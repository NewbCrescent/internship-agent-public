/**
 * Greenhouse's emailed security code, read from the candidate's mailbox
 * through the read-only `VerificationMailbox` the Workday verification uses.
 * The code lives only in memory: it is typed into the page and never logged,
 * stored, put in an error, event, evidence or notice, or sent to a model.
 * Deterministic, no model.
 *
 * The rules were checked on 2026-11-25 against a real message (read-only,
 * headers and structure only): mail from no-reply@us.greenhouse-mail.io,
 * subject "Security code for your application to <organization>", where
 * <organization> is the Greenhouse organization that hosts the board (on a
 * job-wrapping board the wrapping service, not the posting's company); an
 * HTML-only body (multipart/related: one quoted-printable text/html part and
 * an inline image) reading "Copy and paste this code into the security code
 * field on your application: <CODE>"; an 8-character code (digits only or
 * letters only both occur).
 */
import { mentionsCompany } from "@internship-agent/domain";
import { isGreenhouseBoardUrl, type SecurityCodeLookup, type SecurityCodeLookupResult } from "@internship-agent/browser";

import { htmlToText } from "./mail-outcomes";
import { MailboxUnavailable, type MailMessage, type VerificationMailbox, type VerificationMailboxFactory } from "./workday-verification-mail";

/** Messages received this long before the submit click still count (clock skew). */
export const SECURITY_CODE_CLOCK_SKEW_MS = 30_000;
export const SECURITY_CODE_POLL_MS = 10_000;
export const SECURITY_CODE_TIMEOUT_MS = 180_000;
/** After this long polling with no mail naming the posting's company, Greenhouse security-code mail naming another organization counts too (job-wrapping boards). */
export const SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS = 60_000;

