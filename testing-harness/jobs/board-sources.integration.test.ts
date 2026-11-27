import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  addCompanySource,
  boardRetryAfter,
  BOARD_MAX_BACKOFF_MS,
  BOARD_MIN_CHECKS_PER_PASS,
  BOARD_MIN_INTERVAL_MS,
  checkPublicBoards,
  discoveryTraceDirectory,
  fetchCompanySource,
  formatBoardImportReport,
  importBoardSources,
  planBoardChecks,
  publicBoardKey,
  publicBoardKeyOfPostingUrl,
  startDiscoveryTimeBudget,
  summarizeDiscoveryTrace,
  type FetchBatch
} from "@internship-agent/agent";
import { createDatabase, listDiscoverySources } from "@internship-agent/db";
import type { DiscoverySource } from "@internship-agent/domain";

/**
 * Track 52: importing a reviewed list of public boards, and checking those
 * boards without hammering them. Temporary SQLite, a fake fetch, fictional
 * companies; no network and no model.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-boards-"));
  temporaryDirectories.push(directory);
  return directory;
}

function disposableDatabase(): { database: DatabaseSync; path: string } {
  const path = join(temporaryDirectory(), "test.sqlite");
  return { database: createDatabase(path), path };
}

const POSTING = [
  "Software Engineering Intern - Kestrel Freight",
  "Location: Seattle, WA",
  "",
  "Kestrel Freight builds fictional logistics software for this project's synthetic fixtures.",
  "Requirements:",
  "- Experience with Python or TypeScript",
  "- Enrolled in a Bachelor's degree program in Computer Science"
].join("\n");

const evidence = (slug: string) => `https://scouts.example.com/evidence/${slug}`;

function importRows(): unknown[] {
  return [
    { company: "Kestrel Freight", board_url: "https://job-boards.greenhouse.io/Kestrel", ats: "greenhouse", evidence_url: evidence("kestrel"), has_intern_posting: true },
    { company: "Juniper Analytics", board_url: "https://jobs.lever.co/juniper", ats: "lever", evidence_url: evidence("juniper"), has_intern_posting: false },
    { company: " Osprey Robotics ", board_url: "https://jobs.ashbyhq.com/osprey", ats: "ashby", evidence_url: evidence("osprey"), has_intern_posting: true },
    { company: "Kestrel Freight", board_url: "https://boards.greenhouse.io/kestrel", ats: "greenhouse", evidence_url: evidence("kestrel-2"), has_intern_posting: false },
    { company: "Heron Labs", board_url: "https://jobs.lever.co/Heron", ats: "lever", evidence_url: evidence("heron"), has_intern_posting: true },
    { board_url: "https://jobs.lever.co/nameless", ats: "lever", evidence_url: evidence("nameless"), has_intern_posting: false },
    { company: "Wren Systems", board_url: "https://boards.greenhouse.io/wren/jobs/1", ats: "greenhouse", evidence_url: evidence("wren"), has_intern_posting: false },
    { company: "Finch Data", board_url: "https://careers.example.com/finch", ats: "greenhouse", evidence_url: evidence("finch"), has_intern_posting: false },
    { company: "Plover Health", board_url: "https://jobs.lever.co/plover", ats: "ashby", evidence_url: evidence("plover"), has_intern_posting: false },
    { company: "Tern Mobility", board_url: "https://jobs.ashbyhq.com/tern", ats: "ashby", evidence_url: "http://scouts.example.com/evidence/tern", has_intern_posting: false },
    42,
    { company: "Lark Energy", board_url: "https://jobs.ashbyhq.com/lark", ats: "ashby", source_url: evidence("lark"), has_intern_posting: false }
  ];
}

function seedExisting(database: DatabaseSync): void {
  addCompanySource("Heron Labs", "https://jobs.lever.co/heron", 6, database);
}

function expectImportReport(report: ReturnType<typeof importBoardSources>): void {
  // Rows that list an internship go first, then file order.
  expect(report.added).toEqual([
    { row: 1, company: "Kestrel Freight", url: "https://boards.greenhouse.io/Kestrel" },
    { row: 3, company: "Osprey Robotics", url: "https://jobs.ashbyhq.com/osprey" },
    { row: 2, company: "Juniper Analytics", url: "https://jobs.lever.co/juniper" },
    { row: 12, company: "Lark Energy", url: "https://jobs.ashbyhq.com/lark" }
  ]);
  expect(report.alreadyPresent).toEqual([
    { row: 5, company: "Heron Labs", url: "https://jobs.lever.co/Heron", reason: "already a discovery source" },
    { row: 4, company: "Kestrel Freight", url: "https://boards.greenhouse.io/kestrel", reason: "listed earlier in this file" }
  ]);
  expect(report.overCap).toEqual([]);
  const reasons = new Map(report.invalid.map((entry) => [entry.row, entry.reason]));
  expect([...reasons.keys()]).toEqual([6, 7, 8, 9, 10, 11]);
  expect(reasons.get(6)).toContain("company:");
  expect(reasons.get(7)).toBe("board_url: Enter a public board URL with only its company slug.");
  expect(reasons.get(8)).toBe("board_url: This source is unsupported. Paste its listings manually instead.");
  expect(reasons.get(9)).toBe('ats is "ashby" but board_url is a lever board');
  expect(reasons.get(10)).toContain("evidence_url: evidence_url must be a public https link");
  expect(reasons.get(11)).toMatch(/^row: /);
}

function greenhouseBoard(jobs: Array<{ title: string; absolute_url: string; content: string }>): Response {
  return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "content-type": "application/json" } });
}

const traceLines = (dir: string) => readdirSync(discoveryTraceDirectory(dir)).sort()
  .flatMap((name) => readFileSync(join(discoveryTraceDirectory(dir), name), "utf8").trim().split("\n"))
  .map((line) => JSON.parse(line) as Record<string, unknown>);

function source(overrides: Partial<DiscoverySource> & { id: string }): DiscoverySource {
  return {
    kind: "company-page", label: "Board " + overrides.id, url: "https://jobs.lever.co/" + overrides.id, rateLimitPerMinute: 6,
    enabled: true, createdAt: "2026-11-01T00:00:00.000Z", lastFetchedAt: null, importedFrom: null, importedAt: null,
    evidenceUrl: null, failureCount: 0, lastError: null, retryAfter: null, ...overrides
  };
}

describe("public board import", () => {
  it("validates rows, dedupes by board kind and slug, and records each imported board's provenance", () => {
    const { database } = disposableDatabase();
    seedExisting(database);
    const report = importBoardSources(database, importRows(), {
      dryRun: false, importedFrom: "scout run (boards.json)", now: new Date("2026-11-26T10:00:00.000Z")
    });
    expect(report.dryRun).toBe(false);
    expectImportReport(report);
    const imported = listDiscoverySources(database).filter((entry) => entry.importedFrom !== null);
    expect(imported.map((entry) => entry.url).sort()).toEqual([
      "https://boards.greenhouse.io/Kestrel", "https://jobs.ashbyhq.com/lark", "https://jobs.ashbyhq.com/osprey", "https://jobs.lever.co/juniper"
    ]);
    for (const entry of imported) {
      expect(entry).toMatchObject({
        kind: "company-page", rateLimitPerMinute: 6, enabled: true, importedFrom: "scout run (boards.json)",
        importedAt: "2026-11-26T10:00:00.000Z", failureCount: 0, lastError: null, retryAfter: null
      });
    }
    expect(imported.find((entry) => entry.url === "https://boards.greenhouse.io/Kestrel")).toMatchObject({
      label: "Kestrel Freight", evidenceUrl: evidence("kestrel")
    });
    expect(imported.find((entry) => entry.url === "https://jobs.ashbyhq.com/osprey")?.label).toBe("Osprey Robotics");
    // Track 51's scouts name the provenance link source_url.
    expect(imported.find((entry) => entry.url === "https://jobs.ashbyhq.com/lark")?.evidenceUrl).toBe(evidence("lark"));
    expect(listDiscoverySources(database)).toHaveLength(5);
    database.close();
  });

  it("writes nothing on a dry run, even through a read-only handle, and prints every count and reason", () => {
    const { database, path } = disposableDatabase();
    seedExisting(database);
    const before = listDiscoverySources(database);
    const report = importBoardSources(database, importRows(), { dryRun: true, importedFrom: "scout run (boards.json)" });
    expect(report.dryRun).toBe(true);
    expectImportReport(report);
    expect(listDiscoverySources(database)).toEqual(before);
    database.close();

    const readOnly = new DatabaseSync(path, { readOnly: true });
    try {
      expectImportReport(importBoardSources(readOnly, importRows(), { dryRun: true, importedFrom: "scout run (boards.json)" }));
    } finally {
      readOnly.close();
    }
    const lines = formatBoardImportReport(report, { profile: "demo", file: "boards.json" });
    expect(lines[0]).toBe("Board import for the demo workspace from boards.json (dry run: nothing was written).");
    expect(lines[1]).toBe("Would add 4, already present 2, invalid 6, over the 300-board cap 0.");
    expect(lines).toContain("  would add: Kestrel Freight https://boards.greenhouse.io/Kestrel");
    for (const row of [6, 7, 8, 9, 10, 11]) expect(lines.some((line) => line.startsWith(`  row ${row}: `))).toBe(true);
    expect(lines.at(-1)).toBe('BOARD_IMPORT_REPORT {"profile":"demo","dryRun":true,"added":4,"alreadyPresent":2,"invalid":6,"overCap":0}');
  });

  it("adds at most 300 new boards per import, keeping boards with an internship posting first", () => {
    const { database } = disposableDatabase();
    const rows = Array.from({ length: 305 }, (_, index) => {
      const slug = "board-" + String(index + 1).padStart(3, "0");
      return { company: "Synthetic " + slug, board_url: "https://jobs.lever.co/" + slug, ats: "lever", evidence_url: evidence(slug), has_intern_posting: index >= 295 };
    });
    const first = importBoardSources(database, rows, { dryRun: false, importedFrom: "scout run (cap.json)" });
    expect(first.added).toHaveLength(300);
    expect(first.overCap).toHaveLength(5);
    const addedRows = new Set(first.added.map((entry) => entry.row));
    for (let row = 296; row <= 305; row += 1) expect(addedRows.has(row)).toBe(true);
    expect(first.overCap.map((entry) => entry.row)).toEqual([291, 292, 293, 294, 295]);
    expect(formatBoardImportReport(first, { profile: "demo", file: "cap.json" })).toContain("Over the 300-board cap, not imported:");
    expect(listDiscoverySources(database)).toHaveLength(300);
    const second = importBoardSources(database, rows, { dryRun: false, importedFrom: "scout run (cap.json)" });
    expect(second.added.map((entry) => entry.row)).toEqual([291, 292, 293, 294, 295]);
    expect(second.alreadyPresent).toHaveLength(300);
    expect(listDiscoverySources(database)).toHaveLength(305);
    database.close();
  });
});

describe("public board polling plan", () => {
  const now = new Date("2026-11-26T12:00:00.000Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  it("checks never-fetched boards first, then the oldest, defers past the limit, and skips boards not due or backed off", () => {
    const boards = [
      source({ id: "recent", lastFetchedAt: ago(5) }),
      source({ id: "old", lastFetchedAt: ago(30) }),
      source({ id: "older", lastFetchedAt: ago(48) }),
      source({ id: "never-b", createdAt: "2026-11-02T00:00:00.000Z" }),
      source({ id: "never-a", createdAt: "2026-11-01T00:00:00.000Z" }),
      source({ id: "backed-off", lastFetchedAt: ago(30), failureCount: 1, retryAfter: new Date(now.getTime() + 3_600_000).toISOString() }),
      source({ id: "retry-due", lastFetchedAt: ago(13), failureCount: 1, retryAfter: ago(1) })
    ];
    const plan = planBoardChecks(boards, now, 4);
    expect(plan.due.map((entry) => entry.id)).toEqual(["never-a", "never-b", "older", "old"]);
    expect(plan.deferred.map((entry) => entry.id)).toEqual(["retry-due"]);
    expect(plan.notDue.map((entry) => entry.id)).toEqual(["recent"]);
    expect(plan.backedOff.map((entry) => entry.id)).toEqual(["backed-off"]);
    expect(planBoardChecks([source({ id: "edge", lastFetchedAt: ago(6) })], now).due).toHaveLength(1);
    expect(BOARD_MIN_INTERVAL_MS).toBe(6 * 3_600_000);
    // With no interval (the board-location backfill) a board read an hour ago is due again (Track 73).
    expect(planBoardChecks([source({ id: "hour", lastFetchedAt: ago(1) })], now, 100, 0).due).toHaveLength(1);
    expect(BOARD_MIN_CHECKS_PER_PASS).toBe(20);
  });

  it("keys a posting link by the board it sits on, and nothing else (Track 73)", () => {
    expect(publicBoardKeyOfPostingUrl("https://boards.greenhouse.io/Kestrel/jobs/7?gh_jid=7")).toBe("greenhouse:kestrel");
    expect(publicBoardKeyOfPostingUrl("https://job-boards.greenhouse.io/kestrel/jobs/7")).toBe("greenhouse:kestrel");
    expect(publicBoardKeyOfPostingUrl("https://jobs.lever.co/kestrel/0a1b")).toBe("lever:kestrel");
    expect(publicBoardKeyOfPostingUrl("https://jobs.ashbyhq.com/kestrel/0a1b")).toBe("ashby:kestrel");
    expect(publicBoardKeyOfPostingUrl("https://boards.greenhouse.io/kestrel")).toBeNull();
    expect(publicBoardKeyOfPostingUrl("https://example.com/kestrel/jobs/7")).toBeNull();
    expect(publicBoardKeyOfPostingUrl("http://jobs.lever.co/kestrel/1")).toBeNull();
    expect(publicBoardKeyOfPostingUrl("not a url")).toBeNull();
    expect(publicBoardKeyOfPostingUrl("https://boards.greenhouse.io/kestrel/jobs/7")).toBe(publicBoardKey("https://boards.greenhouse.io/kestrel"));
  });

  it("backs a failing board off from 12 hours, doubling to 7 days, and a missing board 7 days at once", () => {
    const hours = (failures: number, status: number | null) => (Date.parse(boardRetryAfter(failures, status, now)) - now.getTime()) / 3_600_000;
    expect([1, 2, 3, 4, 5, 6].map((failures) => hours(failures, 503))).toEqual([12, 24, 48, 96, 168, 168]);
    expect(hours(1, null)).toBe(12);
    expect(hours(1, 404)).toBe(168);
    expect(hours(1, 410)).toBe(168);
    expect(BOARD_MAX_BACKOFF_MS).toBe(168 * 3_600_000);
  });
});

describe("public board checks", () => {
  function fiveBoards(): { database: DatabaseSync; ids: string[] } {
    const { database } = disposableDatabase();
    const ids = ["b1", "b2", "b3", "b4", "b5"].map((slug, index) => {
      const board = addCompanySource(`Board ${slug}`, `https://boards.greenhouse.io/${slug}`, 6, database);
      database.prepare("UPDATE discovery_sources SET created_at = ? WHERE id = ?").run(`2026-11-0${index + 1}T00:00:00.000Z`, board.id);
      return board.id;
    });
    return { database, ids };
  }

  it("reads at least the floor of due boards past the time budget, oldest first, so every board is read within ceil(boards/floor) passes (Track 73)", async () => {
    const { database, ids } = fiveBoards();
    const read: string[] = [];
    const fetchBatch: FetchBatch = async (board) => {
      read.push(board.url);
      return { items: [], notes: ["No internship postings on this board right now."] };
    };
    const url = (slug: string) => `https://boards.greenhouse.io/${slug}`;
    const lastFetched = () => new Map(listDiscoverySources(database).map((entry) => [entry.id, entry.lastFetchedAt]));
    const pass = async () => {
      // Spent from the first check on: the first clock read sets the deadline, every later read is past it.
      let t = 0;
      const budget = startDiscoveryTimeBudget(60_000, () => (t += 100_000));
      const log: string[] = [];
      const result = await checkPublicBoards(database, listDiscoverySources(database), { log: (line) => log.push(line), fetchBatch, budget, minChecks: 2, concurrency: 1 });
      return { result, log };
    };

    const first = await pass();
    expect(read).toEqual([url("b1"), url("b2")]);
    expect(first.result).toMatchObject({ pastBudget: 2, budgetDeferred: 3 });
    expect(first.log).toContain("Public boards: checked 2 (0 failed), not due 0, backed off 0, left for a later pass 0, read past the time budget 2, left by the time budget 3.");
    const afterFirst = lastFetched();
    expect(ids.slice(2).map((id) => afterFirst.get(id))).toEqual([null, null, null]);

    const second = await pass();
    expect(read.slice(2)).toEqual([url("b3"), url("b4")]);
    expect(second.log).toContain("Public boards: checked 2 (0 failed), not due 2, backed off 0, left for a later pass 0, read past the time budget 2, left by the time budget 1.");

    const third = await pass();
    expect(read.slice(4)).toEqual([url("b5")]);
    expect(third.log).toContain("Public boards: checked 1 (0 failed), not due 4, backed off 0, left for a later pass 0, read past the time budget 1.");
    expect(third.result).toMatchObject({ pastBudget: 1, budgetDeferred: 0 });
    // Every board read exactly once across the three passes.
    expect([...read].sort()).toEqual(["b1", "b2", "b3", "b4", "b5"].map(url));
    expect([...lastFetched().values()].every((value) => value !== null)).toBe(true);
    database.close();

    // With an unspent budget every due board is read and nothing is read past it.
    const fresh = fiveBoards();
    const freshRead: string[] = [];
    const freshLog: string[] = [];
    const freshResult = await checkPublicBoards(fresh.database, listDiscoverySources(fresh.database), {
      log: (line) => freshLog.push(line), budget: startDiscoveryTimeBudget(900_000), concurrency: 1,
      fetchBatch: async (board) => { freshRead.push(board.url); return { items: [], notes: ["No internship postings on this board right now."] }; }
    });
    expect(freshRead).toHaveLength(5);
    expect(freshResult).toMatchObject({ pastBudget: 0, budgetDeferred: 0 });
    expect(freshLog).toContain("Public boards: checked 5 (0 failed), not due 0, backed off 0, left for a later pass 0.");
    fresh.database.close();
  });

  it("marks a missing or failing board and backs it off, then clears it after a successful check", async () => {
    const { database } = disposableDatabase();
    const gone = addCompanySource("Gone Robotics", "https://boards.greenhouse.io/gone", 6, database);
    const flaky = addCompanySource("Flaky Analytics", "https://jobs.lever.co/flaky", 6, database);
    const at = Date.now();
    await expect(fetchCompanySource(gone.id, { database, fetcher: async () => new Response("Not Found", { status: 404 }) }))
      .rejects.toThrow("answered 404");
    await expect(fetchCompanySource(flaky.id, { database, fetcher: async () => { throw new TypeError("fetch failed"); } }))
      .rejects.toThrow("fetch failed");
    const byId = () => new Map(listDiscoverySources(database).map((entry) => [entry.id, entry]));
    const goneAfter = byId().get(gone.id)!;
    expect(goneAfter.failureCount).toBe(1);
    expect(goneAfter.lastError).toContain("404");
    expect(Math.abs(Date.parse(goneAfter.retryAfter!) - (at + BOARD_MAX_BACKOFF_MS))).toBeLessThan(60_000);
    const flakyAfter = byId().get(flaky.id)!;
    expect(flakyAfter.failureCount).toBe(1);
    expect(flakyAfter.lastError).toBe("fetch failed");
    expect(Math.abs(Date.parse(flakyAfter.retryAfter!) - (at + 12 * 3_600_000))).toBeLessThan(60_000);

    // Past the source's 10-second rate limit, a successful check clears the failure.
    database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE id = ?").run(new Date(at - 60_000).toISOString(), flaky.id);
    await fetchCompanySource(flaky.id, { database, fetcher: async () => new Response("[]", { status: 200 }) });
    expect(byId().get(flaky.id)).toMatchObject({ failureCount: 0, lastError: null, retryAfter: null });
    database.close();
  });

  it("finishes a board with no internship postings as an empty check with a note, not an error", async () => {
    const { database } = disposableDatabase();
    const board = addCompanySource("Kestrel Freight", "https://boards.greenhouse.io/kestrel", 6, database);
    const report = await fetchCompanySource(board.id, {
      database,
      fetcher: async () => greenhouseBoard([{ title: "Senior Engineer", absolute_url: "https://boards.greenhouse.io/kestrel/jobs/2", content: POSTING }])
    });
    expect(report.sourceNotes).toEqual(["No internship postings on this board right now."]);
    expect(report.run.fetched).toBe(0);
    expect(report.run.finishedAt).not.toBeNull();
    expect(report.errors).toEqual([]);
    expect(listDiscoverySources(database)[0]?.failureCount).toBe(0);
    database.close();
  });

  it("writes a fetch line for each board request and a row line for each internship title", async () => {
    const { database } = disposableDatabase();
    const dir = temporaryDirectory();
    const board = addCompanySource("Kestrel Freight", "https://boards.greenhouse.io/kestrel", 6, database);
    await fetchCompanySource(board.id, {
      database, traceDirectory: dir,
      fetcher: async () => greenhouseBoard([
        { title: "Software Engineering Intern", absolute_url: "https://boards.greenhouse.io/kestrel/jobs/1", content: POSTING },
        { title: "Senior Engineer", absolute_url: "https://boards.greenhouse.io/kestrel/jobs/2", content: POSTING },
        { title: "Data Intern", absolute_url: "https://boards.greenhouse.io/kestrel/jobs/3", content: "Short." },
        { title: "Platform Intern", absolute_url: "http://boards.greenhouse.io/kestrel/jobs/4", content: POSTING }
      ])
    });
    const lines = traceLines(dir);
    expect(lines.map((line) => line.type)).toEqual(["pass", "fetch", "row", "row", "row", "ingest", "end"]);
    expect(lines[0]).toMatchObject({ type: "pass", list: board.url, source: "Kestrel Freight", full: false });
    expect(Object.keys(lines[1]!)).toEqual([
      "type", "list", "pass", "at", "company", "host", "url", "status", "decision", "reason", "jobs", "internships", "kept"
    ]);
    expect(lines[1]).toMatchObject({
      company: "Kestrel Freight", host: "boards-api.greenhouse.io",
      url: "https://boards-api.greenhouse.io/v1/boards/kestrel/jobs?content=true", status: 200, decision: "board-fetched",
      reason: "4 jobs, 3 internship titles, 1 kept", jobs: 4, internships: 3, kept: 1
    });
    expect(lines.slice(2, 5).map((line) => [line.row, line.title, line.decision])).toEqual([
      [1, "Software Engineering Intern", "resolved"],
      [3, "Data Intern", "unavailable"],
      [4, "Platform Intern", "invalid-link"]
    ]);
    expect(lines[2]).toMatchObject({ postingUrl: "https://boards.greenhouse.io/kestrel/jobs/1", host: "boards.greenhouse.io" });
    expect(lines[5]).toMatchObject({ postingUrl: "https://boards.greenhouse.io/kestrel/jobs/1" });
    const counts = lines[6]!.counts as Record<string, number>;
    expect(counts).toMatchObject({ "board-fetched": 1, unavailable: 1, "invalid-link": 1 });
    expect(counts.resolved).toBeUndefined();

    const gone = addCompanySource("Gone Robotics", "https://jobs.ashbyhq.com/gone", 6, database);
    await expect(fetchCompanySource(gone.id, {
      database, traceDirectory: dir, fetcher: async () => new Response("Not Found", { status: 404 })
    })).rejects.toThrow("answered 404");
    const failed = traceLines(dir).filter((line) => line.list === gone.url);
    expect(failed.map((line) => line.type)).toEqual(["pass", "fetch", "end"]);
    expect(failed[1]).toMatchObject({
      decision: "board-fetch-failed", status: 404, host: "api.ashbyhq.com", reason: "The public board answered 404."
    });
    expect(failed[1]).not.toHaveProperty("jobs");
    expect(failed[2]).toMatchObject({ error: "The public board answered 404." });
    expect((failed[2]!.hosts as Record<string, number>)["api.ashbyhq.com"]).toBe(1);

    const summary = summarizeDiscoveryTrace(dir).join("\n");
    expect(summary).toContain("board fetched 1");
    expect(summary).toContain("board fetch failed 1");
    const found = summarizeDiscoveryTrace(dir, { find: "Gone Robotics" });
    expect(found.some((line) => line.includes("board fetch: Gone Robotics (api.ashbyhq.com): board fetch failed — The public board answered 404."))).toBe(true);
    database.close();
  });
});
