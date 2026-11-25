#!/usr/bin/env node
// One-time migration of the single-file TECHNICAL.md and BUGS.md into
// docs/technical/ (one folder per section, one file per paragraph, one
// sentence per line) and bugs/open/ + bugs/resolved/ (one file per bug), so
// parallel runs stop editing the same lines. TECHNICAL.md and BUGS.md become
// short indexes. The split is lossless: `--check` proves that the new files
// rebuild the old text byte for byte.
//
//   node scripts/split-docs.mjs (--write | --check) [--from-ref <ref> | --technical <file> --bugs <file>]
//
// `--write` replaces docs/technical/, bugs/open/, bugs/resolved/, TECHNICAL.md,
// and BUGS.md. Run it only on the pre-split files (this split and the
// merge-conflict rounds of this split), never after later runs have edited
// those folders: it would throw their edits away.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TECHNICAL_DIR = "docs/technical";
export const BUG_DIRS = { open: "bugs/open", resolved: "bugs/resolved" };

/** Words before a period that do not end a sentence. */
export const ABBREVIATIONS = new Set(["e.g", "i.e", "U.S", "B.S", "B.A", "M.S", "Ph.D", "vs", "etc", "Inc", "Co", "Corp", "Ltd", "St", "No", "approx", "cf", "Mr", "Ms", "Mrs", "Dr", "Jr", "Sr"]);

const TECHNICAL_INTRO = [
  [
    "The guide lives in `docs/technical/`: one folder per topic below, one file per paragraph read in file-name order, and one sentence per line.",
    "Start with the status, then read the folders your task touches (`cat docs/technical/<folder>/*.md` prints a folder in order)."
  ],
  [
    "Parallel runs must not edit the same lines, so do not append to a shared file.",
    "Change a sentence where it stands, or add a new sentence on its own line beside the sentences about the same feature, never by default at the end of a file.",
    "Put new material in a new file numbered between its neighbours (`NNN-<slug>.md`, the slug in lower-case words joined by hyphens), and a new topic in a new folder listed here, the only change this file needs."
  ]
].map((lines) => lines.join("\n")).join("\n\n");

const BUGS_INTRO = [
  "Each bug is its own file: `bugs/open/<slug>.md` while it is open and `bugs/resolved/<slug>.md` once it is fixed.",
  "The slug is the title in lower-case words joined by hyphens, and the file starts with `# <title>`.",
  "To file a bug, add a new file under `bugs/open/`; when it is fixed, move it with `git mv` to `bugs/resolved/` and add how it was fixed.",
  "Bugs are not numbered, and this file lists none of them, so parallel runs never edit the same lines."
].join("\n");

const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])\s/;
const FENCE = /^(?:```|~~~)/;
const CLOSERS = new Set([")", "]", "\"", "'", "”", "’", "*"]);
const NOT_A_LINE_START = /^(?:[-+*]\s|#|>|\d{1,9}[.)](?:\s|$)|```|~~~)/;

class AlreadySplitError extends Error {}

/** Lower-case words joined by hyphens, at most `max` characters, cut at a hyphen. */
export function slugify(text, max) {
  let slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > max) {
    slug = slug.slice(0, max);
    const cut = slug.lastIndexOf("-");
    if (cut !== -1) slug = slug.slice(0, cut);
    slug = slug.replace(/-+$/, "");
  }
  return slug === "" ? "part" : slug;
}

