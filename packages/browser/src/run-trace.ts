import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import type { BrowserContext } from "playwright-core";

import { traceArtifactsDir } from "./run-files";

/**
 * Run traces (Track 42): a Playwright trace of every real browser run, kept
 * only when the run stops, pauses, or fails, and discarded when it ends
 * cleanly (submitted, or a clean awaiting-approval).
 *
 * What is recorded by default (RUN_TRACE_OPTIONS, the candidate's choice on
 * 2026-11-26): the screencast film strip and the actions with their call
 * parameters. INTERNSHIP_AGENT_TRACE_SNAPSHOTS=1 (optionally limited to the
 * hosts in INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS, traceSnapshotsWanted) adds
 * a screenshot before and after each action (`snapshots.screen`,
 * RUN_TRACE_SNAPSHOT_OPTIONS) for debugging one site. What is never
 * recorded, in either mode: DOM snapshots (`snapshots.dom: false`), which is
 * also what starts Playwright's network recorder, so no request or response
 * headers, cookies, tokens, or bodies are written; accessibility snapshots
 * (`snapshots.aria: false`), which would hold every input's value, passwords
 * included; and sources. Typed candidate values stay in the action
 * parameters (local only, like the other evidence); secrets are kept out by
 * not recording while the adapter's sign-in, account, verification-link, and
 * security-code steps run (wrapUntracedMethods). Every saved part is checked
 * fail-closed before it is kept (checkRunTraceZip), in both modes. Traces live under the
 * job's `run-traces/` folder (directory 700, files 600) and are never sent
 * anywhere.
 */

/** The default (the candidate's choice, 2026-11-26: "Film strip by default"): the screencast film strip and the actions, no per-action screenshots. */
export const RUN_TRACE_OPTIONS = { screenshots: true, snapshots: { dom: false, aria: false, screen: false }, sources: false } as const;
/** INTERNSHIP_AGENT_TRACE_SNAPSHOTS=1 (optionally limited by INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS): adds a screenshot before and after each action, for debugging one site. Still no DOM, aria, network, or sources. */
export const RUN_TRACE_SNAPSHOT_OPTIONS = { screenshots: true, snapshots: { dom: false, aria: false, screen: true }, sources: false } as const;
/** Kept traces older than this are deleted. */
export const RUN_TRACE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** The most bytes all kept traces of a data directory may take; the oldest go first. */
export const RUN_TRACE_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const RUN_TRACE_TITLE = "internship-agent run";
const DAY_MS = 24 * 60 * 60 * 1000;
const TRACE_FILE = /^trace-[A-Za-z0-9-]+\.zip$/;

/**
 * Whether a run trace opened at `url` takes per-action screen snapshots:
 * only when INTERNSHIP_AGENT_TRACE_SNAPSHOTS is exactly "1"; when
 * INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS is set and not blank, only when the
 * URL's host name (lower-case) equals one of its comma-separated entries
 * (trimmed, lower-case, blanks ignored). A URL that does not parse never
 * matches a host list.
 */
export function traceSnapshotsWanted(url: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.INTERNSHIP_AGENT_TRACE_SNAPSHOTS !== "1") return false;
  const hosts = (env.INTERNSHIP_AGENT_TRACE_SNAPSHOT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.includes(host);
}

export type RunTraceDrop = "secret-found" | "network-found" | "unreadable" | "trace-error" | "secrets-unknown";
export type RunTraceResult = { saved: string[]; dropped: RunTraceDrop | null };

export type RunTrace = {
  /** The run's id once it is chosen; names the saved files. */
  setRun(runId: string): void;
  runId(): string | null;
  /** The run ended cleanly: finish discards the trace. */
  endedCleanly(): void;
  /**
   * Runs `action` with nothing recorded: the chunk so far is saved as a part
   * first; `resume` starts a new chunk after it, otherwise nothing more is
   * recorded on this context.
   */
  untraced<T>(action: () => Promise<T>, options: { resume: boolean }): Promise<T>;
  /** Stops tracing and keeps or discards the parts; `neverStored` null means the values to check for could not be read. Never throws. */
  finish(neverStored: string[] | null): Promise<RunTraceResult>;
};

