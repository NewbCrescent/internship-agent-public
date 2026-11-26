import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  normalizeQuestionText,
  questionAliasSchema,
  type BrowserFieldKind,
  type QuestionAlias,
  type QuestionAliasSource,
  type QuestionAliasTarget
} from "@internship-agent/domain";

/**
 * Recorded question wordings (migration 0036): the exact wording of each
 * question a stop asked, recorded against the saved answer it matched (a
 * candidate fact by key and scope key, or a question-memory answer by its
 * question key), with the ATS kind and the options the field offered. It
 * stores no answer value. A database without the table (an older profile
 * opened read-only) reads as empty.
 */

type AliasRow = {
  id: string;
  candidate_id: string;
  wording: string;
  wording_key: string;
  target_kind: string;
  fact_key: string | null;
  fact_scope_key: string | null;
  question_key: string | null;
  ats_kind: string;
  field_kind: string | null;
  options_json: string;
  source: string;
  source_run_id: string | null;
  created_at: string;
  last_seen_at: string;
  seen_count: number;
  revoked_at: string | null;
};

export type QuestionAliasMatch = QuestionAlias & { matchedBy: "exact" | "normalized" };

const available = new WeakMap<DatabaseSync, boolean>();

/** True when the database has the alias table (migration 0036); cached per handle. */
export function questionAliasStoreAvailable(database: DatabaseSync): boolean {
  const cached = available.get(database);
  if (cached !== undefined) return cached;
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidate_question_aliases'").get();
  const present = row !== undefined;
  // Only a present table is cached: a handle opened before its migration may gain it later.
  if (present) available.set(database, true);
  return present;
}

function targetOf(row: AliasRow): QuestionAliasTarget {
  return row.target_kind === "fact"
    ? { kind: "fact", factKey: row.fact_key ?? "", scopeKey: row.fact_scope_key ?? "" }
    : { kind: "question", questionKey: row.question_key ?? "" };
}

function parseRow(row: AliasRow): QuestionAlias {
  return questionAliasSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    wording: row.wording,
    wordingKey: row.wording_key,
    target: targetOf(row),
    atsKind: row.ats_kind,
    fieldKind: row.field_kind,
    options: JSON.parse(row.options_json) as unknown,
    source: row.source,
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    revokedAt: row.revoked_at
  });
}

export type RecordQuestionAliasInput = {
  candidateId: string;
  wording: string;
  target: QuestionAliasTarget;
  atsKind: string;
  fieldKind?: BrowserFieldKind | null;
  options?: readonly string[];
  source: QuestionAliasSource;
  sourceRunId: string | null;
};

/**
 * Records this exact wording against its saved answer, or, when the same
 * wording, target, and ATS kind is already recorded, bumps its last-seen time
 * and count ("seen").
 */
