import type { DatabaseSync } from "node:sqlite";

import { getDatabase, recordModelInvocation } from "@internship-agent/db";
import {
  RequirementLabelsUnavailableError,
  type ClassificationContext,
  type ClassifiedRequirement,
  type RequirementCandidate,
  type RequirementClassifier
} from "@internship-agent/jobs";
import { z } from "zod";

import { mapWithConcurrency } from "../concurrency";
import {
  ModelInvalidOutputError,
  ModelOutputBudgetError,
  ModelTimeoutError,
  type ModelProvider,
  type StructuredResult
} from "./provider";

// Small batches keep each call inside the model's reasoning budget; a batch
// that overruns it returns no JSON at all rather than a partial answer. Such a
// batch is split in half and retried, and a single bullet that still overruns
// is retried at a doubled budget, so one hard bullet never costs a posting its
// labels.
const BATCH_SIZE = 10;
const BASE_OUTPUT_TOKENS = 2_000;
const OUTPUT_TOKENS_PER_ITEM = 600;
const MAX_OUTPUT_TOKENS = 12_000;
// A reasoning model spends tens of seconds per call, so a posting's batches run
// concurrently. Bounded, because ingestion runs many postings at once and the
// corpus benchmark issues these in a loop.
const BATCH_CONCURRENCY = 2;
// Splitting and budget retries are bounded per posting, so a model that keeps
// failing costs a known number of calls before the posting is held.
const MAX_CALLS_PER_POSTING = 48;
const SINGLE_ITEM_RETRIES = 2;
// Reasoning tokens count against the output budget; the model's default effort
// ("high") is what exhausted it. Labelling a bullet needs little reasoning.
const REASONING_EFFORT = "medium" as const;

type PostingState = { calls: number; failed: boolean };

const decisionSchema = z.object({
  decisions: z.array(z.object({
    index: z.number().int().nonnegative(),
    category: z.enum(["HARD", "PREFERRED"]),
    subject: z.enum([
      "DEGREE", "GRADUATION", "AUTHORIZATION", "LOCATION",
      "AVAILABILITY", "SKILL", "EXPERIENCE", "OTHER"
    ]),
    assertion: z.enum(["STATED", "INFERRED"]),
    confidence: z.number().min(0).max(1)
  }))
});

const INSTRUCTIONS = [
  "You categorize requirement bullets already extracted verbatim from a job posting.",
  "",
  "For each numbered bullet return:",
  "- category: HARD only if the posting states the candidate is ineligible without it. Anything framed as preferred, nice to have, a bonus, or a plus is PREFERRED.",
  "  A bullet that states who the role is for, such as current enrollment in a named degree program or level of study, is HARD unless the posting frames it as preferred.",
  "- subject: the closest of DEGREE, GRADUATION, AUTHORIZATION, LOCATION, AVAILABILITY, SKILL, EXPERIENCE, OTHER.",
  "- assertion: STATED if the bullet itself says it plainly. INFERRED if you are reading between the lines.",
  "- confidence: 0 to 1.",
  "",
  "Never invent a bullet, never change a bullet's wording, and never return an index you were not given.",
  "When unsure between HARD and PREFERRED, choose PREFERRED.",
  "Respond with JSON: {\"decisions\": [{\"index\": 0, \"category\": \"...\", \"subject\": \"...\", \"assertion\": \"...\", \"confidence\": 0.0}]}"
].join("\n");

/**
 * Hard-versus-preferred separation is the judgment the deterministic cue
 * rules handle worst across structurally different postings, so it is the one
 * task worth a model call. The model returns indices and labels only: it never
 * sees or supplies a span, so it cannot ground a requirement in text the
 * posting does not contain.
 *
 * It returns a model decision for every candidate or throws
 * `RequirementLabelsUnavailableError`; it never falls back to rule labels.
 */
export class ModelRequirementClassifier implements RequirementClassifier {
  readonly method = "MODEL" as const;

  constructor(
    private readonly provider: ModelProvider,
    private readonly database: DatabaseSync = getDatabase()
  ) {}

  async classify(
    candidates: RequirementCandidate[],
    context: ClassificationContext
  ): Promise<ClassifiedRequirement[]> {
    if (candidates.length === 0) return [];
    const batches: Array<{ offset: number; items: RequirementCandidate[] }> = [];
    for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
      batches.push({ offset, items: candidates.slice(offset, offset + BATCH_SIZE) });
    }

