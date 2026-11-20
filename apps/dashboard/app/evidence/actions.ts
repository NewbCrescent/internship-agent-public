"use server";

import { revalidatePath } from "next/cache";

import { reviewGitHubEvidenceClaim, syncGitHubRepository } from "@internship-agent/github";

import type { EvidenceActionState } from "./action-state";
import { getActiveDatabase } from "@/lib/active-profile";

export async function syncRepositoryAction(
  _previousState: EvidenceActionState,
  formData: FormData
): Promise<EvidenceActionState> {
  try {
    const database = await getActiveDatabase();
    const repository = requiredText(formData, "repository");
    const result = await syncGitHubRepository(repository, { database });
    revalidatePath("/evidence");
    return {
      status: "success",
      message: result.status === "UNCHANGED"
        ? `${result.repository} is already current at ${result.headSha.slice(0, 7)}.`
        : `Synced ${result.repository}: ${result.extractedClaims} candidate claims from ${result.fetchedFiles} changed files.`
    };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

export async function reviewClaimAction(
  _previousState: EvidenceActionState,
  formData: FormData
): Promise<EvidenceActionState> {
  try {
    const database = await getActiveDatabase();
    const claimId = requiredText(formData, "claimId");
    const decision = requiredText(formData, "decision");
    if (decision !== "ALLOWED" && decision !== "QUESTIONED" && decision !== "REJECTED") {
      throw new Error("Choose allow, question, or reject.");
    }
    const reviewed = reviewGitHubEvidenceClaim({ claimId, decision }, database);
    if (!reviewed) throw new Error("This claim is stale or no longer available for review.");
    revalidatePath("/evidence");
    return { status: "success", message: `Claim marked ${decision.toLocaleLowerCase("en-US")}.` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
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
