import { describe, expect, it } from "vitest";

import { DiscordNotifyError, type DiscordFetch } from "../../packages/agent/src/discord-notify";
import { DISCORD_READ_SETUP_MESSAGE, DISCORD_READ_USAGE, clampDiscordReadLimit, discordMessagesSince, formatDiscordDm,
  parseDiscordSince, readDiscordDm, runDiscordRead } from "../../packages/agent/src/discord-read";

/**
 * The read-only Discord DM reader with an injected fetch; no request leaves
 * the process.
 */
const TOKEN = "tok-SECRET-123";
const USER_ID = "123456789012345678";
const BOT_ID = "555555555555555555";
const CHANNEL_ID = "987654321";
const settings = { token: TOKEN, userId: USER_ID };
const env = { INTERNSHIP_AGENT_DISCORD_BOT_TOKEN: TOKEN, INTERNSHIP_AGENT_DISCORD_USER_ID: USER_ID };
const NOW = new Date("2026-11-20T04:00:00Z");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type DiscordMessage = { id: string; timestamp: string; content: string; author: { id: string; bot?: boolean }; attachments?: unknown[] };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Discord's newest-first page: the candidate's reply, then the bot's notice. */
const THREAD: DiscordMessage[] = [
  { id: "1300000000000000300", timestamp: "2026-11-20T03:30:00.250000+00:00", content: "yes, apply", author: { id: USER_ID } },
  { id: "1300000000000000200", timestamp: "2026-11-20T02:03:03.000000+00:00", content: "Held: Acme\nQ1 Start date?",
    author: { id: BOT_ID, bot: true } },
  { id: "1300000000000000100", timestamp: "2026-11-19T01:00:00+00:00", content: "Internship agent connected.",
    author: { id: BOT_ID } }
];

/**
 * A fake Discord: the DM channel, the bot's own user, and the message page.
 * `messages` answers each GET of the page in order (the last one repeats).
 */
function fakeDiscord(messages: Array<() => Response> = [() => json(200, THREAD)]) {
  const calls: Call[] = [];
  let pages = 0;
  const fetch: DiscordFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url, method: String(init.method), headers, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url.endsWith("/users/@me/channels")) return json(200, { id: CHANNEL_ID });
    if (url.endsWith("/users/@me")) return json(200, { id: BOT_ID, username: "agent" });
    if (url.includes(`/channels/${CHANNEL_ID}/messages`)) {
      const answer = messages[Math.min(pages, messages.length - 1)];
      pages += 1;
      if (!answer) throw new Error("no answer queued");
      return answer();
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { fetch, calls };
}

const noSleep = { sleep: async () => {} };

function captured() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, output: { log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
}

