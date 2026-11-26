import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Trace files older than this many days (by their UTC date) are removed when a new pass starts. */
export const DISCOVERY_TRACE_RETENTION_DAYS = 14;

/** What discovery decided about one listed row. */
export type DiscoveryListDecision = "resolved" | "already-known" | "stale" | "closed" | "not-internship" | "off-season" |
  "duplicate-row" | "invalid-link" | "failed-to-parse" | "unsupported" | "unavailable" | "not-reached";
/** What ingestion did with one resolved posting. */
export type DiscoveryIngestDecision = "stored-new" | "updated" | "duplicate" | "live-posting" | "feedback-skipped" | "ingest-error" | "not-reached";
/**
 * One listed row. `row` is the 1-based position in the list's parse output:
 * file order for Simplify and Speedy, and for Vansh the valid rows newest
 * first, then the malformed ones.
 */
export type DiscoveryRowEvent = {
  row: number; company: string; title: string; url: string; host: string;
  decision: DiscoveryListDecision; reason: string; postingUrl?: string;
};
export type DiscoveryIngestEvent = {
  company: string; title: string; postingUrl: string; decision: DiscoveryIngestDecision; reason: string; jobId?: string;
};
/** What one public board request did. */
export type DiscoveryFetchDecision = "board-fetched" | "board-fetch-failed";
/** One public board request: its API endpoint, HTTP status (null when none came back), and the board's counts when read. */
export type DiscoveryFetchEvent = {
  url: string; decision: DiscoveryFetchDecision; status: number | null; reason: string;
  jobs?: number; internships?: number; kept?: number;
};
export type DiscoveryTrace = {
  row(event: DiscoveryRowEvent): void;
  fetch(event: DiscoveryFetchEvent): void;
  ingest(event: DiscoveryIngestEvent): void;
  end(outcome?: { error?: string }): void;
  readonly path: string;
  /** The first write failure (error code or message); the trace stops writing but keeps counting. */
  readonly writeError: string | null;
};

const TRACE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
/** Written only on the first pass of the UTC day for a list; always counted. */
const QUIET: ReadonlySet<string> = new Set(["already-known", "stale", "closed", "not-internship"]);
/** Rows whose host is counted as dropped. */
const HOST_COUNTED: ReadonlySet<string> = new Set(["unsupported", "unavailable", "failed-to-parse", "invalid-link", "not-reached"]);
const LABELS: Record<string, string> = {
  "stored-new": "stored new", updated: "updated", duplicate: "duplicate", "live-posting": "already in the live pipeline",
  "feedback-skipped": "skipped by your feedback", "ingest-error": "failed to store", resolved: "read, not yet stored",
  "already-known": "already known", stale: "older than the age limit", closed: "closed on the list",
  "not-internship": "not an internship", "off-season": "another season", "duplicate-row": "listed twice",
  "invalid-link": "invalid link", "failed-to-parse": "failed to parse", unsupported: "unsupported", unavailable: "unavailable",
  "not-reached": "not reached this check", "board-fetched": "board fetched", "board-fetch-failed": "board fetch failed"
};

export function discoveryTraceDirectory(dataDir: string): string {
  return join(dataDir, "discovery-traces");
}

/**
 * Starts one pass's trace in `<dataDir>/discovery-traces/<UTC date>.jsonl`.
 * Each event is appended the moment it happens, so a crash keeps what was
 * written. It never throws: a write failure is kept in `writeError`.
 */
