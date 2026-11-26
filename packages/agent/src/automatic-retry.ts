import type { DatabaseSync } from "node:sqlite";

import {
  applicationHoldFixUsed,
  applicationReceiptConfirmed,
  closeProfileDatabase,
  findBrowserRunIds,
  findJobIds,
  getApplicationHold,
  getBrowserRun,
  getJobPosting,
  getProfileDatabase,
  listApplicationEvents,
  listBrowserRuns,
  listJobSummaries,
  listOutcomeEvents,
  logApplicationEvent,
  readApplicationReceiptCheck,
  recordApplicationHoldReopen,
  recordApplicationHoldRetry,
  resolveProfileDataDirectory,
  saveDiscoverySkip,
  setJobStatus,
  updateBrowserRun,
  withApplicationHoldTransaction,
  type ApplicationHold
} from "@internship-agent/db";
import { isGreenhouseBoardUrl, SECURITY_CODE_FIELD_ID } from "@internship-agent/browser";
import {
  AUTO_SUBMIT_EVENT,
  manualOnly,
  mentionsCompany,
  QUICK_SKIP_REASONS,
  runStartedByPipeline,
  workspaceProfileSchema,
  type BrowserRun,
  type BrowserRunStatus,
  type JobPosting,
  type WorkspaceProfile
} from "@internship-agent/domain";

import { mayHaveSubmitted, observeApplicationHolds } from "./application-holds";
import { cancelBrowserRun } from "./browser-orchestrator";
import { greenhouseMailSender } from "./greenhouse-security-code";
import { acquirePipelineLock } from "./pipeline-lock";
import { AUTOMATIC_RETRY_PREFIX, pipelineSettings, REOPENED_UNSUBMITTED_PREFIX } from "./pipeline-orchestrator";
import { readJobEvidence, readSubmitEvidence, type StoredSubmitEvidence } from "./submit-evidence";
import { judgeSubmitCapture, showsClosedPosting, type CaptureVerdict, type NeverTakenKind } from "./unsubmitted-evidence";
import { resolveWorkdayAccounts, workdayAccountSettings } from "./workday-account-service";
import { putWorkdayAccount, readWorkdayAccounts, WorkdayAccountsFileError, type WorkdayAccountEntry } from "./workday-account-store";

/**
 * Retrying an automatic run that a since-fixed bug held: the run is
 * cancelled and its job goes back to READY_FOR_REVIEW, so the next pipeline
 * pass starts a fresh automatic run under the current code, with the company
 * cap, profile lock, target, and fit rules applied as usual. Only runs the
 * pipeline started qualify, and never one the candidate already touched
 * (an answered pause or a submit approval) or one that may have reached the
 * site. `pnpm pipeline:retry` drives it. Deterministic: no model, no network.
 *
 * `--reopen-unsubmitted` is the one exception for a failed submit: it reopens
 * a run whose submit was clicked only with positive evidence that the site
 * did not complete it (Greenhouse's security-code email after the click, a
 * verification-code evidence capture, or post-submit evidence that shows the
 * site never took the click: Ashby's busy notice, Dover's Turnstile, or an
 * older capture of the intact form judged by unsubmitted-evidence.ts), never
 * one with a confirmation, and only after a fresh absent receipt check.
 * It also reopens a run held on Greenhouse's emailed security code (paused,
 * the approval withdrawn, that safeguard its only open pause, and only
 * verification-code evidence on a Greenhouse board since the timeline's
 * newest approval): Greenhouse completes nothing until the code is entered,
 * so that shape is the proof and no receipt check is needed.
 *
 * Two more explicit modes never retry anything. `--close-unsubmitted` closes
 * a failed submit that was never clicked ("No submit control was found") on
 * a posting its evidence shows closed: the run is cancelled and the job is
 * skipped as "Posting closed". `--correct-submitted` (with `--confirm`)
 * corrects a SUBMITTED record that rests only on the closed-dialog relabel
 * ("Modal dialog closed after submit without errors") when the evidence shows
 * the site never took it: the run becomes a failed, unconfirmed submit held
 * as a possible submission; no row or event is deleted.
 *
 * `--held` also releases Workday account holds the account step left as
 * "unexpected" (it stopped on a page it did not recognize, or Workday did not
 * answer). No run was saved for those: the account step runs before the
 * walk, so the host's hold in the accounts file is what keeps the pipeline
 * away. Released, the next pass signs in with the saved password (or tries
 * the account step again). Other hold kinds (CAPTCHA, refused or wrong
 * passwords, lockouts, interrupted creations) are never released here.
 */

/** Statuses a retry may cancel. "failed" is set only by a failed submit, which always carries an approval, so it is refused below. */
const RETRYABLE: ReadonlySet<BrowserRunStatus> = new Set(["paused-needs-input", "awaiting-approval", "failed"]);
/** What `--held` looks at: runs waiting on the candidate. */
const HELD: ReadonlySet<BrowserRunStatus> = new Set(["paused-needs-input", "awaiting-approval"]);

export class AutomaticRetryRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AutomaticRetryRefused";
  }
}

/** Why a run may not be retried, or null when it may. */
export function automaticRetryBlocker(database: DatabaseSync, run: BrowserRun): string | null {
  if (!RETRYABLE.has(run.status)) return `it is ${run.status}; only held (paused or awaiting approval) or failed runs are retried.`;
  if (run.submissionApprovedAt) return "its submission was approved, so it may have reached the site.";
  if (run.pauses.some((pause) => pause.status === "answered")) {
    return "you already answered one of its questions; continue it with pnpm run:answer instead.";
  }
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "APPLYING") return `its application is ${posting.status.toLocaleLowerCase("en-US").replace(/_/g, " ")}, not applying.`;
  const applying = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  if (!runStartedByPipeline(run.createdAt, applying)) return "you started it yourself; only runs the pipeline started are retried.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status === "submitted" || other.status === "submitting")) return "the application already has a submitted run.";
  // The next pass starts a run only when every other run is cancelled; a failed one may have reached the site.
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open or failed.";
  return null;
}

/**
 * Cancels an eligible automatic run, moves its job from APPLYING back to
 * READY_FOR_REVIEW, and logs "Automatic run retried after a fix: <reason>".
 * Throws AutomaticRetryRefused (with the reason) for any other run.
 */
export function retryAutomaticRun(database: DatabaseSync, runId: string, options: { reason: string }): BrowserRun {
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A retry needs a reason.");
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  const blocker = automaticRetryBlocker(database, run);
  if (blocker) throw new AutomaticRetryRefused(blocker);
  const cancelled = cancelBrowserRun(run.id, database);
  setJobStatus(database, run.jobId, "APPLYING", "READY_FOR_REVIEW", (AUTOMATIC_RETRY_PREFIX + reason).slice(0, 1_000));
  return cancelled;
}

