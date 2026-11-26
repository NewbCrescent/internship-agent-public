import type { DatabaseSync } from "node:sqlite";

import { applicationHoldSchemaPresent } from "./application-hold-repository";

/**
 * Bounded read-only queries for the application scoreboard (pnpm pipeline:scoreboard).
 * Nothing here writes, and nothing returns answers, drafts, decision values, fact values,
 * or free-text match reasons: only ids, statuses, timestamps, keys, and labels.
 */

export type ScoreboardJob = { id: string; companyName: string; status: string; createdAt: string };

export function listScoreboardJobs(database: DatabaseSync): ScoreboardJob[] {
  return database.prepare("SELECT id, company_name AS companyName, status, created_at AS createdAt FROM jobs")
    .all() as ScoreboardJob[];
}

export type ScoreboardEvent = {
  id: string; jobId: string; fromStatus: string | null; toStatus: string; detail: string | null; createdAt: string;
};

export function listScoreboardEventsSince(database: DatabaseSync, sinceIso: string): ScoreboardEvent[] {
  return database.prepare(`
    SELECT id, job_id AS jobId, from_status AS fromStatus, to_status AS toStatus, detail, created_at AS createdAt
    FROM application_events WHERE created_at >= ? ORDER BY created_at, id
  `).all(sinceIso) as ScoreboardEvent[];
}

export type ScoreboardRun = {
  id: string; jobId: string; status: string; atsKind: string; confirmationText: string | null;
  submissionApprovedAt: string | null; createdAt: string; updatedAt: string;
};

export function listScoreboardRunsSince(database: DatabaseSync, sinceIso: string): ScoreboardRun[] {
  return database.prepare(`
    SELECT id, job_id AS jobId, status, ats_kind AS atsKind, confirmation_text AS confirmationText,
      submission_approved_at AS submissionApprovedAt, created_at AS createdAt, updated_at AS updatedAt
    FROM browser_runs WHERE created_at >= ? OR updated_at >= ? OR submission_approved_at >= ?
    ORDER BY created_at, id
  `).all(sinceIso, sinceIso, sinceIso) as ScoreboardRun[];
}

/** Every run with status submitted, with its confirmation text, regardless of the window. */
export function listSubmittedRunConfirmations(database: DatabaseSync): Array<{ runId: string; jobId: string; confirmationText: string | null; updatedAt: string }> {
  return database.prepare(`
    SELECT id AS runId, job_id AS jobId, confirmation_text AS confirmationText, updated_at AS updatedAt
    FROM browser_runs WHERE status = 'submitted' ORDER BY updated_at, id
  `).all() as Array<{ runId: string; jobId: string; confirmationText: string | null; updatedAt: string }>;
}

/** Runs whose employer receipt was checked and matched; empty before migration 0033. */
export function listConfirmedReceipts(database: DatabaseSync): Array<{ runId: string; jobId: string; checkedAt: string }> {
  if (!applicationHoldSchemaPresent(database)) return [];
  return database.prepare(`
    SELECT c.run_id AS runId, r.job_id AS jobId, c.checked_at AS checkedAt
    FROM application_receipt_checks c JOIN browser_runs r ON r.id = c.run_id
    WHERE c.result = 'confirmed' ORDER BY c.checked_at, c.run_id
  `).all() as Array<{ runId: string; jobId: string; checkedAt: string }>;
}

export type ScoreboardMatch = { jobId: string; verdict: string; eligible: boolean; evaluatedAt: string; failedSubjects: string[] };

const SUBJECT = /^[A-Z_]{1,40}$/;

/** Match verdicts with only the subjects of failed findings (never their reason text, which can quote resume content). */
export function listScoreboardMatches(database: DatabaseSync): ScoreboardMatch[] {
  const rows = database.prepare("SELECT job_id, verdict, eligible, findings_json, evaluated_at FROM job_matches")
    .all() as Array<{ job_id: string; verdict: string; eligible: number; findings_json: string; evaluated_at: string }>;
  return rows.map((row) => {
    const failedSubjects: string[] = [];
    try {
      const findings: unknown = JSON.parse(row.findings_json);
      if (Array.isArray(findings)) {
        for (const finding of findings) {
          if (!finding || typeof finding !== "object") continue;
          const { outcome, subject } = finding as { outcome?: unknown; subject?: unknown };
          if (outcome !== "FAIL") continue;
          failedSubjects.push(typeof subject === "string" && SUBJECT.test(subject) ? subject : "OTHER");
        }
      }
    } catch {
      // A damaged findings column reads as no failed subjects.
    }
    return { jobId: row.job_id, verdict: row.verdict, eligible: row.eligible === 1, evaluatedAt: row.evaluated_at, failedSubjects };
  });
}