export function openDiscoveryTrace(
  dataDir: string,
  source: { label: string; url: string },
  options: {
    now?: () => Date; passId?: string;
    /**
     * Whether quiet rows are written this pass. When given, the day's file is
     * not read to decide it (public boards pass false: they write no quiet rows).
     */
    full?: boolean;
  } = {}
): DiscoveryTrace {
  const now = options.now ?? (() => new Date());
  const started = now();
  try { pruneDiscoveryTraces(dataDir, started); } catch { /* pruning never stops discovery */ }
  const passId = options.passId ?? randomUUID().slice(0, 8);
  const directory = discoveryTraceDirectory(dataDir);
  const path = join(directory, utcDate(started) + ".jsonl");
  let writeError: string | null = null;
  let ended = false;
  const counts = new Map<string, number>();
  const reasons = new Map<string, number>();
  const hosts = new Map<string, number>();
  const resolvedPostingUrls = new Set<string>();

  const fail = (error: unknown) => {
    if (writeError !== null) return;
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
    writeError = (code ?? (error instanceof Error ? error.message : String(error))).slice(0, 200);
  };
  const write = (line: Record<string, unknown>) => {
    if (writeError !== null) return;
    try { appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 }); } catch (error) { fail(error); }
  };

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch (error) { fail(error); }
  let full = options.full ?? true;
  if (writeError === null && options.full === undefined) {
    try {
      full = !readFileSync(path, "utf8").includes('{"type":"pass","list":' + JSON.stringify(source.url) + ",");
    } catch { full = true; }
  }
  write({ type: "pass", list: source.url, pass: passId, at: started.toISOString(), source: source.label, full });

  return {
    get path() { return path; },
    get writeError() { return writeError; },
    row(event) {
      if (ended) return;
      tally(counts, event.decision);
      const quiet = QUIET.has(event.decision);
      if (!quiet) tally(reasons, event.decision + ": " + event.reason);
      if (HOST_COUNTED.has(event.decision)) tally(hosts, event.host);
      if (event.decision === "resolved" && event.postingUrl) resolvedPostingUrls.add(event.postingUrl);
      if (quiet && !full) return;
      write({
        type: "row", list: source.url, pass: passId, at: now().toISOString(), row: event.row,
        company: cap(event.company, 200), title: cap(event.title, 200), host: event.host, url: cap(event.url, 500),
        decision: event.decision, reason: cap(event.reason, 300),
        ...(event.postingUrl !== undefined ? { postingUrl: cap(event.postingUrl, 500) } : {})
      });
    },
    fetch(event) {
      if (ended) return;
      tally(counts, event.decision);
      const host = hostOf(event.url);
      if (event.decision === "board-fetch-failed") {
        tally(reasons, event.decision + ": " + event.reason);
        tally(hosts, host);
      }
      write({
        type: "fetch", list: source.url, pass: passId, at: now().toISOString(),
        company: cap(source.label, 200), host, url: cap(event.url, 500), status: event.status,
        decision: event.decision, reason: cap(event.reason, 300),
        ...(event.jobs !== undefined ? { jobs: event.jobs } : {}),
        ...(event.internships !== undefined ? { internships: event.internships } : {}),
        ...(event.kept !== undefined ? { kept: event.kept } : {})
      });
    },
    ingest(event) {
      if (ended) return;
      tally(counts, event.decision);
      tally(reasons, event.decision + ": " + event.reason);
      if (resolvedPostingUrls.delete(event.postingUrl)) untally(counts, "resolved");
      write({
        type: "ingest", list: source.url, pass: passId, at: now().toISOString(),
        company: cap(event.company, 200), title: cap(event.title, 200), host: hostOf(event.postingUrl),
        postingUrl: cap(event.postingUrl, 500), decision: event.decision, reason: cap(event.reason, 300),
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {})
      });
    },
    end(outcome = {}) {
      if (ended) return;
      ended = true;
      write({
        type: "end", list: source.url, pass: passId, at: now().toISOString(),
        counts: Object.fromEntries(counts), reasons: Object.fromEntries(reasons), hosts: Object.fromEntries(hosts),
        ...(outcome.error !== undefined ? { error: cap(outcome.error, 300) } : {})
      });
    }
  };
}

