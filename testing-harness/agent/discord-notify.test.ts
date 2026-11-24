import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordNotifyError, discordFailureStatus, sendDiscordDm, splitDiscordMessage, type DiscordFetch } from "../../packages/agent/src/discord-notify";
import { formatNotice, notifiedStatePath, notifyPass, passFailureItem, passNoticeItems, readNotifiedKeys, type NoticeItem,
  type NoticeLookup, type NoticePause } from "../../packages/agent/src/pass-notice";
import type { PipelineReport } from "../../packages/agent/src/pipeline-orchestrator";

/**
 * Discord DM notices with an injected fetch and temporary data directories;
 * no request leaves the process.
 */
const TOKEN = "tok-SECRET-123";
const USER_ID = "123456789012345678";
const CHANNEL_ID = "987654321";
const settings = { token: TOKEN, userId: USER_ID };

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };

/**
 * A fake fetch that records each call. DM channel requests get the channel;
 * message posts are answered from `answers` in order (the last one repeats).
 */
function fakeFetch(answers: Array<() => Response>) {
  const calls: Call[] = [];
  let posts = 0;
  const fetch: DiscordFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, method: String(init.method), headers, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (url.endsWith("/users/@me/channels")) return json(200, { id: CHANNEL_ID })();
    const answer = answers[Math.min(posts, answers.length - 1)];
    posts += 1;
    if (!answer) throw new Error("no answer queued");
    return answer();
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = json(200, { id: "1" });
/** A fetch that opens the DM channel and accepts every message. */
const okFetch = () => fakeFetch([ok]);
const messages = (calls: Call[]) => calls.filter((call) => call.url.endsWith("/messages")).map((call) => String(call.body.content));

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-discord-"));
  directories.push(directory);
  return directory;
}

const item = (key: string, line: string, section: NoticeItem["section"] = "errors"): NoticeItem => ({ key, section, lines: [`• ${line}`] });

