/**
 * Oracle Cloud HCM Candidate Experience's emailed one-time code, read from
 * the candidate's mailbox through the read-only `VerificationMailbox` the
 * Workday verification and Greenhouse's security code use. The code lives
 * only in memory: it is typed into the page and never logged, stored, put in
 * an error, event, evidence or notice, or sent to a model. Deterministic, no
 * model.
 *
 * The rules are derived, not captured: Oracle's mail was never seen, and its
 * sender and template ("Candidate Verification Notification") are
 * configurable per tenant (Oracle's recruiting documentation). Codes are six
 * digits. The matching is conservative and fails closed: no code or more
 * than one distinct code stops the run.
 *
 * The company's own domain counts too (Track 63): a sender at a domain whose
 * registrable name is the company's name joined ("fixturenationallaboratory")
 * or its initials ("fnl"), or at the root of the posting's careers URL. Both
 * come from the posting, never from the mail. A national laboratory's code
 * mail came as "STAFFING" at its own domain with the subject "Confirm your
 * identity", naming neither the company nor the tenant (headers read
 * read-only on 2026-11-27; bodies never read).
 */
import { mentionsCompany, normalizeCompanyName } from "@internship-agent/domain";

import { htmlToText } from "./mail-outcomes";
import { MailboxUnavailable, type MailMessage, type VerificationMailbox, type VerificationMailboxFactory } from "./workday-verification-mail";

/** Messages received this long before the Next click still count (clock skew). */
export const ORACLE_CODE_CLOCK_SKEW_MS = 30_000;
export const ORACLE_CODE_POLL_MS = 10_000;
export const ORACLE_CODE_TIMEOUT_MS = 180_000;

/**
 * The tenant's host (`<tenant>.fa.<region>.oraclecloud.com`), the posting's
 * company, and the registrable domains of the posting's careers URL
 * (companyMailDomains).
 */
export type OracleCodeTarget = { host: string; company: string; companyDomains?: string[] };

const ADDRESS = /[^\s<>"',;()]+@([a-z0-9.-]+)/gi;

function senderDomains(from: string): string[] {
  return [...from.matchAll(ADDRESS)].map((match) => match[1]!.toLowerCase().replace(/\.+$/, ""));
}

const within = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);

/** From names an address on oracle.com, oraclecloud.com, or a dot-bounded subdomain of either (notoracle.com, oracle.com.example no). */
export function oracleMailSender(from: string): boolean {
  return senderDomains(from).some((domain) => within(domain, "oracle.com") || within(domain, "oraclecloud.com"));
}

/** Other application sites' mail machinery: never Oracle's code, even when it names the company. */
const OTHER_SITES = ["greenhouse-mail.io", "greenhouse.io", "myworkday.com", "workday.com", "myworkdayjobs.com", "icims.com"];

/** Second-level labels under a two-letter country code ("example.co.uk"). */
const SECOND_LEVEL = new Set(["co", "com", "ac", "gov", "org", "net", "edu"]);

/** The registrable labels of a domain: the last two, or the last three under a country's second level ("example.co.uk"); null below two labels. */
function registrableParts(domain: string): string[] | null {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1]!;
  if (labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!)) return labels.slice(-3);
  return labels.slice(-2);
}

const INITIAL_STOP_WORDS = new Set(["of", "and", "the", "for", "at", "de"]);

/**
 * The domain names a company's own mail may come from, from its name only:
 * its normalized words joined (at least 4 characters: "fixturenationallaboratory",
 * "fixturerobotics"), and the initials of three or more words other than
 * of/and/the/for/at/de ("fnl"). A single word of a longer name is never a
 * label, and no label is shorter than 3 characters.
 */
export function companyMailLabels(company: string): string[] {
  const words = normalizeCompanyName(company).split(" ").filter(Boolean);
  const labels = new Set<string>();
  const joined = words.join("");
  if (joined.length >= 4) labels.add(joined);
  const significant = words.filter((word) => !INITIAL_STOP_WORDS.has(word));
  if (significant.length >= 3) {
    const initials = significant.map((word) => word[0]!).join("");
    if (initials.length >= 3) labels.add(initials);
  }
  return [...labels];
}

/** Hosts that are application sites, job boards, or code hosting, never a company's own domain. */
const NOT_COMPANY_HOSTS = [
  ...OTHER_SITES, "oraclecloud.com", "oracle.com", "lever.co", "ashbyhq.com", "smartrecruiters.com", "jobvite.com", "taleo.net",
  "successfactors.com", "linkedin.com", "joinhandshake.com", "github.com"
];

/** The registrable domains of the posting's own http(s) URLs (its careers page), skipping application sites and job boards; distinct. */
export function companyMailDomains(urls: ReadonlyArray<string | null | undefined>): string[] {
  const domains = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    const parts = registrableParts(host);
    if (!parts) continue;
    const root = parts.join(".");
    if (NOT_COMPANY_HOSTS.some((site) => within(host, site) || within(root, site))) continue;
    domains.add(root);
  }
  return [...domains];
}

