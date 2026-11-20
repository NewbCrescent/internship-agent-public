/**
 * Finds Workday's account-verification link in the candidate's mailbox.
 * Messages are held in memory only; nothing about them is logged, stored, or
 * sent to a model. The mailbox itself sits behind `VerificationMailbox`, so
 * tests never reach a real mail server.
 */
export type MailMessage = { from: string; subject: string; receivedAt: Date; text: string; html: string };

export type VerificationMailbox = {
  /** Messages received since `since` whose From/Subject pass `relevant`; only those bodies are read. */
  messagesSince(since: Date, relevant: (header: { from: string; subject: string }) => boolean): Promise<MailMessage[]>;
  close(): Promise<void>;
};

export type VerificationMailboxFactory = () => Promise<VerificationMailbox>;

/** The mailbox could not be used; messages are fixed phrases, never server text. */
export class MailboxUnavailable extends Error {}

export type VerificationTarget = { host: string; tenant: string; company: string };

/** Messages received this long before the account was created still count (clock skew). */
const SKEW_MS = 120_000;
const VERIFY_PHRASE = /\b(verif\w*|activat\w*|confirm\w*)\b/i;

function mentions(text: string, target: VerificationTarget): boolean {
  const lower = text.toLocaleLowerCase("en-US");
  const company = target.company.trim().toLocaleLowerCase("en-US");
  return lower.includes("workday") || lower.includes(target.tenant.toLocaleLowerCase("en-US")) ||
    (company.length >= 3 && lower.includes(company));
}

/** From/Subject mentions Workday, the tenant, or the company. */
export function relevantWorkdayHeader(target: VerificationTarget): (header: { from: string; subject: string }) => boolean {
  return (header) => mentions(`${header.from} ${header.subject}`, target);
}

function acceptedHost(hostname: string, target: VerificationTarget): boolean {
  const host = hostname.toLocaleLowerCase("en-US");
  if (host === target.host.toLocaleLowerCase("en-US")) return true;
  if (host.endsWith(".myworkdayjobs.com") && host.startsWith(`${target.tenant.toLocaleLowerCase("en-US")}.`)) return true;
  if (host === "myworkday.com" || host.endsWith(".myworkday.com")) return true;
  return host === "workday.com" || host.endsWith(".workday.com");
}

/** An https link on the tenant's Workday host or a Workday domain whose path names an activation step. */
function acceptedLink(raw: string, target: VerificationTarget): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (!acceptedHost(url.hostname, target)) return null;
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

export type VerificationLinkResult = { kind: "found"; link: string } | { kind: "none" } | { kind: "ambiguous"; count: number };

export function findWorkdayVerificationLink(messages: MailMessage[], target: VerificationTarget & { since: Date }): VerificationLinkResult {
  const relevant = relevantWorkdayHeader(target);
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
export async function pollVerificationLink(
  factory: VerificationMailboxFactory,
  target: VerificationTarget & { since: Date },
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<VerificationLinkResult> {
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
        messages = await mailbox.messagesSince(target.since, relevantWorkdayHeader(target));
      } catch (error) {
        if (error instanceof MailboxUnavailable) throw error;
        throw new MailboxUnavailable("the mailbox could not be read");
      }
      const result = findWorkdayVerificationLink(messages, target);
      if (result.kind !== "none") return result;
      if (Date.now() + pollMs > deadline) return { kind: "none" };
      await sleep(pollMs);
    }
  } finally {
    await mailbox.close().catch(() => undefined);
  }
}