/** Why a failed submit is known not to have completed on the site (shown in output and the event). */
export type UnsubmittedEvidence = {
  kind: "security-code-email" | "verification-code-evidence" | "security-code-hold" | NeverTakenKind; text: string;
};

const SECURITY_CODE_EMAIL_TEXT = "Greenhouse emailed a security code after the submit click";
const VERIFICATION_EVIDENCE_TEXT = "its post-submit evidence shows the site's emailed security-code step";
const SECURITY_CODE_HOLD_TEXT = "it is held on Greenhouse's emailed security code, which was never entered, and its post-submit evidence shows that step";
/** The timeline note of a submit approval: the auto-submit policy's (AUTO_SUBMIT_EVENT) or any other "Submission approved…" note. */
const APPROVAL_EVENT_PREFIX = "Submission approved";
/** The Gmail watcher's timeline note (mailEventDetail): `Email received: <label> from <domain>: "<subject>"`. */
const MAIL_EVENT = /^Email received: [^"]*? from ([a-z0-9.-]+): "([^"]*)"/i;
/** Mail this long after the approval no longer counts as this submit's. */
const MAIL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_CHECK_FRESH_MS = 15 * 60 * 1_000;

/** Positive evidence, after the submit approval (the click follows it), that the site did not complete the run; null when none. */
export function unsubmittedEvidence(database: DatabaseSync, dataDir: string, run: BrowserRun): UnsubmittedEvidence | null {
  if (!run.submissionApprovedAt) return null;
  const approvedAt = Date.parse(run.submissionApprovedAt);
  if (Number.isNaN(approvedAt)) return null;
  const posting = getJobPosting(database, run.jobId);
  if (posting) {
    const emailed = listApplicationEvents(database, run.jobId).some((event) => {
      const at = Date.parse(event.createdAt);
      if (!(at > approvedAt && at <= approvedAt + MAIL_WINDOW_MS)) return false;
      const match = MAIL_EVENT.exec(event.detail ?? "");
      if (!match) return false;
      const [, domain, subject] = match;
      return greenhouseMailSender(`x@${domain!}`)
        && /security code for your application to /i.test(subject!)
        && mentionsCompany(subject!, posting.companyName);
    });
    if (emailed) return { kind: "security-code-email", text: SECURITY_CODE_EMAIL_TEXT };
  }
  const captured = readSubmitEvidence(dataDir, run).some((entry) => entry.outcome === "verification-code" && Date.parse(entry.capturedAt) >= approvedAt);
  if (captured) return { kind: "verification-code-evidence", text: VERIFICATION_EVIDENCE_TEXT };
  // Every capture after the approval must show the site never took the click: an older confirmation or error vetoes a newer clean one.
  const captures = capturesAfterApproval(dataDir, run);
  if (captures.length === 0) return null;
  const verdicts = captures.map(({ verdict }) => verdict);
  const newest = verdicts[0]!;
  if (!verdicts.every((verdict) => "kind" in verdict) || !("kind" in newest)) return null;
  return { kind: newest.kind, text: newest.text };
}

type JudgedCapture = { entry: StoredSubmitEvidence & { dir: string }; verdict: CaptureVerdict };

/** The run's stored captures saved at or after its submit approval, newest first, each judged by judgeSubmitCapture. */
function capturesAfterApproval(dataDir: string, run: BrowserRun): JudgedCapture[] {
  const approvedAt = Date.parse(run.submissionApprovedAt ?? "");
  if (Number.isNaN(approvedAt)) return [];
  return readSubmitEvidence(dataDir, run)
    .filter((entry) => Date.parse(entry.capturedAt) >= approvedAt)
    .map((entry) => ({ entry, verdict: judgeSubmitCapture(run, entry) }));
}

/** Why unsubmittedEvidence found nothing, naming the missing signal (meaningful only when it returned null). */
export function unsubmittedEvidenceRefusal(_database: DatabaseSync, dataDir: string, run: BrowserRun): string {
  if (!run.submissionApprovedAt || Number.isNaN(Date.parse(run.submissionApprovedAt))) return "its submit was never approved";
  const captures = capturesAfterApproval(dataDir, run);
  if (captures.length === 0) return "no security-code email after the submit click and no post-submit evidence saved after it";
  // Newest first, so this is the newest capture that fails.
  const failing = captures.find(({ verdict }) => "refusal" in verdict) ?? captures[0]!;
  const refusal = "refusal" in failing.verdict ? failing.verdict.refusal : "does not show that the site never took the submit";
  return `no security-code email after the submit click, and its post-submit evidence of ${failing.entry.capturedAt} ${refusal}`;
}

/**
 * The time of the run's newest submit approval on the timeline (an event
 * starting with AUTO_SUBMIT_EVENT or "Submission approved", logged since the
 * run began), or null when none is logged. Used once the approval itself was
 * withdrawn, as it is for a run held on the emailed security code.
 */
function approvalEventAt(database: DatabaseSync, run: BrowserRun): number | null {
  const createdAt = Date.parse(run.createdAt);
  const times = listApplicationEvents(database, run.jobId)
    .filter((event) => (event.detail ?? "").startsWith(AUTO_SUBMIT_EVENT) || (event.detail ?? "").startsWith(APPROVAL_EVENT_PREFIX))
    .map((event) => Date.parse(event.createdAt))
    .filter((at) => !Number.isNaN(at) && at >= createdAt);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * Why a paused run is not held only on Greenhouse's emailed security code
 * after a clicked submit, or null when it is: the approval withdrawn, the
 * `site-security-code` safeguard its only open pause, an approval on the
 * timeline, and every capture saved since that approval a verification-code
 * capture, the newest on a Greenhouse board. Greenhouse completes nothing
 * until the code is entered, so no receipt check is needed for this shape.
 */
function securityCodeHoldBlocker(database: DatabaseSync, dataDir: string, run: BrowserRun): string | null {
  const open = run.pauses.filter((pause) => pause.status === "open");
  if (!open.some((pause) => pause.fieldId === SECURITY_CODE_FIELD_ID && pause.safeguard)) {
    return "it is paused-needs-input; --reopen-unsubmitted reopens only a failed submit or a run held on Greenhouse's emailed security code.";
  }
  if (open.length > 1) return "it has open pauses besides Greenhouse's emailed security code, so it stays as it is.";
  if (run.submissionApprovedAt) return "its submit approval was not withdrawn, so it may have reached the site.";
  const approvedAt = approvalEventAt(database, run);
  if (approvedAt === null) return "no submit approval is logged for it, so nothing shows its submit was clicked.";
  const captures = readSubmitEvidence(dataDir, run).filter((entry) => Date.parse(entry.capturedAt) >= approvedAt);
  const since = new Date(approvedAt).toISOString();
  if (captures.length === 0) return `no post-submit evidence was saved after its approval of ${since}, so nothing shows Greenhouse's security-code step.`;
  // Newest first, so this is the newest capture that records anything else.
  const other = captures.find((entry) => entry.outcome !== "verification-code");
  if (other) return `its post-submit evidence of ${other.capturedAt} records ${other.outcome}, not Greenhouse's security-code step.`;
  if (!isGreenhouseBoardUrl(captures[0]!.url)) return "its post-submit evidence is not on a Greenhouse board, so it stays as it is.";
  return null;
}

/** The evidence a reopen names: the security-code hold for a paused run, else unsubmittedEvidence. */
function reopenEvidence(database: DatabaseSync, dataDir: string, run: BrowserRun): UnsubmittedEvidence | null {
  if (run.status === "paused-needs-input") {
    return securityCodeHoldBlocker(database, dataDir, run) === null ? { kind: "security-code-hold", text: SECURITY_CODE_HOLD_TEXT } : null;
  }
  return unsubmittedEvidence(database, dataDir, run);
}

/**
 * Why a run may not be reopened as not submitted, or null when it may: a
 * failed submit with positive noncompletion evidence and a fresh absent
 * receipt check, or a run held only on Greenhouse's emailed security code
 * (securityCodeHoldBlocker; no receipt check needed).
 */
export function reopenUnsubmittedBlocker(database: DatabaseSync, dataDir: string, run: BrowserRun): string | null {
  const held = run.status === "paused-needs-input";
  if (run.status !== "failed" && !held) {
    return `it is ${run.status}; --reopen-unsubmitted reopens only a failed submit or a run held on Greenhouse's emailed security code.`;
  }
  if (held) {
    const blocker = securityCodeHoldBlocker(database, dataDir, run);
    if (blocker) return blocker;
  } else if (!run.submissionApprovedAt) {
    return "its submission was never approved, so its submit was never clicked; retry it without --reopen-unsubmitted.";
  }
  if (run.confirmationText && run.confirmationText.trim()) return "a confirmation was recognized, so it stays as it is.";
  if (applicationReceiptConfirmed(database, run.id)) return "a trusted application receipt was found, so it stays as it is.";
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "APPLYING") return `its application is ${posting.status.toLocaleLowerCase("en-US").replace(/_/g, " ")}, not applying.`;
  const applying = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  if (!runStartedByPipeline(run.createdAt, applying)) return "you started it yourself; only runs the pipeline started are reopened.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status === "submitted" || other.status === "submitting")) return "the application already has a submitted run.";
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open or failed.";
  // The security-code hold is its own proof: Greenhouse's unfinished code step.
  if (held) return null;
  // Checked above for a failed run; repeated so the type narrows.
  if (!run.submissionApprovedAt) return "its submission was never approved, so its submit was never clicked; retry it without --reopen-unsubmitted.";
  if (unsubmittedEvidence(database, dataDir, run) === null) {
    return `there is no evidence the site did not complete it (${unsubmittedEvidenceRefusal(database, dataDir, run)}); check the application on the site.`;
  }
  const check = readApplicationReceiptCheck(database, run.id);
  const latestEvidence = readSubmitEvidence(dataDir, run)[0]?.capturedAt;
  const latestAttempt = Math.max(Date.parse(run.submissionApprovedAt), latestEvidence ? Date.parse(latestEvidence) : 0);
  const checkedAt = check ? Date.parse(check.checkedAt) : Number.NaN;
  const age = Date.now() - checkedAt;
  if (check?.result !== "absent" || Date.parse(check.attemptedAt) !== Date.parse(run.submissionApprovedAt)
    || !(checkedAt >= latestAttempt && age >= 0 && age <= RECEIPT_CHECK_FRESH_MS)) {
    return `a completed receipt check for this attempt is required (pnpm mail:scan --receipt ${run.id.slice(0, 8)}).`;
  }
  return null;
}

/**
 * Cancels a failed submit the site is known not to have completed (or a run
 * held on Greenhouse's emailed security code), moves its
 * job from APPLYING back to READY_FOR_REVIEW, and logs "Automatic run retried
 * after a fix: reopened as not submitted (<evidence>): <reason>". The
 * AUTOMATIC_RETRY_PREFIX keeps the pipeline's retry semantics (stops before
 * it no longer block). Throws AutomaticRetryRefused (with the reason) otherwise.
 */
export function reopenUnsubmittedRun(
  database: DatabaseSync,
  dataDir: string,
  runId: string,
  options: { reason: string }
): { run: BrowserRun; evidence: UnsubmittedEvidence } {
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A reopen needs a reason.");
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new Error("The browser run is unknown.");
    const blocker = reopenUnsubmittedBlocker(database, dataDir, run);
    if (blocker) throw new AutomaticRetryRefused(blocker);
    const evidence = reopenEvidence(database, dataDir, run)!;
    const cancelled = cancelBrowserRun(run.id, database);
    setJobStatus(database, run.jobId, "APPLYING", "READY_FOR_REVIEW",
      (REOPENED_UNSUBMITTED_PREFIX + `${evidence.text}): ${reason}`).slice(0, 1_000));
    recordApplicationHoldReopen(database, run.jobId, run.id, new Date().toISOString());
    return { run: cancelled, evidence };
  });
}

/** The pipeline's timeline note when the auto-submit found no submit control (handshake-executor.ts throws before any click). */
export const NEVER_CLICKED_EVENT = "Automatic submission failed: No submit control was found.";
export const CLOSED_UNSUBMITTED_PREFIX = "Closed as never submitted (";
const CLOSED_EVIDENCE_TEXT = "the submit was never clicked: no submit control was found, and its post-submit evidence shows the posting closed";

function statusWords(status: string): string {
  return status.toLocaleLowerCase("en-US").replace(/_/g, " ");
}

function startedByPipeline(database: DatabaseSync, run: BrowserRun): boolean {
  const applying = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  return runStartedByPipeline(run.createdAt, applying);
}

/** Why a failed submit may not be closed as never submitted on a closed posting, or null when it may. */
export function closeUnsubmittedBlocker(database: DatabaseSync, dataDir: string, run: BrowserRun): string | null {
  if (run.status !== "failed") return `it is ${run.status}; --close-unsubmitted closes only a failed submit.`;
  if (!run.submissionApprovedAt) return "its submission was never approved; retry it without --close-unsubmitted.";
  if (run.confirmationText && run.confirmationText.trim()) return "a confirmation was recognized, so it stays as it is.";
  if (applicationReceiptConfirmed(database, run.id)) return "a trusted application receipt was found, so it stays as it is.";
  const check = readApplicationReceiptCheck(database, run.id);
  if (check && check.result !== "absent") return `its receipt check is ${check.result}; check the application on the site.`;
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "APPLYING") return `its application is ${statusWords(posting.status)}, not applying.`;
  if (!startedByPipeline(database, run)) return "you started it yourself; only runs the pipeline started are closed.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status === "submitted" || other.status === "submitting")) return "the application already has a submitted run.";
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open or failed.";
  const approvedAt = Date.parse(run.submissionApprovedAt);
  const neverClicked = listApplicationEvents(database, run.jobId)
    .some((event) => event.detail === NEVER_CLICKED_EVENT && Date.parse(event.createdAt) >= approvedAt);
  if (!neverClicked) {
    return "there is no record that its submit was never clicked (\"No submit control was found\" after its approval); --close-unsubmitted closes only a submit that was never clicked.";
  }
  const captures = readSubmitEvidence(dataDir, run).filter((entry) => Date.parse(entry.capturedAt) >= approvedAt);
  if (captures.length === 0) return "no post-submit evidence was saved after its approval, so nothing shows the posting closed.";
  const clicked = captures.find((entry) => entry.outcome !== "unknown");
  if (clicked) return `its post-submit evidence records ${clicked.outcome}, so the submit may have been clicked.`;
  if (!showsClosedPosting(captures[0]!)) {
    return "its post-submit evidence does not show the posting closed (\"The job you are looking for is no longer open\" or similar).";
  }
  return null;
}

