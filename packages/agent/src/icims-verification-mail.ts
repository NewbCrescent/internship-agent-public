import {
  MailboxUnavailable,
  type MailMessage,
  type VerificationMailbox,
  type VerificationMailboxFactory
} from "./workday-verification-mail";

/**
 * Finds iCIMS's account-verification link in the candidate's mailbox, the
 * same way as Workday's (workday-verification-mail.ts): messages are held in
 * memory only, and nothing about them is logged, stored, or sent to a model.
 */
export type IcimsVerificationTarget = { host: string; company: string };

/** Messages received this long before the account was created still count (clock skew). */
const SKEW_MS = 120_000;
const VERIFY_PHRASE = /\b(verif\w*|activat\w*|confirm\w*)\b/i;

function mentions(text: string, target: IcimsVerificationTarget): boolean {
  const lower = text.toLocaleLowerCase("en-US");
  const label = target.host.split(".")[0]?.toLocaleLowerCase("en-US") ?? "";
  const company = target.company.trim().toLocaleLowerCase("en-US");
  return lower.includes("icims") || (label.length > 0 && lower.includes(label)) || (company.length >= 3 && lower.includes(company));
}

/** From/Subject mentions iCIMS, the tenant host's first label, or the company. */
export function relevantIcimsHeader(target: IcimsVerificationTarget): (header: { from: string; subject: string }) => boolean {
  return (header) => mentions(`${header.from} ${header.subject}`, target);
}

/** An https link on the tenant's host or another iCIMS host whose path names an activation step. */
function acceptedLink(raw: string, target: IcimsVerificationTarget): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLocaleLowerCase("en-US");
  if (host !== target.host.toLocaleLowerCase("en-US") && !host.endsWith(".icims.com")) return null;
  const rest = `${url.pathname}${url.search}`;
  if (!/activat|verif|confirm/i.test(rest) || /unsubscribe/i.test(rest)) return null;
  return url.href;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&#61;/g, "=").replace(/&#x3D;/gi, "=");
}

function linksIn(message: MailMessage): string[] {
  const links: string[] = [];
  for (const match of message.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) links.push(decodeEntities(match[1]!.trim()));
  for (const match of message.text.matchAll(/https:\/\/[^\s<>"')\]]+/g)) links.push(match[0].replace(/[.,;:!?]+$/, ""));
  return links;
}

export type IcimsVerificationLinkResult = { kind: "found"; link: string } | { kind: "none" } | { kind: "ambiguous"; count: number };

export function findIcimsVerificationLink(messages: MailMessage[], target: IcimsVerificationTarget & { since: Date }): IcimsVerificationLinkResult {
  const relevant = relevantIcimsHeader(target);
  const earliest = target.since.getTime() - SKEW_MS;
  const found = new Set<string>();
  for (const message of messages) {
    if (message.receivedAt.getTime() < earliest) continue;
    if (!relevant({ from: message.from, subject: message.subject }) && !mentions(`${message.text} ${message.html}`, target)) continue;
    if (!VERIFY_PHRASE.test(`${message.subject} ${message.text} ${message.html}`)) continue;
    for (const link of linksIn(message)) {
      const accepted = acceptedLink(link, target);
      if (accepted) found.add(accepted);
    }
  }
  if (found.size === 0) return { kind: "none" };
  if (found.size > 1) return { kind: "ambiguous", count: found.size };
  return { kind: "found", link: [...found][0]! };
}

/** Polls the mailbox until one verification link arrives, several do, or the time runs out. */
export async function pollIcimsVerificationLink(
  factory: VerificationMailboxFactory,
  target: IcimsVerificationTarget & { since: Date },
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<IcimsVerificationLinkResult> {
  const pollMs = options.pollMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
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
        messages = await mailbox.messagesSince(target.since, relevantIcimsHeader(target));
      } catch (error) {
        if (error instanceof MailboxUnavailable) throw error;
        throw new MailboxUnavailable("the mailbox could not be read");
      }
      const result = findIcimsVerificationLink(messages, target);
      if (result.kind !== "none") return result;
      if (Date.now() + pollMs > deadline) return { kind: "none" };
      await sleep(pollMs);
    }
  } finally {
    await mailbox.close().catch(() => undefined);
  }
}
