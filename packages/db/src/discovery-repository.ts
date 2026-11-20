import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  discoveryRunSchema,
  discoverySourceSchema,
  discoveryFeedbackSchema,
  type DiscoveryRun,
  type DiscoverySource,
  type DiscoveryFeedback
} from "@internship-agent/domain";

type SourceRow = {
  id: string;
  kind: DiscoverySource["kind"];
  label: string;
  url: string | null;
  rate_limit_per_minute: number;
  enabled: number;
  created_at: string;
  last_fetched_at: string | null;
};

type RunRow = {
  id: string;
  source_id: string | null;
  started_at: string;
  finished_at: string | null;
  fetched: number;
  deduped: number;
  ingested: number;
  analyzed: number;
  promoted: number;
};

function parseSource(row: SourceRow): DiscoverySource {
  return discoverySourceSchema.parse({
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    rateLimitPerMinute: row.rate_limit_per_minute,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    lastFetchedAt: row.last_fetched_at
  });
}

function parseRun(row: RunRow): DiscoveryRun {
  return discoveryRunSchema.parse({
    id: row.id,
    sourceId: row.source_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetched: row.fetched,
    deduped: row.deduped,
    ingested: row.ingested,
    analyzed: row.analyzed,
    promoted: row.promoted
  });
}

export function saveDiscoverySource(
  database: DatabaseSync,
  input: { kind: DiscoverySource["kind"]; label: string; url?: string; rateLimitPerMinute?: number }
): DiscoverySource {
  const source = discoverySourceSchema.parse({
    id: randomUUID(),
    kind: input.kind,
    label: input.label,
    url: input.url ?? null,
    rateLimitPerMinute: input.rateLimitPerMinute ?? 30,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastFetchedAt: null
  });
  database.prepare(`
    INSERT INTO discovery_sources (id, kind, label, url, rate_limit_per_minute, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(source.id, source.kind, source.label, source.url, source.rateLimitPerMinute, source.createdAt);
  return source;
}

export function listDiscoverySources(database: DatabaseSync): DiscoverySource[] {
  const rows = database.prepare("SELECT * FROM discovery_sources ORDER BY created_at").all() as SourceRow[];
  return rows.map(parseSource);
}

/** Reserve a source poll before network I/O, including attempts that fail. */
export function reserveDiscoveryFetch(database: DatabaseSync, sourceId: string, at = new Date()): DiscoverySource {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const row = database.prepare("SELECT * FROM discovery_sources WHERE id = ?").get(sourceId) as SourceRow | undefined;
    if (!row?.url || row.enabled !== 1) throw new Error("The company source is unavailable.");
    if (row.last_fetched_at && at.getTime() - Date.parse(row.last_fetched_at) < 60_000 / row.rate_limit_per_minute) {
      throw new Error("Rate limit reached for this source; try again later.");
    }
    database.prepare("UPDATE discovery_sources SET last_fetched_at = ? WHERE id = ?").run(at.toISOString(), sourceId);
    database.exec("COMMIT;");
    return parseSource({ ...row, last_fetched_at: at.toISOString() });
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function startDiscoveryRun(database: DatabaseSync, sourceId: string | null): DiscoveryRun {
  const run = discoveryRunSchema.parse({
    id: randomUUID(),
    sourceId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    fetched: 0,
    deduped: 0,
    ingested: 0,
    analyzed: 0,
    promoted: 0
  });
  database.prepare(`
    INSERT INTO discovery_runs (id, source_id, started_at, finished_at, fetched, deduped, ingested, analyzed, promoted)
    VALUES (?, ?, ?, NULL, 0, 0, 0, 0, 0)
  `).run(run.id, run.sourceId, run.startedAt);
  return run;
}

export function finishDiscoveryRun(
  database: DatabaseSync,
  runId: string,
  counts: { fetched: number; deduped: number; ingested: number; analyzed: number; promoted: number }
): DiscoveryRun {
  database.prepare(`
    UPDATE discovery_runs
    SET finished_at = ?, fetched = ?, deduped = ?, ingested = ?, analyzed = ?, promoted = ?
    WHERE id = ?
  `).run(new Date().toISOString(), counts.fetched, counts.deduped, counts.ingested, counts.analyzed, counts.promoted, runId);
  const row = database.prepare("SELECT * FROM discovery_runs WHERE id = ?").get(runId) as RunRow;
  return parseRun(row);
}

export function listDiscoveryRuns(database: DatabaseSync, limit = 10): DiscoveryRun[] {
  const rows = database.prepare(`
    SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT ?
  `).all(limit) as RunRow[];
  return rows.map(parseRun);
}

export function saveDiscoverySkip(
  database: DatabaseSync,
  input: { jobId: string; reason: string; preferenceNote: string | null }
): DiscoveryFeedback {
  const feedback = discoveryFeedbackSchema.parse({
    ...input,
    decision: "SKIP",
    createdAt: new Date().toISOString()
  });
  database.prepare(`
    INSERT INTO discovery_feedback (job_id, decision, reason, preference_note, created_at)
    VALUES (?, 'SKIP', ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      reason = excluded.reason,
      preference_note = excluded.preference_note,
      created_at = excluded.created_at
  `).run(feedback.jobId, feedback.reason, feedback.preferenceNote, feedback.createdAt);
  return feedback;
}

export function saveDiscoverySkips(
  database: DatabaseSync,
  input: { jobIds: string[]; reason: string; preferenceNote: string | null }
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const jobId of new Set(input.jobIds)) {
      const row = database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
      if (row?.status !== "READY_FOR_REVIEW" && row?.status !== "NEEDS_INPUT") {
        throw new Error("Only postings in the review queue can be skipped.");
      }
      saveDiscoverySkip(database, { jobId, reason: input.reason, preferenceNote: input.preferenceNote });
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function getDiscoverySkip(database: DatabaseSync, jobId: string): DiscoveryFeedback | null {
  const row = database.prepare("SELECT * FROM discovery_feedback WHERE job_id = ?").get(jobId) as
    { job_id: string; decision: "SKIP"; reason: string; preference_note: string | null; created_at: string } | undefined;
  return row ? discoveryFeedbackSchema.parse({
    jobId: row.job_id,
    decision: row.decision,
    reason: row.reason,
    preferenceNote: row.preference_note,
    createdAt: row.created_at
  }) : null;
}

export function listDiscoverySkips(database: DatabaseSync): DiscoveryFeedback[] {
  const rows = database.prepare("SELECT job_id FROM discovery_feedback ORDER BY created_at DESC").all() as Array<{ job_id: string }>;
  return rows.map((row) => getDiscoverySkip(database, row.job_id)!);
}

/** Lightweight labels for the review page, without hydrating posting snapshots. */
export function listDiscoverySkipsWithTitles(database: DatabaseSync): Array<DiscoveryFeedback & { title: string }> {
  const rows = database.prepare(`SELECT f.*, j.title FROM discovery_feedback f
    JOIN jobs j ON j.id = f.job_id ORDER BY f.created_at DESC, f.job_id DESC`).all() as Array<{
      job_id: string; decision: string; reason: string; preference_note: string | null; created_at: string; title: string;
    }>;
  return rows.map((row) => ({ ...discoveryFeedbackSchema.parse({
    jobId: row.job_id, decision: row.decision, reason: row.reason,
    preferenceNote: row.preference_note, createdAt: row.created_at
  }), title: row.title }));
}

export function removeDiscoverySkip(database: DatabaseSync, jobId: string): void {
  database.prepare("DELETE FROM discovery_feedback WHERE job_id = ?").run(jobId);
}

export type { DiscoveryRun, DiscoverySource };
