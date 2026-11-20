import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getCurrentFact,
  getCurrentFacts,
  LOCAL_CANDIDATE_ID,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";

import { runProfileFacts } from "../../packages/agent/src/profile-facts";

/**
 * `pnpm profile:facts` against a disposable workspace. The protected values
 * here are neutral fixtures, never anyone's real answers.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-profile-facts-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  const files = new Map<string, string>();
  const output: string[] = [];
  let closes = 0;
  const run = (argv: string[]) => runProfileFacts(argv, {
    open: () => database,
    close: () => { closes += 1; },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("missing");
      return text;
    },
    log: (line) => { output.push(line); }
  });
  return { database, files, output, run, closes: () => closes };
}

const factCount = (database: DatabaseSync) =>
  (database.prepare("SELECT COUNT(*) AS count FROM candidate_facts").get() as { count: number }).count;

const PROTECTED_FIXTURES = ["female", "asian", "protected_veteran", "has_disability"];
const FULL_FILE = {
  facts: [
    { key: "how_heard", value: "Company website" },
    { key: "previously_worked_here", value: false },
    { key: "previously_worked_here", scope: { kind: "company", name: "Vandelay" }, value: true, note: "Interned there before." },
    { key: "age_18_or_older", value: true },
    { key: "pronouns", value: "they/them" },
    { key: "relatives_at_company", value: false },
    { key: "available_end_date", value: "2030-08-15" },
    { key: "work_arrangement", value: true },
    { key: "willing_to_relocate", scope: { kind: "country", code: "US" }, value: true },
    { key: "eeo_gender", value: "female" },
    { key: "eeo_race_ethnicity", value: "asian" },
    { key: "eeo_veteran_status", value: "protected_veteran" },
    { key: "eeo_disability_status", value: "has_disability" }
  ]
};

describe("pnpm profile:facts", () => {
  it("writes every fact with user provenance, supersedes the global relocation answer, and never prints protected values", async () => {
    const { database, files, output, run, closes } = workspace();
    const legacy = saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key: "willing_to_relocate",
      scope: { kind: "global" },
      value: true,
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Relocate?" },
      confidence: 1,
      rememberedAt: "2026-01-01T00:00:00.000Z"
    });
    files.set("facts.json", JSON.stringify(FULL_FILE));

    expect(await run(["--profile", "demo", "--set-file", "facts.json"])).toBe(0);
    expect(closes()).toBe(1);
    const country = getCurrentFact(database, LOCAL_CANDIDATE_ID, "willing_to_relocate", { kind: "country", code: "US" })!;
    expect(getCurrentFact(database, LOCAL_CANDIDATE_ID, "willing_to_relocate", { kind: "global" })).toBeNull();
    expect(database.prepare("SELECT superseded_by_id FROM candidate_facts WHERE id = ?").get(legacy.id)).toEqual({ superseded_by_id: country.id });
    expect(output).toContain("superseded willing_to_relocate [global] by [country:US]");
    expect(output).toContain("set previously_worked_here [company:vandelay]: Yes");
    expect(output).toContain("set how_heard [global]: Company website");
    for (const key of ["eeo_gender", "eeo_race_ethnicity", "eeo_veteran_status", "eeo_disability_status"]) {
      expect(output).toContain(`set ${key} [global]: set`);
    }
    const printed = output.join("\n").toLowerCase();
    for (const value of PROTECTED_FIXTURES) expect(printed).not.toContain(value);

    const facts = getCurrentFacts(database, LOCAL_CANDIDATE_ID);
    expect(facts).toHaveLength(FULL_FILE.facts.length);
    for (const fact of facts) {
      expect(fact.source).toBe("user");
      expect(fact.sourceDetail.kind).toBe("profile");
    }
    expect(facts.find((fact) => fact.key === "previously_worked_here" && fact.scope.kind === "company")?.sourceDetail.question).toBe("Interned there before.");

    output.length = 0;
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output).toContain("eeo_gender [global]: set");
    for (const value of PROTECTED_FIXTURES) expect(output.join("\n").toLowerCase()).not.toContain(value);

    output.length = 0;
    const before = factCount(database);
    expect(await run(["--profile", "demo", "--set-file", "facts.json"])).toBe(0);
    expect(output.filter((line) => line.startsWith("unchanged "))).toHaveLength(FULL_FILE.facts.length);
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("writes nothing on a dry run", async () => {
    const { database, files, output, run } = workspace();
    files.set("facts.json", JSON.stringify(FULL_FILE));
    const before = factCount(database);
    expect(await run(["--profile", "demo", "--set-file", "facts.json", "--dry-run"])).toBe(0);
    expect(factCount(database)).toBe(before);
    expect(output.every((line) => line.startsWith("would "))).toBe(true);
    database.close();
  });

  it("validates the whole file first and never echoes a rejected protected value", async () => {
    const { database, files, output, run } = workspace();
    const before = factCount(database);
    files.set("bad-protected.json", JSON.stringify({ facts: [{ key: "how_heard", value: "Company website" }, { key: "eeo_gender", value: "x-invalid-x" }] }));
    expect(await run(["--profile", "demo", "--set-file", "bad-protected.json"])).toBe(1);
    expect(factCount(database)).toBe(before);
    expect(output.join("\n")).not.toContain("x-invalid-x");
    expect(output).toContain("invalid: eeo_gender [global]: value or scope not allowed");

    files.set("global-yes.json", JSON.stringify({ facts: [{ key: "previously_worked_here", value: true }] }));
    expect(await run(["--profile", "demo", "--set-file", "global-yes.json"])).toBe(1);
    files.set("unknown-key.json", JSON.stringify({ facts: [{ key: "favorite_color", value: "x-secret-x" }] }));
    expect(await run(["--profile", "demo", "--set-file", "unknown-key.json"])).toBe(1);
    files.set("not-json.json", "{ facts: x-secret-x");
    expect(await run(["--profile", "demo", "--set-file", "not-json.json"])).toBe(1);
    expect(output.join("\n")).not.toContain("x-secret-x");
    expect(factCount(database)).toBe(before);

    expect(await run(["--set-file", "global-yes.json"])).toBe(2);
    expect(await run(["--profile", "staging"])).toBe(2);
    expect(output.at(-1)).toMatch(/^Usage: pnpm profile:facts --profile real\|demo/);
    database.close();
  });

  it("revokes a saved answer", async () => {
    const { database, files, output, run } = workspace();
    files.set("set.json", JSON.stringify({ facts: [{ key: "eeo_gender", value: "female" }] }));
    expect(await run(["--profile", "demo", "--set-file", "set.json"])).toBe(0);
    files.set("revoke.json", JSON.stringify({ revoke: [{ key: "eeo_gender" }, { key: "pronouns" }] }));
    expect(await run(["--profile", "demo", "--set-file", "revoke.json"])).toBe(0);
    expect(output).toContain("revoked eeo_gender [global]");
    expect(output).toContain("not found pronouns [global]");
    expect(getCurrentFact(database, LOCAL_CANDIDATE_ID, "eeo_gender", { kind: "global" })).toBeNull();
    database.close();
  });

  it("refuses relevant coursework, which is saved only with pnpm profile:coursework", async () => {
    const { database, files, output, run } = workspace();
    const before = factCount(database);
    files.set("coursework.json", JSON.stringify({ facts: [{ key: "relevant_coursework", value: "x" }] }));
    expect(await run(["--profile", "demo", "--set-file", "coursework.json"])).toBe(1);
    expect(output.some((line) => line.startsWith("Invalid fact file at facts.0.key"))).toBe(true);
    files.set("revoke.json", JSON.stringify({ revoke: [{ key: "relevant_coursework" }] }));
    expect(await run(["--profile", "demo", "--set-file", "revoke.json"])).toBe(1);
    expect(factCount(database)).toBe(before);
    database.close();
  });
});