/**
 * Cancels a failed submit that was never clicked on a posting its evidence
 * shows closed, moves the job from APPLYING to READY_FOR_REVIEW with the
 * candidate's "Posting closed" skip (so no pass starts it again and the
 * review queue hides it), logs "Closed as never submitted (<evidence>):
 * <reason>", and resolves its possible-submission hold. Never retries.
 * Throws AutomaticRetryRefused (with the reason) otherwise.
 */
export function closeUnsubmittedRun(
  database: DatabaseSync,
  dataDir: string,
  runId: string,
  options: { reason: string }
): { run: BrowserRun; text: string } {
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A close needs a reason.");
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new Error("The browser run is unknown.");
    const blocker = closeUnsubmittedBlocker(database, dataDir, run);
    if (blocker) throw new AutomaticRetryRefused(blocker);
    const cancelled = cancelBrowserRun(run.id, database);
    setJobStatus(database, run.jobId, "APPLYING", "READY_FOR_REVIEW",
      (CLOSED_UNSUBMITTED_PREFIX + `${CLOSED_EVIDENCE_TEXT}): ${reason}`).slice(0, 1_000));
    saveDiscoverySkip(database, { jobId: run.jobId, reason: QUICK_SKIP_REASONS.closed, preferenceNote: null });
    recordApplicationHoldReopen(database, run.jobId, run.id, new Date().toISOString());
    return { run: cancelled, text: CLOSED_EVIDENCE_TEXT };
  });
}