const ADDRESS = /[^\s<>"',;()]+@([a-z0-9.-]+)/gi;

/** From names an address on greenhouse-mail.io or greenhouse.io, dot-bounded (us.greenhouse-mail.io yes; notgreenhouse.io, greenhouse.io.example no). */
export function greenhouseMailSender(from: string): boolean {
  for (const match of from.matchAll(ADDRESS)) {
    const domain = match[1]!.toLowerCase().replace(/\.+$/, "");
    if (domain === "greenhouse-mail.io" || domain.endsWith(".greenhouse-mail.io")) return true;
    if (domain === "greenhouse.io" || domain.endsWith(".greenhouse.io")) return true;
  }
  return false;
}

/** A Greenhouse sender and a subject that says "security code" (any case), whatever organization it names. */
export function greenhouseSecurityCodeHeader(header: { from: string; subject: string }): boolean {
  return greenhouseMailSender(header.from) && /\bsecurity code\b/i.test(header.subject);
}

/** greenhouseSecurityCodeHeader, and a subject that names the company (mentionsCompany). */
export function relevantSecurityCodeHeader(company: string): (header: { from: string; subject: string }) => boolean {
  return (header) => greenhouseSecurityCodeHeader(header) && mentionsCompany(header.subject, company);
}

const CODE_AFTER_ANCHOR = /\bcode\b[^:\n]{0,60}:\s*([A-Za-z0-9]{6,8})(?![A-Za-z0-9])/gi;

function codesInText(text: string): string[] {
  return [...text.matchAll(CODE_AFTER_ANCHOR)].map((match) => match[1]!);
}

/** Distinct tokens after a "code …:" anchor in the plain text and in the HTML read as text (htmlToText). */
export function securityCodesIn(message: MailMessage): string[] {
  const found = new Set<string>();
  for (const code of codesInText(message.text)) found.add(code);
  if (message.html) for (const code of codesInText(htmlToText(message.html))) found.add(code);
  return [...found];
}

export type SecurityCodeMailResult = { kind: "found"; code: string } | { kind: "none" } | { kind: "ambiguous"; count: number };

function distinctCodes(messages: MailMessage[]): Set<string> {
  const found = new Set<string>();
  for (const message of messages) for (const code of securityCodesIn(message)) found.add(code);
  return found;
}

/**
 * Greenhouse security-code mail received from 30 s before `since` on. Mail
 * whose subject names the posting's company decides first: exactly one
 * distinct code is found, several are ambiguous. Without such a code and with
 * `anyOrganization`, the same rule covers every Greenhouse security-code mail
 * in the window: the subject names the board's Greenhouse organization, which
 * on a job-wrapping board is not the posting's company.
 */
export function findGreenhouseSecurityCode(
  messages: MailMessage[],
  target: { company: string; since: Date },
  options: { anyOrganization?: boolean } = {}
): SecurityCodeMailResult {
  const earliest = target.since.getTime() - SECURITY_CODE_CLOCK_SKEW_MS;
  const inWindow = messages.filter((message) => message.receivedAt.getTime() >= earliest && greenhouseSecurityCodeHeader(message));
  const named = relevantSecurityCodeHeader(target.company);
  const namedCodes = distinctCodes(inWindow.filter((message) => named(message)));
  const codes = namedCodes.size > 0 || !options.anyOrganization ? namedCodes : distinctCodes(inWindow);
  if (codes.size === 0) return { kind: "none" };
  if (codes.size > 1) return { kind: "ambiguous", count: codes.size };
  return { kind: "found", code: [...codes][0]! };
}

/**
 * Polls the mailbox like pollVerificationLink (workday-verification-mail.ts):
 * opens it once, reads every Greenhouse security-code mail, returns at once on
 * a found or ambiguous code, sleeps `pollMs` until `timeoutMs`, and closes the
 * mailbox on every path. Mail naming the posting's company counts from the
 * first read; once SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS (60 s) of polling
 * has passed without it, mail naming any Greenhouse organization counts too
 * (findGreenhouseSecurityCode's anyOrganization). Mailbox failures become
 * MailboxUnavailable with fixed phrases, never server text.
 */
export async function pollGreenhouseSecurityCode(
  factory: VerificationMailboxFactory,
  target: { company: string; since: Date },
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<SecurityCodeMailResult> {
  const pollMs = options.pollMs ?? SECURITY_CODE_POLL_MS;
  const timeoutMs = options.timeoutMs ?? SECURITY_CODE_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let mailbox: VerificationMailbox;
  try {
    mailbox = await factory();
  } catch (error) {
    if (error instanceof MailboxUnavailable) throw error;
    throw new MailboxUnavailable("the mailbox could not be opened");
  }
  const started = Date.now();
  const deadline = started + timeoutMs;
  try {
    for (;;) {
      let messages: MailMessage[];
      try {
        messages = await mailbox.messagesSince(target.since, greenhouseSecurityCodeHeader);
      } catch (error) {
        if (error instanceof MailboxUnavailable) throw error;
        throw new MailboxUnavailable("the mailbox could not be read");
      }
      const result = findGreenhouseSecurityCode(messages, target, { anyOrganization: Date.now() - started >= SECURITY_CODE_ANY_ORGANIZATION_AFTER_MS });
      if (result.kind !== "none") return result;
      if (Date.now() + pollMs > deadline) return { kind: "none" };
      await sleep(pollMs);
    }
  } finally {
    await mailbox.close().catch(() => undefined);
  }
}

/**
 * The lookup submitAndConfirm calls after the site's security-code step
 * appears: non-Greenhouse pages are unsupported (no mailbox opened); no
 * mailbox factory is no-mailbox; a blank company is none (no mailbox
 * opened); any thrown error is unavailable; found, none, and ambiguous pass
 * through. Never throws, never logs.
 */
export function greenhouseSecurityCodeLookup(input: {
  mailbox: VerificationMailboxFactory | null;
  company: string;
  wait?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}): SecurityCodeLookup {
  return async ({ url, clickedAt }): Promise<SecurityCodeLookupResult> => {
    if (!isGreenhouseBoardUrl(url)) return { kind: "unsupported" };
    if (!input.mailbox) return { kind: "no-mailbox" };
    const company = input.company.trim();
    if (!company) return { kind: "none" };
    try {
      const result = await pollGreenhouseSecurityCode(input.mailbox, { company, since: clickedAt }, input.wait ?? {});
      return result.kind === "ambiguous" ? { kind: "ambiguous" } : result;
    } catch {
      return { kind: "unavailable" };
    }
  };
}
