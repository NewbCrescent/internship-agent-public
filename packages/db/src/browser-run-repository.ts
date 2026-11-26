import type { DatabaseSync } from "node:sqlite";

import {
  browserRunSchema,
  fillDecisionSchema,
  pauseRecordSchema,
  type ApplicationProfile,
  type BrowserRun,
  type FillDecision,
  type PauseRecord
} from "@internship-agent/domain";
import { normalizeSqliteDateTime } from "./job-posting-repository";

type RunRow = {
  id: string;
  job_id: string;
  application_url: string;
  status: BrowserRun["status"];
  package_id: string;
  variant_id: string | null;
  base_resume_id: string | null;
  application_profile: ApplicationProfile | null;
  ats_kind: BrowserRun["atsKind"];
  ats_confidence: number;
  suggested_ats_kind: BrowserRun["suggestedAtsKind"];
  ats_confirmed: number;
  decisions_json: string;
  pauses_json: string;
  submitted_answers_json: string | null;
  confirmation_text: string | null;
  submission_approved_at: string | null;
  created_at: string;
  updated_at: string;
};

function parseRow(row: RunRow): BrowserRun {
  return browserRunSchema.parse({
    id: row.id,
    jobId: row.job_id,
    applicationUrl: row.application_url,
    status: row.status,
    packageId: row.package_id,
    variantId: row.variant_id,
    baseResumeId: row.base_resume_id,
    applicationProfile: row.application_profile,
    atsKind: row.ats_kind,
    atsConfidence: row.ats_confidence,
    suggestedAtsKind: row.suggested_ats_kind,
    atsConfirmed: row.ats_confirmed === 1,
    decisions: (JSON.parse(row.decisions_json) as unknown[]).map((decision) =>
      fillDecisionSchema.parse(decision)
    ),
    pauses: (JSON.parse(row.pauses_json) as unknown[]).map((pause) =>
      pauseRecordSchema.parse(pause)
    ),
    submittedAnswers: row.submitted_answers_json ? JSON.parse(row.submitted_answers_json) : null,
    confirmationText: row.confirmation_text,
    submissionApprovedAt: row.submission_approved_at
      ? normalizeSqliteDateTime(row.submission_approved_at)
      : null,
    createdAt: normalizeSqliteDateTime(row.created_at),
    updatedAt: normalizeSqliteDateTime(row.updated_at)
  });
}

/** Runs are replaced per attempt: one current row per job, history via events. */
export function saveBrowserRun(database: DatabaseSync, run: BrowserRun): BrowserRun {
  const parsed = browserRunSchema.parse(run);
  database.prepare(`
    INSERT INTO browser_runs (
      id, job_id, application_url, status, package_id, variant_id, base_resume_id,
      ats_kind, ats_confidence, suggested_ats_kind, ats_confirmed,
      decisions_json, pauses_json, submitted_answers_json, confirmation_text,
      submission_approved_at, created_at, updated_at, application_profile
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.id, parsed.jobId, parsed.applicationUrl, parsed.status, parsed.packageId,
    parsed.variantId, parsed.baseResumeId, parsed.atsKind, parsed.atsConfidence, parsed.suggestedAtsKind,
    parsed.atsConfirmed ? 1 : 0,
    JSON.stringify(parsed.decisions), JSON.stringify(parsed.pauses),
    parsed.submittedAnswers ? JSON.stringify(parsed.submittedAnswers) : null,
    parsed.confirmationText, parsed.submissionApprovedAt, parsed.createdAt, parsed.updatedAt,
    parsed.applicationProfile ?? null
  );
  return parsed;
}

export function updateBrowserRun(
  database: DatabaseSync,
  runId: string,
  patch: {
    status?: BrowserRun["status"];
    decisions?: FillDecision[];
    pauses?: PauseRecord[];
    variantId?: string | null;
    baseResumeId?: string | null;
    atsKind?: BrowserRun["atsKind"];
    atsConfidence?: number;
    suggestedAtsKind?: BrowserRun["suggestedAtsKind"];
    atsConfirmed?: boolean;
    submittedAnswers?: Record<string, string> | null;
    confirmationText?: string | null;
    submissionApprovedAt?: string | null;
    applicationProfile?: ApplicationProfile | null;
  }
): BrowserRun {
  const current = getBrowserRun(database, runId);
  if (!current) throw new Error("The browser run is unknown.");
  const updated = browserRunSchema.parse({
    ...current,
    ...patch,
    decisions: patch.decisions ?? current.decisions,
    pauses: patch.pauses ?? current.pauses,
    id: current.id,
    updatedAt: new Date().toISOString()
  });
  database.prepare(`
    UPDATE browser_runs
    SET status = ?, decisions_json = ?, pauses_json = ?, variant_id = ?, base_resume_id = ?,
      ats_kind = ?, ats_confidence = ?, suggested_ats_kind = ?, ats_confirmed = ?,
      submitted_answers_json = ?, confirmation_text = ?, submission_approved_at = ?,
      application_profile = ?, updated_at = ?
    WHERE id = ?
  `).run(
    updated.status, JSON.stringify(updated.decisions), JSON.stringify(updated.pauses),
    updated.variantId, updated.baseResumeId, updated.atsKind, updated.atsConfidence, updated.suggestedAtsKind,
    updated.atsConfirmed ? 1 : 0,
    updated.submittedAnswers ? JSON.stringify(updated.submittedAnswers) : null,
    updated.confirmationText, updated.submissionApprovedAt, updated.applicationProfile ?? null,
    updated.updatedAt, updated.id
  );
  return updated;
}

export function getBrowserRun(database: DatabaseSync, runId: string): BrowserRun | null {
  const row = database.prepare("SELECT * FROM browser_runs WHERE id = ?").get(runId) as RunRow | undefined;
  return row ? parseRow(row) : null;
}

export function listBrowserRuns(database: DatabaseSync, jobId: string): BrowserRun[] {
  const rows = database.prepare(`
    SELECT * FROM browser_runs WHERE job_id = ? ORDER BY updated_at DESC
  `).all(jobId) as RunRow[];
  return rows.map(parseRow);
}

/** Ids of every run in this status, oldest update first. */
export function listBrowserRunIdsByStatus(database: DatabaseSync, status: BrowserRun["status"]): string[] {
  const rows = database.prepare(`
    SELECT id FROM browser_runs WHERE status = ? ORDER BY updated_at, id
  `).all(status) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** Run ids starting with this prefix (8 to 36 hex characters or dashes), newest first; at most three. */
export function findBrowserRunIds(database: DatabaseSync, prefix: string): string[] {
  if (!/^[0-9a-f-]{8,36}$/i.test(prefix)) return [];
  const rows = database.prepare(`
    SELECT id FROM browser_runs WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 3
  `).all(`${prefix.toLowerCase()}%`) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export type { BrowserRun, FillDecision, PauseRecord };
