import { createHash } from "node:crypto";

import type { AppliedJob } from "@internship-agent/db";

import { redactNoticeText } from "./pass-notice";

/**
 * Deterministic rules for the Gmail outcome watcher: which emails follow
 * from an application the candidate made (interview, online assessment,
 * offer, rejection, recruiter reply, or a site's security or verification
 * code, which is machinery: recorded on the timeline, never DMed), which
 * application they belong to, and the Discord text about them. Pure: no database, network, or model. Bodies
 * are read only to classify and are never part of any output.
 */
export type { AppliedJob };

export type MailHeader = {
  uid: number;
  messageId: string | null;
  fromName: string;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  /** A List-Unsubscribe or List-Id header, or Precedence: bulk|list|junk. */
  bulk: boolean;
};

export type MailCategory = "assessment" | "interview" | "offer" | "rejection" | "recruiter" | "verification";
export type MailDeadline = { text: string; date: string | null };
/** jobs.length === 1 means the match is unambiguous. */
export type MailMatch = { company: string; jobs: AppliedJob[]; via: "sender" | "subject" | "body" };
export type MailItem = {
  key: string;
  uid: number;
  category: MailCategory;
  senderDomain: string;
  /** Already redacted and clipped. */
  subject: string;
  deadline: MailDeadline | null;
  match: MailMatch;
};

export const ATS_DOMAINS: readonly string[] = [
  "greenhouse.io", "greenhouse-mail.io", "lever.co", "ashbyhq.com", "myworkday.com", "workday.com", "myworkdayjobs.com",
  "smartrecruiters.com", "icims.com", "jobvite.com", "taleo.net", "oraclecloud.com", "successfactors.com", "successfactors.eu",
  "sapsf.com", "bamboohr.com", "workable.com", "workablemail.com", "recruitee.com", "breezy.hr", "applytojob.com", "jazzhr.com",
  "rippling.com", "gem.com", "avature.net", "eightfold.ai", "phenompeople.com", "paradox.ai", "dover.com", "teamtailor.com",
  "pinpointhq.com"
];
export const ASSESSMENT_DOMAINS: readonly string[] = [
  "hackerrank.com", "hackerrankforwork.com", "codesignal.com", "codility.com", "hirevue.com", "karat.io", "karat.com",
  "testgorilla.com", "coderbyte.com", "hackerearth.com", "mettl.com", "shl.com", "pymetrics.ai", "harver.com", "imocha.io",
  "qualified.io", "devskiller.com", "vervoe.com", "criteriacorp.com"
];
export const SCHEDULING_DOMAINS: readonly string[] = ["calendly.com", "goodtime.io", "modernloop.io", "prelude.co", "cronofy.com"];
export const IGNORED_DOMAINS: readonly string[] = [
  "linkedin.com", "indeed.com", "glassdoor.com", "ziprecruiter.com", "joinhandshake.com", "simplify.jobs", "wellfound.com",
  "dice.com", "monster.com"
];

const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "technologies",
  "technology", "labs", "group", "holdings"
]);

const MAX_BODY_MATCH_CHARS = 20_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function inDomains(domain: string, list: readonly string[]): boolean {
  return domain !== "" && list.some((entry) => domain === entry || domain.endsWith("." + entry));
}

function trustedSender(domain: string): boolean {
  return inDomains(domain, ATS_DOMAINS) || inDomains(domain, ASSESSMENT_DOMAINS) || inDomains(domain, SCHEDULING_DOMAINS);
}

/** Tokens of text: NFKD, diacritics dropped, lowercase, "&" as "and", anything else non-alphanumeric as a break. */
function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Normalized text padded with spaces, so `" " + key + " "` tests a whole-word phrase. */
function padded(text: string): string {
  return ` ${tokens(text).join(" ")} `;
}

function containsPhrase(paddedText: string, key: string): boolean {
  return key !== "" && paddedText.includes(` ${key} `);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, code: string) => {
      const value = Number(code);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    })
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function senderDomain(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  const domain = address.slice(at + 1).trim().toLocaleLowerCase("en-US");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : "";
}

/** The company name as matching tokens: no leading "the", no trailing legal or generic suffixes. */
export function companyKey(name: string): string {
  const all = tokens(name);
  const words = [...all];
  if (words[0] === "the" && words.length > 1) words.shift();
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return (words.length ? words : all).join(" ");
}