describe("Discord DM transport", () => {
  it("opens the DM channel, then posts the message with the bot header and mentions disabled", async () => {
    const { fetch, calls } = okFetch();
    await expect(sendDiscordDm(settings, "hello", { fetch })).resolves.toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: "https://discord.com/api/v10/users/@me/channels", method: "POST", body: { recipient_id: USER_ID } });
    expect(calls[0]?.headers.authorization).toBe(`Bot ${TOKEN}`);
    expect(calls[0]?.headers["user-agent"]).toMatch(/^DiscordBot \(/);
    expect(calls[1]).toMatchObject({
      url: `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, method: "POST",
      body: { content: "hello", allowed_mentions: { parse: [] } }
    });
    for (const call of calls) expect(call.url).not.toContain(TOKEN);
  });

  it("splits long text into messages of at most 2,000 characters", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => String(index % 10).repeat(99));
    const text = lines.join("\n");
    const chunks = splitDiscordMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join("\n")).toBe(text);

    const long = "x".repeat(4500);
    const pieces = splitDiscordMessage(long);
    expect(pieces).toHaveLength(3);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(2000);
    expect(pieces.join("")).toBe(long);
    expect(splitDiscordMessage("  \n \n\t")).toEqual([]);

    const { fetch, calls } = okFetch();
    await expect(sendDiscordDm(settings, text, { fetch })).resolves.toBe(chunks.length);
    expect(calls.filter((call) => call.url.endsWith("/users/@me/channels"))).toHaveLength(1);
    expect(messages(calls)).toEqual(chunks);
  });

  it("retries once after a 429's retry_after and gives up on a second 429 or a long wait", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const once = fakeFetch([json(429, { retry_after: 0.25, global: false }), ok]);
    await expect(sendDiscordDm(settings, "hello", { fetch: once.fetch, sleep })).resolves.toBe(1);
    expect(waits).toEqual([250]);

    const twice = fakeFetch([json(429, { retry_after: 0.25, global: false })]);
    const error = await sendDiscordDm(settings, "hello", { fetch: twice.fetch, sleep }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordNotifyError);
    expect((error as DiscordNotifyError).status).toBe("429");
    expect(messages(twice.calls)).toHaveLength(2);

    waits.length = 0;
    const slow = fakeFetch([json(429, { retry_after: 120, global: false })]);
    const slowError = await sendDiscordDm(settings, "hello", { fetch: slow.fetch, sleep }).catch((caught: unknown) => caught);
    expect(discordFailureStatus(slowError)).toBe("429");
    expect(waits).toEqual([]);
  });

  it("reports failures by status only: Discord codes, a bad user id, network errors, and timeouts", async () => {
    const forbidden = fakeFetch([json(403, { code: 50007, message: "Cannot send messages to this user" })]);
    const error = await sendDiscordDm(settings, "hello", { fetch: forbidden.fetch }).catch((caught: unknown) => caught);
    expect(discordFailureStatus(error)).toBe("403 (Discord code 50007)");
    expect(String(error)).not.toContain("Cannot send");

    const unused = okFetch();
    const badId = await sendDiscordDm({ token: TOKEN, userId: "abc" }, "hello", { fetch: unused.fetch }).catch((caught: unknown) => caught);
    expect(discordFailureStatus(badId)).toBe("invalid user id");
    expect(unused.calls).toHaveLength(0);

    const network: DiscordFetch = async () => { throw new TypeError(`fetch failed ${TOKEN}`); };
    const networkError = await sendDiscordDm(settings, "hello", { fetch: network }).catch((caught: unknown) => caught);
    expect(discordFailureStatus(networkError)).toBe("network error");

    const hanging: DiscordFetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const timeout = await sendDiscordDm(settings, "hello", { fetch: hanging, timeoutMs: 20 }).catch((caught: unknown) => caught);
    expect(discordFailureStatus(timeout)).toBe("timeout");
    expect(discordFailureStatus(new Error(`boom ${TOKEN}`))).toBe("unexpected error");
  });
});

describe("pass notices", () => {
  it("sends only what is new, records it, and sends nothing when nothing is new", async () => {
    const dataDir = tempDir();
    const { fetch, calls } = okFetch();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const first = [item("error:a", "first error"), item("error:b", "second error")];

    await notifyPass({ dataDir, items: first, settings: null, transport: { fetch }, log });
    await notifyPass({ dataDir, items: [], settings, transport: { fetch }, log });
    expect(calls).toHaveLength(0);
    expect(existsSync(notifiedStatePath(dataDir))).toBe(false);

    await notifyPass({ dataDir, items: first, settings, transport: { fetch }, log });
    expect(calls).toHaveLength(2);
    expect(messages(calls)[0]).toContain("first error");
    expect(messages(calls)[0]).toContain("second error");
    expect(messages(calls)[0]).toMatch(/^Internship agent: 2 new updates/);
    expect(readNotifiedKeys(dataDir)).toEqual(["error:a", "error:b"]);
    if (process.platform !== "win32") expect(statSync(notifiedStatePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(lines).toEqual(["Discord: sent 2 update(s) in 1 message(s)."]);

    await notifyPass({ dataDir, items: first, settings, transport: { fetch }, log });
    expect(calls).toHaveLength(2);

    await notifyPass({ dataDir, items: [...first, item("error:c", "third error")], settings, transport: { fetch }, log });
    expect(calls).toHaveLength(4);
    const latest = messages(calls)[1] ?? "";
    expect(latest).toMatch(/^Internship agent: 1 new update\n/);
    expect(latest).toContain("third error");
    expect(latest).not.toContain("first error");
    expect(JSON.parse(readFileSync(notifiedStatePath(dataDir), "utf8"))).toEqual({ version: 1, keys: ["error:a", "error:b", "error:c"] });
  });

  it("never throws on a failed send, records nothing, and keeps the token out of logs and messages", async () => {
    const dataDir = tempDir();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const items = [item("error:a", "first error")];

    const failing = fakeFetch([json(500, { message: `bad ${TOKEN}` })]);
    await expect(notifyPass({ dataDir, items, settings, transport: { fetch: failing.fetch }, log })).resolves.toBeUndefined();
    expect(lines).toEqual(["Discord notify failed: 500"]);
    expect(readNotifiedKeys(dataDir)).toEqual([]);

    const network: DiscordFetch = async () => { throw new TypeError(`fetch failed ${TOKEN}`); };
    await notifyPass({ dataDir, items, settings, transport: { fetch: network }, log });
    expect(lines[1]).toBe("Discord notify failed: network error");

    const throwingLog = () => { throw new Error("log down"); };
    await expect(notifyPass({ dataDir, items, settings, transport: { fetch: network }, log: throwingLog })).resolves.toBeUndefined();

    const { fetch, calls } = okFetch();
    await notifyPass({ dataDir, items: [...items, passFailureItem(new Error(`token ${TOKEN} leaked`))], settings, transport: { fetch }, log });
    const sent = messages(calls).join("\n");
    expect(sent).toContain("first error");
    expect(sent).toContain("Pass failed: token [redacted] leaked");
    expect(sent).not.toContain(TOKEN);
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });
});

type FakeRun = { id: string; status: string; pauses: NoticePause[] };
const JOB_HELD = "11111111-aaaa-4aaa-8aaa-111111111111";
const JOB_PAUSED = "22222222-bbbb-4bbb-8bbb-222222222222";
const JOB_SENT = "33333333-cccc-4ccc-8ccc-333333333333";
const JOB_STOPPED = "44444444-dddd-4ddd-8ddd-444444444444";
const JOB_FAILED = "55555555-eeee-4eee-8eee-555555555555";
const RUN_HELD = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const RUN_PAUSED = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

const pause = (label: string, status: "open" | "answered", flags: Partial<Pick<NoticePause, "safeguard" | "sensitive" | "upload">> = {}) => {
  // Real pause records also carry the answer and the voice draft; a notice must never render them.
  const record = { label, status, safeguard: false, sensitive: false, upload: false, ...flags,
    answer: "MY-SECRET-ANSWER", draft: { text: "MY-DRAFT-TEXT" }, question: "MY-REWORDED-QUESTION" };
  return record as NoticePause;
};

function emptyReport(): PipelineReport {
  return { analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [], submitted: [], errors: [] };
}

function lookupFor(runs: Record<string, FakeRun>): NoticeLookup {
  return {
    posting: (jobId) => (jobId === JOB_STOPPED ? null : { companyName: `Company ${jobId.slice(0, 4)}`, title: "Software Engineer Intern" }),
    latestRun: (jobId) => runs[jobId] ?? null
  };
}

describe("pass notice items", () => {
  it("lists held runs with numbered open questions and keeps answers, drafts, confirmations, and identifiers out", () => {
    const report = emptyReport();
    report.held = [{ jobId: JOB_HELD, reasons: ["The form asked something the agent could not answer on its own."] }];
    report.started = [
      { jobId: JOB_HELD, runStatus: "awaiting-approval" },
      { jobId: JOB_PAUSED, runStatus: "paused-needs-input" },
      { jobId: JOB_FAILED, runStatus: "awaiting-approval" }
    ];
    report.submitted = [{ jobId: JOB_SENT, confirmation: "Thanks Jane, sent to jane@example.com" }];
    report.stopped = [{ jobId: JOB_STOPPED, reason: "Sign in as jane@example.com at https://x.test/a?token=abc first." }];
    report.errors = ["Preparation failed for job 123456789: boom"];
    const runs: Record<string, FakeRun> = {
      [JOB_HELD]: {
        id: RUN_HELD, status: "awaiting-approval",
        pauses: [
          pause("Are you willing to relocate to Austin?", "open"),
          pause("reCAPTCHA", "open", { safeguard: true }),
          pause("Preferred start date", "answered"),
          pause("Gender", "open", { sensitive: true }),
          pause("Cover letter", "open", { upload: true })
        ]
      },
      [JOB_PAUSED]: { id: RUN_PAUSED, status: "paused-needs-input", pauses: [pause("Earliest start?", "open")] },
      [JOB_FAILED]: { id: "cccccccc-3333-4333-8333-cccccccccccc", status: "failed", pauses: [pause("Never shown", "open")] }
    };
    const items = passNoticeItems(report, lookupFor(runs));
    const text = formatNotice(items);

    expect(items.map((entry) => entry.section)).toEqual(["held", "held", "sent", "stopped", "errors"]);
    expect(text).toContain(`run ${RUN_HELD.slice(0, 8)}`);
    expect(text).toContain(`run ${RUN_PAUSED.slice(0, 8)}`);
    expect(text).toContain('  Q1: "Are you willing to relocate to Austin?"');
    expect(text).toContain('  Q2 CAPTCHA or safeguard, solve it in the browser: "reCAPTCHA"');
    expect(text).not.toContain("Q3");
    expect(text).not.toContain("Preferred start date");
    expect(text).toContain('  Q4 demographic, answered for this application only: "Gender"');
    expect(text).toContain('  Q5 needs a document: "Cover letter"');
    expect(text).toContain("Why: The form asked something the agent could not answer on its own.");
    expect(text).toContain('  Q1: "Earliest start?"');
    expect(text).toContain(`(job ${JOB_SENT.slice(0, 8)})`);
    expect(text).toContain(`Unknown posting (job ${JOB_STOPPED.slice(0, 8)})`);
    expect(text).not.toContain("Never shown");
    for (const secret of ["MY-SECRET-ANSWER", "MY-DRAFT-TEXT", "MY-REWORDED-QUESTION", "Thanks Jane", "jane@example.com", "token=abc", "123456789"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[email]");
    expect(text).toContain("https://x.test/a");
    expect(text).toContain("[number]");
    const order = ["Held for you:", "Sent:", "Stopped:", "Errors:"].map((title) => text.indexOf(title));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.startsWith("Internship agent: 5 new updates\n\nHeld for you:")).toBe(true);
  });

  it("says a sent item's record was saved locally, never its path or file", () => {
    const report = emptyReport();
    report.submitted = [{ jobId: JOB_SENT, confirmation: "Thanks" }, { jobId: JOB_HELD, confirmation: "Thanks" }];
    const items = passNoticeItems(report, { ...lookupFor({}), recordSaved: (jobId) => jobId === JOB_SENT });
    const sent = items.find((entry) => entry.key === `submitted:${JOB_SENT}`);
    const other = items.find((entry) => entry.key === `submitted:${JOB_HELD}`);
    expect(sent?.lines).toContain("  Record saved locally.");
    expect(other?.lines).not.toContain("  Record saved locally.");
    expect(items.map((entry) => entry.key)).toEqual([`submitted:${JOB_SENT}`, `submitted:${JOB_HELD}`]);
    const text = formatNotice(items);
    expect(text).not.toContain(".pdf");
    expect(text).not.toContain("applications/");
  });

  it("lists the unverified requirements of a posting pursued on AI fit, redacted, only on that posting", () => {
    const report = emptyReport();
    report.submitted = [{ jobId: JOB_SENT, confirmation: "Thanks" }];
    report.held = [{ jobId: JOB_HELD, reasons: ["Filled and waiting for your submit approval."] }];
    const unverified = (jobId: string) => jobId === JOB_SENT ? ["Experience with Elixir", "jane@example.com contact"] : [];
    const items = passNoticeItems(report, { ...lookupFor({}), unverified });
    const line = "  Pursued on AI fit despite unverified requirements: Experience with Elixir; [email] contact";
    const sent = items.find((entry) => entry.key === `submitted:${JOB_SENT}`);
    const held = items.find((entry) => entry.section === "held");
    expect(sent?.lines).toContain(line);
    expect(held).toBeDefined();
    expect(held!.lines.some((text) => text.includes("Pursued on AI fit"))).toBe(false);
    expect(formatNotice(items)).not.toContain("jane@example.com");

    const plain = passNoticeItems(report, lookupFor({}));
    expect(plain.flatMap((entry) => entry.lines).some((text) => text.includes("Pursued on AI fit"))).toBe(false);
  });

  it("shows at most eight questions per run", () => {
    const report = emptyReport();
    report.held = [{ jobId: JOB_HELD, reasons: [] }];
    const pauses = Array.from({ length: 10 }, (_, index) => pause(`Question ${index + 1}`, "open"));
    const [held] = passNoticeItems(report, lookupFor({ [JOB_HELD]: { id: RUN_HELD, status: "awaiting-approval", pauses } }));
    expect(held?.lines.filter((line) => /^ {2}Q\d+/.test(line))).toHaveLength(8);
    expect(held?.lines.at(-1)).toBe("  …and 2 more");
    expect(held?.lines.some((line) => line.startsWith("  Why:"))).toBe(false);
  });

  it("notifies a held run again only when its open questions change", async () => {
    const dataDir = tempDir();
    const { fetch, calls } = okFetch();
    const log = () => undefined;
    const report = emptyReport();
    report.held = [{ jobId: JOB_HELD, reasons: ["Held."] }];
    const run: FakeRun = { id: RUN_HELD, status: "awaiting-approval", pauses: [pause("Relocate?", "open"), pause("Start date?", "open")] };

    const first = passNoticeItems(report, lookupFor({ [JOB_HELD]: run }));
    const again = passNoticeItems(report, lookupFor({ [JOB_HELD]: { ...run, pauses: [...run.pauses] } }));
    expect(again[0]?.key).toBe(first[0]?.key);
    await notifyPass({ dataDir, items: first, settings, transport: { fetch }, log });
    await notifyPass({ dataDir, items: again, settings, transport: { fetch }, log });
    expect(messages(calls)).toHaveLength(1);

    const continued = passNoticeItems(report, lookupFor({ [JOB_HELD]: {
      ...run, pauses: [pause("Relocate?", "answered"), pause("Start date?", "open"), pause("Visa sponsorship?", "open")]
    } }));
    expect(continued[0]?.key).not.toBe(first[0]?.key);
    await notifyPass({ dataDir, items: continued, settings, transport: { fetch }, log });
    expect(messages(calls)).toHaveLength(2);
    expect(messages(calls)[1]).toContain('  Q3: "Visa sponsorship?"');
  });

  it("sums up fields without labels and never lists the CAPTCHA token field", () => {
    const report = emptyReport();
    report.held = [{ jobId: JOB_HELD, reasons: ["Held."] }];
    const pauses = [
      pause("Unlabeled input control 5", "open"),
      pause("g-recaptcha-response", "open", { safeguard: true }),
      pause("Cover Letter", "open", { upload: true }),
      pause("Unlabeled input control 9", "open"),
      pause("Start date year", "open")
    ];
    const text = formatNotice(passNoticeItems(report, lookupFor({ [JOB_HELD]: { id: RUN_HELD, status: "paused-needs-input", pauses } })));
    expect(text).toContain('  Q3 needs a document: "Cover Letter"');
    expect(text).toContain('  Q5: "Start date year"');
    expect(text).toContain("  plus 2 fields without labels");
    expect(text).not.toContain("Unlabeled");
    expect(text).not.toContain("g-recaptcha-response");

    const single = formatNotice(passNoticeItems(report, lookupFor({ [JOB_HELD]: {
      id: RUN_HELD, status: "paused-needs-input", pauses: [pause("Unlabeled textarea control 2", "open"), pause("Why us?", "open")]
    } })));
    expect(single).toContain("  plus 1 field without a label");
    expect(single).toContain('  Q2: "Why us?"');
  });
});