/** The confirmation the 2026-11-21 relabels wrote: a closed dialog, not a site confirmation. */
export const RELABEL_CONFIRMATION = /^Submitted with confirmation: Modal dialog closed after submit without errors\.?$/i;
const RELABEL_EVENT = /\bmodal dialog closed after submit without errors\b/i;
export const CORRECTED_SUBMITTED_PREFIX = "Submitted record corrected: not submitted (";
const MAIL_NOTE = /^Email received: /;

/** Why a SUBMITTED record may not be corrected as not submitted, or null when it may. */
export function correctSubmittedBlocker(database: DatabaseSync, dataDir: string, run: BrowserRun): string | null {
  if (run.status !== "submitted") return `it is ${run.status}; --correct-submitted corrects only a submitted record.`;
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "SUBMITTED") return `its application is ${statusWords(posting.status)}, not submitted.`;
  if (!RELABEL_CONFIRMATION.test((run.confirmationText ?? "").trim())) {
    return "its confirmation is not the closed-dialog relabel (\"Modal dialog closed after submit without errors\"), so it stays as it is.";
  }
  const events = listApplicationEvents(database, run.jobId);
  const toSubmitted = events.filter((event) => event.toStatus === "SUBMITTED" && event.fromStatus !== "SUBMITTED");
  if (toSubmitted.length !== 1 || !RELABEL_EVENT.test(toSubmitted[0]!.detail ?? "")) {
    return "its SUBMITTED status does not rest only on the closed-dialog relabel event, so it stays as it is.";
  }
  if (!run.submissionApprovedAt) return "its submission was never approved.";
  if (applicationReceiptConfirmed(database, run.id)) return "a trusted application receipt was found, so it stays as it is.";
  const check = readApplicationReceiptCheck(database, run.id);
  if (check && check.result !== "absent") return `its receipt check is ${check.result}; check the application on the site.`;
  if (listOutcomeEvents(database, run.jobId).length > 0) return "an employer outcome is recorded for it, so it stays submitted.";
  const approvedAt = Date.parse(run.submissionApprovedAt);
  if (events.some((event) => MAIL_NOTE.test(event.detail ?? "") && Date.parse(event.createdAt) > approvedAt)) {
    return "an email about it arrived after the submit, so it stays submitted; read it first.";
  }
  if (!startedByPipeline(database, run)) return "you started it yourself; only runs the pipeline started are corrected.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open, failed, or submitted.";
  if (unsubmittedEvidence(database, dataDir, run) === null) {
    return `there is no evidence the site did not take it (${unsubmittedEvidenceRefusal(database, dataDir, run)}).`;
  }
  return null;
}

/**
 * Corrects a SUBMITTED record that rests only on the closed-dialog relabel
 * when the evidence shows the site never took the submit: the run becomes a
 * failed, unconfirmed submit (approval, answers, and decisions kept), the job
 * moves from SUBMITTED back to APPLYING, and the timeline logs "Submitted
 * record corrected: not submitted (<evidence>); it was recorded as submitted
 * only from "<old confirmation>": <reason>". No row or event is deleted. The
 * next hold refresh holds it as a possible submission, so `pnpm mail:scan
 * --receipt` can check it before any `--reopen-unsubmitted`. Never retries.
 * Requires `confirm: true`; throws AutomaticRetryRefused otherwise.
 */
export function correctSubmittedRun(
  database: DatabaseSync,
  dataDir: string,
  runId: string,
  options: { reason: string; confirm: boolean }
): { run: BrowserRun; evidence: UnsubmittedEvidence } {
  if (options.confirm !== true) throw new AutomaticRetryRefused("a correction of a SUBMITTED record needs --confirm.");
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A correction needs a reason.");
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new Error("The browser run is unknown.");
    const blocker = correctSubmittedBlocker(database, dataDir, run);
    if (blocker) throw new AutomaticRetryRefused(blocker);
    const evidence = unsubmittedEvidence(database, dataDir, run)!;
    const old = run.confirmationText;
    // The confirmation must be cleared, or the hold logic and the reopen keep reading the run as submitted; the event quotes it.
    const updated = updateBrowserRun(database, run.id, { status: "failed", confirmationText: null });
    setJobStatus(database, run.jobId, "SUBMITTED", "APPLYING",
      (CORRECTED_SUBMITTED_PREFIX + `${evidence.text}); it was recorded as submitted only from "${old}": ${reason}`).slice(0, 1_000));
    return { run: updated, evidence };
  });
}

