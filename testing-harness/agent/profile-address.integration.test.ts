import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getCandidate, LOCAL_CANDIDATE_ID, seedDevelopmentData, setCandidateHighSchoolDetails } from "@internship-agent/db";

import { ADDRESS_FIELDS, runProfileAddress } from "../../packages/agent/src/profile-address";

/**
 * `pnpm profile:address` against a disposable workspace. Every address here
 * is fictional (an example street in an example town), never a real one.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(options: { seed?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-profile-address-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  if (options.seed !== false) seedDevelopmentData(database);
  const files = new Map<string, string>();
  const output: string[] = [];
  let opens = 0;
  let closes = 0;
  let acquired = 0;
  let released = 0;
  let lockError: string | null = null;
  const run = (argv: string[]) => runProfileAddress(argv, {
    open: () => { opens += 1; return database; },
    close: () => { closes += 1; },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("missing");
      return text;
    },
    log: (line) => { output.push(line); },
    lock: () => {
      if (lockError) throw new Error(lockError);
      acquired += 1;
      return () => { released += 1; };
    }
  });
  return {
    database,
    files,
    output,
    run,
    counts: () => ({ opens, closes, acquired, released }),
    failLock: (message: string) => { lockError = message; }
  };
}

const contextVersion = (database: DatabaseSync) =>
  (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;

const ADDRESS = {
  addressLine1: "100 Example Street",
  addressLine2: "Unit 7",
  addressCity: "Exampletown",
  addressRegion: "Example Region",
  addressPostalCode: "00000",
  addressCountry: "Exampleland"
};
const VALUES = Object.values(ADDRESS);

function noValuesIn(output: string[]) {
  const text = output.join("\n");
  for (const value of VALUES) expect(text).not.toContain(value);
}

describe("pnpm profile:address", () => {
  it("saves the address under the pipeline lock, keeps every other profile field, and prints only field names", async () => {
    const { database, files, output, run, counts } = workspace();
    setCandidateHighSchoolDetails(database, LOCAL_CANDIDATE_ID, { city: "Old Example City" }, "fixture");
    const before = getCandidate(database, LOCAL_CANDIDATE_ID)!;
    const version = contextVersion(database);
    files.set("address.json", JSON.stringify(ADDRESS));
    expect(await run(["--profile", "demo", "--set-file", "address.json"])).toBe(0);
    expect(output).toEqual([...ADDRESS_FIELDS.map((field) => `set ${field} [profile]`), "changed 6 address fields"]);
    noValuesIn(output);
    const after = getCandidate(database, LOCAL_CANDIDATE_ID)!;
    expect(after).toMatchObject(ADDRESS);
    const { updatedAt: _beforeUpdated, ...restBefore } = before;
    const { updatedAt: _afterUpdated, ...restAfter } = after;
    expect(restAfter).toEqual({ ...restBefore, ...ADDRESS });
    expect(after.highSchoolCity).toBe("Old Example City");
    expect(contextVersion(database)).toBeGreaterThan(version);
    expect(counts()).toEqual({ opens: 1, closes: 1, acquired: 1, released: 1 });
    database.close();
  });

  it("changes only the fields the file names, clears a field given as an empty string, and skips an unchanged file without the lock", async () => {
    const { database, files, output, run, counts } = workspace();
    files.set("address.json", JSON.stringify(ADDRESS));
    expect(await run(["--profile", "demo", "--set-file", "address.json"])).toBe(0);

    output.length = 0;
    const version = contextVersion(database);
    expect(await run(["--profile", "demo", "--set-file", "address.json"])).toBe(0);
    expect(output).toEqual([...ADDRESS_FIELDS.map((field) => `unchanged ${field} [profile]`), "nothing to change"]);
    expect(contextVersion(database)).toBe(version);
    expect(counts().acquired).toBe(1);

    files.set("partial.json", JSON.stringify({ addressLine2: "  ", addressCity: "Othertown" }));
    output.length = 0;
    expect(await run(["--profile", "demo", "--set-file", "partial.json"])).toBe(0);
    expect(output).toEqual(["cleared addressLine2 [profile]", "set addressCity [profile]", "changed 2 address fields"]);
    expect(output.join("\n")).not.toContain("Othertown");
    const after = getCandidate(database, LOCAL_CANDIDATE_ID)!;
    expect(after.addressLine2).toBeUndefined();
    expect(after.addressCity).toBe("Othertown");
    expect(after.addressLine1).toBe(ADDRESS.addressLine1);
    expect(after.addressCountry).toBe(ADDRESS.addressCountry);
    expect(counts().acquired).toBe(2);
    expect(counts().released).toBe(2);
    database.close();
  });

  it("writes nothing and takes no lock on a dry run", async () => {
    const { database, files, output, run, counts } = workspace();
    const version = contextVersion(database);
    files.set("address.json", JSON.stringify({ addressLine1: ADDRESS.addressLine1, addressPostalCode: ADDRESS.addressPostalCode }));
    expect(await run(["--profile", "demo", "--set-file", "address.json", "--dry-run"])).toBe(0);
    expect(output).toEqual(["would set addressLine1 [profile]", "would set addressPostalCode [profile]", "would change 2 address fields"]);
    noValuesIn(output);
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)?.addressLine1).toBeUndefined();
    expect(contextVersion(database)).toBe(version);
    expect(counts().acquired).toBe(0);
    database.close();
  });

  it("validates the file before opening the database and never echoes a value", async () => {
    const { database, files, output, run, counts } = workspace();
    const cases: Array<[string, string, string]> = [
      ["unknown.json", JSON.stringify({ ...ADDRESS, street: ADDRESS.addressLine1 }), "Unknown key in the address file: street."],
      ["long.json", JSON.stringify({ addressPostalCode: `${ADDRESS.addressPostalCode}${"9".repeat(30)}` }), "Invalid address file at addressPostalCode."],
      ["number.json", JSON.stringify({ addressLine1: 100 }), "Invalid address file at addressLine1."],
      ["array.json", JSON.stringify([ADDRESS]), "Invalid address file at (root)."],
      ["empty.json", JSON.stringify({}), "The address file names no address field."],
      ["broken.json", "{", "The address file is not valid JSON."],
      ["absent.json", "", "The address file could not be read."]
    ];
    for (const [name, text, message] of cases) {
      if (name !== "absent.json") files.set(name, text);
      output.length = 0;
      expect(await run(["--profile", "demo", "--set-file", name])).toBe(1);
      expect(output.some((line) => line.startsWith(message)), `${name}: ${output.join(" | ")}`).toBe(true);
      noValuesIn(output);
      expect(output.join("\n")).not.toContain("9".repeat(30));
    }
    expect(counts()).toEqual({ opens: 0, closes: 0, acquired: 0, released: 0 });
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)?.addressLine1).toBeUndefined();
    database.close();
  });

  it("writes nothing when the pipeline lock is held or the workspace has no profile", async () => {
    const held = workspace();
    held.files.set("address.json", JSON.stringify(ADDRESS));
    held.failLock("A pipeline pass is running (pid 1).");
    const version = contextVersion(held.database);
    expect(await held.run(["--profile", "demo", "--set-file", "address.json"])).toBe(1);
    expect(held.output).toEqual(["Not saved: A pipeline pass is running (pid 1)."]);
    expect(getCandidate(held.database, LOCAL_CANDIDATE_ID)?.addressLine1).toBeUndefined();
    expect(contextVersion(held.database)).toBe(version);
    expect(held.counts().closes).toBe(1);
    held.database.close();

    const empty = workspace({ seed: false });
    empty.files.set("address.json", JSON.stringify(ADDRESS));
    expect(await empty.run(["--profile", "demo", "--set-file", "address.json"])).toBe(1);
    expect(empty.output).toEqual(["Save the candidate profile first; nothing was written."]);
    expect(getCandidate(empty.database, LOCAL_CANDIDATE_ID)).toBeNull();
    expect(empty.counts().acquired).toBe(0);
    empty.database.close();
  });

  it("lists which fields are set, never their values", async () => {
    const { database, files, output, run } = workspace();
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output).toEqual(ADDRESS_FIELDS.map((field) => `${field} [profile]: not set`));
    files.set("address.json", JSON.stringify({ addressCity: ADDRESS.addressCity }));
    expect(await run(["--profile", "demo", "--set-file", "address.json"])).toBe(0);
    output.length = 0;
    expect(await run(["--profile", "demo", "--list"])).toBe(0);
    expect(output).toEqual(ADDRESS_FIELDS.map((field) => `${field} [profile]: ${field === "addressCity" ? "set" : "not set"}`));
    noValuesIn(output);
    database.close();
  });

  it("refuses bad arguments with the usage line", async () => {
    const { database, output, run, counts } = workspace();
    const usage = "Usage: pnpm profile:address --profile real|demo [--list | --set-file <address.json> [--dry-run]]";
    for (const argv of [
      [],
      ["--profile", "staging"],
      ["--profile", "demo", "--dry-run"],
      ["--profile", "demo", "--list", "--set-file", "address.json"],
      ["--profile", "demo", "--set-file"],
      ["--profile", "demo", "--line1", "x"]
    ]) {
      output.length = 0;
      expect(await run(argv)).toBe(2);
      expect(output).toEqual([usage]);
    }
    expect(counts().opens).toBe(0);
    database.close();
  });
});
