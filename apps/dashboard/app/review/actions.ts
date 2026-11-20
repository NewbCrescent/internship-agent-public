"use server";

import { revalidatePath } from "next/cache";
import { getReviewQueueWithResumeState, recordManualApplication, refreshApplications, restoreDiscoveredJob, saveReviewFocusSettings, skipDiscoveredJobs } from "@internship-agent/agent";
import { QUICK_SKIP_REASONS, quickSkipSchema } from "@internship-agent/domain";
import type { ApplicationActionState } from "@/app/applications/action-state";
import { getActiveDatabase } from "@/lib/active-profile";

export async function skipReviewBatchAction(
  _previous: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    const database = await getActiveDatabase();
    skipDiscoveredJobs({
      jobIds: formData.getAll("jobIds").filter((value): value is string => typeof value === "string"),
      reason: String(formData.get("reason") ?? ""),
      preferenceNote: String(formData.get("preferenceNote") ?? "").trim() || null
    }, database);
    revalidatePath("/review");
    revalidatePath("/jobs");
    return { status: "success", message: "Selected postings skipped. Preferences were not changed." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save skip feedback." };
  }
}

export async function recordManualApplicationAction(
  _previous: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  try {
    const database = await getActiveDatabase();
    const jobId = formData.get("jobId");
    if (typeof jobId !== "string") throw new Error("Choose an application to check off.");
    recordManualApplication(jobId, { database });
    revalidatePath("/review");
    revalidatePath("/applications");
    revalidatePath("/jobs");
    revalidatePath("/");
    return { status: "success", message: "Checked off as applied. Like a real submission, this cannot be undone." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not record the manual application." };
  }
}

export async function restoreReviewJobAction(formData: FormData): Promise<void> {
  const database = await getActiveDatabase();
  const jobId = formData.get("jobId");
  if (typeof jobId !== "string") throw new Error("Choose a posting to restore.");
  restoreDiscoveredJob(jobId, database);
  revalidatePath("/review");
}

/**
 * Rebuilds the given applications' packages from the current resume; runs
 * filled but never submitted are cancelled so the pipeline refills them.
 */
export async function refreshResumeAction(formData: FormData): Promise<void> {
  const database = await getActiveDatabase();
  const jobIds = formData.get("scope") === "all"
    ? getReviewQueueWithResumeState(database).filter((entry) => entry.resumeChanged).map((entry) => entry.jobId)
    : formData.getAll("jobIds").filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value));
  if (jobIds.length === 0 && formData.get("scope") !== "all") throw new Error("Choose an application to refresh.");
  refreshApplications(jobIds, { database });
  revalidatePath("/review");
  revalidatePath("/applications");
  for (const jobId of jobIds) revalidatePath(`/applications/${jobId}`);
}

/** One click from a Review card: the chosen reason is recorded without typing. */
export async function skipReviewJobAction(
  _previous: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  const parsed = quickSkipSchema.safeParse({ jobId: formData.get("jobId"), reason: formData.get("reason") });
  if (!parsed.success) return { status: "error", message: "Choose a reason to skip this posting." };
  try {
    const database = await getActiveDatabase();
    skipDiscoveredJobs({ jobIds: [parsed.data.jobId], reason: QUICK_SKIP_REASONS[parsed.data.reason], preferenceNote: null }, database);
    revalidatePath("/review");
    revalidatePath("/jobs");
    return { status: "success", message: "Skipped." };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not skip the posting." };
  }
}

export async function saveReviewFocusAction(
  _previous: ApplicationActionState,
  formData: FormData
): Promise<ApplicationActionState> {
  const pay = String(formData.get("minHourlyPay") ?? "").trim();
  try {
    const database = await getActiveDatabase();
    saveReviewFocusSettings(database, {
      categories: formData.getAll("categories").map(String),
      countries: formData.getAll("countries").map(String),
      includeUnstatedCountry: formData.get("includeUnstatedCountry") === "on",
      postedWithinDays: Number(formData.get("postedWithinDays")),
      minHourlyPay: pay ? Number(pay) : null
    });
    revalidatePath("/review");
    return { status: "success", message: "Focus saved." };
  } catch {
    return { status: "error", message: "Check the settings: 1–365 days and at most $1,000 an hour." };
  }
}