export type VerifiedHoldFix = { revision: number; recheck: string };

function verifiedHold(
  database: DatabaseSync, dataDir: string, run: BrowserRun, fix: VerifiedHoldFix
): ApplicationHold | string {
  const blocker = automaticRetryBlocker(database, run);
  if (blocker) return blocker;
  if (run.status === "awaiting-approval") return "the run is awaiting approval or review.";
  if (run.pauses.some((pause) => pause.safeguard)) return "the run has a safeguard that requires separate review.";
  if (mayHaveSubmitted(run, readSubmitEvidence(dataDir, run)) || applicationReceiptConfirmed(database, run.id)) {
    return "the run may already have submitted.";
  }
  const hold = getApplicationHold(database, run.jobId, run.id);
  if (!hold?.active || hold.owner !== "manager" || hold.reason !== "automation-fault") return "there is no active manager-owned pre-submit fault.";
  if (hold.revision !== fix.revision) return "the hold revision changed.";
  const current = observeApplicationHolds(database, dataDir).observations.find((item) => item.runId === run.id);
  if (!current || current.owner !== hold.owner || current.reason !== hold.reason || current.identity !== hold.identity) {
    return "the hold evidence or reason changed; refresh and review the trace.";
  }
  if (applicationHoldFixUsed(database, hold, fix.recheck)) return "that recheck was already used for this job and evidence.";
  return hold;
}

export function requeueVerifiedHold(
  database: DatabaseSync, dataDir: string, runId: string, fix: VerifiedHoldFix, reason: string, now = new Date()
): BrowserRun {
  if (!Number.isSafeInteger(fix.revision) || fix.revision < 1 || !/^[a-f0-9]{7,64}$/i.test(fix.recheck) || !reason.trim()) {
    throw new AutomaticRetryRefused("a revision, passing recheck reference, and reason are required.");
  }
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new AutomaticRetryRefused("the browser run is unknown.");
    const hold = verifiedHold(database, dataDir, run, fix);
    if (typeof hold === "string") throw new AutomaticRetryRefused(hold);
    const cancelled = retryAutomaticRun(database, runId, { reason });
    recordApplicationHoldRetry(database, hold, fix.recheck, now.toISOString());
    return cancelled;
  });
}

/** Evidence outcomes saved before any submit click (account steps, Workday entry or step errors, iCIMS stops, a dialog over the form while it filled, a Track 42 stop capture); any other outcome is post-submit. */
const PRE_SUBMIT_OUTCOMES: ReadonlySet<string> = new Set(["workday-account", "workday-errors", "workday-entry", "icims-account", "icims-application", "covering-dialog", "stop"]);
/** Timeline notes that show a submit was approved, attempted, reopened, or recorded for the job. */
const SUBMIT_ATTEMPT_NOTES = [AUTO_SUBMIT_EVENT, APPROVAL_EVENT_PREFIX, "Automatic submission failed: ", REOPENED_UNSUBMITTED_PREFIX];

/** Why the job's record shows a submit may have been attempted, or null when nothing does. */
function jobSubmitAttempt(database: DatabaseSync, dataDir: string, jobId: string): string | null {
  for (const run of listBrowserRuns(database, jobId)) {
    if (run.submissionApprovedAt || (run.confirmationText ?? "").trim() || run.status === "submitted" || run.status === "submitting") {
      return `its run ${run.id.slice(0, 8)} had a submit approval or confirmation, so a submit may have been attempted.`;
    }
    if (readApplicationReceiptCheck(database, run.id) || applicationReceiptConfirmed(database, run.id)) {
      return `its run ${run.id.slice(0, 8)} has a receipt check, so a submit may have been attempted.`;
    }
  }
  const events = listApplicationEvents(database, jobId);
  if (events.some((event) => event.toStatus === "SUBMITTED" || SUBMIT_ATTEMPT_NOTES.some((note) => (event.detail ?? "").startsWith(note)))) {
    return "its timeline records a submit approval, attempt, or submission, so a submit may have been attempted.";
  }
  const evidence = readJobEvidence(dataDir, jobId).find((entry) => !PRE_SUBMIT_OUTCOMES.has(entry.outcome));
  if (evidence) return `its evidence of ${evidence.capturedAt} records ${evidence.outcome} after a submit click, so a submit may have been attempted.`;
  if (listOutcomeEvents(database, jobId).length > 0) return "an employer outcome is recorded for it.";
  return null;
}

/**
 * The job-level hold a verified requeue may release (a manager-owned
 * automation fault on a job with no run that is not cancelled, the stop
 * logged before any run was saved), or why not: the job is ready for review,
 * no submit was ever attempted (no approval or submit note, no submit
 * approval, confirmation, or receipt check on any run, no post-submit
 * evidence, no employer outcome), the hold is at the given revision, the
 * current observation still matches it, and the recheck was not used for it.
 */
function verifiedJobHold(database: DatabaseSync, dataDir: string, jobId: string, fix: VerifiedHoldFix): ApplicationHold | string {
  const posting = getJobPosting(database, jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "READY_FOR_REVIEW") return `its application is ${statusWords(posting.status)}, not ready for review.`;
  const live = listBrowserRuns(database, jobId).find((run) => run.status !== "cancelled");
  if (live) return `it has a browser run that is not cancelled (${live.id.slice(0, 8)}, ${live.status}); use --run with --verified-hold instead.`;
  const attempted = jobSubmitAttempt(database, dataDir, jobId);
  if (attempted) return attempted;
  const hold = getApplicationHold(database, jobId, null);
  if (!hold?.active || hold.owner !== "manager" || hold.reason !== "automation-fault") return "there is no active manager-owned job-level automation fault.";
  if (hold.revision !== fix.revision) return "the hold revision changed.";
  const current = observeApplicationHolds(database, dataDir).observations.find((item) => item.jobId === jobId && item.runId === null);
  if (!current || current.owner !== hold.owner || current.reason !== hold.reason || current.identity !== hold.identity) {
    return "the hold evidence or reason changed; refresh and review the trace.";
  }
  if (applicationHoldFixUsed(database, hold, fix.recheck)) return "that recheck was already used for this job and evidence.";
  return hold;
}

/** Why a job-level verified requeue is refused, or null when it may run (verifiedJobHold). */
export function verifiedJobHoldBlocker(database: DatabaseSync, dataDir: string, jobId: string, fix: VerifiedHoldFix): string | null {
  const hold = verifiedJobHold(database, dataDir, jobId, fix);
  return typeof hold === "string" ? hold : null;
}

/**
 * Releases one verified job-level automation fault (no run was saved: the
 * stop came before one), in one transaction: logs "Automatic run retried
 * after a fix: <reason>" on the job (it stays READY_FOR_REVIEW; the note ends
 * the stop for the next pass and for the hold observation), records the
 * recheck reference, and resolves the hold. The next pass may then start the
 * job under its normal fit, cap, target, and approval checks. Throws
 * AutomaticRetryRefused (with the reason) otherwise.
 */
