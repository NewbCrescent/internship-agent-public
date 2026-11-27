import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  addCompanySource,
  applyBoardLocationBackfill,
  boardLocationBackfillLines,
  evaluateAndPersistMatch,
  fetchCompanySource,
  fetchPublicBoard,
  getApplicationPackage,
  ingestPosting,
  plainText,
  getDiscoveryRuns,
  getReviewQueue,
  planBoardLocationBackfill,
  processManualBatch,
  PROTECTED_POSTING_STATUSES,
  restoreDiscoveredJob,
  skipDiscoveredJobs,
  acquirePipelineLock,
  readPipelineLock,
  startDiscoveryTimeBudget,
  type DiscoveryFetchEvent,
  type DiscoveryRowEvent,
  type ModelProvider,
  type StructuredRequest
} from "@internship-agent/agent";
import {
  createDatabase,
  getJobPosting,
  holdRequirementLabels,
  listDiscoverySkips,
  listPostingsAwaitingAnalysis,
  listApplicationEvents,
  setJobStatus,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  listProjectEvidenceProfiles,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import { judgeLocation } from "@internship-agent/domain";
import { extractDeterministically } from "@internship-agent/jobs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-discovery-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** A strong posting mirrors the seeded demo winner under a new company name. */
const STRONG_POSTING = [
  "Software Engineering Intern - Meridian Tools",
  "Location: Seattle, WA",
  "",
  "Meridian Tools builds fictional developer infrastructure for this project's local demo.",
  "",
  "Requirements:",
  "- Must be enrolled in a Bachelor's degree program in Computer Science or a related field",
  "- Experience with Python or TypeScript",
  "- Available to start in June 2027",
  "",
  "Preferred qualifications:",
  "- Familiarity with Docker is a plus",
  "",
  "Applicants must be legally authorized to work in the United States."
].join("\n");

const WEAK_POSTING = [
  "Marketing Intern - Harbor Goods",
  "Location: Austin, TX",
  "",
  "Harbor Goods sells fictional outdoor gear and seeks a marketing intern for social campaigns.",
  "Requirements: enrolled in a marketing degree program, available part time in Austin."
].join("\n");

/** A fictional board posting whose description names no city, state, country, or work mode. */
const PLACELESS_POSTING = [
  "Juniper Lane Robotics builds fictional warehouse software for this project's tests. Interns ship one feature with a mentor.",
  "Requirements:",
  "- Experience with TypeScript or Python",
  "- Enrolled in a Bachelor's program"
].join("\n");

/** The country codes the deterministic extractor reads from a posting's text. */
function countries(text: string): string[] {
  return extractDeterministically(text).locations.map((location) => location.countryCode).filter((code): code is string => Boolean(code));
}

function qualifiedDatabase(): DatabaseSync {
  const database = disposableDatabase();
  seedDevelopmentData(database);
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    owner: "example",
    name: "evidence-demo",
    url: "https://github.com/example/evidence-demo",
    defaultBranch: "main",
    description: "Fixture evidence.",
    observedHeadSha: "sha-fixture"
  });
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    repositoryId: repository.id,
    name: "evidence-demo",
    summary: "Fixture project.",
    fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology",
      normalizedKey: "python",
      text: "Shipped Python services in production.",
      evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme",
        commitSha: "sha-fixture",
        path: "README.md",
        startLine: 2,
        endLine: 2,
        sourceUrl: "https://github.com/example/evidence-demo/blob/sha-fixture/README.md#L2",
        excerpt: "Python services in production.",
        excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0].claims[0];
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);
  return database;
}

