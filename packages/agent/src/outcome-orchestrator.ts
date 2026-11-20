import type { DatabaseSync } from "node:sqlite";

import {
  getDatabase,
  getFunnelStats,
  getJobStatus,
  listOutcomeEvents,
  persistOutcomeUpdate,
  type FunnelStats
} from "@internship-agent/db";
import type { JobPostingStatus, OutcomeStage } from "@internship-agent/domain";

export type RecordableOutcome = OutcomeStage | "WITHDRAWN";

const MAX_NOTE_LENGTH = 500;

/**
 * Post-submission outcomes only: the browser run owns APPROVED -> APPLYING ->
 * SUBMITTED, and terminal states never reopen. Withdrawing is the one exit
 * allowed from any live state.
 */
const OUTCOME_TRANSITIONS: Record<string, RecordableOutcome[]> = {
  SUBMITTED: ["INTERVIEW", "REJECTED", "OFFER", "WITHDRAWN"],
  INTERVIEW: ["OFFER", "REJECTED", "WITHDRAWN"]
};

export function assertOutcomeTransition(from: JobPostingStatus, to: RecordableOutcome): void {
  if (to === "RESPONSE" || to === "OA" || to === "SCREEN" || to === "GHOSTED") {
    if (from === "SUBMITTED" || from === "INTERVIEW") return;
  }
  if (to === "FINAL" && from === "INTERVIEW") return;
  const allowed = OUTCOME_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `That update does not follow this application: from ${from.toLocaleLowerCase("en-US")} only ${allowed.length > 0 ? allowed.map((status) => status.toLocaleLowerCase("en-US")).join(", ") : "no further updates"} ${allowed.length === 1 ? "is" : "are"} possible.`
    );
  }
}

/**
 * The Milestone 10 orchestration seam. Outcomes are the candidate's own
 * records of what employers said, logged onto the event timeline so the
 * funnel and the detail page reconstruct the same history.
 */
export function recordOutcome(
  jobId: string,
  outcome: RecordableOutcome,
  options: { database?: DatabaseSync; note?: string } = {}
): void {
  const database = options.database ?? getDatabase();
  const status = getJobStatus(database, jobId);
  if (!status) throw new Error("The posting is unknown; ingest it before recording an outcome.");
  assertOutcomeTransition(status, outcome);
  const note = options.note?.trim() ?? "";
  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error("The note is too long; keep employer news under 500 characters.");
  }
  persistOutcomeUpdate(database, jobId, outcome, note || null);
}

export function getOutcomeStats(database: DatabaseSync = getDatabase()): FunnelStats {
  return getFunnelStats(database);
}

export function getJobOutcomeEvents(jobId: string, database: DatabaseSync = getDatabase()) {
  return listOutcomeEvents(database, jobId);
}

export function getOutcomeRecommendations(database: DatabaseSync = getDatabase(), stats = getFunnelStats(database)): string[] {
  const groups = stats.byRole.filter((group) => group.submitted >= 5);
  if (groups.length < 2) return [];
  const ordered = [...groups].sort((a, b) => b.responses / b.submitted - a.responses / a.submitted);
  const best = ordered[0];
  const weakest = ordered[ordered.length - 1];
  if (best.responses / best.submitted - weakest.responses / weakest.submitted < 0.2) return [];
  return [
    `${best.roleType} drew ${best.responses} responses from ${best.submitted} submissions, compared with ${weakest.responses} from ${weakest.submitted} for ${weakest.roleType}. Consider whether to focus more on ${best.roleType}; review the underlying applications before changing your preferences.`
  ];
}
