import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkSplit,
  planSplit,
  rebuildBugs,
  rebuildTechnical,
  slugify,
  splitBugs,
  splitSentences,
  splitTechnical,
  writeSplit
} from "../../scripts/split-docs.mjs";

// Fictional fixtures only; no text from the real guide or bug list.
const TECHNICAL = [
  "# Guide",
  "",
  "## First topic",
  "",
  "Alpha one. Alpha two.",
  "",
  "**Bold lead.** Beta one. Beta two.",
  "",
  "Scopes come in kinds:",
  "",
  "- `global`",
  "- `country`",
  "",
  "## Second topic",
  "",
  "```text",
  "a -> b",
  "```",
  "",
  "`pnpm thing:run [--x]` does a thing. It is fast.",
  ""
].join("\n");

const BUGS = [
  "# Bugs",
  "",
  "Intro line.",
  "",
  "## Open",
  "",
  "### Form stalls on Example's page",
  "",
  "The form stalls on the second page.",
  "It never recovers.",
  "",
  "## Resolved",
  "",
  "### Form stalls on Examples page",
  "",
  "Fixed by waiting for the page.",
  "",
  "",
  "### Another fixed bug",
  "",
  "#### Detail",
  "Fixed too.",
  "",
  "## Resolved: Legacy entry",
  "",
  "Old text.",
  ""
].join("\n");