describe("bulk discovery run", () => {
  it("dedupes a pasted batch, ingests, analyzes, and prepares the promoted posting", async () => {
    const database = qualifiedDatabase();
    const batch = [
      `Software Engineering Intern @ Meridian Tools\n${STRONG_POSTING}`,
      `Software Engineering Intern @ Meridian Tools\n${STRONG_POSTING.toUpperCase()}`,
      `Marketing Intern @ Harbor Goods\n${WEAK_POSTING}`
    ].join("\n===\n");

    const report = await processManualBatch(batch, { database, threshold: 60, limit: 5 });

    expect(report.run.fetched).toBe(3);
    expect(report.run.deduped).toBe(1);
    expect(report.run.ingested).toBe(2);
    expect(report.run.analyzed).toBe(2);
    expect(report.run.finishedAt).not.toBeNull();
    expect(report.jobIds).toHaveLength(2);
    expect(report.errors).toHaveLength(0);
    expect(report.promotedJobIds).toHaveLength(1);

    const promoted = getJobPosting(database, report.promotedJobIds[0]);
    expect(promoted?.companyName).toBe("Meridian Tools");
    expect(getJobPosting(database, report.promotedJobIds[0])?.status).toBe("READY_FOR_REVIEW");
    expect(getApplicationPackage(report.promotedJobIds[0], database)?.package.jobId).toBe(
      report.promotedJobIds[0]
    );
    expect(
      listApplicationEvents(database, report.promotedJobIds[0]).some(
        (event) => event.toStatus === "READY_FOR_REVIEW"
      )
    ).toBe(true);

    const runs = getDiscoveryRuns(5, database);
    expect(runs).toHaveLength(1);
    expect(runs[0].promoted).toBe(1);
    database.close();
  });

  it("leaves live applications untouched when their text is pasted again", async () => {
    const database = qualifiedDatabase();
    const sourceUrl = "https://example.test/meridian/1";
    const batch = [
      `Software Engineering Intern @ Meridian Tools\nSource: ${sourceUrl}\n${STRONG_POSTING}`,
      `Marketing Intern @ Harbor Goods\n${WEAK_POSTING}`
    ].join("\n===\n");

    const first = await processManualBatch(batch, { database, threshold: 60, limit: 5 });
    expect(first.promotedJobIds).toHaveLength(1);
    const live = first.promotedJobIds[0];
    const jobsBefore = (database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count;

    // The candidate moved on: the posting is submitted before the re-paste.
    setJobStatus(database, live, null, "SUBMITTED", "Fixture submission.");
    const eventsBefore = listApplicationEvents(database, live).length;
    const snapshotBefore = getJobPosting(database, live)?.snapshot;
    const snapshotsBefore = (database.prepare("SELECT COUNT(*) AS count FROM job_snapshots WHERE job_id = ?").get(live) as { count: number }).count;

    const revisedBatch = batch.replace("fictional developer infrastructure", "fictional cloud infrastructure");
    const second = await processManualBatch(revisedBatch, { database, threshold: 60, limit: 5 });
    expect(second.skippedJobIds).toEqual([live]);
    expect(second.jobIds).not.toContain(live);
    expect(second.run.ingested).toBe(0);
    expect(second.run.deduped).toBe(1);
    expect(second.errors).toHaveLength(0);
    expect(getJobPosting(database, live)?.status).toBe("SUBMITTED");
    expect(getJobPosting(database, live)?.snapshot).toEqual(snapshotBefore);
    expect((database.prepare("SELECT COUNT(*) AS count FROM job_snapshots WHERE job_id = ?").get(live) as { count: number }).count).toBe(snapshotsBefore);
    expect(listApplicationEvents(database, live)).toHaveLength(eventsBefore);
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(jobsBefore);
    database.close();
  });

  it("records batch skip feedback without editing preferences and keeps skipped jobs out of the queue", async () => {
    const database = qualifiedDatabase();
    const batch = `Software Engineering Intern @ Meridian Tools\nSource: https://example.test/meridian/skip\n${STRONG_POSTING}`;
    const first = await processManualBatch(batch, { database, threshold: 60 });
    const jobId = first.promotedJobIds[0];
    expect(getReviewQueue(database).some((entry) => entry.jobId === jobId)).toBe(true);
    skipDiscoveredJobs({ jobIds: [jobId], reason: "Wrong focus", preferenceNote: "Prefer backend roles" }, database);
    expect(getReviewQueue(database).some((entry) => entry.jobId === jobId)).toBe(false);
    expect(listDiscoverySkips(database)[0]).toMatchObject({ jobId, preferenceNote: "Prefer backend roles" });
    const second = await processManualBatch(batch, { database, threshold: 60 });
    expect(second.feedbackSkippedJobIds).toEqual([jobId]);
    expect(second.promotedJobIds).toHaveLength(0);
    restoreDiscoveredJob(jobId, database);
    expect(getReviewQueue(database).some((entry) => entry.jobId === jobId)).toBe(true);
    database.close();
  });

  it("refuses a garbage batch instead of recording an empty run", async () => {
    const database = qualifiedDatabase();
    let message = "";
    try {
      await processManualBatch("no header here\n===\nToo short @ Co\ntiny", { database });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(getDiscoveryRuns(5, database)).toHaveLength(0);
    database.close();
  });

  it("fetches a company source through an injected fetcher and promotes the winner", async () => {
    const database = qualifiedDatabase();
    const source = addCompanySource(
      "Meridian Tools",
      "https://boards.greenhouse.io/meridian",
      30,
      database
    );
    const fetchBatch = async () => [{
      title: "Software Engineering Intern",
      companyName: "Meridian Tools",
      text: STRONG_POSTING,
      sourceUrl: "https://careers.example.test/meridian/1"
    }];
    const report = await fetchCompanySource(source.id, {
      database,
      threshold: 60,
      limit: 5,
      fetchBatch
    });
    expect(report.run.sourceId).toBe(source.id);
    expect(report.run.ingested).toBe(1);
    expect(report.promotedJobIds).toHaveLength(1);

    // The persisted fetch stamp refuses an immediate second poll without fetching.
    let refused = "";
    try {
      await fetchCompanySource(source.id, {
        database,
        fetchBatch: async () => { throw new Error("must not fetch under rate limit"); }
      });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    expect(refused.includes("Rate limit")).toBe(true);
    database.close();
  });

  it("registers a selected GitHub list once and imports only resolved posting text", async () => {
    const database = qualifiedDatabase();
    const url = "https://github.com/SimplifyJobs/Summer2027-Internships";
    const source = addCompanySource("Summer 2027 internships", url, 60, database);
    expect(addCompanySource("Duplicate label", url + "/", 60, database).id).toBe(source.id);
    expect(source.rateLimitPerMinute).toBe(1);

    const report = await fetchCompanySource(source.id, {
      database,
      fetchBatch: async ({ url: fetchedUrl }) => {
        expect(fetchedUrl).toBe(url);
        return {
          items: [{
            companyName: "Meridian Tools",
            title: "Software Engineering Intern",
            text: STRONG_POSTING,
            sourceUrl: "https://job-boards.greenhouse.io/meridian/jobs/123"
          }],
          notes: ["One unsupported listing remains in the source repository for manual review."]
        };
      }
    });
    expect(report.run.ingested).toBe(1);
    expect(report.sourceNotes).toHaveLength(1);
    const posting = getJobPosting(database, report.jobIds[0]!);
    expect(posting?.snapshot?.normalizedText).toContain("Experience with Python or TypeScript");
    database.close();
  });

  it("writes the discovery trace for a checked source", async () => {
    const database = qualifiedDatabase();
    const traceDirectory = mkdtempSync(join(tmpdir(), "internship-agent-trace-"));
    temporaryDirectories.push(traceDirectory);
    const primer = addCompanySource("SWE 2027", "https://github.com/speedyapply/2027-SWE-College-Jobs", 60, database);
    const meridian = { companyName: "Meridian Tools", title: "Software Engineering Intern", text: STRONG_POSTING };
    await fetchCompanySource(primer.id, {
      database,
      fetchBatch: async () => ({ items: [{ ...meridian, sourceUrl: "https://job-boards.greenhouse.io/meridian/jobs/123" }], notes: [] })
    });
    const listUrl = "https://github.com/SimplifyJobs/Summer2027-Internships";
    const source = addCompanySource("Summer 2027", listUrl, 60, database);
    const harborUrl = "https://job-boards.greenhouse.io/harbor/jobs/456";
    const report = await fetchCompanySource(source.id, {
      database,
      traceDirectory,
      fetchBatch: async (_source, context) => {
        context.onRow?.({
          row: 1, company: "Harbor Goods", title: "Marketing Intern", url: harborUrl, host: "job-boards.greenhouse.io",
          decision: "resolved", reason: "full posting read", postingUrl: harborUrl
        });
        return {
          items: [
            { companyName: "Harbor Goods", title: "Marketing Intern", text: WEAK_POSTING, sourceUrl: harborUrl },
            { ...meridian, sourceUrl: "https://jobs.ashbyhq.com/meridian/abc" }
          ],
          notes: ["1 listed link was read."]
        };
      }
    });
    expect(report.traceError).toBeNull();
    expect(report.run.ingested).toBe(1);
    const traceFolder = join(traceDirectory, "discovery-traces");
    const files = readdirSync(traceFolder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = readFileSync(join(traceFolder, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line.type, line.decision ?? null])).toEqual([
      ["pass", null], ["row", "resolved"], ["ingest", "stored-new"], ["ingest", "duplicate"], ["end", null]
    ]);
    expect(lines.every((line) => line.list === listUrl)).toBe(true);
    expect(lines[2]).toMatchObject({ company: "Harbor Goods", postingUrl: harborUrl, jobId: report.jobIds[0] });
    expect(lines[3]).toMatchObject({ company: "Meridian Tools", reason: "the same posting (company, title, and text) is already stored" });
    expect(lines[4]!.counts).toEqual({ "stored-new": 1, duplicate: 1 });

    const failing = addCompanySource("Vansh 2027", "https://github.com/vanshb03/Summer2027-Internships", 60, database);
    await expect(fetchCompanySource(failing.id, {
      database,
      traceDirectory,
      fetchBatch: async () => { throw new Error("The GitHub job list answered 503."); }
    })).rejects.toThrow("The GitHub job list answered 503.");
    const after = readFileSync(join(traceFolder, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(after.at(-1)).toMatchObject({ type: "end", list: "https://github.com/vanshb03/Summer2027-Internships", error: "The GitHub job list answered 503." });
    database.close();
  });

  it("hands known posting links to the fetcher and records an all-known check as an empty run", async () => {
    const database = qualifiedDatabase();
    const firstSource = addCompanySource("Summer 2027", "https://github.com/SimplifyJobs/Summer2027-Internships", 60, database);
    const secondSource = addCompanySource("SWE 2027", "https://github.com/speedyapply/2027-SWE-College-Jobs", 60, database);
    await fetchCompanySource(firstSource.id, {
      database,
      fetchBatch: async () => ({
        items: [{
          companyName: "Meridian Tools",
          title: "Software Engineering Intern",
          text: STRONG_POSTING,
          sourceUrl: "https://boards.greenhouse.io/meridian/jobs/123?gh_jid=123"
        }],
        notes: []
      })
    });

    let received: ReadonlySet<string> = new Set();
    const report = await fetchCompanySource(secondSource.id, {
      database,
      fetchBatch: async (_source, { knownLinkKeys }) => {
        received = knownLinkKeys;
        return { items: [], notes: ["1 listed link was already in the workspace and not fetched again."] };
      }
    });
    expect(received.has("greenhouse:123")).toBe(true);
    expect(report.run).toMatchObject({ sourceId: secondSource.id, fetched: 0, deduped: 0, ingested: 0, analyzed: 0, promoted: 0 });
    expect(report.run.finishedAt).toBeTruthy();
    expect(report.sourceNotes).toEqual(["1 listed link was already in the workspace and not fetched again."]);
    database.close();
  });

  it("waits on the model for several postings at once, bounded by the configured concurrency", async () => {
    const database = qualifiedDatabase();
    const source = addCompanySource("Summer 2027", "https://github.com/SimplifyJobs/Summer2027-Internships", 60, database);
    let inFlight = 0;
    let peak = 0;
    const provider: ModelProvider = {
      available: true,
      async complete<T>(request: StructuredRequest<T>) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        // A complete model answer: one label per numbered requirement line.
        const decisions = [...request.input.matchAll(/^(\d+)\. /gm)].map((line) => ({
          index: Number(line[1]), category: "PREFERRED", subject: "SKILL", assertion: "STATED", confidence: 0.9
        }));
        return { value: request.schema.parse({ decisions }), model: "fake", inputTokens: 1, outputTokens: 1, reasoningTokens: 0, durationMs: 25 };
      }
    };
    const titles = Array.from({ length: 6 }, (_, index) => `Software Engineering Intern ${index + 1}`);
    const previous = process.env.INTERNSHIP_AGENT_MODEL_CONCURRENCY;
    process.env.INTERNSHIP_AGENT_MODEL_CONCURRENCY = "3";
    try {
      const report = await fetchCompanySource(source.id, {
        database,
        provider,
        fetchBatch: async () => ({
          items: titles.map((title, index) => ({
            companyName: "Meridian Tools", title,
            text: STRONG_POSTING.replace("Software Engineering Intern", title),
            sourceUrl: `https://job-boards.greenhouse.io/meridian/jobs/${900 + index}`
          })),
          notes: []
        })
      });
      expect(report.run.ingested).toBe(6);
      expect(peak).toBe(3);
      // Report order follows the source, not completion order.
      expect(report.jobIds.map((jobId) => getJobPosting(database, jobId)?.title)).toEqual(titles);
    } finally {
      if (previous === undefined) delete process.env.INTERNSHIP_AGENT_MODEL_CONCURRENCY;
      else process.env.INTERNSHIP_AGENT_MODEL_CONCURRENCY = previous;
    }
    database.close();
  });

  it("holds one pipeline lock per workspace and ignores a stale one", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "internship-agent-lock-"));
    temporaryDirectories.push(dataDir);
    expect(readPipelineLock(dataDir)).toBeNull();
    const release = acquirePipelineLock(dataDir);
    expect(readPipelineLock(dataDir)).toMatchObject({ pid: process.pid });
    expect(() => acquirePipelineLock(dataDir)).toThrow("already in progress");
    release();
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);

    // A lock left by a process that has exited never blocks a new run.
    const exited = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(join(dataDir, "pipeline.lock"), JSON.stringify({ pid: exited, startedAt: new Date().toISOString() }));
    expect(readPipelineLock(dataDir)).toBeNull();
    const again = acquirePipelineLock(dataDir);
    expect(readPipelineLock(dataDir)).toMatchObject({ pid: process.pid });
    again();
  });

  it("skips the same posting when two boards expose it under different URLs", async () => {
    const database = qualifiedDatabase();
    const firstSource = addCompanySource("Board A", "https://boards.greenhouse.io/meridian", 6, database);
    const secondSource = addCompanySource("Board B", "https://jobs.ashbyhq.com/meridian", 6, database);
    const posting = { companyName: "Meridian Tools", title: "Software Engineering Intern", text: STRONG_POSTING };
    const first = await fetchCompanySource(firstSource.id, {
      database,
      fetchBatch: async () => [{ ...posting, sourceUrl: "https://boards.greenhouse.io/meridian/jobs/123" }]
    });
    const jobId = first.jobIds[0]!;
    const snapshot = getJobPosting(database, jobId)?.snapshot;
    const events = listApplicationEvents(database, jobId).length;

    const second = await fetchCompanySource(secondSource.id, {
      database,
      fetchBatch: async () => [{ ...posting, text: STRONG_POSTING.toUpperCase(), sourceUrl: "https://jobs.ashbyhq.com/meridian/abc" }]
    });

    expect(second.run.deduped).toBe(1);
    expect(second.run.ingested).toBe(0);
    expect(second.jobIds).toHaveLength(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(2); // seeded placeholder + one posting
    expect(getJobPosting(database, jobId)?.snapshot).toEqual(snapshot);
    expect(listApplicationEvents(database, jobId)).toHaveLength(events);
    database.close();
  });

  it("keeps distinct requisitions that share a company and title", async () => {
    const database = qualifiedDatabase();
    const source = addCompanySource("Board", "https://boards.greenhouse.io/meridian", 6, database);
    const report = await fetchCompanySource(source.id, {
      database,
      fetchBatch: async () => [
        { companyName: "Meridian Tools", title: "Software Engineering Intern", text: STRONG_POSTING, sourceUrl: "https://boards.greenhouse.io/meridian/jobs/123" },
        { companyName: "Meridian Tools", title: "Software Engineering Intern", text: STRONG_POSTING.replace("Location: Seattle, WA", "Location: Austin, TX"), sourceUrl: "https://boards.greenhouse.io/meridian/jobs/456" }
      ]
    });
    expect(report.run.deduped).toBe(0);
    expect(report.run.ingested).toBe(2);
    expect(report.jobIds).toHaveLength(2);
    database.close();
  });

  it("keeps source-free postings from different companies even when their body text matches", async () => {
    const database = qualifiedDatabase();
    const batch = [
      `Software Engineering Intern @ Meridian Tools\n${STRONG_POSTING}`,
      `Software Engineering Intern @ Beacon Systems\n${STRONG_POSTING}`
    ].join("\n===\n");
    const report = await processManualBatch(batch, { database });
    expect(report.run.deduped).toBe(0);
    expect(report.run.ingested).toBe(2);
    expect(new Set(report.jobIds).size).toBe(2);
    database.close();
  });

  it("rate limits a failed source poll before another fetch can start", async () => {
    const database = qualifiedDatabase();
    const source = addCompanySource("Meridian Tools", "https://jobs.ashbyhq.com/meridian", 6, database);
    await expect(fetchCompanySource(source.id, {
      database,
      fetchBatch: async () => { throw new Error("temporary board error"); }
    })).rejects.toThrow("temporary board error");
    let attempted = false;
    await expect(fetchCompanySource(source.id, {
      database,
      fetchBatch: async () => { attempted = true; return []; }
    })).rejects.toThrow("Rate limit");
    expect(attempted).toBe(false);
    database.close();
  });

  it("reads bounded internship listings from an allowed public board and rejects generic pages", async () => {
    const jobs = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://boards.greenhouse.io/meridian" },
      async (url, init) => {
        expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/meridian/jobs?content=true");
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ jobs: [
          { title: "Software Engineering Intern", absolute_url: "https://boards.greenhouse.io/meridian/jobs/1", content: STRONG_POSTING },
          { title: "Senior Engineer", absolute_url: "https://boards.greenhouse.io/meridian/jobs/2", content: STRONG_POSTING }
        ] }), { status: 200 });
      }
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Software Engineering Intern");
    let blocked = false;
    try {
      await fetchPublicBoard({ label: "Meridian", url: "https://careers.example.test/jobs" }, async () => { throw new Error("must not fetch"); });
    } catch { blocked = true; }
    expect(blocked).toBe(true);
    await expect(fetchPublicBoard(
      { label: "Meridian", url: "https://boards.greenhouse.io/meridian" },
      async () => new Response("x".repeat(5_000_001))
    )).rejects.toThrow("too large");
  });

  it("reads Lever and Ashby listings while preserving requirement lines and excluding unlisted jobs", async () => {
    const encoded = "&lt;p&gt;Requirements:&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Experience with TypeScript and Python in production systems.&lt;/li&gt;&lt;li&gt;Enrolled in a Bachelor's program and available for the summer internship.&lt;/li&gt;&lt;/ul&gt;";
    const lever = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://jobs.lever.co/meridian" },
      async (url) => {
        expect(url).toBe("https://api.lever.co/v0/postings/meridian?mode=json");
        return new Response(JSON.stringify([{
          text: "Software Engineering Intern",
          hostedUrl: "https://jobs.lever.co/meridian/123",
          description: encoded
        }]));
      }
    );
    expect(lever).toHaveLength(1);
    expect(lever[0].text).toContain("Requirements:\n- Experience");
    const ashby = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://jobs.ashbyhq.com/meridian" },
      async (url) => {
        expect(url).toBe("https://api.ashbyhq.com/posting-api/job-board/meridian");
        return new Response(JSON.stringify({ jobs: [
          { title: "Software Engineering Intern", jobUrl: "https://jobs.ashbyhq.com/meridian/123", isListed: true, descriptionPlain: STRONG_POSTING },
          { title: "Marketing Intern", jobUrl: "https://jobs.ashbyhq.com/meridian/hidden", isListed: false, descriptionPlain: STRONG_POSTING },
          { title: "Data Intern", jobUrl: "javascript:alert(1)", isListed: true, descriptionPlain: STRONG_POSTING }
        ] }));
      }
    );
    expect(ashby).toHaveLength(1);
    expect(ashby[0].sourceUrl).toBe("https://jobs.ashbyhq.com/meridian/123");
  });

  it("reads an oversized Greenhouse board from its job list and each internship posting", async () => {
    const list = "https://boards-api.greenhouse.io/v1/boards/meridian/jobs";
    const job = (id: number, title: string) => ({ id, title, absolute_url: `https://boards.greenhouse.io/meridian/jobs/${id}` });
    const requested: string[] = [];
    const fetches: DiscoveryFetchEvent[] = [];
    const rows: DiscoveryRowEvent[] = [];
    const items = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://boards.greenhouse.io/meridian" },
      async (url, init) => {
        requested.push(url);
        expect(init?.redirect).toBe("error");
        if (url === `${list}?content=true`) return new Response("x".repeat(5_000_001));
        if (url === list) {
          return new Response(JSON.stringify({ jobs: [
            job(11, "Software Engineering Intern"), job(12, "Senior Engineer"), job(13, "Data Intern"), job(14, "Design Intern")
          ] }));
        }
        if (url === `${list}/11`) return new Response(JSON.stringify({ ...job(11, "Software Engineering Intern"), content: STRONG_POSTING, location: { name: "Redlands, CA" } }));
        if (url === `${list}/13`) return new Response("{}", { status: 404 });
        if (url === `${list}/14`) return new Response(JSON.stringify({ ...job(14, "Design Intern"), content: "Too short." }));
        throw new Error(`unexpected request ${url}`);
      },
      { onFetch: (event) => fetches.push(event), onRow: (event) => rows.push(event) }
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("Software Engineering Intern");
    expect(items[0]!.text).toContain("Requirements");
    expect(items[0]!.text.startsWith("Location: Redlands, CA\n\n")).toBe(true);
    expect(requested).toEqual([`${list}?content=true`, list, `${list}/11`, `${list}/13`, `${list}/14`]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ url: list, decision: "board-fetched", jobs: 4, internships: 3, kept: 1 });
    expect(fetches[0]!.reason).toContain("over 5 MB");
    const byUrl = new Map(rows.map((row) => [row.url, row]));
    expect(byUrl.get(job(11, "").absolute_url)?.decision).toBe("resolved");
    expect(byUrl.get(job(13, "").absolute_url)).toMatchObject({ decision: "unavailable" });
    expect(byUrl.get(job(13, "").absolute_url)?.reason).toContain("404");
    expect(byUrl.get(job(14, "").absolute_url)).toMatchObject({ decision: "unavailable" });
    expect(byUrl.get(job(14, "").absolute_url)?.reason).toContain("fewer than 80 characters");
  });

  it("reads an oversized Lever board in pages of 100", async () => {
    const base = "https://api.lever.co/v0/postings/meridian?mode=json";
    const senior = (n: number) => ({ text: `Senior Engineer ${n}`, hostedUrl: `https://jobs.lever.co/meridian/senior-${n}`, descriptionPlain: "A fictional senior role." });
    const requested: string[] = [];
    const fetches: DiscoveryFetchEvent[] = [];
    const items = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://jobs.lever.co/meridian" },
      async (url) => {
        requested.push(url);
        if (url === base) return new Response("x".repeat(5_000_001));
        if (url === `${base}&skip=0&limit=100`) {
          return new Response(JSON.stringify([
            ...Array.from({ length: 99 }, (_, index) => senior(index)),
            { text: "Software Engineering Intern", hostedUrl: "https://jobs.lever.co/meridian/1", descriptionPlain: STRONG_POSTING }
          ]));
        }
        if (url === `${base}&skip=100&limit=100`) {
          return new Response(JSON.stringify([
            { text: "Data Intern", hostedUrl: "https://jobs.lever.co/meridian/2", descriptionPlain: STRONG_POSTING, country: "US", categories: { location: "Austin, TX" } },
            senior(100)
          ]));
        }
        throw new Error(`unexpected request ${url}`);
      },
      { onFetch: (event) => fetches.push(event) }
    );
    expect(items.map((item) => item.title)).toEqual(["Software Engineering Intern", "Data Intern"]);
    expect(items[1]!.text.startsWith("Location: Austin, TX, United States\n\n")).toBe(true);
    expect(requested).toEqual([base, `${base}&skip=0&limit=100`, `${base}&skip=100&limit=100`]);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ url: `${base}&skip=0&limit=100`, decision: "board-fetched", jobs: 102, internships: 2, kept: 2 });
  });

  it("reads an Ashby board up to 16 MB", async () => {
    const items = await fetchPublicBoard(
      { label: "Meridian Tools", url: "https://jobs.ashbyhq.com/meridian" },
      async () => new Response(JSON.stringify({ jobs: [
        { title: "Software Engineering Intern", jobUrl: "https://jobs.ashbyhq.com/meridian/1", descriptionPlain: STRONG_POSTING },
        { title: "Senior Engineer", jobUrl: "https://jobs.ashbyhq.com/meridian/2", descriptionPlain: "y".repeat(6_000_000) }
      ] }))
    );
    expect(items).toHaveLength(1);
    await expect(fetchPublicBoard(
      { label: "Meridian Tools", url: "https://jobs.ashbyhq.com/meridian" },
      async () => new Response("x".repeat(16_000_001))
    )).rejects.toThrow("too large");
  });

  it("writes each public board's stated location into the posting text (Track 68)", async () => {
    const greenhouse = await fetchPublicBoard(
      { label: "Juniper Lane Robotics", url: "https://boards.greenhouse.io/juniperlane" },
      async (url) => {
        expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/juniperlane/jobs?content=true");
        return new Response(JSON.stringify({ jobs: [
          {
            title: "Software Engineering Intern", absolute_url: "https://boards.greenhouse.io/juniperlane/jobs/1", content: PLACELESS_POSTING,
            location: { name: "Austin, TX" }, offices: [{ name: "Austin", location: "Austin, Texas, United States" }]
          },
          { title: "Data Intern", absolute_url: "https://boards.greenhouse.io/juniperlane/jobs/2", content: PLACELESS_POSTING, location: { name: "Remote" }, offices: [] },
          { title: "Platform Intern", absolute_url: "https://boards.greenhouse.io/juniperlane/jobs/3", content: PLACELESS_POSTING, location: 42 },
          { title: "Design Intern", absolute_url: "https://boards.greenhouse.io/juniperlane/jobs/4", content: "Too short.", location: { name: "Austin, TX" } }
        ] }));
      }
    );
    expect(greenhouse.map((item) => item.title)).toEqual(["Software Engineering Intern", "Data Intern", "Platform Intern"]);
    const [stated, remote, malformed] = greenhouse;
    expect(stated!.text.startsWith("Location: Austin, TX\nOffice: Austin, Texas, United States\n\n")).toBe(true);
    expect(countries(stated!.text)).toContain("US");
    expect(judgeLocation(countries(stated!.text)).outcome).toBe("apply");
    expect(remote!.text.startsWith("Location: Remote\n\n")).toBe(true);
    expect(countries(remote!.text)).toEqual([]);
    expect(judgeLocation(countries(remote!.text)).outcome).toBe("review");
    expect(malformed!.text).toBe(plainText(PLACELESS_POSTING));

    const lever = await fetchPublicBoard(
      { label: "Juniper Lane Robotics", url: "https://jobs.lever.co/juniperlane" },
      async () => new Response(JSON.stringify([
        {
          text: "Software Engineering Intern", hostedUrl: "https://jobs.lever.co/juniperlane/1", descriptionPlain: PLACELESS_POSTING,
          country: "US", categories: { location: "Austin, TX", allLocations: ["Austin, TX"] }
        },
        {
          text: "Graphics Intern", hostedUrl: "https://jobs.lever.co/juniperlane/2", descriptionPlain: PLACELESS_POSTING,
          country: "KR", categories: { location: "Seoul", allLocations: ["Seoul"] }
        }
      ]))
    );
    expect(lever).toHaveLength(2);
    expect(lever[0]!.text.startsWith("Location: Austin, TX, United States\n\n")).toBe(true);
    expect(countries(lever[0]!.text)).toContain("US");
    expect(judgeLocation(countries(lever[0]!.text)).outcome).toBe("apply");
    expect(lever[1]!.text.startsWith("Location: Seoul, South Korea\n\n")).toBe(true);
    expect(countries(lever[1]!.text)).toEqual(["KR"]);
    expect(judgeLocation(countries(lever[1]!.text)).outcome).toBe("skip");

    const ashby = await fetchPublicBoard(
      { label: "Juniper Lane Robotics", url: "https://jobs.ashbyhq.com/juniperlane" },
      async () => new Response(JSON.stringify({ jobs: [{
        title: "Software Engineering Intern", jobUrl: "https://jobs.ashbyhq.com/juniperlane/1", isListed: true, descriptionPlain: PLACELESS_POSTING,
        location: "Hybrid", address: { postalAddress: { addressLocality: "Denver", addressRegion: "Colorado", addressCountry: "United States" } }
      }] }))
    );
    expect(ashby).toHaveLength(1);
    expect(ashby[0]!.text.startsWith("Location: Denver, Colorado, United States\n\n")).toBe(true);
    expect(countries(ashby[0]!.text)).toContain("US");
    expect(judgeLocation(countries(ashby[0]!.text)).outcome).toBe("apply");
  });

  it("re-reads a stored board posting that had no location and stores its country (Track 68)", async () => {
    const database = qualifiedDatabase();
    const postingUrl = "https://boards.greenhouse.io/juniperlane/jobs/7";
    const seeded = await ingestPosting({
      title: "Software Engineering Intern", companyName: "Juniper Lane Robotics", content: PLACELESS_POSTING, sourceUrl: postingUrl
    }, { database });
    expect(getJobPosting(database, seeded.jobId)!.locations.some((location) => location.countryCode)).toBe(false);
    const source = addCompanySource("Juniper Lane Robotics", "https://boards.greenhouse.io/juniperlane", 6, database);
    const report = await fetchCompanySource(source.id, {
      database,
      fetcher: async (url) => {
        expect(url).toBe("https://boards-api.greenhouse.io/v1/boards/juniperlane/jobs?content=true");
        return new Response(JSON.stringify({ jobs: [{
          title: "Software Engineering Intern", absolute_url: postingUrl, content: PLACELESS_POSTING,
          location: { name: "Austin, Texas, United States" }
        }] }));
      }
    });
    expect(report.jobIds).toEqual([seeded.jobId]);
    expect(getJobPosting(database, seeded.jobId)!.locations.map((location) => location.countryCode)).toContain("US");
    database.close();
  });

  it("lists postings owed an analysis: no match, or a match older than the current snapshot, never past the approval gate, skipped, or label-held (Track 73)", async () => {
    const database = qualifiedDatabase();
    const text = (name: string, extra = "") => PLACELESS_POSTING.replace("Juniper Lane Robotics", name) + extra;
    const names = ["Alder Freight", "Birch Analytics", "Cedar Robotics", "Dogwood Labs", "Elm Systems"];
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      const report = await ingestPosting({
        title: "Software Engineering Intern", companyName: name, content: text(name), sourceUrl: `https://example.test/jobs/${index + 1}`
      }, { database });
      ids.push(report.jobId);
      // A fixed creation order, so oldest first is deterministic.
      database.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(`2026-11-0${index + 1}T00:00:00.000Z`, report.jobId);
    }
    const [revised, applying, skipped, held, fresh] = ids as [string, string, string, string, string];
    for (const id of [revised, applying, skipped, held]) evaluateAndPersistMatch(id, { database });
    // A first snapshot and an analysis that both predate the revision below, whatever the clock's resolution.
    for (const id of [revised, applying, skipped, held]) {
      database.prepare("UPDATE job_snapshots SET captured_at = ? WHERE job_id = ?").run("2026-11-09T00:00:00.000Z", id);
      database.prepare("UPDATE job_matches SET evaluated_at = ? WHERE job_id = ?").run("2026-11-10T00:00:00.000Z", id);
    }
    // The demo seed's own postings are left out of the comparison.
    const owed = () => listPostingsAwaitingAnalysis(database, { excludedStatuses: [...PROTECTED_POSTING_STATUSES] })
      .filter((id) => ids.includes(id));
    expect(owed()).toEqual([fresh]);
    for (const [index, id] of [revised, applying, skipped, held].entries()) {
      const report = await ingestPosting({
        title: "Software Engineering Intern", companyName: names[index]!, content: text(names[index]!, "\nInterns present their feature at the end of the term."),
        sourceUrl: `https://example.test/jobs/${index + 1}`
      }, { database });
      expect(report.jobId).toBe(id);
    }
    database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("APPLYING", applying);
    database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("READY_FOR_REVIEW", skipped);
    skipDiscoveredJobs({ jobIds: [skipped], reason: "Wrong focus", preferenceNote: null }, database);
    const heldSnapshot = database.prepare("SELECT id FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL").get(held) as { id: string };
    holdRequirementLabels(database, { jobId: held, snapshotId: heldSnapshot.id, reason: "Labels pending (test)." });
    expect(owed()).toEqual([revised, fresh]);
    for (const id of [revised, fresh]) evaluateAndPersistMatch(id, { database });
    expect(owed()).toEqual([]);
    database.close();
  });

  it("plans and applies the board-location backfill: re-reads a held posting's board for its stated country and never revises one past the approval gate (Track 73)", async () => {
    const database = qualifiedDatabase();
    const board = addCompanySource("Juniper Lane Robotics", "https://boards.greenhouse.io/juniperlane", 6, database);
    const ingest = async (title: string, sourceUrl: string, content = PLACELESS_POSTING, companyName = "Juniper Lane Robotics") =>
      (await ingestPosting({ title, companyName, content, sourceUrl }, { database })).jobId;
    const heldId = await ingest("Software Engineering Intern", "https://boards.greenhouse.io/juniperlane/jobs/7");
    database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("READY_FOR_REVIEW", heldId);
    const applyingId = await ingest("Data Intern", "https://boards.greenhouse.io/juniperlane/jobs/8");
    database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("APPLYING", applyingId);
    const noBoardId = await ingest("Platform Intern", "https://jobs.lever.co/kestrel/1", PLACELESS_POSTING.replace("Juniper Lane Robotics", "Kestrel Freight"), "Kestrel Freight");
    const placedId = await ingest("Robotics Intern", "https://boards.greenhouse.io/juniperlane/jobs/9", "Location: Austin, TX\n\n" + PLACELESS_POSTING);
    const offBoardId = await ingest("Firmware Intern", "https://example.test/jobs/1", PLACELESS_POSTING.replace("Juniper Lane Robotics", "Wren Systems"), "Wren Systems");
    database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE id = ?").run(new Date(Date.now() - 3_600_000).toISOString(), board.id);

    const plan = planBoardLocationBackfill(database);
    expect(plan.boards).toHaveLength(1);
    expect(plan.boards[0]!.key).toBe("greenhouse:juniperlane");
    expect(plan.boards[0]!.reread.map((posting) => posting.jobId)).toEqual([heldId]);
    expect(plan.boards[0]!.kept.map((posting) => posting.jobId)).toEqual([applyingId]);
    expect(plan.noBoard.map((posting) => posting.jobId)).toEqual([noBoardId]);
    const planned = [...plan.boards.flatMap((entry) => [...entry.reread, ...entry.kept]), ...plan.noBoard].map((posting) => posting.jobId);
    expect(planned).not.toContain(placedId);
    expect(planned).not.toContain(offBoardId);
    const lines = boardLocationBackfillLines(plan);
    expect(lines).toContain("Board Juniper Lane Robotics (greenhouse:juniperlane): re-read for 1 posting(s) without a stated location.");
    expect(lines).toContain(`  re-read Juniper Lane Robotics — Software Engineering Intern (READY_FOR_REVIEW, job ${heldId.slice(0, 8)})`);
    expect(lines.some((line) => line.startsWith(`  kept Juniper Lane Robotics — Data Intern (APPLYING, job ${applyingId.slice(0, 8)})`) &&
      line.includes("past the approval gate"))).toBe(true);
    expect(lines).toContain(`No board source: Kestrel Freight — Platform Intern (DISCOVERED, job ${noBoardId.slice(0, 8)}).`);
    expect(lines.at(-1)).toBe("1 board(s) to re-read for 1 posting(s); 1 kept past the approval gate; 1 with no board source.");

    const applyingText = () => (database.prepare("SELECT normalized_text FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL")
      .get(applyingId) as { normalized_text: string }).normalized_text;
    const applyingBefore = applyingText();
    const fetched: string[] = [];
    const log: string[] = [];
    const result = await applyBoardLocationBackfill(database, plan, {
      log: (line) => log.push(line), budget: startDiscoveryTimeBudget(900_000),
      fetcher: async (url) => {
        fetched.push(url);
        return new Response(JSON.stringify({ jobs: [7, 8].map((id) => ({
          title: id === 7 ? "Software Engineering Intern" : "Data Intern",
          absolute_url: `https://boards.greenhouse.io/juniperlane/jobs/${id}`, content: PLACELESS_POSTING,
          location: { name: "Austin, Texas, United States" }
        })) }));
      }
    });
    // The board's last check an hour ago did not stop the re-read.
    expect(fetched).toEqual(["https://boards-api.greenhouse.io/v1/boards/juniperlane/jobs?content=true"]);
    expect(result).toMatchObject({ failed: 0, notDue: 0 });
    const healed = getJobPosting(database, heldId)!;
    expect(healed.locations.map((location) => location.countryCode)).toContain("US");
    expect(healed.snapshot.normalizedText.startsWith("Location: Austin, Texas, United States\n")).toBe(true);
    const protectedPosting = getJobPosting(database, applyingId)!;
    expect(protectedPosting.status).toBe("APPLYING");
    expect(applyingText()).toBe(applyingBefore);
    expect(protectedPosting.locations.some((location) => location.countryCode)).toBe(false);
    const replanned = planBoardLocationBackfill(database);
    expect(replanned.boards.map((entry) => [entry.reread.length, entry.kept.length])).toEqual([[0, 1]]);
    expect(boardLocationBackfillLines(replanned)[0]).toBe("Board Juniper Lane Robotics (greenhouse:juniperlane): nothing to re-read.");
    database.close();
  });
});
