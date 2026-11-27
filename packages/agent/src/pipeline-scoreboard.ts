import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";
import {
  applicationHoldSchemaPresent, countJobsByStatus, getBrowserRun, listApplicationEvents, listConfirmedReceipts,
  listCandidateValueTexts, listCurrentFactScopes, listCurrentQuestionKeys, listDiscoverySkipReasons, listScoreboardEventsSince, listScoreboardJobs,
  listScoreboardMatches, listScoreboardRunsSince, listSubmittedRunConfirmations, type HoldObservation, type ScoreboardEvent
} from "@internship-agent/db";
import {
  ATS_KIND_LABELS, atsKindSchema, autoSubmitBlockers, COMPANY_CAP_PREFIX, normalizeAnswerText, normalizeCompanyName,
  normalizeQuestionText, QUICK_SKIP_REASONS, type BrowserRun, type PauseRecord
} from "@internship-agent/domain";

import { classifyOpenPauses, observeApplicationHolds } from "./application-holds";
import { discoveryTraceDirectory } from "./discovery-trace";
import { redactNoticeText } from "./pass-notice";
import { claimAgeHours, claimIsStale, readScoreboardClaims, scoreboardDirectory } from "./scoreboard-claims";

/**
 * The application scoreboard (pnpm pipeline:scoreboard): a deterministic, read-only funnel
 * over the workspace database and its discovery traces, and a ranked board of what holds
 * the applications that are held or paused right now. It prints labels and counts only:
 * never answers, offered options, drafts, decision values, confirmation text, or saved
 * fact and self-identification values. Workday history labels lose their entry names,
 * sensitive questions read as one fixed label, and any label that still holds a value the
 * candidate entered is withheld (grouped by a hash). It never writes the database; it
 * writes only its own snapshot (for the next run's changes) under <data>/scoreboard.
 */

export const SCOREBOARD_DEFAULT_DAYS = 7;
export const SCOREBOARD_MAX_DAYS = 90;
export const SNAPSHOT_RETENTION_DAYS = 30;
/** Every pipeline pass saves a snapshot, so the folder also keeps only the newest this many. */
export const SNAPSHOT_RETENTION_COUNT = 200;

const DAY_MS = 86_400_000;
const LABEL_MAX = 140;

export type BlockerCategory = "needs-candidate" | "needs-fix" | "site-safeguard";
export const BLOCKER_CATEGORY_WORDS: Record<BlockerCategory, string> = {
  "needs-candidate": "needs the candidate",
  "needs-fix": "needs a fix",
  "site-safeguard": "site safeguard"
};
const CATEGORY_ORDER: BlockerCategory[] = ["needs-fix", "needs-candidate", "site-safeguard"];

export type BlockerKind = "question" | "missing-fact" | "saved-fact-unused" | "saved-answer-unused" | "document" |
  "field-correction" | "challenge" | "fault" | "stop" | "submit-hold" | "unconfirmed-submit";

export type BlockerClaimView = { track: string; claimedAt: string; renewedAt: string; ageHours: number; stale: boolean };

export type Blocker = {
  id: string;
  key: string;
  kind: BlockerKind;
  category: BlockerCategory;
  label: string;
  applications: number;
  /** Applications whose only blocker this is. */
  unblocks: number;
  companies: string[];
  owner: string[];
  holdReasons: string[];
  claim: BlockerClaimView | null;
};

export type FunnelCounts = {
  seen: number | null; stored: number; qualified: number; ruledOut: number; started: number;
  reachedSubmit: number; confirmed: number; failedOrHeld: number;
};

export type ScoreboardChanges = {
  previousAt: string;
  heldBefore: number; heldNow: number;
  confirmedBefore: number; confirmedNow: number;
  grew: Array<{ id: string; label: string; before: number; after: number }>;
  shrank: Array<{ id: string; label: string; before: number; after: number }>;
};

export type LastPassSummary = {
  finishedAt: string | null; submitted: number; held: number; ruledOut: number; stopped: number; waitingForSignIn: number; errors: number;
};

export type Scoreboard = {
  version: 1;
  generatedAt: string;
  days: number;
  since: string;
  until: string;
  funnel: {
    days: Array<{ date: string } & FunnelCounts>;
    totals: FunnelCounts;
    ruledOutByReason: Array<{ reason: string; count: number }>;
    markedSubmittedUnconfirmed: number;
    failedOrHeldByHold: Array<{ reason: string; count: number }>;
    requeuedOrInProgress: number;
  };
  stock: Array<{ status: string; count: number }>;
  lastPass: LastPassSummary | null;
  holdsAvailable: boolean;
  heldApplications: number;
  byCategory: Record<BlockerCategory, number>;
  blockers: Blocker[];
  claims: {
    offBoard: Array<{ id: string; label: string } & BlockerClaimView>;
    recent: Array<{ id: string; label: string; track: string; event: "released" | "done" | "expired"; reason: string | null; at: string }>;
  };
  changes: ScoreboardChanges | null;
};

/** A stable blocker id: "b" and the first 10 hex characters of the cause key's sha256. */
export function blockerId(key: string): string {
  return "b" + createHash("sha256").update(key).digest("hex").slice(0, 10);
}

const blockerKey = (kind: BlockerKind, causeText: string) => `${kind}|${normalizeAnswerText(causeText)}`;

const QUOTED = /"[^"]*"|“[^”]*”|‘[^’]*’|(?<=[(=[,]\s*)'[^']*'/g;
const HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

/** Cuts to `max` characters, at the last space when one sits in the last 30 characters. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > 0 && space >= max - 30 ? cut.slice(0, space) : cut).trimEnd();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A cause label safe to print: redacted, without Playwright logs, sites, quoted text (which can
 * hold an option the agent tried), the company's name, or numbers (unless `keepDigits`), cut to
 * its first sentence. A link at a sentence's end leaves the period in place.
 */