const compact = (key: string) => key.replace(/ /g, "");

/** The employer's tenant slug on a known ATS posting URL, or null. Never throws. */
export function atsTenant(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLocaleLowerCase("en-US");
  let raw: string | null = null;
  const pathHosts = ["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io", "jobs.lever.co", "jobs.eu.lever.co",
    "jobs.ashbyhq.com", "jobs.smartrecruiters.com"];
  if (pathHosts.includes(host)) raw = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  else raw = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host)?.[1] ?? null;
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the raw segment */ }
  const tenant = decoded.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  return tenant.length >= 3 ? tenant : null;
}

/** The label before the public suffix (naive: foo.com → foo, foo.co.uk → foo). */
function registrableLabel(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const last = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  if (labels.length >= 3 && /^[a-z]{2}$/.test(last) && ["co", "com", "ac", "org", "net"].includes(second)) return labels[labels.length - 3] ?? "";
  return second;
}

function jobTenants(job: AppliedJob): string[] {
  return [job.sourceUrl, job.externalApplicationUrl]
    .filter((url): url is string => typeof url === "string" && url !== "")
    .map(atsTenant)
    .filter((tenant): tenant is string => tenant !== null);
}

const TIER_RANK = { sender: 3, subject: 2, body: 1 } as const;

export function matchApplication(input: { header: MailHeader; body: string | null }, jobs: AppliedJob[]): MailMatch | null {
  const { header } = input;
  const domain = senderDomain(header.fromAddress);
  const label = registrableLabel(domain).replace(/[^a-z0-9]/g, "");
  const workdaySender = domain === "myworkday.com" || domain.endsWith(".myworkday.com") || domain === "workday.com" || domain.endsWith(".workday.com");
  const localPart = header.fromAddress.slice(0, Math.max(0, header.fromAddress.lastIndexOf("@"))).toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  const fromName = padded(header.fromName);
  const subject = padded(header.subject);
  const bodyAllowed = input.body !== null && trustedSender(domain);
  const body = bodyAllowed ? padded((input.body ?? "").slice(0, MAX_BODY_MATCH_CHARS)) : "";

  const reached: Array<{ job: AppliedJob; key: string; tier: keyof typeof TIER_RANK }> = [];
  for (const job of jobs) {
    const key = companyKey(job.companyName);
    const keyCompact = compact(key);
    const tenants = jobTenants(job);
    let tier: keyof typeof TIER_RANK | null = null;
    if (
      (label !== "" && (label === keyCompact || tenants.includes(label))) ||
      (workdaySender && localPart !== "" && tenants.includes(localPart)) ||
      (keyCompact.length >= 3 && containsPhrase(fromName, key))
    ) tier = "sender";
    else if (keyCompact.length >= 4 && containsPhrase(subject, key)) tier = "subject";
    else if (bodyAllowed && keyCompact.length >= 4 && containsPhrase(body, key)) tier = "body";
    if (tier) reached.push({ job, key, tier });
  }
  if (reached.length === 0) return null;

  const best = Math.max(...reached.map((entry) => TIER_RANK[entry.tier]));
  const top = reached.filter((entry) => TIER_RANK[entry.tier] === best);
  const via = top[0]!.tier;
  const companies = new Set(top.map((entry) => entry.key));
  if (companies.size > 1) return { company: top[0]!.job.companyName, jobs: top.map((entry) => entry.job), via };

  let candidates = top.map((entry) => entry.job);
  if (candidates.some((job) => job.submitted)) candidates = candidates.filter((job) => job.submitted);
  if (candidates.length > 1) {
    const text = padded(`${header.subject} ${(input.body ?? "").slice(0, MAX_BODY_MATCH_CHARS)}`);
    const titled = candidates.filter((job) => containsPhrase(text, tokens(job.title).join(" ")));
    if (titled.length === 1) candidates = titled;
  }
  return { company: candidates[0]!.companyName, jobs: candidates, via };
}

