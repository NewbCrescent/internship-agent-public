import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { closeProfileDatabase, getJobPosting, getProfileDatabase, listBrowserRuns, listDiscoverySources, resolveProfileDataDirectory } from "@internship-agent/db";
import { applicationRecordPdfPath } from "@internship-agent/browser";
import type { WorkspaceProfile } from "@internship-agent/domain";

import { fetchCompanySource, type FetchBatch } from "../src/discovery-orchestrator";
import { advancePipeline, pipelineSettings, type PipelineReport } from "../src/pipeline-orchestrator";
import { readDoorbellState, ringListDoorbell, writeDoorbellState } from "../src/list-doorbell";
import { acquirePipelineLock, readPipelineLock } from "../src/pipeline-lock";
import { discordFailureStatus, discordSettings, type DiscordTransport } from "../src/discord-notify";
import { notifyPass, passNoticeItems, type NoticeItem } from "../src/pass-notice";
import { recordApplicationHoldFailures, refreshApplicationHolds } from "../src/application-holds";
import { dailyDigestTick, type DigestTickOptions } from "../src/daily-digest";

export type PassLog = (line: string) => void;

/**
 * One pass: check the chosen discovery sources ("all", or the ids the list
 * doorbell rang for), then advance every eligible posting. It holds the
 * workspace's pipeline lock throughout and writes pipeline-status.json, the
 * summary `pnpm pipeline:status` prints. With the Discord settings, it DMs
 * the candidate what is new after releasing the lock.
 */
