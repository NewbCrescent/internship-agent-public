import type { DatabaseSync } from "node:sqlite";

import {
  getCandidate,
  getCandidatePreferences,
  getCurrentFacts,
  getCurrentPackage,
  getDatabase,
  getJobMatch,
  getJobPosting,
  getRequirementLabelHold,
  listApplicationEvents,
  getJobStatusCounts,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  listReviewQueue,
  listResumeEntries,
  listResumeVariants,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  saveApplicationPackage,
  saveResumeVariant,
  saveVerificationReport,
  setJobStatus,
  type CurrentPackage,
  type ReviewQueueEntry
} from "@internship-agent/db";
import { RequirementLabelsPendingError } from "@internship-agent/jobs";
import { reviewPursuit } from "@internship-agent/matching";
import { buildApplicationPackage } from "@internship-agent/writer";
import { verifyApplicationPackage } from "@internship-agent/verifier";
import { buildResumeDocument, buildResumeVariant, renderResumeDocumentMarkdown } from "@internship-agent/resume";
import type { BrowserRunStatus, JobPostingStatus, VerificationReport } from "@internship-agent/domain";

import { PURSUED_ON_FIT_PREFIX, pursuedOnFitDetail, type PursuedOnFit } from "./fit-pursuit";

export type { CurrentPackage } from "@internship-agent/db";
export type { ReviewQueueEntry } from "@internship-agent/db";

export type PreparationReport = {
  current: CurrentPackage;
  verification: VerificationReport;
  /** Facts the package wanted but the candidate has not recorded. */
  missingFacts: string[];
};

/**
 * A qualified posting is preparable; so is a needs-review posting the pursuit
 * rules allow, either pursued on its AI fit now (first time, still waiting in
 * analysis) or already pursued before (a re-prepare such as a resume refresh).
 */
function requirePreparable(database: DatabaseSync, jobId: string, pursuedOnFit: PursuedOnFit | undefined): "QUALIFIED" | "NEEDS_REVIEW" {
  // A posting waiting for AI requirement labels is never prepared.
  const hold = getRequirementLabelHold(database, jobId);
  if (hold) throw new RequirementLabelsPendingError(hold.reason);
  const match = getJobMatch(database, jobId);
  if (!match) throw new Error("Analyze eligibility before preparing an application.");
  if (match.verdict === "QUALIFIED") return "QUALIFIED";
  if (match.verdict === "NEEDS_REVIEW") {
    const posting = getJobPosting(database, jobId);
    const pursuit = posting ? reviewPursuit(match, posting) : null;
    if (posting && pursuit?.pursue) {
      if (pursuedOnFit) {
        if (posting.status !== "ANALYZING") {
          throw new Error(`Only a posting waiting in analysis can be pursued on its AI fit; this one is ${posting.status.toLocaleLowerCase("en-US").replace("_", " ")}.`);
        }
        return "NEEDS_REVIEW";
      }
      if (listApplicationEvents(database, jobId).some((event) => event.detail?.startsWith(PURSUED_ON_FIT_PREFIX))) return "NEEDS_REVIEW";
    }
  }
  throw new Error(`Only qualified postings can be prepared; this one is ${match.verdict.toLocaleLowerCase("en-US").replace("_", " ")}.`);
}

/**
 * The Milestone 5 orchestration seam: build deterministically from allowed
 * evidence and explicit facts, verify independently, then gate the status.
 * A blocked package lands in NEEDS_INPUT with the failing checks attached;
 * only a clean package reaches READY_FOR_REVIEW.
 */
export function prepareApplication(
  jobId: string,
  options: { database?: DatabaseSync; candidateId?: string; pursuedOnFit?: PursuedOnFit } = {}
): PreparationReport {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const verdict = requirePreparable(database, jobId, options.pursuedOnFit);
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown; ingest it before preparing.");
  const profile = getCandidate(database, candidateId);
  if (!profile) throw new Error("The candidate profile is missing; complete it before preparing.");

  setJobStatus(
    database,
    jobId,
    null,
    "PREPARING",
    verdict === "NEEDS_REVIEW" && options.pursuedOnFit ? pursuedOnFitDetail(options.pursuedOnFit) : "Application preparation started."
  );

  const facts = getCurrentFacts(database, candidateId);
  const preferences = getCandidatePreferences(database, candidateId);
  const evidenceClaims = listProjectEvidenceProfiles(database, candidateId)
    .flatMap((project) => project.claims)
    .filter((claim) => claim.reviewStatus === "ALLOWED" && claim.freshness === "CURRENT")
    .map((claim) => ({ id: claim.id, kind: claim.kind, normalizedKey: claim.normalizedKey, text: claim.text }));

  const resumeEntries = listResumeEntries(database, candidateId);
  const draft = buildApplicationPackage(posting, { facts, preferences, profile, evidenceClaims, resumeEntries });
  saveApplicationPackage(database, draft.package);
  const verification = verifyApplicationPackage(draft.package, { database, candidateId });
  saveVerificationReport(database, verification);

  // The variant freezes the same approved entries the package bullets came from.
  const document = buildResumeDocument(profile, resumeEntries);
  const variant = buildResumeVariant(candidateId, jobId, `${posting.companyName} — ${posting.title}`, draft.package.bullets, document);
  saveResumeVariant(database, variant, renderResumeDocumentMarkdown(document));

  if (verification.blocked || draft.missingFacts.length > 0) {
    const reasons = [
      ...verification.checks
        .filter((check) => check.verdict !== "SUPPORTED")
        .map((check) => check.reason),
      ...draft.missingFacts.map((key) => `Missing candidate fact: ${key}.`)
    ];
    setJobStatus(database, jobId, null, "NEEDS_INPUT", reasons.join(" "));
    logApplicationEvent(database, {
      jobId,
      fromStatus: "PREPARING",
      toStatus: "NEEDS_INPUT",
      detail: `Verification blocked the package: ${reasons.join(" ")}`
    });
  } else {
    setJobStatus(database, jobId, null, "READY_FOR_REVIEW", "Verified package ready for candidate review.");
  }
  const current = getCurrentPackage(database, jobId);
  if (!current) throw new Error("The package was not persisted.");
  return { current, verification, missingFacts: draft.missingFacts };
}

