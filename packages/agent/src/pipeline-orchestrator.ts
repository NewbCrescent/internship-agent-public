import type { ModelProvider } from "./model/provider";
import { automaticallyAnalyzeFit } from "./model/semantic-fit";
import type { DatabaseSync } from "node:sqlite";

import {
  getBrowserSession,
  getCandidate,
  getCurrentPackage,
  getDatabase,
  getDiscoverySkip,
  getJobMatch,
  getSemanticFit,
  getSemanticFitFailure,
  getJobPosting,
  getRequirementLabelHold,
  listApplicationEvents,
  listBrowserRuns,
  listJobSummaries,
  LOCAL_CANDIDATE_ID,
  listApplicationEventsSince,
  logApplicationEvent,
  setJobStatus
} from "@internship-agent/db";

import { prepareApplication } from "./application-orchestrator";
import { relabelHeldPostings } from "./requirement-relabel";
import { getMatchReport, evaluateAndPersistMatch } from "./match-orchestrator";
import { applicationUrlFor, approveRunSubmissionAutomatically, AutomaticRunStopped, startBrowserRun, submitBrowserRun,
  WorkdayAccountHeld, type PageFactory, type PdfRenderer } from "./browser-orchestrator";
import { resolveWorkdayAccounts, workdayAccountSettings, workdayAccountWait, type WorkdayAccountSettings } from "./workday-account-service";
import { fitTargetDecision, postingTargetDecision, targetTerm } from "./application-target";
import { companyStanding } from "./company-policy";
import type { VoiceDrafter } from "./voice-drafting";
import type { VerificationMailboxFactory } from "./workday-verification-mail";
import { AUTO_SUBMIT_EVENT, autoSubmitBlockers, autoSubmitSettings, combineTargetDecisions, manualOnly, parseWorkdayUrl,
  workdaySiteKey, type AutoSubmitSettings, type BrowserRun, type TargetDecision, type TargetTerm } from "@internship-agent/domain";
import { COMPANY_CAP_PREFIX, companyCapReason, companyCapSetting, DEFAULT_COMPANY_CAP } from "@internship-agent/domain";
import { SubmissionHeld } from "@internship-agent/browser";

export type PipelineSettings = {
  /** Qualified postings at or above this fit score are prepared. */
  minFit: number;
  /** Whether verified packages start browser runs without a package approval. */
  autoApply: boolean;
  /** Pursue only postings the target does not skip (INTERNSHIP_AGENT_TARGET_TERM). */
  target?: TargetTerm | null;
  /** Submit clean "apply" runs without the candidate (INTERNSHIP_AGENT_AUTO_SUBMIT=1; needs a target). */
  autoSubmit?: AutoSubmitSettings | null;
  /** Create and sign in to Workday accounts with this email (INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL; needs auto-apply). */
  workdayAccounts?: WorkdayAccountSettings | null;
  /** Most automatic applications per company per target term (INTERNSHIP_AGENT_COMPANY_CAP, default 2): runs the pipeline started that are in flight or submitted. */
  companyCap?: number;
};

/** Logged once when the target rules a posting out, so it is not reported on every pass. */
const TARGET_SKIP = "Not pursued for your target: ";
const AUTO_SUBMIT_FAILURE = "Automatic submission failed: ";

/** A stop only the candidate can resolve (sign-in, no form): recorded once, never retried. */
const AUTOMATIC_STOP = "Automatic browser run needs you: ";
/** An unexpected failure (a bug, a network error): recorded and retried on the next pass. */
const AUTOMATIC_FAILURE = "Automatic browser run failed: ";
/** An account step held for the candidate or a later pass: retried when the hold allows. */
const AUTOMATIC_WAIT = "Automatic browser run waiting: ";
/** Logged by retryAutomaticRun (automatic-retry.ts) when a held run is retried after a fix; stops logged before it no longer block. */
export const AUTOMATIC_RETRY_PREFIX = "Automatic run retried after a fix: ";
/** Logged by reopenUnsubmittedRun (automatic-retry.ts): a failed submit the site is known not to have completed. */
export const REOPENED_UNSUBMITTED_PREFIX = AUTOMATIC_RETRY_PREFIX + "reopened as not submitted (";

