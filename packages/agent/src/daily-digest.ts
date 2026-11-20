import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  closeProfileDatabase,
  getProfileDatabase,
  listAppliedJobsForMail,
  listApplicationEvents,
  listBrowserRuns,
  listJobSummaries,
  resolveProfileDataDirectory
} from "@internship-agent/db";
import { CAPTCHA_TOKEN_NAME } from "@internship-agent/browser";
import { atsKindNeedsApproval, type WorkspaceProfile } from "@internship-agent/domain";

import { discordFailureStatus, discordSettings, sendDiscordDm, type DiscordSettings, type DiscordTransport } from "./discord-notify";
import { verificationSubject } from "./mail-outcomes";
import { redactNoticeText } from "./pass-notice";

/**
 * The candidate's daily Discord digest: one short DM, at or after 09:00
 * local time and at most once a day, of what still waits on the candidate
 * (numbered, so a reply can say "1: yes"), what was sent since the last
 * digest, and replies from companies the Gmail watcher matched. Holds the
 * agent fixes itself (an unrecognized site, unlabeled fields, a resume over
 * one page) collapse into one count. It shows company, title, and form
 * question labels only: never answers, drafts, confirmations, or email text.
 */
export const DIGEST_HOUR = 9;
const MAX_ITEMS = 8;
const MAX_QUESTIONS = 2;
const MAX_NAMES = 4;
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DigestPause = { label: string; status: "open" | "answered"; safeguard: boolean; upload: boolean };
export type DigestRun = {
  id: string; status: string; atsConfirmed: boolean;
  /** The recognized site the candidate approves each run on (Oracle, SmartRecruiters); null or absent otherwise. */
  suggestedAtsKind?: string | null;
  voiceDraft: boolean; pauses: ReadonlyArray<DigestPause>;
};
export type ReplyKind = "assessment" | "interview" | "offer" | "rejection" | "recruiter";
/** What the digest reads: postings being applied to with their latest run, and what happened since the last digest. */
export type DigestSnapshot = {
  applying: ReadonlyArray<{ jobId: string; companyName: string; title: string; run: DigestRun | null }>;
  /** Postings whose automatic run stopped because the generated resume ran over one page. */
  resumeTooLong: number;
  sent: ReadonlyArray<{ jobId: string; companyName: string }>;
  replies: ReadonlyArray<{ companyName: string; kind: ReplyKind }>;
};
export type DigestEntry = { number: number; runId: string; jobId: string; company: string };
export type Digest = { text: string; items: DigestEntry[] };

type Hold =
  | { kind: "candidate"; captcha: boolean; asks: string[]; ready: false }
  | { kind: "candidate"; captcha: false; asks: []; ready: true; voiceDraft: boolean }
  | { kind: "fixing" }
  | null;

const HELD_STATUSES = new Set(["paused-needs-input", "awaiting-approval"]);

/** Form recognition names a control with no label "Unlabeled <tag> control <n>": the agent's bug, not a question for the candidate. */
function unlabeled(label: string): boolean {
  return /^Unlabeled \S+ control \d+$/.test(label.trim());
}

/** Older runs recorded the hidden CAPTCHA token field as a safeguard pause: page machinery, neither a CAPTCHA nor a question. */
function captchaToken(label: string): boolean {
  return CAPTCHA_TOKEN_NAME.test(label.trim());
}

