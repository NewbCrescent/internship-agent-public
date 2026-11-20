import type { DatabaseSync } from "node:sqlite";

import type { JobPostingStatus } from "@internship-agent/domain";

/**
 * A posting whose requirement lines were found but not labelled by the model.
 * While a hold exists the posting has no requirement rows and is never
 * analyzed, prepared, or run; each pipeline pass retries the labels.
 */
export type RequirementLabelHold = {
  jobId: string;
  snapshotId: string;
  reason: string;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string;
};

export type RequirementRelabelCandidate = {
  jobId: string;
  status: JobPostingStatus;
  companyName: string;
  title: string;
  snapshotId: string;
  /** A stored requirement row carries a rule label. */
  ruleLabels: boolean;
  /** A requirement classification call failed for this posting before its current snapshot was stored. */
  failedModelCall: boolean;
  held: boolean;
};

const MAX_REASON_LENGTH = 1_000;

type HoldRow = {
  job_id: string;
  snapshot_id: string;
  reason: string;
  attempts: number;
  created_at: string;
  last_attempt_at: string;
};

function toHold(row: HoldRow): RequirementLabelHold {
  return {
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    reason: row.reason,
    attempts: row.attempts,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at
  };
}

export function getRequirementLabelHold(database: DatabaseSync, jobId: string): RequirementLabelHold | null {
  const row = database.prepare("SELECT * FROM requirement_label_holds WHERE job_id = ?")
    .get(jobId) as HoldRow | undefined;
  return row ? toHold(row) : null;
}

export function listRequirementLabelHolds(database: DatabaseSync): RequirementLabelHold[] {
  const rows = database.prepare("SELECT * FROM requirement_label_holds ORDER BY last_attempt_at ASC, job_id ASC")
    .all() as HoldRow[];
  return rows.map(toHold);
}

/** Creates a hold, or records another failed attempt on an existing one. */
export function holdRequirementLabels(
  database: DatabaseSync,
  hold: { jobId: string; snapshotId: string; reason: string }
): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO requirement_label_holds (job_id, snapshot_id, reason, attempts, created_at, last_attempt_at)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      reason = excluded.reason,
      snapshot_id = excluded.snapshot_id,
      attempts = requirement_label_holds.attempts + 1,
      last_attempt_at = excluded.last_attempt_at
  `).run(hold.jobId, hold.snapshotId, hold.reason.slice(0, MAX_REASON_LENGTH), now, now);
}

/**
 * Postings whose stored labels may not have come from the model: a rule label
 * is stored, or a classification call failed before the current snapshot was
 * captured (a failed call used to fall back to rule labels stamped MODEL).
 */
export function listRequirementRelabelCandidates(database: DatabaseSync): RequirementRelabelCandidate[] {
  const rows = database.prepare(`
    SELECT
      jobs.id AS job_id,
      jobs.status AS status,
      jobs.company_name AS company_name,
      jobs.title AS title,
      snapshot.id AS snapshot_id,
      EXISTS (
        SELECT 1 FROM job_requirements
        WHERE job_requirements.job_id = jobs.id AND job_requirements.extraction = 'DETERMINISTIC'
      ) AS rule_labels,
      EXISTS (
        SELECT 1 FROM model_invocations
        WHERE model_invocations.task = 'job.requirement_classification'
          AND model_invocations.outcome = 'failed'
          AND (model_invocations.source_url = jobs.source_url OR model_invocations.job_id = jobs.id)
          AND model_invocations.created_at <= snapshot.captured_at
      ) AS failed_model_call,
      EXISTS (
        SELECT 1 FROM requirement_label_holds WHERE requirement_label_holds.job_id = jobs.id
      ) AS held
    FROM jobs
    JOIN job_snapshots AS snapshot ON snapshot.job_id = jobs.id AND snapshot.superseded_at IS NULL
    ORDER BY jobs.created_at ASC, jobs.id ASC
  `).all() as Array<{
    job_id: string;
    status: JobPostingStatus;
    company_name: string;
    title: string;
    snapshot_id: string;
    rule_labels: number;
    failed_model_call: number;
    held: number;
  }>;
  return rows
    .filter((row) => row.rule_labels || row.failed_model_call)
    .map((row) => ({
      jobId: row.job_id,
      status: row.status,
      companyName: row.company_name,
      title: row.title,
      snapshotId: row.snapshot_id,
      ruleLabels: Boolean(row.rule_labels),
      failedModelCall: Boolean(row.failed_model_call),
      held: Boolean(row.held)
    }));
}
