import type { DatabaseSync } from "node:sqlite";

import {
  eligibilityFindingSchema,
  fitReasonSchema,
  jobMatchReportSchema,
  matchVerdictSchema,
  type EligibilityFinding,
  type FitReason,
  type JobMatchReport,
  type JobPostingStatus,
  type MatchVerdict
} from "@internship-agent/domain";

type MatchRow = {
  job_id: string;
  verdict: MatchVerdict;
  eligible: number;
  fit_score: number;
  findings_json: string;
  reasons_json: string;
  evaluated_at: string;
  scoring_version: number;
};

/**
 * Match reports are replaced on every evaluation, in the same transaction
 * that moves the job into QUALIFIED, NOT_QUALIFIED, or ANALYZING. A
 * NEEDS_REVIEW verdict leaves the posting in ANALYZING: unknown facts pause
 * the workflow instead of deciding it.
 */
export function saveJobMatch(
  database: DatabaseSync,
  report: JobMatchReport
): JobMatchReport {
  const parsed = jobMatchReportSchema.parse(report);
  const status: JobPostingStatus =
    parsed.verdict === "QUALIFIED"
      ? "QUALIFIED"
      : parsed.verdict === "NOT_QUALIFIED"
        ? "NOT_QUALIFIED"
        : "ANALYZING";

  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare(`
      INSERT INTO job_matches (
        job_id, verdict, eligible, fit_score,
        findings_json, reasons_json, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        verdict = excluded.verdict,
        eligible = excluded.eligible,
        fit_score = excluded.fit_score,
        findings_json = excluded.findings_json,
        reasons_json = excluded.reasons_json,
        evaluated_at = excluded.evaluated_at
    `).run(
      parsed.jobId,
      parsed.verdict,
      parsed.eligible ? 1 : 0,
      parsed.fitScore,
      JSON.stringify(parsed.findings),
      JSON.stringify(parsed.reasons),
      parsed.evaluatedAt
    );
    database.prepare("UPDATE job_matches SET scoring_version = ? WHERE job_id = ?").run(parsed.scoringVersion, parsed.jobId);
    database.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, parsed.evaluatedAt, parsed.jobId);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return parsed;
}

export function getJobMatch(database: DatabaseSync, jobId: string): JobMatchReport | null {
  const row = database.prepare("SELECT * FROM job_matches WHERE job_id = ?")
    .get(jobId) as MatchRow | undefined;
  if (!row) return null;
  return jobMatchReportSchema.parse({
    jobId: row.job_id,
    verdict: matchVerdictSchema.parse(row.verdict),
    eligible: row.eligible === 1,
    fitScore: row.fit_score,
    findings: (JSON.parse(row.findings_json) as unknown[]).map((finding) =>
      eligibilityFindingSchema.parse(finding)
    ),
    reasons: (JSON.parse(row.reasons_json) as unknown[]).map((reason) =>
      fitReasonSchema.parse(reason)
    ),
    evaluatedAt: row.evaluated_at,
    scoringVersion: row.scoring_version
  });
}

export function listJobMatches(database: DatabaseSync): JobMatchReport[] {
  const rows = database.prepare("SELECT * FROM job_matches ORDER BY fit_score DESC")
    .all() as MatchRow[];
  return rows.map((row) =>
    getJobMatch(database, row.job_id)
  ).filter((report): report is JobMatchReport => report !== null);
}

export type { EligibilityFinding, FitReason, JobMatchReport, MatchVerdict };


/** Replace only fit measurements; never change eligibility, approvals, or browser state. */
export function replaceJobFit(database: DatabaseSync, report: JobMatchReport) {
  const parsed = jobMatchReportSchema.parse(report);
  database.prepare("UPDATE job_matches SET fit_score = ?, reasons_json = ?, scoring_version = ? WHERE job_id = ?")
    .run(parsed.fitScore, JSON.stringify(parsed.reasons), parsed.scoringVersion, parsed.jobId);
}