/** Starts tracing on the context; null when Playwright refuses (the run then goes on untraced). */
export async function startRunTrace(
  context: BrowserContext,
  input: { dir: string; runId: string | null; now?: () => Date; snapshots?: boolean }
): Promise<RunTrace | null> {
  try {
    await context.tracing.start({ ...(input.snapshots ? RUN_TRACE_SNAPSHOT_OPTIONS : RUN_TRACE_OPTIONS), title: RUN_TRACE_TITLE });
  } catch {
    return null;
  }
  const startedAt = (input.now ?? (() => new Date()))();
  let state: "recording" | "paused" | "ended" | "broken" = "recording";
  let clean = false;
  let runId = input.runId;
  let depth = 0;
  let partsDir: string | null = null;
  const parts: string[] = [];
  let result: Promise<RunTraceResult> | null = null;

  const nextPart = (): string => {
    if (!partsDir) {
      const dir = join(input.dir, `.parts-${randomUUID()}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(input.dir, 0o700);
      chmodSync(dir, 0o700);
      partsDir = dir;
    }
    const path = join(partsDir, `part-${parts.length + 1}.zip`);
    parts.push(path);
    return path;
  };
  const removeParts = (): void => {
    try {
      if (partsDir) rmSync(partsDir, { recursive: true, force: true });
    } catch {
      // A later prune removes a leftover parts folder.
    }
  };

  const finishOnce = async (neverStored: string[] | null): Promise<RunTraceResult> => {
    try {
      if (state === "recording") {
        try {
          if (clean) await context.tracing.stopChunk();
          else await context.tracing.stopChunk({ path: nextPart() });
          state = "ended";
        } catch {
          state = "broken";
        }
      }
      await context.tracing.stop().catch(() => undefined);
      if (clean) {
        removeParts();
        return { saved: [], dropped: null };
      }
      if (state === "broken") {
        removeParts();
        return { saved: [], dropped: "trace-error" };
      }
      state = "ended";
      if (neverStored === null) {
        removeParts();
        return { saved: [], dropped: "secrets-unknown" };
      }
      const written = parts.filter((path) => existsSync(path));
      if (written.length === 0) {
        removeParts();
        return { saved: [], dropped: null };
      }
      for (const path of written) {
        const verdict = checkRunTraceZip(path, neverStored);
        if (verdict !== "ok") {
          removeParts();
          return { saved: [], dropped: verdict };
        }
      }
      const base = `trace-${runId ?? "job"}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
      const saved = written.map((path, index) => {
        const target = join(input.dir, written.length > 1 ? `${base}-${index + 1}.zip` : `${base}.zip`);
        renameSync(path, target);
        chmodSync(target, 0o600);
        return target;
      });
      removeParts();
      return { saved, dropped: null };
    } catch {
      removeParts();
      return { saved: [], dropped: "trace-error" };
    }
  };

  return {
    setRun: (id) => { runId = id; },
    runId: () => runId,
    endedCleanly: () => { clean = true; },
    untraced: async <T>(action: () => Promise<T>, options: { resume: boolean }): Promise<T> => {
      if (depth > 0 || state !== "recording") {
        depth += 1;
        try {
          return await action();
        } finally {
          depth -= 1;
        }
      }
      depth += 1;
      try {
        try {
          await context.tracing.stopChunk({ path: nextPart() });
          state = "paused";
        } catch {
          // Whatever is in flight is discarded; the action still runs unrecorded.
          state = "broken";
          await context.tracing.stop().catch(() => undefined);
        }
        return await action();
      } finally {
        depth -= 1;
        if (state === "paused") {
          if (options.resume) {
            try {
              await context.tracing.startChunk({ title: RUN_TRACE_TITLE });
              state = "recording";
            } catch {
              state = "ended";
            }
          } else {
            state = "ended";
          }
        }
      }
    },
    finish: (neverStored) => {
      result ??= finishOnce(neverStored);
      return result;
    }
  };
}

const traces = new WeakMap<object, RunTrace>();

/** Ties a run trace to the page adapter the run uses, so the orchestrator can reach it (runTraceOf). */
export function attachRunTrace<T extends object>(page: T, trace: RunTrace): T {
  traces.set(page, trace);
  return page;
}

/** The run trace attached to a page adapter, if any (none for test pages). */
export function runTraceOf(page: object): RunTrace | undefined {
  return traces.get(page);
}

/**
 * Wraps the adapter's secret-typing steps so nothing is recorded while they
 * run: Workday's sign-in, account creation, and verification link; iCIMS's
 * profile creation, sign-in, and verification link (resumed after); and the
 * emailed security codes of Greenhouse and Oracle (never resumed: nothing is
 * recorded after a code is typed).
 */
export function wrapUntracedMethods(adapter: object, trace: RunTrace): void {
  const wrap = (owner: unknown, name: string, resume: boolean): void => {
    if (!owner || typeof owner !== "object") return;
    const record = owner as Record<string, unknown>;
    const original = record[name];
    if (typeof original !== "function") return;
    record[name] = (...args: unknown[]) => trace.untraced(async () => (original as (...values: unknown[]) => unknown).apply(owner, args), { resume });
  };
  const target = adapter as Record<string, unknown>;
  wrap(target, "signInToAccount", true);
  wrap(target, "createAccount", true);
  wrap(target, "openInNewTab", true);
  wrap(target, "submitSecurityCode", false);
  wrap(target.icims, "createProfile", true);
  wrap(target.icims, "signIn", true);
  wrap(target.icims, "openInNewTab", true);
  wrap(target.oracle, "enterCode", false);
}

/** The entries of a zip file (stored or deflated; no zip64), read from its central directory. Throws on anything else. */
export function readZipEntries(bytes: Buffer): Array<{ name: string; data: Buffer }> {
  const END = 0x06054b50;
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === END) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("no end of central directory");
  const total = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  if (total === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) throw new Error("zip64 is not read");
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("zip64 is not read");
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header");
    const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    if (start + compressedSize > bytes.length) throw new Error("entry runs past the file");
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error("unknown compression method");
  }
  return entries;
}

