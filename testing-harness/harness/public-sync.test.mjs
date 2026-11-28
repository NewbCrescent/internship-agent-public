import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  RUN_ID_MASK,
  applyReplacements,
  loadProfileValues,
  parseScrubList,
  preparePublicTree,
  profileValueRules,
  scanPath,
  scanText,
  scrubText,
  scrubTree,
  syncPublic
} from "../../scripts/public-sync.mjs";

// A fictional deny-list: none of these names is real.
const LIST = parseScrubList({
  replace: [
    { find: "Zorblax", replace: "Example Co" },
    { find: "zorblax", replace: "exampleco" },
    { find: "Quillon Labs", replace: "Sample Labs" },
    { find: "quillon.wd9", replace: "employer-a.wd9" }
  ],
  forbid: [{ pattern: "jane\\s+fixturesson", note: "fictional candidate name" }],
  allowSecrets: ["sk-abcdefghijklmnopqrstuvwxyz"]
});

function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixtureRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "public-sync-repo-"));
  git(dir, "init", "--quiet");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "fixture");
  return dir;
}

test("scrub list validation refuses malformed rules and self-matching replacements", () => {
  assert.throws(() => parseScrubList([]), /expected an object/);
  assert.throws(() => parseScrubList({ replace: [{ find: "", replace: "x" }] }), /non-empty find/);
  assert.throws(() => parseScrubList({ replace: [{ find: "Zorblax", replace: "New Zorblax" }] }), /contains its own find/);
  assert.throws(() => parseScrubList({ forbid: [{ pattern: "(" }] }), /not a valid regular expression/);
});

test("replacements are whole-word, longest first, and survive a line break", () => {
  assert.equal(applyReplacements("Zorblax and Zorblaxian at zorblax.example", LIST), "Example Co and Zorblaxian at exampleco.example");
  assert.equal(applyReplacements("Quillon Labs (quillon.wd9) and\nQuillon\nLabs", LIST), "Sample Labs (employer-a.wd9) and\nSample\nLabs");
});

test("run ids are masked in docs and comments, never in code", () => {
  assert.equal(scrubText("Run 1a2b3c4d and 12345678; sha 0123456789abcdef stays.", "BUGS.md", LIST), `Run ${RUN_ID_MASK} and ${RUN_ID_MASK}; sha 0123456789abcdef stays.`);
  const code = [
    "// the 0f1e2d3c run",
    // Built from parts so this file's own export never masks the sample (its "//" follows a quote).
    ["const id = \"a1c3e000\";", "// job 5e6f7a8b"].join(" "),
    "const url = \"https://example.test/a1c3e000\";",
    "const glob = \"packages/*\"; const other = \"a9b8c7d6\";",
    "/* held on",
    "   run 9c8d7e6f */ const kept = \"9c8d7e6f\";",
    "const uuid = \"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d\";"
  ].join("\n");
  assert.equal(scrubText(code, "src/example.ts", LIST), [
    `// the ${RUN_ID_MASK} run`,
    `const id = "a1c3e000"; // job ${RUN_ID_MASK}`,
    "const url = \"https://example.test/a1c3e000\";",
    "const glob = \"packages/*\"; const other = \"a9b8c7d6\";",
    "/* held on",
    `   run ${RUN_ID_MASK} */ const kept = "9c8d7e6f";`,
    "const uuid = \"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d\";"
  ].join("\n"));
  assert.equal(scrubText("<!-- run 4a5b6c7d --><p>4a5b6c7d</p>", "fixture.html", LIST), `<!-- run ${RUN_ID_MASK} --><p>4a5b6c7d</p>`);
});

test("the scan fails on leftovers in any case and never echoes a secret", () => {
  const token = ["ghp", "_", "Q".repeat(36)].join("");
  const hits = scanText(`ZORBLAX\nJane Fixturesson\nrun 1a2b3c4d\nkey ${token}\nsk-abcdefghijklmnopqrstuvwxyz\nGITHUB_TOKEN=\n`, "notes.md", LIST);
  assert.deepEqual(hits.map((hit) => [hit.line, hit.kind]), [[1, "deny-list"], [2, "forbidden"], [3, "run-id"], [4, "secret"]]);
  assert.ok(hits.every((hit) => !JSON.stringify(hit).includes(token)));
  assert.deepEqual(scanText("MODEL_API_KEY=real-looking-value\n", ".env.example", LIST).map((hit) => hit.kind), ["secret"]);
  // The lockfile is never rewritten or name-scanned (hashes could spell anything), but secrets still count.
  assert.deepEqual(scanText("integrity: sha512-zorblax\n", "pnpm-lock.yaml", LIST), []);
  assert.equal(scrubText("zorblax", "pnpm-lock.yaml", LIST), "zorblax");
});

