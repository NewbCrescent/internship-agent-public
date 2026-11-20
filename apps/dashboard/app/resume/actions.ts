"use server";

import { revalidatePath } from "next/cache";

import {
  addResumeEntry,
  approveResumeEntry,
  archiveCandidateResumeEntry,
  editResumeEntry,
  moveCandidateResumeEntry,
  setCandidateResumeEntryInWorkHistory,
  setCandidateResumeEntryOnResume
} from "@internship-agent/agent";
import { resumeSectionSchema, type ResumeEntryContentInput } from "@internship-agent/domain";

import type { ResumeActionState } from "./action-state";
import { getActiveDatabase } from "@/lib/active-profile";

export async function saveResumeEntryAction(
  _previousState: ResumeActionState,
  formData: FormData
): Promise<ResumeActionState> {
  try {
    const database = await getActiveDatabase();
    const entryId = optionalText(formData, "entryId");
    const content = entryContent(formData);
    if (entryId) {
      assertUuid(entryId);
      editResumeEntry(entryId, content, { database });
    } else {
      addResumeEntry(resumeSectionSchema.parse(formData.get("section")), content, { database });
    }
    revalidatePath("/resume");
    return { status: "success", message: entryId ? "Entry updated." : "Entry added." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function approveResumeEntryAction(formData: FormData): Promise<void> {
  const entryId = requiredText(formData, "entryId");
  const revisionId = requiredText(formData, "revisionId");
  assertUuid(entryId);
  assertUuid(revisionId);
  approveResumeEntry(entryId, revisionId, { database: await getActiveDatabase() });
  revalidatePath("/resume");
}

export async function archiveResumeEntryAction(formData: FormData): Promise<void> {
  const entryId = requiredText(formData, "entryId");
  assertUuid(entryId);
  archiveCandidateResumeEntry(entryId, await getActiveDatabase());
  revalidatePath("/resume");
}

/** Chooses whether an entry prints on the resume; it stays library content either way. */
export async function setResumeEntryOnResumeAction(formData: FormData): Promise<void> {
  const entryId = requiredText(formData, "entryId");
  assertUuid(entryId);
  const onResume = requiredText(formData, "onResume");
  if (onResume !== "true" && onResume !== "false") throw new Error("Unknown resume choice.");
  setCandidateResumeEntryOnResume(entryId, onResume === "true", await getActiveDatabase());
  revalidatePath("/resume");
}

/** Chooses whether an experience entry is listed in application work history (Workday's My Experience). */
export async function setResumeEntryInWorkHistoryAction(formData: FormData): Promise<void> {
  const entryId = requiredText(formData, "entryId");
  assertUuid(entryId);
  const include = requiredText(formData, "inWorkHistory");
  if (include !== "true" && include !== "false") throw new Error("Unknown work-history choice.");
  setCandidateResumeEntryInWorkHistory(entryId, include === "true", await getActiveDatabase());
  revalidatePath("/resume");
}

export async function moveResumeEntryAction(formData: FormData): Promise<void> {
  const entryId = requiredText(formData, "entryId");
  const direction = requiredText(formData, "direction");
  assertUuid(entryId);
  if (direction !== "up" && direction !== "down") throw new Error("Unknown direction.");
  moveCandidateResumeEntry(entryId, direction, await getActiveDatabase());
  revalidatePath("/resume");
}

function entryContent(formData: FormData): ResumeEntryContentInput {
  return {
    title: requiredText(formData, "title"),
    role: optionalText(formData, "role") ?? null,
    linkLabel: optionalText(formData, "linkLabel") ?? null,
    linkUrl: optionalText(formData, "linkUrl") ?? null,
    location: optionalText(formData, "location") ?? null,
    dateText: optionalText(formData, "dateText") ?? null,
    startMonth: optionalText(formData, "startMonth") ?? null,
    endMonth: formData.get("isCurrent") === "on" ? null : optionalText(formData, "endMonth") ?? null,
    isCurrent: formData.get("isCurrent") === "on",
    bullets: requiredText(formData, "bullets").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
}

function requiredText(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

function optionalText(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Unknown resume entry.");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") return "Check the entry fields: a link must start with http(s):// and text must fit the limits.";
  return error instanceof Error ? error.message : "The request could not be completed.";
}
