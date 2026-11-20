import type { DatabaseSync } from "node:sqlite";
import { semanticFitAssessmentSchema, type SemanticFitAssessment } from "@internship-agent/domain";

export const CURRENT_SEMANTIC_FIT_JOIN = `LEFT JOIN semantic_fit_cache ai ON ai.job_id = j.id
  AND json_extract(ai.assessment_json, '$.version') = 2
  AND ai.context_version = (SELECT version FROM semantic_fit_context WHERE id = 1)
  AND ai.requirement_version = COALESCE((SELECT version FROM semantic_fit_job_inputs WHERE job_id = j.id), 0)
  AND ai.snapshot_id = (SELECT id FROM job_snapshots WHERE job_id = j.id AND superseded_at IS NULL)`;

export function getFitInputVersion(database: DatabaseSync, jobId: string) {
  return database.prepare(`SELECT (SELECT version FROM semantic_fit_context WHERE id = 1) AS context,
    COALESCE((SELECT version FROM semantic_fit_job_inputs WHERE job_id = ?), 0) AS requirements,
    (SELECT id FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL) AS snapshot`).get(jobId, jobId) as
    { context: number; requirements: number; snapshot: string | null };
}
export type FitInputVersion = ReturnType<typeof getFitInputVersion>;
export function saveSemanticFit(database: DatabaseSync, jobId: string, input: FitInputVersion, assessment: SemanticFitAssessment) {
  const current = getFitInputVersion(database, jobId);
  if (JSON.stringify(current) !== JSON.stringify(input) || !input.snapshot) throw new Error("Fit inputs changed during analysis; try again.");
  const parsed = semanticFitAssessmentSchema.parse(assessment);
  database.prepare("DELETE FROM semantic_fit_failures WHERE job_id = ?").run(jobId);
  database.prepare(`INSERT INTO semantic_fit_cache(job_id,snapshot_id,context_version,requirement_version,assessment_json,score)
    VALUES (?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET snapshot_id=excluded.snapshot_id,
    context_version=excluded.context_version,requirement_version=excluded.requirement_version,
    assessment_json=excluded.assessment_json,score=excluded.score`).run(jobId,input.snapshot,input.context,input.requirements,JSON.stringify(parsed),parsed.score);
}
export function getSemanticFit(database: DatabaseSync, jobId: string) {
  const row = database.prepare("SELECT * FROM semantic_fit_cache WHERE job_id = ?").get(jobId) as
    { snapshot_id: string; context_version: number; requirement_version: number; assessment_json: string } | undefined;
  if (!row) return null;
  const current = getFitInputVersion(database, jobId);
  return { assessment: semanticFitAssessmentSchema.parse(JSON.parse(row.assessment_json)),
    stale: JSON.parse(row.assessment_json).version !== 2 || current.context !== row.context_version || current.requirements !== row.requirement_version || current.snapshot !== row.snapshot_id };
}


export function recordSemanticFitFailure(database: DatabaseSync, jobId: string) {
  const input = getFitInputVersion(database, jobId);
  database.prepare(`INSERT INTO semantic_fit_failures(job_id,failed_at,context_version,requirement_version,snapshot_id,assessment_version) VALUES(?,?,?,?,?,2) ON CONFLICT(job_id) DO UPDATE SET
    failed_at=excluded.failed_at,context_version=excluded.context_version,requirement_version=excluded.requirement_version,
    snapshot_id=excluded.snapshot_id,assessment_version=2`).run(jobId,new Date().toISOString(),input.context,input.requirements,input.snapshot);
}
export function getSemanticFitFailure(database: DatabaseSync, jobId: string): string | null {
  const input = getFitInputVersion(database, jobId);
  const row = database.prepare(`SELECT failed_at FROM semantic_fit_failures WHERE job_id = ? AND context_version = ?
    AND requirement_version = ? AND snapshot_id = ? AND assessment_version = 2`).get(jobId,input.context,input.requirements,input.snapshot) as { failed_at: string } | undefined;
  return row?.failed_at ?? null;
}
