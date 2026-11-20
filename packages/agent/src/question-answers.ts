import type { DatabaseSync } from "node:sqlite";

import { getCurrentQuestionAnswer } from "@internship-agent/db";
import {
  COURSEWORK_FACT_KEY,
  checkboxAnswer,
  genericSaveBlocker,
  matchOfferedOption,
  normalizeQuestionText,
  notSavedReasonText,
  questionReuseBlocked,
  type BrowserField,
  type CandidateFactKey,
  type FillDecision,
  type PauseRecord,
  type QuestionAnswerNotSavedReason,
  type QuestionContext,
  type SavedQuestionAnswer
} from "@internship-agent/domain";

import { DeterministicQuestionMapper, type SemanticQuestionMapper } from "./question-mapper";

/**
 * Where a held run's answer goes: catalog facts (the existing candidate memory
 * path), question memory (generic questions the catalog does not map), or this
 * run only, with the reason. Fully deterministic; no model is ever called.
 */

export type PauseMemoryPlan =
  | { path: "fact"; key: CandidateFactKey }
  | { path: "question"; questionKey: string }
  | { path: "once"; reason: QuestionAnswerNotSavedReason };

export type PauseAnswerOutcome =
  | { saved: true; store: "fact"; factKey: CandidateFactKey }
  | { saved: true; store: "question"; answerId: string; status: "saved" | "replaced" | "unchanged" }
  | { saved: false; reason: QuestionAnswerNotSavedReason; detail: string };

export function usedOnce(reason: QuestionAnswerNotSavedReason, detail?: string): PauseAnswerOutcome {
  return { saved: false, reason, detail: detail ?? notSavedReasonText(reason) };
}

/** Decides which store a pause's answer may go to; never-save rules make it this run only. */
export async function planPauseMemory(
  pause: PauseRecord,
  input: { companyName: string | null; context: QuestionContext; answer?: string; mapper?: SemanticQuestionMapper }
): Promise<PauseMemoryPlan> {
  if (pause.safeguard) return { path: "once", reason: "safeguard" };
  if (pause.upload) return { path: "once", reason: "upload" };
  if (pause.sensitive) return { path: "once", reason: "sensitive" };
  const mapper = input.mapper ?? new DeterministicQuestionMapper();
  const mapping = await mapper.map(pause.question, input.context);
  if (mapping.status === "MAPPED" && mapping.key === COURSEWORK_FACT_KEY) return { path: "once", reason: "coursework" };
  if (mapping.status === "MAPPED") return { path: "fact", key: mapping.key };
  if (mapping.status === "BLOCKED") {
    return { path: "once", reason: mapping.policy === "attestation" ? "blocked_attestation" : "blocked_protected" };
  }
  if (mapping.status === "AMBIGUOUS") return { path: "once", reason: "ambiguous" };
  const labelMapping = await mapper.map(pause.label, input.context);
  if (labelMapping.status === "BLOCKED") {
    return { path: "once", reason: labelMapping.policy === "attestation" ? "blocked_attestation" : "blocked_protected" };
  }
  if (labelMapping.status === "MAPPED" || labelMapping.status === "AMBIGUOUS") return { path: "once", reason: "ambiguous" };
  const blocker = genericSaveBlocker({
    label: pause.label,
    fieldId: pause.fieldId,
    fieldKind: pause.fieldKind,
    companyName: input.companyName,
    hasDraft: pause.draft !== null,
    answer: input.answer ?? null
  });
  if (blocker) return { path: "once", reason: blocker };
  return { path: "question", questionKey: normalizeQuestionText(pause.label) };
}

/** The answer as the field takes it: an offered option's exact text for a select or radio, Yes/No for a single checkbox. */
export function answerForPause(pause: PauseRecord, answer: string): { value: string; offered: boolean } {
  if (answer.trim() === "") throw new Error("The answer is empty.");
  if ((pause.fieldKind === "select" || pause.fieldKind === "radio") && pause.options?.length) {
    const option = matchOfferedOption(pause.options, answer);
    if (!option) {
      throw new Error("That answer is not one of the offered options for this question; pnpm run:questions lists them.");
    }
    return { value: option, offered: true };
  }
  if (pause.fieldKind === "checkbox" && !pause.options?.length) {
    const box = checkboxAnswer(answer);
    if (!box) throw new Error("Answer yes or no for a checkbox.");
    return { value: box, offered: true };
  }
  return { value: answer, offered: false };
}

/** The saved question-memory answer for this field, unless the field names the company or meets a never-reuse rule. */
export function rememberedAnswerFor(
  database: DatabaseSync,
  candidateId: string,
  field: BrowserField,
  companyName: string | null | undefined
): SavedQuestionAnswer | null {
  if (questionReuseBlocked(field, companyName)) return null;
  return getCurrentQuestionAnswer(database, candidateId, field.label);
}

/**
 * The fill decision for a pause the candidate answered, or null when the
 * answer does not fit the field (the pause then reopens): a type-ahead chooses
 * the offered option or types the answer into its suggestion list; a list,
 * radio set, or checkbox group chooses one exactly matching offered option and
 * is never typed into; a single checkbox is checked by a yes and left
 * unchecked by a no; a number box takes only a number; an upload is never
 * answered here; any other field is filled with the answer.
 */
export function answeredPauseDecision(field: BrowserField, answer: string, basis: FillDecision["basis"]): FillDecision | null {
  const reason = "The candidate answered this pause during review.";
  const trimmed = answer.trim();
  if (trimmed === "") return null;
  const choose = (value: string): FillDecision => ({ fieldId: field.id, action: "choose", value, basis, reason, pause: null });
  if (field.widget === "autocomplete") {
    const option = field.options?.length ? matchOfferedOption(field.options, answer) : null;
    return choose(option ?? trimmed);
  }
  if (field.kind === "checkbox" && (field.options?.length ?? 0) >= 2) {
    const option = matchOfferedOption(field.options!, answer);
    return option ? choose(option) : null;
  }
  if (field.kind === "select" || field.kind === "radio") {
    if (!field.options?.length) return null;
    const option = matchOfferedOption(field.options, answer);
    return option ? choose(option) : null;
  }
  if (field.kind === "checkbox") {
    const box = checkboxAnswer(answer);
    if (box === "Yes") return { fieldId: field.id, action: "check", value: "true", basis, reason, pause: null };
    if (box === "No") {
      return {
        fieldId: field.id,
        action: "skip",
        value: null,
        basis: null,
        reason: "The candidate answered no; the box stays unchecked.",
        pause: null
      };
    }
    return null;
  }
  if (field.kind === "number" && !/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  if (field.kind === "file") return null;
  return { fieldId: field.id, action: "fill", value: answer, basis, reason, pause: null };
}

/** The application timeline's line for an answered pause; never includes the answer. */
export function pauseAnswerEventDetail(label: string, outcome: PauseAnswerOutcome, factLabel?: string): string {
  const shown = label.replace(/\s+/g, " ").trim().slice(0, 150);
  let detail: string;
  if (outcome.saved && outcome.store === "fact") {
    detail = `Answer to "${shown}" saved for reuse as ${(factLabel ?? outcome.factKey).toLocaleLowerCase("en-US")}.`;
  } else if (outcome.saved) {
    detail = `Answer to "${shown}" saved for reuse.`;
  } else {
    detail = `Answer to "${shown}" used for this run only: ${outcome.detail.replace(/[.\s]+$/, "")}.`;
  }
  return detail.slice(0, 1000);
}
