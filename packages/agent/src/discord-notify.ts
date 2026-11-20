/**
 * Discord DM transport for the candidate's notices: opens the DM channel and
 * posts the text through Discord's REST API v10. It touches no database and
 * never puts the token, headers, or Discord's error text into an error.
 */
export type DiscordSettings = { token: string; userId: string };
export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>;
export type DiscordTransport = { fetch?: DiscordFetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number };

export const DISCORD_MESSAGE_LIMIT = 2000;

const DISCORD_API = "https://discord.com/api/v10";
const MAX_RETRY_SECONDS = 30;

export class DiscordNotifyError extends Error {
  readonly status: string;
  constructor(status: string) {
    super(`Discord request failed: ${status}`);
    this.name = "DiscordNotifyError";
    this.status = status;
  }
}

/** The bot token and the candidate's user id, or null (notices off) unless both are set. */
export function discordSettings(env: Record<string, string | undefined> = process.env): DiscordSettings | null {
  const token = env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN?.trim() ?? "";
  const userId = env.INTERNSHIP_AGENT_DISCORD_USER_ID?.trim() ?? "";
  return token && userId ? { token, userId } : null;
}

/** Splits text on line breaks into non-empty messages of at most `limit` characters. */
export function splitDiscordMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let chunk: string | null = null;
  const push = (piece: string) => { if (piece.trimEnd()) chunks.push(piece); };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (chunk !== null) push(chunk);
      chunk = null;
      for (let start = 0; start < line.length; start += limit) push(line.slice(start, start + limit));
      continue;
    }
    if (chunk !== null && chunk.length + 1 + line.length <= limit) {
      chunk = `${chunk}\n${line}`;
    } else {
      if (chunk !== null) push(chunk);
      chunk = line;
    }
  }
  if (chunk !== null) push(chunk);
  return chunks;
}

/** Sends `content` to the candidate as one or more DMs; returns the number of messages posted. */
export async function sendDiscordDm(settings: DiscordSettings, content: string, transport: DiscordTransport = {}): Promise<number> {
  if (!/^\d{5,25}$/.test(settings.userId)) throw new DiscordNotifyError("invalid user id");
  const chunks = splitDiscordMessage(content);
  if (chunks.length === 0) return 0;
  const request = (path: string, body: unknown) => discordRequest(settings, "POST", path, body, transport);
  const channelId = await openDiscordDmChannel(settings, transport);
  let posted = 0;
  for (const chunk of chunks) {
    await request(`/channels/${channelId}/messages`, { content: chunk, allowed_mentions: { parse: [] } });
    posted += 1;
  }
  return posted;
}

/** Opens (or gets back) the bot's DM channel with the candidate and returns its id. */
export async function openDiscordDmChannel(settings: DiscordSettings, transport: DiscordTransport = {}): Promise<string> {
  const channel = await discordRequest(settings, "POST", "/users/@me/channels", { recipient_id: settings.userId }, transport);
  const channelId = isRecord(channel) ? channel.id : null;
  if (typeof channelId !== "string" || !/^\d+$/.test(channelId)) throw new DiscordNotifyError("no DM channel id");
  return channelId;
}

/**
 * One Discord REST v10 request with the bot header and a 10 s timeout (by
 * default), retried once after a 429 that asks to wait at most 30 s. A GET
 * sends no body. Errors carry only the HTTP status and Discord's numeric code.
 */
export async function discordRequest(settings: DiscordSettings, method: "GET" | "POST", path: string, body: unknown,
  transport: DiscordTransport = {}): Promise<unknown> {
  const fetcher: DiscordFetch = transport.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const sleep = transport.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = transport.timeoutMs ?? 10_000;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetcher(`${DISCORD_API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${settings.token}`,
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://localhost, 0.1.0)"
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.ok) return await response.json().catch(() => null) as unknown;
    const payload = await response.json().catch(() => null) as unknown;
    if (response.status === 429 && attempt === 1) {
      const fromBody = isRecord(payload) && typeof payload.retry_after === "number" && Number.isFinite(payload.retry_after)
        ? payload.retry_after : null;
      const header = response.headers.get("retry-after");
      const fromHeader = header !== null && Number.isFinite(Number(header)) ? Number(header) : null;
      const seconds = fromBody ?? fromHeader ?? 1;
      if (seconds < 0 || seconds > MAX_RETRY_SECONDS) throw new DiscordNotifyError("429");
      await sleep(Math.ceil(seconds * 1000));
      continue;
    }
    const code = isRecord(payload) && typeof payload.code === "number" ? payload.code : null;
    throw new DiscordNotifyError(code === null ? `${response.status}` : `${response.status} (Discord code ${code})`);
  }
  throw new DiscordNotifyError("429");
}

/** A short status for a failed send; never the error's message, which may carry request details. */
export function discordFailureStatus(error: unknown): string {
  if (error instanceof DiscordNotifyError) return error.status;
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
  }
  if (error instanceof TypeError) return "network error";
  return "unexpected error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