export function requeueVerifiedJobHold(
  database: DatabaseSync, dataDir: string, jobId: string, fix: VerifiedHoldFix, reason: string, now = new Date()
): ApplicationHold {
  const text = reason.replace(/\s+/g, " ").trim();
  if (!Number.isSafeInteger(fix.revision) || fix.revision < 1 || !/^[a-f0-9]{7,64}$/i.test(fix.recheck) || !text) {
    throw new AutomaticRetryRefused("a revision, passing recheck reference, and reason are required.");
  }
  return withApplicationHoldTransaction(database, () => {
    const hold = verifiedJobHold(database, dataDir, jobId, fix);
    if (typeof hold === "string") throw new AutomaticRetryRefused(hold);
    logApplicationEvent(database, { jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "READY_FOR_REVIEW", detail: (AUTOMATIC_RETRY_PREFIX + text).slice(0, 1_000) });
    recordApplicationHoldRetry(database, hold, fix.recheck, now.toISOString());
    return hold;
  });
}

/** Every held run (paused or awaiting approval) on an applying job, newest first per job. */
export function listHeldRuns(database: DatabaseSync): BrowserRun[] {
  return listJobSummaries(database)
    .filter((job) => job.status === "APPLYING")
    .flatMap((job) => listBrowserRuns(database, job.id).filter((run) => HELD.has(run.status)));
}

/** Workday account hosts held as "unexpected", which `--held` releases; sorted by host. Throws WorkdayAccountsFileError. */
export function releasableWorkdayHolds(file: string): WorkdayAccountEntry[] {
  return Object.values(readWorkdayAccounts(file))
    .filter((entry) => entry.hold?.kind === "unexpected")
    .sort((left, right) => left.host.localeCompare(right.host));
}

/**
 * Clears one host's "unexpected" hold, keeping its email, password, account
 * state, and creation time. Throws for any other hold kind (or none).
 */
export function releaseWorkdayAccountHold(file: string, host: string, now = new Date()): WorkdayAccountEntry {
  const entry = readWorkdayAccounts(file)[host];
  if (!entry || entry.hold?.kind !== "unexpected") throw new Error(`Workday ${host} has no hold the retry may release.`);
  const released: WorkdayAccountEntry = { ...entry, hold: null, updatedAt: now.toISOString() };
  putWorkdayAccount(file, released);
  return released;
}

// ---- pnpm pipeline:retry ----

export type RetryCommandDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  log(line: string): void;
  acquireLock(dataDir: string): () => void;
  /** One pipeline pass with no discovery, run while this command holds the lock (`--start`). */
  startPass(profile: WorkspaceProfile, log: (line: string) => void): Promise<unknown>;
  env: Record<string, string | undefined>;
};

const RETRY_USAGE = "Usage: pnpm pipeline:retry [--profile real|demo] (--run <id or 8-character prefix> ... | --held) [--dry-run] [--start] [--reason \"<text>\"] | --run <id or 8-character prefix> ... --reopen-unsubmitted --reason \"<text>\" [--dry-run] [--start] | (--run <ref> | --job <id or 8-character prefix>) --verified-hold --revision <n> --recheck <hex ref> --reason \"<text>\" [--dry-run] | --run <ref> ... --close-unsubmitted --reason \"<text>\" [--dry-run] | --run <ref> ... --correct-submitted --reason \"<text>\" (--dry-run | --confirm)";
const DEFAULT_REASON = "the bug that held it is fixed.";
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RetryArgs = {
  profile: WorkspaceProfile; runs: string[]; held: boolean; dryRun: boolean; start: boolean; reason: string; reopen: boolean;
  close: boolean; correct: boolean; confirm: boolean; verified: VerifiedHoldFix | null;
  /** `--job <ref>`: one job-level verified hold (only with --verified-hold). */
  job: string | null;
};

/** `--run` takes one or more references (repeated flags or several values), `--job` exactly one; null on anything unknown, missing, or contradictory. */
function parseRetryArgs(argv: string[]): RetryArgs | null {
  let profileText: string | undefined;
  let reason: string | undefined;
  const runs: string[] = [];
  let held = false;
  let dryRun = false;
  let start = false;
  let reopen = false;
  let close = false;
  let correct = false;
  let confirm = false;
  let verified = false;
  let revision: string | undefined;
  let recheck: string | undefined;
  let job: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--held" || arg === "--dry-run" || arg === "--start" || arg === "--reopen-unsubmitted" || arg === "--verified-hold"
      || arg === "--close-unsubmitted" || arg === "--correct-submitted" || arg === "--confirm") {
      if ((arg === "--held" && held) || (arg === "--dry-run" && dryRun) || (arg === "--start" && start)
        || (arg === "--reopen-unsubmitted" && reopen) || (arg === "--verified-hold" && verified)
        || (arg === "--close-unsubmitted" && close) || (arg === "--correct-submitted" && correct) || (arg === "--confirm" && confirm)) return null;
      if (arg === "--held") held = true;
      else if (arg === "--dry-run") dryRun = true;
      else if (arg === "--reopen-unsubmitted") reopen = true;
      else if (arg === "--verified-hold") verified = true;
      else if (arg === "--close-unsubmitted") close = true;
      else if (arg === "--correct-submitted") correct = true;
      else if (arg === "--confirm") confirm = true;
      else start = true;
    } else if (arg === "--run") {
      const before = runs.length;
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) {
        runs.push(argv[index + 1]!.trim());
        index += 1;
      }
      if (runs.length === before) return null;
    } else if (arg === "--revision" || arg === "--recheck" || arg === "--job") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--revision" && revision === undefined) revision = value;
      else if (arg === "--recheck" && recheck === undefined) recheck = value;
      else if (arg === "--job" && job === undefined) job = value.trim();
      else return null;
      index += 1;
    } else if (arg === "--profile" || arg === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || (arg === "--profile" ? profileText !== undefined : reason !== undefined)) return null;
      if (arg === "--profile") profileText = value;
      else reason = value;
      index += 1;
    } else {
      return null;
    }
  }
  const profile = workspaceProfileSchema.safeParse(profileText ?? "real");
  if (!profile.success) return null;
  // A job reference names one job-level verified hold: never with --run or --held, only with --verified-hold.
  if (job !== undefined && (job === "" || !verified || held || runs.length > 0)) return null;
  if (job === undefined && held === (runs.length > 0)) return null; // exactly one of --run / --held
  if (runs.some((ref) => ref === "")) return null;
  if (dryRun && start) return null; // a dry run writes nothing, so it cannot start a pass
  const trimmed = reason?.replace(/\s+/g, " ").trim();
  if (reason !== undefined && !trimmed) return null;
  // A reopen names its runs and says why; the default reason never applies.
  if (reopen && (held || reason === undefined)) return null;
  if (verified && (held || start || reopen || runs.length + (job === undefined ? 0 : 1) !== 1 || !trimmed || !revision || !recheck
    || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !/^[a-f0-9]{7,64}$/i.test(recheck))) return null;
  if (!verified && (revision !== undefined || recheck !== undefined)) return null;
  // One explicit mode at a time; a close or a correction names its runs, says why, and starts no pass.
  if ([reopen, close, correct, verified].filter(Boolean).length > 1) return null;
  if ((close || correct) && (held || start || reason === undefined)) return null;
  if (confirm && !correct) return null;
  return { profile: profile.data, runs, held, dryRun, start, reason: trimmed ?? DEFAULT_REASON, reopen, close, correct, confirm,
    verified: verified ? { revision: Number(revision), recheck: recheck!.toLowerCase() } : null, job: job ?? null };

}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeRun(database: DatabaseSync, run: BrowserRun): string {
  const posting = getJobPosting(database, run.jobId);
  const name = posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
  return `${run.id.slice(0, 8)} ${name} (${run.status})`;
}

