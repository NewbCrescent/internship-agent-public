import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  createResumeEntry,
  LOCAL_CANDIDATE_ID,
  listProjectEvidenceProfiles,
  reconcileProjectEvidence,
  registerGitHubRepository,
  replaceCoursework,
  reviewEvidenceClaim,
  revokeCandidateFact,
  saveApplicationIntent,
  saveCandidateFact,
  seedDevelopmentData,
  type SaveCandidateFactInput
} from "@internship-agent/db";
import { candidateFactKeySchema, FIT_CONTEXT_FACT_KEYS } from "@internship-agent/domain";

const temporaryDirectories: string[] = [];
const migrationDirectory = join(import.meta.dirname, "..", "..", "packages", "db", "migrations");
const fitKeys: readonly string[] = FIT_CONTEXT_FACT_KEYS;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-fit-facts-"));
  temporaryDirectories.push(directory);
  return join(directory, "test.sqlite");
}

function seededDatabase(): DatabaseSync {
  const database = createDatabase(temporaryPath());
  seedDevelopmentData(database);
  return database;
}

function contextVersion(database: DatabaseSync): number {
  return (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
}

/** A database as it stood before 0034: every earlier migration applied the way runMigrations does. */
function databaseBefore0034(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql") && name < "0034").sort()) {
    database.exec("BEGIN IMMEDIATE;");
    database.exec(readFileSync(join(migrationDirectory, file), "utf8"));
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(file, "2026-11-01T00:00:00.000Z");
    database.exec("COMMIT;");
  }
  database.prepare("INSERT INTO candidates (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(LOCAL_CANDIDATE_ID, "Fixture Candidate", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare("UPDATE semantic_fit_context SET version = 64 WHERE id = 1").run();
  database.close();
}

function triggerNames(database: DatabaseSync): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'candidate_facts' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function fact(key: SaveCandidateFactInput["key"], scope: SaveCandidateFactInput["scope"], value: SaveCandidateFactInput["value"]): SaveCandidateFactInput {
  return {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "profile" },
    confidence: 1,
    rememberedAt: "2026-11-25T00:00:00.000Z"
  };
}