function writeFiles(dir, files) {
  for (const [path, content] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

test("sentences split at sentence ends only, and join back to the line", () => {
  const cases = [
    ["One. Two! Three? Four.", ["One.", "Two!", "Three?", "Four."]],
    ["Use `a. B` here. Next.", ["Use `a. B` here.", "Next."]],
    ["**Lead. In.** Body text. More.", ["**Lead. In.**", "Body text.", "More."]],
    ["A U.S. person, e.g. Bob, has a B.S. Degree. Done.", ["A U.S. person, e.g. Bob, has a B.S. Degree.", "Done."]],
    ["It ends here. 1. Then more.", ["It ends here. 1.", "Then more."]],
    ["Ends.  Two spaces.", ["Ends.  Two spaces."]],
    ["A (see note.) Then.", ["A (see note.)", "Then."]],
    ["Unclosed `tick. Next.", ["Unclosed `tick.", "Next."]]
  ];
  for (const [input, expected] of cases) {
    const result = splitSentences(input);
    assert.deepEqual(result, expected, input);
    assert.equal(result.join(" "), input);
    for (const piece of result.slice(1)) assert.doesNotMatch(piece, /^(?:[-+*]\s|#|>|\d{1,9}[.)]\s)/);
  }
});

test("slugs are lower-case words joined by hyphens and cut at a hyphen", () => {
  assert.equal(slugify("Workday's “Bachelor's” Degree", 80), "workdays-bachelors-degree");
  const long = slugify("A very long title about an application form that keeps stalling forever", 30);
  assert.ok(long.length <= 30);
  assert.equal(long, "a-very-long-title-about-an");
  assert.equal(slugify("", 80), "part");
});

test("the guide splits into one folder per section and one file per paragraph, and rebuilds exactly", () => {
  const { files } = planSplit(TECHNICAL, BUGS);
  assert.equal(files.get("docs/technical/01-first-topic/010-alpha-one-alpha-two.md"), "Alpha one.\nAlpha two.\n");
  assert.equal(files.get("docs/technical/01-first-topic/020-bold-lead.md"), "**Bold lead.**\nBeta one.\nBeta two.\n");
  assert.equal(files.get("docs/technical/01-first-topic/030-scopes-come-in-kinds.md"), "Scopes come in kinds:\n\n- `global`\n- `country`\n");
  assert.equal(files.get("docs/technical/02-second-topic/010-a-b.md"), "```text\na -> b\n```\n");
  assert.equal(files.get("docs/technical/02-second-topic/020-pnpm-thing-run-x-does-a-thing.md"), "`pnpm thing:run [--x]` does a thing.\nIt is fast.\n");
  assert.equal([...files.keys()].filter((path) => path.startsWith("docs/")).length, 5);
  assert.equal(rebuildTechnical(splitTechnical(TECHNICAL)), TECHNICAL);
  const index = files.get("TECHNICAL.md");
  assert.ok(index.startsWith("# Guide\n\n"));
  assert.ok(index.includes("## First topic\n\n`docs/technical/01-first-topic/`"));
  assert.ok(index.includes("## Second topic\n\n`docs/technical/02-second-topic/`"));
});

test("the guide split refuses what it cannot split losslessly", () => {
  assert.throws(() => splitTechnical("# Guide\n\n## A\n\nOne.\n\n\nTwo.\n"), /double blank/);
  assert.throws(() => splitTechnical("# Guide\n\n## A\n\n`docs/technical/01-a/`\n"), /already split/);
  assert.throws(() => splitTechnical("# Guide\n\n## A\n\nOne line\nand another.\n"), /multi-line paragraph/);
});

test("the bug list splits into one file per bug, and rebuilds exactly", () => {
  const { files } = planSplit(TECHNICAL, BUGS);
  assert.equal(files.get("bugs/open/form-stalls-on-examples-page.md"), "# Form stalls on Example's page\n\nThe form stalls on the second page.\nIt never recovers.\n");
  assert.equal(files.get("bugs/resolved/form-stalls-on-examples-page-2.md"), "# Form stalls on Examples page\n\nFixed by waiting for the page.\n");
  assert.equal(files.get("bugs/resolved/another-fixed-bug.md"), "# Another fixed bug\n\n#### Detail\nFixed too.\n");
  assert.equal(files.get("bugs/resolved/legacy-entry.md"), "# Resolved: Legacy entry\n\nOld text.\n");
  assert.equal([...files.keys()].filter((path) => path.startsWith("bugs/")).length, 4);
  assert.equal(rebuildBugs(splitBugs(BUGS)), BUGS);
  const index = files.get("BUGS.md");
  assert.ok(index.startsWith("# Bugs\n\nIntro line.\n\n"));
  assert.ok(index.endsWith("## Open\n\n`bugs/open/`\n\n## Resolved\n\n`bugs/resolved/`\n"));
  assert.ok(!index.split("\n").some((line) => line.startsWith("### ")));
});

test("the bug split refuses unexpected structure and an already split list", () => {
  assert.throws(() => splitBugs("# Bugs\n\n## Open\n\n### A\n\nBody.\n\n## Other\n\n## Resolved\n\n### B\n\nBody.\n"), /unexpected heading/);
  assert.throws(() => splitBugs("# Bugs\n\n## Open\n\n`bugs/open/`\n\n## Resolved\n\n`bugs/resolved/`\n"), /already split|no bug entries/);
  assert.throws(() => splitBugs("# Bugs\n\n## Open\n\nStray text.\n\n### A\n\nBody.\n\n## Resolved\n\n### B\n\nBody.\n"));
});

test("the check finds changed files, allows added ones, and a rewrite drops stale ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "split-docs-"));
  try {
    writeFiles(dir, planSplit(TECHNICAL, BUGS).files);
    assert.deepEqual(checkSplit(dir, TECHNICAL, BUGS).problems, []);

    writeFileSync(join(dir, "bugs/resolved/legacy-entry.md"), "# Resolved: Legacy entry\n\nChanged.\n");
    const changed = checkSplit(dir, TECHNICAL, BUGS).problems;
    assert.equal(changed.length, 1);
    assert.match(changed[0], /bugs\/resolved\/legacy-entry\.md/);
    writeFileSync(join(dir, "bugs/resolved/legacy-entry.md"), "# Resolved: Legacy entry\n\nOld text.\n");

    writeFileSync(join(dir, "docs/technical/01-first-topic/015-extra.md"), "An extra sentence.\n");
    const added = checkSplit(dir, TECHNICAL, BUGS);
    assert.deepEqual(added.problems, []);
    assert.deepEqual(added.additions, ["docs/technical/01-first-topic/015-extra.md"]);

    writeFileSync(join(dir, "bugs/open/stale.md"), "# Stale\n\nOld.\n");
    writeSplit(dir, TECHNICAL, BUGS);
    assert.equal(existsSync(join(dir, "bugs/open/stale.md")), false);
    assert.deepEqual(checkSplit(dir, TECHNICAL, BUGS), { problems: [], additions: [], stats: planSplit(TECHNICAL, BUGS).stats });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
