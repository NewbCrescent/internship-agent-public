import type { DatabaseSync } from "node:sqlite";

import { findQuestionAliases, getCurrentFact, getCurrentQuestionAnswer, getJobPosting, logApplicationEvent } from "@internship-agent/db";
import { classifyFieldRole, isSensitiveRole, type FieldResolution } from "@internship-agent/browser";
import {
  aiReviewMatchReason,
  aliasScopeAllowed,
  candidateFactKeySchema,
  classifyStandingStatement,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  formatFactValue,
  isWorkdayErrorPauseId,
  questionReuseBlocked,
  STANDARD_ANSWER_KEYS,
  textMessageTopic,
  type BrowserField,
  type CandidateFactKey,
  type FactScope,
  type FillDecision,
  type PauseRecord,
  type QuestionAliasSource,
  type QuestionAliasTarget,
  type QuestionContext
} from "@internship-agent/domain";

import { classifyOpenPauses } from "./application-holds";

/**
 * The stop re-check's pure helpers (Track 45): which stops it may look at,
 * how a recorded wording (packages/db/src/question-alias-repository.ts)
 * resolves to a saved answer, how a match is named (a saved answer, or a
 * profile field the planner answered from; Track 57), and the timeline line.
 * Deterministic; no model is called, and no answer value is ever logged.
 * This file imports nothing from browser-orchestrator.ts, which imports it.
 */

export type SavedMatchKind =
  | "saved_fact"
  | "standard_answer"
  | "question_memory_exact"
  | "question_memory_normalized"
  | "alias_exact"
  | "alias_normalized"
  | "profile_field"
  | "self_identification";

export const SAVED_MATCH_KINDS: readonly SavedMatchKind[] = [
  "saved_fact",
  "standard_answer",
  "question_memory_exact",
  "question_memory_normalized",
  "alias_exact",
  "alias_normalized",
  "profile_field",
  "self_identification"
];

export type AliasHit = {
  fieldId: string;
  label: string;
  aliasId: string;
  source: QuestionAliasSource;
  matchedBy: "exact" | "normalized";
  target: QuestionAliasTarget;
};

function factScopeFor(key: string, context: QuestionContext): FactScope | null {
  if (key === "global") return { kind: "global" };
  if (key.startsWith("country:")) return { kind: "country", code: key.slice("country:".length) };
  if (key.startsWith("company:") && context.companyName) return { kind: "company", name: context.companyName };
  return null;
}

/**
 * A saved answer reached through a recorded wording of this field's question,
 * or null. Never for a question that names the company or meets a never-reuse
 * rule; a fact alias only for a reusable, non-protected catalog fact whose
 * scope applies to this posting (global, its one country, or its company), and
 * a sensitive fact only when the candidate saved it. The first alias that
 * resolves wins (exact wording first).
 */
export function aliasResolutionFor(
  database: DatabaseSync,
  candidateId: string,
  field: BrowserField,
  context: QuestionContext
): { resolution: FieldResolution; hit: AliasHit } | null {
  if (questionReuseBlocked(field, context.companyName)) return null;
  for (const alias of findQuestionAliases(database, candidateId, field.label)) {
    const hit: AliasHit = {
      fieldId: field.id, label: field.label, aliasId: alias.id, source: alias.source, matchedBy: alias.matchedBy, target: alias.target
    };
    if (alias.target.kind === "question") {
      const saved = getCurrentQuestionAnswer(database, candidateId, alias.target.questionKey);
      if (!saved) continue;
      return {
        resolution: { status: "REMEMBERED_ANSWER", answerId: saved.id, answer: saved.answer, answerKey: saved.answerKey, answerKind: saved.answerKind },
        hit
      };
    }
    const parsedKey = candidateFactKeySchema.safeParse(alias.target.factKey);
    if (!parsedKey.success) continue;
    const key: CandidateFactKey = parsedKey.data;
    const definition = factDefinitions[key];
    if (definition.sensitivity === "protected" || key === COURSEWORK_FACT_KEY || STANDARD_ANSWER_KEYS.has(key)) continue;
    if (!aliasScopeAllowed(alias.target.scopeKey, context)) continue;
    const scope = factScopeFor(alias.target.scopeKey, context);
    if (!scope) continue;
    const fact = getCurrentFact(database, candidateId, key, scope);
    if (!fact || fact.reusePolicy !== "auto") continue;
    if (definition.sensitivity === "sensitive" && fact.source !== "user") continue;
    return {
      resolution: { status: "RESOLVED", key, scope: alias.target.scopeKey, display: formatFactValue(fact.value), value: fact.value },
      hit
    };
  }
  return null;
}

