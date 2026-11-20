"use server";

import { revalidatePath } from "next/cache";

import {
  answerRunPause,
  approveApplication,
  approveRunSubmission,
  cancelBrowserRun,
  confirmRunAts,
  continueBrowserRun,
  recordOutcome,
  startBrowserRun,
  submitBrowserRun,
  withdrawApplication,
  type RecordableOutcome
} from "@internship-agent/agent";
import type { AtsKind } from "@internship-agent/domain";
import { atsKindSchema, manualOnly, outcomeStageSchema } from "@internship-agent/domain";

function manualRefusal(): ApplicationActionState {
  return { status: "error", message: "AI submission is hidden while manual mode is on." };
}

import type { ApplicationActionState } from "./action-state";
import { getActiveDataDirectory, getActiveDatabase } from "@/lib/active-profile";

export async function approveApplicationAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const jobId = requiredText(formData, "jobId");
    assertUuid(jobId);
    approveApplication(jobId, { database });
    revalidatePath("/applications");
    revalidatePath("/review");
    revalidatePath("/jobs");
    revalidatePath("/");
    return { status: "success", message: "Package approved. Submission itself still needs a separate explicit approval." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function withdrawApplicationAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    const database = await getActiveDatabase();
    const jobId = requiredText(formData, "jobId");
    assertUuid(jobId);
    withdrawApplication(jobId, { database });
    revalidatePath("/applications");
    revalidatePath("/review");
    revalidatePath("/jobs");
    revalidatePath("/");
    return { status: "success", message: "Application withdrawn." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Milestone 10 outcome logging. Employer news is the candidate's own record:
 * it lands on the event timeline and feeds the funnel, guarded so a closed
 * application cannot reopen and jumps off the submission path are refused.
 */
export async function recordOutcomeAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    const database = await getActiveDatabase();
    const jobId = requiredText(formData, "jobId");
    assertUuid(jobId);
    const outcome = requiredText(formData, "outcome");
    const stage = outcomeStageSchema.parse(outcome);
    const note = formData.get("note");
    recordOutcome(jobId, stage as RecordableOutcome, {
      database,
      note: typeof note === "string" ? note : undefined
    });
    revalidatePath("/applications");
    revalidatePath(`/applications/${jobId}`);
    revalidatePath("/");
    return { status: "success", message: `Recorded ${outcome.toLocaleLowerCase("en-US")}.` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Milestone 7 run controls. Each step opens the candidate's own persistent
 * browser session, does its bounded work, and closes it — there is no
 * daemon, and submission stays behind its own explicit approval.
 */
export async function startBrowserRunAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const dataDir = await getActiveDataDirectory();
    const jobId = requiredText(formData, "jobId");
    const applicationUrl = requiredText(formData, "applicationUrl");
    assertUuid(jobId);
    const { run } = await startBrowserRun(jobId, applicationUrl, { database, dataDir });
    revalidatePath(`/applications/${jobId}`);
    revalidatePath("/applications");
    return { status: "success", message: `Run started: ${run.status.toLocaleLowerCase("en-US").replace(/-/g, " ")}.` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function answerPauseAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const runId = requiredText(formData, "runId");
    const fieldId = requiredText(formData, "fieldId");
    const answer = requiredText(formData, "answer");
    const remember = formData.get("remember") === "on";
    assertUuid(runId);
    const { remembered } = await answerRunPause(runId, fieldId, answer, remember, { database });
    revalidatePath("/applications");
    return {
      status: "success",
      message: remembered ? "Answer recorded and remembered." : "Answer recorded for this run only; nothing was stored."
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function continueRunAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const dataDir = await getActiveDataDirectory();
    const runId = requiredText(formData, "runId");
    assertUuid(runId);
    const { run } = await continueBrowserRun(runId, { database, dataDir });
    revalidatePath("/applications");
    return { status: "success", message: `Run continued: ${run.status.toLocaleLowerCase("en-US").replace(/-/g, " ")}.` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function approveSubmissionAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const runId = requiredText(formData, "runId");
    assertUuid(runId);
    approveRunSubmission(runId, undefined, { database });
    revalidatePath("/applications");
    return { status: "success", message: "Submission approved. The final submit step still runs separately." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function submitRunAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const dataDir = await getActiveDataDirectory();
    const runId = requiredText(formData, "runId");
    assertUuid(runId);
    const run = await submitBrowserRun(runId, { database, dataDir });
    revalidatePath("/applications");
    revalidatePath("/");
    return { status: "success", message: `Submitted. Confirmation: ${(run.confirmationText ?? "").slice(0, 160)}` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function confirmAtsAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    if (manualOnly()) return manualRefusal();
    const database = await getActiveDatabase();
    const runId = requiredText(formData, "runId");
    const kind = requiredText(formData, "kind");
    assertUuid(runId);
    if (!atsKindSchema.options.includes(kind as AtsKind)) {
      throw new Error("Unknown ATS kind.");
    }
    confirmRunAts(runId, kind as AtsKind, { database });
    revalidatePath("/applications");
    return { status: "success", message: `ATS confirmed as ${kind}. Corrections stay visible in the timeline.` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function cancelRunAction(
  _previousState: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    const database = await getActiveDatabase();
    const runId = requiredText(formData, "runId");
    assertUuid(runId);
    cancelBrowserRun(runId, database);
    revalidatePath("/applications");
    return { status: "success", message: "Run cancelled." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Unknown application.");
  }
}

function requiredText(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
