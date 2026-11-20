import type { DatabaseSync } from "node:sqlite";

import type { ApplicationType, BrowserRun, EmploymentType, JobPostingStatus } from "@internship-agent/domain";

import { listBrowserRuns } from "./browser-run-repository";

export type CompanyHistoryEntry = {
  jobId: string;
  companyName: string;
  title: string;
  employmentType: EmploymentType;
  applicationType: ApplicationType;
  status: JobPostingStatus;
  /** The source, external application, and careers URLs that are set. */
  urls: string[];
  /** The current snapshot text, "" when none. */
  text: string;
  updatedAt: string;
  /** Reached SUBMITTED: now SUBMITTED or a later stage, an event to SUBMITTED, or a submitted run. */
  submitted: boolean;
  runs: BrowserRun[];
  /** The job's events into APPLYING (run starts among them), oldest first. */
  applyingEvents: Array<{ detail: string | null; at: string }>;
};

type HistoryRow = {
  id: string;
  company_name: string;
  title: string;
  employment_type: EmploymentType;
  application_type: ApplicationType;
  status: JobPostingStatus;
  source_url: string;
  external_application_url: string | null;
  company_careers_url: string | null;
  updated_at: string;
  normalized_text: string | null;
  was_submitted: number;
};

const SUBMITTED_STAGES: readonly JobPostingStatus[] = ["SUBMITTED", "INTERVIEW", "OFFER", "REJECTED"];

/** Postings that reached a browser run or a submission, with their runs: the history the company policies read. */
export function listCompanyHistory(database: DatabaseSync): CompanyHistoryEntry[] {
  const rows = database.prepare(`
    SELECT j.id, j.company_name, j.title, j.employment_type, j.application_type, j.status,
      j.source_url, j.external_application_url, j.company_careers_url, j.updated_at,
      s.normalized_text,
      EXISTS (SELECT 1 FROM application_events e WHERE e.job_id = j.id AND e.to_status = 'SUBMITTED') AS was_submitted
    FROM jobs j
    LEFT JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
    WHERE j.status IN ('SUBMITTED', 'INTERVIEW', 'OFFER', 'REJECTED')
      OR EXISTS (SELECT 1 FROM browser_runs r WHERE r.job_id = j.id)
      OR EXISTS (SELECT 1 FROM application_events e WHERE e.job_id = j.id AND e.to_status = 'SUBMITTED')
    ORDER BY j.created_at, j.id
  `).all() as HistoryRow[];
  const applyingEvents = database.prepare(
    "SELECT detail, created_at FROM application_events WHERE job_id = ? AND to_status = 'APPLYING' ORDER BY created_at, rowid"
  );
  return rows.map((row) => {
    const runs = listBrowserRuns(database, row.id);
    return {
      jobId: row.id,
      companyName: row.company_name,
      title: row.title,
      employmentType: row.employment_type,
      applicationType: row.application_type,
      status: row.status,
      urls: [row.source_url, row.external_application_url, row.company_careers_url].filter(
        (url): url is string => Boolean(url)
      ),
      text: row.normalized_text ?? "",
      updatedAt: row.updated_at,
      submitted: SUBMITTED_STAGES.includes(row.status) || row.was_submitted === 1 || runs.some((run) => run.status === "submitted"),
      runs,
      applyingEvents: (applyingEvents.all(row.id) as Array<{ detail: string | null; created_at: string }>).map((event) => ({
        detail: event.detail,
        at: event.created_at
      }))
    };
  });
}