/**
 * Automatic approvals logged at or after `sinceIso` that use the daily
 * auto-submit cap. Each approval belongs to the job's latest run created at
 * or before it. It is released only when that run is known not to have
 * reached the site: the approval was withdrawn (the run went back to the
 * candidate after field errors, a challenge, or a missing security code), or
 * the failed submit was reopened as not submitted before the job's next run
 * began. Anything else counts, conservatively: a submitted, submitting, or
 * failed run, an approval still standing, or an approval with no run found.
 */
export function automaticSubmissionsSince(database: DatabaseSync, sinceIso: string): number {
  let used = 0;
  for (const approval of listApplicationEventsSince(database, AUTO_SUBMIT_EVENT, sinceIso)) {
    const runs = listBrowserRuns(database, approval.jobId);
    const run = runs.filter((entry) => entry.createdAt <= approval.createdAt)
      .reduce<BrowserRun | null>((latest, entry) => (!latest || entry.createdAt > latest.createdAt ? entry : latest), null);
    if (!run || !approvalReleased(database, run, approval.createdAt, runs)) used += 1;
  }
  return used;
}

function approvalReleased(database: DatabaseSync, run: BrowserRun, approvedAt: string, runs: BrowserRun[]): boolean {
  if (run.status === "submitted" || run.status === "submitting") return false;
  // Every path that clears the approval sent nothing (submitBrowserRun withdraws it only then).
  if (run.submissionApprovedAt === null) return true;
  if (run.status !== "cancelled") return false;
  // The reopen cancels this run; any later run on the job starts only after it.
  const next = runs.filter((entry) => entry.createdAt > run.createdAt).map((entry) => entry.createdAt).sort()[0];
  return listApplicationEvents(database, run.jobId).some((event) =>
    event.detail?.startsWith(REOPENED_UNSUBMITTED_PREFIX) && event.createdAt >= approvedAt && (next === undefined || event.createdAt <= next));
}

/** Whether an automatic stop was logged after the job's latest retry (events oldest first). */
function stoppedSinceRetry(events: ReadonlyArray<{ detail: string | null }>): boolean {
  let stopped = false;
  for (const event of events) {
    if (event.detail?.startsWith(AUTOMATIC_RETRY_PREFIX)) stopped = false;
    else if (event.detail?.startsWith(AUTOMATIC_STOP)) stopped = true;
  }
  return stopped;
}

export function pipelineSettings(env: Record<string, string | undefined> = process.env): PipelineSettings {
  const raw = env.INTERNSHIP_AGENT_PREPARE_MIN_FIT?.trim();
  const minFit = raw && /^\d+$/.test(raw) ? Math.min(100, Number.parseInt(raw, 10)) : 0;
  const settings: PipelineSettings = { minFit, autoApply: env.INTERNSHIP_AGENT_AUTO_APPLY?.trim() === "1" };
  const target = targetTerm(env);
  const autoSubmit = autoSubmitSettings(env);
  if (target) settings.target = target;
  if (target && autoSubmit) settings.autoSubmit = autoSubmit;
  const accounts = workdayAccountSettings(env);
  if (accounts) settings.workdayAccounts = accounts;
  const cap = companyCapSetting(env);
  if (cap !== null) settings.companyCap = cap;
  return settings;
}

export type PipelineReport = {
  /** Postings ingested earlier but never analyzed (for example, an interrupted run). */
  analyzed: string[];
  prepared: Array<{ jobId: string; status: string }>;
  started: Array<{ jobId: string; runStatus: string }>;
  stopped: Array<{ jobId: string; reason: string }>;
  /**
   * Workday applications held without opening a browser until the candidate
   * signs in to that site, or held by an account step (`detail` says why).
   */
  waiting: Array<{ jobId: string; siteKey: string; reason: "workday-sign-in" | "workday-account"; detail?: string }>;
  /** Submitted by the auto-submit policy, with the confirmation the site showed. */
  submitted: Array<{ jobId: string; confirmation: string }>;
  /** Filled runs left at the submit step for the candidate, and why. */
  held: Array<{ jobId: string; reasons: string[] }>;
  /** Postings the target or a company cap ruled out on this pass (each is reported once). */
  skipped: Array<{ jobId: string; reasons: string[] }>;
  errors: string[];
};

