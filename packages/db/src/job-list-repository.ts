import { CURRENT_SEMANTIC_FIT_JOIN } from "./semantic-fit-repository";
import type { DatabaseSync } from "node:sqlite";

/**
 * Changes whenever the Jobs list could change: a posting added or revised
 * (jobs.updated_at), or a posting analyzed again (job_matches.evaluated_at).
 */
export function getJobListFingerprint(database: DatabaseSync): string {
  const row = database.prepare(`
    SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT MAX(updated_at) FROM jobs) AS jobs_updated,
      (SELECT COUNT(*) FROM job_matches) AS matches, (SELECT MAX(evaluated_at) FROM job_matches) AS matches_evaluated
  `).get() as { jobs: number; jobs_updated: string | null; matches: number; matches_evaluated: string | null };
  const changes = database.prepare("SELECT total_changes() AS count").get() as { count: number };
  const version = database.prepare("PRAGMA data_version").get() as { data_version: number };
  return [changes.count, version.data_version, row.jobs, row.jobs_updated ?? "", row.matches, row.matches_evaluated ?? ""].join("|");
}

/** Every current AI score, in one query, for sorting without loading reports. Scores never require a deterministic match. */
export function listFitScores(database: DatabaseSync): Map<string, number> {
  const rows = database.prepare(`SELECT j.id AS job_id, ai.score AS fit_score FROM jobs j ${CURRENT_SEMANTIC_FIT_JOIN} WHERE ai.score IS NOT NULL`).all() as Array<{ job_id: string; fit_score: number }>;
  return new Map(rows.map((row) => [row.job_id, row.fit_score]));
}

/** Workspace-wide counts for the Jobs page header, computed in SQL. */
export function getJobListStats(database: DatabaseSync): { hardRequirements: number; constrained: number; qualified: number } {
  const current = "SELECT job_id FROM job_snapshots WHERE superseded_at IS NULL";
  return database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM job_requirements WHERE category = 'HARD' AND job_id IN (${current})) AS hardRequirements,
      (SELECT COUNT(DISTINCT job_id) FROM job_constraints WHERE job_id IN (${current})) AS constrained,
      (SELECT COUNT(*) FROM job_matches WHERE verdict = 'QUALIFIED' AND job_id IN (${current})) AS qualified
  `).get() as { hardRequirements: number; constrained: number; qualified: number };
}
