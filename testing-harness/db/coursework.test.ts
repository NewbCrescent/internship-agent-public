import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getCoursework,
  LOCAL_CANDIDATE_ID,
  replaceCoursework,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import type { CourseworkSet } from "@internship-agent/domain";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-coursework-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  return database;
}

// Neutral fixtures: a fictional school and generic course codes.
const school = "Example State University";
const first: CourseworkSet = {
  school,
  courses: [
    { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" },
    { code: "CS 70", title: "Discrete Mathematics", term: "Fall 2025", status: "completed" },
    { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "in_progress" }
  ]
};

describe("candidate coursework storage", () => {
  it("stores, replaces, skips an identical set, and clears, bumping the AI-fit context only on a change", () => {
    const database = temporaryDatabase();
    const contextVersion = () => (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
    try {
      expect(getCoursework(database, LOCAL_CANDIDATE_ID)).toBeNull();

      const before = contextVersion();
      const saved = replaceCoursework(database, LOCAL_CANDIDATE_ID, first);
      expect(saved.changed).toBe(true);
      const stored = getCoursework(database, LOCAL_CANDIDATE_ID);
      expect(stored?.school).toBe(school);
      expect(stored?.courses).toEqual(first.courses);
      expect(contextVersion()).toBeGreaterThan(before);

      const afterSave = contextVersion();
      const same = replaceCoursework(database, LOCAL_CANDIDATE_ID, structuredClone(first));
      expect(same.changed).toBe(false);
      expect(contextVersion()).toBe(afterSave);

      const next: CourseworkSet = {
        school,
        courses: [
          { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" },
          { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "completed" },
          { code: "CS 162", title: "Operating Systems", term: "Spring 2026", status: "in_progress" }
        ]
      };
      expect(replaceCoursework(database, LOCAL_CANDIDATE_ID, next).changed).toBe(true);
      expect(getCoursework(database, LOCAL_CANDIDATE_ID)?.courses).toEqual(next.courses);
      const afterChange = contextVersion();
      expect(afterChange).toBeGreaterThan(afterSave);

      expect(replaceCoursework(database, LOCAL_CANDIDATE_ID, { school, courses: [] }).changed).toBe(true);
      expect(getCoursework(database, LOCAL_CANDIDATE_ID)).toBeNull();
      expect(contextVersion()).toBeGreaterThan(afterChange);
      const afterClear = contextVersion();
      expect(replaceCoursework(database, LOCAL_CANDIDATE_ID, { school, courses: [] }).changed).toBe(false);
      expect(contextVersion()).toBe(afterClear);
    } finally {
      database.close();
    }
  });

  it("rolls back a failed replacement, leaving the old set and the context version as they were", () => {
    const database = temporaryDatabase();
    const contextVersion = () => (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
    try {
      replaceCoursework(database, LOCAL_CANDIDATE_ID, first);
      const before = contextVersion();
      database.exec("CREATE TEMP TRIGGER fail_third BEFORE INSERT ON candidate_coursework WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
      const different: CourseworkSet = {
        school,
        courses: [
          { code: "CS 162", title: "Operating Systems", term: "Spring 2026", status: "completed" },
          { code: "CS 164", title: "Compilers", term: "Spring 2026", status: "completed" },
          { code: "CS 186", title: "Databases", term: "Fall 2026", status: "in_progress" }
        ]
      };
      expect(() => replaceCoursework(database, LOCAL_CANDIDATE_ID, different)).toThrow(/fixture failure/);
      expect(getCoursework(database, LOCAL_CANDIDATE_ID)?.courses).toEqual(first.courses);
      expect(contextVersion()).toBe(before);
    } finally {
      database.close();
    }
  });

  it("refuses an unknown candidate and never stores relevant coursework as a fact", () => {
    const database = temporaryDatabase();
    try {
      expect(() => replaceCoursework(database, "no-such-candidate", first)).toThrow();
      expect(getCoursework(database, "no-such-candidate")).toBeNull();
      expect((database.prepare("SELECT COUNT(*) AS count FROM candidate_coursework").get() as { count: number }).count).toBe(0);

      expect(() => saveCandidateFact(database, {
        candidateId: LOCAL_CANDIDATE_ID,
        key: "relevant_coursework",
        scope: { kind: "global" },
        value: "Data Structures (CS 61B)",
        source: "user",
        sourceDetail: { kind: "profile" },
        confidence: 1,
        rememberedAt: new Date().toISOString()
      })).toThrow(/never stored as a fact/);
      expect((database.prepare("SELECT COUNT(*) AS count FROM candidate_facts WHERE key = 'relevant_coursework'").get() as { count: number }).count).toBe(0);
    } finally {
      database.close();
    }
  });
});