function isBoundary(line, i, start) {
  if (i <= start) return false;
  if (line[i - 1] === " " || i + 1 >= line.length || line[i + 1] === " ") return false;
  let k = i - 1;
  while (k >= start && CLOSERS.has(line[k])) k -= 1;
  if (k < start || ![".", "!", "?"].includes(line[k])) return false;
  if (!/[A-Z0-9`"“(\[*]/.test(line[i + 1])) return false;
  if (line[k] === ".") {
    let w = k;
    while (w > 0 && line[w - 1] !== " " && line[w - 1] !== "(") w -= 1;
    const word = line.slice(w, k);
    if (ABBREVIATIONS.has(word) || /^[A-Za-z]$/.test(word)) return false;
  }
  return !NOT_A_LINE_START.test(line.slice(i + 1));
}

/** Splits one paragraph line into sentences; joining them with one space gives the line back. */
export function splitSentences(line) {
  const pieces = [];
  let start = 0;
  let bold = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === "`") {
      let n = 0;
      while (line[i + n] === "`") n += 1;
      let j = i + n;
      let close = -1;
      while (j < line.length) {
        if (line[j] !== "`") { j += 1; continue; }
        let m = 0;
        while (line[j + m] === "`") m += 1;
        if (m === n) { close = j; break; }
        j += m;
      }
      i = close === -1 ? i + n : close + n;
      continue;
    }
    if (char === "*" && line[i + 1] === "*") { bold = !bold; i += 2; continue; }
    if (char === " " && !bold && isBoundary(line, i, start)) {
      pieces.push(line.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  pieces.push(line.slice(start));
  if (pieces.join(" ") !== line) throw new Error(`sentence split lost text in: ${line.slice(0, 80)}`);
  return pieces;
}

function sourceLines(text, name) {
  if (text.includes("\r")) throw new Error(`${name} contains a carriage return`);
  if (!text.endsWith("\n")) throw new Error(`${name} does not end with a newline`);
  return text.slice(0, -1).split("\n");
}

function renderBlock(block) {
  return block.lines.join("\n");
}

function groupSlugSource(block) {
  const first = block.kind === "sentences" ? block.source : block.lines[0];
  if (FENCE.test(first)) return block.lines[1] ?? "";
  if (LIST_ITEM.test(first)) return first.replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "");
  if (first.startsWith("**")) {
    const end = first.indexOf("**", 2);
    if (end !== -1) return first.slice(2, end);
  }
  return first;
}

function makeBlock(lines, lineNumber) {
  const first = lines[0];
  if (FENCE.test(first) || LIST_ITEM.test(first)) return { kind: "verbatim", lines };
  if (lines.length > 1) throw new Error(`TECHNICAL.md: multi-line paragraph at line ${lineNumber} is not supported`);
  if (/^[|><#\s]/.test(first)) return { kind: "verbatim", lines };
  return { kind: "sentences", source: first, lines: splitSentences(first) };
}

/** Splits the single-file technical guide into sections, paragraph files, and sentence lines. */
export function splitTechnical(text) {
  const lines = sourceLines(text, "TECHNICAL.md");
  if (lines.some((line) => /^`docs\/technical\//.test(line))) throw new AlreadySplitError("TECHNICAL.md is already split");
  if (!lines[0].startsWith("# ")) throw new Error("TECHNICAL.md must start with a \"# \" title");
  const title = lines[0];
  const sections = [];
  let section = null;
  let block = null;
  let blockLine = 0;
  let inFence = false;
  let previousBlank = false;
  const closeBlock = () => {
    if (!block) return;
    section.blocks.push(makeBlock(block, blockLine));
    block = null;
  };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    if (inFence) {
      block.push(line);
      if (FENCE.test(line)) inFence = false;
      continue;
    }
    if (line === "") {
      if (previousBlank) throw new Error(`TECHNICAL.md: double blank line at ${number}`);
      previousBlank = true;
      closeBlock();
      continue;
    }
    const afterBlank = previousBlank;
    previousBlank = false;
    if (line.startsWith("## ")) {
      if (block || !afterBlank) throw new Error(`TECHNICAL.md: heading at line ${number} must follow a blank line`);
      if (lines[index + 1] !== "") throw new Error(`TECHNICAL.md: heading at line ${number} must be followed by a blank line`);
      section = { heading: line, blocks: [] };
      sections.push(section);
      continue;
    }
    if (!section) throw new Error(`TECHNICAL.md: text before the first section at line ${number}`);
    if (!block) { block = []; blockLine = number; }
    block.push(line);
    if (FENCE.test(line)) inFence = true;
  }
  if (inFence) throw new Error("TECHNICAL.md: unclosed fence");
  if (previousBlank) throw new Error("TECHNICAL.md: trailing blank line");
  if (section) closeBlock();
  if (sections.length === 0) throw new Error("TECHNICAL.md has no \"## \" sections");
  if (sections.length > 99) throw new Error("TECHNICAL.md has more than 99 sections");

  return {
    title,
    sections: sections.map((current, sectionIndex) => {
      if (current.blocks.length === 0) throw new Error(`TECHNICAL.md: section "${current.heading}" has no text`);
      const groups = [];
      for (const item of current.blocks) {
        const previous = groups.at(-1);
        const previousLine = previous?.at(-1).lines.at(-1);
        const first = item.lines[0];
        if (previous && LIST_ITEM.test(first) && !FENCE.test(first) && previousLine.endsWith(":")) previous.push(item);
        else groups.push([item]);
      }
      const dir = `${String(sectionIndex + 1).padStart(2, "0")}-${slugify(current.heading.replace(/^#+\s+/, ""), 60)}`;
      const files = groups.map((blocks, index) => {
        if ((index + 1) * 10 > 990) throw new Error(`TECHNICAL.md: section "${current.heading}" has more than 99 paragraphs`);
        const words = groupSlugSource(blocks[0]).split(/\s+/).filter(Boolean).slice(0, 6);
        const name = `${String((index + 1) * 10).padStart(3, "0")}-${slugify(words.join(" "), 60)}.md`;
        return { name, blocks, content: `${blocks.map(renderBlock).join("\n\n")}\n` };
      });
      return { heading: current.heading, dir, files };
    })
  };
}

/** The old single-file guide, rebuilt from the split. */
export function rebuildTechnical(split) {
  return `${split.title}\n\n${split.sections.map((section) => `${section.heading}\n\n${section.files.map((file) => file.blocks.map((block) => (block.kind === "sentences" ? block.lines.join(" ") : block.lines.join("\n"))).join("\n\n")).join("\n\n")}`).join("\n\n")}\n`;
}

/** The new TECHNICAL.md: the title, how to read and edit the guide, and one folder per section. */
export function technicalIndex(split) {
  return `${split.title}\n\n${TECHNICAL_INTRO}\n\n${split.sections.map((section) => `${section.heading}\n\n\`${TECHNICAL_DIR}/${section.dir}/\``).join("\n\n")}\n`;
}

/** Splits the single-file bug list into one entry per bug, keeping what is needed to rebuild it byte for byte. */
export function splitBugs(text) {
  const lines = sourceLines(text, "BUGS.md");
  if (!lines.some((line) => line.startsWith("### "))) throw new AlreadySplitError("BUGS.md has no bug entries; it is already split");
  const openIndexes = lines.flatMap((line, index) => (line === "## Open" ? [index] : []));
  const resolvedIndexes = lines.flatMap((line, index) => (line === "## Resolved" ? [index] : []));
  if (openIndexes.length !== 1 || resolvedIndexes.length !== 1) throw new Error("BUGS.md needs exactly one \"## Open\" and one \"## Resolved\" line");
  const openIndex = openIndexes[0];
  if (resolvedIndexes[0] < openIndex) throw new Error("BUGS.md: \"## Open\" must come before \"## Resolved\"");
  const preamble = lines.slice(0, openIndex);
  if (preamble.length === 0 || preamble.at(-1) !== "") throw new Error("BUGS.md: the text before \"## Open\" must end with a blank line");

  const items = [];
  const entries = [];
  let status = "open";
  let current = null;
  let raw = null;
  const closeEntry = () => {
    if (!current) return;
    if (raw.length < 2 || raw[0] !== "") throw new Error(`BUGS.md: entry at line ${current.lineNumber} needs a blank line and a body after its heading`);
    const body = raw.slice(1);
    let trailing = 0;
    while (body.length > 0 && body.at(-1) === "") { body.pop(); trailing += 1; }
    if (body.length === 0) throw new Error(`BUGS.md: entry at line ${current.lineNumber} has no body`);
    entries.push({ status: current.status, headingLine: current.headingLine, title: current.title, lines: body });
    items.push({ type: "entry", entry: entries.length - 1, trailing });
    current = null;
    raw = null;
  };
  for (let index = openIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    if (line === "## Open" || line === "## Resolved") {
      closeEntry();
      if (line === "## Resolved") status = "resolved";
      items.push({ type: "heading", line, blanks: 0 });
      continue;
    }
    let title = null;
    let entryStatus = status;
    if (line.startsWith("### ")) title = line.replace(/^#+\s+/, "");
    else if (line.startsWith("## Resolved: ")) { title = line.slice(3); entryStatus = "resolved"; }
    else if (/^#{1,2} /.test(line)) throw new Error(`BUGS.md: unexpected heading at line ${number}`);
    if (title !== null) {
      closeEntry();
      current = { status: entryStatus, headingLine: line, title, lineNumber: number };
      raw = [];
      continue;
    }
    if (current) { raw.push(line); continue; }
    if (line !== "") throw new Error(`BUGS.md: text outside an entry at line ${number}`);
    items.at(-1).blanks += 1;
  }
  closeEntry();

  const used = new Set();
  for (const entry of entries) {
    const base = slugify(entry.title.replace(/^Resolved: /, ""), 80);
    let name = base;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${base}-${suffix}`;
    used.add(name);
    entry.name = `${name}.md`;
    entry.content = `# ${entry.title}\n\n${entry.lines.join("\n")}\n`;
  }
  return { preamble, items, entries };
}

/** The old single-file bug list, rebuilt from the split. */
export function rebuildBugs(split) {
  const out = [...split.preamble];
  for (const item of split.items) {
    if (item.type === "heading") {
      out.push(item.line, ...Array(item.blanks).fill(""));
    } else {
      const entry = split.entries[item.entry];
      out.push(entry.headingLine, "", ...entry.lines, ...Array(item.trailing).fill(""));
    }
  }
  return `${out.join("\n")}\n`;
}

/** The new BUGS.md: the old preamble and how the bug files are laid out. */
export function bugsIndex(split) {
  return `${split.preamble.join("\n")}\n${BUGS_INTRO}\n\n## Open\n\n\`${BUG_DIRS.open}/\`\n\n## Resolved\n\n\`${BUG_DIRS.resolved}/\`\n`;
}

/** Every file the split writes, keyed by repository-relative path. */
export function planSplit(technicalText, bugsText) {
  const technical = splitTechnical(technicalText);
  const bugs = splitBugs(bugsText);
  const files = new Map();
  files.set("TECHNICAL.md", technicalIndex(technical));
  files.set("BUGS.md", bugsIndex(bugs));
  let sentenceLines = 0;
  for (const section of technical.sections) {
    for (const file of section.files) {
      files.set(`${TECHNICAL_DIR}/${section.dir}/${file.name}`, file.content);
      for (const block of file.blocks) if (block.kind === "sentences") sentenceLines += block.lines.length;
    }
  }
  for (const entry of bugs.entries) files.set(`${BUG_DIRS[entry.status]}/${entry.name}`, entry.content);
  const stats = {
    sections: technical.sections.length,
    technicalFiles: technical.sections.reduce((total, section) => total + section.files.length, 0),
    sentenceLines,
    openBugs: bugs.entries.filter((entry) => entry.status === "open").length,
    resolvedBugs: bugs.entries.filter((entry) => entry.status === "resolved").length
  };
  return { files, technical, bugs, stats };
}

function firstDifference(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) if (left[index] !== right[index]) return index + 1;
  return Math.max(left.length, right.length);
}

function walkFiles(root, dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(full);
  return files.sort();
}

/** Proves the split is lossless and on disk; files the split did not write are listed as additions. */
export function checkSplit(root, technicalText, bugsText) {
  const plan = planSplit(technicalText, bugsText);
  const problems = [];
  const technical = rebuildTechnical(plan.technical);
  if (technical !== technicalText) problems.push(`TECHNICAL.md does not rebuild: first difference at line ${firstDifference(technical, technicalText)}`);
  const bugs = rebuildBugs(plan.bugs);
  if (bugs !== bugsText) problems.push(`BUGS.md does not rebuild: first difference at line ${firstDifference(bugs, bugsText)}`);
  for (const section of plan.technical.sections) {
    for (const file of section.files) {
      for (const block of file.blocks) {
        if (block.kind === "sentences" && block.lines.join(" ") !== block.source) problems.push(`${TECHNICAL_DIR}/${section.dir}/${file.name}: sentences do not join back to their paragraph`);
      }
    }
  }
  for (const [path, content] of plan.files) {
    const full = join(root, path);
    if (!existsSync(full)) problems.push(`${path}: missing`);
    else if (readFileSync(full, "utf8") !== content) problems.push(`${path}: differs from the split`);
  }
  const additions = [TECHNICAL_DIR, BUG_DIRS.open, BUG_DIRS.resolved].flatMap((dir) => walkFiles(root, dir)).filter((path) => !plan.files.has(path));
  return { problems, additions, stats: plan.stats };
}

/** Replaces docs/technical/, bugs/open/, bugs/resolved/, TECHNICAL.md, and BUGS.md with the split. */
export function writeSplit(root, technicalText, bugsText) {
  const plan = planSplit(technicalText, bugsText);
  if (rebuildTechnical(plan.technical) !== technicalText || rebuildBugs(plan.bugs) !== bugsText) throw new Error("The split does not rebuild its source; nothing was written");
  for (const dir of [TECHNICAL_DIR, BUG_DIRS.open, BUG_DIRS.resolved]) rmSync(join(root, dir), { recursive: true, force: true });
  for (const [path, content] of plan.files) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return plan.stats;
}

export function parseArgs(argv) {
  const options = { mode: null, ref: null, technical: null, bugs: null };
  const args = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--write" || argument === "--check") {
      if (options.mode) throw new Error("Give exactly one of --write and --check");
      options.mode = argument.slice(2);
    } else if (argument === "--from-ref") options.ref = value();
    else if (argument === "--technical") options.technical = value();
    else if (argument === "--bugs") options.bugs = value();
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.mode) throw new Error("Give exactly one of --write and --check");
  if ((options.technical === null) !== (options.bugs === null)) throw new Error("--technical and --bugs go together");
  if (options.technical !== null && options.ref !== null) throw new Error("Give --from-ref or --technical and --bugs, not both");
  if (options.technical === null && options.ref === null) options.ref = "HEAD";
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const root = execFileSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const read = (file, path) => (options.ref !== null
    ? execFileSync("git", ["-C", root, "show", `${options.ref}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(resolve(path), "utf8"));
  const technicalText = read("TECHNICAL.md", options.technical);
  const bugsText = read("BUGS.md", options.bugs);
  try {
    if (options.mode === "write") {
      console.log(`SPLIT_DOCS_WRITE ${JSON.stringify(writeSplit(root, technicalText, bugsText))}`);
      return 0;
    }
    const { problems, additions, stats } = checkSplit(root, technicalText, bugsText);
    const status = problems.length === 0 ? "passed" : "failed";
    console.log(`SPLIT_DOCS_CHECK ${JSON.stringify({ status, ...stats, additions, problems: problems.slice(0, 20) })}`);
    return problems.length === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof AlreadySplitError) {
      const file = error.message.startsWith("TECHNICAL.md") ? "TECHNICAL.md" : "BUGS.md";
      const source = options.ref !== null ? options.ref : file === "TECHNICAL.md" ? options.technical : options.bugs;
      throw new Error(`${file} at ${source} is already split; pass the ref or files that hold the single-file guide`);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
