import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { outcomeEventSchema, roleTypeForTitle, type OutcomeEvent, type OutcomeStage } from "@internship-agent/domain";
import { setJobStatus } from "./application-repository";

export type FunnelStage = "submitted" | "interview" | "offer" | "rejected" | "withdrawn";

export type SourceFunnel = {
  applicationType: string;
  submitted: number;
  interviews: number;
  offers: number;
  rejections: number;
};

export type FunnelStats = {
  generatedAt: string;
  /** Current snapshot: postings per status. */
  snapshot: Record<string, number>;
  /** Event-based funnel: distinct postings that ever entered each stage. */
  funnel: Record<FunnelStage, number>;
  /** Share of submitted postings that drew any response (interview, offer, or rejection). */
  responseRate: number | null;
  /** Share of submitted postings that reached an interview or better. */
  interviewRate: number | null;
  /** Share of submitted postings that reached an offer. */
  offerRate: number | null;
  /** Mean days from first SUBMITTED to first response; null when nothing responded yet. */
  avgDaysToResponse: number | null;
  /** Funnel per application channel, using the posting's current channel. */
  bySource: SourceFunnel[];
  detailedStages: Record<OutcomeStage, number>;
  byRole: Array<{ roleType: string; submitted: number; responses: number; interviews: number; offers: number }>;
  byVariant: Array<{ variantId: string | null; variant: string; submitted: number; interviews: number; offers: number }>;
  cost: { knownUsd: number; unknownCalls: number; perApplicationUsd: number | null; perInterviewUsd: number | null; perOfferUsd: number | null };
};

export function saveOutcomeEvent(database: DatabaseSync, jobId: string, stage: OutcomeStage, note: string | null): OutcomeEvent {
  const event = outcomeEventSchema.parse({ id: randomUUID(), jobId, stage, note, recordedAt: new Date().toISOString() });
  database.prepare("INSERT INTO outcome_events (id, job_id, stage, note, recorded_at) VALUES (?, ?, ?, ?, ?)")
    .run(event.id, event.jobId, event.stage, event.note, event.recordedAt);
  return event;
}