    const state: PostingState = { calls: 0, failed: false };
    try {
      const settled = await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
        try {
          return await this.labelRange(batch.items, batch.offset, context, state, 0);
        } catch (error) {
          state.failed = true;
          throw error;
        }
      });
      return settled.flat();
    } catch (error) {
      const text = message(error);
      process.stderr.write(`Requirement classification failed; the posting waits for AI labels: ${text}\n`);
      throw error instanceof RequirementLabelsUnavailableError
        ? error
        : new RequirementLabelsUnavailableError(text);
    }
  }

  /**
   * Labels a contiguous slice. On a budget overrun, unusable JSON, or a
   * timeout, a multi-item slice is split in half (each half keeps at least
   * this slice's budget) and a single item is retried at a doubled budget.
   */
  private async labelRange(
    items: RequirementCandidate[],
    offset: number,
    context: ClassificationContext,
    state: PostingState,
    floorTokens: number
  ): Promise<ClassifiedRequirement[]> {
    let budget = Math.min(MAX_OUTPUT_TOKENS, Math.max(floorTokens, BASE_OUTPUT_TOKENS + items.length * OUTPUT_TOKENS_PER_ITEM));
    try {
      return await this.attempt(items, offset, context, state, budget);
    } catch (error) {
      if (!isShrinkable(error)) throw error;
      if (items.length > 1) {
        const middle = Math.ceil(items.length / 2);
        const head = await this.labelRange(items.slice(0, middle), offset, context, state, budget);
        const tail = await this.labelRange(items.slice(middle), offset + middle, context, state, budget);
        return [...head, ...tail];
      }
      let last: unknown = error;
      for (let retry = 0; retry < SINGLE_ITEM_RETRIES && budget < MAX_OUTPUT_TOKENS; retry += 1) {
        budget = Math.min(MAX_OUTPUT_TOKENS, budget * 2);
        try {
          return await this.attempt(items, offset, context, state, budget);
        } catch (retryError) {
          if (!isShrinkable(retryError)) throw retryError;
          last = retryError;
        }
      }
      throw last;
    }
  }

  private async attempt(
    items: RequirementCandidate[],
    offset: number,
    context: ClassificationContext,
    state: PostingState,
    maxOutputTokens: number
  ): Promise<ClassifiedRequirement[]> {
    if (state.failed) throw new Error("Classification stopped after another batch failed.");
    state.calls += 1;
    if (state.calls > MAX_CALLS_PER_POSTING) {
      throw new Error(`Stopped after ${MAX_CALLS_PER_POSTING} model calls for one posting.`);
    }

    const input = [
      `Role: ${context.title} at ${context.companyName}`,
      "",
      ...items.map((candidate, index) => {
        const heading = candidate.heading ? ` (section: ${candidate.heading})` : "";
        return `${index}. ${candidate.text}${heading}`;
      })
    ].join("\n");

    let result: StructuredResult<z.infer<typeof decisionSchema>>;
    try {
      result = await this.provider.complete({
        task: "job.requirement_classification",
        tier: "cheap",
        jobId: context.jobId,
        instructions: INSTRUCTIONS,
        input,
        schema: decisionSchema,
        maxOutputTokens,
        reasoningEffort: REASONING_EFFORT
      });
    } catch (error) {
      const usage = error instanceof ModelOutputBudgetError
        ? { inputTokens: error.inputTokens, outputTokens: error.outputTokens }
        : { inputTokens: 0, outputTokens: 0 };
      this.record(context, { model: "unavailable", ...usage, durationMs: 0, outcome: "failed" });
      throw error;
    }

    const decisions = new Map<number, ClassifiedRequirement>();
    for (const decision of result.value.decisions) {
      if (decision.index < 0 || decision.index >= items.length || decisions.has(decision.index)) continue;
      decisions.set(decision.index, decision);
    }
    if (decisions.size !== items.length) {
      this.record(context, {
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        outcome: "failed"
      });
      throw new ModelInvalidOutputError("The model did not label every requirement in the batch.");
    }

    this.record(context, {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      outcome: "succeeded"
    });
    return [...decisions.values()]
      .sort((left, right) => left.index - right.index)
      .map((decision) => ({ ...decision, index: decision.index + offset }));
  }

  private record(
    context: ClassificationContext,
    call: { model: string; inputTokens: number; outputTokens: number; durationMs: number; outcome: "succeeded" | "failed" }
  ): void {
    recordModelInvocation(this.database, {
      task: "job.requirement_classification",
      tier: "cheap",
      model: call.model,
      jobId: context.jobId,
      sourceUrl: context.sourceUrl ?? null,
      estimatedCostMicrousd: call.model === "unavailable" && call.outputTokens === 0
        ? null
        : estimateCostMicrousd(call.inputTokens, call.outputTokens),
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      durationMs: call.durationMs,
      outcome: call.outcome
    });
  }
}

function isShrinkable(error: unknown): boolean {
  return error instanceof ModelOutputBudgetError
    || error instanceof ModelInvalidOutputError
    || error instanceof ModelTimeoutError;
}

function estimateCostMicrousd(inputTokens: number, outputTokens: number): number | null {
  const inputRate = process.env.MODEL_INPUT_USD_PER_MILLION?.trim();
  const outputRate = process.env.MODEL_OUTPUT_USD_PER_MILLION?.trim();
  if (!inputRate || !outputRate) return null;
  const input = Number(inputRate);
  const output = Number(outputRate);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null;
  // Tokens / 1e6 * USD-per-million * 1e6 micro-USD = tokens * rate.
  return Math.round(inputTokens * input + outputTokens * output);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
