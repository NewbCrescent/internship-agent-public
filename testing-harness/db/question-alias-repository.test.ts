import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  findQuestionAliasIds,
  findQuestionAliases,
  listQuestionAliases,
  LOCAL_CANDIDATE_ID,
  questionAliasStoreAvailable,
  recordQuestionAlias,
  revokeQuestionAlias,
  seedDevelopmentData
} from "@internship-agent/db";

/**
 * Recorded question wordings (migration 0036) against disposable SQLite:
 * recording and re-seeing a wording, exact-then-normalized lookup, the target
 * CHECK, revocation, and a database without the table reading as empty.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seededDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-aliases-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  return database;
}

const question = { kind: "question" as const, questionKey: "do you use python" };

describe("candidate_question_aliases", () => {
  it("is created by migration 0036", () => {
    const database = seededDatabase();
    expect(database.prepare("SELECT version FROM schema_migrations WHERE version = '0036_question_aliases.sql'").get()).toBeTruthy();
    expect(questionAliasStoreAvailable(database)).toBe(true);
    database.close();
  });

  it("records a wording, then bumps it when seen again", () => {
    const database = seededDatabase();
    const first = recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python?", target: question, atsKind: "greenhouse",
      fieldKind: "select", options: ["Yes", "No"], source: "candidate_answer", sourceRunId: null
    });
    expect(first.status).toBe("recorded");
    expect(first.alias).toMatchObject({ wording: "Do you use Python?", wordingKey: "do you use python", seenCount: 1, options: ["Yes", "No"], fieldKind: "select" });
    const again = recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python?", target: question, atsKind: "greenhouse",
      fieldKind: "select", options: ["Yes", "No", "Somewhat"], source: "saved_answer_match", sourceRunId: null
    });
    expect(again.status).toBe("seen");
    expect(again.alias).toMatchObject({ id: first.alias.id, seenCount: 2, options: ["Yes", "No", "Somewhat"], source: "candidate_answer" });
    // Another ATS kind is its own record.
    expect(recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python?", target: question, atsKind: "lever", source: "candidate_answer", sourceRunId: null
    }).status).toBe("recorded");
    expect(listQuestionAliases(database, LOCAL_CANDIDATE_ID)).toHaveLength(2);
    expect(() => recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: " * ", target: question, atsKind: "lever", source: "candidate_answer", sourceRunId: null
    })).toThrow(/no words/);
    database.close();
  });

  it("finds the exact wording first, then the same normalized wording", () => {
    const database = seededDatabase();
    const normalized = recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "DO YOU USE PYTHON", target: question, atsKind: "lever", source: "candidate_answer", sourceRunId: null
    });
    const exact = recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python? *", target: { kind: "fact", factKey: "how_heard", scopeKey: "global" },
      atsKind: "lever", source: "saved_answer_match", sourceRunId: null
    });
    const found = findQuestionAliases(database, LOCAL_CANDIDATE_ID, "Do you use Python? *");
    expect(found.map((alias) => [alias.id, alias.matchedBy])).toEqual([[exact.alias.id, "exact"], [normalized.alias.id, "normalized"]]);
    expect(found[0]?.target).toEqual({ kind: "fact", factKey: "how_heard", scopeKey: "global" });
    expect(findQuestionAliases(database, LOCAL_CANDIDATE_ID, "Do you use Java?")).toEqual([]);
    database.close();
  });

  it("rejects a fact target that also names a question", () => {
    const database = seededDatabase();
    expect(() => database.prepare(`
      INSERT INTO candidate_question_aliases (id, candidate_id, wording, wording_key, target_kind, fact_key, fact_scope_key, question_key, ats_kind, source, created_at, last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000001', ?, 'Q?', 'q', 'fact', 'how_heard', 'global', 'q', 'lever', 'candidate_answer', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')
    `).run(LOCAL_CANDIDATE_ID)).toThrow();
    expect(() => database.prepare(`
      INSERT INTO candidate_question_aliases (id, candidate_id, wording, wording_key, target_kind, fact_key, fact_scope_key, question_key, ats_kind, source, created_at, last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000002', ?, 'Q?', 'q', 'question', NULL, NULL, NULL, 'lever', 'candidate_answer', '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z')
    `).run(LOCAL_CANDIDATE_ID)).toThrow();
    database.close();
  });

  it("revokes one alias by id or prefix", () => {
    const database = seededDatabase();
    const { alias } = recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python?", target: question, atsKind: "lever", source: "candidate_answer", sourceRunId: null
    });
    expect(findQuestionAliasIds(database, LOCAL_CANDIDATE_ID, alias.id.slice(0, 8))).toEqual([alias.id]);
    expect(findQuestionAliasIds(database, LOCAL_CANDIDATE_ID, "xyz")).toEqual([]);
    expect(revokeQuestionAlias(database, LOCAL_CANDIDATE_ID, alias.id)).toBe(true);
    expect(revokeQuestionAlias(database, LOCAL_CANDIDATE_ID, alias.id)).toBe(false);
    expect(findQuestionAliases(database, LOCAL_CANDIDATE_ID, "Do you use Python?")).toEqual([]);
    expect(listQuestionAliases(database, LOCAL_CANDIDATE_ID)).toEqual([]);
    // A revoked wording may be recorded again.
    expect(recordQuestionAlias(database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Do you use Python?", target: question, atsKind: "lever", source: "candidate_answer", sourceRunId: null
    }).status).toBe("recorded");
    database.close();
  });

  it("reads as empty on a database without the table", () => {
    const database = new DatabaseSync(":memory:");
    expect(questionAliasStoreAvailable(database)).toBe(false);
    expect(findQuestionAliases(database, LOCAL_CANDIDATE_ID, "Do you use Python?")).toEqual([]);
    expect(listQuestionAliases(database, LOCAL_CANDIDATE_ID)).toEqual([]);
    expect(findQuestionAliasIds(database, LOCAL_CANDIDATE_ID, "00000000")).toEqual([]);
    expect(revokeQuestionAlias(database, LOCAL_CANDIDATE_ID, "00000000-0000-4000-8000-000000000001")).toBe(false);
    database.close();
  });
});
