import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getCurrentFact,
  LOCAL_CANDIDATE_ID,
  saveCandidateFact,
  supersedeCandidateFact
} from "@internship-agent/db";

const temporaryDirectories: string[] = [];
const migrationDirectory = join(import.meta.dirname, "..", "..", "packages", "db", "migrations");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A database as it stood before 0030: every earlier migration applied the way runMigrations does. */
function databaseBefore0030(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql") && name < "0030").sort()) {
    database.exec("BEGIN IMMEDIATE;");
    database.exec(readFileSync(join(migrationDirectory, file), "utf8"));
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(file, "2026-11-01T00:00:00.000Z");
    database.exec("COMMIT;");
  }
  database.prepare("INSERT INTO candidates (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(LOCAL_CANDIDATE_ID, "Fixture Candidate", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const insert = database.prepare(`
    INSERT INTO candidate_facts (id, candidate_id, key, scope_json, scope_key, value_json, value_type, source,
      source_detail_json, confidence, sensitivity, reuse_policy, remembered_at, created_at, superseded_at, superseded_by_id, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, 1, 'standard', 'auto', ?, ?, ?, ?, ?)
  `);
  const detail = JSON.stringify({ kind: "remembered_answer", question: "Relocate?" });
  insert.run("fact-new", LOCAL_CANDIDATE_ID, "willing_to_relocate", '{"kind":"global"}', "global", "true", "boolean", detail,
    "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", null, null, null);
  insert.run("fact-old", LOCAL_CANDIDATE_ID, "willing_to_relocate", '{"kind":"global"}', "global", "false", "boolean", detail,
    "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "fact-new", null);
  insert.run("fact-revoked", LOCAL_CANDIDATE_ID, "available_start_date", '{"kind":"global"}', "global", '"2030-01-15"', "date", detail,
    "2026-01-15T00:00:00.000Z", "2026-01-15T00:00:00.000Z", null, null, "2026-01-20T00:00:00.000Z");
  database.close();
}

describe("migration 0030: candidate facts gain a text value type", () => {
  it("rebuilds candidate_facts keeping rows, the self-reference, indexes, and AI-fit triggers", () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-0030-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "test.sqlite");
    databaseBefore0030(path);

    const appliedBefore = new DatabaseSync(path);
    const versionsBefore = (appliedBefore.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((row) => row.version);
    appliedBefore.close();
    expect(versionsBefore).toContain("0028_application_intent.sql");
    expect(versionsBefore).toContain("0029_browser_run_profile.sql");
    expect(versionsBefore).not.toContain("0030_candidate_fact_text.sql");

    const database = createDatabase(path);
    try {
      const versionsAfter = (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((row) => row.version);
      expect(versionsAfter).toContain("0030_candidate_fact_text.sql");
      expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'candidate_application_intent'").get()).toEqual({ count: 1 });
      const rows = database.prepare("SELECT id, key, value_json, value_type, superseded_at, superseded_by_id, revoked_at FROM candidate_facts ORDER BY id").all();
      expect(rows).toEqual([
        { id: "fact-new", key: "willing_to_relocate", value_json: "true", value_type: "boolean", superseded_at: null, superseded_by_id: null, revoked_at: null },
        { id: "fact-old", key: "willing_to_relocate", value_json: "false", value_type: "boolean", superseded_at: "2026-02-01T00:00:00.000Z", superseded_by_id: "fact-new", revoked_at: null },
        { id: "fact-revoked", key: "available_start_date", value_json: '"2030-01-15"', value_type: "date", superseded_at: null, superseded_by_id: null, revoked_at: "2026-01-20T00:00:00.000Z" }
      ]);
      const columns = (database.prepare("PRAGMA table_info(candidate_facts)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual([
        "id", "candidate_id", "key", "scope_json", "scope_key", "value_json", "value_type", "source", "source_detail_json",
        "confidence", "sensitivity", "reuse_policy", "remembered_at", "created_at", "superseded_at", "superseded_by_id", "revoked_at"
      ]);

      const foreignKeys = database.prepare("PRAGMA foreign_key_list(candidate_facts)").all() as Array<{ table: string; from: string }>;
      expect(foreignKeys.map((key) => `${key.from}->${key.table}`).sort()).toEqual(["candidate_id->candidates", "superseded_by_id->candidate_facts"]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'candidate_facts_next'").get()).toEqual({ count: 0 });

      const schema = (database.prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'candidate_facts' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string }>)
        .map((entry) => `${entry.type}:${entry.name}`);
      expect(schema).toEqual([
        "index:candidate_facts_candidate_created",
        "index:candidate_facts_current_identity",
        "trigger:semantic_fit_candidate_facts_delete",
        "trigger:semantic_fit_candidate_facts_insert",
        "trigger:semantic_fit_candidate_facts_update"
      ]);

      const raw = database.prepare(`
        INSERT INTO candidate_facts (id, candidate_id, key, scope_json, scope_key, value_json, value_type, source,
          source_detail_json, confidence, sensitivity, reuse_policy, remembered_at, created_at)
        VALUES (?, ?, 'how_heard', '{"kind":"global"}', ?, '"Company website"', ?, 'user', '{"kind":"profile"}', 1, 'standard', 'auto', NULL, '2026-11-19T00:00:00.000Z')
      `);
      expect(() => raw.run("raw-text", LOCAL_CANDIDATE_ID, "raw-text-scope", "text")).not.toThrow();
      expect(() => raw.run("raw-bogus", LOCAL_CANDIDATE_ID, "raw-bogus-scope", "bogus")).toThrow();
      database.prepare("DELETE FROM candidate_facts WHERE id = 'raw-text'").run();

      const version = () => (database.prepare("SELECT version FROM semantic_fit_context WHERE id = 1").get() as { version: number }).version;
      const before = version();
      const heard = saveCandidateFact(database, {
        candidateId: LOCAL_CANDIDATE_ID,
        key: "how_heard",
        scope: { kind: "global" },
        value: "Company website",
        source: "user",
        sourceDetail: { kind: "profile" },
        confidence: 1,
        rememberedAt: "2026-11-19T00:00:00.000Z"
      });
      expect(heard.valueType).toBe("text");
      // Migration 0034: facts the AI fit does not read leave the fit context unchanged.
      expect(version()).toBe(before);

      const country = saveCandidateFact(database, {
        candidateId: LOCAL_CANDIDATE_ID,
        key: "willing_to_relocate",
        scope: { kind: "country", code: "US" },
        value: true,
        source: "user",
        sourceDetail: { kind: "profile" },
        confidence: 1,
        rememberedAt: "2026-11-19T00:00:00.000Z"
      });
      expect(supersedeCandidateFact(database, LOCAL_CANDIDATE_ID, "fact-new", country.id)).toBe(true);
      expect(supersedeCandidateFact(database, LOCAL_CANDIDATE_ID, "fact-new", country.id)).toBe(false);
      expect(getCurrentFact(database, LOCAL_CANDIDATE_ID, "willing_to_relocate", { kind: "global" })).toBeNull();
      expect(database.prepare("SELECT superseded_by_id FROM candidate_facts WHERE id = 'fact-new'").get()).toEqual({ superseded_by_id: country.id });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