describe("readDiscordDm", () => {
  it("opens the DM channel, looks up the bot once, then reads the page with GETs only", async () => {
    const { fetch, calls } = fakeDiscord();
    await readDiscordDm(settings, {}, { fetch, ...noSleep });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://discord.com/api/v10/users/@me/channels",
      "GET https://discord.com/api/v10/users/@me",
      `GET https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=20`
    ]);
    expect(calls[0]?.body).toEqual({ recipient_id: USER_ID });
    for (const call of calls) {
      expect(call.headers.authorization).toBe(`Bot ${TOKEN}`);
      expect(call.headers["user-agent"]).toMatch(/^DiscordBot /);
    }
    for (const call of calls.slice(1)) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
    }
  });

  it("returns messages oldest first, classified by the bot's own id or the bot flag", async () => {
    const shuffled = [THREAD[1], THREAD[0], THREAD[2],
      { id: "1300000000000000250", timestamp: "2026-11-20T03:00:00Z", content: "other bot", author: { id: "42", bot: true } }];
    const { fetch } = fakeDiscord([() => json(200, shuffled)]);
    const messages = await readDiscordDm(settings, {}, { fetch, ...noSleep });
    expect(messages).toEqual([
      { id: "1300000000000000100", at: "2026-11-19T01:00:00Z", from: "bot", text: "Internship agent connected." },
      { id: "1300000000000000200", at: "2026-11-20T02:03:03Z", from: "bot", text: "Held: Acme\nQ1 Start date?" },
      { id: "1300000000000000250", at: "2026-11-20T03:00:00Z", from: "bot", text: "other bot" },
      { id: "1300000000000000300", at: "2026-11-20T03:30:00Z", from: "candidate", text: "yes, apply" }
    ]);
  });

  it("orders ids numerically, not as strings, and notes attachments", async () => {
    const { fetch } = fakeDiscord([() => json(200, [
      { id: "10000000000000000000", timestamp: "2026-11-20T03:00:00Z", content: "", author: { id: USER_ID }, attachments: [{}, {}] },
      { id: "9000000000000000000", timestamp: "2026-11-20T02:00:00Z", content: "see file", author: { id: USER_ID }, attachments: [{}] },
      { id: "not-a-snowflake", timestamp: "2026-11-20T01:00:00Z", content: "skipped", author: { id: USER_ID } }
    ])]);
    const messages = await readDiscordDm(settings, {}, { fetch, ...noSleep });
    expect(messages.map((message) => [message.id, message.text])).toEqual([
      ["9000000000000000000", "see file\n[1 attachment]"],
      ["10000000000000000000", "[2 attachments]"]
    ]);
  });

  it("clamps the limit to 1-100 and passes before/after message ids", async () => {
    expect([clampDiscordReadLimit(undefined), clampDiscordReadLimit(0), clampDiscordReadLimit(-5), clampDiscordReadLimit(2.7),
      clampDiscordReadLimit(500), clampDiscordReadLimit(Number.NaN)]).toEqual([20, 1, 1, 2, 100, 20]);
    const { fetch, calls } = fakeDiscord();
    await readDiscordDm(settings, { limit: 500, before: "1300000000000000300", after: "1300000000000000100" }, { fetch, ...noSleep });
    const url = new URL(calls[2]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "100", before: "1300000000000000300", after: "1300000000000000100" });
  });

  it("refuses a bad message id or user id before any request", async () => {
    const { fetch, calls } = fakeDiscord();
    await expect(readDiscordDm(settings, { before: "1; DROP" }, { fetch })).rejects.toThrow(DiscordNotifyError);
    await expect(readDiscordDm({ token: TOKEN, userId: "me" }, {}, { fetch })).rejects.toThrow("invalid user id");
    expect(calls).toEqual([]);
  });

  it("retries the page once after a 429's retry_after", async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeDiscord([() => json(429, { retry_after: 1.5, message: "slow down" }), () => json(200, THREAD)]);
    const messages = await readDiscordDm(settings, {}, { fetch, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([1500]);
    expect(messages).toHaveLength(3);
    expect(calls.filter((call) => call.url.includes("/messages"))).toHaveLength(2);
  });

  it("fails a 403 with only the status and Discord's code, never the token or Discord's text", async () => {
    const { fetch } = fakeDiscord([() => json(403, { code: 50001, message: `Missing Access ${TOKEN}` })]);
    const error = await readDiscordDm(settings, {}, { fetch, ...noSleep }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DiscordNotifyError);
    expect((error as DiscordNotifyError).status).toBe("403 (Discord code 50001)");
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain("Missing Access");
  });

  it("redacts the token inside message text", async () => {
    const { fetch } = fakeDiscord([() => json(200, [
      { id: "1300000000000000400", timestamp: "2026-11-20T03:40:00Z", content: `token is ${TOKEN} ok ${TOKEN}`, author: { id: USER_ID } }
    ])]);
    const [message] = await readDiscordDm(settings, {}, { fetch, ...noSleep });
    expect(message?.text).toBe("token is [redacted] ok [redacted]");
  });
});

