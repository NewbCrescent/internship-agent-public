import { automaticallyAnalyzeFit } from "./model/semantic-fit";
import type { DatabaseSync } from "node:sqlite";

import {
  finishDiscoveryRun,
  findJobBySourceUrl,
  getDiscoverySkip,
  getDatabase,
  getJobPosting,
  getJobStatus,
  getRequirementLabelHold,
  listCurrentPostingIdentities,
  listDiscoveryRuns,
  listDiscoverySkips,
  listDiscoverySkipsWithTitles,
  listDiscoverySources,
  LOCAL_CANDIDATE_ID,
  reserveDiscoveryFetch,
  ProtectedJobError,
  removeDiscoverySkip,
  saveDiscoverySource,
  saveDiscoverySkips,
  startDiscoveryRun,
  type DiscoveryRun
} from "@internship-agent/db";
import {
  contentDedupeKey,
  dedupeItems,
  parsePostingBatch,
  postingDedupeKey,
  REQUIREMENT_LABELS_UNAVAILABLE,
  selectPromotion
} from "@internship-agent/jobs";
import { discoverySkipInputSchema, type DiscoveredItem, type JobPostingStatus } from "@internship-agent/domain";

import { ingestPosting } from "./job-ingestion-orchestrator";
import { prepareApplication } from "./application-orchestrator";
import { evaluateAndPersistMatch } from "./match-orchestrator";
import { fetchPublicBoard, parsePublicBoardUrl } from "./public-board-source";
import { canonicalGitHubJobListUrl, fetchGitHubJobList, postingLinkKey } from "./github-job-list-source";
import { pipelineSettings } from "./pipeline-orchestrator";
import { fitTargetDecision, postingTargetDecision, targetTerm } from "./application-target";
import { mapWithConcurrency, modelConcurrency } from "./concurrency";
import { labelsPendingNotice } from "./requirement-relabel";
import { openDiscoveryTrace, type DiscoveryRowEvent, type DiscoveryTrace } from "./discovery-trace";
import type { ModelProvider } from "./model/provider";

export const MAX_BATCH_ITEMS = 100;

export type BatchReport = {
  run: DiscoveryRun;
  jobIds: string[];
  promotedJobIds: string[];
  skippedJobIds: string[];
  feedbackSkippedJobIds: string[];
  errors: string[];
  sourceNotes: string[];
  /** Why the source check's discovery trace could not be written, if it could not. */
  traceError?: string | null;
};

/** Postings past the approval gate belong to the live pipeline, not to discovery. */
const LIVE_STATUSES: ReadonlySet<JobPostingStatus> = new Set([
  "APPROVED",
  "APPLYING",
  "SUBMITTED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "WITHDRAWN"
]);

type FetchedBatch = { items: DiscoveredItem[]; notes: string[] };
type FetchContext = { knownLinkKeys: ReadonlySet<string>; onRow?: (event: DiscoveryRowEvent) => void };
export type FetchBatch = (
  source: { label: string; url: string },
  context: FetchContext
) => Promise<DiscoveredItem[] | FetchedBatch>;

async function defaultFetchBatch(source: { label: string; url: string }, context: FetchContext): Promise<FetchedBatch> {
  if (new URL(source.url).hostname === "github.com") {
    return fetchGitHubJobList(source, fetch, { knownLinkKeys: context.knownLinkKeys, onRow: context.onRow });
  }
  return { items: await fetchPublicBoard(source), notes: [] };
}

/**
 * The Milestone 9 orchestration seam. Bulk flow: parse a pasted batch (or
 * fetch a company page), dedupe by posting identity, ingest and
 * cheaply analyze everything, then prepare only the promoted few so the
 * review queue reflects strong candidates instead of raw volume.
 */
export async function processManualBatch(
  batchText: string,
  options: {
    database?: DatabaseSync;
    candidateId?: string;
    threshold?: number;
    limit?: number;
  } = {}
): Promise<BatchReport> {
  const database = options.database ?? getDatabase();
  const { items, errors } = parsePostingBatch(batchText);
  return processDiscoveredItems(database, null, items.slice(0, MAX_BATCH_ITEMS), errors, options);
}