/** Removes dated trace files more than `keepDays` days before `now`'s UTC date; returns the removed names. */
export function pruneDiscoveryTraces(dataDir: string, now: Date = new Date(), keepDays = DISCOVERY_TRACE_RETENTION_DAYS): string[] {
  const directory = discoveryTraceDirectory(dataDir);
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const today = Date.parse(utcDate(now) + "T00:00:00Z");
  const removed: string[] = [];
  for (const name of names) {
    const date = TRACE_FILE.exec(name)?.[1];
    if (!date) continue;
    const day = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(day) || (today - day) / DAY_MS <= keepDays) continue;
    try { rmSync(join(directory, name), { force: true }); removed.push(name); } catch { /* left for the next pass */ }
  }
  return removed;
}

type TraceLine = Record<string, unknown> & { type: string; list: string; pass: string; at: string };
type PassGroup = { list: string; pass: string; at: string; source: string; end: TraceLine | null; events: TraceLine[] };

/** Printable lines: the newest passes with counts, or every kept row matching `find`. */
export function summarizeDiscoveryTrace(
  dataDir: string,
  options: { passes?: number; find?: string; now?: Date } = {}
): string[] {
  const directory = discoveryTraceDirectory(dataDir);
  const lines = ["Discovery traces in " + directory + " (kept " + DISCOVERY_TRACE_RETENTION_DAYS + " days)."];
  if (!existsSync(directory)) return [...lines, "No discovery trace has been written in this workspace yet."];
  const today = Date.parse(utcDate(options.now ?? new Date()) + "T00:00:00Z");
  let names: string[];
  try { names = readdirSync(directory); } catch { names = []; }
  const files = names.filter((name) => {
    const date = TRACE_FILE.exec(name)?.[1];
    return date !== undefined && (today - Date.parse(date + "T00:00:00Z")) / DAY_MS <= DISCOVERY_TRACE_RETENTION_DAYS;
  }).sort().reverse();
  if (files.length === 0) return [...lines, "No discovery trace has been written in this workspace yet."];

  const groups = new Map<string, PassGroup>();
  for (const file of files) {
    let content = "";
    try { content = readFileSync(join(directory, file), "utf8"); } catch { continue; }
    for (const raw of content.split("\n")) {
      const line = parseLine(raw);
      if (!line) continue;
      const key = line.list + "\u0000" + line.pass;
      let group = groups.get(key);
      if (!group) {
        group = { list: line.list, pass: line.pass, at: line.at, source: "", end: null, events: [] };
        groups.set(key, group);
      }
      if (line.type === "pass") { group.at = line.at; group.source = text(line.source); }
      else if (line.type === "end") group.end = line;
      else if (line.type === "row" || line.type === "ingest" || line.type === "fetch") group.events.push(line);
    }
  }
  const passes = [...groups.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  if (options.find !== undefined) {
    const needle = options.find.toLocaleLowerCase("en-US");
    // Newest first: passes by start time, and within a pass the later lines first.
    const matches = passes.flatMap((group) => group.events.slice().reverse()
      .filter((event) => ["company", "title", "url", "postingUrl"]
        .some((field) => text(event[field]).toLocaleLowerCase("en-US").includes(needle)))
      .map((event) => ({ group, event })))
      .sort((a, b) => (a.event.at < b.event.at ? 1 : a.event.at > b.event.at ? -1 : 0))
      .slice(0, 50);
    if (matches.length === 0) {
      return [...lines, "No row matching \"" + options.find + "\" in the kept discovery traces (" + DISCOVERY_TRACE_RETENTION_DAYS +
        " days). Rows already known or older than the age limit are written once per day per list."];
    }
    return [...lines, ...matches.map(({ group, event }) => event.type === "fetch"
      ? event.at + " " + (group.source || group.list) + " board fetch: " + text(event.company) + " (" + text(event.host) + "): " +
        label(text(event.decision)) + " — " + text(event.reason)
      : event.at + " " + (group.source || group.list) + " " +
        (event.type === "ingest" ? "stored" : "row " + text(event.row)) + ": " + text(event.company) + " — " + text(event.title) +
        " (" + text(event.host) + "): " + label(text(event.decision)) + " — " + text(event.reason))];
  }

  for (const group of passes.slice(0, options.passes ?? 10)) {
    const totals = group.end ? numbers(group.end.counts) : computedCounts(group.events);
    const why = group.end ? numbers(group.end.reasons) : computedReasons(group.events);
    const hosts = group.end ? numbers(group.end.hosts) : computedHosts(group.events);
    const counted = sorted(totals, (decision) => label(decision)).map(([name, count]) => name + " " + count).join(", ");
    let summary = group.at + " " + (group.source || group.list) + " (pass " + group.pass + "): " + (counted || "no rows recorded");
    if (!group.end) summary += " (incomplete: the pass stopped before it finished)";
    else if (typeof group.end.error === "string") summary += "; failed: " + group.end.error;
    lines.push(summary);
    const reasonText = sorted(why, reasonLabel).slice(0, 6).map(([name, count]) => name + " (" + count + ")").join("; ");
    if (reasonText) lines.push("  why: " + reasonText);
    const hostText = sorted(hosts, (host) => host || "no host").slice(0, 8).map(([name, count]) => name + " " + count).join(", ");
    if (hostText) lines.push("  dropped by host: " + hostText);
  }
  return lines;
}

function parseLine(raw: string): TraceLine | null {
  if (!raw.trim()) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = value as Record<string, unknown>;
  if (typeof line.type !== "string" || typeof line.list !== "string" || typeof line.pass !== "string" || typeof line.at !== "string") return null;
  return line as TraceLine;
}

function computedCounts(events: TraceLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  const resolved = new Set<string>();
  for (const event of events) {
    const decision = text(event.decision);
    tally(counts, decision);
    if (event.type === "row" && decision === "resolved" && typeof event.postingUrl === "string") resolved.add(event.postingUrl);
    if (event.type === "ingest" && resolved.delete(text(event.postingUrl))) untally(counts, "resolved");
  }
  return counts;
}

function computedReasons(events: TraceLine[]): Map<string, number> {
  const reasons = new Map<string, number>();
  for (const event of events) {
    const decision = text(event.decision);
    if (event.type === "row" && QUIET.has(decision)) continue;
    if (event.type === "fetch" && decision === "board-fetched") continue;
    tally(reasons, decision + ": " + text(event.reason));
  }
  return reasons;
}

function computedHosts(events: TraceLine[]): Map<string, number> {
  const hosts = new Map<string, number>();
  for (const event of events) {
    if ((event.type === "row" && HOST_COUNTED.has(text(event.decision))) ||
      (event.type === "fetch" && text(event.decision) === "board-fetch-failed")) tally(hosts, text(event.host));
  }
  return hosts;
}

function numbers(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!value || typeof value !== "object") return map;
  for (const [key, count] of Object.entries(value)) if (typeof count === "number" && count > 0) map.set(key, count);
  return map;
}

/** Entries as display labels, by count descending, then label. */
function sorted(counts: Map<string, number>, display: (key: string) => string): Array<[string, number]> {
  return [...counts].map(([key, count]): [string, number] => [display(key), count])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function reasonLabel(key: string): string {
  const split = key.indexOf(": ");
  return split < 0 ? key : label(key.slice(0, split)) + ": " + key.slice(split + 2);
}

function label(decision: string): string {
  return LABELS[decision] ?? decision;
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function untally(counts: Map<string, number>, key: string): void {
  const count = (counts.get(key) ?? 0) - 1;
  if (count > 0) counts.set(key, count); else counts.delete(key);
}

function hostOf(raw: string): string {
  try { return new URL(raw).hostname; } catch { return ""; }
}

function cap(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) : value;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
