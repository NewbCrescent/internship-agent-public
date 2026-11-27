import type { ImapFlow } from "imapflow";
import { z } from "zod";

import { htmlToText, type MailHeader } from "./mail-outcomes";
import { MailAuthFailed, type MailSession, type MailSessionFactory } from "./mail-watch";
import type { MailMessage, VerificationMailbox, VerificationMailboxFactory } from "./workday-verification-mail";
import { MailboxUnavailable } from "./workday-verification-mail";

/**
 * Gmail over IMAP (TLS, port 993) in read-only mode, for Workday's
 * verification emails. The INBOX is opened with EXAMINE: nothing is marked
 * seen, deleted, moved, or sent. The app password and message contents are
 * never logged. imapflow is loaded lazily so its logger never loads with the
 * dashboard. This module is not exported from the package index.
 */
type StructureNode = { part?: string; type: string; disposition?: string; childNodes?: StructureNode[] };

/** Headers read per search (the newest kept), and bodies read of the newest relevant messages. */
const HEADER_LIMIT = 500;
const BODY_LIMIT = 20;

/** The imapflow calls the verification mailbox makes; tests pass a fake. */
export type ImapReader = Pick<ImapFlow, "getMailboxLock" | "search" | "fetch" | "download" | "logout" | "close">;

export function gmailSettings(env: Record<string, string | undefined> = process.env): { address: string; appPassword: string } | null {
  const address = env.INTERNSHIP_AGENT_GMAIL_ADDRESS?.trim() ?? "";
  const appPassword = (env.INTERNSHIP_AGENT_GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, "");
  if (!z.email().safeParse(address).success || !appPassword) return null;
  return { address, appPassword };
}

/** The first inline text/plain and text/html parts of a message's body structure. */
export function textParts(structure: StructureNode): { plain: string | null; html: string | null } {
  const found: { plain: string | null; html: string | null } = { plain: null, html: null };
  if (!structure.childNodes?.length) {
    const type = structure.type.toLocaleLowerCase("en-US");
    if (structure.disposition?.toLocaleLowerCase("en-US") === "attachment") return found;
    if (type === "text/plain") found.plain = structure.part ?? "1";
    if (type === "text/html") found.html = structure.part ?? "1";
    return found;
  }
  const walk = (node: StructureNode) => {
    if (node.childNodes?.length) { for (const child of node.childNodes) walk(child); return; }
    if (node.disposition?.toLocaleLowerCase("en-US") === "attachment" || !node.part) return;
    const type = node.type.toLocaleLowerCase("en-US");
    if (type === "text/plain" && found.plain === null) found.plain = node.part;
    if (type === "text/html" && found.html === null) found.html = node.part;
  };
  walk(structure);
  return found;
}

async function streamText(content: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!content) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The verification mailbox over an IMAP client: INBOX locked read-only
 * (EXAMINE); headers of at most the 500 newest messages since the day before
 * `since`; bodies only of the 20 newest received since `since` (2 minutes of
 * skew) whose From/Subject pass `relevant`; so a verification email is not
 * pushed out by newer unrelated mail.
 */
export function imapVerificationMailbox(client: ImapReader): VerificationMailbox {
  return {
    async messagesSince(since, relevant) {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const found = (await client.search({ since: new Date(since.getTime() - 86_400_000) }, { uid: true })) || [];
        const uids = [...found].sort((a, b) => a - b).slice(-HEADER_LIMIT);
        if (uids.length === 0) return [];
        // Every row is collected before any download: no other command runs inside the fetch.
        const fetched: Array<{ uid: number; internalDate: Date | null; from: string; subject: string; structure: StructureNode | null }> = [];
        for await (const message of client.fetch(uids.join(","), { uid: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })) {
          const from = (message.envelope?.from ?? []).map((entry) => `${entry.name ?? ""} <${entry.address ?? ""}>`).join(", ");
          fetched.push({
            uid: message.uid,
            internalDate: message.internalDate ? new Date(message.internalDate) : null,
            from,
            subject: message.envelope?.subject ?? "",
            structure: (message.bodyStructure as StructureNode | undefined) ?? null
          });
        }
        const selected = fetched
          .filter((entry): entry is typeof entry & { internalDate: Date } => entry.internalDate !== null
            && entry.internalDate.getTime() >= since.getTime() - 120_000
            && relevant({ from: entry.from, subject: entry.subject }))
          .sort((a, b) => a.uid - b.uid)
          .slice(-BODY_LIMIT);
        const messages: MailMessage[] = [];
        for (const entry of selected) {
          const parts = entry.structure ? textParts(entry.structure) : { plain: null, html: null };
          const read = async (part: string | null) => {
            if (!part) return "";
            const download = await client.download(String(entry.uid), part, { uid: true, maxBytes: 300_000 });
            return streamText(download.content);
          };
          messages.push({ from: entry.from, subject: entry.subject, receivedAt: entry.internalDate, text: await read(parts.plain), html: await read(parts.html) });
        }
        return messages;
      } finally {
        lock.release();
      }
    },
    async close() {
      try {
        await client.logout();
      } catch {
        try { client.close(); } catch { /* already closed */ }
      }
    }
  };
}