/** Discovery feedback skips: the reason and time only (never the preference note). */
export function listDiscoverySkipReasons(database: DatabaseSync): Array<{ jobId: string; reason: string; createdAt: string }> {
  return database.prepare("SELECT job_id AS jobId, reason, created_at AS createdAt FROM discovery_feedback")
    .all() as Array<{ jobId: string; reason: string; createdAt: string }>;
}

/** The key and scope of each current candidate fact (never its value). */
export function listCurrentFactScopes(database: DatabaseSync): Array<{ key: string; scopeKey: string }> {
  return database.prepare(`
    SELECT DISTINCT key, scope_key AS scopeKey FROM candidate_facts WHERE superseded_at IS NULL AND revoked_at IS NULL
  `).all() as Array<{ key: string; scopeKey: string }>;
}

/** The normalized question key of each current saved question answer (never the answer). */
export function listCurrentQuestionKeys(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT DISTINCT question_key FROM candidate_question_answers WHERE superseded_at IS NULL AND revoked_at IS NULL
  `).all() as Array<{ question_key: string }>).map((row) => row.question_key);
}

export function countJobsByStatus(database: DatabaseSync): Array<{ status: string; count: number }> {
  return database.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; count: number }>;
}

const CANDIDATE_VALUE_COLUMNS = [
  "full_name", "preferred_name", "legal_first_name", "legal_last_name", "email", "phone", "school", "high_school_name",
  "address_line1", "address_line2", "address_city", "address_postal_code", "linkedin_url", "github_url", "portfolio_url"
];

const tablePresent = (database: DatabaseSync, name: string) =>
  !!database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);

/**
 * Candidate-entered values, read only for in-memory redaction of printed labels; never printed, logged, or stored.
 * Identity and contact fields, coursework schools, current text and protected fact values, current
 * question-memory answers, and current resume entry titles and links. Generic fields (degree, field of
 * study, region, country, resume roles and locations) are left out on purpose.
 */
export function listCandidateValueTexts(database: DatabaseSync): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  };
  if (tablePresent(database, "candidates")) {
    const present = new Set((database.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>).map((column) => column.name));
    const columns = CANDIDATE_VALUE_COLUMNS.filter((column) => present.has(column));
    if (columns.length) {
      for (const row of database.prepare(`SELECT ${columns.join(", ")} FROM candidates`).all() as Array<Record<string, unknown>>) {
        for (const column of columns) add(row[column]);
      }
    }
  }
  if (tablePresent(database, "candidate_coursework")) {
    for (const row of database.prepare("SELECT school FROM candidate_coursework").all() as Array<{ school: unknown }>) add(row.school);
  }
  if (tablePresent(database, "candidate_facts")) {
    const rows = database.prepare(`
      SELECT value_json FROM candidate_facts
      WHERE superseded_at IS NULL AND revoked_at IS NULL AND (value_type = 'text' OR sensitivity = 'protected')
    `).all() as Array<{ value_json: string }>;
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.value_json); } catch { continue; }
      if (Array.isArray(parsed)) parsed.forEach(add);
      else add(parsed);
    }
  }
  if (tablePresent(database, "candidate_question_answers")) {
    for (const row of database.prepare("SELECT answer FROM candidate_question_answers WHERE superseded_at IS NULL AND revoked_at IS NULL")
      .all() as Array<{ answer: unknown }>) add(row.answer);
  }
  if (tablePresent(database, "resume_entry_revisions")) {
    for (const row of database.prepare("SELECT title, link_url FROM resume_entry_revisions WHERE superseded_at IS NULL")
      .all() as Array<{ title: unknown; link_url: unknown }>) {
      add(row.title);
      add(row.link_url);
    }
  }
  return values;
}
