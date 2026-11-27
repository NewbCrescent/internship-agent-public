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
  listPostingsAwaitingAnalysis,
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
  updateDiscoverySourceHealth,
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
import { discoverySkipInputSchema, type DiscoveredItem, type DiscoverySource, type JobPostingStatus } from "@internship-agent/domain";

import { ingestPosting } from "./job-ingestion-orchestrator";
import { prepareApplication } from "./application-orchestrator";
import { evaluateAndPersistMatch } from "./match-orchestrator";
import { fetchPublicBoard, parsePublicBoardUrl, PublicBoardError } from "./public-board-source";
import { BOARD_CHECK_CONCURRENCY, BOARD_CHECKS_PER_PASS, BOARD_MIN_CHECKS_PER_PASS, boardRetryAfter, isPublicBoardSource, planBoardChecks } from "./board-polling";
import { canonicalGitHubJobListUrl, fetchGitHubJobList, postingLinkKey } from "./github-job-list-source";
import { pipelineSettings } from "./pipeline-orchestrator";
import { fitTargetDecision, postingTargetDecision, targetTerm } from "./application-target";
import { mapWithConcurrency, modelConcurrency } from "./concurrency";
import { labelsPendingNotice } from "./requirement-relabel";
import { openDiscoveryTrace, type DiscoveryFetchEvent, type DiscoveryRowEvent, type DiscoveryTrace } from "./discovery-trace";
import type { ModelProvider } from "./model/provider";
import type { DiscoveryTimeBudget } from "./discovery-time-budget";

export const MAX_BATCH_ITEMS = 100;

export type BatchReport = {
  run: DiscoveryRun;
  jobIds: string[];
  promotedJobIds: string[];
  skippedJobIds: string[];
  feedbackSkippedJobIds: string[];
  errors: string[];
  sourceNotes: string[];
  /** New postings stored but left unanalyzed for the next pass by the pass's discovery time budget. */
  deferredJobIds: string[];
  /** Why the source check's discovery trace could not be written, if it could not. */
  traceError?: string | null;
};

/** Statuses past the approval gate: discovery never revises, re-analyzes, or re-prepares these postings. */
export const PROTECTED_POSTING_STATUSES: ReadonlySet<JobPostingStatus> = new Set([
  "APPROVED",
  "APPLYING",
  "SUBMITTED",
  "INTERVIEW",
  "REJECTED",
  "OFFER",
  "WITHDRAWN"
]);
/** Postings past the approval gate belong to the live pipeline, not to discovery. */
const LIVE_STATUSES = PROTECTED_POSTING_STATUSES;

type FetchedBatch = { items: DiscoveredItem[]; notes: string[] };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type FetchContext = {
  knownLinkKeys: ReadonlySet<string>;
  onRow?: (event: DiscoveryRowEvent) => void;
  /** Public boards report each request (endpoint, status, counts) for the discovery trace. */
  onFetch?: (event: DiscoveryFetchEvent) => void;
  /** Tests inject the public board fetch; production uses fetch. */
  fetcher?: Fetcher;
};
export type FetchBatch = (
  source: { label: string; url: string },
  context: FetchContext
) => Promise<DiscoveredItem[] | FetchedBatch>;