/** The job a typed reference (full id or 8+ character prefix) names, or why none is chosen. */
function resolveJobRef(database: DatabaseSync, typed: string): JobPosting | string {
  const shown = clip(typed, 40);
  if (FULL_ID.test(typed)) return getJobPosting(database, typed.toLowerCase()) ?? `no job matches "${shown}".`;
  const ids = findJobIds(database, typed);
  if (ids.length === 0) return `no job matches "${shown}".`;
  if (ids.length > 1) return `several jobs match "${shown}"; give more characters.`;
  return getJobPosting(database, ids[0]!) ?? `no job matches "${shown}".`;
}

function describeJob(posting: JobPosting): string {
  return `job ${posting.id.slice(0, 8)} ${clip(posting.companyName, 120)} — ${clip(posting.title, 120)} (${statusWords(posting.status)})`;
}

/** `--job <ref> --verified-hold`: requeues (or, in a dry run, checks) one job-level verified hold; counts as one retry or skip. */
function requeueJobTarget(io: RetryCommandDeps, database: DatabaseSync, args: RetryArgs & { job: string; verified: VerifiedHoldFix }): { retried: number; failed: boolean } {
  const posting = resolveJobRef(database, args.job);
  if (typeof posting === "string") {
    io.log(`skipped ${clip(args.job, 40)} (${posting})`);
    return { retried: 0, failed: false };
  }
  const label = describeJob(posting);
  const dataDir = io.dataDir(args.profile);
  const blocker = verifiedJobHoldBlocker(database, dataDir, posting.id, args.verified);
  if (blocker) {
    io.log(`skipped ${label} (${blocker})`);
    return { retried: 0, failed: false };
  }
  if (args.dryRun) {
    io.log(`would requeue ${label} after verified pre-submit fix (its job-level hold; no run was saved).`);
    return { retried: 1, failed: false };
  }
  try {
    requeueVerifiedJobHold(database, dataDir, posting.id, args.verified, args.reason);
    io.log(`requeued ${label} after verified pre-submit fix: its job-level hold is released; the next pass may start it under the usual checks.`);
    return { retried: 1, failed: false };
  } catch (error) {
    io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
    return { retried: 0, failed: true };
  }
}

/** The run a typed reference names, or why none is chosen. */
function resolveRef(database: DatabaseSync, typed: string): BrowserRun | string {
  const shown = clip(typed, 40);
  if (FULL_ID.test(typed)) return getBrowserRun(database, typed.toLowerCase()) ?? `no browser run matches "${shown}".`;
  const ids = findBrowserRunIds(database, typed);
  if (ids.length === 0) return `no browser run matches "${shown}".`;
  if (ids.length > 1) return `several runs match "${shown}"; give more characters.`;
  return getBrowserRun(database, ids[0]!) ?? `no browser run matches "${shown}".`;
}

/**
 * `pnpm pipeline:retry`: retries the named runs (or every held one with
 * `--held`) under the workspace's pipeline lock and prints one line per run,
 * `retried` or `skipped (<reason>)`. `--dry-run` writes nothing and takes no
 * lock. `--start` then runs one pass with no discovery while still holding
 * the lock. `--reopen-unsubmitted --reason "<text>"` (with `--run` only)
 * reopens failed submits instead, each only with evidence the site did not
 * complete it, and runs held on Greenhouse's emailed security code
 * (reopenUnsubmittedBlocker), printing `reopened` or `skipped`.
 * `--close-unsubmitted --reason` closes never-clicked failed submits on
 * closed postings (closeUnsubmittedBlocker), printing `closed` or `skipped`.
 * `--correct-submitted --reason` corrects SUBMITTED records that rest only on
 * the closed-dialog relabel (correctSubmittedBlocker), printing `corrected`
 * or `skipped`; it refuses to write without `--confirm` (`--dry-run` checks).
 * With Workday account automation on, `--held` also releases the account
 * holds left as "unexpected" (releasableWorkdayHolds), one line per host.
 * `--run <ref> --verified-hold` requeues one run's manager-owned pre-submit
 * fault (requeueVerifiedHold); `--job <ref> --verified-hold` releases one
 * job-level automation fault for a job with no run that is not cancelled and
 * no submit ever attempted (requeueVerifiedJobHold). Both print `requeued`
 * (`would requeue` in a dry run) or `skipped`.
 * Returns 0, 1 (lock, retry, accounts file, or pass failure), or 2 (usage).
 */
