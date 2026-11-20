import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import {
  closeProfileDatabase,
  getJobStatus,
  getProfileDatabase,
  hasApplicationEventDetail,
  listAppliedJobsForMail,
  logApplicationEvent
} from "@internship-agent/db";
import type { WorkspaceProfile } from "@internship-agent/domain";

import { discordFailureStatus, sendDiscordDm, type DiscordSettings, type DiscordTransport } from "./discord-notify";
import {
  evaluateMail,
  formatMailNotice,
  mailEventDetail,
  mailItemKey,
  relevantHeader,
  type AppliedJob,
  type MailHeader,
  type MailItem
} from "./mail-outcomes";
import { MailboxUnavailable } from "./workday-verification-mail";

/**
 * The Gmail outcome watcher: one read-only IMAP session whose IDLE "new
 * mail" pushes trigger a round over the UIDs above the last seen one. Only
 * mail that matches an application the candidate made is DMed (never body
 * text); bodies stay in memory. State lives in <workspace data>/mail-watch.json.
 * The session sits behind `MailSession`, so tests never reach a mail server.
 */
export type MailSession = {
  /** UIDVALIDITY as a decimal string. */
  readonly uidValidity: string;
  readonly uidNext: number;
  /** UIDs greater than `after` (and received since `since`, when given), ascending. */
  uidsAfter(after: number, options?: { since?: Date }): Promise<number[]>;
  /** Headers for these UIDs (any order in, ascending out). */
  headers(uids: number[]): Promise<MailHeader[]>;
  /** First inline text part (plain preferred, else HTML converted to text), at most maxBytes; memory only. */
  bodyText(uid: number, maxBytes: number): Promise<string>;
  /** Registers the IDLE new-mail callback. */
  onNewMail(listener: () => void): void;
  /** Resolves once the connection ends for any reason. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
};
export type MailSessionFactory = () => Promise<MailSession>;

export class MailAuthFailed extends Error {
  constructor() {
    super("the mailbox refused the sign-in");
    this.name = "MailAuthFailed";
  }
}

const MAX_KEYS = 5_000;
const HEADER_CHUNK = 50;
const MAX_BODIES_PER_SCAN = 100;
const BODY_BYTES = 65_536;
const ROUND_LIMIT = 200;
const FIRST_RUN_WINDOW = 200;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const AUTH_WAIT_MS = 1_800_000;
const STABLE_SESSION_MS = 60_000;

export const MAIL_SETUP_MESSAGE = "Set INTERNSHIP_AGENT_GMAIL_ADDRESS, INTERNSHIP_AGENT_GMAIL_APP_PASSWORD, INTERNSHIP_AGENT_DISCORD_BOT_TOKEN and INTERNSHIP_AGENT_DISCORD_USER_ID in the root .env first.";
export const AUTH_FAILED_NOTICE ="Internship agent: Gmail access stopped working; check the app password (INTERNSHIP_AGENT_GMAIL_APP_PASSWORD).";

const stateSchema = z.object({
  version: z.literal(1),
  uidValidity: z.string().nullable(),
  lastUid: z.number().int().min(0),
  notified: z.array(z.string()),
  authAlertSent: z.boolean()
});
export type MailWatchState = z.infer<typeof stateSchema>;

const freshState = (): MailWatchState => ({ version: 1, uidValidity: null, lastUid: 0, notified: [], authAlertSent: false });

export function mailWatchStatePath(dataDir: string): string {
  return join(dataDir, "mail-watch.json");
}

/** The watcher's state; a missing or damaged file starts fresh. */
export function readMailWatchState(dataDir: string): MailWatchState {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(mailWatchStatePath(dataDir), "utf8")) as unknown);
  } catch {
    return freshState();
  }
}

function dedupeTail(keys: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  return kept.reverse().slice(-MAX_KEYS);
}

