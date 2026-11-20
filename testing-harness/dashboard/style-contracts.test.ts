import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const DASHBOARD = fileURLToPath(new URL("../../apps/dashboard/", import.meta.url));
const css = readFileSync(join(DASHBOARD, "app/styles.css"), "utf8");
const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((match) => match[1].trim());
const defined = new Set(selectors.flatMap((selector) => [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1])));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * Class tokens a className expression can apply. Literals in class position
 * count (including both branches of a conditional); a token glued to an
 * interpolation, such as `status-${kind}`, is dynamic and skipped.
 */
function classTokens(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return words(expression.text);
  if (ts.isParenthesizedExpression(expression)) return classTokens(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...classTokens(expression.whenTrue), ...classTokens(expression.whenFalse)];
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return classTokens(expression.right);
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return [...classTokens(expression.left), ...classTokens(expression.right)];
    }
    return [];
  }
  if (ts.isTemplateExpression(expression)) {
    const texts = [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
    const literal = texts.flatMap((text, index) => {
      const tokens = text.split(/\s+/);
      if (index > 0) tokens.shift();
      if (index < texts.length - 1) tokens.pop();
      return tokens.filter(Boolean);
    });
    // An interpolation separated by whitespace on both sides is a whole class.
    const interpolated = expression.templateSpans.flatMap((span, index) => {
      const before = texts[index];
      const after = span.literal.text;
      const standalone = (before === "" || /\s$/.test(before)) && (after === "" || /^\s/.test(after));
      return standalone ? classTokens(span.expression) : [];
    });
    return [...literal, ...interpolated];
  }
  return [];
}

function usedClasses(): Array<{ file: string; token: string }> {
  const files = ["app", "components"].flatMap((root) => sourceFiles(join(DASHBOARD, root)));
  return files.flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: Array<{ file: string; token: string }> = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
        const expression = ts.isStringLiteral(node.initializer)
          ? node.initializer
          : ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        for (const token of expression ? classTokens(expression) : []) found.push({ file: relative(DASHBOARD, file), token });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

describe("dashboard style contracts", () => {
  it("defines a rule for every class name the dashboard renders", () => {
    const used = usedClasses();
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter(({ token }) => !defined.has(token)).map(({ file, token }) => `${file}: .${token}`)).toEqual([]);
  });

  it("styles buttons without a class instead of leaving the browser default", () => {
    const elementSelectors = selectors.flatMap((selector) => selector.split(",").map((part) => part.trim()));
    expect(elementSelectors.some((selector) => selector === "button" || selector === ":where(button)")).toBe(true);
  });
});