export function cleanCauseText(text: string, companyName?: string, options: { firstSentence?: boolean; keepDigits?: boolean } = {}): string {
  let value = redactNoticeText(text);
  value = value.split(/\s+(?:Call log|Browser logs):/)[0] ?? "";
  value = value.replace(/https?:\/\/[^\s]*[^\s.,;:)]/gi, "<site>").replace(HOST, "<site>").replace(QUOTED, "<text>");
  const company = companyName?.trim() ?? "";
  if (company.length >= 2) value = value.replace(new RegExp(escapeRegExp(company), "gi"), "<company>");
  if (!options.keepDigits) value = value.replace(/\d+/g, "N");
  value = value.replace(/\s+/g, " ").trim();
  if (options.firstSentence !== false) {
    const end = /[.;](?=\s|$)/.exec(value);
    if (end) value = value.slice(0, end.index);
  }
  const unclosed = (value.match(/\(/g)?.length ?? 0) - (value.match(/\)/g)?.length ?? 0);
  if (unclosed > 0) value += ")".repeat(unclosed);
  return clip(value.trim(), LABEL_MAX);
}

const STOP_PREFIX = /^(?:Automatic browser run (?:waiting|needs you|failed|stopped)|Automatic submission failed|Application hold):\s*/i;

/** A stop or hold event's cause, with its source prefix, site, numbers, and quoted text removed. */
export function normalizeStopReason(detail: string, companyName?: string): { key: string; label: string } {
  const label = cleanCauseText(redactNoticeText(detail).replace(STOP_PREFIX, ""), companyName);
  return { key: normalizeAnswerText(label), label };
}

const SAFEGUARD = /captcha|datadome|turnstile|hcaptcha|recaptcha|bot (?:check|detection|protection)|verify you are human|are you a robot|cloudflare|safeguard/i;

export function stopReasonCategory(label: string): BlockerCategory {
  return SAFEGUARD.test(label) ? "site-safeguard" : "needs-fix";
}

export function submitHoldCategory(label: string): BlockerCategory {
  if (/not recognized|no adapter/i.test(label)) return "needs-fix";
  if (/safeguard/i.test(label)) return "site-safeguard";
  return "needs-candidate";
}

/** A question's grouping text: the question-memory key (digits kept), with the company's name read as "the company". */
export function questionCauseText(label: string, companyName?: string): string {
  const key = normalizeQuestionText(cleanCauseText(label, undefined, { firstSentence: false, keepDigits: true }));
  const company = companyName ? normalizeCompanyName(companyName) : "";
  if (!company) return key;
  return ` ${key} `.split(` ${company} `).join(" the company ").trim();
}

const ATS_NAMES = [...atsKindSchema.options, ...Object.values(ATS_KIND_LABELS)].map((name) => name.toLowerCase());
const startsWithAts = (label: string) => ATS_NAMES.some((name) => label.toLowerCase().startsWith(name));
const TOKEN_LABEL = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;
const FACT_KEY = /^[a-z][a-z0-9_]{0,79}$/;

type Cause = { kind: BlockerKind; category: BlockerCategory; label: string; causeText: string };

/** Tells whether a text holds a candidate-entered value; the values never leave the closure. */
export type ValueMatcher = (text: string) => boolean;
const neverMatches: ValueMatcher = () => false;

const MATCH_SKIP: ReadonlySet<string> = new Set([
  "yes", "no", "true", "false", "none", "n a", "na", "other", "not applicable", "prefer not to say", "decline to answer", "i don t wish to answer"
]);

/**
 * A whole-word matcher over candidate-entered values (normalized like question memory). Values
 * shorter than 3 characters, short numbers (a year, an age), and generic answers are ignored.
 */
export function candidateValueMatcher(values: ReadonlyArray<string>): ValueMatcher {
  const phrases = new Set<string>();
  for (const value of values) {
    const phrase = normalizeAnswerText(value);
    if (phrase.length < 3 || MATCH_SKIP.has(phrase)) continue;
    if (/^[\d ]+$/.test(phrase) && phrase.replace(/ /g, "").length < 5) continue;
    phrases.add(phrase);
  }
  const kept = [...phrases];
  if (kept.length === 0) return neverMatches;
  return (text: string) => {
    const haystack = ` ${normalizeAnswerText(text)} `;
    return kept.some((phrase) => haystack.includes(` ${phrase} `));
  };
}

/** The matcher over this database's candidate-entered values (read once, kept in memory only). */
export function scoreboardMatcher(database: DatabaseSync): ValueMatcher {
  return candidateValueMatcher(listCandidateValueTexts(database));
}

const WITHHELD_LABEL = "(label withheld: it contains a saved candidate value)";
const WITHHELD_REASON = "(reason withheld)";

/** A label read back from a snapshot or the claims file, withheld when it holds a candidate value. */
const guardLabel = (label: string, matches: ValueMatcher) => matches(label) ? WITHHELD_LABEL : label;

const HISTORY_FIELD = /(?:^|::)history:(work|education):.*:([a-z_]+)$/i;

/**
 * A Workday history pause's label without the entry's name (a school or employer the candidate
 * entered): "education history entry: degree", "work history row"; null for any other pause.
 */
export function historyFieldLabel(label: string, fieldId: string): string | null {
  const parts = HISTORY_FIELD.exec(fieldId) ?? HISTORY_FIELD.exec(label);
  if (!parts) return null;
  const section = parts[1]!.toLowerCase();
  const field = parts[2]!.toLowerCase();
  return field === "row" ? `${section} history row` : `${section} history entry: ${field}`;
}

const SENSITIVE_QUESTION = "a sensitive or self-identification question";

const KIND_PREFIX: Partial<Record<BlockerKind, string>> = {
  question: "question: ", document: "document: ", "field-correction": "fix in the browser: ",
  challenge: "safeguard challenge: ", "saved-answer-unused": "saved answer not used: "
};

/**
 * Withholds a free-text cause whose original or printed text holds a candidate-entered value:
 * the label becomes a fixed notice, and the cause groups by a hash of the original text.
 */
