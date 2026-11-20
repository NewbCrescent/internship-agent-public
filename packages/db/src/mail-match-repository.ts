import type { DatabaseSync } from "node:sqlite";

import type { JobPostingStatus } from "@internship-agent/domain";

/**
 * Applications the Gmail watcher may match an email to: postings the
 * candidate submitted (or that moved on to an outcome) first, then postings
 * the agent started (APPLYING, or any browser run). Read-only.
 */
export type AppliedJob = {
  id: string;
  companyName: string;
  title: string;
  status: JobPostingStatus;
  submitted: boolean;
  sourceUrl: string;
  externalApplicationUrl: string | null;
};

const SUBMITTED_STATUSES = new Set<string>(["SUBMITTED", "INTERVIEW", "OFFER", "REJECTED"]);

export function listAppliedJobsForMail(database: DatabaseSync, limit = 2_000): AppliedJob[] {
  const rows = database.prepare(`
    SELECT j.id, j.company_name, j.title, j.status, j.source_url, j.external_application_url
    FROM jobs j
    WHERE j.status IN ('SUBMITTED','INTERVIEW','OFFER','REJECTED','APPLYING')
       OR EXISTS (SELECT 1 FROM browser_runs r WHERE r.job_id = j.id)
    ORDER BY CASE WHEN j.status IN ('SUBMITTED','INTERVIEW','OFFER','REJECTED') THEN 0 ELSE 1 END, j.updated_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; company_name: string; title: string; status: JobPostingStatus;
    source_url: string; external_application_url: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    companyName: row.company_name,
    title: row.title,
    status: row.status,
    submitted: SUBMITTED_STATUSES.has(row.status),
    sourceUrl: row.source_url,
    externalApplicationUrl: row.external_application_url
  }));
}

export function hasApplicationEventDetail(database: DatabaseSync, jobId: string, detail: string): boolean {
  return database.prepare("SELECT 1 FROM application_events WHERE job_id = ? AND detail = ? LIMIT 1").get(jobId, detail) !== undefined;
}