/** What a held run needs, in plain terms; "fixing" for holds the agent fixes itself, null when the run is not held. */
export function classifyHold(run: DigestRun | null): Hold {
  if (!run || !HELD_STATUSES.has(run.status)) return null;
  const open = run.pauses.filter((pause) => pause.status === "open");
  const captcha = open.some((pause) => pause.safeguard && !captchaToken(pause.label));
  const asks = open.filter((pause) => !pause.safeguard && !unlabeled(pause.label) && !captchaToken(pause.label))
    .map((pause) => quote(pause.label, 60) + (pause.upload ? " (file)" : ""));
  if (captcha || asks.length > 0) return { kind: "candidate", captcha, asks, ready: false };
  if (open.length > 0) return { kind: "fixing" };
  if (run.status !== "awaiting-approval") return null;
  // A recognized site the candidate approves each run on (Oracle, SmartRecruiters) is ready for them, not being fixed.
  if (!run.atsConfirmed && !atsKindNeedsApproval(run.suggestedAtsKind)) return { kind: "fixing" };
  return { kind: "candidate", captcha: false, asks: [], ready: true, voiceDraft: run.voiceDraft };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plain(text: string, max: number): string {
  return clip(redactNoticeText(text).replace(/"/g, "'"), max);
}

function quote(label: string, max: number): string {
  return `"${plain(label, max)}"`;
}

function postingName(companyName: string, title: string): string {
  const company = plain(companyName, 40);
  const role = plain(title, 50);
  return role.toLowerCase().startsWith(company.toLowerCase()) ? role : `${company} ${role}`;
}

function names(list: ReadonlyArray<string>): string {
  const shown = list.slice(0, MAX_NAMES).join(", ");
  return list.length > MAX_NAMES ? `${shown} +${list.length - MAX_NAMES} more` : shown;
}

const REPLY_LABELS: Array<[ReplyKind, string, string]> = [
  ["assessment", "online assessment", "online assessments"],
  ["interview", "interview invite", "interview invites"],
  ["offer", "offer", "offers"],
  ["rejection", "rejection", "rejections"],
  ["recruiter", "recruiter reply", "recruiter replies"]
];

/** The digest text and its number-to-run mapping, or null when there is nothing to report. */
export function buildDigest(snapshot: DigestSnapshot, now: Date): Digest | null {
  const waiting: Array<{ line: string; entry: DigestEntry; asks: boolean }> = [];
  let fixing = snapshot.resumeTooLong;
  for (const job of snapshot.applying) {
    const hold = classifyHold(job.run);
    if (!hold || !job.run) continue;
    if (hold.kind === "fixing") { fixing += 1; continue; }
    const company = plain(job.companyName, 40);
    const parts: string[] = [];
    if (hold.ready) {
      parts.push(hold.voiceDraft ? `ready, check the drafted answer, then say "send ${company}"` : `ready, say "send ${company}"`);
    } else {
      if (hold.captcha) parts.push("solve a CAPTCHA");
      if (hold.asks.length > 0) {
        const n = hold.asks.length;
        const more = n > MAX_QUESTIONS ? ` +${n - MAX_QUESTIONS} more` : "";
        parts.push(`${n} question${n === 1 ? "" : "s"}: ${hold.asks.slice(0, MAX_QUESTIONS).join(", ")}${more}`);
      }
    }
    const number = waiting.length + 1;
    waiting.push({
      line: `${number}. ${postingName(job.companyName, job.title)} — ${parts.join("; ")}`,
      entry: { number, runId: job.run.id, jobId: job.jobId, company },
      asks: !hold.ready
    });
  }
  const sent = snapshot.sent.map((entry) => plain(entry.companyName, 40));
  const replies = REPLY_LABELS.flatMap(([kind, one, many]) => {
    const companies = snapshot.replies.filter((reply) => reply.kind === kind).map((reply) => plain(reply.companyName, 40));
    return companies.length ? [`${companies.length} ${companies.length === 1 ? one : many} (${names(companies)})`] : [];
  });
  // Only the fixing count is not worth a message on its own.
  if (waiting.length === 0 && sent.length === 0 && replies.length === 0) return null;

  const date = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(/,/g, "");
  const lines = [`📋 Daily internship update — ${date}`];
  if (sent.length) lines.push(`Sent since last update: ${sent.length} (${names(sent)})`);
  const shown = waiting.slice(0, MAX_ITEMS);
  if (waiting.length) {
    lines.push(`Waiting on you (${waiting.length}):`, ...shown.map((item) => item.line));
    if (waiting.length > MAX_ITEMS) lines.push(`…and ${waiting.length - MAX_ITEMS} more`);
  }
  if (fixing > 0) lines.push(`Being fixed automatically: ${fixing}`);
  if (replies.length) lines.push(`Replies from companies: ${replies.join(", ")}`);
  if (shown.some((item) => item.asks)) lines.push(`Reply here with answers, e.g. "1: yes, May 15".`);
  return { text: lines.join("\n"), items: shown.map((item) => item.entry) };
}

const AUTOMATIC_FAILURE = /^Automatic browser run (failed|needs you): The generated resume runs to \d+ pages/;
const MAIL_EVENT = /^Email received: (Online assessment|Interview invite|Offer|Rejection|Recruiter reply)\b/;
/** The quoted subject of the Gmail watcher's note (mailEventDetail). */
const MAIL_SUBJECT = / from [a-z0-9.-]+: "([^"]*)"/i;
const MAIL_KINDS: Record<string, ReplyKind> = {
  "Online assessment": "assessment", "Interview invite": "interview", Offer: "offer", Rejection: "rejection", "Recruiter reply": "recruiter"
};

/** Reads the digest's facts from the workspace database; read-only. */
export function collectDigestSnapshot(database: DatabaseSync, sinceIso: string): DigestSnapshot {
  const jobs = listAppliedJobsForMail(database);
  const applying: Array<DigestSnapshot["applying"][number]> = [];
  const sent: Array<DigestSnapshot["sent"][number]> = [];
  const replies: Array<DigestSnapshot["replies"][number]> = [];
  for (const job of jobs) {
    if (job.status === "APPLYING") {
      const run = listBrowserRuns(database, job.id)[0];
      applying.push({
        jobId: job.id, companyName: job.companyName, title: job.title,
        run: run ? {
          id: run.id, status: run.status, atsConfirmed: run.atsConfirmed, suggestedAtsKind: run.suggestedAtsKind,
          voiceDraft: run.decisions.some((decision) => decision.basis?.kind === "voice_draft"),
          pauses: run.pauses.map(({ label, status, safeguard, upload }) => ({ label, status, safeguard, upload }))
        } : null
      });
    }
    const events = listApplicationEvents(database, job.id);
    const submittedAt = events.find((event) => event.toStatus === "SUBMITTED")?.createdAt;
    if (submittedAt && submittedAt >= sinceIso) sent.push({ jobId: job.id, companyName: job.companyName });
    for (const event of events) {
      if (event.createdAt < sinceIso) continue;
      const kind = MAIL_EVENT.exec(event.detail ?? "")?.[1];
      // A security or verification code email is not a reply, even under an older label ("Recruiter reply").
      if (kind && verificationSubject(MAIL_SUBJECT.exec(event.detail ?? "")?.[1] ?? "")) continue;
      if (kind) replies.push({ companyName: job.companyName, kind: MAIL_KINDS[kind]! });
    }
  }
  let resumeTooLong = 0;
  for (const job of listJobSummaries(database, { status: "READY_FOR_REVIEW" })) {
    const last = listApplicationEvents(database, job.id).at(-1);
    if (last?.detail && AUTOMATIC_FAILURE.test(last.detail)) resumeTooLong += 1;
  }
  return { applying, resumeTooLong, sent, replies };
}

const stateSchema = z.object({
  version: z.literal(1),
  /** Local calendar date (YYYY-MM-DD) of the last digest sent. */
  lastSentDate: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  lastFailedAt: z.string().nullable(),
  /** The last digest's numbers: digest number to run, so a reply like "1: yes" maps back to its run. */
  items: z.array(z.object({ number: z.number().int().positive(), runId: z.string(), jobId: z.string(), company: z.string() }))
});
export type DigestState = z.infer<typeof stateSchema>;

const EMPTY_STATE: DigestState = { version: 1, lastSentDate: null, lastSentAt: null, lastFailedAt: null, items: [] };

export function digestStatePath(dataDir: string): string {
  return join(dataDir, "discord-digest.json");
}

/** The saved digest state; a missing or damaged file starts fresh. */
export function readDigestState(dataDir: string): DigestState {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(digestStatePath(dataDir), "utf8")) as unknown);
  } catch {
    return { ...EMPTY_STATE, items: [] };
  }
}

