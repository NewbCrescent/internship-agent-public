import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeProfileDatabase,
  createDatabase,
  getJobStatus,
  listApplicationEvents,
  resolveProfileDatabasePath,
  resolveProfileDataDirectory
} from "@internship-agent/db";

import type { DiscordFetch } from "../../packages/agent/src/discord-notify";
import type { MailHeader } from "../../packages/agent/src/mail-outcomes";
import {
  addNotifiedKeys,
  mailWatchStatePath,
  MailAuthFailed,
  processNewMail,
  readMailWatchState,
  runMailWatch,
  workspaceMailStore,
  writeMailWatchState,
  type MailContext,
  type MailSession
} from "../../packages/agent/src/mail-watch";
import { MailboxUnavailable } from "../../packages/agent/src/workday-verification-mail";

/**
 * The Gmail IDLE watcher against a fake IMAP session (in-memory messages
 * that push "new mail" like IDLE's EXISTS), a disposable workspace, and an
 * injected Discord fetch. Nothing connects to Gmail or Discord.
 */
const TOKEN = "tok-SECRET-123";
const APP_PASSWORD = "app-SECRET-pass";
const USER_ID = "123456789012345678";
const ACME_ID = "a1c3e000-0000-4000-8000-000000000001";
const GLOBEX_ID = "9b0be000-0000-4000-8000-000000000002";
const sentinel = (uid: number) => `BODY-SENTINEL-${uid}-zq`;
const mailEnv = ["INTERNSHIP_AGENT_GMAIL_ADDRESS", "INTERNSHIP_AGENT_GMAIL_APP_PASSWORD", "INTERNSHIP_AGENT_DISCORD_BOT_TOKEN",
  "INTERNSHIP_AGENT_DISCORD_USER_ID"];

type FakeMessage = Omit<MailHeader, "uid"> & { uid: number; body: string };
type Draft = Partial<Omit<FakeMessage, "uid">>;

let directory = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "internship-agent-mail-"));
  saved = Object.fromEntries(["INTERNSHIP_AGENT_DATA_DIR", ...mailEnv].map((name) => [name, process.env[name]]));
  process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
  for (const name of mailEnv) delete process.env[name];
  const seed = createDatabase(resolveProfileDatabasePath("real"));
  const now = new Date().toISOString();
  const insert = seed.prepare(`
    INSERT INTO jobs (id, company_name, title, employment_type, application_type, source_url, external_application_url,
      company_careers_url, status, created_at, updated_at)
    VALUES (?, ?, ?, 'INTERNSHIP', 'EXTERNAL_ATS', ?, ?, NULL, ?, ?, ?)
  `);
  insert.run(ACME_ID, "Acme Robotics", "Software Engineering Intern", "https://boards.greenhouse.io/acmerobotics/jobs/1", null, "SUBMITTED", now, now);
  insert.run(GLOBEX_ID, "Globex", "Data Science Intern", "https://example.test/lists/globex",
    "https://globex.wd5.myworkdayjobs.com/en-US/careers/job/2", "APPLYING", now, now);
  seed.close();
});