function writeState(dataDir: string, state: MailWatchState): void {
  mkdirSync(dataDir, { recursive: true });
  const path = mailWatchStatePath(dataDir);
  writeFileSync(path + ".tmp", JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

/** Writes the watcher's state, keeping notified keys another process added meanwhile. */
export function writeMailWatchState(dataDir: string, state: MailWatchState): void {
  const current = readMailWatchState(dataDir);
  writeState(dataDir, { ...state, version: 1, notified: dedupeTail([...current.notified, ...state.notified]) });
}

/** Adds notified keys and leaves every other field exactly as stored (used by scans, which never own the UID position). */
export function addNotifiedKeys(dataDir: string, keys: string[]): void {
  const current = readMailWatchState(dataDir);
  writeState(dataDir, { ...current, notified: dedupeTail([...current.notified, ...keys]) });
}

export type MailStore = { appliedJobs(): AppliedJob[]; recordEvent(jobId: string, detail: string): void };

/** The workspace's applications and timeline; each call opens and closes the workspace database. */
export function workspaceMailStore(profile: WorkspaceProfile): MailStore {
  return {
    appliedJobs() {
      try {
        return listAppliedJobsForMail(getProfileDatabase(profile));
      } finally {
        closeProfileDatabase(profile);
      }
    },
    recordEvent(jobId, detail) {
      try {
        const database = getProfileDatabase(profile);
        if (hasApplicationEventDetail(database, jobId, detail)) return;
        const status = getJobStatus(database, jobId);
        if (!status) return;
        // A timeline note only: the status never changes because of an email.
        logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail });
      } finally {
        closeProfileDatabase(profile);
      }
    }
  };
}

export type MailContext = {
  dataDir: string;
  log: (line: string) => void;
  discord: DiscordSettings | null;
  transport?: DiscordTransport;
  candidateAddress: string;
  /** The bot token and the app password: stripped from anything sent. */
  secrets: string[];
  store: MailStore;
};

function safeLog(ctx: MailContext): (line: string) => void {
  return (line) => { try { ctx.log(line); } catch { /* a failing log never escapes */ } };
}

function stripSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

const ascending = (a: number, b: number) => a - b;

/**
 * Reads, classifies, and (unless dry) DMs these UIDs. Persists only notified
 * keys; the caller owns the UID position. `lastProcessedUid` is the highest
 * UID handled before the body-read cap stopped the scan.
 */