export function recordQuestionAlias(
  database: DatabaseSync,
  input: RecordQuestionAliasInput
): { alias: QuestionAlias; status: "recorded" | "seen" } {
  const wordingKey = normalizeQuestionText(input.wording);
  if (wordingKey === "") throw new Error("The question has no words to match on.");
  if (input.wording.length > 300) throw new Error("The question is longer than 300 characters.");
  const factKey = input.target.kind === "fact" ? input.target.factKey : null;
  const factScopeKey = input.target.kind === "fact" ? input.target.scopeKey : null;
  const questionKey = input.target.kind === "question" ? input.target.questionKey : null;
  const options = JSON.stringify((input.options ?? []).slice(0, 500));
  const fieldKind = input.fieldKind ?? null;
  const now = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE;");
  try {
    const existing = database.prepare(`
      SELECT * FROM candidate_question_aliases
      WHERE candidate_id = ? AND wording = ? AND target_kind = ?
        AND IFNULL(fact_key, '') = ? AND IFNULL(fact_scope_key, '') = ? AND IFNULL(question_key, '') = ?
        AND ats_kind = ? AND revoked_at IS NULL
    `).get(input.candidateId, input.wording, input.target.kind, factKey ?? "", factScopeKey ?? "", questionKey ?? "", input.atsKind) as AliasRow | undefined;
    if (existing) {
      database.prepare(`
        UPDATE candidate_question_aliases
        SET last_seen_at = ?, seen_count = seen_count + 1, options_json = ?, field_kind = ?
        WHERE id = ?
      `).run(now, options, fieldKind, existing.id);
      const updated = database.prepare("SELECT * FROM candidate_question_aliases WHERE id = ?").get(existing.id) as AliasRow;
      database.exec("COMMIT;");
      return { alias: parseRow(updated), status: "seen" };
    }
    const id = randomUUID();
    database.prepare(`
      INSERT INTO candidate_question_aliases (
        id, candidate_id, wording, wording_key, target_kind, fact_key, fact_scope_key, question_key,
        ats_kind, field_kind, options_json, source, source_run_id, created_at, last_seen_at, seen_count, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
    `).run(
      id, input.candidateId, input.wording, wordingKey, input.target.kind, factKey, factScopeKey, questionKey,
      input.atsKind, fieldKind, options, input.source, input.sourceRunId, now, now
    );
    const inserted = database.prepare("SELECT * FROM candidate_question_aliases WHERE id = ?").get(id) as AliasRow;
    const alias = parseRow(inserted);
    database.exec("COMMIT;");
    return { alias, status: "recorded" };
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** Current aliases for this wording: exact wording first, then the same normalized wording, newest first. */
export function findQuestionAliases(database: DatabaseSync, candidateId: string, wording: string): QuestionAliasMatch[] {
  if (!questionAliasStoreAvailable(database)) return [];
  const key = normalizeQuestionText(wording);
  if (key === "") return [];
  const rows = database.prepare(`
    SELECT * FROM candidate_question_aliases
    WHERE candidate_id = ? AND revoked_at IS NULL AND (wording = ? OR wording_key = ?)
    ORDER BY CASE WHEN wording = ? THEN 0 ELSE 1 END, last_seen_at DESC, id
  `).all(candidateId, wording, key, wording) as AliasRow[];
  return rows.map((row) => ({ ...parseRow(row), matchedBy: row.wording === wording ? "exact" : "normalized" }));
}

/** Every current alias, by target, then wording. */
export function listQuestionAliases(database: DatabaseSync, candidateId: string): QuestionAlias[] {
  if (!questionAliasStoreAvailable(database)) return [];
  const rows = database.prepare(`
    SELECT * FROM candidate_question_aliases
    WHERE candidate_id = ? AND revoked_at IS NULL
    ORDER BY target_kind, IFNULL(fact_key, ''), IFNULL(fact_scope_key, ''), IFNULL(question_key, ''), wording COLLATE NOCASE, id
  `).all(candidateId) as AliasRow[];
  return rows.map(parseRow);
}

/** Revokes a current alias; false when it is not current. */
export function revokeQuestionAlias(database: DatabaseSync, candidateId: string, id: string): boolean {
  if (!questionAliasStoreAvailable(database)) return false;
  const result = database.prepare(`
    UPDATE candidate_question_aliases SET revoked_at = ?
    WHERE id = ? AND candidate_id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), id, candidateId);
  return result.changes === 1;
}

/** Current alias ids starting with this prefix (8 to 36 hex characters or dashes); at most three. */
export function findQuestionAliasIds(database: DatabaseSync, candidateId: string, prefix: string): string[] {
  if (!questionAliasStoreAvailable(database)) return [];
  if (!/^[0-9a-f-]{8,36}$/i.test(prefix)) return [];
  const rows = database.prepare(`
    SELECT id FROM candidate_question_aliases
    WHERE candidate_id = ? AND id LIKE ? AND revoked_at IS NULL
    ORDER BY id LIMIT 3
  `).all(candidateId, `${prefix.toLowerCase()}%`) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
