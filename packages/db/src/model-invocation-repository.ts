import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ModelTier = "cheap" | "standard" | "frontier";

export type ModelInvocationRecord = {
  task: string;
  tier: ModelTier;
  model: string;
  jobId: string | null;
  sourceUrl?: string | null;
  estimatedCostMicrousd?: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  outcome: "succeeded" | "failed";
};

/**
 * Cost attribution is recorded from the first model call so a later budget
 * surface can total spend per job without a backfill.
 */
export function recordModelInvocation(database: DatabaseSync, record: ModelInvocationRecord): string {
  const id = randomUUID();
  database.prepare(`
    INSERT INTO model_invocations (
      id, task, tier, model, job_id, input_tokens, output_tokens,
      duration_ms, outcome, created_at, source_url, estimated_cost_microusd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, record.task, record.tier, record.model, record.jobId,
    Math.max(0, Math.round(record.inputTokens)),
    Math.max(0, Math.round(record.outputTokens)),
    Math.max(0, Math.round(record.durationMs)),
    record.outcome,
    new Date().toISOString(), record.sourceUrl ?? null, record.estimatedCostMicrousd ?? null
  );
  return id;
}

export function summarizeModelInvocations(database: DatabaseSync, jobId?: string) {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS invocations,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM model_invocations
    WHERE (? IS NULL OR job_id = ?)
  `).get(jobId ?? null, jobId ?? null) as {
    invocations: number;
    input_tokens: number;
    output_tokens: number;
  };
  return {
    invocations: row.invocations,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens
  };
}
