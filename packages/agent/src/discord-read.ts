import { z } from "zod";

import { DiscordNotifyError, discordFailureStatus, discordRequest, discordSettings, openDiscordDmChannel,
  type DiscordSettings, type DiscordTransport } from "./discord-notify";

/**
 * Read-only access to the bot's DM thread with the candidate: the bot's own
 * notices and the candidate's replies, oldest first. Apart from opening (or
 * getting back) the DM channel, every request is a GET; nothing is sent,
 * edited, reacted to, or deleted. It touches no database, and errors carry
 * only the HTTP status and Discord's numeric code.
 */
export type DiscordDmMessage = { id: string; at: string; from: "bot" | "candidate"; text: string };
export type DiscordReadOptions = { limit?: number; before?: string; after?: string };

export const DISCORD_READ_DEFAULT_LIMIT = 20;
export const DISCORD_READ_MAX_LIMIT = 100;
export const DISCORD_READ_SETUP_MESSAGE =
  "Set INTERNSHIP_AGENT_DISCORD_BOT_TOKEN and INTERNSHIP_AGENT_DISCORD_USER_ID in the root .env first.";
export const DISCORD_READ_USAGE = "Usage: pnpm discord:read [--limit 1-100] [--since <ISO time or 30m/2h/1d>] [--json]";

const SNOWFLAKE = /^\d{1,25}$/;

const messageSchema = z.object({
  id: z.string().regex(SNOWFLAKE),
  timestamp: z.string(),
  content: z.string().catch(""),
  author: z.object({ id: z.string(), bot: z.boolean().optional() }),
  attachments: z.array(z.unknown()).catch([])
});

/** A whole number of messages from 1 to 100; anything unusable becomes 20. */
export function clampDiscordReadLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DISCORD_READ_DEFAULT_LIMIT;
  return Math.min(DISCORD_READ_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** Reads up to `limit` messages of the DM thread (before/after are message ids) and returns them oldest first. */
export async function readDiscordDm(settings: DiscordSettings, options: DiscordReadOptions = {},
  transport: DiscordTransport = {}): Promise<DiscordDmMessage[]> {
  if (!/^\d{5,25}$/.test(settings.userId)) throw new DiscordNotifyError("invalid user id");
  for (const id of [options.before, options.after]) {
    if (id !== undefined && !SNOWFLAKE.test(id)) throw new DiscordNotifyError("invalid message id");
  }
  const channelId = await openDiscordDmChannel(settings, transport);
  const me = await discordRequest(settings, "GET", "/users/@me", undefined, transport);
  const botId = typeof me === "object" && me !== null && "id" in me && typeof me.id === "string" ? me.id : null;
  if (botId === null) throw new DiscordNotifyError("no bot id");

  const query = new URLSearchParams({ limit: String(clampDiscordReadLimit(options.limit)) });
  if (options.before !== undefined) query.set("before", options.before);
  if (options.after !== undefined) query.set("after", options.after);
  const payload = await discordRequest(settings, "GET", `/channels/${channelId}/messages?${query.toString()}`, undefined, transport);
  if (!Array.isArray(payload)) throw new DiscordNotifyError("unexpected response");

  const messages: DiscordDmMessage[] = [];
  for (const entry of payload) {
    const parsed = messageSchema.safeParse(entry);
    if (!parsed.success) continue;
    const time = new Date(parsed.data.timestamp);
    if (Number.isNaN(time.getTime())) continue;
    const attachments = parsed.data.attachments.length;
    const text = [parsed.data.content, attachments > 0 ? `[${attachments} attachment${attachments === 1 ? "" : "s"}]` : ""]
      .filter(Boolean).join("\n");
    messages.push({
      id: parsed.data.id,
      at: time.toISOString().replace(/\.\d{3}Z$/, "Z"),
      from: parsed.data.author.id === botId || parsed.data.author.bot === true ? "bot" : "candidate",
      text: redactDiscordToken(text, settings.token)
    });
  }
  return messages.sort((a, b) => compareSnowflakes(a.id, b.id));
}

/** Replaces every occurrence of the bot token with [redacted]. */
export function redactDiscordToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

/** `--since` as an ISO time or a relative age (30m, 2h, 1d); null when it is neither. */
export function parseDiscordSince(value: string, now: Date = new Date()): Date | null {
  const relative = /^(\d{1,4})([mhd])$/.exec(value.trim());
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const time = new Date(value.trim());
  return Number.isNaN(time.getTime()) ? null : time;
}

/** The messages sent at or after `since`. */
export function discordMessagesSince(messages: DiscordDmMessage[], since: Date): DiscordDmMessage[] {
  return messages.filter((message) => new Date(message.at).getTime() >= Math.floor(since.getTime() / 1000) * 1000);
}

/** Human output: `--- <time> BOT:` or `--- <time> CANDIDATE:` followed by the text. */
export function formatDiscordDm(messages: DiscordDmMessage[]): string {
  if (messages.length === 0) return "No messages.";
  return messages.map((message) => `--- ${message.at} ${message.from === "bot" ? "BOT" : "CANDIDATE"}:\n${message.text}`).join("\n");
}

export type DiscordReadOutput = { log: (line: string) => void; error: (line: string) => void };

/**
 * `pnpm discord:read [--limit 20] [--since <ISO or 2h/1d>] [--json]`: the
 * latest `--limit` messages of the DM thread, oldest first, keeping only those
 * at or after `--since`. Returns the exit code. The token is never printed.
 */
export async function runDiscordRead(args: string[], env: Record<string, string | undefined>, output: DiscordReadOutput,
  transport: DiscordTransport = {}, now: Date = new Date()): Promise<number> {
  let limit = DISCORD_READ_DEFAULT_LIMIT;
  let since: Date | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    const parsedSince = arg === "--since" && value !== undefined ? parseDiscordSince(value, now) : null;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--limit" && value !== undefined && /^\d{1,6}$/.test(value)) {
      limit = clampDiscordReadLimit(Number(value));
      index += 1;
    } else if (parsedSince !== null) {
      since = parsedSince;
      index += 1;
    } else {
      output.error(DISCORD_READ_USAGE);
      return 1;
    }
  }
  const settings = discordSettings(env);
  if (!settings) {
    output.error(DISCORD_READ_SETUP_MESSAGE);
    return 1;
  }
  try {
    const read = await readDiscordDm(settings, { limit }, transport);
    const messages = since ? discordMessagesSince(read, since) : read;
    output.log(redactDiscordToken(json ? JSON.stringify(messages, null, 2) : formatDiscordDm(messages), settings.token));
    return 0;
  } catch (error) {
    output.error(`Discord read failed: ${discordFailureStatus(error)}`);
    return 1;
  }
}

function compareSnowflakes(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
