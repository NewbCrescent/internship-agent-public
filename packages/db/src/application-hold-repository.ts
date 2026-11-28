import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { WorkspaceProfile } from "@internship-agent/domain";

import { setJobStatus } from "./application-repository";
import { getBrowserRun, listBrowserRuns, updateBrowserRun } from "./browser-run-repository";
import { resolveProfileDatabasePath } from "./database";
import { getJobStatus } from "./job-posting-repository";

export function openApplicationAuditDatabase(profile: WorkspaceProfile): DatabaseSync {
  return new DatabaseSync(resolveProfileDatabasePath(profile), { readOnly: true });
}

/** A separate SQLite file serializes deliveries without locking application data during the send. */
export function acquireApplicationHoldDeliveryLock(path: string): (() => void) | null {
  let lock: DatabaseSync | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    lock = new DatabaseSync(path, { timeout: 0 });
    lock.exec("BEGIN IMMEDIATE");
  } catch {
    lock?.close();
    return null;
  }
  return () => { lock.close(); };
}

export type HoldOwner = "manager" | "candidate";
export type HoldReason = "possible-submission" | "account-stop" | "automation-fault" | "form-review" | "candidate-question" | "manual-challenge" | "manual-field-correction" | "approval";
export type ReceiptResult = "confirmed" | "absent" | "ambiguous" | "truncated" | "unavailable";
export type HoldObservation = {
  jobId: string;
  runId: string | null;
  owner: HoldOwner;
  reason: HoldReason;
  identity: string;
  evidenceRef: string | null;
  sourceEventId: string | null;
};
export type ApplicationHold = HoldObservation & { key: string; revision: number; active: number; updatedAt: string };

export const applicationHoldKey = (jobId: string, runId: string | null): string => runId ? `run:${runId}` : `job:${jobId}`;

export function withApplicationHoldTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const HOLD_FIELDS = `hold_key AS key, job_id AS jobId, run_id AS runId, revision, owner, reason,
  identity, evidence_ref AS evidenceRef, source_event_id AS sourceEventId, active, updated_at AS updatedAt`;

export function getApplicationHold(database: DatabaseSync, jobId: string, runId: string | null): ApplicationHold | null {
  return (database.prepare(`SELECT ${HOLD_FIELDS} FROM application_holds WHERE hold_key = ?`)
    .get(applicationHoldKey(jobId, runId)) as ApplicationHold | undefined) ?? null;
}

export function listApplicationHolds(database: DatabaseSync): ApplicationHold[] {
  return database.prepare(`SELECT ${HOLD_FIELDS} FROM application_holds ORDER BY updated_at, hold_key`).all() as ApplicationHold[];
}

