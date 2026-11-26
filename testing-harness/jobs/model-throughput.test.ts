import { describe, expect, it } from "vitest";

import { githubRepositoryRefSchema } from "@internship-agent/domain";

import {
  mapWithConcurrency,
  modelConcurrency,
  modelRateLimits,
  ModelRateLimiter,
  OpenAiCompatibleProvider,
  retryDelayMs,
  type Clock
} from "@internship-agent/agent";

/** Virtual time: sleeping advances the clock instantly. */
function virtualClock(): Clock & { time: () => number } {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; }, time: () => now };
}

describe("model rate limits and parallelism", () => {
  it("defaults to the configured model's published limits and accepts overrides", () => {
    expect(modelRateLimits({})).toEqual({ requestsPerMinute: 100, tokensPerMinute: 3_000_000 });
    expect(modelRateLimits({ MODEL_REQUESTS_PER_MINUTE: "60", MODEL_TOKENS_PER_MINUTE: "500000" }))
      .toEqual({ requestsPerMinute: 60, tokensPerMinute: 500_000 });
    expect(modelRateLimits({ MODEL_REQUESTS_PER_MINUTE: "0", MODEL_TOKENS_PER_MINUTE: "lots" }))
      .toEqual({ requestsPerMinute: 100, tokensPerMinute: 3_000_000 });
    expect(modelConcurrency({})).toBe(32);
    expect(modelConcurrency({ INTERNSHIP_AGENT_MODEL_CONCURRENCY: "500" })).toBe(64);
    expect(modelConcurrency({ INTERNSHIP_AGENT_MODEL_CONCURRENCY: "0" })).toBe(1);
  });

  it("paces requests evenly at 90% of the request limit", async () => {
    const clock = virtualClock();
    const limiter = new ModelRateLimiter({ requestsPerMinute: 100, tokensPerMinute: 3_000_000 }, clock);
    expect(limiter.requestsPerMinute).toBe(90);
    expect(limiter.tokensPerMinute).toBe(2_700_000);
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 181 }, async () => { await limiter.acquire(5_000); starts.push(clock.time()); }));
    starts.sort((a, b) => a - b);
    // Never more than 90 starts in any 60-second window, and never a burst.
    for (let index = 90; index < starts.length; index += 1) expect(starts[index]! - starts[index - 90]!).toBeGreaterThanOrEqual(60_000);
    for (let index = 1; index < starts.length; index += 1) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(666);
    expect(starts[180]).toBeLessThanOrEqual(120_100);
  });

  it("holds requests that would exceed the token budget, and credits actual usage", async () => {
    const clock = virtualClock();
    const limiter = new ModelRateLimiter({ requestsPerMinute: 6_000, tokensPerMinute: 1_000 }, clock);
    const first = await limiter.acquire(600);
    await limiter.acquire(600);
    expect(clock.time()).toBeGreaterThanOrEqual(60_000);

    const settledClock = virtualClock();
    const settled = new ModelRateLimiter({ requestsPerMinute: 6_000, tokensPerMinute: 1_000 }, settledClock);
    const reservation = await settled.acquire(600);
    settled.settle(reservation, 100);
    await settled.acquire(600);
    expect(settledClock.time()).toBeLessThan(1_000);
    expect(first.tokens).toBe(600);
  });

  it("pauses every caller after a rate-limit response", async () => {
    const clock = virtualClock();
    const limiter = new ModelRateLimiter({ requestsPerMinute: 6_000, tokensPerMinute: 3_000_000 }, clock);
    await limiter.acquire(10);
    limiter.pause(5_000);
    await limiter.acquire(10);
    expect(clock.time()).toBeGreaterThanOrEqual(5_000);
  });

  it("keeps input order and never exceeds the in-flight limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 0], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value * 3));
      inFlight -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(3);
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it("computes retry delays from Retry-After or exponential backoff", () => {
    expect(retryDelayMs("3", 1)).toBe(3_000);
    expect(retryDelayMs(null, 1)).toBe(2_000);
    expect(retryDelayMs(null, 3)).toBe(8_000);
    expect(retryDelayMs(null, 10)).toBe(60_000);
    expect(retryDelayMs("600", 1)).toBe(60_000);
  });
});

describe("provider rate-limit handling", () => {
  const schema = githubRepositoryRefSchema;
  const request = { task: "job.requirement_classification" as const, tier: "cheap" as const, jobId: null, instructions: "Return JSON.", input: "x", schema };
  const success = () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ owner: "example", name: "fixture-repo" }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20 }
  }), { status: 200, headers: { "content-type": "application/json" } });
  const limited = () => new Response("slow down", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "3" } });

  it("waits out a 429 and retries through the limiter", async () => {
    const responses = [limited(), limited(), success()];
    const slept: number[] = [];
    const clock = virtualClock();
    const limiter = new ModelRateLimiter({ requestsPerMinute: 100, tokensPerMinute: 3_000_000 }, clock);
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://model.example.test/v1", apiKey: "test-key", models: { cheap: "test-model" },
      fetch: (async () => responses.shift()!) as typeof fetch,
      rateLimiter: limiter,
      sleep: async (ms) => { slept.push(ms); }
    });
    const result = await provider.complete(request);
    expect(result.value).toEqual({ owner: "example", name: "fixture-repo" });
    expect(slept).toEqual([3_000, 3_000]);
    expect(clock.time()).toBeGreaterThanOrEqual(3_000);
  });

  it("gives up after five rate-limited attempts", async () => {
    let calls = 0;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://model.example.test/v1", apiKey: "test-key", models: { cheap: "test-model" },
      fetch: (async () => { calls += 1; return limited(); }) as typeof fetch,
      rateLimiter: new ModelRateLimiter({ requestsPerMinute: 100, tokensPerMinute: 3_000_000 }, virtualClock()),
      sleep: async () => {}
    });
    await expect(provider.complete(request)).rejects.toThrow("429");
    expect(calls).toBe(5);
  });
});
