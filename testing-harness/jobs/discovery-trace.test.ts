import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoveryTraceDirectory, openDiscoveryTrace, pruneDiscoveryTraces, summarizeDiscoveryTrace, type DiscoveryRowEvent
} from "@internship-agent/agent";

// Synthetic lists and fictional employers; the trace lives in a temporary data directory.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function dataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-trace-"));
  directories.push(directory);
  return directory;
}

const LIST = { label: "Simplify Summer 2027", url: "https://github.com/SimplifyJobs/Summer2027-Internships" };
const OTHER = { label: "Vansh Summer 2027", url: "https://github.com/vanshb03/Summer2027-Internships" };
const clock = (iso: string) => () => new Date(iso);
const row = (n: number, decision: DiscoveryRowEvent["decision"], extra: Partial<DiscoveryRowEvent> = {}): DiscoveryRowEvent => ({
  row: n, company: "Kestrel Freight", title: "Software Development Intern " + n,
  url: "https://kestrelfreight.example.com/jobs/" + n, host: "kestrelfreight.example.com", decision, reason: "reason " + n, ...extra
});
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("discovery trace", () => {
  it("appends each decision as it happens, in a fixed key order, with owner-only modes", () => {
    const dir = dataDir();
    const trace = openDiscoveryTrace(dir, LIST, { now: clock("2026-11-26T03:40:00.000Z"), passId: "p1" });
    expect(trace.path).toBe(join(discoveryTraceDirectory(dir), "2026-11-26.jsonl"));
    trace.row(row(1, "resolved", { postingUrl: "https://kestrelfreight.example.com/jobs/1" }));
    // On disk before the pass ends, so a crash keeps it.
    expect(lines(trace.path).map((line) => line.type)).toEqual(["pass", "row"]);
    trace.ingest({ company: "Kestrel Freight", title: "Software Development Intern 1", postingUrl: "https://kestrelfreight.example.com/jobs/1", decision: "stored-new", reason: "stored as a new job", jobId: "job-1" });
    trace.end();
    const written = lines(trace.path);
    expect(Object.keys(written[0]!)).toEqual(["type", "list", "pass", "at", "source", "full"]);
    expect(written[0]).toMatchObject({ type: "pass", list: LIST.url, pass: "p1", source: LIST.label, full: true });
    expect(Object.keys(written[1]!)).toEqual(["type", "list", "pass", "at", "row", "company", "title", "host", "url", "decision", "reason", "postingUrl"]);
    expect(Object.keys(written[2]!)).toEqual(["type", "list", "pass", "at", "company", "title", "host", "postingUrl", "decision", "reason", "jobId"]);
    expect(written[2]).toMatchObject({ host: "kestrelfreight.example.com", jobId: "job-1" });
    expect(Object.keys(written[3]!)).toEqual(["type", "list", "pass", "at", "counts", "reasons", "hosts"]);
    expect(statSync(discoveryTraceDirectory(dir)).mode & 0o777).toBe(0o700);
    expect(statSync(trace.path).mode & 0o777).toBe(0o600);
    expect(trace.writeError).toBeNull();
  });

  it("writes quiet rows on the first pass of the UTC day per list and always counts them", () => {
    const dir = dataDir();
    const now = clock("2026-11-26T08:00:00.000Z");
    const first = openDiscoveryTrace(dir, LIST, { now, passId: "a" });
    first.row(row(1, "already-known"));
    first.row(row(2, "stale"));
    first.row(row(3, "unavailable"));
    first.end();
    const second = openDiscoveryTrace(dir, LIST, { now, passId: "b" });
    second.row(row(1, "already-known"));
    second.row(row(2, "stale"));
    second.row(row(3, "unavailable"));
    second.end();
    const other = openDiscoveryTrace(dir, OTHER, { now, passId: "c" });
    other.row(row(1, "closed"));
    other.end();
    const written = lines(first.path);
    const rowsOf = (pass: string) => written.filter((line) => line.type === "row" && line.pass === pass).map((line) => line.decision);
    expect(rowsOf("a")).toEqual(["already-known", "stale", "unavailable"]);
    expect(rowsOf("b")).toEqual(["unavailable"]);
    expect(rowsOf("c")).toEqual(["closed"]);
    expect(written.find((line) => line.type === "pass" && line.pass === "b")!.full).toBe(false);
    const end = written.find((line) => line.type === "end" && line.pass === "b")!;
    expect(end.counts).toEqual({ "already-known": 1, stale: 1, unavailable: 1 });
    expect(end.reasons).toEqual({ "unavailable: reason 3": 1 });
    expect(end.hosts).toEqual({ "kestrelfreight.example.com": 1 });
  });

  it("counts a resolved row that was then stored as stored new", () => {
    const dir = dataDir();
    const trace = openDiscoveryTrace(dir, LIST, { now: clock("2026-11-26T08:00:00.000Z"), passId: "p" });
    trace.row(row(1, "resolved", { postingUrl: "https://kestrelfreight.example.com/jobs/1" }));
    trace.row(row(2, "resolved", { postingUrl: "https://kestrelfreight.example.com/jobs/2" }));
    trace.ingest({ company: "Kestrel Freight", title: "Intern", postingUrl: "https://kestrelfreight.example.com/jobs/1", decision: "stored-new", reason: "stored as a new job" });
    trace.end();
    trace.end();
    trace.row(row(3, "unavailable"));
    const written = lines(trace.path);
    expect(written.filter((line) => line.type === "end")).toHaveLength(1);
    expect(written.filter((line) => line.type === "row")).toHaveLength(2);
    expect(written.at(-1)!.counts).toEqual({ resolved: 1, "stored-new": 1 });
  });

  it("prunes dated files older than 14 days and leaves everything else", () => {
    const dir = dataDir();
    const traces = discoveryTraceDirectory(dir);
    mkdirSync(traces, { recursive: true });
    for (const name of ["2026-11-11.jsonl", "2026-11-12.jsonl", "2026-11-26.jsonl", "notes.txt", "2026-11-01.jsonl.bak"]) writeFileSync(join(traces, name), "");
    expect(pruneDiscoveryTraces(dir, new Date("2026-11-26T23:00:00.000Z"))).toEqual(["2026-11-11.jsonl"]);
    expect(readdirSync(traces).sort()).toEqual(["2026-11-01.jsonl.bak", "2026-11-12.jsonl", "2026-11-26.jsonl", "notes.txt"]);
    expect(pruneDiscoveryTraces(join(dir, "missing"))).toEqual([]);
  });

  it("never throws when the data directory cannot hold a trace", () => {
    const dir = dataDir();
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    const trace = openDiscoveryTrace(file, LIST, { now: clock("2026-11-26T08:00:00.000Z") });
    expect(() => { trace.row(row(1, "unavailable")); trace.end(); }).not.toThrow();
    expect(trace.writeError).toBe("ENOTDIR");
  });

  it("summarizes passes by decision, reason, and host, and finds a listing", () => {
    const dir = dataDir();
    expect(summarizeDiscoveryTrace(dir)).toEqual([
      "Discovery traces in " + discoveryTraceDirectory(dir) + " (kept 14 days).",
      "No discovery trace has been written in this workspace yet."
    ]);
    const now = new Date("2026-11-26T12:00:00.000Z");
    const done = openDiscoveryTrace(dir, LIST, { now: clock("2026-11-26T08:00:00.000Z"), passId: "done" });
    done.row(row(1, "already-known"));
    done.row(row(2, "already-known"));
    done.row(row(3, "unavailable", { reason: "redirected away from the posting's site", host: "kestrelfreight.avature.net", company: "Total Kestrel" }));
    done.row(row(4, "resolved", { postingUrl: "https://kestrelfreight.example.com/jobs/4" }));
    done.ingest({ company: "Kestrel Freight", title: "Software Development Intern 4", postingUrl: "https://kestrelfreight.example.com/jobs/4", decision: "stored-new", reason: "stored as a new job" });
    done.end();
    const failed = openDiscoveryTrace(dir, OTHER, { now: clock("2026-11-26T09:00:00.000Z"), passId: "failed" });
    failed.row(row(1, "unsupported", { reason: "no supported full-posting source for kestrel.applytojob.com", host: "kestrel.applytojob.com" }));
    failed.end({ error: "The GitHub job list answered 503." });
    const crashed = openDiscoveryTrace(dir, LIST, { now: clock("2026-11-26T10:00:00.000Z"), passId: "crashed" });
    crashed.row(row(5, "unavailable", { reason: "HTTP 403" }));
    writeFileSync(crashed.path, readFileSync(crashed.path, "utf8") + "{not json\n");

    const summary = summarizeDiscoveryTrace(dir, { now });
    expect(summary[0]).toBe("Discovery traces in " + discoveryTraceDirectory(dir) + " (kept 14 days).");
    expect(summary.slice(1)).toEqual([
      "2026-11-26T10:00:00.000Z Simplify Summer 2027 (pass crashed): unavailable 1 (incomplete: the pass stopped before it finished)",
      "  why: unavailable: HTTP 403 (1)",
      "  dropped by host: kestrelfreight.example.com 1",
      "2026-11-26T09:00:00.000Z Vansh Summer 2027 (pass failed): unsupported 1; failed: The GitHub job list answered 503.",
      "  why: unsupported: no supported full-posting source for kestrel.applytojob.com (1)",
      "  dropped by host: kestrel.applytojob.com 1",
      "2026-11-26T08:00:00.000Z Simplify Summer 2027 (pass done): already known 2, stored new 1, unavailable 1",
      "  why: read, not yet stored: reason 4 (1); stored new: stored as a new job (1); unavailable: redirected away from the posting's site (1)",
      "  dropped by host: kestrelfreight.avature.net 1"
    ]);
    expect(summarizeDiscoveryTrace(dir, { now, passes: 1 })).toHaveLength(4);

    const found = summarizeDiscoveryTrace(dir, { now, find: "total kestrel" });
    expect(found.slice(1)).toEqual([
      "2026-11-26T08:00:00.000Z Simplify Summer 2027 row 3: Total Kestrel — Software Development Intern 3 (kestrelfreight.avature.net): " +
        "unavailable — redirected away from the posting's site"
    ]);
    const stored = summarizeDiscoveryTrace(dir, { now, find: "jobs/4" });
    expect(stored.slice(1)).toEqual([
      "2026-11-26T08:00:00.000Z Simplify Summer 2027 stored: Kestrel Freight — Software Development Intern 4 (kestrelfreight.example.com): stored new — stored as a new job",
      "2026-11-26T08:00:00.000Z Simplify Summer 2027 row 4: Kestrel Freight — Software Development Intern 4 (kestrelfreight.example.com): read, not yet stored — reason 4"
    ]);
    expect(summarizeDiscoveryTrace(dir, { now, find: "Nowhere Corp" }).slice(1)).toEqual([
      "No row matching \"Nowhere Corp\" in the kept discovery traces (14 days). Rows already known or older than the age limit are written once per day per list."
    ]);
  });
});