test("the public tree drops private-only paths and takes the public README", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-sync-tree-"));
  try {
    mkdirSync(join(dir, "triage"));
    writeFileSync(join(dir, "triage", "list.mjs"), "x");
    writeFileSync(join(dir, "HANDOFF.md"), "notes");
    writeFileSync(join(dir, "README.md"), "private");
    writeFileSync(join(dir, "PUBLIC-README.md"), "public");
    writeFileSync(join(dir, "notes.ts"), "// Zorblax run 1a2b3c4d\n");
    quiet(() => preparePublicTree(dir));
    assert.equal(existsSync(join(dir, "HANDOFF.md")), false);
    assert.equal(existsSync(join(dir, "triage")), false);
    assert.equal(existsSync(join(dir, "PUBLIC-README.md")), false);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "public");
    assert.deepEqual(scrubTree(dir, LIST), { hits: [], changed: 1 });
    assert.equal(readFileSync(join(dir, "notes.ts"), "utf8"), `// Example Co run ${RUN_ID_MASK}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nested doc and bug files are scrubbed like root docs", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-sync-docs-"));
  try {
    mkdirSync(join(dir, "docs", "technical", "01-topic"), { recursive: true });
    mkdirSync(join(dir, "bugs", "resolved"), { recursive: true });
    writeFileSync(join(dir, "docs/technical/01-topic/010-a-sentence.md"), "Zorblax ran 1a2b3c4d.\nNext sentence.\n");
    writeFileSync(join(dir, "bugs/resolved/clean-bug.md"), "# Clean bug\n\nRun 12345678 failed.\n");
    assert.deepEqual(scrubTree(dir, LIST), { hits: [], changed: 2 });
    assert.equal(readFileSync(join(dir, "docs/technical/01-topic/010-a-sentence.md"), "utf8"), `Example Co ran ${RUN_ID_MASK}.\nNext sentence.\n`);
    assert.equal(readFileSync(join(dir, "bugs/resolved/clean-bug.md"), "utf8"), `# Clean bug\n\nRun ${RUN_ID_MASK} failed.\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file names are scanned and fail closed", () => {
  assert.deepEqual(scanPath("bugs/open/zorblax-form-fails.md", LIST), [{ path: "bugs/open/zorblax-form-fails.md", line: 0, kind: "path deny-list", note: "Zorblax" }]);
  assert.deepEqual(scanPath("bugs/open/run-1a2b3c4d-held.md", LIST).map((hit) => hit.kind), ["path run-id"]);
  assert.deepEqual(scanPath("docs/technical/06-job-posting-model/010-jobs-holds-posting-identity.md", LIST), []);
  const dir = mkdtempSync(join(tmpdir(), "public-sync-names-"));
  try {
    mkdirSync(join(dir, "bugs", "open"), { recursive: true });
    writeFileSync(join(dir, "bugs/open/quillon-labs-form.md"), "# A form\n\nClean.\n");
    assert.deepEqual(scrubTree(dir, LIST).hits.map((hit) => [hit.path, hit.line, hit.kind]), [["bugs/open/quillon-labs-form.md", 0, "path deny-list"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync fails closed on a leftover and otherwise mirrors the export into the clone", () => {
  const work = mkdtempSync(join(tmpdir(), "public-sync-work-"));
  const leaky = fixtureRepo({ "README.md": "Built by Jane Fixturesson.\n" });
  const repo = fixtureRepo({ "README.md": "private", "PUBLIC-README.md": "Zorblax agent\n", "HANDOFF.md": "notes", ".gitignore": "ignored.txt\n", "src/a.ts": "export const a = 1;\n" });
  const clone = fixtureRepo({ "old.txt": "gone", ".gitignore": "ignored.txt\n", "src/a.ts": "stale\n" });
  git(clone, "config", "user.name", "Public Fixture");
  git(clone, "config", "user.email", "public@example.test");
  try {
    const out = join(work, "out");
    assert.equal(quiet(() => syncPublic(leaky, LIST, { out })), 1);
    assert.equal(existsSync(out), false);

    writeFileSync(join(clone, "ignored.txt"), "local");
    assert.equal(quiet(() => syncPublic(repo, LIST, { publicDir: clone, dryRun: true })), 0);
    assert.equal(existsSync(join(clone, "old.txt")), true);

    assert.equal(quiet(() => syncPublic(repo, LIST, { publicDir: clone })), 0);
    assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "Example Co agent\n");
    assert.equal(readFileSync(join(clone, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(existsSync(join(clone, "old.txt")), false);
    assert.equal(readFileSync(join(clone, ".gitignore"), "utf8"), "ignored.txt\n");
    assert.equal(existsSync(join(clone, "HANDOFF.md")), false);
    assert.equal(readFileSync(join(clone, "ignored.txt"), "utf8"), "local");
    assert.match(git(clone, "log", "-1", "--format=%s"), /^Sync from private \d{4}-\d{2}-\d{2}\n$/);
    assert.equal(git(clone, "log", "-1", "--format=%an"), "Public Fixture\n");
    assert.equal(git(clone, "ls-files", "ignored.txt"), "");
    assert.equal(git(clone, "status", "--porcelain"), "");
    assert.equal(git(clone, "rev-list", "--count", "HEAD"), "2\n");
  } finally {
    for (const dir of [work, leaky, repo, clone]) rmSync(dir, { recursive: true, force: true });
  }
});

// Fictional saved values: no real street, ZIP, county, or phone.
const SAVED = { streets: ["4321 Fixture Lane"], zips: ["90999", null], counties: ["Quarrow County"], phones: ["+1 (555) 010-4477"] };
const PROFILE_LIST = { ...LIST, profile: profileValueRules(SAVED) };

test("saved street, ZIP, county, and phone values fail the scan without being echoed", () => {
  const text = [
    "Mail to 4321 fixture\nlane.",
    "Near 4321 Fixture, as a form shortened it.",
    "ZIP 90999-1234 on the form.",
    "Quarrow, CA was the county option.",
    "Call 555.010.4477 or (555) 010-4477.",
    "Berkeley rules, ZIP 909990, 5550104477123, and Quarrowville stay."
  ].join("\n");
  const hits = scanText(text, "bugs/open/example.md", PROFILE_LIST);
  assert.deepEqual(hits.map((hit) => [hit.line, hit.kind, hit.note]), [
    [1, "profile", "saved street"],
    [1, "profile", "saved street"],
    [3, "profile", "saved street"],
    [4, "profile", "saved ZIP"],
    [5, "profile", "saved county"],
    [6, "profile", "saved phone"],
    [6, "profile", "saved phone"]
  ]);
  for (const value of ["4321", "Fixture", "Quarrow", "90999", "0104477"]) assert.ok(hits.every((hit) => !JSON.stringify(hit).includes(value)));
  assert.deepEqual(scanPath("bugs/open/quarrow-county-list-fails.md", PROFILE_LIST).map((hit) => [hit.kind, hit.note]), [["path profile", "saved county"]]);
  assert.deepEqual(scanText(text, "bugs/open/example.md", LIST), []);
});

test("saved values are read read-only from a profile database, and a missing one stops the sync", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-sync-profile-"));
  try {
    const file = join(dir, "profile.sqlite");
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE candidates (id TEXT, phone TEXT, address_line1 TEXT, address_postal_code TEXT, high_school_postal_code TEXT);
      CREATE TABLE candidate_facts (key TEXT, value_json TEXT, superseded_at TEXT, revoked_at TEXT);`);
    database.prepare("INSERT INTO candidates VALUES (?, ?, ?, ?, ?)").run("c1", "+1 (555) 010-4477", "4321 Fixture Lane", "90999", "90998");
    const fact = database.prepare("INSERT INTO candidate_facts VALUES (?, ?, ?, ?)");
    fact.run("county_of_residence", JSON.stringify("Quarrow County"), null, null);
    fact.run("county_of_residence", JSON.stringify("Old County"), "2026-01-01", null);
    fact.run("pronouns", JSON.stringify("they/them"), null, null);
    database.close();
    assert.deepEqual(loadProfileValues(file), { streets: ["4321 Fixture Lane"], zips: ["90999", "90998"], counties: ["Quarrow County"], phones: ["+1 (555) 010-4477"] });
    assert.throws(() => loadProfileValues(join(dir, "missing.sqlite")), /No profile database/);
    assert.equal(existsSync(join(dir, "missing.sqlite")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync refuses to publish a file holding a saved profile value", () => {
  const work = mkdtempSync(join(tmpdir(), "public-sync-work-"));
  const leaky = fixtureRepo({ "bugs/open/list.md": "Options read \"Berkeley, Quarrow, CA\".\n" });
  const clean = fixtureRepo({ "bugs/open/list.md": "Options read \"Berkeley, <county>, CA\".\n" });
  try {
    const out = join(work, "out");
    assert.equal(quiet(() => syncPublic(leaky, PROFILE_LIST, { out })), 1);
    assert.equal(existsSync(out), false);
    assert.equal(quiet(() => syncPublic(clean, PROFILE_LIST, { out })), 0);
    assert.equal(readFileSync(join(out, "bugs/open/list.md"), "utf8"), "Options read \"Berkeley, <county>, CA\".\n");
  } finally {
    for (const dir of [work, leaky, clean]) rmSync(dir, { recursive: true, force: true });
  }
});