/** The field id of Handshake's attached-resume confirmation (ATTACHED_RESUME_FIELD in browser-orchestrator.ts; importing it here would make a cycle). */
const ATTACHED_RESUME_FIELD_ID = "handshake-attached-resume";

/**
 * Whether the stop re-check may look at this pause: an open question pause
 * with a recorded field kind; never a safeguard, upload, sensitive pause (see
 * selfIdentificationStopEligible), the attached-resume confirmation, the
 * security-code step, a Workday error report, a fault, or a page failure
 * ("The agent could not fill …").
 */
export function stopEligible(pause: PauseRecord): boolean {
  return !pause.sensitive && questionStop(pause);
}

/**
 * (Track 91) Whether the stop re-check may settle this sensitive pause through
 * the saved voluntary self-identification answers alone (the planner's
 * deterministic self-identification path, never the AI review or question
 * memory): a sensitive open question pause with a recorded field kind, on the
 * same terms as stopEligible otherwise.
 */
export function selfIdentificationStopEligible(pause: PauseRecord): boolean {
  return pause.sensitive && questionStop(pause);
}

function questionStop(pause: PauseRecord): boolean {
  if (pause.status !== "open" || pause.safeguard || pause.upload || !pause.fieldKind) return false;
  if (pause.fieldId === ATTACHED_RESUME_FIELD_ID || pause.fieldId === "site-security-code" || isWorkdayErrorPauseId(pause.fieldId)) return false;
  if (classifyOpenPauses([pause])[0]?.kind !== "question") return false;
  return !pause.question.startsWith("The agent could not fill");
}

/**
 * Whether the AI review of a pause batch may look at this pause: one the
 * re-check may look at, on a field that is not a demographic one, a contact or
 * upload field, a consent or attestation statement, or a text-message consent.
 */
export function pauseReviewEligible(pause: PauseRecord, field: BrowserField): boolean {
  if (!stopEligible(pause)) return false;
  if (isSensitiveRole(classifyFieldRole(field))) return false;
  if (["file", "email", "tel", "unknown"].includes(field.kind)) return false;
  if (classifyStandingStatement(field.label).groups.length > 0) return false;
  return textMessageTopic(field.label, field.options ?? []) === null;
}

/** How a planned decision found its saved answer; null when it did not come from one. */
export function matchKindFor(
  decision: FillDecision,
  hit: AliasHit | undefined,
  savedQuestion: string | null,
  label: string
): SavedMatchKind | null {
  if (decision.basis?.kind === "profile") return "profile_field";
  if (hit) return hit.matchedBy === "exact" ? "alias_exact" : "alias_normalized";
  if (decision.basis?.kind === "fact") {
    const parsed = candidateFactKeySchema.safeParse(decision.basis.key);
    return parsed.success && STANDARD_ANSWER_KEYS.has(parsed.data) ? "standard_answer" : "saved_fact";
  }
  if (decision.basis?.kind === "question_answer") return savedQuestion === label ? "question_memory_exact" : "question_memory_normalized";
  return null;
}

const KIND_TEXT: Record<SavedMatchKind, string> = {
  saved_fact: "the question mapper's key",
  standard_answer: "a standard answer",
  question_memory_exact: "same wording",
  question_memory_normalized: "same wording after normalization",
  alias_exact: "a recorded wording",
  alias_normalized: "a recorded wording",
  profile_field: "your profile",
  self_identification: "your saved voluntary self-identification answers"
};

/** How the timeline names a profile field a stop was answered from; never its value. */
const PROFILE_FIELD_TEXT: Record<string, string> = {
  fullName: "name",
  preferredName: "preferred name",
  email: "email address",
  phone: "phone number",
  linkedinUrl: "LinkedIn link",
  githubUrl: "GitHub link",
  portfolioUrl: "portfolio link",
  legalFirstName: "legal first name",
  legalLastName: "legal last name",
  addressLine1: "address",
  addressLine2: "address line 2",
  addressCity: "city",
  addressRegion: "state or region",
  addressPostalCode: "postal code",
  addressCountry: "country",
  currentLocation: "city and state",
  phoneType: "phone type",
  fieldOfStudy: "field of study",
  gpa: "GPA",
  school: "school",
  degree: "degree",
  educationStartMonth: "education start month",
  graduationDate: "graduation date",
  education: "schools"
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Names the saved answer without its value: a fact by its label and scope, question memory by its id and saved question, a profile field by its name. */
export function savedAnswerTargetText(
  target: { kind: "fact"; key: string; scope: string } | { kind: "question"; answerId: string; question: string } | { kind: "profile"; field: string }
): string {
  if (target.kind === "profile") {
    const name = PROFILE_FIELD_TEXT[target.field]
      ?? target.field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\./g, " ").toLocaleLowerCase("en-US");
    return `your profile's ${name}`;
  }
  if (target.kind === "fact") {
    const parsed = candidateFactKeySchema.safeParse(target.key);
    const label = parsed.success ? factDefinitions[parsed.data].label : target.key;
    return `your saved ${label.toLocaleLowerCase("en-US")} (${target.scope})`;
  }
  return `saved answer ${target.answerId.slice(0, 8)} "${clip(target.question, 120)}"`;
}