export async function scanUids(
  session: MailSession,
  uids: number[],
  ctx: MailContext,
  options: { dryRun: boolean; since?: Date; print?: (text: string) => void }
): Promise<{ checked: number; items: MailItem[]; delivered: boolean; lastProcessedUid: number }> {
  const log = safeLog(ctx);
  const sorted = [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0).sort(ascending);
  if (sorted.length === 0) return { checked: 0, items: [], delivered: true, lastProcessedUid: 0 };
  const jobs = ctx.store.appliedJobs();
  const state = readMailWatchState(ctx.dataDir);
  const known = new Set(state.notified);

  const headers: MailHeader[] = [];
  for (let start = 0; start < sorted.length; start += HEADER_CHUNK) headers.push(...await session.headers(sorted.slice(start, start + HEADER_CHUNK)));
  headers.sort((a, b) => a.uid - b.uid);

  const found: MailItem[] = [];
  let checked = 0;
  let bodies = 0;
  let firstUnhandled: number | null = null;
  for (const header of headers) {
    if (options.since && header.receivedAt.getTime() < options.since.getTime()) { checked += 1; continue; }
    const key = mailItemKey(header, session.uidValidity);
    if (known.has(key) || !relevantHeader(header, jobs, ctx.candidateAddress)) { checked += 1; continue; }
    if (bodies >= MAX_BODIES_PER_SCAN) { firstUnhandled = header.uid; break; }
    bodies += 1;
    const item = evaluateMail({ header, body: await session.bodyText(header.uid, BODY_BYTES), jobs, uidValidity: session.uidValidity });
    checked += 1;
    if (!item) continue;
    known.add(item.key);
    found.push(item);
  }

  // A site's security or verification code email is machinery: recorded on the
  // timeline (the --reopen-unsubmitted evidence reads it), never DMed.
  const items = found.filter((item) => item.category !== "verification");
  const quiet = found.filter((item) => item.category === "verification");
  if (quiet.length > 0 && !options.dryRun) {
    addNotifiedKeys(ctx.dataDir, quiet.map((item) => item.key));
    let unrecorded = 0;
    for (const item of quiet) {
      if (item.match.jobs.length !== 1) continue;
      try {
        ctx.store.recordEvent(item.match.jobs[0]!.id, mailEventDetail(item));
      } catch {
        unrecorded += 1;
      }
    }
    log(`Gmail: noted ${quiet.length} verification email(s) on the timeline; not sent.`);
    if (unrecorded > 0) log(`Gmail: could not record ${unrecorded} application event(s).`);
  }

  let lastProcessedUid = sorted[sorted.length - 1]!;
  if (firstUnhandled !== null) {
    const index = sorted.indexOf(firstUnhandled);
    lastProcessedUid = index > 0 ? sorted[index - 1]! : sorted[0]! - 1;
  }

  if (items.length === 0) return { checked, items, delivered: true, lastProcessedUid };
  if (options.dryRun) {
    options.print?.(stripSecrets(formatMailNotice(items), ctx.secrets));
    return { checked, items, delivered: true, lastProcessedUid };
  }
  if (!ctx.discord) {
    log("Gmail: Discord is not configured; nothing sent.");
    return { checked, items, delivered: false, lastProcessedUid };
  }
  let posted = 0;
  try {
    posted = await sendDiscordDm(ctx.discord, stripSecrets(formatMailNotice(items), [ctx.discord.token, ...ctx.secrets]), ctx.transport);
  } catch (error) {
    log(`Gmail: Discord notify failed: ${discordFailureStatus(error)}`);
    return { checked, items, delivered: false, lastProcessedUid };
  }
  addNotifiedKeys(ctx.dataDir, items.map((item) => item.key));
  let failed = 0;
  for (const item of items) {
    if (item.match.jobs.length !== 1) continue;
    try {
      ctx.store.recordEvent(item.match.jobs[0]!.id, mailEventDetail(item));
    } catch {
      failed += 1;
    }
  }
  log(`Gmail: sent ${items.length} update(s) in ${posted} message(s).`);
  if (failed > 0) log(`Gmail: could not record ${failed} application event(s).`);
  return { checked, items, delivered: true, lastProcessedUid };
}

/**
 * One round: sets the starting point on the first run or after a UIDVALIDITY
 * change (no flood), then scans UIDs above the last seen one in batches. A
 * failed DM returns retry without advancing.
 */
export async function processNewMail(
  session: MailSession,
  ctx: MailContext,
  options: { since?: Date } = {}
): Promise<{ checked: number; notified: number; retry: boolean }> {
  const log = safeLog(ctx);
  let state = readMailWatchState(ctx.dataDir);
  let scanSince: Date | undefined;
  if (state.uidValidity !== session.uidValidity) {
    let lastUid: number;
    if (state.uidValidity === null) {
      if (options.since) {
        const window = (await session.uidsAfter(0, { since: options.since })).filter((uid) => uid > 0).sort(ascending).slice(-FIRST_RUN_WINDOW);
        lastUid = window.length > 0 ? window[0]! - 1 : session.uidNext - 1;
        scanSince = options.since;
      } else {
        lastUid = session.uidNext - 1;
      }
      log("Gmail: watching new mail from here.");
    } else {
      log("Gmail: mailbox UIDVALIDITY changed; starting from new mail.");
      lastUid = session.uidNext - 1;
    }
    state = { ...readMailWatchState(ctx.dataDir), uidValidity: session.uidValidity, lastUid: Math.max(0, lastUid) };
    writeMailWatchState(ctx.dataDir, state);
  }

  let checked = 0;
  let notified = 0;
  for (;;) {
    const after = state.lastUid;
    // IMAP's `UID n:*` returns the highest message even when n is past it, so always filter.
    const pending = (await session.uidsAfter(after)).filter((uid) => uid > after).sort(ascending);
    if (pending.length === 0) return { checked, notified, retry: false };
    const result = await scanUids(session, pending.slice(0, ROUND_LIMIT), ctx, { dryRun: false, since: scanSince });
    checked += result.checked;
    if (!result.delivered) return { checked, notified, retry: true };
    notified += result.items.length;
    if (result.lastProcessedUid <= after) return { checked, notified, retry: true };
    state = { ...readMailWatchState(ctx.dataDir), uidValidity: session.uidValidity, lastUid: result.lastProcessedUid };
    writeMailWatchState(ctx.dataDir, state);
  }
}