function guardCause(cause: Cause, rawText: string, matches: ValueMatcher, atsKind = ""): Cause {
  if (!matches(rawText) && !matches(cause.label)) return cause;
  const prefix = cause.kind === "fault" || cause.kind === "stop" ? (atsKind ? `${atsKind}: ` : "")
    : cause.kind === "submit-hold" ? "" : KIND_PREFIX[cause.kind] ?? "";
  const hash = createHash("sha256").update(normalizeAnswerText(rawText)).digest("hex").slice(0, 12);
  return { ...cause, label: `${prefix}${WITHHELD_LABEL}`, causeText: `withheld ${hash}` };
}

function faultCause(pause: PauseRecord, atsKind: string, company: string, matches: ValueMatcher): Cause {
  const label = pause.label.trim();
  const history = historyFieldLabel(label, pause.fieldId);
  const unlabeled = /^Unlabeled (\S+) control \d+$/i.exec(label);
  let detail: string;
  if (history) detail = history;
  else if (!label || TOKEN_LABEL.test(label)) detail = "CAPTCHA token field read as a question";
  else if (unlabeled) detail = `unlabeled ${unlabeled[1]!.toLowerCase()} control`;
  else if (pause.fieldId === "site-security-code") detail = "site security code not found";
  else if (/::workday-error(?:-|::)|^\(workday errors\)$/i.test(pause.fieldId) || /\(workday errors\)$/i.test(label)) {
    detail = "Workday error report: " + cleanCauseText(label, company);
  } else detail = cleanCauseText(label, company);
  const text = `${atsKind}: ${detail}`;
  return guardCause({ kind: "fault", category: "needs-fix", label: text, causeText: text }, history ?? label, matches, atsKind);
}

type PauseContext = { company: string; atsKind: string; factScopes: Set<string>; questionKeys: Set<string>; matches: ValueMatcher };

function pauseCause(pause: PauseRecord, kind: "fault" | "challenge" | "correction" | "question", context: PauseContext): Cause {
  const { company, matches } = context;
  if (kind === "fault") return faultCause(pause, context.atsKind, company, matches);
  const history = historyFieldLabel(pause.label, pause.fieldId);
  const rawText = history ?? (pause.sensitive ? SENSITIVE_QUESTION : pause.label);
  const question = history ?? (pause.sensitive ? SENSITIVE_QUESTION : questionCauseText(pause.label, company));
  const guard = (cause: Cause) => guardCause(cause, rawText, matches);
  if (kind === "challenge") return guard({ kind: "challenge", category: "site-safeguard", label: `safeguard challenge: "${question}"`, causeText: question });
  if (kind === "correction") return guard({ kind: "field-correction", category: "needs-candidate", label: `fix in the browser: "${question}"`, causeText: question });
  if (pause.upload) return guard({ kind: "document", category: "needs-candidate", label: `document: "${question}"`, causeText: question });
  const suggested = pause.suggestedKey?.trim() ?? "";
  if (suggested && FACT_KEY.test(suggested)) {
    const saved = context.factScopes.has(`${suggested}\u0000${pause.suggestedScope ?? "global"}`);
    return saved
      ? { kind: "saved-fact-unused", category: "needs-fix", label: `saved fact not used: ${suggested}`, causeText: suggested }
      : { kind: "missing-fact", category: "needs-candidate", label: `missing fact: ${suggested}`, causeText: suggested };
  }
  if (context.questionKeys.has(normalizeQuestionText(pause.label))) {
    return guard({ kind: "saved-answer-unused", category: "needs-fix", label: `saved answer not used: "${question}"`, causeText: question });
  }
  return guard({ kind: "question", category: "needs-candidate", label: `question: "${question}"`, causeText: question });
}

function stopCause(detail: string | null | undefined, company: string, run: BrowserRun | null, matches: ValueMatcher): Cause {
  const cleaned = detail?.trim() ? normalizeStopReason(detail, company).label : "";
  let label = cleaned || (run && run.status !== "failed" ? "paused with no open question" : "browser run failed");
  if (run && !startsWithAts(label)) label = `${run.atsKind}: ${label}`;
  const rawText = detail?.trim() ? detail : label;
  return guardCause({ kind: "stop", category: stopReasonCategory(label), label, causeText: label }, rawText, matches, run?.atsKind ?? "");
}

const RUN_NOT_AT_SUBMIT = /^The run is \S+, not waiting at the submit step\.$/;
const OPEN_QUESTIONS_REASON = "The form has unanswered questions waiting for you.";

function submitHoldCauses(
  reason: "approval" | "form-review", run: BrowserRun, passReasons: ReadonlyArray<string>, company: string, matches: ValueMatcher
): Cause[] {
  const causes = new Map<string, Cause>();
  for (const text of [...passReasons, ...autoSubmitBlockers(run)]) {
    if (RUN_NOT_AT_SUBMIT.test(text) || text === OPEN_QUESTIONS_REASON) continue;
    const label = cleanCauseText(text, company);
    if (!label) continue;
    const cause = guardCause({ kind: "submit-hold", category: submitHoldCategory(label), label, causeText: label }, text, matches);
    const key = blockerKey("submit-hold", cause.causeText);
    if (!causes.has(key)) causes.set(key, cause);
  }
  if (causes.size > 0) return [...causes.values()];
  return reason === "approval"
    ? [{ kind: "submit-hold", category: "needs-candidate", label: "ready at the submit step: waiting for your approval", causeText: "ready at the submit step: waiting for your approval" }]
    : [{ kind: "submit-hold", category: "needs-fix", label: "the form needs review", causeText: "the form needs review" }];
}

const UNCONFIRMED_LABEL = "a submit may have gone through: check for a receipt before any retry";