/** The timeline line for a stop the re-check answered from a saved answer; never the answer. */
export function savedAnswerEventDetail(label: string, kind: SavedMatchKind, targetText: string): string {
  return `Answer to "${clip(label, 150)}" found in your saved answers (${KIND_TEXT[kind]}): ${targetText}; it no longer waits for you.`.slice(0, 1000);
}

/** How a sensitive stop is settled from the saved answers alone (Track 91). */
export type SensitiveSettlement = "self_identification" | "pronouns";

/**
 * (Track 91) How today's plan of a sensitive stop settles it from the saved
 * answers alone, or null. On a field whose role is sensitive, only the
 * planner's deterministic self-identification path counts: a SELF_IDENTIFIED
 * resolution chosen or checked from its own saved key (and, where the page
 * itself was read, `allowSkip`, a classification it leaves empty). On a stop
 * recorded as sensitive whose field is no longer sensitive, only the saved
 * pronouns answer counts (Track 82 made pronoun questions the pronouns
 * answer's), never through a recorded wording.
 */
export function sensitiveStopSettlement(
  sensitiveRole: boolean,
  resolution: FieldResolution | undefined,
  decision: FillDecision | undefined,
  options: { allowSkip: boolean; aliasHit: boolean }
): SensitiveSettlement | null {
  if (!decision) return null;
  if (sensitiveRole) {
    if (resolution?.status !== "SELF_IDENTIFIED") return null;
    if (decision.action === "skip") return options.allowSkip ? "self_identification" : null;
    return (decision.action === "choose" || decision.action === "check") && decision.basis?.kind === "fact" && decision.basis.key === resolution.key
      ? "self_identification" : null;
  }
  if (options.aliasHit || resolution?.status !== "RESOLVED" || resolution.key !== "pronouns") return null;
  return (decision.action === "fill" || decision.action === "choose" || decision.action === "check")
    && decision.basis?.kind === "fact" && decision.basis.key === "pronouns" ? "pronouns" : null;
}

/** (Track 91) The timeline line for a sensitive stop the saved answers settle; it never names the answer. */
export function selfIdentificationEventDetail(label: string, settlement: SensitiveSettlement): string {
  const source = settlement === "pronouns" ? "your saved pronouns answer" : "your saved voluntary self-identification answer";
  return `Answer to "${clip(label, 150)}" settled by ${source}; it no longer waits for you.`.slice(0, 1000);
}

/** The timeline line for a field a recorded wording answered; never the answer. */
export function aliasHitEventDetail(label: string): string {
  return `Used a recorded wording of your saved answer for "${clip(label, 150)}".`.slice(0, 1000);
}

/**
 * The alias hits whose field now has an answer (its decision is not a pause),
 * with each AI-review hit's decision marked with aiReviewMatchReason (naming
 * the question's label) so the auto-submit approval names it. `within`, when
 * given, limits it to those field ids (continue: the fields that were paused).
 */
export function settleAliasHits(
  decisions: FillDecision[],
  hits: readonly AliasHit[],
  within?: ReadonlySet<string>
): { decisions: FillDecision[]; used: AliasHit[] } {
  const used = hits.filter((hit) => {
    if (within && !within.has(hit.fieldId)) return false;
    const decision = decisions.find((entry) => entry.fieldId === hit.fieldId);
    return decision !== undefined && decision.action !== "pause";
  });
  const marked = new Map(used.filter((hit) => hit.source === "ai_review").map((hit) => [hit.fieldId, hit.label]));
  return {
    decisions: marked.size === 0 ? decisions : decisions.map((decision) => {
      const label = marked.get(decision.fieldId);
      return label !== undefined && decision.action !== "skip" ? { ...decision, reason: aiReviewMatchReason(label) } : decision;
    }),
    used
  };
}

/** One timeline line per field a recorded wording answered; never the answer. */
export function logAliasHits(database: DatabaseSync, jobId: string, hits: readonly AliasHit[]): void {
  if (hits.length === 0) return;
  const status = getJobPosting(database, jobId)?.status ?? "APPLYING";
  for (const hit of hits) {
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: aliasHitEventDetail(hit.label) });
  }
}
