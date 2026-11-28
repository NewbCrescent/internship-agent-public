import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  acquireApplicationHoldDeliveryLock, applicationHoldKey, applicationReceiptConfirmed, getCurrentPackage, getJobPosting, listApplicationEvents,
  listApplicationHolds, listApplicationHoldJobs, listBrowserRuns, logApplicationEvent, reconcileApplicationHolds,
  type ApplicationHold, type HoldObservation, type HoldReason
} from "@internship-agent/db";
import { atsKindNeedsApproval, isPossibleSubmissionNote, type BrowserRun } from "@internship-agent/domain";

import { readJobEvidence } from "./submit-evidence";

export function holdIdentity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type HoldPause = { label: string; status: "open" | "answered"; safeguard: boolean; upload: boolean; fieldId?: string };
export type ClassifiedPause<T> = { pause: T; index: number; kind: "fault" | "challenge" | "correction" | "question" };

export function classifyOpenPauses<T extends HoldPause>(pauses: ReadonlyArray<T>): ClassifiedPause<T>[] {
  return pauses.flatMap((pause, index) => {
    if (pause.status !== "open") return [];
    const label = pause.label.trim();
    const token = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i.test(label);
    const fault = !label || token || /^Unlabeled \S+ control \d+$/i.test(label)
      || /::workday-error(?:-|::)|^\(workday errors\)$/i.test(pause.fieldId ?? "")
      || /\(workday errors\)$|Workday did not answer/i.test(label) || pause.fieldId === "site-security-code";
    const correction = pause.safeguard && /^site-error-\d+$/.test(pause.fieldId ?? "");
    const kind = fault ? "fault" : correction ? "correction" : pause.safeguard ? "challenge" : "question";
    return [{ pause, index, kind }];
  });
}

type HoldRun = {
  status: string;
  atsConfirmed: boolean;
  suggestedAtsKind?: string | null;
  submissionApprovedAt?: string | null;
  pauses: ReadonlyArray<HoldPause>;
};

export function classifyRunHold(run: HoldRun): HoldReason | null {
  if (run.status === "failed") return "automation-fault";
  if (run.status !== "paused-needs-input" && run.status !== "awaiting-approval") return null;
  if (run.status === "awaiting-approval" && run.submissionApprovedAt) return "form-review";
  const open = classifyOpenPauses(run.pauses);
  if (open.some(({ pause }) => pause.fieldId === "site-security-code")) return "automation-fault";
  if (open.some(({ kind }) => kind === "challenge")) return "manual-challenge";
  if (open.some(({ kind }) => kind === "correction")) return "manual-field-correction";
  if (open.some(({ kind }) => kind === "question")) return "candidate-question";
  if (open.length || run.status === "paused-needs-input") return "automation-fault";
  return run.atsConfirmed || atsKindNeedsApproval(run.suggestedAtsKind) ? "approval" : "form-review";
}

export function candidateHold(reason: HoldReason): boolean {
  return reason === "candidate-question" || reason === "manual-challenge" || reason === "manual-field-correction" || reason === "approval";
}

const POST_SUBMIT = new Set(["field-errors", "refused", "challenged", "verification-code", "unknown"]);
const ACCOUNT_STOP = /^Automatic browser run waiting: (?:Workday|iCIMS) \S+:/i;
const AUTOMATION_STOP = /^Automatic browser run (?:failed|needs you|stopped):/i;
const TARGET_SKIP = /^Not pursued for your target: /;
const TERMINAL = new Set(["NOT_QUALIFIED", "SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"]);
const INTERNAL_FAILURE = /^Application hold: (analysis|preparation) failed\.$/;
/**
 * AUTOMATIC_RETRY_PREFIX (pipeline-orchestrator.ts; not imported, to avoid a cycle). A job-level verified
 * requeue (automatic-retry.ts) logs it without a status change, and it must outrank the stop it requeued.
 */
const RETRIED_AFTER_FIX = /^Automatic run retried after a fix: /;
const PIPELINE_ERROR = /^(Analysis|Preparation) failed for ([a-f0-9-]{36}):/i;

export function recordApplicationHoldFailures(database: DatabaseSync, errors: ReadonlyArray<string>): void {
  for (const error of errors) {
    const parts = PIPELINE_ERROR.exec(error);
    if (!parts) continue;
    const [, stage, jobId] = parts;
    const posting = getJobPosting(database, jobId!);
    if (!posting) continue;
    if (posting.status !== (stage!.toLowerCase() === "analysis" ? "DISCOVERED" : "QUALIFIED")) continue;
    const detail = `Application hold: ${stage!.toLowerCase()} failed.`;
    const source = listApplicationEvents(database, posting.id).at(-1);
    if (source?.detail === detail) continue;
    logApplicationEvent(database, { jobId: posting.id, fromStatus: posting.status, toStatus: posting.status, detail });
  }
}