export function gmailMailboxFactory(env: Record<string, string | undefined> = process.env): VerificationMailboxFactory | null {
  const settings = gmailSettings(env);
  if (!settings) return null;
  return async (): Promise<VerificationMailbox> => {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: "imap.gmail.com", port: 993, secure: true,
      auth: { user: settings.address, pass: settings.appPassword },
      logger: false
    });
    try {
      await client.connect();
    } catch (error) {
      throw new MailboxUnavailable((error as { authenticationFailed?: boolean }).authenticationFailed
        ? "the mailbox refused the sign-in"
        : "the mailbox could not be reached");
    }
    return imapVerificationMailbox(client);
  };
}

/**
 * The Gmail watcher's IDLE session: one connection with INBOX opened
 * read-only (EXAMINE), "exists" pushes as the new-mail callback, and IDLE
 * restarted every 10 minutes (Gmail drops IDLE after about 29). Nothing is
 * ever flagged, moved, deleted, appended, or sent; bodies stay in memory.
 */
export function gmailMailSessionFactory(env: Record<string, string | undefined> = process.env): MailSessionFactory | null {
  const settings = gmailSettings(env);
  if (!settings) return null;
  return async (): Promise<MailSession> => {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: "imap.gmail.com", port: 993, secure: true,
      auth: { user: settings.address, pass: settings.appPassword },
      logger: false,
      maxIdleTime: 600_000,
      connectionTimeout: 30_000
    });
    // An unhandled 'error' would crash the process; 'close' follows it.
    client.on("error", () => undefined);
    const closed = new Promise<void>((resolve) => { client.once("close", () => resolve()); });
    const close = async () => {
      try {
        await client.logout();
      } catch {
        try { client.close(); } catch { /* already closed */ }
      }
    };
    try {
      await client.connect();
    } catch (error) {
      if ((error as { authenticationFailed?: boolean }).authenticationFailed) throw new MailAuthFailed();
      throw new MailboxUnavailable("the mailbox could not be reached");
    }
    let box: { uidValidity: bigint; uidNext: number; readOnly?: boolean | undefined };
    try {
      box = await client.mailboxOpen("INBOX", { readOnly: true });
    } catch {
      await close();
      throw new MailboxUnavailable("the mailbox could not be reached");
    }
    if (box.readOnly !== true) {
      await close();
      throw new MailboxUnavailable("the mailbox did not open read-only");
    }
    let listener: (() => void) | null = null;
    client.on("exists", () => listener?.());
    const structures = new Map<number, StructureNode>();

    async function readBody(uid: number, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
      const structure = structures.get(uid);
      structures.delete(uid);
      if (!structure) return { body: "", truncated: true };
      const parts = textParts(structure);
      const part = parts.plain ?? parts.html;
      if (!part) return { body: "", truncated: true };
      const download = await client.download(String(uid), part, { uid: true, maxBytes });
      const raw = await streamText(download.content);
      const body = parts.plain ? raw : htmlToText(raw);
      return {
        body: body.slice(0, 20_000),
        truncated: !download.content || body.length >= 20_000 || Buffer.byteLength(raw) >= maxBytes
          || (download.meta?.expectedSize ?? maxBytes) >= maxBytes
      };
    }

    return {
      uidValidity: String(box.uidValidity),
      uidNext: box.uidNext,
      async uidsAfter(after, options) {
        const query = { uid: `${after + 1}:*`, ...(options?.since ? { since: new Date(options.since.getTime() - 86_400_000) } : {}) };
        const found = (await client.search(query, { uid: true })) || [];
        return found.filter((uid) => uid > after).sort((a, b) => a - b);
      },
      async headers(uids) {
        if (uids.length === 0) return [];
        // Every row is collected before any download: no other command runs inside the fetch.
        const rows: MailHeader[] = [];
        for await (const message of client.fetch(uids.join(","), {
          uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ["list-unsubscribe", "list-id", "precedence"]
        }, { uid: true })) {
          const from = message.envelope?.from?.[0];
          const raw = message.headers ? message.headers.toString("utf8") : "";
          const received = message.internalDate ?? message.envelope?.date;
          const receivedAt = received ? new Date(received) : new Date();
          if (message.bodyStructure) structures.set(message.uid, message.bodyStructure as StructureNode);
          // Structures of mail whose body is never read: keep only the most recent ones.
          for (const old of structures.keys()) { if (structures.size <= 1_000) break; structures.delete(old); }
          rows.push({
            uid: message.uid,
            messageId: message.envelope?.messageId ?? null,
            fromName: from?.name ?? "",
            fromAddress: from?.address ?? "",
            subject: message.envelope?.subject ?? "",
            receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
            bulk: /^(list-unsubscribe|list-id):/im.test(raw) || /^precedence:\s*(bulk|list|junk)/im.test(raw)
          });
        }
        return rows.sort((a, b) => a.uid - b.uid);
      },
      async bodyText(uid, maxBytes) { return (await readBody(uid, maxBytes)).body; },
      bodyForReceipt: readBody,
      onNewMail(callback) {
        listener = callback;
      },
      closed,
      close
    };
  };
}
