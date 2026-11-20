import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  normalizeAnswerText,
  normalizeQuestionText,
  savedQuestionAnswerSchema,
  type SavedQuestionAnswer
} from "@internship-agent/domain";

/**
 * Question memory (migration 0032): the candidate's own answers to questions
 * outside the fact catalog, keyed by the normalized question text and matched
 * exactly. Append-only by revision, like candidate facts. This repository
 * stores what it is given; the never-save rules live in packages/domain and
 * packages/agent.
 */

type QuestionAnswerRow = {
  id: string;
  candidate_id: string;
  question_key: string;
  question: string;
  answer_kind: string;
  answer: string;
  answer_key: string;
  source_run_id: string | null;
  created_at: string;
  superseded_at: string | null;
  superseded_by_id: string | null;
  revoked_at: string | null;
};

function parseRow(row: QuestionAnswerRow): SavedQuestionAnswer {
  return savedQuestionAnswerSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    questionKey: row.question_key,
    question: row.question,
    answerKind: row.answer_kind,
    answer: row.answer,
    answerKey: row.answer_key,
    sourceRunId: row.source_run_id,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
    supersededById: row.superseded_by_id,
    revokedAt: row.revoked_at
  });
}

function currentRow(database: DatabaseSync, candidateId: string, questionKey: string): QuestionAnswerRow | undefined {
  return database.prepare(`
    SELECT * FROM candidate_question_answers
    WHERE candidate_id = ? AND question_key = ?
      AND superseded_at IS NULL AND revoked_at IS NULL
  `).get(candidateId, questionKey) as QuestionAnswerRow | undefined;
}

/** The current saved answer for exactly this question (after normalization), or null. */
export function getCurrentQuestionAnswer(
  database: DatabaseSync,
  candidateId: string,
  question: string
): SavedQuestionAnswer | null {
  const key = normalizeQuestionText(question);
  if (key === "") return null;
  const row = currentRow(database, candidateId, key);
  return row ? parseRow(row) : null;
}

/** Every current saved answer, by question. */
export function listCurrentQuestionAnswers(database: DatabaseSync, candidateId: string): SavedQuestionAnswer[] {
  const rows = database.prepare(`
    SELECT * FROM candidate_question_answers
    WHERE candidate_id = ? AND superseded_at IS NULL AND revoked_at IS NULL
    ORDER BY question COLLATE NOCASE, id
  `).all(candidateId) as QuestionAnswerRow[];
  return rows.map(parseRow);
}

export type SaveQuestionAnswerInput = {
  candidateId: string;
  question: string;
  answerKind: "text" | "option";
  answer: string;
  sourceRunId: string | null;
};

/** Saves an answer, superseding the question's current one; an identical answer is left as is. */
export function saveQuestionAnswer(
  database: DatabaseSync,
  input: SaveQuestionAnswerInput
): { answer: SavedQuestionAnswer; status: "saved" | "replaced" | "unchanged" } {
  const questionKey = normalizeQuestionText(input.question);
  if (questionKey === "") throw new Error("The question has no words to match on.");
  const answerKey = normalizeAnswerText(input.answer);
  if (answerKey === "") throw new Error("The answer has no words to match on.");
  const id = randomUUID();
  const now = new Date().toISOString();
  const saved = savedQuestionAnswerSchema.parse({
    id,
    candidateId: input.candidateId,
    questionKey,
    question: input.question,
    answerKind: input.answerKind,
    answer: input.answer,
    answerKey,
    sourceRunId: input.sourceRunId,
    createdAt: now,
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  });

  database.exec("BEGIN IMMEDIATE;");
  try {
    const previous = currentRow(database, input.candidateId, questionKey);
    if (previous && previous.answer_kind === saved.answerKind && previous.answer === saved.answer) {
      database.exec("COMMIT;");
      return { answer: parseRow(previous), status: "unchanged" };
    }
    if (previous) {
      database.prepare("UPDATE candidate_question_answers SET superseded_at = ? WHERE id = ?").run(now, previous.id);
    }
    database.prepare(`
      INSERT INTO candidate_question_answers (
        id, candidate_id, question_key, question, answer_kind, answer, answer_key,
        source_run_id, created_at, superseded_at, superseded_by_id, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      saved.id,
      saved.candidateId,
      saved.questionKey,
      saved.question,
      saved.answerKind,
      saved.answer,
      saved.answerKey,
      saved.sourceRunId,
      saved.createdAt
    );
    if (previous) {
      database.prepare("UPDATE candidate_question_answers SET superseded_by_id = ? WHERE id = ?").run(id, previous.id);
    }
    database.exec("COMMIT;");
    return { answer: saved, status: previous ? "replaced" : "saved" };
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

/** Revokes a current saved answer; false when it is not current. */
export function revokeQuestionAnswer(database: DatabaseSync, candidateId: string, answerId: string): boolean {
  const result = database.prepare(`
    UPDATE candidate_question_answers SET revoked_at = ?
    WHERE id = ? AND candidate_id = ? AND superseded_at IS NULL AND revoked_at IS NULL
  `).run(new Date().toISOString(), answerId, candidateId);
  return result.changes === 1;
}

/** Current saved-answer ids starting with this prefix (8 to 36 hex characters or dashes); at most three. */
export function findCurrentQuestionAnswerIds(database: DatabaseSync, candidateId: string, prefix: string): string[] {
  if (!/^[0-9a-f-]{8,36}$/i.test(prefix)) return [];
  const rows = database.prepare(`
    SELECT id FROM candidate_question_answers
    WHERE candidate_id = ? AND id LIKE ? AND superseded_at IS NULL AND revoked_at IS NULL
    ORDER BY id LIMIT 3
  `).all(candidateId, `${prefix.toLowerCase()}%`) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}