function observationCauses(
  database: DatabaseSync, observation: HoldObservation, company: string, passHeld: Map<string, string[]>,
  facts: { factScopes: Set<string>; questionKeys: Set<string>; matches: ValueMatcher }
): Cause[] {
  if (observation.reason === "possible-submission") {
    return [{ kind: "unconfirmed-submit", category: "needs-fix", label: UNCONFIRMED_LABEL, causeText: UNCONFIRMED_LABEL }];
  }
  const run = observation.runId ? getBrowserRun(database, observation.runId) : null;
  const source = () => observation.sourceEventId
    ? listApplicationEvents(database, observation.jobId).find((event) => event.id === observation.sourceEventId)?.detail ?? null
    : null;
  if (!run) return [stopCause(source(), company, null, facts.matches)];
  const context: PauseContext = { company, atsKind: run.atsKind, ...facts };
  const open = classifyOpenPauses(run.pauses);
  const causes = open.map(({ pause, kind }) => pauseCause(pause, kind, context));
  if (observation.reason === "approval" || observation.reason === "form-review") {
    causes.push(...submitHoldCauses(observation.reason, run, passHeld.get(observation.jobId) ?? [], company, facts.matches));
  }
  if (observation.reason === "automation-fault" && !open.some(({ kind }) => kind === "fault")) causes.push(stopCause(source(), company, run, facts.matches));
  if (causes.length === 0) causes.push(stopCause(source(), company, run, facts.matches));
  return causes;
}

/** The last pass's pipeline-status.json (statusPath in scripts/pipeline-pass.ts; src never imports scripts). */
function readLastPass(dataDir: string): { summary: LastPassSummary; held: Map<string, string[]> } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, "pipeline-status.json"), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const status = raw as Record<string, unknown>;
    const length = (name: string) => Array.isArray(status[name]) ? (status[name] as unknown[]).length : 0;
    const held = new Map<string, string[]>();
    if (Array.isArray(status.held)) {
      for (const entry of status.held as unknown[]) {
        if (!entry || typeof entry !== "object") continue;
        const { jobId, reasons } = entry as { jobId?: unknown; reasons?: unknown };
        if (typeof jobId !== "string" || !Array.isArray(reasons)) continue;
        held.set(jobId, reasons.filter((reason): reason is string => typeof reason === "string"));
      }
    }
    return {
      summary: {
        finishedAt: typeof status.finishedAt === "string" ? status.finishedAt : null,
        submitted: length("submitted"), held: length("held"), ruledOut: length("ruledOut"), stopped: length("stopped"),
        waitingForSignIn: length("waitingForSignIn"), errors: length("errors")
      },
      held
    };
  } catch {
    return null;
  }
}

const utcDate = (time: number) => new Date(time).toISOString().slice(0, 10);

function windowDates(now: Date, days: number): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => utcDate(today - (days - 1 - index) * DAY_MS));
}