/** Whether the body is worth reading at all; mail that fails this is never opened. */
export function relevantHeader(header: MailHeader, jobs: AppliedJob[], candidateAddress: string): boolean {
  if (candidateAddress && header.fromAddress.trim().toLocaleLowerCase("en-US") === candidateAddress.trim().toLocaleLowerCase("en-US")) return false;
  const domain = senderDomain(header.fromAddress);
  if (domain === "" || inDomains(domain, IGNORED_DOMAINS)) return false;
  if (trustedSender(domain)) return true;
  return matchApplication({ header, body: null }, jobs) !== null;
}

/**
 * A subject naming a site's emailed code or account check (Greenhouse's
 * "Security code for your application to …", Workday's "Verify your
 * account", a verification or one-time code): machinery, not a company reply.
 */
const VERIFICATION = ["security code", "verification code", "verify your account", "one-time code", "one time code", "one-time passcode",
  "one time passcode"];
const ACCOUNT_NOISE = ["verify your email", "verify your account", "activate your account", "confirm your email", "reset your password",
  "password reset", "verification code"];
const REJECTION = ["not be moving forward", "not moving forward", "won't be moving forward", "will not be moving forward",
  "decided to move forward with other candidates", "move forward with other candidates", "pursue other candidates", "decided not to proceed",
  "will not be proceeding", "not able to move forward", "unable to move forward", "unable to offer you", "regret to inform", "not been selected",
  "were not selected", "was not selected", "position has been filled", "no longer under consideration", "other applicants whose",
  "candidates whose qualifications"];
const OFFER = ["pleased to offer you", "excited to offer you", "delighted to offer you", "happy to offer you", "offer of employment", "offer letter",
  "extend you an offer", "extend an offer", "extending an offer", "internship offer", "formal offer", "verbal offer"];
const COMPLETION = ["thank you for completing", "thanks for completing", "thank you for taking the", "you have completed", "you've completed",
  "has been submitted successfully"];
const ASSESSMENT = ["online assessment", "coding assessment", "technical assessment", "coding challenge", "coding test", "technical challenge",
  "take-home", "take home assignment", "assessment invitation", "invited to complete", "complete the assessment", "complete your assessment",
  "complete an assessment", "hackerrank", "codesignal", "codility", "hirevue", "karat", "testgorilla", "coderbyte", "hackerearth"];
const INTERVIEW = ["schedule an interview", "schedule your interview", "interview invitation", "invitation to interview", "invite you to interview",
  "invite you for an interview", "would like to interview", "phone screen", "phone interview", "technical interview", "virtual interview",
  "onsite interview", "superday", "interview with", "schedule a call", "schedule a time", "your availability", "select a time", "book a time",
  "interview slot", "calendly.com/", "goodtime.io"];
const RECEIPT = ["received your application", "thank you for applying", "thanks for applying", "application has been received",
  "application was received", "we have received your application", "application received", "thank you for your application",
  "thanks for your application", "application submitted", "successfully submitted", "thank you for your interest"];
const RECRUITING_WORD = /\b(application|applied|candidate|candidacy|position|role|internship|intern|recruiter|recruiting|hiring|interview|resume|opportunity)\b/;

const any = (text: string, phrases: readonly string[]) => phrases.some((phrase) => text.includes(phrase));
const flatten = (text: string) => text.toLocaleLowerCase("en-US").replace(/[’‘]/g, "'").replace(/\s+/g, " ");

/** Whether a subject names a security or verification code step (a "verification" email, never a company reply). */
export function verificationSubject(subject: string): boolean {
  return any(flatten(subject), VERIFICATION);
}