function writeDigestState(dataDir: string, state: DigestState): void {
  mkdirSync(dataDir, { recursive: true });
  const path = digestStatePath(dataDir);
  writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Due at or after 09:00 local time, once per local day, and not within an hour of a failed send. */
export function digestDue(state: DigestState, now: Date): boolean {
  if (now.getHours() < DIGEST_HOUR || state.lastSentDate === localDate(now)) return false;
  return !(state.lastFailedAt && now.getTime() - Date.parse(state.lastFailedAt) < FAILURE_RETRY_MS);
}

/** The window the digest covers: since the last digest, or the last day before the first. */
export function digestSince(state: DigestState, now: Date): string {
  return state.lastSentAt ?? new Date(now.getTime() - DAY_MS).toISOString();
}

export type DigestOutcome = "off" | "not-due" | "nothing" | "sent" | "failed";

/**
 * Sends the digest when due (or now, with `force`), then saves the date and
 * the number-to-run mapping. Never throws: a failure logs "Discord digest
 * failed: <status>" (never the token) and is retried an hour later.
 */
export async function sendDailyDigest(input: {
  dataDir: string; settings: DiscordSettings | null; now: Date; read: (sinceIso: string) => DigestSnapshot;
  transport?: DiscordTransport; log: (line: string) => void; force?: boolean;
}): Promise<DigestOutcome> {
  const { dataDir, settings, now } = input;
  const log = (line: string) => { try { input.log(line); } catch { /* a failing log never escapes */ } };
  if (!settings) return "off";
  let state = EMPTY_STATE;
  try {
    state = readDigestState(dataDir);
    if (!input.force && !digestDue(state, now)) return "not-due";
    const digest = buildDigest(input.read(digestSince(state, now)), now);
    if (!digest) return "nothing";
    await sendDiscordDm(settings, digest.text.split(settings.token).join("[redacted]"), input.transport);
    writeDigestState(dataDir, { version: 1, lastSentDate: localDate(now), lastSentAt: now.toISOString(), lastFailedAt: null, items: digest.items });
    log(`Discord digest: sent (${digest.items.length} waiting on you).`);
    return "sent";
  } catch (error) {
    log(`Discord digest failed: ${discordFailureStatus(error)}`);
    try { writeDigestState(dataDir, { ...state, lastFailedAt: now.toISOString() }); } catch { /* the next tick retries */ }
    return "failed";
  }
}

/** Reads the workspace database for the digest and closes the cached handle again. */
export function workspaceDigestReader(profile: WorkspaceProfile): (sinceIso: string) => DigestSnapshot {
  return (sinceIso) => {
    try {
      return collectDigestSnapshot(getProfileDatabase(profile), sinceIso);
    } finally {
      closeProfileDatabase(profile);
    }
  };
}

export type DigestTickOptions = { now?: () => Date; transport?: DiscordTransport; read?: (sinceIso: string) => DigestSnapshot };

/** The watcher tick's hook: sends the digest when due. Never throws and never fails the tick. */
export async function dailyDigestTick(profile: WorkspaceProfile, log: (line: string) => void, options: DigestTickOptions = {}): Promise<void> {
  try {
    await sendDailyDigest({
      dataDir: resolveProfileDataDirectory(profile), settings: discordSettings(), now: (options.now ?? (() => new Date()))(),
      read: options.read ?? workspaceDigestReader(profile), transport: options.transport, log
    });
  } catch (error) {
    try { log(`Discord digest failed: ${discordFailureStatus(error)}`); } catch { /* never fails the tick */ }
  }
}
