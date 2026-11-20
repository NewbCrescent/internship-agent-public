/**
 * Client-side pacing for the configured model's published limits. Every
 * model call in the process shares one limiter per endpoint and model, so
 * parallel ingestion and drafting stay inside the provider's budget instead
 * of discovering it through 429 responses.
 */
export type RateLimits = { requestsPerMinute: number; tokensPerMinute: number };

/** Run this far below each published limit, leaving room for clock skew and other clients. */
export const RATE_LIMIT_SAFETY = 0.9;
const WINDOW_MS = 60_000;

export function modelRateLimits(env: Record<string, string | undefined> = process.env): RateLimits {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = raw?.trim();
    return value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : fallback;
  };
  // Defaults are the configured contributor model's limits: 100 RPM, 3M TPM.
  return {
    requestsPerMinute: positive(env.MODEL_REQUESTS_PER_MINUTE, 100),
    tokensPerMinute: positive(env.MODEL_TOKENS_PER_MINUTE, 3_000_000)
  };
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };
const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

type Reservation = { at: number; tokens: number };

export class ModelRateLimiter {
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
  private readonly intervalMs: number;
  private readonly events: Reservation[] = [];
  private nextStart = 0;
  private pausedUntil = 0;
  private turn: Promise<void> = Promise.resolve();

  constructor(limits: RateLimits, private readonly clock: Clock = systemClock) {
    this.requestsPerMinute = Math.max(1, Math.floor(limits.requestsPerMinute * RATE_LIMIT_SAFETY));
    this.tokensPerMinute = Math.max(1, Math.floor(limits.tokensPerMinute * RATE_LIMIT_SAFETY));
    // Even spacing: a per-minute limit is often enforced over shorter windows.
    this.intervalMs = WINDOW_MS / this.requestsPerMinute;
  }

  /** Waits (first come, first served) until a request with this token estimate fits both budgets. */
  acquire(estimatedTokens: number): Promise<Reservation> {
    const tokens = Math.min(this.tokensPerMinute, Math.max(1, Math.ceil(estimatedTokens)));
    const granted = this.turn.then(() => this.waitForRoom(tokens));
    this.turn = granted.then(() => undefined, () => undefined);
    return granted;
  }

  /** Replaces a reservation's estimate with the tokens the provider actually counted. */
  settle(reservation: Reservation, actualTokens: number): void {
    if (actualTokens >= 0) reservation.tokens = actualTokens;
  }

  /** After a 429, holds every caller for the provider's requested delay. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }

  private async waitForRoom(tokens: number): Promise<Reservation> {
    for (;;) {
      const now = this.clock.now();
      while (this.events.length && this.events[0]!.at <= now - WINDOW_MS) this.events.shift();
      let waitMs = Math.max(this.nextStart - now, this.pausedUntil - now, 0);
      if (this.events.length >= this.requestsPerMinute) {
        waitMs = Math.max(waitMs, this.events[0]!.at + WINDOW_MS - now);
      }
      let used = this.events.reduce((sum, event) => sum + event.tokens, 0);
      for (const event of this.events) {
        if (used + tokens <= this.tokensPerMinute) break;
        used -= event.tokens;
        waitMs = Math.max(waitMs, event.at + WINDOW_MS - now);
      }
      if (waitMs <= 0) {
        const reservation = { at: now, tokens };
        this.events.push(reservation);
        this.nextStart = now + this.intervalMs;
        return reservation;
      }
      await this.clock.sleep(Math.ceil(waitMs));
    }
  }
}

const shared = new Map<string, ModelRateLimiter>();

/** One limiter per endpoint and model for the whole process. */
export function sharedRateLimiter(key: string, limits: RateLimits = modelRateLimits()): ModelRateLimiter {
  let limiter = shared.get(key);
  if (!limiter) {
    limiter = new ModelRateLimiter(limits);
    shared.set(key, limiter);
  }
  return limiter;
}