const TRACE_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Listing links seen in the discovery traces, by the first window date each appears; null dates had no trace file. */
function readSeen(dataDir: string, dates: ReadonlySet<string>): Map<string, number | null> {
  const seen = new Map<string, number | null>([...dates].map((date) => [date, null]));
  let names: string[] = [];
  try { names = readdirSync(discoveryTraceDirectory(dataDir)); } catch { return seen; }
  const files = names.flatMap((name) => {
    const date = TRACE_FILE.exec(name)?.[1];
    return date && dates.has(date) ? [{ name, date }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const urls = new Set<string>();
  for (const { name, date } of files) {
    let text: string;
    try { text = readFileSync(join(discoveryTraceDirectory(dataDir), name), "utf8"); } catch { continue; }
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event !== "object") continue;
      const { type, url, postingUrl } = event as { type?: unknown; url?: unknown; postingUrl?: unknown };
      if (type !== "row") continue;
      const key = typeof url === "string" && url ? url : typeof postingUrl === "string" && postingUrl ? postingUrl : null;
      if (!key || urls.has(key)) continue;
      urls.add(key);
      count += 1;
    }
    seen.set(date, count);
  }
  return seen;
}

type Stage = "stored" | "qualified" | "ruledOut" | "started" | "reachedSubmit" | "confirmed" | "failedOrHeld";
const STAGES: Stage[] = ["stored", "qualified", "ruledOut", "started", "reachedSubmit", "confirmed", "failedOrHeld"];

const TARGET_SKIP = "Not pursued for your target: ";
const RUN_START = /^(?:Browser|Workday) run started automatically|^Automatic browser run (?:waiting|needs you|failed|stopped):/;
const REACHED_SUBMIT = /^Submission approved |^Post-submit evidence saved|^Automatic submission failed/;
/** The 2026-11-21 closed-dialog relabel (RELABEL_CONFIRMATION in automatic-retry.ts) is not a confirmation. */
const RELABEL = /\bmodal dialog closed after submit without errors\b/i;
const QUICK_SKIPS: ReadonlySet<string> = new Set(Object.values(QUICK_SKIP_REASONS));

const RULED_OUT_WITHHELD = "ruled out (reason withheld)";

function targetSkipReason(detail: string, matches: ValueMatcher): string {
  const head = /^([A-Za-z][A-Za-z ]{0,30}):/.exec(detail.slice(TARGET_SKIP.length))?.[1];
  if (head && matches(head)) return RULED_OUT_WITHHELD;
  return `not pursued for your target: ${head ? head.trim().toLowerCase() : "other"}`;
}

function countBy(values: Iterable<string>): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

export function buildScoreboard(input: { database: DatabaseSync; dataDir: string; now: Date; days: number }): Scoreboard {
  const { database, dataDir, now } = input;
  const days = Math.min(SCOREBOARD_MAX_DAYS, Math.max(1, Math.floor(input.days)));
  const dates = windowDates(now, days);
  const since = `${dates[0]!}T00:00:00.000Z`;
  const dateSet = new Set(dates);

  const jobs = listScoreboardJobs(database);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const events = listScoreboardEventsSince(database, since);
  const eventsByJob = new Map<string, ScoreboardEvent[]>();
  for (const event of events) eventsByJob.set(event.jobId, [...(eventsByJob.get(event.jobId) ?? []), event]);
  const runs = listScoreboardRunsSince(database, since);
  const matches = new Map(listScoreboardMatches(database).map((match) => [match.jobId, match]));
  const feedback = new Map(listDiscoverySkipReasons(database).map((row) => [row.jobId, row]));
  // Candidate-entered values, only to withhold printed labels that hold one; never stored on the board.
  const withholds = scoreboardMatcher(database);

  const stages = new Map<Stage, Map<string, number>>(STAGES.map((stage) => [stage, new Map()]));
  const mark = (stage: Stage, jobId: string, at: string | null | undefined) => {
    if (!at) return;
    const time = Date.parse(at);
    if (!Number.isFinite(time) || !dateSet.has(utcDate(time))) return;
    const map = stages.get(stage)!;
    const current = map.get(jobId);
    if (current === undefined || time < current) map.set(jobId, time);
  };
  const inWindow = (at: string | null | undefined) => {
    const time = at ? Date.parse(at) : NaN;
    return Number.isFinite(time) && dateSet.has(utcDate(time));
  };

  for (const job of jobs) mark("stored", job.id, job.createdAt);
  for (const match of matches.values()) if (match.verdict === "QUALIFIED" && match.eligible) mark("qualified", match.jobId, match.evaluatedAt);
  for (const event of events) {
    if (event.toStatus === "PREPARING" && event.fromStatus !== "PREPARING") mark("qualified", event.jobId, event.createdAt);
    if (RUN_START.test(event.detail ?? "") || (event.toStatus === "APPLYING" && event.fromStatus !== "APPLYING")) mark("started", event.jobId, event.createdAt);
    if (REACHED_SUBMIT.test(event.detail ?? "")) mark("reachedSubmit", event.jobId, event.createdAt);
  }
  for (const run of runs) {
    mark("started", run.jobId, run.createdAt);
    mark("reachedSubmit", run.jobId, run.submissionApprovedAt);
    if (run.status === "awaiting-approval" || run.status === "submitting" || run.status === "submitted") mark("reachedSubmit", run.jobId, run.updatedAt);
  }

  // Ruled out: only a job whose current state is ruled out, timed in the window.
  const ruledOutReasons = new Map<string, string>();
  for (const job of jobs) {
    const timeline = eventsByJob.get(job.id) ?? [];
    if (job.status === "NOT_QUALIFIED") {
      const outEvents = timeline.filter((event) => event.toStatus === "NOT_QUALIFIED" && event.fromStatus !== "NOT_QUALIFIED");
      const skip = feedback.get(job.id);
      const match = matches.get(job.id);
      const at = outEvents[0]?.createdAt
        ?? (inWindow(match?.evaluatedAt) ? match!.evaluatedAt : undefined)
        ?? (inWindow(skip?.createdAt) ? skip!.createdAt : undefined);
      if (!at) continue;
      const head = outEvents.find((event) => event.detail?.trim())?.detail?.split(":")[0];
      const cleanedHead = !head ? "" : withholds(head) || withholds(cleanCauseText(head, job.companyName)) ? RULED_OUT_WITHHELD
        : cleanCauseText(head, job.companyName);
      const reason = skip && QUICK_SKIPS.has(skip.reason) ? skip.reason
        : skip ? "skipped by your feedback"
        : cleanedHead ? cleanedHead
        : match?.failedSubjects.length ? `not qualified: ${[...new Set(match.failedSubjects)].map((subject) => subject.toLowerCase()).join(" + ")}`
        : "not qualified";
      mark("ruledOut", job.id, at);
      if (stages.get("ruledOut")!.has(job.id)) ruledOutReasons.set(job.id, reason);
    } else if (job.status === "QUALIFIED" || job.status === "READY_FOR_REVIEW") {
      const latest = timeline.filter((event) => event.fromStatus !== event.toStatus
        || event.detail?.startsWith(TARGET_SKIP) || event.detail?.startsWith(COMPANY_CAP_PREFIX)).at(-1);
      if (!latest?.detail) continue;
      const reason = latest.detail.startsWith(TARGET_SKIP) ? targetSkipReason(latest.detail, withholds)
        : latest.detail.startsWith(COMPANY_CAP_PREFIX) ? "company cap" : null;
      if (!reason) continue;
      mark("ruledOut", job.id, latest.createdAt);
      if (stages.get("ruledOut")!.has(job.id)) ruledOutReasons.set(job.id, reason);
    }
  }

  // Confirmed: a recognized confirmation on a submitted run, or a checked receipt. Nothing else.
  const confirmedRuns = listSubmittedRunConfirmations(database)
    .filter((run) => (run.confirmationText ?? "").trim() !== "" && !RELABEL.test(run.confirmationText ?? ""));
  const receipts = listConfirmedReceipts(database);
  const confirmedEver = new Set([...confirmedRuns.map((run) => run.jobId), ...receipts.map((receipt) => receipt.jobId)]);
  for (const run of confirmedRuns) {
    const submittedEvent = (eventsByJob.get(run.jobId) ?? []).find((event) => event.toStatus === "SUBMITTED" && event.fromStatus !== "SUBMITTED");
    mark("confirmed", run.jobId, submittedEvent?.createdAt ?? run.updatedAt);
  }
  for (const receipt of receipts) mark("confirmed", receipt.jobId, receipt.checkedAt);
  const markedUnconfirmed = new Set([
    ...jobs.filter((job) => job.status === "SUBMITTED").map((job) => job.id),
    ...events.filter((event) => event.toStatus === "SUBMITTED").map((event) => event.jobId)
  ].filter((jobId) => !confirmedEver.has(jobId)));

  // The blocker board, from the current hold observations (read-only; nothing is reconciled).
  const holdsAvailable = applicationHoldSchemaPresent(database);
  const observations = holdsAvailable ? observeApplicationHolds(database, dataDir).observations : [];
  const lastPass = readLastPass(dataDir);
  const facts = {
    factScopes: new Set(listCurrentFactScopes(database).map(({ key, scopeKey }) => `${key}\u0000${scopeKey}`)),
    questionKeys: new Set(listCurrentQuestionKeys(database)),
    matches: withholds
  };
  type Entry = Omit<Blocker, "id" | "applications" | "unblocks" | "companies" | "owner" | "holdReasons" | "claim"> & {
    jobs: Set<string>; companies: Set<string>; owner: Set<string>; holdReasons: Set<string>;
  };
  const entries = new Map<string, Entry>();
  const blockersByJob = new Map<string, Set<string>>();
  const holdReasonsByJob = new Map<string, Set<string>>();
  for (const observation of observations) {
    const company = jobsById.get(observation.jobId)?.companyName ?? "";
    holdReasonsByJob.set(observation.jobId, new Set([...(holdReasonsByJob.get(observation.jobId) ?? []), observation.reason]));
    for (const cause of observationCauses(database, observation, company, lastPass?.held ?? new Map(), facts)) {
      const key = blockerKey(cause.kind, cause.causeText);
      const entry = entries.get(key) ?? {
        key, kind: cause.kind, category: cause.category, label: cause.label,
        jobs: new Set<string>(), companies: new Set<string>(), owner: new Set<string>(), holdReasons: new Set<string>()
      };
      entry.jobs.add(observation.jobId);
      if (company) entry.companies.add(company);
      entry.owner.add(observation.owner);
      entry.holdReasons.add(observation.reason);
      entries.set(key, entry);
      blockersByJob.set(observation.jobId, new Set([...(blockersByJob.get(observation.jobId) ?? []), key]));
    }
  }

  const claimsFile = readScoreboardClaims(dataDir);
  const claimView = (claim: { track: string; claimedAt: string; renewedAt: string }): BlockerClaimView => ({
    track: claim.track, claimedAt: claim.claimedAt, renewedAt: claim.renewedAt, ageHours: claimAgeHours(claim, now), stale: claimIsStale(claim, now)
  });
  const sort = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  const blockers: Blocker[] = [...entries.values()].map((entry) => {
    const id = blockerId(entry.key);
    const claim = claimsFile.claims.find((candidate) => candidate.id === id);
    return {
      id, key: entry.key, kind: entry.kind, category: entry.category, label: entry.label,
      applications: entry.jobs.size,
      unblocks: [...entry.jobs].filter((jobId) => blockersByJob.get(jobId)?.size === 1).length,
      companies: sort(entry.companies), owner: sort(entry.owner), holdReasons: sort(entry.holdReasons),
      claim: claim ? claimView(claim) : null
    };
  }).sort((a, b) => b.applications - a.applications || b.unblocks - a.unblocks
    || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const byCategory = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, new Set(
    blockers.filter((blocker) => blocker.category === category).flatMap((blocker) => [...entries.get(blocker.key)!.jobs])
  ).size])) as Record<BlockerCategory, number>;

  // Failed or held now: started jobs that have a current hold, on their started day.
  const started = stages.get("started")!;
  for (const [jobId, time] of started) if (holdReasonsByJob.has(jobId)) stages.get("failedOrHeld")!.set(jobId, time);
  const failedOrHeldByHold = countBy([...stages.get("failedOrHeld")!.keys()].flatMap((jobId) => [...holdReasonsByJob.get(jobId)!]));
  const requeuedOrInProgress = [...started.keys()].filter((jobId) =>
    !confirmedEver.has(jobId) && !holdReasonsByJob.has(jobId) && !markedUnconfirmed.has(jobId)).length;

  const seen = readSeen(dataDir, dateSet);
  const countOn = (stage: Stage, date: string) => [...stages.get(stage)!.values()].filter((time) => utcDate(time) === date).length;
  const perDay = dates.map((date) => ({
    date, seen: seen.get(date) ?? null,
    stored: countOn("stored", date), qualified: countOn("qualified", date), ruledOut: countOn("ruledOut", date),
    started: countOn("started", date), reachedSubmit: countOn("reachedSubmit", date), confirmed: countOn("confirmed", date),
    failedOrHeld: countOn("failedOrHeld", date)
  }));
  const seenDays = perDay.filter((day) => day.seen !== null);
  const totals: FunnelCounts = {
    seen: seenDays.length ? seenDays.reduce((sum, day) => sum + (day.seen ?? 0), 0) : null,
    stored: stages.get("stored")!.size, qualified: stages.get("qualified")!.size, ruledOut: stages.get("ruledOut")!.size,
    started: started.size, reachedSubmit: stages.get("reachedSubmit")!.size, confirmed: stages.get("confirmed")!.size,
    failedOrHeld: stages.get("failedOrHeld")!.size
  };

  const onBoard = new Set(blockers.map((blocker) => blocker.id));
  const recentCutoff = now.getTime() - 7 * DAY_MS;
  return {
    version: 1,
    generatedAt: now.toISOString(),
    days,
    since,
    until: now.toISOString(),
    funnel: {
      days: perDay,
      totals,
      ruledOutByReason: countBy(ruledOutReasons.values()),
      markedSubmittedUnconfirmed: markedUnconfirmed.size,
      failedOrHeldByHold,
      requeuedOrInProgress
    },
    stock: countJobsByStatus(database).map(({ status, count }) => ({ status, count: Number(count) })),
    lastPass: lastPass?.summary ?? null,
    holdsAvailable,
    heldApplications: new Set(observations.map((observation) => observation.jobId)).size,
    byCategory,
    blockers,
    claims: {
      offBoard: claimsFile.claims.filter((claim) => !onBoard.has(claim.id))
        .map((claim) => ({ id: claim.id, label: guardLabel(claim.label, withholds), ...claimView(claim) })),
      recent: claimsFile.history.filter((entry) => Date.parse(entry.at) >= recentCutoff)
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((entry) => ({
          ...entry, label: guardLabel(entry.label, withholds), reason: entry.reason !== null && withholds(entry.reason) ? WITHHELD_REASON : entry.reason
        }))
    },
    changes: null
  };
}

