import type { DatabaseSync } from "node:sqlite";

import { getDatabase, getJobStatus, logApplicationEvent } from "@internship-agent/db";
import {
  DeterministicRequirementClassifier,
  ingestJobPosting,
  type IngestionReport,
  type RequirementClassifier
} from "@internship-agent/jobs";
import type { JobIngestionInput, JobPostingStatus } from "@internship-agent/domain";

import { OpenAiCompatibleProvider } from "./model/openai-compatible-provider";
import { ModelRequirementClassifier } from "./model/requirement-classifier";
import type { ModelProvider } from "./model/provider";

/**
 * The orchestration seam: the dashboard action calls here, and this is the
 * only place that decides whether a model participates. `packages/jobs` stays
 * provider-free, so its suites never reach the network.
 */
export async function ingestPosting(
  input: JobIngestionInput,
  options: { database?: DatabaseSync; provider?: ModelProvider; protectedStatuses?: ReadonlySet<JobPostingStatus> } = {}
): Promise<IngestionReport> {
  const database = options.database ?? getDatabase();
  const report = await ingestJobPosting(input, {
    database,
    classifier: selectClassifier(database, options.provider),
    protectedStatuses: options.protectedStatuses
  });
  // A held posting records why it waits, so the reason is visible in its history.
  if (report.requirementLabelsPending && report.status !== "UNCHANGED") {
    const status = getJobStatus(database, report.jobId);
    if (status) {
      logApplicationEvent(database, {
        jobId: report.jobId,
        fromStatus: status,
        toStatus: status,
        detail: report.requirementLabelsPending.slice(0, 1_000)
      });
    }
  }
  return report;
}

/**
 * Absent a configured provider this returns the deterministic classifier, so
 * a missing API key degrades to fully local behavior instead of an error.
 * Those rule labels never drive an automatic run: the pipeline refuses to run
 * a posting with any requirement the model did not label. With a provider, a
 * posting the model cannot label is held for a retry instead of rule-labelled.
 */
export function selectClassifier(
  database: DatabaseSync = getDatabase(),
  provider: ModelProvider = new OpenAiCompatibleProvider()
): RequirementClassifier {
  return provider.available
    ? new ModelRequirementClassifier(provider, database)
    : new DeterministicRequirementClassifier();
}
