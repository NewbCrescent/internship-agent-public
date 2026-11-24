import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import {
  acknowledgeApplicationHolds, applicationHoldDelivered, closeProfileDatabase, getApplicationHold,
  getProfileDatabase, type ApplicationHold
} from "@internship-agent/db";
import type { WorkspaceProfile } from "@internship-agent/domain";

import { acquireHoldDeliveryGuard, candidateDeliveryRecipient, classifyOpenPauses } from "./application-holds";

import { discordFailureStatus, sendDiscordDm, type DiscordSettings, type DiscordTransport } from "./discord-notify";
import type { PipelineReport } from "./pipeline-orchestrator";

/**
 * The candidate's Discord notice after a pipeline pass: what is new (held
 * runs with their open questions, sent applications, stopped runs, errors),
 * redacted, and remembered so nothing is sent twice. It shows company,
 * title, form question labels, and reasons only; answers, voice drafts, and
 * confirmations are never read. A sent item may add that its local record
 * was saved; the record itself is never read or attached. A held or sent
 * posting pursued on AI fit adds a line listing its unverified requirements
 * (requirement text only).
 */
export type NoticeSection = "held" | "sent" | "stopped" | "errors";
export type NoticeItem = { key: string; section: NoticeSection; lines: string[]; hold?: ApplicationHold };
/** Only what a notice may show: no answers, drafts, or question rewordings. */
export type NoticePause = { label: string; status: "open" | "answered"; safeguard: boolean; sensitive: boolean; upload: boolean; fieldId?: string };
export type NoticeLookup = {
  posting(jobId: string): { companyName: string; title: string } | null;
  latestRun(jobId: string): { id: string; status: string; pauses: ReadonlyArray<NoticePause> } | null;
  /** True when the local record of a sent application exists. Only this fact is shown, never the file, its path, or its contents. */
  recordSaved?(jobId: string): boolean;
  /** When supplied, persistent classification replaces report heuristics. */
  holds?: ReadonlyArray<ApplicationHold>;
  /** The unverified requirements of a posting pursued on its AI fit (requirement text only); empty or absent otherwise. */
  unverified?(jobId: string): ReadonlyArray<string>;
};

const MAX_QUESTIONS = 8;
const MAX_KEYS = 2_000;

const ref = (id: string) => id.slice(0, 8);
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Removes what free text may carry about the candidate: emails, URL queries and fragments, long digit runs. */
export function redactNoticeText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .replace(/\d{7,}/g, "[number]");
}