type Evidence = ReturnType<typeof readJobEvidence>[number];

export function mayHaveSubmitted(run: BrowserRun, evidence: ReadonlyArray<Pick<Evidence, "outcome">>): boolean {
  return run.status === "submitting" || run.status === "submitted" || run.status === "failed" || !!run.submissionApprovedAt
    || !!run.confirmationText || evidence.some((item) => POST_SUBMIT.has(item.outcome));
}

function evidenceReference(evidence: Evidence | undefined): string | null {
  return evidence ? holdIdentity([evidence.jobId, evidence.runId, evidence.outcome, evidence.capturedAt]) : null;
}

export function isFieldRefusal(item: { outcome: string; invalidFields?: ReadonlyArray<unknown> }): boolean {
  return item.outcome === "field-errors" || (item.outcome === "refused" && Boolean(item.invalidFields && item.invalidFields.length > 0));
}

function explainsPriorSubmit(run: BrowserRun, evidence: Evidence[]): boolean {
  const pausedWithoutApproval = run.status === "paused-needs-input" && !run.submissionApprovedAt;
  if (!pausedWithoutApproval && run.status !== "awaiting-approval") return false;
  if (evidence.some((item) => POST_SUBMIT.has(item.outcome) && !isFieldRefusal(item) && item.outcome !== "verification-code")) {
    return false;
  }
  const current = evidence[0];
  if (current && isFieldRefusal(current)) {
    return !run.submissionApprovedAt || Date.parse(current.capturedAt) < Date.parse(run.submissionApprovedAt);
  }
  return pausedWithoutApproval && current?.outcome === "verification-code" && run.pauses.some((pause) =>
    pause.fieldId === "site-security-code" && pause.status === "open");
}

function receiptInvestigation(run: BrowserRun, evidence: Evidence[], previous: ApplicationHold | undefined): { evidenceRef: string | null } | null {
  const prior = previous?.active && previous.reason === "possible-submission" ? previous : undefined;
  if (prior?.evidenceRef && !evidence.some((item) => evidenceReference(item) === prior.evidenceRef)) {
    return { evidenceRef: prior.evidenceRef };
  }
  if (explainsPriorSubmit(run, evidence)) return null;
  const postSubmit = evidence.filter(({ outcome }) => POST_SUBMIT.has(outcome));
  if (run.status === "awaiting-approval" && run.submissionApprovedAt && postSubmit.length === 0 && !prior) return null;
  if (!prior && !mayHaveSubmitted(run, postSubmit)) return null;
  // Keep a conflicting capture as the uncertainty anchor even if a newer capture records a rejection.
  const conflict = postSubmit.find((item) => !isFieldRefusal(item) && item.outcome !== "verification-code");
  return { evidenceRef: evidenceReference(conflict ?? postSubmit[0]) ?? prior?.evidenceRef ?? null };
}

