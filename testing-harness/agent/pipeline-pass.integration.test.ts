import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addCompanySource, discoveryTimeBudgetLine, discoveryTimeBudgetMs, readDoorbellState, savePostSubmitEvidence, startDiscoveryTimeBudget
} from "@internship-agent/agent";
import {
  closeProfileDatabase, createDatabase, getJobMatch, listDiscoverySources, persistNormalizedPosting, resolveProfileDatabasePath, resolveProfileDataDirectory,
  saveApplicationPackage, saveBrowserRun, setJobStatus, updateBrowserRun
} from "@internship-agent/db";
import type { BrowserPage } from "@internship-agent/browser";

import { runPipelinePass, runWatchTick } from "../../packages/agent/scripts/pipeline-pass";
import type { DiscordFetch } from "../../packages/agent/src/discord-notify";
import type { PipelineReport } from "../../packages/agent/src/pipeline-orchestrator";

/**
 * The watcher and its pass share one cached handle per workspace. Against a
 * temporary data directory with no network: a GitHub fetcher and a source
 * fetch are injected, and the workspace has no postings, so the pass opens
 * no browser and calls no model.
 */
const LIST_URL = "https://github.com/SimplifyJobs/Summer2027-Internships";
const sha = (digit: string) => digit.repeat(40);
const pipelineEnv = ["INTERNSHIP_AGENT_AUTO_APPLY", "INTERNSHIP_AGENT_AUTO_SUBMIT", "INTERNSHIP_AGENT_TARGET_TERM", "GITHUB_TOKEN",
  "INTERNSHIP_AGENT_DISCORD_BOT_TOKEN", "INTERNSHIP_AGENT_DISCORD_USER_ID", "MODEL_API_KEY", "INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS"];

let directory = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "internship-agent-pass-"));
  saved = Object.fromEntries(["INTERNSHIP_AGENT_DATA_DIR", ...pipelineEnv].map((name) => [name, process.env[name]]));
  process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
  for (const name of pipelineEnv) delete process.env[name];
  // Seed the temporary real workspace with one watched list, outside the shared cache.
  const seed = createDatabase(resolveProfileDatabasePath("real"));
  addCompanySource("Simplify Summer 2027", LIST_URL, 6, seed);
  seed.close();
});