function tenantLabel(host: string): string {
  return host.trim().toLowerCase().split(".")[0] ?? "";
}

/**
 * Not from another site's machinery, and from Oracle's mail, from the
 * company's own domain (companyMailLabels, or within a companyDomains root),
 * naming the company (From or Subject, mentionsCompany), or naming the
 * tenant (the host's first label, at least 4 characters) in From.
 */
export function relevantOracleCodeHeader(target: OracleCodeTarget): (header: { from: string; subject: string }) => boolean {
  const label = tenantLabel(target.host);
  const companyLabels = new Set(companyMailLabels(target.company));
  const companyDomains = target.companyDomains ?? [];
  return (header) => {
    const domains = senderDomains(header.from);
    if (domains.some((domain) => OTHER_SITES.some((root) => within(domain, root)))) return false;
    if (oracleMailSender(header.from)) return true;
    if (domains.some((domain) => {
      const name = registrableParts(domain)?.[0];
      return (name !== undefined && companyLabels.has(name)) || companyDomains.some((root) => within(domain, root));
    })) return true;
    if (target.company.trim() && mentionsCompany(`${header.from} ${header.subject}`, target.company)) return true;
    return label.length >= 4 && header.from.toLowerCase().includes(label);
  };
}

const CODE_AFTER_ANCHOR = /\b(?:code|pin|passcode)\b[^0-9]{0,80}?(?<![0-9])([0-9]{6})(?![0-9])/gi;
const CODE_BEFORE_ANCHOR = /(?<![0-9])([0-9]{6})(?![0-9])[^0-9]{0,40}?\b(?:code|pin|passcode)\b/gi;

function codesInText(text: string): string[] {
  const collapsed = text.replace(/\s+/g, " ");
  return [...collapsed.matchAll(CODE_AFTER_ANCHOR), ...collapsed.matchAll(CODE_BEFORE_ANCHOR)].map((match) => match[1]!);
}

/** Distinct six-digit codes next to a "code", "PIN", or "passcode" anchor, in the plain text and in the HTML read as text. */
export function oracleCodesIn(message: MailMessage): string[] {
  const found = new Set<string>();
  for (const code of codesInText(message.text)) found.add(code);
  if (message.html) for (const code of codesInText(htmlToText(message.html))) found.add(code);
  return [...found];
}

export type OracleCodeResult = { kind: "found"; code: string } | { kind: "none" } | { kind: "ambiguous"; count: number };

/** Messages received from 30 s before `since` on, with a relevant header; exactly one distinct code is found, several are ambiguous. */
export function findOracleVerificationCode(messages: MailMessage[], target: OracleCodeTarget & { since: Date }): OracleCodeResult {
  const relevant = relevantOracleCodeHeader(target);
  const earliest = target.since.getTime() - ORACLE_CODE_CLOCK_SKEW_MS;
  const found = new Set<string>();
  for (const message of messages) {
    if (message.receivedAt.getTime() < earliest) continue;
    if (!relevant({ from: message.from, subject: message.subject })) continue;
    for (const code of oracleCodesIn(message)) found.add(code);
  }
  if (found.size === 0) return { kind: "none" };
  if (found.size > 1) return { kind: "ambiguous", count: found.size };
  return { kind: "found", code: [...found][0]! };
}

/**
 * Polls the mailbox like pollGreenhouseSecurityCode: opens it once, returns
 * at once on a found or ambiguous code, sleeps `pollMs` until `timeoutMs`,
 * and closes the mailbox on every path. Mailbox failures become
 * MailboxUnavailable with fixed phrases, never server text.
 */
export async function pollOracleVerificationCode(
  factory: VerificationMailboxFactory,
  target: OracleCodeTarget & { since: Date },
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<OracleCodeResult> {
  const pollMs = options.pollMs ?? ORACLE_CODE_POLL_MS;
  const timeoutMs = options.timeoutMs ?? ORACLE_CODE_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let mailbox: VerificationMailbox;
  try {
    mailbox = await factory();
  } catch (error) {
    if (error instanceof MailboxUnavailable) throw error;
    throw new MailboxUnavailable("the mailbox could not be opened");
  }
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      let messages: MailMessage[];
      try {
        messages = await mailbox.messagesSince(target.since, relevantOracleCodeHeader(target));
      } catch (error) {
        if (error instanceof MailboxUnavailable) throw error;
        throw new MailboxUnavailable("the mailbox could not be read");
      }
      const result = findOracleVerificationCode(messages, target);
      if (result.kind !== "none") return result;
      if (Date.now() + pollMs > deadline) return { kind: "none" };
      await sleep(pollMs);
    }
  } finally {
    await mailbox.close().catch(() => undefined);
  }
}
