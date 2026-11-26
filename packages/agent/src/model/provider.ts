import type { ZodType } from "zod";

/**
 * Task/tier intent rather than model IDs scattered through domain code, per
 * the routing shape in PROJECT_CONTEXT.md. A provider resolves a tier to a
 * concrete model; callers never name one.
 */
export type ModelTier = "cheap" | "standard" | "frontier";

export type ModelTask =
  | "job.semantic_fit"
  | "job.requirement_classification"
  | "job.constraint_reading"
  | "application.answer_draft"
  | "application.voice_revision"
  | "application.pause_review";

export type StructuredRequest<T> = {
  task: ModelTask;
  tier: ModelTier;
  /** Attribution target for the cost ledger; null when no job exists yet. */
  jobId: string | null;
  instructions: string;
  input: string;
  schema: ZodType<T>;
  maxOutputTokens?: number;
  /** How hard a reasoning model thinks; reasoning tokens count against maxOutputTokens. Omitted: the model's default. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
};

export type StructuredResult<T> = {
  value: T;
  model: string;
  inputTokens: number;
  /** Billed output tokens, including any the model spent reasoning. */
  outputTokens: number;
  reasoningTokens: number;
  durationMs: number;
};

/** The model spent its whole output budget (usually on reasoning) before a usable answer. */
export class ModelOutputBudgetError extends Error {
  readonly inputTokens: number;
  readonly outputTokens: number;

  constructor(message: string, usage: { inputTokens: number; outputTokens: number }) {
    super(message);
    this.name = "ModelOutputBudgetError";
    this.inputTokens = usage.inputTokens;
    this.outputTokens = usage.outputTokens;
  }
}

/** The model answered, but not with JSON of the requested shape. */
export class ModelInvalidOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelInvalidOutputError";
  }
}

/** The request or its gateway timed out; a smaller request may succeed. */
export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export interface ModelProvider {
  readonly available: boolean;
  complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/**
 * The default. With no provider configured the system stays fully
 * deterministic rather than degrading silently to a half-configured one.
 */
export class UnavailableModelProvider implements ModelProvider {
  readonly available = false;

  async complete<T>(): Promise<StructuredResult<T>> {
    throw new Error("No model provider is configured. Set MODEL_API_KEY to enable model-backed features.");
  }
}
