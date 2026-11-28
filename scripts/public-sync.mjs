#!/usr/bin/env node
// Public mirror sync: exports a ref's tracked files, drops private-only paths,
// scrubs them with a local deny-list, scans the result, and fails closed when
// anything private remains. Only then does it write a local clone of the
// public repository. See docs/technical/13-public-mirror/.
//
//   pnpm public:sync -- --public-dir <clone> [--ref <ref>] [--scrub <file>]
//                       [--profile-db <file>] [--verify] [--dry-run] [--push]
//                       [--out <new dir>]
//
// The deny-list (default data/public-scrub.json, Git-ignored) holds the real
// names and hosts; this file never does. The candidate's saved street, ZIP,
// county, and phone are read from the local profile database (default
// data/profiles/real/internship-agent.sqlite, opened read-only) and compared in
// memory. The script never reads .env files and never prints a secret or a
// saved profile value it finds, only where it is.
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Tracked paths that never leave the private repository (a trailing "/" is a folder). */
export const PRIVATE_ONLY_PATHS = ["HANDOFF.md", "triage/"];

/** The public README lives in the private tree under this name and replaces README.md in the export. */
export const PUBLIC_README = "PUBLIC-README.md";

export const DEFAULT_SCRUB_FILE = "data/public-scrub.json";

/** The real profile's database, read-only, for the saved-value scan. */
export const DEFAULT_PROFILE_DB = "data/profiles/real/internship-agent.sqlite";

/** Files that are neither rewritten nor name-scanned (hashes could spell anything); secrets are still scanned. */
const NO_REWRITE = new Set(["pnpm-lock.yaml"]);

/** Extensions whose comments get run-id masking; .md files are masked in full. */
const COMMENT_EXTENSIONS = /\.(?:[cm]?[jt]sx?|html|css|sql|ya?ml|sh)$/;

