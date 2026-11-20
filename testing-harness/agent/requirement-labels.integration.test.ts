import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getJobPosting,
  getRequirementLabelHold,
  listApplicationEvents,
  recordModelInvocation,
  saveDiscoverySkip,
  seedDevelopmentData,
  setJobStatus
} from "@internship-agent/db";
import {
  advancePipeline,
  evaluateAndPersistMatch,
  holdFallbackRequirementLabels,
  ingestPosting,
  ModelOutputBudgetError,
  ModelRateLimiter,
  OpenAiCompatibleProvider,
  prepareApplication,
  relabelHeldPostings,
  type Clock,
  type ModelProvider,
  type StructuredRequest
} from "@internship-agent/agent";
import {
  extractDeterministically,
  normalizePostingText,
  RequirementLabelsPendingError
} from "@internship-agent/jobs";

/**
 * Requirement labels come from the model or not at all: a failed or partial
 * classification holds the posting (no rule labels), the provider and
 * classifier recover from transient failures and budget overruns, and the
 * pipeline retries held postings. Every model here is a local fake.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-labels-"));
  temporaryDirectories.push(directory);
  return directory;
}

function disposableDatabase(): DatabaseSync {
  return createDatabase(join(temporaryDirectory(), "test.sqlite"));
}

const LONG_POSTING = `Data Platform Intern
Fictional Harbor Systems - Remote

About the role
Join a fictional data platform team for a summer internship building pipelines and internal tools.

Requirements:
- Experience with Python
- Experience with SQL
- Familiarity with Linux command line tools
- Experience with Git and code review
- Coursework in data structures and algorithms
- Experience writing unit tests
- Familiarity with REST APIs
- Experience with Docker containers
- Strong written communication skills
- Ability to work independently on a small project
- Familiarity with cloud storage services
- Experience reading technical documentation
`;

const SHORT_POSTING = `Software Engineering Intern
Fictional Lantern Works - Remote

About the role
Join a fictional tools team for a summer internship working on developer tooling for internal teams.

Requirements:
- Experience with Python
`;

function posting(content: string, sourceUrl: string, title = "Data Platform Intern") {
  return { title, companyName: "Fictional Harbor Systems", content, sourceUrl };
}

const LONG_URL = "https://job-boards.greenhouse.io/fictional/jobs/1001";
const SHORT_URL = "https://job-boards.greenhouse.io/fictional/jobs/1002";

/** Indices of the numbered requirement lines in a classification request. */
function numberedLines(input: string): number[] {
  return [...input.matchAll(/^(\d+)\. /gm)].map((line) => Number(line[1]));
}

function decisionsFor(input: string) {
  return numberedLines(input).map((index) => ({
    index, category: "PREFERRED", subject: "SKILL", assertion: "STATED", confidence: 0.9
  }));
}

type ScriptedCall = { items: number; input: string; maxOutputTokens: number | undefined; reasoningEffort: string | undefined };

/** A model fake. `fail` may throw for a call; `decisions` may change the answer. */
function scripted(options: {
  fail?: (call: ScriptedCall) => Error | null;
  decisions?: (input: string) => unknown[];
} = {}): ModelProvider & { calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  return {
    available: true,
    calls,
    async complete<T>(request: StructuredRequest<T>) {
      const call = {
        items: numberedLines(request.input).length,
        input: request.input,
        maxOutputTokens: request.maxOutputTokens,
        reasoningEffort: request.reasoningEffort
      };
      calls.push(call);
      const failure = options.fail?.(call);
      if (failure) throw failure;
      const decisions = options.decisions ? options.decisions(request.input) : decisionsFor(request.input);
      return { value: request.schema.parse({ decisions }), model: "fake", inputTokens: 5, outputTokens: 7, reasoningTokens: 0, durationMs: 1 };
    }
  };
}

