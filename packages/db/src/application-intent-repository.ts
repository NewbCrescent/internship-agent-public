import type { DatabaseSync } from "node:sqlite";

import { applicationIntentStatementSchema, type ApplicationIntent } from "@internship-agent/domain";

/**
 * The candidate's application intent statement (migration 0028), context for
 * the AI fit judgment only. Every write bumps the AI-fit context version
 * through the table's triggers, so a changed statement re-scores every fit.
 */
type IntentRow = { statement: string; updated_at: string };

export function getApplicationIntent(database: DatabaseSync, candidateId: string): ApplicationIntent | null {
  const row = database.prepare("SELECT statement, updated_at FROM candidate_application_intent WHERE candidate_id = ?")
    .get(candidateId) as IntentRow | undefined;
  return row ? { statement: row.statement, updatedAt: row.updated_at } : null;
}

/** Stores the statement; identical text is left as is, so it does not re-score every fit. */
export function saveApplicationIntent(database: DatabaseSync, candidateId: string, statement: string): ApplicationIntent {
  const parsed = applicationIntentStatementSchema.parse(statement);
  const stored = getApplicationIntent(database, candidateId);
  if (stored && stored.statement === parsed) return stored;
  const updatedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO candidate_application_intent (candidate_id, statement, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET statement = excluded.statement, updated_at = excluded.updated_at
  `).run(candidateId, parsed, updatedAt);
  return { statement: parsed, updatedAt };
}

/** Removes the statement; true when one was stored. */
export function clearApplicationIntent(database: DatabaseSync, candidateId: string): boolean {
  const result = database.prepare("DELETE FROM candidate_application_intent WHERE candidate_id = ?").run(candidateId);
  return Number(result.changes) > 0;
}