export function classifyOutcome(input: { header: MailHeader; body: string; senderDomain: string; matchedVia: MailMatch["via"] }): MailCategory | null {
  const { header, senderDomain: domain, matchedVia } = input;
  const text = flatten(`${header.subject}\n${input.body}`);
  if (header.bulk && !trustedSender(domain) && matchedVia !== "sender") return null;
  if (verificationSubject(header.subject)) return "verification";
  if (any(text, ACCOUNT_NOISE)) return null;
  if (any(text, REJECTION)) return "rejection";
  if (any(text, OFFER)) return "offer";
  const assessmentSender = inDomains(domain, ASSESSMENT_DOMAINS);
  if (any(text, COMPLETION) && (assessmentSender || /\b(assessment|test|challenge)\b/.test(text))) return null;
  if (assessmentSender || any(text, ASSESSMENT)) return "assessment";
  if (inDomains(domain, SCHEDULING_DOMAINS) || any(text, INTERVIEW)) return "interview";
  if (any(text, RECEIPT)) return null;
  if (!header.bulk && (matchedVia === "sender" || matchedVia === "subject") && RECRUITING_WORD.test(text)) {
    // A code named only in the body is still machinery, not a reply.
    return any(text, VERIFICATION) ? "verification" : "recruiter";
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?";
const TIME = "(?:,?\\s+(?:at\\s+)?(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)(?![a-z])|\\d{1,2}:\\d{2}))?";
const KEYWORD = /\b(?:deadline|due(?: date| by)?|expires?|expiration|expiry|no later than|(?:valid|available) (?:until|through|for)|(?:complete|finish|submit|take)\b[^.\n]{0,40}?\b(?:by|before|within))\b/gi;
const PATTERNS: Array<{ regex: RegExp; kind: "relative" | "month-day" | "day-month" | "us" | "iso" }> = [
  { regex: /\b(?:within\s+)?(\d{1,3})\s+(business\s+days?|days?|hours?)\b/i, kind: "relative" },
  { regex: new RegExp(`\\b${WEEKDAY}${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?${TIME}`, "i"), kind: "month-day" },
  { regex: new RegExp(`\\b${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4})\\b)?${TIME}`, "i"), kind: "day-month" },
  { regex: new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4}|\\d{2})\\b${TIME}`, "i"), kind: "us" },
  { regex: new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b${TIME}`, "i"), kind: "iso" }
];
const ZONE = /^\s*\(?(?:[A-Z]{2,4}|UTC[+-]\d{1,2}|GMT[+-]\d{1,2})\)?(?![A-Za-z])/;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function calendarDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/** The deadline stated after a strong keyword ("complete … by", "deadline", "expires"…), or null. */
export function findDeadline(text: string, receivedAt: Date): MailDeadline | null {
  const flat = text.replace(/\s+/g, " ");
  for (const keyword of flat.matchAll(KEYWORD)) {
    const start = (keyword.index ?? 0) + keyword[0].length;
    const window = flat.slice(start, start + 80);
    let best: { match: RegExpExecArray; kind: (typeof PATTERNS)[number]["kind"] } | null = null;
    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(window);
      if (match && (best === null || match.index < best.match.index)) best = { match, kind: pattern.kind };
    }
    if (!best) continue;
    const { match, kind } = best;
    const found = deadlineFrom(match, kind, receivedAt);
    if (!found) continue;
    let phrase = match[0];
    if (kind !== "relative" && /\d(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)$|\d:\d{2}$/i.test(phrase.replace(/\.$/, "").trimEnd())) {
      const zone = ZONE.exec(window.slice(match.index + match[0].length));
      if (zone) phrase += zone[0];
    }
    const label = kind === "relative" ? found.label : phrase;
    return { text: redactNoticeText(clip(label.replace(/\s+/g, " ").trim(), 60)), date: found.date };
  }
  return null;
}

