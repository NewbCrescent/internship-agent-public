import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearApplicationIntent,
  createDatabase,
  getApplicationIntent,
  LOCAL_CANDIDATE_ID,
  saveApplicationIntent,
  seedDevelopmentData
} from "@internship-agent/db";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-intent-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  return database;
}

describe("application intent storage", () => {
  it("stores, replaces, and clears the statement, bumping the AI-fit context only on a change", () => {
    const database = temporaryDatabase();
    const contextVersion = () => (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
    try {
      expect(getApplicationIntent(database, LOCAL_CANDIDATE_ID)).toBeNull();

      const saved = saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "  Summer 2027 software internships.  ");
      expect(saved.statement).toBe("Summer 2027 software internships.");
      expect(getApplicationIntent(database, LOCAL_CANDIDATE_ID)).toEqual(saved);

      const afterSave = contextVersion();
      expect(saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "Summer 2027 software internships.")).toEqual(saved);
      expect(contextVersion()).toBe(afterSave);

      saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "Summer 2027 ML or data engineering internships.");
      expect(contextVersion()).toBe(afterSave + 1);
      expect(getApplicationIntent(database, LOCAL_CANDIDATE_ID)?.statement).toBe("Summer 2027 ML or data engineering internships.");

      expect(clearApplicationIntent(database, LOCAL_CANDIDATE_ID)).toBe(true);
      expect(contextVersion()).toBe(afterSave + 2);
      expect(getApplicationIntent(database, LOCAL_CANDIDATE_ID)).toBeNull();
      expect(clearApplicationIntent(database, LOCAL_CANDIDATE_ID)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("refuses an unknown candidate and an over-long statement", () => {
    const database = temporaryDatabase();
    try {
      expect(() => saveApplicationIntent(database, "no-such-candidate", "Summer internships.")).toThrow();
      expect(() => saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "x".repeat(2001))).toThrow();
      expect(getApplicationIntent(database, LOCAL_CANDIDATE_ID)).toBeNull();
    } finally {
      database.close();
    }
  });
});