export async function fetchCompanySource(
  sourceId: string,
  options: {
    database?: DatabaseSync;
    candidateId?: string;
    threshold?: number;
    limit?: number;
    fetchBatch?: FetchBatch;
    /** Tests inject a model; production uses the configured provider. */
    provider?: ModelProvider;
    /** The workspace data directory; when given, the check writes its discovery trace there. */
    traceDirectory?: string;
  } = {}
): Promise<BatchReport> {
  const database = options.database ?? getDatabase();
  const source = reserveDiscoveryFetch(database, sourceId);
  if (!source.url) throw new Error("The company source has no URL to fetch.");
  const trace = options.traceDirectory ? openDiscoveryTrace(options.traceDirectory, { label: source.label, url: source.url }) : null;
  try {
    const fetchBatch = options.fetchBatch ?? defaultFetchBatch;
    // Every current posting, whatever its status, is known; its link is not re-fetched.
    const knownLinkKeys = new Set(listCurrentPostingIdentities(database)
      .flatMap((posting) => postingLinkKey(posting.sourceUrl) ?? []));
    const fetched = await fetchBatch(
      { label: source.label, url: source.url },
      { knownLinkKeys, ...(trace ? { onRow: (event: DiscoveryRowEvent) => trace.row(event) } : {}) }
    );
    const { items, notes } = Array.isArray(fetched) ? { items: fetched, notes: [] } : fetched;
    for (const item of items.slice(MAX_BATCH_ITEMS)) {
      trace?.ingest({
        company: item.companyName, title: item.title, postingUrl: item.sourceUrl ?? "",
        decision: "not-reached", reason: "past this check's batch limit of " + MAX_BATCH_ITEMS + " postings"
      });
    }
    const report = await processDiscoveredItems(database, sourceId, items.slice(0, MAX_BATCH_ITEMS), [], { ...options, trace }, notes);
    trace?.end();
    return { ...report, traceError: trace?.writeError ?? null };
  } catch (error) {
    trace?.end({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function addCompanySource(
  label: string,
  url: string,
  rateLimitPerMinute = 6,
  database: DatabaseSync = getDatabase()
) {
  const canonicalUrl = new URL(url).hostname === "github.com"
    ? canonicalGitHubJobListUrl(url)
    : (parsePublicBoardUrl(url), url);
  const existing = listDiscoverySources(database).find((source) => source.url === canonicalUrl);
  if (existing) return existing;
  const limit = canonicalUrl.startsWith("https://github.com/") ? 1 : rateLimitPerMinute;
  return saveDiscoverySource(database, { kind: "company-page", label, url: canonicalUrl, rateLimitPerMinute: limit });
}

export function getDiscoveryRuns(limit = 10, database: DatabaseSync = getDatabase()): DiscoveryRun[] {
  return listDiscoveryRuns(database, limit);
}

export function getDiscoverySources(database: DatabaseSync = getDatabase()) {
  return listDiscoverySources(database);
}

export function getDiscoverySkipsWithTitles(database: DatabaseSync = getDatabase()) {
  return listDiscoverySkipsWithTitles(database);
}

export function getDiscoverySkips(database: DatabaseSync = getDatabase()) {
  return listDiscoverySkips(database);
}

export function skipDiscoveredJobs(
  input: { jobIds: string[]; reason: string; preferenceNote: string | null },
  database: DatabaseSync = getDatabase()
): void {
  const parsed = discoverySkipInputSchema.parse(input);
  saveDiscoverySkips(database, parsed);
}

export function restoreDiscoveredJob(jobId: string, database: DatabaseSync = getDatabase()): void {
  if (!getDiscoverySkip(database, jobId)) throw new Error("The posting was not skipped.");
  removeDiscoverySkip(database, jobId);
}

async function processDiscoveredItems(
  database: DatabaseSync,
  sourceId: string | null,
  items: DiscoveredItem[],
  errors: string[],
  options: { candidateId?: string; threshold?: number; limit?: number; provider?: ModelProvider; trace?: DiscoveryTrace | null },
  sourceNotes: string[] = []
): Promise<BatchReport> {
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  // A source that reports notes (a GitHub list) may legitimately have nothing
  // new once known links are skipped; that is a completed, empty run.
  if (items.length === 0 && (sourceId === null || sourceNotes.length === 0)) {
    throw new Error(errors[0] ?? "The batch held no usable postings.");
  }
  const run = startDiscoveryRun(database, sourceId);
  const { unique, duplicates: batchDuplicates } = dedupeItems(items, (item) => [
    `posting:${postingDedupeKey(item.companyName, item.title, item.text)}`,
    ...(item.sourceUrl ? [`url:${item.sourceUrl}`] : [])
  ]);
  const currentPostings = listCurrentPostingIdentities(database);
  const knownPostings = new Map(
    currentPostings.map((posting) => [
      postingDedupeKey(posting.companyName, posting.title, posting.normalizedText), posting
    ])
  );
  const knownUrls = new Map(currentPostings.map((posting) => [posting.sourceUrl, posting]));
  let existingDuplicates = 0;
  const trace = options.trace ?? null;
  // A pasted item without a source URL needs a stable identity that
  // includes company and title, not just text shared by another employer.
  const itemSourceUrl = (item: DiscoveredItem) => item.sourceUrl
    ?? `manual-batch://${contentDedupeKey(postingDedupeKey(item.companyName, item.title, item.text)).slice(0, 16)}`;
  if (trace) {
    const kept = new Set(unique);
    for (const item of items) {
      if (kept.has(item)) continue;
      trace.ingest({
        company: item.companyName, title: item.title, postingUrl: itemSourceUrl(item),
        decision: "duplicate", reason: "the same posting appears twice in this check"
      });
    }
  }

  type Outcome =
    | { kind: "ingested"; jobId: string; updated: boolean }
    | { kind: "skipped" | "feedback-skipped"; jobId: string; duplicate: boolean }
    | { kind: "duplicate" }
    | { kind: "error"; message: string };
  // Postings wait on the model concurrently; each one's duplicate checks and
  // SQLite write stay synchronous, so writes never interleave.
  const outcomes = await mapWithConcurrency(unique, modelConcurrency(), async (item): Promise<Outcome> => {
    try {
      const sourceUrl = itemSourceUrl(item);
      const existing = findJobBySourceUrl(database, sourceUrl);
      const mirrored = knownPostings.get(postingDedupeKey(item.companyName, item.title, item.text));
      const byUrl = knownUrls.get(sourceUrl);
      const sameTextAtUrl = byUrl && contentDedupeKey(byUrl.normalizedText) === contentDedupeKey(item.text);
      const duplicate = Boolean(mirrored || sameTextAtUrl);
      const matching = existing ?? mirrored;
      if (matching && getDiscoverySkip(database, matching.id)) return { kind: "feedback-skipped", jobId: matching.id, duplicate };
      if (matching && LIVE_STATUSES.has(matching.status)) return { kind: "skipped", jobId: matching.id, duplicate };
      if (duplicate) return { kind: "duplicate" };
      const { jobId } = await ingestPosting({
        title: item.title,
        companyName: item.companyName,
        content: item.text,
        sourceUrl,
        publication: item.publication ?? null
      }, { database, provider: options.provider, protectedStatuses: LIVE_STATUSES });
      return { kind: "ingested", jobId, updated: Boolean(existing) };
    } catch (error) {
      if (error instanceof ProtectedJobError) return { kind: "skipped", jobId: error.jobId, duplicate: false };
      return { kind: "error", message: `${item.companyName} — ${item.title}: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

  const jobIds: string[] = [];
  const skippedJobIds: string[] = [];
  const feedbackSkippedJobIds: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "ingested") jobIds.push(outcome.jobId);
    else if (outcome.kind === "error") errors.push(outcome.message);
    else if (outcome.kind === "duplicate") existingDuplicates += 1;
    else {
      (outcome.kind === "skipped" ? skippedJobIds : feedbackSkippedJobIds).push(outcome.jobId);
      if (outcome.duplicate) existingDuplicates += 1;
    }
  }

  if (trace) {
    unique.forEach((item, index) => {
      const outcome = outcomes[index]!;
      const base = { company: item.companyName, title: item.title, postingUrl: itemSourceUrl(item) };
      if (outcome.kind === "ingested") {
        trace.ingest(outcome.updated
          ? { ...base, decision: "updated", reason: "stored a new revision of the job at this URL", jobId: outcome.jobId }
          : { ...base, decision: "stored-new", reason: "stored as a new job", jobId: outcome.jobId });
      } else if (outcome.kind === "duplicate") {
        trace.ingest({ ...base, decision: "duplicate", reason: "the same posting (company, title, and text) is already stored" });
      } else if (outcome.kind === "error") {
        trace.ingest({ ...base, decision: "ingest-error", reason: outcome.message });
      } else if (outcome.kind === "skipped") {
        trace.ingest({ ...base, decision: "live-posting", reason: "the stored job is already past the approval gate", jobId: outcome.jobId });
      } else {
        trace.ingest({ ...base, decision: "feedback-skipped", reason: "skipped by your discovery feedback", jobId: outcome.jobId });
      }
    });
  }

  const ranked: Array<{ jobId: string; verdict: string; fitScore: number }> = [];
  const target = targetTerm();
  for (const jobId of jobIds) {
    // Re-analysis rewrites the posting status, which would drag a live
    // application (submitted, interviewing, closed) back to an early stage.
    const status = getJobStatus(database, jobId);
    if (status && LIVE_STATUSES.has(status)) {
      skippedJobIds.push(jobId);
      continue;
    }
    // Held for AI requirement labels: not analyzed until the pipeline's retry succeeds.
    if (getRequirementLabelHold(database, jobId)) {
      const posting = getJobPosting(database, jobId);
      errors.push(posting ? labelsPendingNotice(posting) : `${REQUIREMENT_LABELS_UNAVAILABLE}: ${jobId}.`);
      continue;
    }
    try {
      const { report } = evaluateAndPersistMatch(jobId, { database, candidateId });
      // With a target set, postings it rules out get no model call and are not
      // prepared; the pipeline logs why on its next pass.
      if (target && report.verdict === "QUALIFIED" && postingTargetDecision(database, jobId, target).outcome === "skip") {
        ranked.push({ jobId, verdict: "OFF_TARGET", fitScore: report.fitScore });
        continue;
      }
      const ai = await automaticallyAnalyzeFit(jobId, database);
      if (ai) report.fitScore = ai.score;
      if (target && ai && fitTargetDecision(database, jobId, 0).outcome === "skip") {
        ranked.push({ jobId, verdict: "OFF_TARGET", fitScore: report.fitScore });
        continue;
      }
      ranked.push({ jobId, verdict: report.verdict, fitScore: report.fitScore });
    } catch (error) {
      errors.push(`Analysis failed for ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Every qualified posting at or above the configured fit is prepared unless
  // a caller narrows it; the review step, not a top-N cut, decides what to send.
  const promoted = selectPromotion(ranked, {
    threshold: options.threshold ?? pipelineSettings().minFit,
    limit: options.limit ?? Number.POSITIVE_INFINITY
  });
  const promotedJobIds: string[] = [];
  for (const entry of promoted) {
    try {
      prepareApplication(entry.jobId, { database, candidateId });
      promotedJobIds.push(entry.jobId);
    } catch (error) {
      errors.push(`Preparation failed for ${entry.jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const finished = finishDiscoveryRun(database, run.id, {
    fetched: items.length,
    deduped: batchDuplicates + existingDuplicates,
    ingested: jobIds.length,
    analyzed: ranked.length,
    promoted: promotedJobIds.length
  });
  return { run: finished, jobIds, promotedJobIds, skippedJobIds, feedbackSkippedJobIds, errors, sourceNotes };
}