function appendEvent(database: DatabaseSync, hold: ApplicationHold, event: string, at: string, actionRef: string | null = null, receipt: ReceiptResult | null = null): void {
  database.prepare(`INSERT INTO application_hold_events
    (hold_key, revision, event, owner, reason, evidence_ref, source_event_id, action_ref, receipt_result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(hold.key, hold.revision, event, hold.owner, hold.reason, hold.evidenceRef, hold.sourceEventId, actionRef, receipt, at);
}

function resolveHold(database: DatabaseSync, current: ApplicationHold, at: string): void {
  const resolved = { ...current, revision: current.revision + 1, active: 0 };
  database.prepare("UPDATE application_holds SET revision = ?, active = 0, updated_at = ? WHERE hold_key = ?")
    .run(resolved.revision, at, current.key);
  appendEvent(database, resolved, "resolved", at);
}

export function reconcileApplicationHolds(
  database: DatabaseSync,
  read: () => { observations: HoldObservation[]; resolved: ReadonlySet<string> },
  at: string
): ApplicationHold[] {
  return withApplicationHoldTransaction(database, () => {
    const { observations, resolved } = read();
    const active: ApplicationHold[] = [];
    for (const observation of observations) {
      const previous = getApplicationHold(database, observation.jobId, observation.runId);
      const key = applicationHoldKey(observation.jobId, observation.runId);
      if (previous?.active && previous.identity === observation.identity
          && previous.owner === observation.owner && previous.reason === observation.reason) {
        active.push(previous);
        continue;
      }
      const hold = { ...observation, key, revision: (previous?.revision ?? 0) + 1, active: 1, updatedAt: at };
      database.prepare(`INSERT INTO application_holds
        (hold_key, job_id, run_id, revision, owner, reason, identity, evidence_ref, source_event_id, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hold_key) DO UPDATE SET revision = excluded.revision, owner = excluded.owner,
          reason = excluded.reason, identity = excluded.identity, evidence_ref = excluded.evidence_ref,
          source_event_id = excluded.source_event_id, active = 1, updated_at = excluded.updated_at`)
        .run(key, hold.jobId, hold.runId, hold.revision, hold.owner, hold.reason, hold.identity, hold.evidenceRef, hold.sourceEventId, hold.active, at);
      appendEvent(database, hold, previous ? previous.active ? "changed" : "reopened" : "opened", at);
      active.push(hold);
    }
    for (const hold of listApplicationHolds(database)) {
      if (hold.active && resolved.has(hold.key) && !active.some((entry) => entry.key === hold.key)) resolveHold(database, hold, at);
    }
    return active;
  });
}

export function applicationHoldTrace(database: DatabaseSync, jobId: string, runId?: string): Record<string, string | number | null>[] {
  return database.prepare(`SELECT h.job_id AS jobId, h.run_id AS runId, e.revision, e.event, e.owner, e.reason,
    e.evidence_ref AS evidenceRef, e.source_event_id AS sourceEventId, e.action_ref AS actionRef,
    e.receipt_result AS receiptResult, e.created_at AS at
    FROM application_hold_events e JOIN application_holds h ON h.hold_key = e.hold_key
    WHERE h.job_id = ? AND (? IS NULL OR h.run_id = ?) ORDER BY e.id`)
    .all(jobId, runId ?? null, runId ?? null) as Record<string, string | number | null>[];
}

export function applicationHoldDelivered(database: DatabaseSync, hold: Pick<ApplicationHold, "key" | "revision">, recipient: string): boolean {
  return !!database.prepare("SELECT 1 FROM application_hold_delivery WHERE hold_key = ? AND revision = ? AND recipient = ?")
    .get(hold.key, hold.revision, recipient);
}

export function acknowledgeApplicationHolds(database: DatabaseSync, holds: ReadonlyArray<Pick<ApplicationHold, "key" | "revision">>, recipient: string, at: string): void {
  withApplicationHoldTransaction(database, () => {
    const insert = database.prepare("INSERT OR IGNORE INTO application_hold_delivery VALUES (?, ?, ?, ?)");
    for (const hold of holds) insert.run(hold.key, hold.revision, recipient, at);
  });
}

export function applicationReceiptConfirmed(database: DatabaseSync, runId: string): boolean {
  return !!database.prepare("SELECT 1 FROM application_receipt_checks WHERE run_id = ? AND result = 'confirmed'").get(runId);
}

/** Track 85: the confirmation text of a run marked submitted on the employer's receipt email; the private proof key is not in it. */
export const RECEIPT_CONFIRMATION_TEXT = "Confirmed by the employer's application receipt email (receipt check).";

const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set(["NOT_QUALIFIED", "SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"]);
const VALUE_ACTIONS: ReadonlySet<string> = new Set(["fill", "choose", "check"]);

/**
 * Track 85: marks a run submitted, and its job SUBMITTED, on a trusted receipt. Called only inside a hold transaction.
 * It does nothing for a run that is submitting (the browser still owns it), already submitted, or cancelled, for a job
 * already SUBMITTED or past it, or when another run of the job is submitted or submitting.
 */
function submitOnReceipt(database: DatabaseSync, jobId: string, runId: string): boolean {
  const run = getBrowserRun(database, runId);
  if (!run || run.jobId !== jobId) return false;
  if (run.status === "submitted" || run.status === "submitting" || run.status === "cancelled") return false;
  const status = getJobStatus(database, jobId);
  if (!status || TERMINAL_JOB_STATUSES.has(status)) return false;
  if (listBrowserRuns(database, jobId).some((other) => other.id !== runId && (other.status === "submitted" || other.status === "submitting"))) return false;
  let submittedAnswers = run.submittedAnswers;
  if (run.submissionApprovedAt) {
    // The same answers a recognized confirmation records (browser-orchestrator.ts).
    const answers: Record<string, string> = {};
    for (const decision of run.decisions) {
      if (VALUE_ACTIONS.has(decision.action) && typeof decision.value === "string") answers[decision.fieldId] = decision.value;
    }
    submittedAnswers = answers;
  }
  updateBrowserRun(database, runId, { status: "submitted", confirmationText: RECEIPT_CONFIRMATION_TEXT, submittedAnswers });
  setJobStatus(database, jobId, status, "SUBMITTED", `Submitted with confirmation: ${RECEIPT_CONFIRMATION_TEXT}`);
  return true;
}

/**
 * Records a receipt check for a run. A trusted receipt ("confirmed") for a run held as a possible submission resolves
 * that hold and, since Track 85, marks the run submitted with RECEIPT_CONFIRMATION_TEXT and the job SUBMITTED, all in
 * one transaction (`submitOnReceipt` names the runs it skips). A stored confirmed check is never overwritten.
 */
export function recordApplicationReceipt(database: DatabaseSync, hold: Pick<ApplicationHold, "jobId" | "runId">, result: ReceiptResult, proofRef: string | null, attemptedAt: string, at: string): void {
  if (!hold.runId) return;
  const runId = hold.runId;
  withApplicationHoldTransaction(database, () => {
    const old = database.prepare("SELECT result, proof_ref, attempted_at FROM application_receipt_checks WHERE run_id = ?").get(runId);
    if (old?.result === "confirmed") return;
    const changed = old?.result !== result || old.proof_ref !== proofRef || old.attempted_at !== attemptedAt;
    database.prepare(`INSERT INTO application_receipt_checks VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id)
      DO UPDATE SET result = excluded.result, proof_ref = excluded.proof_ref,
        attempted_at = excluded.attempted_at, checked_at = excluded.checked_at`)
      .run(runId, result, proofRef, attemptedAt, at);
    if (!changed) return;
    const current = getApplicationHold(database, hold.jobId, runId);
    if (current) {
      appendEvent(database, current, "receipt-check", at, proofRef, result);
      if (result === "confirmed" && current.active && current.reason === "possible-submission") {
        submitOnReceipt(database, hold.jobId, runId);
        resolveHold(database, current, at);
      }
    }
  });
}

/**
 * Track 85: applies trusted receipts recorded before Track 85, or while their run was still submitting: each run with a
 * confirmed receipt check that is not submitted, submitting, or cancelled, on a job not yet SUBMITTED or past it, is
 * marked submitted (`submitOnReceipt`). It never touches a run without a confirmed receipt. Returns the runs it marked.
 */
export function promoteConfirmedReceiptRuns(database: DatabaseSync): Array<{ jobId: string; runId: string }> {
  if (!applicationHoldSchemaPresent(database)) return [];
  const rows = database.prepare(`
    SELECT r.job_id AS jobId, r.id AS runId FROM application_receipt_checks c
      JOIN browser_runs r ON r.id = c.run_id JOIN jobs j ON j.id = r.job_id
    WHERE c.result = 'confirmed' AND r.status NOT IN ('submitted', 'submitting', 'cancelled')
      AND j.status NOT IN ('NOT_QUALIFIED', 'SUBMITTED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN')
    ORDER BY c.checked_at, r.id
  `).all() as Array<{ jobId: string; runId: string }>;
  if (rows.length === 0) return [];
  return withApplicationHoldTransaction(database, () => rows.filter((row) => submitOnReceipt(database, row.jobId, row.runId)));
}

export function applicationHoldFixUsed(database: DatabaseSync, hold: ApplicationHold, fix: string): boolean {
  return !!database.prepare("SELECT 1 FROM application_hold_retries WHERE job_id = ? AND fix_ref = ? AND evidence_identity = ?")
    .get(hold.jobId, fix, hold.identity);
}

export function recordApplicationHoldRetry(database: DatabaseSync, hold: ApplicationHold, fix: string, at: string): void {
  database.prepare("INSERT INTO application_hold_retries VALUES (?, ?, ?)").run(hold.jobId, fix, hold.identity);
  appendEvent(database, hold, "verified-retry", at, fix);
  resolveHold(database, hold, at);
}

export function recordApplicationHoldReopen(database: DatabaseSync, jobId: string, runId: string, at: string): void {
  const hold = getApplicationHold(database, jobId, runId);
  if (!hold?.active || hold.reason !== "possible-submission") return;
  appendEvent(database, hold, "reopened-unsubmitted", at);
  resolveHold(database, hold, at);
}

export function listApplicationHoldJobs(database: DatabaseSync): Array<{ jobId: string }> {
  return database.prepare(`
    SELECT id AS jobId FROM jobs j WHERE status NOT IN ('NOT_QUALIFIED', 'SUBMITTED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN')
      AND (EXISTS (SELECT 1 FROM browser_runs r WHERE r.job_id = j.id)
        OR EXISTS (SELECT 1 FROM application_events e WHERE e.job_id = j.id AND
          (e.detail LIKE 'Automatic browser run %' OR e.detail LIKE 'Application hold: %')))
  `).all() as Array<{ jobId: string }>;
}

export function applicationHoldSchemaPresent(database: DatabaseSync): boolean {
  return !!database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'application_holds'").get();
}

export function applicationHoldDeliveries(database: DatabaseSync, jobId: string, runId?: string): Record<string, string | number | null>[] {
  return database.prepare(`SELECT h.run_id AS runId, d.revision, d.recipient, d.delivered_at AS at
    FROM application_hold_delivery d JOIN application_holds h ON h.hold_key = d.hold_key
    WHERE h.job_id = ? AND (? IS NULL OR h.run_id = ?) ORDER BY d.delivered_at`)
    .all(jobId, runId ?? null, runId ?? null) as Record<string, string | number | null>[];
}

export type ApplicationAuditRun = {
  id: string; job_id: string; company_name: string; title: string; status: string; ats_kind: string;
  application_url: string; pauses_json: string; decisions_json: string; confirmation_text: string | null;
  created_at: string; updated_at: string;
};

export function listApplicationAuditRuns(database: DatabaseSync): ApplicationAuditRun[] {
  return database.prepare(`
    SELECT r.id, r.job_id, j.company_name, j.title, r.status, r.ats_kind, r.application_url,
           r.pauses_json, r.decisions_json, r.confirmation_text, r.created_at, r.updated_at
    FROM browser_runs r JOIN jobs j ON r.job_id = j.id
    WHERE r.status != 'cancelled' ORDER BY r.created_at DESC
  `).all() as ApplicationAuditRun[];
}

export type ApplicationReceiptAttempt = {
  jobId: string; runId: string | null; companyName: string; title: string; atsKind: string | null;
  sourceUrl: string; applicationUrl: string | null; companyCareersUrl: string | null; attemptedAt: string;
  pending: number;
};

export function listApplicationReceiptAttempts(database: DatabaseSync): ApplicationReceiptAttempt[] {
  return database.prepare(`
    SELECT j.id AS jobId, r.id AS runId, j.company_name AS companyName, j.title, r.ats_kind AS atsKind,
      j.source_url AS sourceUrl, r.application_url AS applicationUrl, j.company_careers_url AS companyCareersUrl,
      COALESCE(r.submission_approved_at, r.updated_at) AS attemptedAt,
      CASE WHEN h.active = 1 AND h.reason = 'possible-submission' THEN 1 ELSE 0 END AS pending
    FROM browser_runs r JOIN jobs j ON j.id = r.job_id
    LEFT JOIN application_holds h ON h.run_id = r.id
    WHERE r.submission_approved_at IS NOT NULL OR r.status IN ('submitting', 'submitted')
      OR (h.active = 1 AND h.reason = 'possible-submission')
    UNION ALL
    SELECT j.id, NULL, j.company_name, j.title, NULL, j.source_url, j.external_application_url,
      j.company_careers_url, MIN(e.created_at), 0
    FROM application_events e JOIN jobs j ON j.id = e.job_id
    WHERE e.to_status = 'SUBMITTED' AND e.from_status IS NOT 'SUBMITTED'
      AND NOT EXISTS (SELECT 1 FROM browser_runs r WHERE r.job_id = j.id AND r.status = 'submitted')
    GROUP BY j.id
  `).all() as ApplicationReceiptAttempt[];
}

export function readApplicationReceiptCheck(database: DatabaseSync, runId: string): { result: ReceiptResult; attemptedAt: string; checkedAt: string } | null {
  return (database.prepare("SELECT result, attempted_at AS attemptedAt, checked_at AS checkedAt FROM application_receipt_checks WHERE run_id = ?")
    .get(runId) as { result: ReceiptResult; attemptedAt: string; checkedAt: string } | undefined) ?? null;
}

export function applicationHoldReceiptChecks(database: DatabaseSync, jobId: string, runId?: string): Record<string, string | number | null>[] {
  return database.prepare(`SELECT c.run_id AS runId, c.result, c.attempted_at AS attemptedAt, c.checked_at AS checkedAt
    FROM application_receipt_checks c JOIN browser_runs r ON r.id = c.run_id
    WHERE r.job_id = ? AND (? IS NULL OR c.run_id = ?) ORDER BY c.checked_at`)
    .all(jobId, runId ?? null, runId ?? null) as Record<string, string | number | null>[];
}