export async function runPipelinePass(options: {
  profile: WorkspaceProfile; sourceIds: "all" | string[]; retryStopped?: boolean; log: PassLog;
  /** This process already holds the workspace's pipeline lock (`pnpm pipeline:retry --start`); the pass neither takes nor releases it. */
  lockHeld?: boolean;
  /** Tests inject the source fetch; production fetches each source. */
  fetchBatch?: FetchBatch;
  /** Tests replace the advance step; production runs advancePipeline. */
  advance?: typeof advancePipeline;
  /** Tests inject the Discord transport (fetch, the 429 wait, the timeout). */
  notify?: DiscordTransport;
}): Promise<PipelineReport> {
  const { profile, log } = options;
  const dataDir = resolveProfileDataDirectory(profile);
  if (options.lockHeld && readPipelineLock(dataDir)?.pid !== process.pid) {
    throw new Error("The pipeline lock is not held by this process.");
  }
  const release = options.lockHeld ? () => {} : acquirePipelineLock(dataDir);
  const onSignal = () => { release(); process.exit(130); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const discord = discordSettings();
  const safeLog: PassLog = (line) => { try { log(line); } catch { /* a failing log never stops the notice */ } };
  let result: PipelineReport | undefined;
  let notice: NoticeItem[] = [];
  let failure: { error: unknown } | undefined;
  // Everything after the lock is taken sits inside the try, so the lock is released on every path.
  try {
    const database = getProfileDatabase(profile);
    const settings = pipelineSettings();
    const startedAt = new Date().toISOString();
    const autoSubmit = settings.autoSubmit;
    const dailyCapLabel = autoSubmit?.dailyCap == null ? "no daily cap" : `${autoSubmit.dailyCap}/day`;
    log(`Workspace ${profile}; model ${process.env.MODEL_API_KEY ? "configured" : "not configured"}; min fit ${settings.minFit}; ` +
      `auto-apply ${settings.autoApply ? "on" : "off"}; target ${settings.target ? `${settings.target.season} ${settings.target.year}` : "none"}; ` +
      `auto-submit ${autoSubmit ? `on (AI ${autoSubmit.minFit}+, ${dailyCapLabel})` : "off"}.`);
    const sources = listDiscoverySources(database).filter((entry) => entry.enabled && entry.url &&
      (options.sourceIds === "all" || options.sourceIds.includes(entry.id)));
    for (const source of sources) {
      try {
        const { run, sourceNotes, errors } = await fetchCompanySource(source.id, { database, fetchBatch: options.fetchBatch });
        log(`${source.label}: fetched ${run.fetched}, duplicates ${run.deduped}, new ${run.ingested}, prepared ${run.promoted}.` +
          (sourceNotes.length ? " " + sourceNotes.join(" ") : "") + (errors.length ? ` ${errors.length} error(s).` : ""));
      } catch (error) {
        log(`${source.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = await (options.advance ?? advancePipeline)({ database, dataDir, settings, retryStopped: options.retryStopped });
    const name = (jobId: string) => describe(database, jobId);
    log(`Analyzed ${report.analyzed.length} left over; prepared ${report.prepared.length}; browser runs started ${report.started.length}; ` +
      `submitted ${report.submitted.length}; held for you ${report.held.length}; ruled out ${report.skipped.length}; stopped ${report.stopped.length}.`);
    for (const entry of report.submitted) log(`  SUBMITTED ${name(entry.jobId)}: ${entry.confirmation.replace(/\s+/g, " ").slice(0, 160)}`);
    for (const entry of report.held) log(`  waiting for you ${name(entry.jobId)}: ${entry.reasons.join(" ")}`);
    for (const entry of report.skipped) log(`  ruled out ${name(entry.jobId)}: ${entry.reasons.join(" ")}`);
    for (const entry of report.started) log(`  run ${name(entry.jobId)}: ${entry.runStatus}`);
    for (const entry of report.stopped) log(`  stopped ${name(entry.jobId)}: ${entry.reason.replace(/\s+/g, " ").slice(0, 300)}`);
    const workdayWaiting = report.waiting.filter((entry) => entry.reason.startsWith("workday"));
    const icimsWaiting = report.waiting.filter((entry) => entry.reason === "icims-account");
    if (workdayWaiting.length) {
      log(`Workday: ${workdayWaiting.length} applications wait for sign-in on ${new Set(workdayWaiting.map((entry) => entry.siteKey)).size} sites.`);
    }
    if (icimsWaiting.length) {
      log(`iCIMS: ${icimsWaiting.length} applications wait on ${new Set(icimsWaiting.map((entry) => entry.siteKey)).size} sites.`);
    }
    for (const error of report.errors) log(`  ${error}`);
    writeStatus(dataDir, {
      startedAt, finishedAt: new Date().toISOString(), sources: sources.map((source) => source.label),
      submitted: report.submitted.map((entry) => ({ job: name(entry.jobId), jobId: entry.jobId, confirmation: entry.confirmation.slice(0, 300) })),
      held: report.held.map((entry) => ({ job: name(entry.jobId), jobId: entry.jobId, reasons: entry.reasons })),
      ruledOut: report.skipped.map((entry) => ({ job: name(entry.jobId), jobId: entry.jobId, reasons: entry.reasons })),
      stopped: report.stopped.map((entry) => ({ job: name(entry.jobId), jobId: entry.jobId, reason: entry.reason.slice(0, 500) })),
      waitingForSignIn: report.waiting.map((entry) => ({ job: name(entry.jobId), jobId: entry.jobId, site: entry.siteKey })),
      errors: report.errors.map((error) => error.slice(0, 500))
    });
    result = report;
    try {
      recordApplicationHoldFailures(database, report.errors);
      const holds = refreshApplicationHolds(database, dataDir);
      if (discord) {
        notice = passNoticeItems(report, {
          holds,
          posting: (jobId) => getJobPosting(database, jobId),
          latestRun: (jobId) => {
            const run = listBrowserRuns(database, jobId)[0];
            return run ? {
              id: run.id, status: run.status,
              pauses: run.pauses.map(({ label, status, safeguard, sensitive, upload, fieldId }) => ({ label, status, safeguard, sensitive, upload, fieldId }))
            } : null;
          },
          recordSaved: (jobId) => existsSync(applicationRecordPdfPath(dataDir, jobId))
        });
      }
    } catch (error) {
      safeLog(`Hold refresh failed: ${discordFailureStatus(error)}`);
    }
  } catch (error) {
    failure = { error };
  } finally {
    try {
      // Closes and forgets the cached handle, so a later pass in this process opens a fresh one.
      closeProfileDatabase(profile);
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      release();
    }
  }
  // Sent after the lock is released, so a slow or failing Discord call never holds the lock or fails the pass.
  await notifyPass({ dataDir, profile, items: notice, settings: discord, transport: options.notify, log: safeLog });
  if (failure) throw failure.error;
  if (!result) throw new Error("Pipeline pass finished without a report.");
  return result;
}

/**
 * One doorbell check (what `pnpm pipeline:watch` runs each tick): ring the
 * enabled GitHub lists and run a pass only for those with a new commit.
 * Tests inject `fetcher` (the GitHub check) and `fetchBatch` (the pass's
 * source fetch).
 */
export async function runWatchTick(options: {
  profile: WorkspaceProfile; log: PassLog; fetcher?: (url: string, init?: RequestInit) => Promise<Response>; fetchBatch?: FetchBatch;
  /** Tests inject the daily digest's clock, Discord transport, and reads. */
  digest?: DigestTickOptions;
}): Promise<void> {
  const { profile, log } = options;
  const dataDir = resolveProfileDataDirectory(profile);
  // A pass from the previous tick may still be filling forms; this tick then does nothing.
  const lock = readPipelineLock(dataDir);
  if (lock) { log(`A pass is still running (process ${lock.pid}); skipping this check.`); return; }
  let sources: Array<{ id: string; url: string; label: string }>;
  try {
    sources = listDiscoverySources(getProfileDatabase(profile)).filter((source) => source.enabled && source.url)
      .map((source) => ({ id: source.id, url: source.url!, label: source.label }));
  } finally {
    // Closes and forgets the shared cached handle, so the pass below opens a fresh one.
    closeProfileDatabase(profile);
  }
  const state = readDoorbellState(dataDir);
  const rung = await ringListDoorbell(sources, state, { token: process.env.GITHUB_TOKEN?.trim() || null, fetcher: options.fetcher });
  for (const error of rung.errors) log(`Doorbell: ${error}`);
  if (rung.changed.length === 0) {
    writeDoorbellState(dataDir, rung.state);
    await dailyDigestTick(profile, log, options.digest);
    return; // Quiet: nothing new on any list.
  }
  log(`Doorbell: new commits on ${sources.filter((source) => rung.changed.includes(source.id)).map((source) => source.label).join(", ")}.`);
  try {
    await runPipelinePass({ profile, sourceIds: rung.changed, log, fetchBatch: options.fetchBatch });
    // Saved only after the pass, so a crash mid-pass rings again next tick.
    writeDoorbellState(dataDir, rung.state);
  } catch (error) {
    log(`Pass failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The once-a-day digest; it never throws, so it never fails the tick.
  await dailyDigestTick(profile, log, options.digest);
}

function describe(database: DatabaseSync, jobId: string): string {
  const posting = getJobPosting(database, jobId);
  return posting ? `${posting.companyName} — ${posting.title}` : jobId;
}

export function statusPath(dataDir: string): string {
  return join(dataDir, "pipeline-status.json");
}

function writeStatus(dataDir: string, status: unknown): void {
  mkdirSync(dataDir, { recursive: true });
  const path = statusPath(dataDir);
  writeFileSync(path + ".tmp", JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
