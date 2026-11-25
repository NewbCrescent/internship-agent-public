import type { DatabaseSync } from "node:sqlite";

import {
  applicationReceiptConfirmed,
  getCurrentPackage,
  getDiscoverySkip,
  getJobMatch,
  getJobPosting,
  getRequirementLabelHold,
  listApplicationEvents,
  listApplicationHolds,
  listBrowserRuns,
  listJobSummaries,
  type ApplicationHold
} from "@internship-agent/db";
import {
  AUTO_SUBMIT_EVENT,
  AUTOMATIC_START_MARK,
  autoSubmitBlockers,
  manualOnly,
  profileOfRun,
  runStartedByPipeline,
  type BrowserRun
} from "@internship-agent/domain";

import { mayHaveSubmitted } from "./application-holds";
import { profileLabel, type CompanyStanding } from "./company-policy";
import { unverifiedRequirements } from "./fit-pursuit";
import { readSubmitEvidence } from "./submit-evidence";

/**
 * Runs the pipeline started that reach the submit step clean after their
 * start pass (answered with `pnpm run:answer` or on the application page, or
 * held earlier only by the target, the AI fit, or a cap) are taken up again by
 * each later pass through the same `submitAutomatically` check (candidate
 * decision 2026-11-21: "even if the application had to ask me a question, they
 * should still auto apply"). Deterministic: no model, no network.
 */

/**
 * Whether the pipeline started this run. Unlike `runStartedByPipeline` alone
 * (which counts a run with no start event as automatic for the company cap), a
 * run with no "started automatically" event at or before its creation is not
 * counted, and a later candidate start ("…started from the approved package",
 * "…restarted…") wins.
 */
export function startedByPipelineStrictly(database: DatabaseSync, run: BrowserRun): boolean {
  const events = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  return events.some((event) => event.at <= run.createdAt && (event.detail?.includes(AUTOMATIC_START_MARK) ?? false))
    && runStartedByPipeline(run.createdAt, events);
}

/** Why the sweep would not take this run (the first reason found), or null when it goes through `submitAutomatically`. */
export function continuedAutoSubmitBlocker(
  database: DatabaseSync,
  dataDir: string,
  run: BrowserRun,
  holds: ReadonlyArray<ApplicationHold> = listApplicationHolds(database)
): string | null {
  if (manualOnly()) return "manual checklist mode is on.";
  if (run.status !== "awaiting-approval") return `the run is ${run.status}, not waiting at the submit step.`;
  if (!startedByPipelineStrictly(database, run)) {
    return "you started this run yourself; the auto-submit policy submits only runs the pipeline started.";
  }
  const blockers = autoSubmitBlockers(run);
  if (blockers.length > 0) return blockers.join(" ");
  if (run.submissionApprovedAt !== null || listApplicationEvents(database, run.jobId)
    .some((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT) && event.createdAt >= run.createdAt)) {
    return "its submission was already approved or attempted, so it is never submitted again automatically.";
  }
  // Any post-submit evidence of this run counts, field errors included: stricter than application-holds'
  // explainsPriorSubmit on purpose, so a run whose submit was ever clicked is never re-submitted automatically.
  const evidence = readSubmitEvidence(dataDir, run);
  if (mayHaveSubmitted(run, evidence) || applicationReceiptConfirmed(database, run.id)
    || holds.some((hold) => hold.jobId === run.jobId && Boolean(hold.active) && hold.reason === "possible-submission")) {
    return "it may already have reached the site.";
  }
  const posting = getJobPosting(database, run.jobId);
  if (!posting || posting.status !== "APPLYING") return "its application is not applying.";
  if (listBrowserRuns(database, run.jobId).some((other) => other.id !== run.id && other.status !== "cancelled")) {
    return "another run of this application is open, failed, or submitted.";
  }
  if (getDiscoverySkip(database, run.jobId) || getRequirementLabelHold(database, run.jobId)) {
    return "the posting is skipped or waits for AI requirement labels.";
  }
  if (posting.requirements.some((requirement) => requirement.extraction !== "MODEL")) {
    return "its requirement labels came from rules, not the AI.";
  }
  const current = getCurrentPackage(database, run.jobId);
  if (!current?.verification || current.verification.blocked || current.package.id !== run.packageId) {
    return "its package changed or is no longer verified since the run was filled.";
  }
  // The needs-review pursuit gate; its target and AI fit "apply" requirement is enforced by submitAutomatically.
  const verdict = getJobMatch(database, run.jobId)?.verdict;
  if (verdict !== "QUALIFIED" && !(verdict === "NEEDS_REVIEW" && unverifiedRequirements(database, run.jobId).length > 0)) {
    return "the posting is no longer qualified or pursued on its AI fit.";
  }
  return null;
}

/** The runs the sweep takes this pass, oldest first (answered runs that waited longest use the daily cap first). */
export function continuedAutoSubmitRuns(database: DatabaseSync, dataDir: string): BrowserRun[] {
  if (manualOnly()) return [];
  const holds = listApplicationHolds(database);
  const runs: BrowserRun[] = [];
  for (const job of listJobSummaries(database, { status: "APPLYING" })) {
    const run = listBrowserRuns(database, job.id).find((entry) => entry.status !== "cancelled");
    if (run && continuedAutoSubmitBlocker(database, dataDir, run, holds) === null) runs.push(run);
  }
  return runs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** Why a run is held when it used a different graduation profile than the one its company already saw; null when it matches. */
export function profileMismatchReason(
  database: DatabaseSync,
  candidateId: string,
  run: BrowserRun,
  standing: CompanyStanding | null
): string | null {
  if (!standing?.profile) return null;
  const used = profileOfRun(run, getJobPosting(database, run.jobId)?.source.applicationType);
  if (used === standing.profile) return null;
  return `${standing.company} already saw your ${profileLabel(database, candidateId, standing.profile)}; this run used your ${profileLabel(database, candidateId, used)}, so it is held for you: ${standing.company} should see one graduation year.`;
}

/** What `pnpm run:answer` prints when a continued run reaches the submit step. */
export function continuedRunNote(database: DatabaseSync, dataDir: string, run: BrowserRun, autoSubmitOn: boolean): string {
  if (!autoSubmitOn) return "It waits for your submit approval; the auto-submit policy is off.";
  const blocker = continuedAutoSubmitBlocker(database, dataDir, run);
  if (blocker) return `It waits for your submit approval: ${blocker}`;
  return "The next pipeline pass submits it under your auto-submit policy if the target, AI fit, company cap, and daily cap still allow; otherwise it waits for your submit approval. A pass runs when a watched list changes, or with pnpm pipeline:run --skip-discovery.";
}