/**
 * Checks a saved trace part, fail-closed: it must parse, hold no network
 * record and no DOM or resource snapshot, and contain none of `neverStored`
 * (raw or JSON-escaped).
 */
export function checkRunTraceZip(path: string, neverStored: string[]): "ok" | "secret-found" | "network-found" | "unreadable" {
  let entries: Array<{ name: string; data: Buffer }>;
  try {
    entries = readZipEntries(readFileSync(path));
  } catch {
    return "unreadable";
  }
  const trace = entries.find((entry) => entry.name === "trace.trace");
  if (!trace) return "unreadable";
  const network = entries.find((entry) => entry.name === "trace.network");
  if (network && network.data.toString("utf8").trim()) return "network-found";
  for (const line of trace.data.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return "unreadable";
    }
    const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
    if (type === "resource-snapshot" || type === "frame-snapshot") return "network-found";
  }
  const needles = neverStored
    .filter((value) => value.length >= 4)
    .flatMap((value) => [Buffer.from(value, "utf8"), Buffer.from(JSON.stringify(value).slice(1, -1), "utf8")]);
  for (const entry of entries) {
    if (needles.some((needle) => entry.data.includes(needle))) return "secret-found";
  }
  return "ok";
}

/** Deletes files under `dir` older than `cutoff` (by their own mtime), then the subfolders left empty; never `dir` itself. */
function pruneOldFiles(dir: string, cutoff: number, isRoot: boolean): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) pruneOldFiles(path, cutoff, false);
      else if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Left for the next prune.
    }
  }
  if (!isRoot) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // Left for the next prune.
    }
  }
}

/**
 * Keeps the traces' disk use bounded: kept traces older than 14 days go, then
 * the oldest while all of them take more than 1 GiB; parts folders and
 * Playwright's intermediate files older than a day go too. Never throws.
 */
export function pruneRunTraces(dataDir: string, options: { now?: Date; maxAgeMs?: number; maxTotalBytes?: number } = {}): void {
  try {
    const now = (options.now ?? new Date()).getTime();
    const maxAge = options.maxAgeMs ?? RUN_TRACE_MAX_AGE_MS;
    const maxTotal = options.maxTotalBytes ?? RUN_TRACE_MAX_TOTAL_BYTES;
    const kept: Array<{ path: string; bytes: number; mtime: number }> = [];
    let jobs: string[] = [];
    try {
      jobs = readdirSync(join(dataDir, "applications"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      jobs = [];
    }
    for (const job of jobs) {
      const dir = join(dataDir, "applications", job, "run-traces");
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        try {
          const stat = statSync(path);
          if (entry.isDirectory() && entry.name.startsWith(".parts-")) {
            if (now - stat.mtimeMs > DAY_MS) rmSync(path, { recursive: true, force: true });
            continue;
          }
          if (!entry.isFile() || !TRACE_FILE.test(entry.name)) continue;
          if (now - stat.mtimeMs > maxAge) {
            rmSync(path, { force: true });
            continue;
          }
          kept.push({ path, bytes: stat.size, mtime: stat.mtimeMs });
        } catch {
          // Left for the next prune.
        }
      }
    }
    kept.sort((a, b) => a.mtime - b.mtime);
    let total = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > maxTotal && kept.length > 0) {
      const oldest = kept.shift()!;
      try {
        rmSync(oldest.path, { force: true });
      } catch {
        // Left for the next prune.
      }
      total -= oldest.bytes;
    }
    pruneOldFiles(traceArtifactsDir(dataDir), now - DAY_MS, true);
  } catch {
    // Pruning never fails a run.
  }
}