export function passNoticeItems(report: PipelineReport, lookup: NoticeLookup): NoticeItem[] {
  const items: NoticeItem[] = [];
  const seen = new Set<string>();
  const add = (item: NoticeItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  const name = (jobId: string) => {
    const posting = lookup.posting(jobId);
    return posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
  };
  const pursuedLines = (jobId: string) => {
    const open = lookup.unverified?.(jobId) ?? [];
    return open.length ? [`  Pursued on AI fit despite unverified requirements: ${clip(redactNoticeText(open.join("; ")), 300)}`] : [];
  };
  const held = (jobId: string, why: string, run: ReturnType<NoticeLookup["latestRun"]>) => {
    const openLabels = run ? run.pauses.filter((pause) => pause.status === "open").map((pause) => pause.label) : [];
    const key = run ? `held:${run.id}:${digest(openLabels.join("\n"))}` : `held:job:${jobId}`;
    const lines = [`• ${name(jobId)} (${run ? `run ${ref(run.id)}` : `job ${ref(jobId)}`})`];
    if (why) lines.push(`  Why: ${clip(redactNoticeText(why), 300)}`);
    lines.push(...pursuedLines(jobId));
    if (run) lines.push(...questionLines(run.pauses));
    add({ key, section: "held", lines });
  };

  for (const hold of lookup.holds ?? []) {
    if (hold.owner !== "candidate" || !hold.runId) continue;
    const run = lookup.latestRun(hold.jobId);
    if (!run || run.id !== hold.runId) continue;
    const lines = [`• ${name(hold.jobId)} (run ${ref(run.id)})`];
    if (hold.reason === "approval") lines.push("  Filled and waiting for your submit approval.");
    else lines.push(...questionLines(run.pauses, true));
    if (lines.length > 1) {
      lines.push(...pursuedLines(hold.jobId));
      add({ key: `${hold.key}:${hold.revision}`, section: "held", lines, hold });
    }
  }
  if (!lookup.holds) {
    for (const entry of report.held) held(entry.jobId, entry.reasons.join(" "), lookup.latestRun(entry.jobId));
    const heldOrSent = new Set([...report.held, ...report.submitted].map((entry) => entry.jobId));
    for (const entry of report.started) {
      if (heldOrSent.has(entry.jobId)) continue;
      const run = lookup.latestRun(entry.jobId);
      // The current status, not the one the run started with: a failed automatic submit is reported under errors.
      if (run?.status === "paused-needs-input") held(entry.jobId, "The form asked something the agent could not answer on its own.", run);
      else if (run?.status === "awaiting-approval") held(entry.jobId, "Filled and waiting for your submit approval.", run);
    }
  }
  for (const entry of report.submitted) {
    const lines = [`• ${name(entry.jobId)} (job ${ref(entry.jobId)})`];
    if (lookup.recordSaved?.(entry.jobId)) lines.push("  Record saved locally.");
    lines.push(...pursuedLines(entry.jobId));
    add({ key: `submitted:${entry.jobId}`, section: "sent", lines });
  }
  if (lookup.holds) return items;
  for (const entry of report.stopped) {
    add({
      key: `stopped:${entry.jobId}:${digest(entry.reason)}`,
      section: "stopped",
      lines: [`• ${name(entry.jobId)} (job ${ref(entry.jobId)}): ${clip(redactNoticeText(entry.reason), 300)}`]
    });
  }
  for (const error of report.errors) {
    add({ key: `error:${digest(error)}`, section: "errors", lines: [`• ${clip(redactNoticeText(error), 300)}`] });
  }
  return items;
}

/**
 * The label form recognition gives a control without a label
 * (packages/browser form-recognition.ts UNLABELED_CONTROL_LABEL), and the
 * hidden CAPTCHA token field (challenge.ts CAPTCHA_TOKEN_NAME). Kept local so
 * the notice stays free of the browser package.
 */
const UNLABELED = /^Unlabeled (?:input|textarea|select|button) control \d+$/;
const CAPTCHA_TOKEN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;

/**
 * Open pauses as numbered questions; Q<n> is pauses[n-1] of the run at notice
 * time. Unlabeled controls are summed up in one line, and the CAPTCHA token
 * field is never listed.
 */
function questionLines(pauses: ReadonlyArray<NoticePause>, actionableOnly = false): string[] {
  const lines: string[] = [];
  let more = 0;
  let unlabeled = 0;
  classifyOpenPauses(pauses).forEach(({ pause, index, kind }) => {
    if (pause.fieldId === "site-security-code" || (actionableOnly && kind === "fault")) return;
    if (CAPTCHA_TOKEN.test(pause.label.trim())) return;
    if (UNLABELED.test(pause.label.trim())) { unlabeled += 1; return; }
    if (lines.length >= MAX_QUESTIONS) { more += 1; return; }
    const label = clip(redactNoticeText(pause.label), 200);
    const q = `Q${index + 1}`;
    if (kind === "correction") lines.push(`  ${q} fix this field in the browser: "${label}"`);
    else if (pause.safeguard) lines.push(`  ${q} CAPTCHA or safeguard, solve it in the browser: "${label}"`);
    else if (pause.upload) lines.push(`  ${q} needs a document: "${label}"`);
    else if (pause.sensitive) lines.push(`  ${q} demographic, answered for this application only: "${label}"`);
    else lines.push(`  ${q}: "${label}"`);
  });
  if (more > 0) lines.push(`  …and ${more} more`);
  if (unlabeled > 0) lines.push(unlabeled === 1 ? "  plus 1 field without a label" : `  plus ${unlabeled} fields without labels`);
  return lines;
}

export function passFailureItem(error: unknown): NoticeItem {
  const message = error instanceof Error ? error.message : String(error);
  const text = `Pass failed: ${message}`;
  return { key: `error:${digest(text)}`, section: "errors", lines: [`• ${clip(redactNoticeText(text), 300)}`] };
}

const SECTION_TITLES: Array<[NoticeSection, string]> = [
  ["held", "Held for you:"],
  ["sent", "Sent:"],
  ["stopped", "Stopped:"],
  ["errors", "Errors:"]
];

export function formatNotice(items: ReadonlyArray<NoticeItem>): string {
  const n = items.length;
  const lines = [`Internship agent: ${n} new update${n === 1 ? "" : "s"}`];
  for (const [section, title] of SECTION_TITLES) {
    const entries = items.filter((item) => item.section === section);
    if (entries.length === 0) continue;
    lines.push("", title, ...entries.flatMap((item) => item.lines));
  }
  return lines.join("\n");
}

const notifiedSchema = z.object({ version: z.literal(1), keys: z.array(z.string()) });

export function notifiedStatePath(dataDir: string): string {
  return join(dataDir, "discord-notified.json");
}

/** The keys of items already notified; a missing or damaged file starts fresh. */
export function readNotifiedKeys(dataDir: string): string[] {
  try {
    return notifiedSchema.parse(JSON.parse(readFileSync(notifiedStatePath(dataDir), "utf8")) as unknown).keys;
  } catch {
    return [];
  }
}

function writeNotifiedKeys(dataDir: string, keys: string[]): void {
  mkdirSync(dataDir, { recursive: true });
  const path = notifiedStatePath(dataDir);
  writeFileSync(path + ".tmp", JSON.stringify({ version: 1, keys: keys.slice(-MAX_KEYS) }) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

/**
 * Sends the items not notified before as one DM and records them. Never
 * throws: a failed send logs its status (never the token) and records
 * nothing, so the next pass retries.
 */
export async function notifyPass(input: {
  dataDir: string; items: ReadonlyArray<NoticeItem>; profile?: WorkspaceProfile; settings: DiscordSettings | null; transport?: DiscordTransport; log: (line: string) => void;
}): Promise<void> {
  const { dataDir, items, settings } = input;
  const log = (line: string) => { try { input.log(line); } catch { /* a failing log never escapes */ } };
  if (!settings || items.length === 0) return;
  const release = acquireHoldDeliveryGuard(dataDir, "candidate");
  if (!release) return;
  const recipient = candidateDeliveryRecipient(settings.userId);
  const withDatabase = <T>(work: (database: ReturnType<typeof getProfileDatabase>) => T): T | undefined => {
    if (!input.profile) return;
    try { return work(getProfileDatabase(input.profile)); }
    finally { closeProfileDatabase(input.profile); }
  };
  try {
    const known = readNotifiedKeys(dataDir);
    const recorded = new Set(known);
    const fresh: NoticeItem[] = [];
    const eligible = withDatabase((database) => items.filter(({ hold }) => {
      if (!hold) return true;
      const current = getApplicationHold(database, hold.jobId, hold.runId);
      return current?.active && current.revision === hold.revision && !applicationHoldDelivered(database, current, recipient);
    })) ?? items;
    for (const item of eligible) {
      if (!item.hold && recorded.has(item.key)) continue;
      recorded.add(item.key);
      fresh.push(item);
    }
    if (fresh.length === 0) return;
    const content = formatNotice(fresh).split(settings.token).join("[redacted]");
    const posted = await sendDiscordDm(settings, content, input.transport);
    withDatabase((database) => acknowledgeApplicationHolds(database, fresh.flatMap(({ hold }) => hold ? [hold] : []), recipient, new Date().toISOString()));
    writeNotifiedKeys(dataDir, [...known, ...fresh.filter(({ hold }) => !hold).map((item) => item.key)]);
    log(`Discord: sent ${fresh.length} update(s) in ${posted} message(s).`);
  } catch (error) {
    log(`Discord notify failed: ${discordFailureStatus(error)}`);
  } finally {
    release();
  }
}
