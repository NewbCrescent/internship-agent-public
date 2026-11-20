"use server";

import { revalidatePath } from "next/cache";

import {
  answerCandidateQuestion,
  connectHandshake,
  forgetCandidateFact,
  isHandshakeConnectionPending,
  resolveCandidateQuestion,
  storeBaseResume,
  storeCandidateDocument,
  updateCandidatePreferences,
  updateCandidateProfile
} from "@internship-agent/agent";
import { applicationChannelSchema, baseResumeChannelSchema } from "@internship-agent/domain";
import type { FormActionState, MemoryActionState } from "./action-state";
import { getActiveDataDirectory, getActiveDatabase } from "@/lib/active-profile";

export async function updateProfileAction(
  _previousState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  try {
    const database = await getActiveDatabase();
    updateCandidateProfile({
      fullName: text(formData, "fullName"),
      preferredName: optionalText(formData, "preferredName"),
      email: optionalText(formData, "email"),
      phone: optionalText(formData, "phone"),
      school: optionalText(formData, "school"),
      degree: optionalText(formData, "degree"),
      graduationDate: optionalText(formData, "graduationDate"),
      gpa: optionalText(formData, "gpa"),
      linkedinUrl: optionalText(formData, "linkedinUrl"),
      githubUrl: optionalText(formData, "githubUrl"),
      portfolioUrl: optionalText(formData, "portfolioUrl"),
      legalFirstName: optionalText(formData, "legalFirstName"),
      legalLastName: optionalText(formData, "legalLastName"),
      addressLine1: optionalText(formData, "addressLine1"),
      addressLine2: optionalText(formData, "addressLine2"),
      addressCity: optionalText(formData, "addressCity"),
      addressRegion: optionalText(formData, "addressRegion"),
      addressPostalCode: optionalText(formData, "addressPostalCode"),
      addressCountry: optionalText(formData, "addressCountry"),
      phoneType: optionalText(formData, "phoneType"),
      fieldOfStudy: optionalText(formData, "fieldOfStudy"),
      educationStartMonth: optionalText(formData, "educationStartMonth"),
      highSchoolName: optionalText(formData, "highSchoolName"),
      highSchoolStartYear: optionalText(formData, "highSchoolStartYear"),
      highSchoolEndYear: optionalText(formData, "highSchoolEndYear")
    }, database);
    revalidatePath("/profile");
    return { status: "success", message: "Profile saved locally." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function updatePreferencesAction(
  _previousState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  try {
    const database = await getActiveDatabase();
    updateCandidatePreferences({
      roleTypes: commaList(formData, "roleTypes"),
      locations: commaList(formData, "locations"),
      industries: commaList(formData, "industries"),
      workModes: formData.getAll("workModes").map(String) as Array<"remote" | "hybrid" | "onsite">,
      excludeGraduateOnlyInternships: formData.get("excludeGraduateOnlyInternships") === "on"
    }, database);
    revalidatePath("/profile");
    return { status: "success", message: "Preferences saved. They will not be treated as application answers." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function resolveQuestionAction(
  _previousState: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  try {
    const database = await getActiveDatabase();
    const question = text(formData, "question");
    const resolution = await resolveCandidateQuestion(question, {
      countryCode: optionalText(formData, "countryCode"),
      location: optionalText(formData, "location"),
      applicationChannel: applicationChannel(formData)
    }, { database });
    return { resolution, error: null };
  } catch (error) {
    return { resolution: null, error: errorMessage(error) };
  }
}

export async function answerQuestionAction(
  _previousState: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  try {
    const database = await getActiveDatabase();
    const resolution = await answerCandidateQuestion({
      question: text(formData, "question"),
      answer: text(formData, "answer"),
      remember: formData.get("remember") === "on",
      context: {
        countryCode: optionalText(formData, "countryCode"),
        location: optionalText(formData, "location"),
        applicationChannel: applicationChannel(formData)
      }
    }, { database });
    revalidatePath("/profile");
    return { resolution, error: null };
  } catch (error) {
    return { resolution: null, error: errorMessage(error) };
  }
}

export async function forgetFactAction(factId: string): Promise<void> {
  forgetCandidateFact(factId, await getActiveDatabase());
  revalidatePath("/profile");
}

export async function uploadBaseResumeAction(
  _previousState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  try {
    const file = formData.get("resume");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a PDF to upload.");
    const [database, dataDir] = await Promise.all([getActiveDatabase(), getActiveDataDirectory()]);
    const input = {
      label: optionalText(formData, "label") ?? "",
      originalName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer())
    };
    const saved = formData.get("channel") === "transcript"
      ? storeCandidateDocument({ ...input, kind: "transcript" }, { database, dataDir })
      : storeBaseResume({ ...input, channel: baseResumeChannelSchema.parse(formData.get("channel")) }, { database, dataDir });
    revalidatePath("/profile");
    return { status: "success", message: `Saved "${saved.label}" locally (${Math.ceil(saved.byteSize / 1024)} KB).` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Opens a visible sign-in window and returns immediately; the window records
 * the outcome when the candidate finishes. Refresh the page to see it.
 */
export async function connectHandshakeAction(): Promise<FormActionState> {
  try {
    const [database, dataDir] = await Promise.all([getActiveDatabase(), getActiveDataDirectory()]);
    if (isHandshakeConnectionPending(dataDir)) {
      return { status: "success", message: "A sign-in window is already open." };
    }
    void connectHandshake({ database, dataDir }).catch(() => undefined);
    return { status: "success", message: "A browser window opened on Handshake. Sign in there, close the window when you are done, then refresh this page." };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

function applicationChannel(formData: FormData) {
  const value = optionalText(formData, "applicationChannel");
  return value ? applicationChannelSchema.parse(value) : undefined;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string") throw new Error(`${key} is required.`);
  return value;
}

function optionalText(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function commaList(formData: FormData, key: string): string[] {
  return text(formData, key).split(",").map((value) => value.trim()).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}
