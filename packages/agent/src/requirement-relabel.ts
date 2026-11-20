import type { DatabaseSync } from "node:sqlite";

import {
  getDatabase,
  getDiscoverySkip,
  getJobMatch,
  getJobPosting,
  holdRequirementLabels,
  listRequirementLabelHolds,
  listRequirementRelabelCandidates,
  logApplicationEvent,
  replaceCurrentJobRequirements
} from "@internship-agent/db";
import type { JobPostingStatus } from "@internship-agent/domain";
import {
  extractDeterministically,
  labelRequirements,
  REQUIREMENT_LABELS_UNAVAILABLE,
  RequirementLabelsUnavailableError
} from "@internship-agent/jobs";

import { evaluateAndPersistMatch } from "./match-orchestrator";
import { OpenAiCompatibleProvider } from "./model/openai-compatible-provider";
import type { ModelProvider } from "./model/provider";
import { ModelRequirementClassifier } from "./model/requirement-classifier";

/** Statuses whose requirements may be replaced without touching an application in flight. */
const REPAIRABLE = new Set<JobPostingStatus>(["DISCOVERED", "ANALYZING", "NOT_QUALIFIED", "QUALIFIED"]);

/** Held postings relabelled per pipeline pass; the rest wait for the next pass. */
export const RELABEL_LIMIT_PER_PASS = 25;

/** The stable line a pass reports for each posting still waiting for AI labels. */
export function labelsPendingNotice(posting: { companyName: string; title: string }): string {
  return `${REQUIREMENT_LABELS_UNAVAILABLE}: ${posting.companyName} — ${posting.title}.`;
}

/**
 * Retries the model labels of held postings from their stored snapshots. A
 * success replaces the requirements and clears the hold in one transaction,
 * then re-evaluates an existing match; a failure records another attempt and
 * keeps the posting held. Never falls back to rule labels.
 */
export async function relabelHeldPostings(
  database: DatabaseSync = getDatabase(),
  options: { provider?: ModelProvider; candidateId?: string; limit?: number; jobIds?: string[] } = {}
): Promise<{ relabelled: string[]; reevaluated: string[]; errors: string[] }> {
  const outcome = { relabelled: [] as string[], reevaluated: [] as string[], errors: [] as string[] };
  const wanted = options.jobIds ? new Set(options.jobIds) : null;
  // Dismissed postings are skipped everywhere else in the pipeline; relabelling
  // them would spend model calls on postings the candidate ruled out.
  const holds = listRequirementLabelHolds(database)
    .filter((hold) => !wanted || wanted.has(hold.jobId))
    .filter((hold) => !getDiscoverySkip(database, hold.jobId));
  if (holds.length === 0) return outcome;

  const provider = options.provider ?? new OpenAiCompatibleProvider();
  if (!provider.available) {
    for (const hold of holds) {
      const posting = getJobPosting(database, hold.jobId);
      if (posting) outcome.errors.push(labelsPendingNotice(posting));
    }
    return outcome;
  }

  const classifier = new ModelRequirementClassifier(provider, database);
  for (const hold of holds.slice(0, options.limit ?? RELABEL_LIMIT_PER_PASS)) {
    const posting = getJobPosting(database, hold.jobId);
    if (!posting) continue;
    const status = posting.status;
    if (!REPAIRABLE.has(status)) {
      outcome.errors.push(`${labelsPendingNotice(posting)} Its status (${status}) blocks automatic relabelling.`);
      continue;
    }
    try {
      const candidates = extractDeterministically(posting.snapshot.normalizedText).requirements;
      const { requirements } = await labelRequirements(posting.snapshot.normalizedText, candidates, classifier, {
        title: posting.title,
        companyName: posting.companyName,
        jobId: posting.id,
        sourceUrl: posting.source.sourceUrl
      });
      replaceCurrentJobRequirements(database, posting.id, posting.snapshot.id, requirements);
      logApplicationEvent(database, {
        jobId: posting.id,
        fromStatus: status,
        toStatus: status,
        detail: "Requirement labels came from the AI on retry."
      });
      outcome.relabelled.push(posting.id);
      if (getJobMatch(database, posting.id)) {
        evaluateAndPersistMatch(posting.id, { database, candidateId: options.candidateId });
        outcome.reevaluated.push(posting.id);
      }
    } catch (error) {
      const reason = error instanceof RequirementLabelsUnavailableError
        ? error.message
        : `${REQUIREMENT_LABELS_UNAVAILABLE} (${error instanceof Error ? error.message : String(error)}).`;
      holdRequirementLabels(database, { jobId: posting.id, snapshotId: posting.snapshot.id, reason });
      outcome.errors.push(labelsPendingNotice(posting));
    }
  }
  return outcome;
}

export type FallbackLabelItem = {
  jobId: string;
  companyName: string;
  title: string;
  status: JobPostingStatus;
  evidence: Array<"rule-labels" | "failed-model-call">;
};

/**
 * Finds postings whose stored labels may have come from the old rule fallback
 * and, with `apply`, holds them so the next pass relabels them with the AI.
 * Writes only hold rows: no deletes and no status changes. Postings past the
 * repairable statuses are reported and never written.
 */
export function holdFallbackRequirementLabels(
  database: DatabaseSync,
  options: { apply: boolean }
): { apply: boolean; held: FallbackLabelItem[]; alreadyHeld: FallbackLabelItem[]; skipped: FallbackLabelItem[] } {
  const report = {
    apply: options.apply,
    held: [] as FallbackLabelItem[],
    alreadyHeld: [] as FallbackLabelItem[],
    skipped: [] as FallbackLabelItem[]
  };
  for (const candidate of listRequirementRelabelCandidates(database)) {
    const item: FallbackLabelItem = {
      jobId: candidate.jobId,
      companyName: candidate.companyName,
      title: candidate.title,
      status: candidate.status,
      evidence: [
        ...(candidate.ruleLabels ? ["rule-labels" as const] : []),
        ...(candidate.failedModelCall ? ["failed-model-call" as const] : [])
      ]
    };
    if (candidate.held) {
      report.alreadyHeld.push(item);
      continue;
    }
    if (!REPAIRABLE.has(candidate.status)) {
      report.skipped.push(item);
      continue;
    }
    report.held.push(item);
    if (options.apply) {
      holdRequirementLabels(database, {
        jobId: candidate.jobId,
        snapshotId: candidate.snapshotId,
        reason: `${REQUIREMENT_LABELS_UNAVAILABLE} (the stored labels may have come from the rule fallback).`
      });
    }
  }
  return report;
}