describe("since filtering", () => {
  it("parses relative ages and ISO times, and rejects anything else", () => {
    expect(parseDiscordSince("2h", NOW)?.toISOString()).toBe("2026-11-20T02:00:00.000Z");
    expect(parseDiscordSince("1d", NOW)?.toISOString()).toBe("2026-11-19T04:00:00.000Z");
    expect(parseDiscordSince("30m", NOW)?.toISOString()).toBe("2026-11-20T03:30:00.000Z");
    expect(parseDiscordSince("2026-11-20T02:03:03Z", NOW)?.toISOString()).toBe("2026-11-20T02:03:03.000Z");
    expect(parseDiscordSince("yesterday", NOW)).toBeNull();
    expect(parseDiscordSince("2w", NOW)).toBeNull();
    expect(parseDiscordSince("2026-13-45T99:00:00Z", NOW)).toBeNull();
  });

  it("keeps messages at or after the time", () => {
    const messages = [
      { id: "1", at: "2026-11-20T02:03:02Z", from: "bot" as const, text: "a" },
      { id: "2", at: "2026-11-20T02:03:03Z", from: "bot" as const, text: "b" },
      { id: "3", at: "2026-11-20T03:30:00Z", from: "candidate" as const, text: "c" }
    ];
    expect(discordMessagesSince(messages, new Date("2026-11-20T02:03:03Z")).map((message) => message.id)).toEqual(["2", "3"]);
  });
});

describe("pnpm discord:read", () => {
  it("prints the thread oldest first as BOT and CANDIDATE blocks", async () => {
    const { fetch } = fakeDiscord();
    const { out, err, output } = captured();
    expect(await runDiscordRead([], env, output, { fetch, ...noSleep }, NOW)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join("\n")).toBe([
      "--- 2026-11-19T01:00:00Z BOT:", "Internship agent connected.",
      "--- 2026-11-20T02:03:03Z BOT:", "Held: Acme", "Q1 Start date?",
      "--- 2026-11-20T03:30:00Z CANDIDATE:", "yes, apply"
    ].join("\n"));
    expect(formatDiscordDm([])).toBe("No messages.");
  });

  it("--since 2h keeps the last two hours; --json prints one array; --limit is clamped", async () => {
    const { fetch, calls } = fakeDiscord();
    const { out, output } = captured();
    expect(await runDiscordRead(["--limit", "500", "--since", "2h", "--json"], env, output, { fetch, ...noSleep }, NOW)).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual([
      { id: "1300000000000000200", at: "2026-11-20T02:03:03Z", from: "bot", text: "Held: Acme\nQ1 Start date?" },
      { id: "1300000000000000300", at: "2026-11-20T03:30:00Z", from: "candidate", text: "yes, apply" }
    ]);
    expect(new URL(calls[2]!.url).searchParams.get("limit")).toBe("100");
  });

  it("exits 1 with the fixed setup message, and no request, when the settings are missing", async () => {
    const { fetch, calls } = fakeDiscord();
    const { out, err, output } = captured();
    expect(await runDiscordRead([], { INTERNSHIP_AGENT_DISCORD_BOT_TOKEN: TOKEN }, output, { fetch }, NOW)).toBe(1);
    expect(err).toEqual([DISCORD_READ_SETUP_MESSAGE]);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("exits 1 with the usage line for unknown or malformed flags", async () => {
    for (const args of [["--since", "yesterday"], ["--limit", "ten"], ["--limit"], ["--send", "hi"]]) {
      const { fetch, calls } = fakeDiscord();
      const { err, output } = captured();
      expect(await runDiscordRead(args, env, output, { fetch }, NOW)).toBe(1);
      expect(err).toEqual([DISCORD_READ_USAGE]);
      expect(calls).toEqual([]);
    }
  });

  it("never prints the token, in human output, JSON, or a failure", async () => {
    const leaky = [{ id: "1300000000000000400", timestamp: "2026-11-20T03:40:00Z", content: `oops ${TOKEN}`, author: { id: USER_ID } }];
    const printed: string[] = [];
    for (const args of [[], ["--json"]]) {
      const { fetch } = fakeDiscord([() => json(200, leaky)]);
      const { out, err, output } = captured();
      expect(await runDiscordRead(args, env, output, { fetch, ...noSleep }, NOW)).toBe(0);
      printed.push(...out, ...err);
    }
    const { fetch } = fakeDiscord([() => json(403, { code: 50001, message: `Missing Access ${TOKEN}` })]);
    const { out, err, output } = captured();
    expect(await runDiscordRead([], env, output, { fetch, ...noSleep }, NOW)).toBe(1);
    expect(err).toEqual(["Discord read failed: 403 (Discord code 50001)"]);
    printed.push(...out, ...err);
    expect(printed.join("\n")).not.toContain(TOKEN);
    expect(printed.join("\n")).toContain("[redacted]");
  });
});