/** `--since` as "Nd" (1–14 days) or "Nh" (1–336 hours) before `now`; null when malformed or out of range. */
export function parseMailSince(value: string, now = Date.now()): Date | null {
  const match = /^(\d{1,3})([dh])$/.exec(value.trim().toLocaleLowerCase("en-US"));
  if (!match) return null;
  const amount = Number(match[1]);
  const hours = match[2] === "d" ? amount * 24 : amount;
  if (amount < 1 || hours > 336) return null;
  return new Date(now - hours * 3_600_000);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Holds the IDLE session until `signal` aborts: a catch-up round on every
 * connect, a round on every new-mail push, reconnects with backoff
 * (5 s doubling to 5 min), and one DM when the sign-in stops working. Never throws.
 */
export async function runMailWatch(options: MailContext & {
  connect: MailSessionFactory;
  since?: Date;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  onRound?: (result: { checked: number; notified: number; retry: boolean }) => void;
  retryMs?: number;
}): Promise<void> {
  const { signal } = options;
  const log = safeLog(options);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const retryMs = options.retryMs ?? BACKOFF_MAX_MS;
  let backoff = BACKOFF_START_MS;

  while (!signal.aborted) {
    let session: MailSession | null = null;
    try {
      session = await options.connect();
      const active = session;
      const connectedAt = now();
      log("Gmail: connected; watching INBOX.");
      const state = readMailWatchState(options.dataDir);
      if (state.authAlertSent) writeMailWatchState(options.dataDir, { ...state, authAlertSent: false });

      let running = false;
      let again = false;
      let ended = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let current: Promise<void> = Promise.resolve();
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const schedule = () => {
        if (ended) return;
        if (running) { again = true; return; }
        clearTimer();
        running = true;
        current = (async () => {
          try {
            do {
              again = false;
              const result = await processNewMail(active, options, { since: options.since });
              try { options.onRound?.(result); } catch { /* an observer never stops the watcher */ }
              if (result.retry && !ended) { clearTimer(); timer = setTimeout(schedule, retryMs); }
            } while (again && !ended);
          } catch {
            log("Gmail: could not read new mail; reconnecting.");
            await active.close().catch(() => undefined);
          } finally {
            running = false;
          }
        })();
      };
      active.onNewMail(schedule);
      schedule();
      const aborted = await Promise.race([active.closed.then(() => false), whenAborted(signal).then(() => true)]);
      ended = true;
      clearTimer();
      if (aborted) {
        await active.close().catch(() => undefined);
        await current;
        return;
      }
      await current;
      if (now() - connectedAt >= STABLE_SESSION_MS) backoff = BACKOFF_START_MS;
      log(`Gmail: connection closed; reconnecting in ${Math.round(backoff / 1000)} s.`);
    } catch (error) {
      if (session) await session.close().catch(() => undefined);
      if (error instanceof MailAuthFailed) {
        log("Gmail: auth failed; retrying in 30 min.");
        const state = readMailWatchState(options.dataDir);
        if (!state.authAlertSent && options.discord) {
          try {
            await sendDiscordDm(options.discord, AUTH_FAILED_NOTICE, options.transport);
            writeMailWatchState(options.dataDir, { ...readMailWatchState(options.dataDir), authAlertSent: true });
          } catch (sendError) {
            log(`Gmail: Discord notify failed: ${discordFailureStatus(sendError)}`);
          }
        }
        await sleep(AUTH_WAIT_MS, signal);
        continue;
      }
      log(`Gmail: could not connect (${error instanceof MailboxUnavailable ? error.message : "unexpected error"}); reconnecting in ${Math.round(backoff / 1000)} s.`);
    }
    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}