export function persistOutcomeUpdate(
  database: DatabaseSync,
  jobId: string,
  stage: OutcomeStage | "WITHDRAWN",
  note: string | null
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    if (stage === "INTERVIEW" || stage === "REJECTED" || stage === "OFFER" || stage === "WITHDRAWN") {
      setJobStatus(database, jobId, null, stage, note ? `Candidate recorded ${stage.toLocaleLowerCase("en-US")}: ${note}` : `Candidate recorded ${stage.toLocaleLowerCase("en-US")}.`);
    }
    if (stage !== "WITHDRAWN") saveOutcomeEvent(database, jobId, stage, note);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function listOutcomeEvents(database: DatabaseSync, jobId: string): OutcomeEvent[] {
  const rows = database.prepare("SELECT * FROM outcome_events WHERE job_id = ? ORDER BY recorded_at, rowid").all(jobId) as
    Array<{ id: string; job_id: string; stage: OutcomeStage; note: string | null; recorded_at: string }>;
  return rows.map((row) => outcomeEventSchema.parse({
    id: row.id, jobId: row.job_id, stage: row.stage, note: row.note, recordedAt: row.recorded_at
  }));
}

function entered(database: DatabaseSync, status: string): number {
  const row = database.prepare(
    "SELECT COUNT(DISTINCT job_id) AS count FROM application_events WHERE to_status = ?"
  ).get(status) as { count: number };
  return row.count;
}

/**
 * Milestone 10 analytics. The funnel reads the event timeline, not current
 * statuses, so a posting that moved SUBMITTED -> INTERVIEW -> OFFER counts
 * in all three stages instead of only its terminal state. Rates are null —
 * never 0/0 — when there is nothing to divide yet.
 */
export function getFunnelStats(database: DatabaseSync): FunnelStats {
  const snapshotRows = database.prepare(
    "SELECT status, COUNT(*) AS count FROM jobs GROUP BY status"
  ).all() as Array<{ status: string; count: number }>;
  const snapshot: Record<string, number> = {};
  for (const row of snapshotRows) snapshot[row.status] = row.count;

  const funnel: Record<FunnelStage, number> = {
    submitted: entered(database, "SUBMITTED"),
    interview: entered(database, "INTERVIEW"),
    offer: entered(database, "OFFER"),
    rejected: entered(database, "REJECTED"),
    withdrawn: entered(database, "WITHDRAWN")
  };

  const responded = new Set(
    (database.prepare(
      "SELECT DISTINCT job_id AS jobId FROM application_events WHERE to_status IN ('INTERVIEW', 'OFFER', 'REJECTED') UNION SELECT DISTINCT job_id AS jobId FROM outcome_events WHERE stage IN ('RESPONSE', 'OA', 'SCREEN', 'INTERVIEW', 'FINAL', 'OFFER', 'REJECTED')"
    ).all() as Array<{ jobId: string }>).map((row) => row.jobId)
  ).size;
  const interviewedOrBetter = new Set(
    (database.prepare(
      "SELECT DISTINCT job_id AS jobId FROM application_events WHERE to_status IN ('INTERVIEW', 'OFFER')"
    ).all() as Array<{ jobId: string }>).map((row) => row.jobId)
  ).size;

  const timing = database.prepare(`
    WITH submitted AS (
      SELECT job_id, MIN(created_at) AS submitted_at
      FROM application_events WHERE to_status = 'SUBMITTED'
      GROUP BY job_id
    ),
    responded AS (
      SELECT job_id, MIN(created_at) AS responded_at
      FROM (
        SELECT job_id, created_at FROM application_events WHERE to_status IN ('INTERVIEW', 'OFFER', 'REJECTED')
        UNION ALL
        SELECT job_id, recorded_at AS created_at FROM outcome_events WHERE stage IN ('RESPONSE', 'OA', 'SCREEN', 'INTERVIEW', 'FINAL', 'OFFER', 'REJECTED')
      )
      GROUP BY job_id
    )
    SELECT AVG((julianday(responded.responded_at) - julianday(submitted.submitted_at))) AS avgDays
    FROM submitted JOIN responded USING (job_id)
  `).get() as { avgDays: number | null };

  const bySource = database.prepare(`
    SELECT
      j.application_type AS applicationType,
      COUNT(DISTINCT CASE WHEN e.to_status = 'SUBMITTED' THEN e.job_id END) AS submitted,
      COUNT(DISTINCT CASE WHEN e.to_status = 'INTERVIEW' THEN e.job_id END) AS interviews,
      COUNT(DISTINCT CASE WHEN e.to_status = 'OFFER' THEN e.job_id END) AS offers,
      COUNT(DISTINCT CASE WHEN e.to_status = 'REJECTED' THEN e.job_id END) AS rejections
    FROM jobs j LEFT JOIN application_events e ON e.job_id = j.id
    GROUP BY j.application_type
  `).all() as SourceFunnel[];

  const detailedStages = Object.fromEntries(outcomeEventSchema.shape.stage.options.map((stage) => {
    const row = database.prepare("SELECT COUNT(DISTINCT job_id) AS count FROM outcome_events WHERE stage = ?").get(stage) as { count: number };
    return [stage, row.count];
  })) as Record<OutcomeStage, number>;

  const jobRows = database.prepare("SELECT id, title FROM jobs").all() as Array<{ id: string; title: string }>;
  const roleMap = new Map<string, { roleType: string; submitted: number; responses: number; interviews: number; offers: number }>();
  const variantMap = new Map<string, { variantId: string | null; variant: string; submitted: number; interviews: number; offers: number }>();
  for (const job of jobRows) {
    const statuses = new Set((database.prepare("SELECT to_status AS status FROM application_events WHERE job_id = ?").all(job.id) as Array<{ status: string }>).map((row) => row.status));
    if (!statuses.has("SUBMITTED")) continue;
    const detailed = new Set((database.prepare("SELECT stage FROM outcome_events WHERE job_id = ?").all(job.id) as Array<{ stage: OutcomeStage }>).map((row) => row.stage));
    const response = ["INTERVIEW", "OFFER", "REJECTED"].some((status) => statuses.has(status))
      || ["RESPONSE", "OA", "SCREEN", "INTERVIEW", "FINAL", "OFFER", "REJECTED"].some((stage) => detailed.has(stage as OutcomeStage));
    const interview = statuses.has("INTERVIEW") || statuses.has("OFFER") || detailed.has("INTERVIEW") || detailed.has("FINAL");
    const offer = statuses.has("OFFER") || detailed.has("OFFER");
    const roleType = roleTypeForTitle(job.title);
    const role = roleMap.get(roleType) ?? { roleType, submitted: 0, responses: 0, interviews: 0, offers: 0 };
    role.submitted += 1; role.responses += Number(response); role.interviews += Number(interview); role.offers += Number(offer);
    roleMap.set(roleType, role);

    const variantRow = database.prepare(`
      SELECT v.id AS variantId, COALESCE(v.label, 'Unknown or manual') AS label
      FROM browser_runs b LEFT JOIN resume_variants v ON v.id = b.variant_id
      WHERE b.job_id = ? AND b.status = 'submitted'
      ORDER BY b.updated_at DESC LIMIT 1
    `).get(job.id) as { variantId: string | null; label: string } | undefined;
    const variantId = variantRow?.variantId ?? null;
    const variantName = variantRow?.label ?? "Unknown or manual";
    const variantKey = variantId ?? "unknown-or-manual";
    const variant = variantMap.get(variantKey) ?? { variantId, variant: variantName, submitted: 0, interviews: 0, offers: 0 };
    variant.submitted += 1; variant.interviews += Number(interview); variant.offers += Number(offer);
    variantMap.set(variantKey, variant);

  }
  // Discovery and analysis for rejected jobs are still part of the cost of
  // getting submitted applications, so the numerator covers every call.
  const usage = database.prepare(`
    SELECT COALESCE(SUM(estimated_cost_microusd), 0) AS known,
      SUM(CASE WHEN estimated_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unknown
    FROM model_invocations
  `).get() as { known: number; unknown: number | null };
  const unknownCalls = usage.unknown ?? 0;
  const knownUsd = usage.known / 1_000_000;
  const completeCost = unknownCalls === 0;

  return {
    generatedAt: new Date().toISOString(),
    snapshot,
    funnel,
    responseRate: funnel.submitted > 0 ? responded / funnel.submitted : null,
    interviewRate: funnel.submitted > 0 ? interviewedOrBetter / funnel.submitted : null,
    offerRate: funnel.submitted > 0 ? funnel.offer / funnel.submitted : null,
    avgDaysToResponse: timing.avgDays,
    bySource,
    detailedStages,
    byRole: [...roleMap.values()].sort((a, b) => b.submitted - a.submitted || a.roleType.localeCompare(b.roleType)),
    byVariant: [...variantMap.values()].sort((a, b) => b.submitted - a.submitted || a.variant.localeCompare(b.variant)),
    cost: {
      knownUsd,
      unknownCalls,
      perApplicationUsd: completeCost && funnel.submitted > 0 ? knownUsd / funnel.submitted : null,
      perInterviewUsd: completeCost && funnel.interview > 0 ? knownUsd / funnel.interview : null,
      perOfferUsd: completeCost && funnel.offer > 0 ? knownUsd / funnel.offer : null
    }
  };
}