export function getApplicationPackage(
  jobId: string,
  database: DatabaseSync = getDatabase()
): CurrentPackage | null {
  return getCurrentPackage(database, jobId);
}

/**
 * The candidate's decision surface: packages waiting for review or input,
 * newest first. APPROVED and terminal states leave the queue.
 */
export function getReviewQueue(database: DatabaseSync = getDatabase()): ReviewQueueEntry[] {
  return listReviewQueue(database);
}

export type PipelineCounts = Record<string, number>;

export function getPipelineCounts(database: DatabaseSync = getDatabase()): PipelineCounts {
  return getJobStatusCounts(database);
}

export type RecentEvent = {
  id: string;
  jobId: string;
  companyName: string;
  title: string;
  fromStatus: string | null;
  toStatus: string;
  detail: string | null;
  createdAt: string;
};

export function listRecentEvents(limit = 10, database: DatabaseSync = getDatabase()): RecentEvent[] {
  const rows = database.prepare(`
    SELECT e.id, e.job_id, j.company_name, j.title, e.from_status, e.to_status, e.detail, e.created_at
    FROM application_events e
    JOIN jobs j ON j.id = e.job_id
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; job_id: string; company_name: string; title: string;
    from_status: string | null; to_status: string; detail: string | null; created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    companyName: row.company_name,
    title: row.title,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    detail: row.detail,
    createdAt: row.created_at
  }));
}

/**
 * Explicit human approval boundary: only a READY package can be approved,
 * and only forward into APPROVED. Submission itself (Milestone 7) requires
 * a second explicit approval at that step.
 */
export function approveApplication(
  jobId: string,
  options: { database?: DatabaseSync } = {}
): void {
  const database = options.database ?? getDatabase();
  const current = getCurrentPackage(database, jobId);
  if (!current) throw new Error("There is no application package to approve.");
  if (!current.verification || current.verification.blocked) {
    throw new Error("Only a verified package can be approved.");
  }
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown.");
  if (posting.status !== "READY_FOR_REVIEW") {
    throw new Error(`Only packages ready for review can be approved; this one is ${posting.status.toLocaleLowerCase("en-US").replace("_", " ")}.`);
  }
  setJobStatus(database, jobId, null, "APPROVED", "Candidate approved the verified package.");
}

export function listJobEvents(jobId: string, database: DatabaseSync = getDatabase()) {
  return listApplicationEvents(database, jobId);
}

export function listJobResumeVariants(jobId: string, database: DatabaseSync = getDatabase()) {
  return listResumeVariants(database, jobId);
}

export function withdrawApplication(
  jobId: string,
  options: { database?: DatabaseSync } = {}
): void {
  const database = options.database ?? getDatabase();
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown.");
  if (posting.status === "WITHDRAWN") throw new Error("The application is already withdrawn.");
  setJobStatus(database, jobId, null, "WITHDRAWN", "Candidate withdrew the application.");
}

/** Queue entries the candidate may check off as manually applied. */
const MANUAL_APPLY_STATUSES: ReadonlySet<JobPostingStatus> = new Set(["READY_FOR_REVIEW", "NEEDS_INPUT"]);
const TERMINAL_RUN_STATUSES: ReadonlySet<BrowserRunStatus> = new Set(["submitted", "failed", "cancelled"]);

/**
 * Manual checklist check-off: records the candidate's own application as a
 * terminal SUBMITTED, like a real submission. There is no undo, so the agent
 * can never later start a browser run for an already-applied job.
 */
export function recordManualApplication(
  jobId: string,
  options: { database?: DatabaseSync } = {}
): { jobId: string; status: "SUBMITTED" } {
  const database = options.database ?? getDatabase();
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown.");
  if (!MANUAL_APPLY_STATUSES.has(posting.status)) {
    throw new Error(`Only applications waiting in the review queue can be checked off; this one is ${posting.status.toLocaleLowerCase("en-US").replace("_", " ")}.`);
  }
  if (listBrowserRuns(database, jobId).some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
    throw new Error("A browser run is still in progress for this application; cancel it before checking off a manual application.");
  }
  setJobStatus(database, jobId, null, "SUBMITTED", "Candidate applied manually.");
  return { jobId, status: "SUBMITTED" };
}

/** Batch check-off collects per-posting results instead of failing the batch. */
export function recordManualApplicationBatch(
  jobIds: string[],
  options: { database?: DatabaseSync } = {}
): { applied: string[]; skipped: Array<{ jobId: string; reason: string }> } {
  const database = options.database ?? getDatabase();
  const applied: string[] = [];
  const skipped: Array<{ jobId: string; reason: string }> = [];
  for (const jobId of jobIds) {
    try {
      recordManualApplication(jobId, { database });
      applied.push(jobId);
    } catch (error) {
      skipped.push({ jobId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { applied, skipped };
}
