import { z } from "zod";

import {
  ModelInvalidOutputError,
  ModelOutputBudgetError,
  ModelTimeoutError,
  type ModelProvider,
  type ModelTier,
  type StructuredRequest,
  type StructuredResult
} from "./provider";
import { sharedRateLimiter, type ModelRateLimiter } from "./rate-limiter";

/**
 * The configured model reasons before answering, spending most of its
 * completion budget on tokens that never reach the response. Both the timeout
 * and the output budget are sized for that, not for a plain chat model.
 */
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
/**
 * Attempts per call for transient failures: a network error, 500/502, and
 * 429/503 (the last two also pause the shared limiter). A 504 or this
 * provider's own timeout is not retried here: the same request would likely
 * time out again, so the caller sends less work per request instead.
 */
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;

const chatCompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
    finish_reason: z.string().nullable().optional()
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().nonnegative().optional(),
    completion_tokens: z.number().nonnegative().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().nonnegative().optional()
    }).optional()
  }).optional()
});

export type OpenAiCompatibleOptions = {
  baseUrl?: string | null;
  apiKey?: string | null;
  /** Model per tier. Only `cheap` is configured today. */
  models?: Partial<Record<ModelTier, string>>;
  /** Tests inject these; production shares one limiter per endpoint and model. */
  fetch?: typeof fetch;
  rateLimiter?: ModelRateLimiter;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout; defaults to two minutes. */
  timeoutMs?: number;
};

/**
 * Speaks the OpenAI-compatible chat-completions shape, which is what the
 * configured endpoint exposes. Nothing above this file knows that: callers
 * work through `ModelProvider`, so swapping vendors does not reach domain code.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  private readonly baseUrl: string | null;
  private readonly apiKey: string | null;
  private readonly models: Partial<Record<ModelTier, string>>;
  private readonly fetcher: typeof fetch;
  private readonly limiter: ModelRateLimiter | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.limiter = options.rateLimiter;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = (options.baseUrl ?? process.env.MODEL_API_BASE_URL)?.trim().replace(/\/$/, "") || null;
    this.apiKey = (options.apiKey ?? process.env.MODEL_API_KEY)?.trim() || null;
    const configured = (process.env.MODEL_API_MODEL ?? "").trim();
    this.models = { ...(configured ? { cheap: configured } : {}), ...options.models };
  }

  get available(): boolean {
    return Boolean(this.baseUrl && this.apiKey && this.models.cheap);
  }

  async complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.models[request.tier] ?? this.models.cheap;
    if (!this.baseUrl || !this.apiKey || !model) {
      throw new Error("The model provider is not configured. Set MODEL_API_BASE_URL, MODEL_API_KEY, and MODEL_API_MODEL.");
    }

    const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const limiter = this.limiter ?? sharedRateLimiter(`${this.baseUrl}|${model}`);
    // Reserve the whole output budget: providers count max_tokens when admitting a request.
    const estimate = Math.ceil((request.instructions.length + request.input.length) / 3.5) + maxTokens;
    const body = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.input }
      ]
    });

    for (let attempt = 1; ; attempt += 1) {
      const reservation = await limiter.acquire(estimate);
      // The timeout covers the request itself, never the wait for a rate-limit slot.
      const startedAt = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      try {
        let response: Response;
        try {
          response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body
          });
        } catch (error) {
          limiter.settle(reservation, 0);
          if (timedOut) throw new ModelTimeoutError(`The model request timed out after ${this.timeoutMs} ms.`);
          // A network failure ("fetch failed") is transient: back off and retry.
          if (attempt < MAX_ATTEMPTS) {
            await this.sleep(retryDelayMs(null, attempt));
            continue;
          }
          throw new Error(`Model request failed after ${attempt} attempts: ${errorMessage(error)}`, { cause: error });
        }
        if ((response.status === 429 || response.status === 503) && attempt < MAX_ATTEMPTS) {
          limiter.settle(reservation, 0);
          const delay = retryDelayMs(response.headers.get("retry-after"), attempt);
          limiter.pause(delay);
          await this.sleep(delay);
          continue;
        }
        if ((response.status === 500 || response.status === 502) && attempt < MAX_ATTEMPTS) {
          limiter.settle(reservation, 0);
          await this.sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
          continue;
        }
        if (response.status === 504) {
          limiter.settle(reservation, 0);
          throw new ModelTimeoutError("The model gateway timed out (504).");
        }
        if (!response.ok) {
          throw new Error(`Model request failed with ${response.status} ${response.statusText}.`);
        }
        let raw: unknown;
        try {
          raw = await response.json();
        } catch (error) {
          if (timedOut) throw new ModelTimeoutError(`The model request timed out after ${this.timeoutMs} ms.`);
          throw error;
        }
        const payload = chatCompletionSchema.parse(raw);
        limiter.settle(reservation, (payload.usage?.prompt_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0) || estimate);
        return this.result(request, model, payload, startedAt);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private result<T>(
    request: StructuredRequest<T>,
    model: string,
    payload: z.infer<typeof chatCompletionSchema>,
    startedAt: number
  ): StructuredResult<T> {
    const choice = payload.choices[0];
    const content = choice.message.content;
    // A response cut off at the output budget is a budget problem even when
    // some text arrived: the caller can shrink the request or raise the budget.
    const truncated = choice.finish_reason === "length";
    const usage = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0
    };
    const budgetError = () => new ModelOutputBudgetError(
      "The model exhausted its output budget before returning JSON; lower the batch size or raise maxOutputTokens.",
      usage
    );
    if (!content) {
      throw truncated ? budgetError() : new ModelInvalidOutputError("The model returned an empty response.");
    }

    let json: unknown;
    try {
      json = parseJson(content);
    } catch {
      throw truncated ? budgetError() : new ModelInvalidOutputError("The model did not return parseable JSON.");
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw truncated
        ? budgetError()
        : new ModelInvalidOutputError("The model's JSON did not match the expected shape.", { cause: parsed.error });
    }

    return {
      value: parsed.data,
      model,
      inputTokens: usage.inputTokens,
      // Billed output includes reasoning tokens, which dominate this model.
      outputTokens: usage.outputTokens,
      reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      durationMs: Date.now() - startedAt
    };
  }
}

/** Retry-After (seconds or an HTTP date), else exponential backoff from two seconds. */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_BACKOFF_MS, Math.ceil(seconds * 1000));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(MAX_BACKOFF_MS, Math.max(0, at - Date.now()));
  }
  return Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (attempt - 1));
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // Some models wrap JSON in a fenced block despite json_object mode.
    const fenced = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(content);
    if (!fenced) throw new Error("The model did not return parseable JSON.");
    return JSON.parse(fenced[1]);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