export async function runRetryCommand(argv: string[], deps: Partial<RetryCommandDeps> = {}): Promise<number> {
  const io: RetryCommandDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    log: deps.log ?? ((line) => console.log(line)),
    acquireLock: deps.acquireLock ?? ((dataDir) => acquirePipelineLock(dataDir)),
    startPass: deps.startPass ?? (async () => { throw new Error("no pipeline pass is available here."); }),
    env: deps.env ?? process.env
  };
  const args = parseRetryArgs(argv);
  if (!args) {
    io.log(RETRY_USAGE);
    return 2;
  }
  if (args.correct && !args.dryRun && !args.confirm) {
    io.log("Not run: --correct-submitted changes a SUBMITTED record; add --confirm once the candidate has agreed, or --dry-run to check it.");
    return 1;
  }
  if ((!args.dryRun || args.verified) && manualOnly(io.env)) {
    io.log("Not run: manual checklist mode is on; the pipeline starts no browser runs.");
    return 1;
  }
  let release: () => void = () => {};
  if (!args.dryRun) {
    try {
      release = io.acquireLock(io.dataDir(args.profile));
    } catch (error) {
      io.log(`Not run: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
      return 1;
    }
  }
  let exit = 0;
  try {
    let retried = 0;
    let skipped = 0;
    let released = 0;
    const database = io.open(args.profile);
    try {
      if (args.job !== null && args.verified) {
        const outcome = requeueJobTarget(io, database, { ...args, job: args.job, verified: args.verified });
        retried += outcome.retried;
        skipped += 1 - outcome.retried;
        if (outcome.failed) exit = 1;
      }
      const seen = new Set<string>();
      const targets: Array<BrowserRun | { ref: string; reason: string }> = args.held
        ? listHeldRuns(database)
        : args.runs.map((ref) => {
          const found = resolveRef(database, ref);
          return typeof found === "string" ? { ref: clip(ref, 40), reason: found } : found;
        });
      if (args.held && targets.length === 0) io.log("No held runs.");
      for (const target of targets) {
        if (!("id" in target)) {
          skipped += 1;
          io.log(`skipped ${target.ref} (${target.reason})`);
          continue;
        }
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        const label = describeRun(database, target);
        if (args.verified) {
          const dataDir = io.dataDir(args.profile);
          const hold = verifiedHold(database, dataDir, target, args.verified);
          if (typeof hold === "string") {
            skipped += 1;
            io.log(`skipped ${label} (${hold})`);
            continue;
          }
          try {
            if (!args.dryRun) requeueVerifiedHold(database, dataDir, target.id, args.verified, args.reason);
            retried += 1;
            io.log(`${args.dryRun ? "would requeue" : "requeued"} ${label} after verified pre-submit fix.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        if (args.close) {
          const dataDir = io.dataDir(args.profile);
          const blocker = closeUnsubmittedBlocker(database, dataDir, target);
          if (blocker) {
            skipped += 1;
            io.log(`skipped ${label} (${blocker})`);
            continue;
          }
          if (args.dryRun) {
            retried += 1;
            io.log(`would close ${label} (${CLOSED_EVIDENCE_TEXT})`);
            continue;
          }
          try {
            const { text } = closeUnsubmittedRun(database, dataDir, target.id, { reason: args.reason });
            retried += 1;
            io.log(`closed ${label}: cancelled as never submitted (${text}); the application is skipped as "Posting closed" and will not be retried.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        if (args.correct) {
          const dataDir = io.dataDir(args.profile);
          const blocker = correctSubmittedBlocker(database, dataDir, target);
          if (blocker) {
            skipped += 1;
            io.log(`skipped ${label} (${blocker})`);
            continue;
          }
          if (args.dryRun) {
            retried += 1;
            io.log(`would correct ${label} (${unsubmittedEvidence(database, dataDir, target)!.text})`);
            continue;
          }
          try {
            const { evidence } = correctSubmittedRun(database, dataDir, target.id, { reason: args.reason, confirm: args.confirm });
            retried += 1;
            io.log(`corrected ${label}: no longer submitted (${evidence.text}); the application is applying again with the run failed and held as a possible submission. Check its receipt with pnpm mail:scan --receipt ${target.id.slice(0, 8)} before any reopen.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        if (args.reopen) {
          const dataDir = io.dataDir(args.profile);
          const blocker = reopenUnsubmittedBlocker(database, dataDir, target);
          if (blocker) {
            skipped += 1;
            io.log(`skipped ${label} (${blocker})`);
            continue;
          }
          if (args.dryRun) {
            retried += 1;
            io.log(`would reopen ${label} (${reopenEvidence(database, dataDir, target)!.text})`);
            continue;
          }
          try {
            const { evidence } = reopenUnsubmittedRun(database, dataDir, target.id, { reason: args.reason });
            retried += 1;
            io.log(`reopened ${label}: cancelled as not submitted (${evidence.text}); the application is back to ready for review.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        const blocker = automaticRetryBlocker(database, target);
        if (blocker) {
          skipped += 1;
          io.log(`skipped ${label} (${blocker})`);
          continue;
        }
        if (args.dryRun) {
          retried += 1;
          io.log(`would retry ${label}`);
          continue;
        }
        try {
          retryAutomaticRun(database, target.id, { reason: args.reason });
          retried += 1;
          io.log(`retried ${label}: cancelled; the application is back to ready for review.`);
        } catch (error) {
          skipped += 1;
          exit = 1;
          io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
        }
      }
      if (args.held && !args.reopen) {
        const outcome = releaseWorkdayHolds(io, args);
        released = outcome.released;
        if (outcome.failed) exit = 1;
      }
    } finally {
      io.close(args.profile);
    }
    const verb = args.reopen ? "reopen" : args.close ? "close" : args.correct ? "correct" : "retry";
    const done = args.reopen ? "Reopened" : args.close ? "Closed" : args.correct ? "Corrected" : "Retried";
    io.log(args.dryRun
      ? `Dry run: would ${verb} ${retried}; skipped ${skipped}; nothing written.`
      : `${done} ${retried}; skipped ${skipped}.`);
    if (released > 0) {
      io.log(args.dryRun ? `Dry run: would release ${released} Workday account hold(s).` : `Released ${released} Workday account hold(s).`);
    }
    if (!args.dryRun && !args.close && !args.correct && retried + released > 0 && !pipelineSettings(io.env).autoApply) {
      io.log("Auto-apply is off (INTERNSHIP_AGENT_AUTO_APPLY), so no pass will start these runs until it is on.");
    }
    if (args.start) {
      if (retried + released === 0) {
        io.log(args.reopen ? "Nothing reopened; no pass started." : "Nothing retried; no pass started.");
      } else {
        io.log("Starting one pipeline pass without discovery.");
        try {
          await io.startPass(args.profile, io.log);
        } catch (error) {
          exit = 1;
          io.log(`Pass failed: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
        }
      }
    }
  } finally {
    release();
  }
  return exit;
}

/**
 * `--held`'s Workday part: releases (or, in a dry run, lists) every
 * "unexpected" account hold when account automation is on for this
 * workspace; prints nothing when it is off.
 */
function releaseWorkdayHolds(io: RetryCommandDeps, args: RetryArgs): { released: number; failed: boolean } {
  const settings = workdayAccountSettings(io.env);
  if (!settings) return { released: 0, failed: false };
  const resolved = resolveWorkdayAccounts(settings, io.dataDir(args.profile), io.env);
  if (!("runtime" in resolved)) return { released: 0, failed: false };
  const file = resolved.runtime.file;
  let released = 0;
  try {
    for (const entry of releasableWorkdayHolds(file)) {
      const reason = clip(entry.hold?.reason ?? "", 200);
      if (args.dryRun) {
        released += 1;
        io.log(`would release the Workday account hold on ${entry.host} (${reason})`);
        continue;
      }
      releaseWorkdayAccountHold(file, entry.host);
      released += 1;
      const next = entry.password && entry.account !== "refused" ? "signs in with the saved password" : "tries the account step again";
      io.log(`released the Workday account hold on ${entry.host} (${reason}): the next pass ${next}.`);
    }
  } catch (error) {
    if (!(error instanceof WorkdayAccountsFileError)) throw error;
    io.log("Workday account holds not released: the accounts file cannot be read.");
    return { released, failed: true };
  }
  return { released, failed: false };
}