/** Secret shapes. Each pattern is written so its own source text does not match it. */
export const SECRET_PATTERNS = [
  { note: "OpenAI-style API key", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
  { note: "GitHub token", pattern: /(?<![A-Za-z0-9])(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g },
  { note: "GitHub fine-grained token", pattern: /github_pat_[A-Za-z0-9_]{20,}/g },
  { note: "Slack token", pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { note: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { note: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { note: "Discord bot token", pattern: /(?<![A-Za-z0-9])[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g },
  { note: "assigned API key, password, token, or secret", pattern: /^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:API_KEY|PASSWORD|TOKEN|SECRET)[ \t]*=[ \t]*["']?[^\s"'#]+/gm }
];

/** In comments an id needs a digit and a letter (so an 8-digit date stays); in .md files any 8-hex token with a digit is one. */
const RUN_ID = /(?<![0-9A-Za-z_#-])(?=[0-9a-f]{0,7}[0-9])(?=[0-9a-f]{0,7}[a-f])[0-9a-f]{8}(?![0-9A-Za-z_-])/g;
const DOC_RUN_ID = /(?<![0-9A-Za-z_#-])(?=[0-9a-f]{0,7}[0-9])[0-9a-f]{8}(?![0-9A-Za-z_-])/g;
export const RUN_ID_MASK = "<run id>";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A find string as a regex: literal, spaces match any whitespace run (names wrap across lines), whole words unless `word: false`. */
function findPattern(rule, flags) {
  const body = rule.find.split(/\s+/).map(escapeRegExp).join("\\s+");
  return rule.word === false ? new RegExp(body, flags) : new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

/** Whole-word tokens joined by any whitespace run, case-insensitive. */
function tokensPattern(tokens) {
  return new RegExp(`(?<![A-Za-z0-9])${tokens.map(escapeRegExp).join("\\s+")}(?![A-Za-z0-9])`, "gi");
}

/**
 * Scan rules for the candidate's saved street, ZIP, county, and phone. Each rule's note names the kind of
 * value, never the value. A street also matches its house number and first street word ("12 Elm" of
 * "12 Elm Street"), a US ZIP matches its five digits not inside a longer number, a county matches with
 * or without "County", and a phone matches its last ten digits with any spacing, dots, dashes, or brackets.
 */
export function profileValueRules(values) {
  const rules = [];
  const strings = (list) => (list ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
  for (const street of strings(values.streets)) {
    const tokens = street.split(/\s+/);
    rules.push({ note: "saved street", pattern: tokensPattern(tokens) });
    if (tokens.length > 2 && /^\d+[A-Za-z]?$/.test(tokens[0])) rules.push({ note: "saved street", pattern: tokensPattern(tokens.slice(0, 2)) });
  }
  for (const zip of strings(values.zips)) {
    const us = /^(\d{5})(?:-\d{4})?$/.exec(zip);
    rules.push({ note: "saved ZIP", pattern: us ? new RegExp(`(?<![0-9])${us[1]}(?![0-9])`, "g") : tokensPattern(zip.split(/\s+/)) });
  }
  for (const county of strings(values.counties)) {
    const tokens = county.replace(/\s+county$/i, "").split(/\s+/).filter(Boolean);
    if (tokens.length > 0) rules.push({ note: "saved county", pattern: tokensPattern(tokens) });
  }
  for (const phone of strings(values.phones)) {
    const digits = phone.replace(/\D/g, "").slice(-10);
    if (digits.length < 7) continue;
    rules.push({ note: "saved phone", pattern: new RegExp(`(?<![0-9])${digits.split("").join("[\\s().+-]{0,3}")}(?![0-9])`, "g") });
  }
  return rules;
}

/**
 * Reads the saved street, ZIP, county, and phone from a profile database, read-only. County is not a profile
 * column, so it comes from any current saved fact whose key names a county. A missing database throws:
 * nothing is exported without this scan.
 */
export function loadProfileValues(file) {
  if (!existsSync(file)) throw new Error(`No profile database at ${file}; give --profile-db <file> (nothing is exported without the saved-value scan)`);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const has = (table) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
    const values = { streets: [], zips: [], counties: [], phones: [] };
    if (has("candidates")) {
      for (const row of database.prepare("SELECT * FROM candidates").all()) {
        values.streets.push(row.address_line1);
        values.zips.push(row.address_postal_code, row.high_school_postal_code);
        values.phones.push(row.phone);
      }
    }
    if (has("candidate_facts")) {
      const facts = database.prepare("SELECT value_json FROM candidate_facts WHERE revoked_at IS NULL AND superseded_at IS NULL AND lower(key) LIKE '%county%'").all();
      for (const fact of facts) {
        try {
          const value = JSON.parse(String(fact.value_json));
          if (typeof value === "string") values.counties.push(value);
        } catch { /* a malformed value is not a county */ }
      }
    }
    return values;
  } finally {
    database.close();
  }
}

/** Validates the parsed deny-list and returns it in a fixed shape; throws on anything malformed. */
export function parseScrubList(value) {
  const fail = (message) => { throw new Error(`Invalid scrub list: ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const replace = value.replace ?? [];
  const forbid = value.forbid ?? [];
  const allowSecrets = value.allowSecrets ?? [];
  if (!Array.isArray(replace) || !Array.isArray(forbid) || !Array.isArray(allowSecrets)) fail("replace, forbid, and allowSecrets must be arrays");
  replace.forEach((rule, index) => {
    if (!rule || typeof rule.find !== "string" || rule.find.trim() === "" || typeof rule.replace !== "string") fail(`replace[${index}] needs a non-empty find and a replace string`);
    if (rule.word !== undefined && typeof rule.word !== "boolean") fail(`replace[${index}].word must be a boolean`);
    if (rule.scanCase !== undefined && typeof rule.scanCase !== "boolean") fail(`replace[${index}].scanCase must be a boolean`);
    if (findPattern(rule, "i").test(rule.replace)) fail(`replace[${index}]'s replacement contains its own find`);
  });
  forbid.forEach((rule, index) => {
    if (!rule || typeof rule.pattern !== "string" || rule.pattern === "") fail(`forbid[${index}] needs a pattern`);
    try { new RegExp(rule.pattern, rule.flags ?? "i"); } catch { fail(`forbid[${index}] is not a valid regular expression`); }
  });
  allowSecrets.forEach((entry, index) => { if (typeof entry !== "string" || entry === "") fail(`allowSecrets[${index}] must be a non-empty string`); });
  // Longest finds first, so "Example Labs Inc" is replaced before "Example Labs".
  const ordered = replace.map((rule) => ({ ...rule })).sort((a, b) => b.find.length - a.find.length);
  return { replace: ordered, forbid: forbid.map((rule) => ({ ...rule })), allowSecrets: [...allowSecrets], profile: [] };
}

/** Applies every replace rule. A match that wrapped across a line break keeps one break in its replacement. */
export function applyReplacements(text, list) {
  let output = text;
  for (const rule of list.replace) {
    output = output.replace(findPattern(rule, "g"), (match) => (match.includes("\n") && rule.replace.includes(" ") ? rule.replace.replace(" ", "\n") : rule.replace));
  }
  return output;
}

/** Masks 8-hex run or job ids that are not part of a longer id or UUID. `doc` also masks all-digit ids. */
export function maskRunIds(text, doc = false) {
  return text.replace(doc ? DOC_RUN_ID : RUN_ID, RUN_ID_MASK);
}

/**
 * Masks run ids only inside comments: // and # (to the end of the line), /* … *\/, and <!-- … -->.
 * A comment opener counts only at the start of a line or after whitespace, so a URL's "//" or a
 * glob's "/*" inside code is never taken for a comment.
 */
export function maskRunIdsInComments(text, path) {
  const hashComments = /\.(?:ya?ml|sh)$/.test(path);
  let block = null;
  return text.split("\n").map((line) => {
    let out = "";
    let rest = line;
    let lineStart = true;
    while (rest.length > 0) {
      if (block) {
        const end = rest.indexOf(block);
        if (end === -1) { out += maskRunIds(rest); rest = ""; break; }
        out += maskRunIds(rest.slice(0, end + block.length));
        rest = rest.slice(end + block.length);
        block = null;
        lineStart = false;
        continue;
      }
      const opener = (pattern) => {
        const match = (lineStart ? new RegExp(`(?:^|\\s)${pattern}`) : new RegExp(`\\s${pattern}`)).exec(rest);
        return match ? match.index + match[0].search(/\S/) : -1;
      };
      const starts = [
        { index: opener("\\/\\/"), close: "\n" },
        { index: opener("\\/\\*(?=[\\s*]|$)"), close: "*/" },
        { index: opener("<!--"), close: "-->" },
        { index: hashComments ? opener("#") : -1, close: "\n" }
      ].filter((start) => start.index !== -1).sort((a, b) => a.index - b.index);
      if (starts.length === 0) { out += rest; rest = ""; break; }
      const first = starts[0];
      out += rest.slice(0, first.index);
      rest = rest.slice(first.index);
      if (first.close === "\n") { out += maskRunIds(rest); rest = ""; break; }
      block = first.close;
      out += rest.slice(0, 2);
      rest = rest.slice(2);
    }
    return out;
  }).join("\n");
}

/** Scrubs one file's text: replacements everywhere, run ids in all of a .md file and in other files' comments. */
export function scrubText(text, path, list) {
  if (NO_REWRITE.has(path)) return text;
  const replaced = applyReplacements(text, list);
  if (path.endsWith(".md")) return maskRunIds(replaced, true);
  if (COMMENT_EXTENSIONS.test(path)) return maskRunIdsInComments(replaced, path);
  return replaced;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Everything private still in a file: deny-list finds, forbidden patterns, saved profile values, run ids, and secrets. Never returns a secret or a saved value. */
export function scanText(text, path, list) {
  const hits = [];
  if (!NO_REWRITE.has(path)) {
    // One scan per find, case-insensitive unless `scanCase` (case variants of one name are one rule here).
    const seen = new Set();
    for (const rule of list.replace) {
      const key = rule.scanCase ? `=${rule.find}` : `~${rule.find.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const match of text.matchAll(findPattern(rule, rule.scanCase ? "g" : "gi"))) {
        hits.push({ path, line: lineOf(text, match.index), kind: "deny-list", note: rule.find });
      }
    }
    for (const rule of list.forbid) {
      for (const match of text.matchAll(new RegExp(rule.pattern, `${(rule.flags ?? "i").replace("g", "")}g`))) {
        hits.push({ path, line: lineOf(text, match.index), kind: "forbidden", note: rule.note ?? rule.pattern });
      }
    }
    for (const rule of list.profile ?? []) {
      for (const match of text.matchAll(rule.pattern)) {
        hits.push({ path, line: lineOf(text, match.index), kind: "profile", note: rule.note });
      }
    }
    const masked = path.endsWith(".md") ? maskRunIds(text, true) : COMMENT_EXTENSIONS.test(path) ? maskRunIdsInComments(text, path) : text;
    if (masked !== text) {
      const after = masked.split("\n");
      text.split("\n").forEach((line, index) => {
        if (line !== after[index]) hits.push({ path, line: index + 1, kind: "run-id", note: "8-hex run or job id" });
      });
    }
  }
  for (const { note, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (list.allowSecrets.some((allowed) => match[0].includes(allowed))) continue;
      hits.push({ path, line: lineOf(text, match.index), kind: "secret", note });
    }
  }
  return hits;
}

/** Private items in a file's path (doc and bug file names come from titles), read as written and with -_./ as spaces. */
export function scanPath(path, list) {
  const hits = [];
  const seen = new Set();
  for (const form of [path, path.replace(/[-_./]+/g, " ")]) {
    for (const hit of scanText(form, "path.md", list)) {
      const key = `${hit.kind}\n${hit.note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ path, line: 0, kind: `path ${hit.kind}`, note: hit.note });
    }
  }
  return hits;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function walk(root, skipGit = true) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipGit && dir === root && entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

/** Drops private-only paths and swaps in the public README. Returns notes for the report. */
export function preparePublicTree(dir) {
  const notes = [];
  for (const path of PRIVATE_ONLY_PATHS) {
    const full = join(dir, path);
    if (existsSync(full)) { rmSync(full, { recursive: true, force: true }); notes.push(`dropped ${path}`); }
  }
  const publicReadme = join(dir, PUBLIC_README);
  if (existsSync(publicReadme)) {
    renameSync(publicReadme, join(dir, "README.md"));
    notes.push(`${PUBLIC_README} -> README.md`);
  } else {
    notes.push(`warning: ${PUBLIC_README} is not in this ref; README.md is the private one`);
  }
  return notes;
}

/** Scrubs every file of a prepared tree in place and returns the hits that remain. */
export function scrubTree(dir, list) {
  const hits = [];
  let changed = 0;
  for (const path of walk(dir)) {
    hits.push(...scanPath(path, list));
    const full = join(dir, path);
    const buffer = readFileSync(full);
    if (isBinary(buffer)) {
      hits.push(...scanText(buffer.toString("latin1"), path, list));
      continue;
    }
    const text = buffer.toString("utf8");
    const scrubbed = scrubText(text, path, list);
    if (scrubbed !== text) { writeFileSync(full, scrubbed); changed += 1; }
    hits.push(...scanText(scrubbed, path, list));
  }
  return { hits, changed };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}${result.stderr ? `: ${String(result.stderr).trim()}` : ""}`);
  }
  return result.stdout;
}

function exportRef(repo, ref, dir) {
  const tar = spawnSync("git", ["-C", repo, "archive", "--format=tar", ref], { maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (tar.status !== 0) throw new Error(`git archive ${ref} failed: ${String(tar.stderr).trim()}`);
  run("tar", ["-x", "-C", dir], { input: tar.stdout, encoding: "buffer" });
}

function clonePaths(clone) {
  const tracked = run("git", ["-C", clone, "ls-files", "-z"]).split("\0").filter(Boolean);
  const untracked = run("git", ["-C", clone, "ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  return new Set([...tracked, ...untracked]);
}

/** What syncing `source` into `clone` would change, ignoring the clone's .git and its ignored files. */
export function planSync(source, clone) {
  const wanted = walk(source);
  const present = clonePaths(clone);
  const add = [];
  const update = [];
  for (const path of wanted) {
    const target = join(clone, path);
    if (!existsSync(target)) add.push(path);
    else if (!lstatSync(target).isFile() || !readFileSync(target).equals(readFileSync(join(source, path))) || (lstatSync(target).mode & 0o111) !== (lstatSync(join(source, path)).mode & 0o111)) update.push(path);
  }
  const wantedSet = new Set(wanted);
  const remove = [...present].filter((path) => !wantedSet.has(path)).sort();
  return { add, update, remove };
}

function applySync(source, clone, plan) {
  for (const path of [...plan.add, ...plan.update]) {
    const target = join(clone, path);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(join(source, path), target);
    chmodSync(target, lstatSync(join(source, path)).mode & 0o777);
  }
  for (const path of plan.remove) {
    rmSync(join(clone, path), { force: true });
    let dir = dirname(join(clone, path));
    while (dir.startsWith(clone + sep) && readdirSync(dir).length === 0) { rmdirSync(dir); dir = dirname(dir); }
  }
}

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function parseArgs(argv) {
  const options = { ref: "HEAD", scrub: null, profileDb: null, publicDir: null, out: null, verify: false, dryRun: false, push: false };
  const args = argv.filter((argument) => argument !== "--");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value`);
      index += 1;
      return next;
    };
    if (argument === "--ref") options.ref = value();
    else if (argument === "--scrub") options.scrub = value();
    else if (argument === "--profile-db") options.profileDb = value();
    else if (argument === "--public-dir") options.publicDir = value();
    else if (argument === "--out") options.out = value();
    else if (argument === "--verify") options.verify = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--push") options.push = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.publicDir && !options.out && !options.dryRun) throw new Error("Give --public-dir <clone>, --out <new dir>, or --dry-run");
  if (options.push && (options.dryRun || !options.publicDir)) throw new Error("--push needs --public-dir and no --dry-run");
  return options;
}

/** Reads and validates a scrub list file; never a .env file. */
export function loadScrubList(file) {
  if (/(?:^|[/\\])\.env(?:\.|$)/.test(file)) throw new Error("The scrub list may not be a .env file");
  if (!existsSync(file)) throw new Error(`No scrub list at ${file}; nothing is exported without one`);
  return parseScrubList(JSON.parse(readFileSync(file, "utf8")));
}

function main(argv) {
  const options = parseArgs(argv);
  const repo = run("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"]).trim();
  const list = loadScrubList(resolve(repo, options.scrub ?? DEFAULT_SCRUB_FILE));
  const profile = profileValueRules(loadProfileValues(resolve(repo, options.profileDb ?? DEFAULT_PROFILE_DB)));
  console.log(`profile scan: ${profile.length} saved-value rules`);
  return syncPublic(repo, { ...list, profile }, options);
}

/** Export, scrub, scan, optionally verify, then write --out and/or the clone. Returns the exit code. */
export function syncPublic(repo, list, options) {
  const commit = run("git", ["-C", repo, "rev-parse", "--verify", `${options.ref ?? "HEAD"}^{commit}`]).trim();

  const work = mkdtempSync(join(tmpdir(), "public-sync-"));
  const tree = join(work, "tree");
  mkdirSync(tree);
  try {
    exportRef(repo, commit, tree);
    for (const note of preparePublicTree(tree)) console.log(note);
    const { hits, changed } = scrubTree(tree, list);
    console.log(`scrubbed ${changed} files with ${list.replace.length} replacements`);
    if (hits.length > 0) {
      console.error(`Scan failed: ${hits.length} private item(s) remain:`);
      for (const hit of hits) console.error(`  ${hit.path}:${hit.line} ${hit.kind}: ${hit.note}`);
      return 1;
    }
    console.log("scan: clean (deny-list, forbidden patterns, saved profile values, run ids, secrets)");

    if (options.verify) {
      // A throwaway copy, so installs and build caches never reach the export.
      const check = join(work, "verify");
      cpSync(tree, check, { recursive: true });
      for (const args of [["install", "--frozen-lockfile"], ["typecheck"], ["test:harness"]]) {
        console.log(`verify: pnpm ${args.join(" ")}`);
        const result = spawnSync("pnpm", args, { cwd: check, stdio: "inherit" });
        if (result.status !== 0) { console.error(`verify failed: pnpm ${args.join(" ")} exited ${result.status}`); return 1; }
      }
    }

    if (options.out) {
      const out = resolve(options.out);
      if (existsSync(out)) throw new Error(`--out ${out} already exists`);
      cpSync(tree, out, { recursive: true });
      console.log(`wrote ${out}`);
    }

    if (!options.publicDir) return 0;
    const clone = resolve(options.publicDir);
    if (!existsSync(join(clone, ".git"))) throw new Error(`${clone} is not a Git clone`);
    if (run("git", ["-C", clone, "status", "--porcelain"]).trim() !== "") throw new Error(`${clone} has uncommitted changes; commit or discard them first`);
    const plan = planSync(tree, clone);
    console.log(`sync: ${plan.add.length} added, ${plan.update.length} changed, ${plan.remove.length} removed`);
    for (const [label, paths] of [["+", plan.add], ["~", plan.update], ["-", plan.remove]]) for (const path of paths) console.log(`  ${label} ${path}`);
    if (options.dryRun) { console.log("dry run: the clone was not written"); return 0; }
    if (plan.add.length + plan.update.length + plan.remove.length === 0) { console.log("nothing to sync"); return 0; }
    applySync(tree, clone, plan);
    run("git", ["-C", clone, "add", "-A"]);
    run("git", ["-C", clone, "commit", "--quiet", "-m", `Sync from private ${localDate()}`]);
    console.log(run("git", ["-C", clone, "show", "--stat", "--format=%h %s", "HEAD"]).trimEnd());
    if (options.push) { run("git", ["-C", clone, "push"], { stdio: ["ignore", "inherit", "inherit"] }); console.log("pushed"); }
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
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