afterEach(() => {
  closeProfileDatabase("real");
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

/** An in-memory INBOX shared by the sessions that connect to it. */
class FakeMailbox {
  messages: FakeMessage[] = [];
  nextUid = 1;
  bodyReads = new Map<number, number>();
  constructor(public uidValidity = "1") {}

  add(draft: Draft): FakeMessage {
    const uid = this.nextUid++;
    const message: FakeMessage = {
      uid, messageId: `<m${uid}@example.test>`, fromName: "", fromAddress: "someone@example.test", subject: `Message ${uid}`,
      receivedAt: new Date(), bulk: false, body: `Hello. ${sentinel(uid)}`, ...draft
    };
    this.messages.push(message);
    return message;
  }

  session(): MailSession & { deliver(draft: Draft): FakeMessage; ring(): void; drop(): void } {
    let listener: (() => void) | null = null;
    let live = true;
    let resolveClosed = () => undefined as void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const end = () => { live = false; resolveClosed(); };
    const check = () => { if (!live) throw new Error("connection closed"); };
    return {
      uidValidity: this.uidValidity,
      uidNext: this.nextUid,
      uidsAfter: async (after, options) => {
        check();
        // IMAP SINCE is day-granular: mail up to a day before `since` still comes back.
        const since = options?.since ? options.since.getTime() - 86_400_000 : null;
        const found = this.messages.filter((message) => message.uid > after && (since === null || message.receivedAt.getTime() >= since));
        // `UID n:*` returns the highest message even when n is past it.
        if (found.length === 0 && this.messages.length > 0 && !options?.since) return [this.messages[this.messages.length - 1]!.uid];
        return found.map((message) => message.uid);
      },
      headers: async (uids) => {
        check();
        return this.messages.filter((message) => uids.includes(message.uid)).map(({ body: _body, ...header }) => header);
      },
      bodyText: async (uid) => {
        check();
        this.bodyReads.set(uid, (this.bodyReads.get(uid) ?? 0) + 1);
        return this.messages.find((message) => message.uid === uid)?.body ?? "";
      },
      onNewMail: (callback) => { listener = callback; },
      closed,
      close: async () => end(),
      deliver: (draft) => {
        const message = this.add(draft);
        listener?.();
        return message;
      },
      ring: () => listener?.(),
      drop: end
    };
  }
}

const HACKERRANK: Draft = {
  fromName: "Acme Robotics Hiring Team",
  fromAddress: "no-reply@hackerrankforwork.com",
  subject: "Acme Robotics coding test invitation",
  body: `Please complete the test by Wednesday, November 25, 2026 at 11:59 PM PST. ${sentinel(0)}`
};
const REJECTION: Draft = {
  fromName: "Acme Robotics",
  fromAddress: "no-reply@us.greenhouse-mail.io",
  subject: "Your application to Acme Robotics",
  body: `Unfortunately we will not be moving forward. ${sentinel(0)}`
};
const NEWSLETTER: Draft = {
  fromName: "Career Digest",
  fromAddress: "digest@careers-weekly.example",
  subject: "Five interview tips",
  bulk: true,
  body: `Schedule an interview with confidence. ${sentinel(0)}`
};
const GLOBEX_INTERVIEW: Draft = {
  fromAddress: "globex@myworkday.com",
  subject: "Interview invitation",
  body: `We would like to interview you. ${sentinel(0)}`
};

function harness(options: { failing?: boolean } = {}) {
  const lines: string[] = [];
  const contents: string[] = [];
  const state = { failing: options.failing ?? false };
  const fetch: DiscordFetch = async (url, init) => {
    if (state.failing) return new Response("{}", { status: 500 });
    if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "987654321" }), { status: 200 });
    contents.push(String((JSON.parse(String(init.body)) as { content: unknown }).content));
    return new Response("{}", { status: 200 });
  };
  const ctx: MailContext = {
    dataDir: resolveProfileDataDirectory("real"),
    log: (line) => lines.push(line),
    discord: { token: TOKEN, userId: USER_ID },
    transport: { fetch },
    candidateAddress: "candidate@example.test",
    secrets: [TOKEN, APP_PASSWORD],
    store: workspaceMailStore("real")
  };
  return { ctx, lines, contents, state };
}

/** Waits for runMailWatch rounds through its onRound observer. */
function rounds() {
  const results: Array<{ checked: number; notified: number; retry: boolean }> = [];
  const waiters: Array<() => void> = [];
  return {
    results,
    onRound: (result: { checked: number; notified: number; retry: boolean }) => {
      results.push(result);
      for (const wake of waiters.splice(0)) wake();
    },
    async waitFor(count: number) {
      while (results.length < count) await new Promise<void>((resolve) => { waiters.push(resolve); });
    }
  };
}

function expectPrivate(box: FakeMailbox, lines: string[], contents: string[]) {
  const everything = [...lines, ...contents].join("\n");
  expect(everything).not.toMatch(/BODY-SENTINEL/);
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain(APP_PASSWORD);
  const log = lines.join("\n");
  for (const message of box.messages) expect(log).not.toContain(message.subject);
}

function workspaceEvents(jobId: string) {
  const database = createDatabase(resolveProfileDatabasePath("real"));
  try {
    return { events: listApplicationEvents(database, jobId), status: getJobStatus(database, jobId) };
  } finally {
    database.close();
  }
}

