import type { DatabaseSync } from "node:sqlite";

import {
  countReviewQueue,
  countReviewQueueUnknownDates,
  countReviewQueueUnstated,
  listReviewQueue,
  listReviewQueueCountries,
  getDatabase,
  getJobPosting,
  listBrowserRuns,
  listResumeVariants,
  LOCAL_CANDIDATE_ID,
  getReviewFocus,
  updateBrowserRun,
  type ReviewQueueEntry
} from "@internship-agent/db";
import {
  compareFocus,
  inFocus,
  listPageBounds,
  parseReviewQueueOptions,
  roleTypeForTitle,
  type ReviewQueueQuery,
  type ResumeDocument,
  type RoleType
} from "@internship-agent/domain";

import { getReviewQueue, prepareApplication } from "./application-orchestrator";
import { applicationUrlFor } from "./browser-orchestrator";
import { getCandidateResumeDocument } from "./resume-entry-service";

/** Statuses whose application package can still be rebuilt without touching a submission. */
const REFRESHABLE = new Set(["READY_FOR_REVIEW", "NEEDS_INPUT", "APPROVED", "APPLYING"]);
/** Runs a refresh may cancel: filled or paused, never submitted or mid-submission. */
const CANCELLABLE_RUNS = new Set(["started", "paused-needs-input", "awaiting-approval"]);

function sameDocument(a: ResumeDocument | null, b: ResumeDocument | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when the resume frozen into the job's latest package no longer matches
 * the resume the candidate's current entries and profile print. Packages from
 * before structured resumes (no frozen document) count as changed.
 */
export function resumeChangedSincePrepared(
  jobId: string,
  database: DatabaseSync = getDatabase(),
  current: ResumeDocument | null = getCandidateResumeDocument(database)
): boolean {
  const variant = listResumeVariants(database, jobId, 1)[0];
  return variant ? !sameDocument(variant.document, current) : false;
}

export type ReviewQueueItem = ReviewQueueEntry & {
  resumeChanged: boolean;
  category: RoleType;
  /** Where the candidate applies: the application form when known, else the posting. */
  applicationUrl: string | null;
};

function toItem(entry: ReviewQueueEntry, database: DatabaseSync, current: ResumeDocument | null): ReviewQueueItem {
  return {
    ...entry,
    resumeChanged: resumeChangedSincePrepared(entry.jobId, database, current),
    category: roleTypeForTitle(entry.title),
    applicationUrl: applicationUrlFor(entry)
  };
}

/** The review queue, with whether each package's resume predates the current one. */
export function getReviewQueueWithResumeState(database: DatabaseSync = getDatabase()): ReviewQueueItem[] {
  const current = getCandidateResumeDocument(database);
  return getReviewQueue(database).map((entry) => toItem(entry, database, current));
}

/**
 * One page of the Review Queue. The default focus view filters and ranks the
 * whole queue by the saved focus (a light read of about a thousand rows); the
 * "all" view keeps the SQL-paged sort, age, country, and pay controls. Frozen
 * resumes are compared only for the visible page.
 */
export function getReviewQueuePage(database: DatabaseSync, query: ReviewQueueQuery = {}, now = Date.now()) {
  const options = parseReviewQueueOptions(query);
  const reads = { ...options, now };
  const current = getCandidateResumeDocument(database);
  const focus = getReviewFocus(database);
  const everything = listReviewQueue(database, { sort: "fit" });
  const focused = everything.filter((entry) => inFocus(entry, focus, now)).sort(compareFocus);
  const shared = {
    view: options.view, focus, focusTotal: focused.length, queueTotal: everything.length,
    queueCountries: listReviewQueueCountries(database).countries, unknownDates: countReviewQueueUnknownDates(database),
    sort: options.sort, postedWithinDays: options.postedWithinDays, country: options.country, minHourlyPay: options.minHourlyPay
  };
  if (options.view === "focus") {
    const bounds = listPageBounds(focused.length, options.page);
    return { ...bounds, ...shared,
      queue: focused.slice(bounds.offset, bounds.offset + bounds.pageSize).map((entry) => toItem(entry, database, current)),
      countries: { countries: [], unstated: 0 }, unstated: { country: 0, pay: 0 } };
  }
  const bounds = listPageBounds(countReviewQueue(database, reads), options.page);
  return { ...bounds, ...shared,
    queue: listReviewQueue(database, { ...reads, limit: bounds.pageSize, offset: bounds.offset }).map((entry) => toItem(entry, database, current)),
    countries: listReviewQueueCountries(database, reads), unstated: countReviewQueueUnstated(database, reads) };
}

export type RefreshReport = {
  refreshed: Array<{ jobId: string; status: string }>;
  /** Runs cancelled so the application refills with the current resume. */
  cancelledRuns: string[];
  skipped: Array<{ jobId: string; reason: string }>;
  errors: string[];
};

/**
 * Rebuilds packages whose frozen resume is out of date, from the candidate's
 * current resume, and re-verifies them. A filled-but-unsubmitted run is
 * cancelled first so the pipeline refills the form with the new resume; the
 * candidate's approval of the old package does not carry over. Submitted
 * applications and runs mid-submission are never touched. Each rebuild is a
 * few milliseconds of local work, so they run one after another.
 */
export function refreshApplications(
  jobIds: string[],
  options: { database?: DatabaseSync; candidateId?: string } = {}
): RefreshReport {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const current = getCandidateResumeDocument(database, candidateId);
  const report: RefreshReport = { refreshed: [], cancelledRuns: [], skipped: [], errors: [] };
  for (const jobId of [...new Set(jobIds)]) {
    const status = getJobPosting(database, jobId)?.status;
    if (!status || !REFRESHABLE.has(status)) {
      report.skipped.push({ jobId, reason: `The application is ${status?.toLocaleLowerCase("en-US") ?? "unknown"}.` });
      continue;
    }
    if (!resumeChangedSincePrepared(jobId, database, current)) {
      report.skipped.push({ jobId, reason: "Its resume already matches your current resume." });
      continue;
    }
    const runs = listBrowserRuns(database, jobId);
    if (runs.some((run) => run.status === "submitted" || run.status === "submitting")) {
      report.skipped.push({ jobId, reason: "A run for it was submitted or is submitting." });
      continue;
    }
    try {
      for (const run of runs.filter((entry) => CANCELLABLE_RUNS.has(entry.status))) {
        updateBrowserRun(database, run.id, { status: "cancelled" });
        report.cancelledRuns.push(run.id);
      }
      prepareApplication(jobId, { database, candidateId });
      report.refreshed.push({ jobId, status: getJobPosting(database, jobId)?.status ?? "UNKNOWN" });
    } catch (error) {
      report.errors.push(`${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