export function observeApplicationHolds(database: DatabaseSync, dataDir: string) {
  const previous = listApplicationHolds(database);
  const byJob = new Map<string, ApplicationHold[]>();
  for (const hold of previous) byJob.set(hold.jobId, [...(byJob.get(hold.jobId) ?? []), hold]);
  const jobs = new Set([
    ...listApplicationHoldJobs(database).map(({ jobId }) => jobId),
    ...byJob.keys()
  ]);
  const observations: HoldObservation[] = [];
  const resolved = new Set<string>();

  for (const jobId of jobs) {
    const posting = getJobPosting(database, jobId);
    if (!posting) continue;
    const runs = listBrowserRuns(database, jobId);
    const timeline = listApplicationEvents(database, jobId);
    const source = timeline.slice().reverse().find((event) =>
      event.fromStatus !== event.toStatus || event.detail?.startsWith("Automatic browser run ")
        || TARGET_SKIP.test(event.detail ?? "") || INTERNAL_FAILURE.test(event.detail ?? "") || RETRIED_AFTER_FIX.test(event.detail ?? "")
    );
    const prior = byJob.get(jobId) ?? [];
    if (TERMINAL.has(posting.status)) {
      for (const hold of prior) resolved.add(hold.key);
      continue;
    }
    const evidence = readJobEvidence(dataDir, jobId);
    const liveRuns = runs.filter((run) => run.status !== "cancelled");
    const possible = liveRuns.flatMap((run) => {
      if (run.status === "submitted" || run.confirmationText || applicationReceiptConfirmed(database, run.id)) return [];
      const receipt = receiptInvestigation(run, evidence.filter((item) => item.runId === run.id), prior.find((hold) => hold.runId === run.id));
      return receipt ? [{ run, ...receipt }] : [];
    });
    if (possible.length > 0) {
      for (const { run, evidenceRef } of possible) {
        observations.push({ jobId, runId: run.id, owner: "manager", reason: "possible-submission",
          identity: holdIdentity(["possible-submission", evidenceRef]), evidenceRef, sourceEventId: source?.id ?? null });
      }
      for (const hold of prior) if (!possible.some(({ run }) => run.id === hold.runId)) resolved.add(hold.key);
      continue;
    }

    const latest = runs[0]?.status === "cancelled" ? undefined : runs[0];
    const targetSkipped = TARGET_SKIP.test(source?.detail ?? "");
    for (const hold of prior) {
      if (targetSkipped || (latest ? hold.runId !== latest.id : hold.runId !== null)) resolved.add(hold.key);
    }
    if (targetSkipped) continue;
    if (latest && (latest.status === "submitted" || latest.confirmationText || applicationReceiptConfirmed(database, latest.id))) {
      resolved.add(applicationHoldKey(jobId, latest.id));
      continue;
    }

    const pipelineFault = INTERNAL_FAILURE.exec(source?.detail ?? "")?.[1];
    if (pipelineFault && posting.status === (pipelineFault === "analysis" ? "DISCOVERED" : "QUALIFIED")) {
      for (const hold of prior) if (hold.runId) resolved.add(hold.key);
      observations.push({ jobId, runId: null, owner: "manager", reason: "automation-fault",
        identity: holdIdentity(pipelineFault), evidenceRef: null, sourceEventId: source?.id ?? null });
      continue;
    }
    if (latest && posting.status === "APPLYING") {
      const reason = classifyRunHold(latest);
      if (reason) {
        const old = prior.find((hold) => hold.runId === latest.id);
        const evidenceRef = evidenceReference(evidence.find((item) => item.runId === latest.id)) ?? old?.evidenceRef ?? null;
        const pauses = classifyOpenPauses(latest.pauses)
          .filter(({ kind }) => candidateHold(reason) ? kind !== "fault" : kind === "fault")
          .map(({ index, pause, kind }) => [index, pause.fieldId, pause.label, pause.question, pause.upload, kind]);
        observations.push({ jobId, runId: latest.id, owner: candidateHold(reason) ? "candidate" : "manager", reason,
          identity: holdIdentity([reason, evidenceRef, pauses]), evidenceRef, sourceEventId: source?.id ?? null });
      } else resolved.add(applicationHoldKey(jobId, latest.id));
    } else if (!latest && posting.status === "READY_FOR_REVIEW") {
      const reason = ACCOUNT_STOP.test(source?.detail ?? "") ? "account-stop" : AUTOMATION_STOP.test(source?.detail ?? "") ? "automation-fault" : null;
      const verification = getCurrentPackage(database, jobId)?.verification;
      if (reason && verification && !verification.blocked) {
        const evidenceRef = evidenceReference(evidence.find((item) => item.runId === null)) ?? prior.find((hold) => !hold.runId)?.evidenceRef ?? null;
        observations.push({ jobId, runId: null, owner: "manager", reason, identity: holdIdentity([reason, evidenceRef]),
          evidenceRef, sourceEventId: source?.id ?? null });
      } else if (source || verification?.blocked) resolved.add(applicationHoldKey(jobId, null));
    } else if (latest) resolved.add(applicationHoldKey(jobId, latest.id));
    else if (source) resolved.add(applicationHoldKey(jobId, null));
  }
  return { observations, resolved };
}

/**
 * Track 85: whether a run is a policy submit held as a possible submission until a receipt check: failed, approved,
 * unconfirmed, with its note (isPossibleSubmissionNote) logged at or after its approval.
 */
export function awaitsReceipt(database: DatabaseSync, run: Pick<BrowserRun, "jobId" | "status" | "submissionApprovedAt" | "confirmationText">): boolean {
  const approvedAt = run.submissionApprovedAt;
  if (run.status !== "failed" || !approvedAt || run.confirmationText) return false;
  return listApplicationEvents(database, run.jobId).some((event) => isPossibleSubmissionNote(event.detail) && event.createdAt >= approvedAt);
}

export function refreshApplicationHolds(database: DatabaseSync, dataDir: string, now = new Date()): ApplicationHold[] {
  return reconcileApplicationHolds(database, () => observeApplicationHolds(database, dataDir), now.toISOString());
}

export function acquireHoldDeliveryGuard(dataDir: string, recipient: string): (() => void) | null {
  return acquireApplicationHoldDeliveryLock(join(dataDir, ".hold-delivery", `${holdIdentity(recipient)}.sqlite`));
}

export const candidateDeliveryRecipient = (userId: string): string => `candidate:${holdIdentity(userId)}`;