const snapshotSchema = z.object({
  version: z.literal(1),
  at: z.iso.datetime(),
  days: z.number().int(),
  heldApplications: z.number().int(),
  confirmed: z.number().int(),
  blockers: z.array(z.object({ id: z.string(), label: z.string(), category: z.string(), applications: z.number().int() }))
});
export type ScoreboardSnapshot = z.infer<typeof snapshotSchema>;

const SNAPSHOT_FILE = /^snapshot-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

export function snapshotFileName(at: Date): string {
  return `snapshot-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

function snapshotTime(name: string): number | null {
  const parts = SNAPSHOT_FILE.exec(name);
  if (!parts) return null;
  const time = Date.parse(`${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}.${parts[5]}Z`);
  return Number.isFinite(time) ? time : null;
}

/** Saves the board's snapshot (mode 600 in a mode 700 folder) and returns its path. */
export function writeScoreboardSnapshot(dataDir: string, board: Scoreboard): string {
  const directory = scoreboardDirectory(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const snapshot: ScoreboardSnapshot = {
    version: 1, at: board.generatedAt, days: board.days, heldApplications: board.heldApplications, confirmed: board.funnel.totals.confirmed,
    blockers: board.blockers.map(({ id, label, category, applications }) => ({ id, label, category, applications }))
  };
  const path = join(directory, snapshotFileName(new Date(board.generatedAt)));
  writeFileSync(path + ".tmp", JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path + ".tmp", 0o600);
  renameSync(path + ".tmp", path);
  return path;
}

/** The newest readable snapshot taken before `now`; damaged files are ignored. */
export function readPreviousSnapshot(dataDir: string, now: Date): ScoreboardSnapshot | null {
  let names: string[];
  try { names = readdirSync(scoreboardDirectory(dataDir)); } catch { return null; }
  const candidates = names.flatMap((name) => {
    const time = snapshotTime(name);
    return time !== null && time < now.getTime() ? [{ name, time }] : [];
  }).sort((a, b) => b.time - a.time);
  for (const { name } of candidates) {
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(join(scoreboardDirectory(dataDir), name), "utf8")));
      if (parsed.success && Date.parse(parsed.data.at) < now.getTime()) return parsed.data;
    } catch {
      // A damaged snapshot is skipped.
    }
  }
  return null;
}

/**
 * Removes snapshots more than SNAPSHOT_RETENTION_DAYS before `now` and all but the newest
 * SNAPSHOT_RETENTION_COUNT; returns the removed names and never throws.
 */
export function pruneScoreboardSnapshots(dataDir: string, now: Date): string[] {
  const removed: string[] = [];
  try {
    const cutoff = now.getTime() - SNAPSHOT_RETENTION_DAYS * DAY_MS;
    const snapshots = readdirSync(scoreboardDirectory(dataDir)).flatMap((name) => {
      const time = snapshotTime(name);
      return time === null ? [] : [{ name, time }];
    }).sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
    snapshots.forEach(({ name, time }, index) => {
      if (time >= cutoff && index < SNAPSHOT_RETENTION_COUNT) return;
      try {
        rmSync(join(scoreboardDirectory(dataDir), name), { force: true });
        removed.push(name);
      } catch {
        // Pruning never fails the command.
      }
    });
  } catch {
    // A missing folder has nothing to prune.
  }
  return removed;
}

/**
 * What every pipeline pass runs at its end: builds the board with the scoreboard command's
 * code, saves its snapshot, and prunes the folder. A failed build throws; a failed save is
 * returned as its error code, so the caller can log one line and carry on.
 */
export function refreshScoreboardSnapshot(input: { database: DatabaseSync; dataDir: string; now: Date }): { board: Scoreboard; saveError: string | null } {
  const board = buildScoreboard({ database: input.database, dataDir: input.dataDir, now: input.now, days: SCOREBOARD_DEFAULT_DAYS });
  try {
    writeScoreboardSnapshot(input.dataDir, board);
  } catch (error) {
    return { board, saveError: error && typeof error === "object" && "code" in error ? String(error.code) : "write failed" };
  }
  pruneScoreboardSnapshots(input.dataDir, input.now);
  return { board, saveError: null };
}

const PASS_BOARD_BLOCKERS = 3;
const PASS_BOARD_LABEL_LIMIT = 80;

/** The pass summary's one board line: held applications and the top blockers with their counts. */
export function passBoardLine(board: Scoreboard, saveError: string | null): string {
  const label = (text: string) => text.length > PASS_BOARD_LABEL_LIMIT ? `${text.slice(0, PASS_BOARD_LABEL_LIMIT - 1)}…` : text;
  const top = board.blockers.slice(0, PASS_BOARD_BLOCKERS).map((blocker) => `${label(blocker.label)} ${blocker.applications}`);
  return `Board: ${plural(board.heldApplications, "application")} held; `
    + (top.length ? `top blockers: ${top.join(", ")}` : "no blockers")
    + (saveError === null ? " (snapshot saved)" : ` (snapshot not saved: ${saveError})`);
}

/** The changes since `previous`; every label it returns is withheld when `matches` finds a candidate value in it. */
export function compareSnapshots(previous: ScoreboardSnapshot, board: Scoreboard, matches: ValueMatcher = neverMatches): ScoreboardChanges {
  const before = new Map(previous.blockers.map((blocker) => [blocker.id, blocker]));
  const after = new Map(board.blockers.map((blocker) => [blocker.id, blocker]));
  const changes: Array<{ id: string; label: string; before: number; after: number }> = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(id)?.applications ?? 0;
    const now = after.get(id)?.applications ?? 0;
    if (was !== now) changes.push({ id, label: guardLabel(after.get(id)?.label ?? before.get(id)!.label, matches), before: was, after: now });
  }
  const order = (a: { label: string; before: number; after: number }, b: { label: string; before: number; after: number }) =>
    Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || a.label.localeCompare(b.label);
  return {
    previousAt: previous.at,
    heldBefore: previous.heldApplications, heldNow: board.heldApplications,
    confirmedBefore: previous.confirmed, confirmedNow: board.funnel.totals.confirmed,
    grew: changes.filter((change) => change.after > change.before).sort(order),
    shrank: changes.filter((change) => change.after < change.before).sort(order)
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const BOARD_LINES = 20;
const COMPANY_LIMIT = 6;
const CHANGE_LIMIT = 5;

function claimSuffix(claim: BlockerClaimView | null): string {
  if (!claim) return "";
  return `; claimed by ${claim.track}, ${claim.ageHours}h ago${claim.stale ? " (stale)" : ""}`;
}

function changeList(items: ScoreboardChanges["grew"]): string {
  const shown = items.slice(0, CHANGE_LIMIT).map((item) => `[${item.id}] ${item.label} ${item.before} → ${item.after}`);
  return shown.join(", ") + (items.length > CHANGE_LIMIT ? `, +${items.length - CHANGE_LIMIT} more` : "");
}

export function formatScoreboard(board: Scoreboard): string[] {
  const first = board.funnel.days[0]?.date ?? board.since.slice(0, 10);
  const last = board.funnel.days.at(-1)?.date ?? board.until.slice(0, 10);
  const lines = [
    `Application scoreboard — last ${board.days} days (${first} to ${last} UTC)`,
    "Only confirmed submissions count: a recognized confirmation or a checked receipt.",
    ""
  ];
  const header = ["date", "seen", "stored", "qualified", "ruled out", "started", "at submit", "confirmed", "failed/held"];
  const row = (date: string, counts: FunnelCounts) => [date, counts.seen === null ? "-" : String(counts.seen), String(counts.stored),
    String(counts.qualified), String(counts.ruledOut), String(counts.started), String(counts.reachedSubmit), String(counts.confirmed),
    String(counts.failedOrHeld)];
  const rows = [header, ...board.funnel.days.map((day) => row(day.date, day)), row("total", board.funnel.totals)];
  const widths = header.map((_, column) => Math.max(...rows.map((cells) => cells[column]!.length)));
  for (const cells of rows) lines.push(cells.map((cell, column) => column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!)).join("  ").trimEnd());
  lines.push("");
  lines.push(`Marked submitted without confirmation (not counted): ${board.funnel.markedSubmittedUnconfirmed}`);
  const reasons = (items: Array<{ reason: string; count: number }>) => items.length ? items.map((item) => `${item.reason} ${item.count}`).join(", ") : "none";
  lines.push(`Ruled out by reason: ${reasons(board.funnel.ruledOutByReason)}`);
  lines.push(`Failed or held now, by hold: ${reasons(board.funnel.failedOrHeldByHold)}`);
  lines.push(`Requeued or still running: ${board.funnel.requeuedOrInProgress}`);
  lines.push(`Right now: ${board.stock.length ? board.stock.map((item) => `${item.status} ${item.count}`).join(", ") : "no postings"}`);
  if (board.lastPass) {
    const pass = board.lastPass;
    lines.push(`Last pass (finished ${pass.finishedAt ?? "unknown"}): submitted ${pass.submitted}, held ${pass.held}, ruled out ${pass.ruledOut}, `
      + `stopped ${pass.stopped}, waiting for sign-in ${pass.waitingForSignIn}, errors ${pass.errors}`);
  }
  lines.push("");
  if (!board.holdsAvailable) lines.push("The hold tables are missing from this database (before migration 0033), so the blocker board is empty.");
  lines.push(`Blocker board: ${plural(board.heldApplications, "application")} held or paused now.`);
  const top = board.blockers[0];
  if (top) {
    lines.push(`Biggest blocker: [${top.id}] ${top.label} — ${plural(top.applications, "application")} (${BLOCKER_CATEGORY_WORDS[top.category]})`);
  }
  board.blockers.slice(0, BOARD_LINES).forEach((blocker, index) => {
    const companies = blocker.companies.slice(0, COMPANY_LIMIT).join(", ")
      + (blocker.companies.length > COMPANY_LIMIT ? `, +${blocker.companies.length - COMPANY_LIMIT} more` : "");
    lines.push(`${index + 1}. [${blocker.id}] [${BLOCKER_CATEGORY_WORDS[blocker.category]}] ${blocker.label} — `
      + `${plural(blocker.applications, "application")}, ${blocker.unblocks} held only by this${companies ? ` (${companies})` : ""}${claimSuffix(blocker.claim)}`);
  });
  if (board.blockers.length > BOARD_LINES) lines.push(`+${board.blockers.length - BOARD_LINES} more blockers (use --json)`);
  lines.push(`By category: ${CATEGORY_ORDER.map((category) => `${BLOCKER_CATEGORY_WORDS[category]} ${board.byCategory[category]}`).join(", ")}`);
  if (board.claims.offBoard.length) {
    lines.push(`Claims off the board: ${board.claims.offBoard.map((claim) =>
      `[${claim.id}] ${claim.track}, ${claim.ageHours}h ago${claim.stale ? " (stale)" : ""}: ${claim.label}`).join("; ")}`);
  }
  if (board.claims.recent.length) {
    lines.push(`Claim changes (last 7 days): ${board.claims.recent.map((entry) =>
      `${entry.id} ${entry.track} ${entry.event}${entry.reason ? `: ${entry.reason}` : ""}`).join("; ")}`);
  }
  const changes = board.changes;
  if (changes) {
    lines.push(`Since the last scoreboard (${changes.previousAt}): held ${changes.heldBefore} → ${changes.heldNow}; `
      + `confirmed submissions (${board.days} days) ${changes.confirmedBefore} → ${changes.confirmedNow}; `
      + `grew: ${changes.grew.length ? changeList(changes.grew) : "none"}; shrank: ${changes.shrank.length ? changeList(changes.shrank) : "none"}`);
  } else lines.push("No earlier scoreboard snapshot to compare with.");
  return lines;
}