/**
 * Advances every eligible posting as far as it may go without the
 * candidate: prepare qualified postings, then (with auto-apply on) fill
 * verified applications in a browser and stop at the submit approval.
 * Submission itself is never reached from here.
 * Per company: at most the company cap of applications per target term, and one graduation profile.
 */
export async function advancePipeline(options: {
  database?: DatabaseSync;
  candidateId?: string;
  dataDir?: string;
  settings?: PipelineSettings;
  openPage?: PageFactory;
  renderPdf?: PdfRenderer;
  voiceDrafter?: VoiceDrafter | null;
  /** Retry applications stopped earlier for the candidate (for example after a fix). */
  retryStopped?: boolean;
  fitProvider?: ModelProvider;
  /** Model for retrying held requirement labels; defaults to the configured provider. */
  labelProvider?: ModelProvider;
  /** Tests only: how long an automatic submit waits for a confirmation (default 30 s, polling every 500 ms). */
  submitWait?: { timeoutMs?: number; pollMs?: number };
  /** Reads Greenhouse's emailed security code after an automatic submit click; default as submitBrowserRun's (the Gmail mailbox, none when unset). */
  securityCodeMailbox?: VerificationMailboxFactory | null;
  /** Tests only: how the security code is polled (default every 10 s for up to 3 minutes). */
  securityCodeWait?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
} = {}): Promise<PipelineReport> {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const settings = options.settings ?? pipelineSettings();
  const report: PipelineReport = { analyzed: [], prepared: [], started: [], stopped: [], waiting: [], submitted: [], held: [], skipped: [], errors: [] };
  const target = settings.target ?? null;
  const autoSubmit = target ? settings.autoSubmit ?? null : null;
  const fitFloor = autoSubmit?.minFit ?? 80;
  /** null when no target narrows the pipeline. */
  const pursued = (jobId: string): TargetDecision | null => {
    if (!target) return null;
    return postingTargetDecision(database, jobId, target);
  };
  const ruledOut = (jobId: string, decision: TargetDecision) => {
    if (listApplicationEvents(database, jobId).some((event) => event.detail?.startsWith(TARGET_SKIP))) return;
    const status = getJobPosting(database, jobId)?.status ?? "QUALIFIED";
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: (TARGET_SKIP + decision.reasons.join(" ")).slice(0, 1_000) });
    report.skipped.push({ jobId, reasons: decision.reasons });
  };
  const cap = settings.companyCap ?? DEFAULT_COMPANY_CAP;
  /** Logged once per posting, like the target skip; the count is recomputed every pass. */
  const capped = (jobId: string, reason: string) => {
    if (listApplicationEvents(database, jobId).some((event) => event.detail?.startsWith(COMPANY_CAP_PREFIX))) return;
    const status = getJobPosting(database, jobId)?.status ?? "READY_FOR_REVIEW";
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: reason.slice(0, 1_000) });
    report.skipped.push({ jobId, reasons: [reason] });
  };

  // Postings held for AI requirement labels get another labelling attempt
  // first; until it succeeds they are not analyzed, prepared, or run.
  const relabel = await relabelHeldPostings(database, { provider: options.labelProvider, candidateId });
  report.analyzed.push(...relabel.reevaluated);
  report.errors.push(...relabel.errors);

  for (const job of listJobSummaries(database)) {
    if (job.status !== "DISCOVERED" || getJobMatch(database, job.id) || getDiscoverySkip(database, job.id) ||
      getRequirementLabelHold(database, job.id)) continue;
    try {
      evaluateAndPersistMatch(job.id, { database, candidateId });
      report.analyzed.push(job.id);
    } catch (error) {
      report.errors.push(`Analysis failed for ${job.id}: ${messageOf(error)}`);
    }
  }

  let fitAttempts = 0;
  for (const job of listJobSummaries(database)) {
    if (fitAttempts >= 25) break;
    if (!getJobMatch(database, job.id) || getDiscoverySkip(database, job.id) || getRequirementLabelHold(database, job.id) ||
      ["NOT_QUALIFIED", "SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"].includes(job.status)) continue;
    const cached = getSemanticFit(database, job.id);
    if (cached && !cached.stale) continue;
    const failure = getSemanticFitFailure(database, job.id);
    if (failure && Date.now() - Date.parse(failure) < 86_400_000) continue;
    const posting = getJobPosting(database, job.id);
    if (!posting) continue;
    // Model calls go only to postings the target would pursue.
    if (pursued(job.id)?.outcome === "skip") continue;
    fitAttempts += 1;
    await automaticallyAnalyzeFit(job.id, database, options.fitProvider);
  }

  for (const job of listJobSummaries(database)) {
    if (job.status !== "QUALIFIED" || getDiscoverySkip(database, job.id) || getRequirementLabelHold(database, job.id)) continue;
    const match = getMatchReport(job.id, database);
    if (match?.verdict !== "QUALIFIED" || match.displayFitScore < settings.minFit) continue;
    const decision = pursued(job.id);
    if (decision) {
      const withFit = combineTargetDecisions(decision, fitTargetDecision(database, job.id, fitFloor));
      if (withFit.outcome === "skip") { ruledOut(job.id, withFit); continue; }
    }
    try {
      prepareApplication(job.id, { database, candidateId });
      report.prepared.push({ jobId: job.id, status: getJobPosting(database, job.id)?.status ?? "UNKNOWN" });
    } catch (error) {
      report.errors.push(`Preparation failed for ${job.id}: ${messageOf(error)}`);
    }
  }

  // Manual checklist mode never starts browser runs, even with auto-apply on.
  if (!settings.autoApply || manualOnly()) return report;
  const accounts = settings.workdayAccounts ? resolveWorkdayAccounts(settings.workdayAccounts, options.dataDir) : null;
  const runtime = accounts && "runtime" in accounts ? accounts.runtime : null;
  // Postings at one company compete for its cap: the higher current AI fit runs first (a stable sort keeps import order on ties).
  const fitScore = new Map<string, number>();
  const ready = listJobSummaries(database).filter((job) => job.status === "READY_FOR_REVIEW");
  for (const job of ready) {
    const fit = getSemanticFit(database, job.id);
    fitScore.set(job.id, fit && !fit.stale ? fit.assessment.score : -1);
  }
  ready.sort((a, b) => (fitScore.get(b.id) ?? -1) - (fitScore.get(a.id) ?? -1));
  for (const job of ready) {
    if (job.status !== "READY_FOR_REVIEW" || getDiscoverySkip(database, job.id) || getRequirementLabelHold(database, job.id)) continue;
    const current = getCurrentPackage(database, job.id);
    if (!current?.verification || current.verification.blocked) continue;
    const decision = pursued(job.id);
    const withFit = decision ? combineTargetDecisions(decision, fitTargetDecision(database, job.id, fitFloor)) : null;
    if (withFit?.outcome === "skip") { ruledOut(job.id, withFit); continue; }
    // Runs cancelled (for example by a resume refresh) do not block a new
    // automatic run; any other run, including a failed submit, does.
    if (listBrowserRuns(database, job.id).some((run) => run.status !== "cancelled")) continue;
    // One automatic attempt per package; after a stop the candidate takes over (a retry after a fix clears earlier stops).
    if (!options.retryStopped && stoppedSinceRetry(listApplicationEvents(database, job.id))) continue;
    const posting = getJobPosting(database, job.id);
    // Automatic runs (and so auto-submit) act only on AI requirement labels.
    if (posting && posting.requirements.some((requirement) => requirement.extraction !== "MODEL")) {
      report.errors.push(`Automatic run not started for ${posting.companyName} — ${posting.title}: its requirement labels came from rules, not the AI.`);
      continue;
    }
    const url = posting ? applicationUrlFor(posting.source) : null;
    if (!url) continue;
    const standing = companyStanding(database, job.id, { term: target });
    if (standing && standing.applications >= cap) { capped(job.id, companyCapReason(standing.company, standing.applications)); continue; }
    // Workday applications need the candidate's own sign-in for that site;
    // until it is connected no window opens for them.
    const workday = parseWorkdayUrl(url);
    if (workday && getBrowserSession(database, workdaySiteKey(workday))?.status !== "connected") {
      if (!accounts) {
        report.waiting.push({ jobId: job.id, siteKey: workdaySiteKey(workday), reason: "workday-sign-in" });
        continue;
      }
      // With the account opt-in the agent signs in itself, unless this host is held.
      const held = workdayAccountWait(accounts, workday.host, getCandidate(database, candidateId)?.email);
      if (held) {
        report.waiting.push({ jobId: job.id, siteKey: workdaySiteKey(workday), reason: "workday-account", detail: held });
        continue;
      }
    }
    try {
      const { run } = await startBrowserRun(job.id, url, {
        database, candidateId, dataDir: options.dataDir, openPage: options.openPage, renderPdf: options.renderPdf,
        voiceDrafter: options.voiceDrafter, automatic: true, workdayAccounts: runtime, companyProfile: standing?.profile ?? null
      });
      report.started.push({ jobId: job.id, runStatus: run.status });
      if (autoSubmit && withFit) {
        await submitAutomatically(run, withFit, autoSubmit);
      }
    } catch (error) {
      const reason = messageOf(error);
      const waiting = error instanceof WorkdayAccountHeld;
      if (waiting && workday) report.waiting.push({ jobId: job.id, siteKey: workdaySiteKey(workday), reason: "workday-account", detail: reason });
      else report.stopped.push({ jobId: job.id, reason });
      // Keep enough of the error to diagnose it (validation errors span lines).
      const prefix = waiting ? AUTOMATIC_WAIT : error instanceof AutomaticRunStopped ? AUTOMATIC_STOP : AUTOMATIC_FAILURE;
      const detail = prefix + reason.replace(/\s+/g, " ").trim().slice(0, 500);
      // A failure after the run began must not strand the job in APPLYING.
      const status = getJobPosting(database, job.id)?.status;
      if (status === "APPLYING" && listBrowserRuns(database, job.id).length === 0) {
        setJobStatus(database, job.id, "APPLYING", "READY_FOR_REVIEW", detail);
      } else {
        logApplicationEvent(database, { jobId: job.id, fromStatus: "READY_FOR_REVIEW", toStatus: "READY_FOR_REVIEW", detail });
      }
    }
  }
  return report;

  async function submitAutomatically(run: Awaited<ReturnType<typeof startBrowserRun>>["run"], decision: TargetDecision, policy: AutoSubmitSettings) {
    const reasons = [...(decision.outcome === "apply" ? [] : decision.reasons), ...autoSubmitBlockers(run)];
    const standing = companyStanding(database, run.jobId, { term: target });
    if (standing && standing.applications >= cap) reasons.push(companyCapReason(standing.company, standing.applications));
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    if (reasons.length === 0 && automaticSubmissionsSince(database, midnight.toISOString()) >= policy.dailyCap) {
      reasons.push(`Today's ${policy.dailyCap} automatic submissions are used up.`);
    }
    if (reasons.length > 0) { report.held.push({ jobId: run.jobId, reasons }); return; }
    const fit = getSemanticFit(database, run.jobId);
    const ai = fit && !fit.stale && fit.assessment.version === 2
      ? `, AI fit ${fit.assessment.score} (${fit.assessment.rating.toLocaleLowerCase("en-US")}, ${fit.assessment.confidence.toLocaleLowerCase("en-US")} confidence) at or above your bar of ${policy.minFit}` : "";
    approveRunSubmissionAutomatically(run.id, [
      `${target!.season} ${target!.year} term, software or adjacent role, US location${ai};`,
      "every answer came from your saved facts and materials."
    ], { database });
    try {
      const submitted = await submitBrowserRun(run.id, {
        database, dataDir: options.dataDir, openPage: options.openPage, renderPdf: options.renderPdf, workdayAccounts: runtime,
        companyProfile: standing?.profile ?? null, submitWait: options.submitWait,
        securityCodeMailbox: options.securityCodeMailbox, securityCodeWait: options.securityCodeWait
      });
      report.submitted.push({ jobId: run.jobId, confirmation: submitted.confirmationText ?? "" });
    } catch (error) {
      // A failed submit may still have reached the site; it is never retried automatically.
      const reason = messageOf(error);
      const status = getJobPosting(database, run.jobId)?.status ?? "APPLYING";
      logApplicationEvent(database, { jobId: run.jobId, fromStatus: status, toStatus: status, detail: (AUTO_SUBMIT_FAILURE + reason.replace(/\s+/g, " ")).slice(0, 600) });
      // A visible challenge or a refusal around the submit is held for the candidate, not an error.
      if (error instanceof SubmissionHeld) report.held.push({ jobId: run.jobId, reasons: [reason] });
      else report.errors.push(`Automatic submission failed for ${run.jobId}: ${reason}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