async function defaultFetchBatch(source: { label: string; url: string }, context: FetchContext): Promise<FetchedBatch> {
  if (new URL(source.url).hostname === "github.com") {
    return fetchGitHubJobList(source, fetch, { knownLinkKeys: context.knownLinkKeys, onRow: context.onRow });
  }
  const items = await fetchPublicBoard(source, context.fetcher ?? fetch, { onRow: context.onRow, onFetch: context.onFetch });
  // A board with no internship postings right now is a completed, empty check, not an error.
  return { items, notes: items.length ? [] : ["No internship postings on this board right now."] };
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
    /** Tests inject the public board fetch; production uses fetch. */
    fetcher?: Fetcher;
    /** Runs the ingest step; a pass checking boards concurrently passes a gate that runs one ingest at a time. */
    ingestGate?: <T>(task: () => Promise<T>) => Promise<T>;
    /** The pass's discovery time budget; analysis of new postings stops once it is spent. */
    budget?: DiscoveryTimeBudget | null;
  } = {}
): Promise<BatchReport> {
  const database = options.database ?? getDatabase();
  const source = reserveDiscoveryFetch(database, sourceId);
  if (!source.url) throw new Error("The company source has no URL to fetch.");
  const board = isPublicBoardSource(source);
  // A board writes no quiet rows, so its trace need not read the day's file to decide.
  const trace = options.traceDirectory
    ? openDiscoveryTrace(options.traceDirectory, { label: source.label, url: source.url }, board ? { full: false } : {})
    : null;
  try {
    const fetchBatch = options.fetchBatch ?? defaultFetchBatch;
    // Every current posting, whatever its status, is known; its link is not re-fetched.
    // The board path never reads these keys, so a board check does not load them.
    const knownLinkKeys = board ? new Set<string>() : new Set(listCurrentPostingIdentities(database)
      .flatMap((posting) => postingLinkKey(posting.sourceUrl) ?? []));
    let fetched: Awaited<ReturnType<FetchBatch>>;
    try {
      fetched = await fetchBatch(
        { label: source.label, url: source.url },
        {
          knownLinkKeys,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(trace ? { onRow: (event: DiscoveryRowEvent) => trace.row(event), onFetch: (event: DiscoveryFetchEvent) => trace.fetch(event) } : {})
        }
      );
    } catch (error) {
      if (board) recordBoardFailure(database, source, error);
      throw error;
    }
    if (board && (source.failureCount > 0 || source.lastError || source.retryAfter)) {
      updateDiscoverySourceHealth(database, source.id, { failureCount: 0, lastError: null, retryAfter: null });
    }
    const { items, notes } = Array.isArray(fetched) ? { items: fetched, notes: [] } : fetched;
    for (const item of items.slice(MAX_BATCH_ITEMS)) {
      trace?.ingest({
        company: item.companyName, title: item.title, postingUrl: item.sourceUrl ?? "",
        decision: "not-reached", reason: "past this check's batch limit of " + MAX_BATCH_ITEMS + " postings"
      });
    }
    const ingest = options.ingestGate ?? (<T>(task: () => Promise<T>) => task());
    const report = await ingest(() => processDiscoveredItems(database, sourceId, items.slice(0, MAX_BATCH_ITEMS), [], { ...options, trace }, notes));
    trace?.end();
    return { ...report, traceError: trace?.writeError ?? null };
  } catch (error) {
    trace?.end({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Marks a failed board fetch and backs the board off; it never masks the fetch's own error. */
function recordBoardFailure(database: DatabaseSync, source: DiscoverySource, error: unknown): void {
  try {
    const failureCount = source.failureCount + 1;
    const status = error instanceof PublicBoardError ? error.status : null;
    updateDiscoverySourceHealth(database, source.id, {
      failureCount,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      retryAfter: boardRetryAfter(failureCount, status, new Date())
    });
  } catch { /* the fetch error is what the caller reports */ }
}

/**
 * A pass's public boards: only those due (see planBoardChecks), at most
 * `concurrency` fetches in flight, and one board's ingest at a time so the
 * cross-board duplicate checks stay correct. Once the time budget is spent,
 * boards are still started while fewer than `minChecks` (the floor,
 * BOARD_MIN_CHECKS_PER_PASS) have started in this pass (Track 73); the rest
 * stay due. Logs only boards that stored, prepared, or failed, then one
 * summary line.
 */
export async function checkPublicBoards(
  database: DatabaseSync,
  boards: readonly DiscoverySource[],
  options: {
    log: (line: string) => void;
    traceDirectory?: string;
    fetchBatch?: FetchBatch;
    fetcher?: Fetcher;
    now?: Date;
    limit?: number;
    concurrency?: number;
    /** The pass's discovery time budget; once it is spent no further board is started past the floor (`minChecks`). */
    budget?: DiscoveryTimeBudget | null;
    /** Due boards still read once the budget is spent, oldest first (default BOARD_MIN_CHECKS_PER_PASS). */
    minChecks?: number;
    /** The shortest time between two checks of one board (default planBoardChecks's own default). */
    minIntervalMs?: number;
  }
): Promise<{ checked: string[]; failed: number; notDue: number; backedOff: number; deferred: number; budgetDeferred: number; pastBudget: number }> {
  const { log } = options;
  const plan = planBoardChecks(boards, options.now ?? new Date(), options.limit ?? BOARD_CHECKS_PER_PASS, options.minIntervalMs);
  let tail: Promise<unknown> = Promise.resolve();
  const gate = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
  let failed = 0;
  const budgetDeferred = new Set<string>();
  const floor = options.minChecks ?? BOARD_MIN_CHECKS_PER_PASS;
  let started = 0;
  const pastBudget = new Set<string>();
  await mapWithConcurrency(plan.due, options.concurrency ?? BOARD_CHECK_CONCURRENCY, async (source) => {
    // Past the time budget a board is still read while fewer than `floor` boards have started in this pass (Track 73), so every due board is read
    // within a bounded number of passes; its new postings are stored and their analysis waits. Past the floor a board is not started:
    // it keeps its last fetch time, so it stays due and goes first next pass.
    if (options.budget?.spent()) {
      if (started >= floor) { options.budget.deferBoard(); budgetDeferred.add(source.id); return; }
      pastBudget.add(source.id);
    }
    started += 1;
    try {
      const { run, sourceNotes, errors, traceError, deferredJobIds } = await fetchCompanySource(source.id, {
        database, fetchBatch: options.fetchBatch, fetcher: options.fetcher, traceDirectory: options.traceDirectory, ingestGate: gate,
        budget: options.budget
      });
      if (run.ingested || run.promoted || errors.length) {
        log(`${source.label}: fetched ${run.fetched}, duplicates ${run.deduped}, new ${run.ingested}, prepared ${run.promoted}.` +
          (deferredJobIds.length ? ` ${deferredJobIds.length} left for the next pass (budget).` : "") +
          (sourceNotes.length ? " " + sourceNotes.join(" ") : "") + (errors.length ? ` ${errors.length} error(s).` : ""));
      }
      if (traceError) log(`${source.label}: discovery trace not written (${traceError}).`);
    } catch (error) {
      failed += 1;
      log(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  log(`Public boards: checked ${plan.due.length - budgetDeferred.size} (${failed} failed), not due ${plan.notDue.length}, ` +
    `backed off ${plan.backedOff.length}, left for a later pass ${plan.deferred.length}` +
    (pastBudget.size ? `, read past the time budget ${pastBudget.size}` : "") +
    (budgetDeferred.size ? `, left by the time budget ${budgetDeferred.size}` : "") + ".");
  return {
    checked: plan.due.filter((source) => !budgetDeferred.has(source.id)).map((source) => source.label),
    failed, notDue: plan.notDue.length, backedOff: plan.backedOff.length, deferred: plan.deferred.length,
    budgetDeferred: budgetDeferred.size, pastBudget: pastBudget.size
  };
}

/**
 * Resumes the postings an earlier pass's time budget (or an interrupted
 * discovery run) left unanalyzed: DISCOVERED with no match, or a revision
 * (any status before the approval gate) whose match predates its current
 * snapshot (Track 73); not skipped by feedback, not held for labels; oldest
 * first. They go through the same analysis and preparation as new postings,
 * within the budget.
 */
export async function resumeDeferredAnalysis(
  database: DatabaseSync,
  options: { budget: DiscoveryTimeBudget; candidateId?: string }
): Promise<{ waiting: number; analyzed: number; prepared: number; deferred: number; errors: string[] }> {
  const backlog = listPostingsAwaitingAnalysis(database, { excludedStatuses: [...PROTECTED_POSTING_STATUSES] });
  if (backlog.length === 0) return { waiting: 0, analyzed: 0, prepared: 0, deferred: 0, errors: [] };
  const result = await analyzeAndPrepare(database, backlog, { candidateId: options.candidateId ?? LOCAL_CANDIDATE_ID, budget: options.budget });
  return { waiting: backlog.length, analyzed: result.ranked.length, prepared: result.promotedJobIds.length, deferred: result.deferredJobIds.length, errors: result.errors };
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
  options: { candidateId?: string; threshold?: number; limit?: number; provider?: ModelProvider; trace?: DiscoveryTrace | null; budget?: DiscoveryTimeBudget | null },
  sourceNotes: string[] = []
): Promise<BatchReport> {
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  // A source that reports notes (a GitHub list) may legitimately have nothing
  // new once known links are skipped; that is a completed, empty run.
  if (items.length === 0 && (sourceId === null || sourceNotes.length === 0)) {
    throw new Error(errors[0] ?? "The batch held no usable postings.");
  }
  const run = startDiscoveryRun(database, sourceId);
  if (items.length === 0) {
    // An empty check (a board with no internship postings) loads no posting identities.
    const finished = finishDiscoveryRun(database, run.id, { fetched: 0, deduped: 0, ingested: 0, analyzed: 0, promoted: 0 });
    return { run: finished, jobIds: [], promotedJobIds: [], skippedJobIds: [], feedbackSkippedJobIds: [], errors, sourceNotes, deferredJobIds: [] };
  }
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

  const analysis = await analyzeAndPrepare(database, jobIds, {
    candidateId, threshold: options.threshold, limit: options.limit, budget: options.budget
  });
  skippedJobIds.push(...analysis.skippedJobIds);
  errors.push(...analysis.errors);
  const { ranked, promotedJobIds, deferredJobIds } = analysis;

  const finished = finishDiscoveryRun(database, run.id, {
    fetched: items.length,
    deduped: batchDuplicates + existingDuplicates,
    ingested: jobIds.length,
    analyzed: ranked.length,
    promoted: promotedJobIds.length
  });
  return { run: finished, jobIds, promotedJobIds, skippedJobIds, feedbackSkippedJobIds, errors, sourceNotes, deferredJobIds };
}

type AnalysisResult = {
  ranked: Array<{ jobId: string; verdict: string; fitScore: number }>;
  promotedJobIds: string[];
  skippedJobIds: string[];
  deferredJobIds: string[];
  errors: string[];
};

/**
 * Matches, AI-fits, and prepares stored postings one at a time, as discovery
 * does for new postings; once the pass's time budget is spent the remaining
 * postings are left stored with no match for the next pass.
 */
async function analyzeAndPrepare(
  database: DatabaseSync,
  jobIds: readonly string[],
  options: { candidateId: string; threshold?: number; limit?: number; budget?: DiscoveryTimeBudget | null }
): Promise<AnalysisResult> {
  const ranked: AnalysisResult["ranked"] = [];
  const skippedJobIds: string[] = [];
  const deferredJobIds: string[] = [];
  const errors: string[] = [];
  const candidateId = options.candidateId;
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
    // Past the pass's time budget the posting stays stored as DISCOVERED with no match; the next pass resumes it oldest first.
    if (options.budget?.spent()) { options.budget.deferPosting(); deferredJobIds.push(jobId); continue; }
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

  return { ranked, promotedJobIds, skippedJobIds, deferredJobIds, errors };
}
