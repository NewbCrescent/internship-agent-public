import { describe, expect, it } from "vitest";

import {
  extractRepositoryClaims,
  parseGitHubRepositoryRef,
  selectEvidenceFiles,
  sourceUrl,
  type AnalyzedFile,
  type RemoteRepositorySnapshot
} from "@internship-agent/github";

const snapshot: RemoteRepositorySnapshot = {
  owner: "example",
  name: "performance-demo",
  url: "https://github.com/example/performance-demo",
  defaultBranch: "main",
  description: "A compact systems performance experiment.",
  headSha: "abc123",
  treeSha: "tree123",
  topics: ["systems"],
  languages: { C: 900, TypeScript: 100 },
  licenseName: "MIT"
};

describe("GitHub repository contracts", () => {
  it("canonicalizes supported repository references and rejects other hosts", () => {
    expect(parseGitHubRepositoryRef("example/project")).toEqual({ owner: "example", name: "project" });
    expect(parseGitHubRepositoryRef("https://github.com/example/project.git/")).toEqual({ owner: "example", name: "project" });
    expect(parseGitHubRepositoryRef("git@github.com:example/project.git")).toEqual({ owner: "example", name: "project" });
    expect(() => parseGitHubRepositoryRef("https://gitlab.com/example/project")).toThrow(/Only github.com/);
  });

  it("selects bounded evidence files while excluding generated, vendored, and binary paths", () => {
    const selected = selectEvidenceFiles([
      { path: "README.md", type: "blob", sha: "1", size: 500 },
      { path: "package.json", type: "blob", sha: "2", size: 800 },
      { path: "src/vector.c", type: "blob", sha: "3", size: 1_200 },
      { path: "node_modules/pkg/index.js", type: "blob", sha: "4", size: 200 },
      { path: "dist/bundle.js", type: "blob", sha: "5", size: 200 },
      { path: "assets/logo.png", type: "blob", sha: "6", size: 200 }
    ]);
    expect(selected.map((file) => file.path)).toEqual(["README.md", "package.json", "src/vector.c"]);
    expect(selected.map((file) => file.kind)).toEqual(["readme", "manifest", "source"]);
  });

  it("extracts traceable candidate claims without granting review approval", () => {
    const files: AnalyzedFile[] = [
      analyzed("README.md", "readme", "# Demo\n\nA compact systems performance experiment.\n\nBenchmark improved throughput by 10x."),
      analyzed("package.json", "manifest", JSON.stringify({ dependencies: { react: "19.0.0" } }, null, 2)),
      analyzed("src/vector.c", "source", "#include <arm_neon.h>\n#pragma omp parallel for")
    ];
    const result = extractRepositoryClaims(snapshot, files);
    expect(result.summary).toBe(snapshot.description);
    expect(result.claims.some((claim) => claim.kind === "metric" && claim.text.includes("10x"))).toBe(true);
    expect(result.claims.some((claim) => claim.normalizedKey === "source:arm-neon")).toBe(true);
    expect(result.claims.some((claim) => claim.normalizedKey === "dependency:react")).toBe(true);
    expect(result.claims.every((claim) => !("reviewStatus" in claim))).toBe(true);
    expect(result.claims.flatMap((claim) => claim.evidence).every((evidence) => evidence.sourceUrl.includes("abc123"))).toBe(true);
  });

  it("claims implementation evidence only from source files", () => {
    // Sample repository regression: a package script and README lines were labeled implementation evidence.
    const docsOnly: AnalyzedFile[] = [
      analyzed("README.md", "readme", "# Demo\n\nA compact systems performance experiment.\n\nEnd-to-end tests run with Playwright."),
      analyzed("package.json", "manifest", JSON.stringify({ scripts: { "test:e2e": "playwright test" } }, null, 2))
    ];
    const withoutSource = extractRepositoryClaims(snapshot, docsOnly);
    expect(withoutSource.claims.some((claim) => claim.normalizedKey.startsWith("source:"))).toBe(false);
    expect(withoutSource.claims.some((claim) => claim.text.includes("implementation evidence"))).toBe(false);

    const withSource = extractRepositoryClaims(snapshot, [
      ...docsOnly,
      analyzed("tests/app.spec.ts", "source", "import { test } from \"@playwright/test\";")
    ]);
    const playwright = withSource.claims.find((claim) => claim.normalizedKey === "source:playwright");
    expect(playwright?.evidence.map((item) => item.path)).toEqual(["tests/app.spec.ts"]);
  });

  it("builds immutable line-specific source URLs", () => {
    expect(sourceUrl(snapshot.url, "abc123", "src/a file.ts", 8, 10))
      .toBe("https://github.com/example/performance-demo/blob/abc123/src/a%20file.ts#L8-L10");
  });
});

function analyzed(path: string, kind: AnalyzedFile["kind"], content: string): AnalyzedFile {
  return { path, kind, content, size: content.length, blobSha: `${path}-blob`, contentHash: `${path}-hash` };
}