describe("migration 0034: only fit-relevant candidate facts bump the AI-fit context", () => {
  it("migration 0034 keeps the context version and the trigger names", () => {
    const path = temporaryPath();
    databaseBefore0034(path);
    const database = createDatabase(path);
    try {
      const versions = (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((row) => row.version);
      expect(versions).toContain("0034_fit_context_fact_keys.sql");
      expect(contextVersion(database)).toBe(64);
      expect(triggerNames(database)).toEqual([
        "semantic_fit_candidate_facts_delete",
        "semantic_fit_candidate_facts_insert",
        "semantic_fit_candidate_facts_update"
      ]);
    } finally {
      database.close();
    }
  });

  it("the candidate_facts triggers list exactly FIT_CONTEXT_FACT_KEYS", () => {
    const database = createDatabase(temporaryPath());
    try {
      const triggers = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'candidate_facts' ORDER BY name").all() as Array<{ name: string; sql: string }>;
      expect(triggers).toHaveLength(3);
      const expected = [...FIT_CONTEXT_FACT_KEYS].sort();
      for (const trigger of triggers) {
        expect(trigger.sql, trigger.name).toMatch(/\bWHEN\b/);
        const lists = [...trigger.sql.matchAll(/\bIN\s*\(([^)]*)\)/g)];
        expect(lists.length, trigger.name).toBeGreaterThan(0);
        for (const list of lists) {
          const keys = [...list[1]!.matchAll(/'([^']*)'/g)].map((match) => match[1]!).sort();
          expect(keys, trigger.name).toEqual(expected);
        }
      }
    } finally {
      database.close();
    }
  });

  it("saving application-only facts leaves the AI-fit context version unchanged", () => {
    const database = seededDatabase();
    try {
      const before = contextVersion(database);
      saveCandidateFact(database, fact("willing_background_check", { kind: "global" }, true));
      expect(contextVersion(database)).toBe(before);
      saveCandidateFact(database, fact("eeo_gender", { kind: "global" }, "non_binary"));
      expect(contextVersion(database)).toBe(before);
      saveCandidateFact(database, fact("eeo_sexual_orientation", { kind: "global" }, "queer"));
      expect(contextVersion(database)).toBe(before);
      const authorized = saveCandidateFact(database, fact("authorized_to_work", { kind: "country", code: "US" }, true));
      expect(contextVersion(database)).toBe(before);
      saveCandidateFact(database, fact("how_heard", { kind: "global" }, "Company website"));
      expect(contextVersion(database)).toBe(before);
      saveCandidateFact(database, fact("how_heard", { kind: "global" }, "Career fair"));
      expect(contextVersion(database)).toBe(before);
      expect(revokeCandidateFact(database, LOCAL_CANDIDATE_ID, authorized.id)).toBe(true);
      expect(contextVersion(database)).toBe(before);
    } finally {
      database.close();
    }
  });

  it("only fit-relevant keys bump on raw insert, update, and delete", () => {
    const database = seededDatabase();
    try {
      const insert = database.prepare(`
        INSERT INTO candidate_facts (id, candidate_id, key, scope_json, scope_key, value_json, value_type, source,
          source_detail_json, confidence, sensitivity, reuse_policy, remembered_at, created_at)
        VALUES (?, ?, ?, '{"kind":"global"}', ?, '"fixture"', 'text', 'user', '{"kind":"profile"}', 1, 'standard', 'auto', NULL, '2026-11-25T00:00:00.000Z')
      `);
      const update = database.prepare("UPDATE candidate_facts SET confidence = 0.5 WHERE id = ?");
      const remove = database.prepare("DELETE FROM candidate_facts WHERE id = ?");
      for (const key of candidateFactKeySchema.options) {
        const id = `raw-${key}`;
        const bumps = fitKeys.includes(key);
        const steps = [
          () => insert.run(id, LOCAL_CANDIDATE_ID, key, `raw-scope-${key}`),
          () => update.run(id),
          () => remove.run(id)
        ];
        for (const [index, step] of steps.entries()) {
          const before = contextVersion(database);
          const result = step();
          expect(Number(result.changes), `${key} step ${index}`).toBe(1);
          if (bumps) expect(contextVersion(database), `${key} step ${index}`).toBeGreaterThan(before);
          else expect(contextVersion(database), `${key} step ${index}`).toBe(before);
        }
      }
    } finally {
      database.close();
    }
  });

  it("a graduation_date change still marks fits stale", () => {
    const database = seededDatabase();
    try {
      const before = contextVersion(database);
      const graduation = saveCandidateFact(database, fact("graduation_date", { kind: "global" }, "2029-05-15"));
      const afterSave = contextVersion(database);
      expect(afterSave).toBeGreaterThan(before);
      expect(revokeCandidateFact(database, LOCAL_CANDIDATE_ID, graduation.id)).toBe(true);
      expect(contextVersion(database)).toBeGreaterThan(afterSave);
    } finally {
      database.close();
    }
  });

  it("other fit inputs still bump the context version", () => {
    const database = seededDatabase();
    try {
      const expectBump = (label: string, change: () => void) => {
        const before = contextVersion(database);
        change();
        expect(contextVersion(database), label).toBeGreaterThan(before);
      };
      expectBump("candidate profile", () => {
        database.prepare("UPDATE candidates SET field_of_study = 'Fixture field' WHERE id = ?").run(LOCAL_CANDIDATE_ID);
      });
      expectBump("resume entry", () => {
        createResumeEntry(database, {
          candidateId: LOCAL_CANDIDATE_ID,
          section: "project",
          content: {
            title: "Fixture Telemetry Dashboard",
            role: null,
            linkLabel: null,
            linkUrl: null,
            location: null,
            dateText: "2026",
            bullets: ["Built a fictional telemetry dashboard for fixture data."]
          },
          source: { kind: "user" },
          reviewStatus: "APPROVED"
        });
      });
      expectBump("project evidence", () => {
        const repository = registerGitHubRepository(database, {
          candidateId: LOCAL_CANDIDATE_ID, owner: "example", name: "evidence-demo", url: "https://github.com/example/evidence-demo",
          defaultBranch: "main", description: "Fixture evidence.", observedHeadSha: "sha-fixture"
        });
        reconcileProjectEvidence(database, {
          candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id, name: "evidence-demo", summary: "Fixture project.",
          fullSnapshot: true, affectedPaths: ["README.md"],
          claims: [{
            kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.", evidenceFingerprint: "tech-v1",
            evidence: [{
              kind: "readme", commitSha: "sha-fixture", path: "README.md", startLine: 2, endLine: 2,
              sourceUrl: "https://github.com/example/evidence-demo/blob/sha-fixture/README.md#L2",
              excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1"
            }]
          }]
        });
      });
      expectBump("claim review", () => {
        const claim = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0]!.claims[0]!;
        expect(reviewEvidenceClaim(database, { claimId: claim.id, decision: "ALLOWED" })).toBe(true);
      });
      expectBump("coursework", () => {
        replaceCoursework(database, LOCAL_CANDIDATE_ID, {
          school: "Example State University",
          courses: [{ code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" }]
        });
      });
      expectBump("application intent", () => {
        saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "Fictional fixture intent: backend software internships.");
      });
    } finally {
      database.close();
    }
  });
});