function virtualClock(): Clock {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

type FetchCall = { body: { max_tokens: number; reasoning_effort?: string; messages: Array<{ content: string }> }; signal: AbortSignal | null | undefined };

/** The OpenAI-compatible provider against an injected fetch; never the network. */
function fetchProvider(
  handler: (call: FetchCall, index: number) => Promise<Response> | Response,
  extra: { timeoutMs?: number } = {}
) {
  const calls: FetchCall[] = [];
  const slept: number[] = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "https://model.example.test/v1",
    apiKey: "test-key",
    models: { cheap: "test-model" },
    fetch: (async (_url: string, init: RequestInit) => {
      const call = { body: JSON.parse(String(init.body)), signal: init.signal };
      calls.push(call);
      return handler(call, calls.length - 1);
    }) as unknown as typeof fetch,
    rateLimiter: new ModelRateLimiter({ requestsPerMinute: 6_000, tokensPerMinute: 100_000_000 }, virtualClock()),
    sleep: async (ms) => { slept.push(ms); },
    ...extra
  });
  return { provider, calls, slept };
}

function userInput(call: FetchCall): string {
  return call.body.messages[call.body.messages.length - 1]!.content;
}

function completion(content: string | null, finishReason = "stop"): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function labelled(call: FetchCall): Response {
  return completion(JSON.stringify({ decisions: decisionsFor(userInput(call)) }));
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response("error", { status: code, statusText: `Status ${code}`, headers });
}

function requirementRows(database: DatabaseSync, jobId: string): Array<{ extraction: string }> {
  return database.prepare("SELECT extraction FROM job_requirements WHERE job_id = ?").all(jobId) as Array<{ extraction: string }>;
}

function candidateTexts(content: string): string[] {
  return extractDeterministically(normalizePostingText(content)).requirements.map((candidate) => candidate.text);
}