describe("Gmail IDLE watcher", () => {
  it("starts at UIDNEXT, DMs a new assessment from the IDLE push once, and notes it on the job's timeline", async () => {
    const box = new FakeMailbox();
    box.add(REJECTION);
    box.add(NEWSLETTER);
    box.add({ subject: "Lunch?" });
    const session = box.session();
    const { ctx, lines, contents } = harness();
    const controller = new AbortController();
    const watch = rounds();
    const done = runMailWatch({ ...ctx, connect: async () => session, signal: controller.signal, onRound: watch.onRound });

    await watch.waitFor(1);
    expect(contents).toEqual([]);
    expect(readMailWatchState(ctx.dataDir)).toMatchObject({ uidValidity: "1", lastUid: 3 });
    expect(lines).toContain("Gmail: watching new mail from here.");

    const invite = session.deliver(HACKERRANK);
    await watch.waitFor(2);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("URGENT: online assessment");
    expect(contents[0]).toContain("• Deadline: Wednesday, November 25, 2026 at 11:59 PM PST, Acme Robotics — Software Engineering Intern");
    expect(contents[0]).toContain("from hackerrankforwork.com");

    session.ring();
    await watch.waitFor(3);
    expect(contents).toHaveLength(1);
    expect(box.bodyReads.get(invite.uid)).toBe(1);

    controller.abort();
    await done;
    const state = readMailWatchState(ctx.dataDir);
    expect(state.lastUid).toBe(invite.uid);
    expect(state.notified).toHaveLength(1);
    expect(statSync(mailWatchStatePath(ctx.dataDir)).mode & 0o777).toBe(0o600);
    const { events, status } = workspaceEvents(ACME_ID);
    expect(events.map((event) => event.detail)).toContain(
      "Email received: Online assessment (deadline Wednesday, November 25, 2026 at 11:59 PM PST) from hackerrankforwork.com: \"Acme Robotics coding test invitation\""
    );
    expect(status).toBe("SUBMITTED");
    expect(lines).toContain("Gmail: sent 1 update(s) in 1 message(s).");
    expectPrivate(box, lines, contents);
  });

  it("ignores unrelated mail without reading its body, and never DMs one Message-ID twice", async () => {
    const box = new FakeMailbox();
    const session = box.session();
    const { ctx, lines, contents } = harness();
    await processNewMail(session, ctx);

    const newsletter = box.add(NEWSLETTER);
    const chat = box.add({ fromAddress: "friend@example.test", subject: "Weekend plans" });
    await processNewMail(session, ctx);
    expect(contents).toEqual([]);
    expect(box.bodyReads.get(newsletter.uid) ?? 0).toBe(0);
    expect(box.bodyReads.get(chat.uid) ?? 0).toBe(0);
    expect(readMailWatchState(ctx.dataDir).lastUid).toBe(chat.uid);

    const first = box.add({ ...GLOBEX_INTERVIEW, messageId: "<SAME@example.test>" });
    await processNewMail(session, ctx);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain(`Globex — Data Science Intern (job ${GLOBEX_ID.slice(0, 8)}, started)`);
    const again = box.add({ ...GLOBEX_INTERVIEW, messageId: " <same@example.test> " });
    const result = await processNewMail(session, ctx);
    expect(result.notified).toBe(0);
    expect(contents).toHaveLength(1);
    expect(readMailWatchState(ctx.dataDir).lastUid).toBe(again.uid);
    expect(first.uid).toBeLessThan(again.uid);
    expect(workspaceEvents(GLOBEX_ID).status).toBe("APPLYING");
    expectPrivate(box, lines, contents);
  });

  it("notes a security-code email on the timeline without a DM, never keeps the code, and still DMs a real reply beside it", async () => {
    const box = new FakeMailbox();
    const session = box.session();
    const { ctx, lines, contents } = harness();
    await processNewMail(session, ctx);

    const code = box.add({
      fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Globex",
      body: `Copy and paste this code into the security code field on your application: Qz8Lm3Xp ${sentinel(0)}`
    });
    const onlyCode = await processNewMail(session, ctx);
    expect(onlyCode).toMatchObject({ notified: 0, retry: false });
    expect(contents).toEqual([]);
    expect(readMailWatchState(ctx.dataDir)).toMatchObject({ lastUid: code.uid });
    expect(readMailWatchState(ctx.dataDir).notified).toHaveLength(1);
    const detail = "Email received: Verification code from us.greenhouse-mail.io: \"Security code for your application to Globex\"";
    expect(workspaceEvents(GLOBEX_ID).events.map((event) => event.detail)).toEqual([detail]);
    expect(lines).toContain("Gmail: noted 1 verification email(s) on the timeline; not sent.");

    // A second copy of the same message is neither DMed nor noted twice.
    box.add({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Security code for your application to Globex", messageId: code.messageId, body: "Code: Qz8Lm3Xp" });
    box.add(REJECTION);
    const beside = await processNewMail(session, ctx);
    expect(beside.notified).toBe(1);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("Rejection");
    expect(contents[0]).not.toContain("Security code");
    expect(workspaceEvents(GLOBEX_ID).events.map((event) => event.detail)).toEqual([detail]);
    expect([...lines, ...contents, ...workspaceEvents(GLOBEX_ID).events.map((event) => event.detail ?? "")].join("\n")).not.toContain("Qz8Lm3Xp");
    expectPrivate(box, lines, contents);
  });

  it("restarts from new mail when UIDVALIDITY changes, without a flood", async () => {
    const { ctx, lines, contents } = harness();
    writeMailWatchState(ctx.dataDir, { version: 1, uidValidity: "1", lastUid: 50, notified: [], authAlertSent: false });
    const box = new FakeMailbox("2");
    box.add({ subject: "Quarterly team photo" });
    box.add(REJECTION);
    box.add({ subject: "Library book due" });
    box.add({ subject: "Gym schedule" });
    box.add({ subject: "Dinner reservation" });
    const session = box.session();
    expect(session.uidNext).toBe(6);
    await processNewMail(session, ctx);
    expect(contents).toEqual([]);
    expect(readMailWatchState(ctx.dataDir)).toMatchObject({ uidValidity: "2", lastUid: 5 });
    expect(lines).toContain("Gmail: mailbox UIDVALIDITY changed; starting from new mail.");

    box.add(HACKERRANK);
    await processNewMail(session, ctx);
    expect(contents).toHaveLength(1);
    expect(readMailWatchState(ctx.dataDir).lastUid).toBe(6);
    expectPrivate(box, lines, contents);
  });

  it("catches up on mail that arrived while disconnected", async () => {
    const box = new FakeMailbox();
    const { ctx, lines, contents } = harness();
    const controller = new AbortController();
    const watch = rounds();
    const sleeps: number[] = [];
    const sessions: Array<ReturnType<FakeMailbox["session"]>> = [];
    const connect = async () => { const session = box.session(); sessions.push(session); return session; };
    const done = runMailWatch({
      ...ctx, connect, signal: controller.signal, onRound: watch.onRound, now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); }
    });
    await watch.waitFor(1);
    box.add(REJECTION);
    sessions[0]!.drop();
    await watch.waitFor(2);
    expect(sessions).toHaveLength(2);
    expect(sleeps).toEqual([5_000]);
    expect(lines).toContain("Gmail: connection closed; reconnecting in 5 s.");
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("Rejection");
    expect(contents[0]).toContain("\"Your application to Acme Robotics\" from us.greenhouse-mail.io");
    controller.abort();
    await done;
    expect(workspaceEvents(ACME_ID).events.map((event) => event.detail)).toContain(
      "Email received: Rejection from us.greenhouse-mail.io: \"Your application to Acme Robotics\""
    );
    expect(workspaceEvents(ACME_ID).status).toBe("SUBMITTED");
    expectPrivate(box, lines, contents);
  });

  it("DMs once when the sign-in stops working, waits 30 minutes, and resets after a good sign-in", async () => {
    const box = new FakeMailbox();
    const { ctx, lines, contents } = harness();
    const controller = new AbortController();
    const watch = rounds();
    const sleeps: number[] = [];
    let attempts = 0;
    const connect = async () => {
      attempts += 1;
      if (attempts <= 2) throw new MailAuthFailed();
      return box.session();
    };
    const done = runMailWatch({ ...ctx, connect, signal: controller.signal, onRound: watch.onRound, sleep: async (ms) => { sleeps.push(ms); } });
    await watch.waitFor(1);
    expect(sleeps).toEqual([1_800_000, 1_800_000]);
    expect(contents).toEqual(["Internship agent: Gmail access stopped working; check the app password (INTERNSHIP_AGENT_GMAIL_APP_PASSWORD)."]);
    expect(lines.filter((line) => line === "Gmail: auth failed; retrying in 30 min.")).toHaveLength(2);
    expect(readMailWatchState(ctx.dataDir).authAlertSent).toBe(false);
    controller.abort();
    await done;
    expectPrivate(box, lines, contents);
  });

  it("keeps a failed DM for the next round without advancing", async () => {
    const box = new FakeMailbox();
    const session = box.session();
    const { ctx, lines, contents, state } = harness({ failing: true });
    await processNewMail(session, ctx);
    const before = readMailWatchState(ctx.dataDir);
    box.add(GLOBEX_INTERVIEW);
    const failed = await processNewMail(session, ctx);
    expect(failed.retry).toBe(true);
    expect(lines).toContain("Gmail: Discord notify failed: 500");
    expect(readMailWatchState(ctx.dataDir)).toEqual(before);

    state.failing = false;
    const delivered = await processNewMail(session, ctx);
    expect(delivered).toMatchObject({ notified: 1, retry: false });
    expect(contents).toHaveLength(1);
    expect(readMailWatchState(ctx.dataDir).lastUid).toBe(1);
    expectPrivate(box, lines, contents);
  });

  it("with --since on the first run, scans only the window", async () => {
    const box = new FakeMailbox();
    const now = Date.now();
    const since = new Date(now - 3 * 86_400_000);
    box.add({ ...REJECTION, subject: "Old: your application to Acme Robotics", receivedAt: new Date(now - 6 * 86_400_000) });
    box.add({ ...REJECTION, subject: "Slack: your application to Acme Robotics", receivedAt: new Date(since.getTime() - 2 * 3_600_000) });
    box.add({ ...REJECTION, subject: "New: your application to Acme Robotics", receivedAt: new Date(now - 86_400_000) });
    const session = box.session();
    const { ctx, lines, contents } = harness();
    await processNewMail(session, ctx, { since });
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("New: your application to Acme Robotics");
    expect(contents[0]).not.toContain("Slack:");
    expect(contents[0]).not.toContain("Old:");
    expect(box.bodyReads.get(1) ?? 0).toBe(0);
    expect(box.bodyReads.get(2) ?? 0).toBe(0);
    expect(readMailWatchState(ctx.dataDir)).toMatchObject({ uidValidity: "1", lastUid: 3 });
    expectPrivate(box, lines, contents);
  });

  it("strips the token and app password from DMs", async () => {
    const box = new FakeMailbox();
    const session = box.session();
    const { ctx, lines, contents } = harness();
    await processNewMail(session, ctx);
    box.add({ ...GLOBEX_INTERVIEW, subject: `Interview invitation ${APP_PASSWORD} ${TOKEN}` });
    await processNewMail(session, ctx);
    expect(contents).toHaveLength(1);
    expect(contents[0]).toContain("Interview invitation [redacted] [redacted]");
    expect(contents.join("\n")).not.toContain(APP_PASSWORD);
    expect(contents.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("Interview invitation");
  });

  it("backs off on connection errors: 5 s, then 10 s", async () => {
    const { ctx, lines, contents } = harness();
    const controller = new AbortController();
    const sleeps: number[] = [];
    const connect = async (): Promise<MailSession> => { throw new MailboxUnavailable("the mailbox could not be reached"); };
    await runMailWatch({
      ...ctx, connect, signal: controller.signal,
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) controller.abort(); }
    });
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(lines).toContain("Gmail: could not connect (the mailbox could not be reached); reconnecting in 5 s.");
    expect(lines).toContain("Gmail: could not connect (the mailbox could not be reached); reconnecting in 10 s.");
    expect(contents).toEqual([]);
  });

  it("adds a scan's notified keys without touching the watcher's position", () => {
    const { ctx } = harness();
    writeMailWatchState(ctx.dataDir, { version: 1, uidValidity: "42", lastUid: 17, notified: ["k1"], authAlertSent: true });
    addNotifiedKeys(ctx.dataDir, ["k2", "k1"]);
    expect(readMailWatchState(ctx.dataDir)).toEqual({ version: 1, uidValidity: "42", lastUid: 17, notified: ["k2", "k1"], authAlertSent: true });
    writeFileSync(mailWatchStatePath(ctx.dataDir), "not json");
    expect(readMailWatchState(ctx.dataDir)).toEqual({ version: 1, uidValidity: null, lastUid: 0, notified: [], authAlertSent: false });
  });
});
