"use server";

import { revalidatePath } from "next/cache";

import { analyzeSemanticFit, automaticallyAnalyzeFit, addCompanySource, evaluateAndPersistMatch, fetchCompanySource, ingestPosting, prepareApplication, processManualBatch, readPipelineLock, relabelHeldPostings } from "@internship-agent/agent";
import { jobIngestionInputSchema } from "@internship-agent/domain";

import type { JobActionState } from "./action-state";
import { getActiveDatabase, getActiveDataDirectory } from "@/lib/active-profile";

export async function ingestPostingAction(
  _previousState: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  try {
    const database = await getActiveDatabase();
    const input = jobIngestionInputSchema.parse({
      companyName: requiredText(formData, "companyName"),
      title: requiredText(formData, "title"),
      content: requiredText(formData, "content"),
      sourceUrl: requiredText(formData, "sourceUrl"),
      externalApplicationUrl: optionalText(formData, "externalApplicationUrl"),
      companyCareersUrl: optionalText(formData, "companyCareersUrl")
    });
    const report = await ingestPosting(input, { database });
    revalidatePath("/jobs");
    revalidatePath("/");
    return { status: "success", message: describe(report) };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

function describe(report: Awaited<ReturnType<typeof ingestPosting>>): string {
  if (report.status === "UNCHANGED") {
    return "This posting is already stored and its content has not changed.";
  }
  if (report.requirementLabelsPending) {
    return "Stored the posting. AI requirement labels are unavailable right now; the next pipeline pass will retry them before it is analyzed.";
  }
  const verb = report.status === "CREATED" ? "Ingested" : "Updated";
  const constraints = report.statedConstraints.length > 0
    ? ` Stated constraints: ${report.statedConstraints.join(", ")}.`
    : " No eligibility constraints were stated.";
  return `${verb} the posting: ${report.hardRequirements} hard and ${report.preferredRequirements} preferred requirements,`
    + ` ${report.technologies} technologies.${constraints}`;
}

/**
 * Deterministic Milestone 4 analysis: hard eligibility first, then
 * explainable fit. Re-running replaces the stored match report.
 */
export async function prepareApplicationAction(
  _previousState: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  try {
    const database = await getActiveDatabase();
    const jobId = requiredText(formData, "jobId");
    assertUuid(jobId);
    const { verification, missingFacts } = prepareApplication(jobId, { database });
    revalidatePath("/jobs");
    revalidatePath("/");
    if (verification.blocked || missingFacts.length > 0) {
      return {
        status: "success",
        message: `Package prepared but needs candidate input: ${describeNeedsInput(verification, missingFacts)}`
      };
    }
    return { status: "success", message: "Verified package prepared and ready for review." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Milestone 9 bulk intake: paste a batch, dedupe, ingest, cheaply analyze
 * everything, and prepare only the promoted few for the review queue.
 */
export async function discoverBatchAction(
  _previousState: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  try {
    const database = await getActiveDatabase();
    const batchText = requiredText(formData, "batchText");
    const { run, jobIds, promotedJobIds, skippedJobIds, feedbackSkippedJobIds, errors } = await processManualBatch(batchText, {
      database,
      threshold: 60,
      limit: 5
    });
    revalidatePath("/jobs");
    revalidatePath("/review");
    revalidatePath("/");
    const summary = `Batch: ${run.fetched} fetched, ${run.deduped} duplicates, ${jobIds.length} ingested, ${run.analyzed} analyzed, ${promotedJobIds.length} promoted.`;
    const skipped = skippedJobIds.length > 0 ? ` ${skippedJobIds.length} live application${skippedJobIds.length === 1 ? "" : "s"} left untouched.` : "";
    const feedback = feedbackSkippedJobIds.length > 0 ? ` ${feedbackSkippedJobIds.length} candidate-skipped posting${feedbackSkippedJobIds.length === 1 ? "" : "s"} ignored.` : "";
    const notes = errors.slice(0, 3).join(" ");
    return { status: "success", message: notes ? `${summary}${skipped}${feedback} Notes: ${notes}` : `${summary}${skipped}${feedback}` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function addDiscoverySourceAction(
  _previousState: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  try {
    const database = await getActiveDatabase();
    const label = requiredText(formData, "label");
    const url = requiredText(formData, "url");
    const rateLimitPerMinute = Number(requiredText(formData, "rateLimitPerMinute"));
    if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 60) {
      throw new Error("Choose between 1 and 60 polls per minute.");
    }
    addCompanySource(label, url, rateLimitPerMinute, database);
    revalidatePath("/jobs");
    return { status: "success", message: "Public source saved locally." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function pollDiscoverySourceAction(
  _previousState: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  try {
    const running = readPipelineLock(await getActiveDataDirectory());
    if (running) {
      throw new Error(`A pipeline run is in progress (started ${new Date(running.startedAt).toLocaleString("en-US")}). Check board is disabled until it finishes.`);
    }
    const database = await getActiveDatabase();
    const sourceId = requiredText(formData, "sourceId");
    assertUuid(sourceId);
    const report = await fetchCompanySource(sourceId, { database });
    revalidatePath("/jobs");
    revalidatePath("/review");
    const notes = report.sourceNotes.length > 0 ? ` ${report.sourceNotes.join(" ")}` : "";
    return { status: "success", message: `Source checked: ${report.run.fetched} full postings found, ${report.run.promoted} promoted.${notes}` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function analyzePostingAction(formData: FormData): Promise<void> {
  const database = await getActiveDatabase();
  const jobId = requiredText(formData, "jobId");
  assertUuid(jobId);
  // A posting held for AI requirement labels gets a labelling retry first; if
  // it is still held, analysis refuses with the hold's reason.
  await relabelHeldPostings(database, { jobIds: [jobId] });
  evaluateAndPersistMatch(jobId, { database });
  await automaticallyAnalyzeFit(jobId, database);
  revalidatePath("/jobs");
  revalidatePath("/");
}

function describeNeedsInput(
  verification: Awaited<ReturnType<typeof prepareApplication>>["verification"],
  missingFacts: string[]
): string {
  const reasons = verification.checks
    .filter((check) => check.verdict !== "SUPPORTED")
    .map((check) => check.reason);
  return [...reasons, ...missingFacts.map((key) => `missing fact: ${key}`)].join(" ").slice(0, 400);
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Unknown posting.");
  }
}

function requiredText(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optionalText(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export async function analyzeFitAiAction(_previous: JobActionState, formData: FormData): Promise<JobActionState> {
  try {
    const jobId = requiredText(formData, "jobId");
    assertUuid(jobId);
    const database = await getActiveDatabase();
    await analyzeSemanticFit(jobId, { database });
    revalidatePath("/jobs"); revalidatePath("/review"); revalidatePath(`/applications/${jobId}`);
    return { status: "success", message: "AI competitiveness assessment saved. Eligibility and application approval are unchanged." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "AI fit unavailable." };
  }
}