describe("requirement labels come from the model or not at all", () => {
  it("uses fixtures with enough requirement lines to batch and split", () => {
    expect(candidateTexts(LONG_POSTING).length).toBeGreaterThanOrEqual(10);
    expect(candidateTexts(SHORT_POSTING)).toHaveLength(1);
  });

  it("splits a batch that exhausts the output budget until every line has a model label", async () => {
    const database = disposableDatabase();
    const provider = scripted({
      fail: (call) => call.items > 2 ? new ModelOutputBudgetError("budget", { inputTokens: 100, outputTokens: 8_000 }) : null
    });
    const report = await ingestPosting(posting(LONG_POSTING, LONG_URL), { database, provider });
    const candidates = candidateTexts(LONG_POSTING);

    expect(report.requirementLabelsPending).toBeNull();
    const rows = requirementRows(database, report.jobId);
    expect(rows).toHaveLength(candidates.length);
    expect(rows.every((row) => row.extraction === "MODEL")).toBe(true);
    expect(provider.calls[0]).toMatchObject({ items: 10, maxOutputTokens: 8_000, reasoningEffort: "medium" });
    // Calls that succeeded carried at most two lines.
    const succeeded = provider.calls.filter((call) => call.items <= 2);
    expect(succeeded.reduce((sum, call) => sum + call.items, 0)).toBe(candidates.length);
    // Halves of the first batch keep that batch's budget rather than shrinking it.
    const firstBatch = candidates.slice(0, 10);
    for (const call of provider.calls.filter((entry) => firstBatch.some((text) => entry.input.includes(text)))) {
      expect(call.maxOutputTokens).toBeGreaterThanOrEqual(8_000);
    }
    expect(provider.calls.length).toBeLessThanOrEqual(48);
    expect(provider.calls.every((call) => call.reasoningEffort === "medium")).toBe(true);
  });

  it("retries a single line at doubled budgets, then holds the posting when it still overruns", async () => {
    const database = disposableDatabase();
    const budgetUntil = (threshold: number) => (call: FetchCall) =>
      call.body.max_tokens < threshold ? completion(null, "length") : labelled(call);

    const recovered = fetchProvider(budgetUntil(10_000));
    const success = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider: recovered.provider });
    expect(recovered.calls.map((call) => call.body.max_tokens)).toEqual([2_600, 5_200, 10_400]);
    expect(recovered.calls.every((call) => call.body.reasoning_effort === "medium")).toBe(true);
    expect(success.requirementLabelsPending).toBeNull();
    expect(requirementRows(database, success.jobId).map((row) => row.extraction)).toEqual(["MODEL"]);

    const exhausted = fetchProvider(budgetUntil(20_000));
    const held = await ingestPosting(posting(SHORT_POSTING, `${SHORT_URL}9`), { database, provider: exhausted.provider });
    expect(exhausted.calls.map((call) => call.body.max_tokens)).toEqual([2_600, 5_200, 10_400]);
    expect(held.requirementLabelsPending).toMatch(/^AI requirement labels unavailable; will retry/);
    expect(held.requirementLabelsPending).toContain("output budget");
    expect(requirementRows(database, held.jobId)).toHaveLength(0);
  });

  it("retries a network failure with backoff", async () => {
    const database = disposableDatabase();
    const { provider, calls, slept } = fetchProvider((call, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return labelled(call);
    });
    const report = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider });
    expect(report.requirementLabelsPending).toBeNull();
    expect(requirementRows(database, report.jobId).map((row) => row.extraction)).toEqual(["MODEL"]);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2_000]);
  });

  it("retries 503 and 500, gives up after five attempts, and never retries a 400", async () => {
    const database = disposableDatabase();
    const unavailable = fetchProvider((call, index) => index === 0 ? status(503, { "retry-after": "1" }) : labelled(call));
    const recovered = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider: unavailable.provider });
    expect(recovered.requirementLabelsPending).toBeNull();
    expect(unavailable.calls).toHaveLength(2);
    expect(unavailable.slept).toEqual([1_000]);

    const failing = fetchProvider(() => status(500));
    const held = await ingestPosting(posting(SHORT_POSTING, `${SHORT_URL}1`), { database, provider: failing.provider });
    expect(failing.calls).toHaveLength(5);
    expect(held.requirementLabelsPending).toContain("500");
    expect(requirementRows(database, held.jobId)).toHaveLength(0);

    const rejected = fetchProvider(() => status(400));
    const refused = await ingestPosting(posting(SHORT_POSTING, `${SHORT_URL}2`), { database, provider: rejected.provider });
    expect(rejected.calls).toHaveLength(1);
    expect(refused.requirementLabelsPending).toContain("400");
    expect(getRequirementLabelHold(database, refused.jobId)).not.toBeNull();
  });

  it("does not retry a 504 or its own timeout in the provider, but sends less work per request", async () => {
    const database = disposableDatabase();
    const gateway = fetchProvider((call) => numberedLines(userInput(call)).length > 1 ? status(504) : labelled(call));
    const split = await ingestPosting(posting(LONG_POSTING, LONG_URL), { database, provider: gateway.provider });
    expect(split.requirementLabelsPending).toBeNull();
    expect(requirementRows(database, split.jobId).every((row) => row.extraction === "MODEL")).toBe(true);
    expect(gateway.slept).toEqual([]);

    const alwaysGateway = fetchProvider(() => status(504));
    const heldGateway = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider: alwaysGateway.provider });
    expect(alwaysGateway.calls.map((call) => call.body.max_tokens)).toEqual([2_600, 5_200, 10_400]);
    expect(heldGateway.requirementLabelsPending).toContain("504");

    const hanging = fetchProvider((call) => new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    }), { timeoutMs: 20 });
    const heldTimeout = await ingestPosting(posting(SHORT_POSTING, `${SHORT_URL}3`), { database, provider: hanging.provider });
    expect(hanging.calls).toHaveLength(3);
    expect(hanging.slept).toEqual([]);
    expect(heldTimeout.requirementLabelsPending).toContain("timed out");
    expect(requirementRows(database, heldTimeout.jobId)).toHaveLength(0);
  });

  it("splits a batch the model labels incompletely, and holds a posting it never labels completely", async () => {
    const database = disposableDatabase();
    const partial = scripted({ decisions: (input) => {
      const all = decisionsFor(input);
      return all.length > 1 ? all.slice(0, -1) : all;
    } });
    const complete = await ingestPosting(posting(LONG_POSTING, LONG_URL), { database, provider: partial });
    expect(complete.requirementLabelsPending).toBeNull();
    const rows = requirementRows(database, complete.jobId);
    expect(rows).toHaveLength(candidateTexts(LONG_POSTING).length);
    expect(rows.every((row) => row.extraction === "MODEL")).toBe(true);

    const never = scripted({ decisions: () => [] });
    const held = await ingestPosting(posting(LONG_POSTING, `${LONG_URL}1`), { database, provider: never });
    expect(held.requirementLabelsPending).toContain("did not label every requirement");
    expect(requirementRows(database, held.jobId)).toHaveLength(0);
    expect(never.calls.length).toBeLessThanOrEqual(48);
    const failed = database.prepare(`
      SELECT COUNT(*) AS count FROM model_invocations WHERE task = 'job.requirement_classification' AND outcome = 'failed' AND source_url = ?
    `).get(`${LONG_URL}1`) as { count: number };
    expect(failed.count).toBe(never.calls.length);
  });

  it("stores a held posting with no requirement rows that cannot be analyzed or prepared", async () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    const { provider } = fetchProvider(() => { throw new TypeError("fetch failed"); });
    const report = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider });

    expect(report.requirementLabelsPending).toMatch(/^AI requirement labels unavailable; will retry/);
    expect(report.requirementLabelsPending).toContain("fetch failed");
    expect(getJobPosting(database, report.jobId)?.status).toBe("DISCOVERED");
    expect(requirementRows(database, report.jobId)).toHaveLength(0);
    expect(getRequirementLabelHold(database, report.jobId)?.reason).toBe(report.requirementLabelsPending);
    expect(listApplicationEvents(database, report.jobId).map((event) => event.detail)).toContain(report.requirementLabelsPending);
    expect(() => evaluateAndPersistMatch(report.jobId, { database })).toThrow(RequirementLabelsPendingError);
    expect(() => prepareApplication(report.jobId, { database })).toThrow(RequirementLabelsPendingError);
  });

  it("retries held labels on each pipeline pass and analyzes the posting once they arrive", async () => {
    const database = disposableDatabase();
    const dataDir = temporaryDirectory();
    seedDevelopmentData(database);
    const failing = scripted({ fail: () => new Error("fetch failed") });
    const report = await ingestPosting(posting(SHORT_POSTING, SHORT_URL, "Software Engineering Intern"), { database, provider: failing });
    expect(report.requirementLabelsPending).not.toBeNull();
    const fitProvider: ModelProvider = { available: false, complete: () => { throw new Error("no fit model"); } };
    const settings = { minFit: 0, autoApply: false };

    const waiting = await advancePipeline({ database, dataDir, settings, labelProvider: failing, fitProvider });
    expect(waiting.analyzed).not.toContain(report.jobId);
    expect(waiting.prepared.map((entry) => entry.jobId)).not.toContain(report.jobId);
    expect(getJobPosting(database, report.jobId)?.status).toBe("DISCOVERED");
    expect(getRequirementLabelHold(database, report.jobId)?.attempts).toBe(2);
    expect(waiting.errors).toContain("AI requirement labels unavailable; will retry: Fictional Harbor Systems — Software Engineering Intern.");

    const working = scripted();
    const resumed = await advancePipeline({ database, dataDir, settings, labelProvider: working, fitProvider });
    expect(getRequirementLabelHold(database, report.jobId)).toBeNull();
    const rows = requirementRows(database, report.jobId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.extraction === "MODEL")).toBe(true);
    expect(resumed.analyzed).toContain(report.jobId);
    expect(database.prepare("SELECT 1 FROM job_matches WHERE job_id = ?").get(report.jobId)).toBeTruthy();
    expect(listApplicationEvents(database, report.jobId).map((event) => event.detail))
      .toContain("Requirement labels came from the AI on retry.");
  });

  it("holds postings whose stored labels may have come from the rule fallback, without deleting or moving anything", async () => {
    const database = disposableDatabase();
    const unavailable: ModelProvider = { available: false, complete: () => { throw new Error("no model"); } };
    const recordFailedCall = (sourceUrl: string) => recordModelInvocation(database, {
      task: "job.requirement_classification", tier: "cheap", model: "unavailable", jobId: null, sourceUrl,
      inputTokens: 0, outputTokens: 0, durationMs: 0, outcome: "failed"
    });
    const a = await ingestPosting(posting(SHORT_POSTING, "https://example.test/jobs/a"), { database, provider: unavailable });
    recordFailedCall("https://example.test/jobs/b");
    const b = await ingestPosting(posting(SHORT_POSTING, "https://example.test/jobs/b"), { database, provider: scripted() });
    const c = await ingestPosting(posting(SHORT_POSTING, "https://example.test/jobs/c"), { database, provider: scripted() });
    recordFailedCall("https://example.test/jobs/d");
    const d = await ingestPosting(posting(SHORT_POSTING, "https://example.test/jobs/d"), { database, provider: scripted() });
    setJobStatus(database, d.jobId, null, "SUBMITTED");
    const counts = () => database.prepare("SELECT job_id, COUNT(*) AS count FROM job_requirements GROUP BY job_id ORDER BY job_id").all();
    const statuses = () => database.prepare("SELECT id, status FROM jobs ORDER BY id").all();
    const beforeCounts = counts();
    const beforeStatuses = statuses();

    const dryRun = holdFallbackRequirementLabels(database, { apply: false });
    expect(dryRun.held.map((item) => item.jobId)).toEqual([a.jobId, b.jobId]);
    expect(dryRun.held.map((item) => item.evidence)).toEqual([["rule-labels"], ["failed-model-call"]]);
    expect(dryRun.skipped.map((item) => item.jobId)).toEqual([d.jobId]);
    expect([...dryRun.held, ...dryRun.skipped, ...dryRun.alreadyHeld].map((item) => item.jobId)).not.toContain(c.jobId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM requirement_label_holds").get()).toEqual({ count: 0 });

    const applied = holdFallbackRequirementLabels(database, { apply: true });
    expect(applied.held.map((item) => item.jobId)).toEqual([a.jobId, b.jobId]);
    expect(getRequirementLabelHold(database, a.jobId)).not.toBeNull();
    expect(getRequirementLabelHold(database, b.jobId)).not.toBeNull();
    expect(getRequirementLabelHold(database, c.jobId)).toBeNull();
    expect(getRequirementLabelHold(database, d.jobId)).toBeNull();
    expect(statuses()).toEqual(beforeStatuses);
    expect(counts()).toEqual(beforeCounts);
    expect(holdFallbackRequirementLabels(database, { apply: false }).alreadyHeld.map((item) => item.jobId)).toEqual([a.jobId, b.jobId]);

    const relabel = await relabelHeldPostings(database, { provider: scripted() });
    expect(relabel.relabelled.sort()).toEqual([a.jobId, b.jobId].sort());
    for (const jobId of [a.jobId, b.jobId]) {
      expect(getRequirementLabelHold(database, jobId)).toBeNull();
      expect(requirementRows(database, jobId).every((row) => row.extraction === "MODEL")).toBe(true);
    }
  });

  it("keeps holds without a model, skips dismissed postings, and touches no provider when nothing is held", async () => {
    const database = disposableDatabase();
    const untouchable = {
      get available(): boolean { throw new Error("must not touch the provider"); },
      complete: () => { throw new Error("must not call the provider"); }
    } as ModelProvider;
    expect(await relabelHeldPostings(database, { provider: untouchable })).toEqual({ relabelled: [], reevaluated: [], errors: [] });

    const held = await ingestPosting(posting(SHORT_POSTING, SHORT_URL), { database, provider: scripted({ fail: () => new Error("fetch failed") }) });
    const hold = getRequirementLabelHold(database, held.jobId)!;
    const unavailable: ModelProvider = { available: false, complete: () => { throw new Error("no model"); } };
    const without = await relabelHeldPostings(database, { provider: unavailable });
    expect(without.errors).toEqual(["AI requirement labels unavailable; will retry: Fictional Harbor Systems — Data Platform Intern."]);
    expect(getRequirementLabelHold(database, held.jobId)).toEqual(hold);

    saveDiscoverySkip(database, { jobId: held.jobId, reason: "Not interested.", preferenceNote: null });
    const counting = scripted();
    const dismissed = await relabelHeldPostings(database, { provider: counting });
    expect(dismissed).toEqual({ relabelled: [], reevaluated: [], errors: [] });
    expect(counting.calls).toHaveLength(0);
    expect(getRequirementLabelHold(database, held.jobId)).toEqual(hold);
  });

  it("splits a batch whose answer is not JSON until every line has a model label", async () => {
    const database = disposableDatabase();
    const { provider } = fetchProvider((call) => numberedLines(userInput(call)).length > 1
      ? completion("not json at all")
      : labelled(call));
    const report = await ingestPosting(posting(LONG_POSTING, LONG_URL), { database, provider });
    expect(report.requirementLabelsPending).toBeNull();
  });
});