afterEach(() => {
  closeProfileDatabase("real");
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("pipeline watcher pass", () => {
  it("runs the pass after its own sources read, tick after tick in one process, and releases the lock", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    expect(dataDir.startsWith(directory)).toBe(true);
    let head = sha("a");
    const fetcher = async () => new Response(head, { headers: { etag: `"${head.slice(0, 4)}"` } });
    const fetched: string[] = [];
    const fetchBatch = async (source: { label: string; url: string }) => { fetched.push(source.url); return []; };

    for (const next of ["a", "b"]) {
      head = sha(next);
      const lines: string[] = [];
      await runWatchTick({ profile: "real", log: (line) => lines.push(line), fetcher, fetchBatch });
      expect(lines.filter((line) => line.startsWith("Pass failed"))).toEqual([]);
      expect(lines).toContain("Doorbell: new commits on Simplify Summer 2027.");
      // The pass opened the workspace, reached the source, and finished.
      expect(lines, lines.join("\n")).toContainEqual(expect.stringMatching(/^Workspace real;/));
      expect(lines, lines.join("\n")).toContainEqual(expect.stringMatching(/^Analyzed 0 left over;/));
      expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);
      // Saved only after a pass that finished.
      expect(Object.values(readDoorbellState(dataDir))[0]?.sha).toBe(sha(next));
    }
    // The first pass fetched the list; the second, a minute's rate limit later, still opened the workspace and finished.
    expect(fetched).toEqual([LIST_URL]);
    // The checked source wrote its discovery trace in the workspace's data directory.
    const traceFiles = readdirSync(join(dataDir, "discovery-traces"));
    expect(traceFiles).toHaveLength(1);
    expect(traceFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const traceLines = readFileSync(join(dataDir, "discovery-traces", traceFiles[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; list: string });
    expect(traceLines.some((line) => line.type === "pass" && line.list === LIST_URL)).toBe(true);
    expect(traceLines.some((line) => line.type === "end" && line.list === LIST_URL)).toBe(true);
  });

  it("releases the pipeline lock when the pass fails early", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const failingLog = () => { throw new Error("log unavailable"); };
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: failingLog })).rejects.toThrow("log unavailable");
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    // The next pass can take the lock and open the workspace again.
    const lines: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^Workspace real;/);
  });

  it("DMs what is new after releasing the lock, once per item, and a failed DM never fails the pass", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = "123456789012345678";
    const dataDir = resolveProfileDataDirectory("real");
    const report: PipelineReport = {
      analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [],
      submitted: [{ jobId: "9f0c2f4e-0000-4000-8000-000000000001", confirmation: "Thanks" }],
      errors: ["Preparation failed for x: boom"]
    };
    const advance = async () => report;

    const failing: DiscordFetch = async () => new Response("{}", { status: 500 });
    const failedLines: string[] = [];
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: (line) => failedLines.push(line), advance, notify: { fetch: failing } }))
      .resolves.toBe(report);
    expect(failedLines).toContain("Discord notify failed: 500");
    for (const line of failedLines) expect(line).not.toContain(TOKEN);
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);

    const { fetch, calls, contents } = recordingFetch(dataDir);
    await runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } });
    expect(calls).toEqual([false, false]);
    const sent = contents.join("\n");
    expect(sent).not.toContain("Preparation failed for x: boom");
    expect(sent).toContain("Unknown posting (job ");
    expect(sent).not.toContain("Thanks");

    await runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } });
    expect(calls).toHaveLength(2);
  });

  it("does not send a second approval request and sends a later browser correction once", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = "123456789012345678";
    const dataDir = resolveProfileDataDirectory("real");
    const database = createDatabase(resolveProfileDatabasePath("real"));
    const companyName = "Fixture Employer";
    const sourceUrl = "https://example.test/jobs/correction";
    const { jobId } = persistNormalizedPosting(database, {
      companyName, title: "Intern", employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
      sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: "browser-correction",
      normalizedText: "Fixture application",
      locations: [], compensation: null, requirements: [], technologies: [],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
    setJobStatus(database, jobId, "DISCOVERED", "APPLYING");
    const now = new Date().toISOString();
    const packageId = randomUUID();
    saveApplicationPackage(database, { id: packageId, jobId, createdAt: now, summary: "Fixture", answers: [], bullets: [], claims: [] });
    const run = saveBrowserRun(database, {
      id: randomUUID(), jobId, applicationUrl: sourceUrl, status: "awaiting-approval", packageId,
      variantId: null, baseResumeId: null, applicationProfile: "default",
      atsKind: "greenhouse", atsConfidence: 1, atsConfirmed: true, suggestedAtsKind: null,
      pauses: [], decisions: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: now,
      createdAt: now, updatedAt: now
    });
    const { fetch, contents } = recordingFetch(dataDir);
    // The seeded run has a submit approval, so the pass's receipt check is replaced: no test reads a real mailbox.
    const receipts = async () => ({ pending: 0, mailbox: "none-pending" as const, confirmed: [] });
    const pass = () => runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, notify: { fetch }, receipts,
      advance: async () => ({ analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [] }) });
    await pass();
    expect(contents).toEqual([]);

    const pause = { suggestedKey: null, suggestedScope: null, sensitive: false, upload: false, status: "open" as const, answer: null, draft: null };
    updateBrowserRun(database, run.id, { status: "paused-needs-input", submissionApprovedAt: null, pauses: [
      { ...pause, fieldId: "unknown", label: "Unlabeled input control 1", question: "Unlabeled input control 1", safeguard: false },
      { ...pause, fieldId: "site-error-1", label: "Applicant jordan@example.test", question: "Correct the value", safeguard: true }
    ] });
    await savePostSubmitEvidence({
      database, dataDir, run, page: { screenshot: async () => {} } as BrowserPage,
      evidence: {
        outcome: "field-errors", url: sourceUrl, bodyText: "", alertText: "", challenge: null,
        invalidFields: [{ ref: null, label: "Applicant jordan@example.test", error: "Correct the value" }]
      }
    });
    database.close();
    await pass();
    await pass();
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain('Q2 fix this field in the browser: "Applicant [email]"');
    expect(contents[0]).not.toMatch(/Unlabeled|CAPTCHA|jordan@example.test/);
  });

  it("a pass that throws releases the lock and rethrows without interrupting the candidate", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = "123456789012345678";
    const dataDir = resolveProfileDataDirectory("real");
    const advance = async (): Promise<PipelineReport> => { throw new Error("database is not open"); };
    const { fetch, calls, contents } = recordingFetch(dataDir);

    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } }))
      .rejects.toThrow("database is not open");
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(calls).toEqual([]);
    expect(contents).toEqual([]);

    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } }))
      .rejects.toThrow("database is not open");
    expect(calls).toHaveLength(0);
  });

  it("logs postings pursued on AI fit and writes them to pipeline-status.json", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const jobId = randomUUID();
    const pursuedOnFit = { score: 86, unverified: ["Experience with Elixir"] };
    const advance = async (): Promise<PipelineReport> => ({
      analyzed: [], prepared: [{ jobId, status: "READY_FOR_REVIEW", pursuedOnFit }], started: [], stopped: [], waiting: [],
      held: [], skipped: [], submitted: [], errors: []
    });
    const lines: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => lines.push(line), advance });
    expect(lines).toContainEqual(expect.stringMatching(/^  pursued on AI fit 86 .*: unverified Experience with Elixir$/));
    const status = JSON.parse(readFileSync(join(dataDir, "pipeline-status.json"), "utf8")) as { pursuedOnFit: unknown };
    expect(status.pursuedOnFit).toEqual([{ job: jobId, jobId, fit: 86, unverified: ["Experience with Elixir"] }]);
  });

  it("checks public boards four at a time, at most once per 6 hours, and backs failing boards off", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    seed.prepare("UPDATE discovery_sources SET enabled = 0 WHERE url LIKE 'https://github.com/%'").run();
    const boards = [
      addCompanySource("Alpha Freight", "https://boards.greenhouse.io/alpha", 6, seed),
      addCompanySource("Bravo Analytics", "https://boards.greenhouse.io/bravo", 6, seed),
      addCompanySource("Charlie Robotics", "https://jobs.lever.co/charlie", 6, seed),
      addCompanySource("Delta Health", "https://jobs.ashbyhq.com/delta", 6, seed),
      addCompanySource("Gone Systems", "https://boards.greenhouse.io/gone", 6, seed),
      addCompanySource("Flaky Energy", "https://jobs.lever.co/flaky", 6, seed)
    ];
    seed.close();
    const [alpha, bravo, charlie, delta, gone, flaky] = boards.map((board) => board.id);
    const endpoint: Record<string, string> = {
      [alpha!]: "https://boards-api.greenhouse.io/v1/boards/alpha/jobs?content=true",
      [bravo!]: "https://boards-api.greenhouse.io/v1/boards/bravo/jobs?content=true",
      [charlie!]: "https://api.lever.co/v0/postings/charlie?mode=json",
      [delta!]: "https://api.ashbyhq.com/posting-api/job-board/delta",
      [gone!]: "https://boards-api.greenhouse.io/v1/boards/gone/jobs?content=true",
      [flaky!]: "https://api.lever.co/v0/postings/flaky?mode=json"
    };
    let requested: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const senior = (slug: string) => JSON.stringify({ jobs: [
      { title: "Senior Engineer", absolute_url: `https://boards.greenhouse.io/${slug}/jobs/1`, content: "A fictional senior role." }
    ] });
    const boardFetcher = async (url: string) => {
      requested.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (url === endpoint[alpha!]) return new Response(senior("alpha"), { status: 200 });
        if (url === endpoint[bravo!]) return new Response(senior("bravo"), { status: 200 });
        if (url === endpoint[charlie!]) return new Response("[]", { status: 200 });
        if (url === endpoint[delta!]) return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
        if (url === endpoint[gone!]) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        throw new TypeError("fetch failed");
      } finally {
        inFlight -= 1;
      }
    };
    const advance = async (): Promise<PipelineReport> => ({
      analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: []
    });
    const pass = async () => {
      requested = [];
      const lines: string[] = [];
      await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => lines.push(line), boardFetcher, advance });
      return lines;
    };
    const withDatabase = <T>(read: (database: ReturnType<typeof createDatabase>) => T): T => {
      const database = createDatabase(resolveProfileDatabasePath("real"));
      try { return read(database); } finally { database.close(); }
    };
    const health = () => withDatabase((database) => new Map(listDiscoverySources(database).map((source) => [source.id, source])));
    const moveFetches = (hoursAgo: number) => withDatabase((database) => {
      database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE url NOT LIKE 'https://github.com/%'")
        .run(new Date(Date.now() - hoursAgo * 3_600_000).toISOString());
    });

    const first = await pass();
    const firstAt = Date.now();
    expect(requested.slice().sort()).toEqual(Object.values(endpoint).sort());
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(first, first.join("\n")).toContain("Public boards: checked 6 (2 failed), not due 0, backed off 0, left for a later pass 0.");
    expect(first).toContain("Gone Systems: The public board answered 404.");
    expect(first).toContain("Flaky Energy: fetch failed");
    // Empty boards are not logged one by one.
    expect(first.some((line) => line.startsWith("Alpha Freight:"))).toBe(false);
    let sources = health();
    expect(sources.get(gone!)).toMatchObject({ failureCount: 1 });
    expect(sources.get(gone!)?.lastError).toContain("404");
    expect(Math.abs(Date.parse(sources.get(gone!)!.retryAfter!) - (firstAt + 7 * 24 * 3_600_000))).toBeLessThan(60_000);
    expect(sources.get(flaky!)).toMatchObject({ failureCount: 1, lastError: "fetch failed" });
    expect(Math.abs(Date.parse(sources.get(flaky!)!.retryAfter!) - (firstAt + 12 * 3_600_000))).toBeLessThan(60_000);
    for (const id of [alpha, bravo, charlie, delta]) expect(sources.get(id!)).toMatchObject({ failureCount: 0, retryAfter: null });
    const traceFile = join(dataDir, "discovery-traces", readdirSync(join(dataDir, "discovery-traces"))[0]!);
    const fetchLines = () => readFileSync(traceFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string }).filter((line) => line.type === "fetch");
    expect(fetchLines()).toHaveLength(6);
    const status = JSON.parse(readFileSync(join(dataDir, "pipeline-status.json"), "utf8")) as { sources: string[] };
    expect(status.sources.slice().sort()).toEqual(boards.map((board) => board.label).sort());

    // An hour later nothing is due: the healthy boards wait 6 hours, the failing ones are backed off.
    moveFetches(1);
    const second = await pass();
    expect(requested).toEqual([]);
    expect(second).toContain("Public boards: checked 0 (0 failed), not due 4, backed off 2, left for a later pass 0.");

    // Seven hours later the healthy boards are due again; the failing ones are still backed off.
    moveFetches(7);
    await pass();
    expect(requested.slice().sort()).toEqual([endpoint[alpha!], endpoint[bravo!], endpoint[charlie!], endpoint[delta!]].sort());

    // Once its back-off ends, the failing board is retried alone and backed off twice as long.
    withDatabase((database) => database.prepare("UPDATE discovery_sources SET retry_after = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), flaky!));
    await pass();
    const retriedAt = Date.now();
    expect(requested).toEqual([endpoint[flaky!]]);
    sources = health();
    expect(sources.get(flaky!)?.failureCount).toBe(2);
    expect(Math.abs(Date.parse(sources.get(flaky!)!.retryAfter!) - (retriedAt + 24 * 3_600_000))).toBeLessThan(60_000);
    expect(sources.get(gone!)?.failureCount).toBe(1);
  });

  it("reads the discovery time budget setting and honors it on a fake clock", () => {
    expect(discoveryTimeBudgetMs({})).toBe(900_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: "120000" })).toBe(120_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: " 300000 " })).toBe(300_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: "5" })).toBe(60_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: "99999999999" })).toBe(21_600_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: "abc" })).toBe(900_000);
    expect(discoveryTimeBudgetMs({ INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: "-5" })).toBe(900_000);

    let t = 1_000;
    const budget = startDiscoveryTimeBudget(60_000, () => t);
    t = 60_999;
    expect(budget.spent()).toBe(false);
    t = 61_000;
    expect(budget.spent()).toBe(true);
    expect(discoveryTimeBudgetLine(budget)).toBeNull();
    budget.deferBoard();
    budget.deferBoard();
    budget.deferPosting();
    expect(discoveryTimeBudgetLine(budget)).toBe("discovery: 2 boards and 1 posting left for the next pass (budget).");
  });

  it("a pass past its discovery time budget defers the rest of its analysis, still reads boards up to the floor, still runs the application step, and the next pass resumes them oldest first", async () => {
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    const boards = [
      addCompanySource("Alpha Freight", "https://boards.greenhouse.io/alpha", 6, seed),
      addCompanySource("Bravo Analytics", "https://jobs.lever.co/bravo", 6, seed),
      addCompanySource("Charlie Robotics", "https://jobs.ashbyhq.com/charlie", 6, seed)
    ];
    seed.close();
    const posting = (title: string, id: number) => ({
      title, companyName: "Kestrel Freight", sourceUrl: `https://boards.greenhouse.io/kestrel/jobs/${id}`,
      text: `${title} - Kestrel Freight\nLocation: Seattle, WA\n` +
        "Kestrel Freight builds fictional logistics software for this project's synthetic fixtures.\n" +
        "Requirements:\n- Experience with Python or TypeScript\n- Enrolled in a Bachelor's degree program in Computer Science"
    });
    const titles = ["S1", "V1", "V2", "V3", "V4"].map((suffix) => `Software Engineering Intern ${suffix}`);
    const items = titles.map((title, index) => posting(title, 101 + index));
    const fetched: string[] = [];
    let listCalls = 0;
    const fetchBatch = async (source: { label: string; url: string }) => {
      fetched.push(source.url);
      if (source.url !== LIST_URL) return { items: [], notes: ["No internship postings on this board right now."] };
      listCalls += 1;
      return listCalls === 1 ? { items, notes: [] } : { items: [], notes: ["Nothing new on the list."] };
    };
    // One read starts the budget and one per spent() check: the default 15 minutes allows two checks, then it is spent.
    let reads = 0;
    const discoveryClock = () => (reads += 1) * 400_000;
    const withDatabase = <T>(read: (database: ReturnType<typeof createDatabase>) => T): T => {
      const database = createDatabase(resolveProfileDatabasePath("real"));
      try { return read(database); } finally { database.close(); }
    };
    const state = () => withDatabase((database) => {
      const rows = database.prepare("SELECT id, title, status FROM jobs").all() as Array<{ id: string; title: string; status: string }>;
      return new Map(rows.map((row) => [row.title, { status: row.status, matched: Boolean(getJobMatch(database, row.id)) }]));
    });
    const boardFetches = () => withDatabase((database) => listDiscoverySources(database)
      .filter((source) => boards.some((board) => board.id === source.id)).map((source) => source.lastFetchedAt));

    reads = 0;
    const first: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => first.push(line), fetchBatch, discoveryClock });
    let jobs = state();
    expect(jobs.get(titles[0]!)?.matched, first.join("\n")).toBe(true);
    expect(jobs.get(titles[1]!)?.matched).toBe(true);
    for (const title of titles.slice(2)) expect(jobs.get(title)).toEqual({ status: "DISCOVERED", matched: false });
    // Past the budget the boards are still read, up to the floor of 20 per pass (Track 73).
    expect(fetched[0]).toBe(LIST_URL);
    expect(fetched.slice(1).sort()).toEqual(boards.map((board) => board.url).sort());
    expect(boardFetches().every((at) => at !== null)).toBe(true);
    expect(first).toContainEqual(expect.stringMatching(/^Simplify Summer 2027: fetched 5, duplicates 0, new 5, prepared \d+\. 3 left for the next pass \(budget\)\./));
    expect(first).toContain("Public boards: checked 3 (0 failed), not due 0, backed off 0, left for a later pass 0, read past the time budget 3.");
    const firstDeferred = first.indexOf("discovery: 0 boards and 3 postings left for the next pass (budget).");
    expect(firstDeferred).toBeGreaterThanOrEqual(0);
    expect(first.findIndex((line) => /^Analyzed 0 left over;/.test(line))).toBeGreaterThan(firstDeferred);

    // V4 is now the oldest, then V2, then V3; the list's rate limit is an hour behind.
    withDatabase((database) => {
      const age = database.prepare("UPDATE jobs SET created_at = ? WHERE title = ?");
      age.run("2026-01-01T00:00:00.000Z", titles[4]!);
      age.run("2026-01-02T00:00:00.000Z", titles[2]!);
      age.run("2026-01-03T00:00:00.000Z", titles[3]!);
      database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE url = ?")
        .run(new Date(Date.now() - 3_600_000).toISOString(), LIST_URL);
    });

    reads = 0;
    const second: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => second.push(line), fetchBatch, discoveryClock });
    jobs = state();
    expect(jobs.get(titles[4]!)?.matched, second.join("\n")).toBe(true);
    expect(jobs.get(titles[2]!)?.matched).toBe(true);
    expect(jobs.get(titles[3]!)).toEqual({ status: "DISCOVERED", matched: false });
    expect(second).toContainEqual(expect.stringMatching(/^Deferred postings: 3 from earlier passes; analyzed 2, prepared \d+, still waiting 1\./));
    expect(second).toContain("Public boards: checked 0 (0 failed), not due 3, backed off 0, left for a later pass 0.");
    expect(second).toContain("discovery: 0 boards and 1 posting left for the next pass (budget).");
    expect(second).toContainEqual(expect.stringMatching(/^Analyzed 0 left over;/));
    expect(fetched.slice(4)).toEqual([LIST_URL]);
  });

  it("a doorbell pass also checks the public boards that are due, and a quiet tick checks none (Track 73)", async () => {
    const seed = createDatabase(resolveProfileDatabasePath("real"));
    addCompanySource("Alpha Freight", "https://boards.greenhouse.io/alpha", 6, seed);
    seed.close();
    let tick = 0;
    const fetcher = async () => tick === 1
      ? new Response(sha("c"), { headers: { etag: '"cccc"' } })
      : new Response(null, { status: 304 });
    const fetched: string[] = [];
    const fetchBatch = async (source: { label: string; url: string }) => {
      fetched.push(source.url);
      return source.url === LIST_URL ? [] : { items: [], notes: ["No internship postings on this board right now."] };
    };

    tick = 1;
    const first: string[] = [];
    await runWatchTick({ profile: "real", log: (line) => first.push(line), fetcher, fetchBatch });
    expect(first, first.join("\n")).toContain("Doorbell: new commits on Simplify Summer 2027.");
    expect(fetched.slice().sort()).toEqual(["https://boards.greenhouse.io/alpha", LIST_URL].sort());
    expect(first).toContain("Public boards: checked 1 (0 failed), not due 0, backed off 0, left for a later pass 0.");

    tick = 2;
    const second: string[] = [];
    await runWatchTick({ profile: "real", log: (line) => second.push(line), fetcher, fetchBatch });
    expect(fetched).toHaveLength(2);
    expect(second.some((line) => line.startsWith("Workspace real;")), second.join("\n")).toBe(false);
    expect(second.some((line) => line.startsWith("Public boards:"))).toBe(false);
  });

  it("resumes a revised posting whose analysis an earlier pass's budget left (Track 73)", async () => {
    const postingUrl = "https://boards.greenhouse.io/kestrel/jobs/301";
    const text = "Software Engineering Intern - Kestrel Freight\nLocation: Seattle, WA\n" +
      "Kestrel Freight builds fictional logistics software for this project's synthetic fixtures.\n" +
      "Requirements:\n- Experience with Python or TypeScript\n- Enrolled in a Bachelor's degree program in Computer Science";
    let listText: string | null = text;
    const fetchBatch = async (source: { label: string; url: string }) => {
      if (source.url !== LIST_URL || listText === null) return { items: [], notes: ["Nothing new on the list."] };
      return { items: [{ title: "Software Engineering Intern", companyName: "Kestrel Freight", sourceUrl: postingUrl, text: listText }], notes: [] };
    };
    const withDatabase = <T>(read: (database: ReturnType<typeof createDatabase>) => T): T => {
      const database = createDatabase(resolveProfileDatabasePath("real"));
      try { return read(database); } finally { database.close(); }
    };
    const times = () => withDatabase((database) => database.prepare(`
      SELECT m.evaluated_at AS evaluated, s.captured_at AS captured FROM jobs j
      JOIN job_snapshots s ON s.job_id = j.id AND s.superseded_at IS NULL
      LEFT JOIN job_matches m ON m.job_id = j.id WHERE j.source_url = ?
    `).get(postingUrl) as { evaluated: string | null; captured: string });
    const listAnHourBack = () => withDatabase((database) => {
      database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE url = ?").run(new Date(Date.now() - 3_600_000).toISOString(), LIST_URL);
    });

    // Pass 1, unspent budget: the posting is stored and analyzed.
    const first: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => first.push(line), fetchBatch, discoveryClock: () => 0 });
    expect(times().evaluated, first.join("\n")).not.toBeNull();
    // The first snapshot and its analysis both predate the revision below, whatever the clock's resolution.
    withDatabase((database) => {
      database.prepare("UPDATE job_snapshots SET captured_at = ?").run("2025-12-31T00:00:00.000Z");
      database.prepare("UPDATE job_matches SET evaluated_at = ?").run("2026-01-01T00:00:00.000Z");
    });

    // Pass 2, budget spent at once: the revision is stored and its analysis waits.
    listAnHourBack();
    listText = text + "\nInterns present their feature to the team at the end of the term.";
    let reads = 0;
    const second: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => second.push(line), fetchBatch, discoveryClock: () => (reads += 1) * 1_000_000 });
    expect(second, second.join("\n")).toContainEqual(expect.stringMatching(/^Simplify Summer 2027: .* 1 left for the next pass \(budget\)\./));
    let stamps = times();
    expect(stamps.evaluated! < stamps.captured).toBe(true);

    // Pass 3, unspent budget, nothing new on the list: the revision is analyzed again.
    listAnHourBack();
    listText = null;
    const third: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: "all", log: (line) => third.push(line), fetchBatch, discoveryClock: () => 0 });
    expect(third, third.join("\n")).toContainEqual(expect.stringMatching(/^Deferred postings: 1 from earlier passes; analyzed 1, prepared \d+, still waiting 0\./));
    stamps = times();
    expect(stamps.evaluated! >= stamps.captured).toBe(true);
  });

  it("refreshes the blocker board after every pass: one snapshot and one Board line per pass", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const database = createDatabase(resolveProfileDatabasePath("real"));
    const pauseFields = { suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false, upload: false, status: "open" as const, answer: null, draft: null };
    for (const [index, labels] of [["Are you over 18?", "What is your expected graduation term?"], ["Are you over 18?"]].entries()) {
      const sourceUrl = `https://example.test/jobs/board-${index}`;
      const { jobId } = persistNormalizedPosting(database, {
        companyName: `Board Employer ${index}`, title: "Intern", employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
        sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `board-${index}`, normalizedText: "Fixture application",
        locations: [], compensation: null, requirements: [], technologies: [],
        constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
      });
      setJobStatus(database, jobId, "DISCOVERED", "APPLYING");
      const now = new Date().toISOString();
      const packageId = randomUUID();
      saveApplicationPackage(database, { id: packageId, jobId, createdAt: now, summary: "Fixture", answers: [], bullets: [], claims: [] });
      saveBrowserRun(database, {
        id: randomUUID(), jobId, applicationUrl: sourceUrl, status: "paused-needs-input", packageId, variantId: null, baseResumeId: null,
        applicationProfile: "default", atsKind: "greenhouse", atsConfidence: 1, atsConfirmed: true, suggestedAtsKind: null,
        pauses: labels.map((label) => ({ ...pauseFields, fieldId: randomUUID(), label, question: label })),
        decisions: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: now, updatedAt: now
      });
    }
    database.close();
    const advance = async (): Promise<PipelineReport> => ({ analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [] });
    const snapshots = () => existsSync(join(dataDir, "scoreboard"))
      ? readdirSync(join(dataDir, "scoreboard")).filter((name) => name.startsWith("snapshot-")) : [];
    expect(snapshots()).toEqual([]);

    const first: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => first.push(line), advance });
    expect(snapshots()).toHaveLength(1);
    expect(first.filter((line) => line.startsWith("Board:")), first.join("\n")).toEqual([
      'Board: 2 applications held; top blockers: question: "are you over 18" 2, question: "what is your expected graduation term" 1 (snapshot saved)'
    ]);
    const saved = JSON.parse(readFileSync(join(dataDir, "scoreboard", snapshots()[0]!), "utf8")) as { heldApplications: number; blockers: unknown[] };
    expect(saved.heldApplications).toBe(2);
    expect(saved.blockers).toHaveLength(2);
    // The scoreboard reads the pass's own pipeline-status.json, written before the board.
    expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => second.push(line), advance });
    expect(snapshots()).toHaveLength(2);
    expect(second.filter((line) => line.startsWith("Board:"))).toHaveLength(1);
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
  });

  it("a board failure is one log line and never fails the pass", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const report: PipelineReport = { analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [] };
    const advance = async () => report;
    const lines: string[] = [];
    const scoreboard = () => { throw Object.assign(new Error("no such table: browser_runs"), { code: "ERR_SQLITE_ERROR" }); };
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: (line) => lines.push(line), advance, scoreboard })).resolves.toBe(report);
    expect(lines.filter((line) => line.startsWith("Board:"))).toEqual(["Board: not refreshed (ERR_SQLITE_ERROR); the pass is unaffected."]);
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);

    // A snapshot folder that cannot be written keeps the board line and the pass.
    writeFileSync(join(dataDir, "scoreboard"), "not a folder");
    const blocked: string[] = [];
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: (line) => blocked.push(line), advance })).resolves.toBe(report);
    expect(blocked.filter((line) => line.startsWith("Board:"))).toEqual(["Board: 0 applications held; no blockers (snapshot not saved: EEXIST)"]);
  });

  it("checks receipts each pass: a confirmed one counts as submitted, the rest are held possible submissions, never errors (Track 85)", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const [first, second] = [randomUUID(), randomUUID()];
    const [firstRun, secondRun] = [randomUUID(), randomUUID()];
    const reason = "The auto-submit policy clicked the final submit of the application at example.test and the page read as a confirmation, so it is held as a possible submission until a receipt check finds the site's receipt.";
    const advance = async (): Promise<PipelineReport> => ({
      analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [],
      possibleSubmissions: [{ jobId: first, runId: firstRun, reason }, { jobId: second, runId: secondRun, reason }]
    });
    const confirmation = "Confirmed by the employer's application receipt email (receipt check).";
    const seen: string[] = [];
    const receipts = async (input: { dataDir: string }) => {
      seen.push(input.dataDir);
      return { pending: 2, mailbox: "checked" as const, confirmed: [{ jobId: second, runId: secondRun, confirmation }] };
    };
    const lines: string[] = [];
    const report = await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => lines.push(line), advance, receipts });
    expect(seen).toEqual([dataDir]);
    expect(report.submitted).toEqual([{ jobId: second, confirmation }]);
    expect(report.possibleSubmissions).toEqual([{ jobId: first, runId: firstRun, reason }]);
    expect(report.errors).toEqual([]);
    expect(lines).toContain("Receipts: checked 2 possible submission(s) for an employer receipt; 1 marked submitted.");
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^  SUBMITTED ${second}: Confirmed by the employer's application receipt email`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^  sent, waiting for its receipt ${first}: The auto-submit policy clicked`)));
    expect(lines.some((line) => line.includes("Automatic submission failed"))).toBe(false);
    expect(lines).toContainEqual(expect.stringMatching(/^Analyzed 0 left over; .*submitted 1;/));
    const status = JSON.parse(readFileSync(join(dataDir, "pipeline-status.json"), "utf8")) as { possibleSubmissions: unknown; submitted: unknown; errors: unknown };
    expect(status.possibleSubmissions).toEqual([{ job: first, jobId: first, runId: firstRun, reason }]);
    expect(status.submitted).toEqual([{ job: second, jobId: second, confirmation }]);
    expect(status.errors).toEqual([]);

    const failing: string[] = [];
    const broken = async () => { throw Object.assign(new Error("mailbox gone"), { code: "ECONNRESET" }); };
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: (line) => failing.push(line), advance, receipts: broken })).resolves.toBeDefined();
    expect(failing).toContain("Receipts: not checked (ECONNRESET); the pass is unaffected.");
    expect(failing).toContainEqual(expect.stringMatching(/^Analyzed 0 left over;/));
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
  });
});

const TOKEN = "tok-SECRET-123";

/** A Discord fetch that answers the DM channel and the message, recording whether the pipeline lock was held at each call. */
function recordingFetch(dataDir: string) {
  const calls: boolean[] = [];
  const contents: string[] = [];
  const fetch: DiscordFetch = async (url, init) => {
    calls.push(existsSync(join(dataDir, "pipeline.lock")));
    if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "987654321" }), { status: 200 });
    contents.push(String((JSON.parse(String(init.body)) as { content: unknown }).content));
    return new Response("{}", { status: 200 });
  };
  return { fetch, calls, contents };
}