function deadlineFrom(match: RegExpExecArray, kind: (typeof PATTERNS)[number]["kind"], receivedAt: Date): { label: string; date: string | null } | null {
  if (kind === "relative") {
    const amount = Number(match[1]);
    if (!Number.isInteger(amount) || amount < 1 || amount > 999) return null;
    const unit = (match[2] ?? "").toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    const label = `within ${amount} ${unit}`;
    if (unit.startsWith("business")) return { label, date: null };
    const ms = unit.startsWith("hour") ? amount * 3_600_000 : amount * 86_400_000;
    return { label, date: isoDay(new Date(receivedAt.getTime() + ms)) };
  }
  let year: number | null;
  let month: number;
  let day: number;
  if (kind === "month-day" || kind === "day-month") {
    const monthText = (kind === "month-day" ? match[1] : match[2]) ?? "";
    const dayText = (kind === "month-day" ? match[2] : match[1]) ?? "";
    month = MONTHS[monthText.slice(0, 3).toLocaleLowerCase("en-US")] ?? 0;
    day = Number(dayText);
    year = match[3] ? Number(match[3]) : null;
  } else if (kind === "us") {
    month = Number(match[1]);
    day = Number(match[2]);
    const raw = match[3] ?? "";
    year = raw.length === 2 ? 2000 + Number(raw) : Number(raw);
  } else {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  if (year === null) {
    const thisYear = receivedAt.getUTCFullYear();
    const guess = calendarDate(thisYear, month, day);
    if (!guess) return null;
    year = guess.getTime() < receivedAt.getTime() - 30 * 86_400_000 ? thisYear + 1 : thisYear;
  }
  const date = calendarDate(year, month, day);
  return date ? { label: match[0], date: isoDay(date) } : null;
}

/** A verification subject with every code-like token (4–12 letters, digits, or dashes, with a digit) replaced; the code is never kept. */
function withoutCodes(subject: string): string {
  return subject.replace(/(?<![A-Za-z0-9-])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{4,12}(?![A-Za-z0-9-])/g, "[code]");
}

/** A stable digest of the Message-ID (or of the UID when there is none); raw Message-IDs are never stored. */
export function mailItemKey(header: MailHeader, uidValidity: string): string {
  const id = header.messageId?.trim().toLocaleLowerCase("en-US");
  const source = id ? id : `uid:${uidValidity}:${header.uid}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

export function evaluateMail(input: { header: MailHeader; body: string; jobs: AppliedJob[]; uidValidity: string }): MailItem | null {
  const { header, body } = input;
  const domain = senderDomain(header.fromAddress);
  const match = matchApplication({ header, body }, input.jobs);
  if (!match) return null;
  const category = classifyOutcome({ header, body, senderDomain: domain, matchedVia: match.via });
  if (!category) return null;
  return {
    key: mailItemKey(header, input.uidValidity),
    uid: header.uid,
    category,
    senderDomain: domain,
    subject: clip(redactNoticeText(category === "verification" ? withoutCodes(header.subject) : header.subject), 160),
    deadline: category === "assessment" ? findDeadline(`${header.subject}\n${body}`, header.receivedAt) : null,
    match
  };
}

const SECTIONS: Array<[MailCategory, string]> = [
  ["assessment", "URGENT: online assessment"],
  ["interview", "Interview"],
  ["offer", "Offer"],
  ["rejection", "Rejection"],
  ["recruiter", "Recruiter reply"]
];

const ref = (id: string) => id.slice(0, 8);

function reference(match: MailMatch): string {
  const company = clip(match.company, 120);
  if (match.jobs.length === 1) {
    const job = match.jobs[0]!;
    return `${company} — ${clip(job.title, 120)} (job ${ref(job.id)}, ${job.submitted ? "submitted" : "started"})`;
  }
  const shown = match.jobs.slice(0, 5).map((job) => `job ${ref(job.id)}`).join(", ");
  return `${company} (${match.jobs.length} applications: ${shown}${match.jobs.length > 5 ? ", …" : ""})`;
}

/**
 * The DM: category sections (assessments first, deadline first), a reference, the redacted subject, the sender domain. Never body text.
 * Verification emails are never part of it.
 */
export function formatMailNotice(all: MailItem[]): string {
  const items = all.filter((item) => item.category !== "verification");
  const n = items.length;
  const lines = [`Internship agent: ${n} new email${n === 1 ? "" : "s"} about your applications`];
  for (const [category, title] of SECTIONS) {
    const entries = items.filter((item) => item.category === category);
    if (entries.length === 0) continue;
    lines.push("", title);
    for (const item of entries) {
      const prefix = category === "assessment" ? `Deadline: ${item.deadline?.text ?? "not stated"}, ` : "";
      lines.push(`• ${prefix}${reference(item.match)}`, `  "${item.subject}" from ${item.senderDomain || "unknown sender"}`);
    }
  }
  return lines.join("\n");
}

const EVENT_LABELS: Record<MailCategory, string> = {
  assessment: "Online assessment",
  interview: "Interview invite",
  offer: "Offer",
  rejection: "Rejection",
  recruiter: "Recruiter reply",
  verification: "Verification code"
};

/** The timeline note on an unambiguously matched job. */
export function mailEventDetail(item: MailItem): string {
  const label = EVENT_LABELS[item.category] + (item.category === "assessment" && item.deadline ? ` (deadline ${item.deadline.text})` : "");
  return clip(`Email received: ${label} from ${item.senderDomain || "unknown sender"}: "${item.subject}"`, 400);
}
