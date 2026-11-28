import { z } from "zod";

import { browserFieldKindSchema, type BrowserFieldKind } from "./browser";
import { scopeKey } from "./candidate-facts";
import { mentionsCompany } from "./company-name";
import { isInternshipTermQuestion } from "./term-availability";
import { isDraftableQuestion } from "./voice";

/**
 * Question memory: the candidate's own answers to application questions the
 * fact catalog does not map ("Do you have experience with Python?"). It holds
 * only candidate-supplied answers, keyed by the normalized question text and
 * matched exactly, never fuzzily or by similarity. It is never sent to a model
 * and never feeds the AI fit or voice drafting. Company-specific, why/interest,
 * protected, attestation, sensitive, essay, and upload questions are never
 * saved; those answers are used for one run only.
 */

/** Free-text answers longer than this are essays: never saved. */
export const GENERIC_ANSWER_MAX_LENGTH = 200;

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lower-case ASCII words: NFKD with accents removed, `+` and `#` spelled out
 * (so "C++" and "C#" never collide with "C"), other punctuation removed, and
 * whitespace collapsed. Exact identity, never fuzzy; idempotent.
 */
export function normalizeAnswerText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLocaleLowerCase("en-US")
    .replace(/\+/g, " plus ")
    .replace(/#/g, " sharp ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const TRAILING_MARKER = /[\s*:\-–—]*(?:\*+|\((?:optional|required)\)|\brequired\b)[\s*:.\-–—]*$/i;

/** The question-memory key: like `normalizeAnswerText`, after dropping trailing "*", "(optional)", "(required)", or "required" markers. Idempotent. */
export function normalizeQuestionText(text: string): string {
  let current = text.normalize("NFKD").replace(COMBINING_MARKS, "");
  for (;;) {
    const next = current.replace(TRAILING_MARKER, "");
    if (next === current) break;
    current = next;
  }
  return normalizeAnswerText(current);
}

/** The one offered option whose normalized text equals the answer's; null when none or several match. */
export function matchOfferedOption(options: readonly string[], answer: string): string | null {
  const key = normalizeAnswerText(answer);
  if (key === "") return null;
  const matches = options.filter((option) => normalizeAnswerText(option) === key);
  return matches.length === 1 ? matches[0]! : null;
}

const CHECKBOX_YES = new Set(["yes", "y", "true", "checked", "agree", "i agree"]);
const CHECKBOX_NO = new Set(["no", "n", "false", "unchecked"]);

/** A single checkbox's answer: "Yes" checks it, "No" leaves it unchecked, anything else is not an answer. */
export function checkboxAnswer(text: string): "Yes" | "No" | null {
  const key = normalizeAnswerText(text);
  if (CHECKBOX_YES.has(key)) return "Yes";
  if (CHECKBOX_NO.has(key)) return "No";
  return null;
}

export const questionAnswerKindSchema = z.enum(["text", "option"]);
export type QuestionAnswerKind = z.infer<typeof questionAnswerKindSchema>;

/** Select, radio, and checkbox answers are stored as the chosen option; everything else as text. */
export function answerKindFor(kind: BrowserFieldKind | undefined): QuestionAnswerKind {
  return kind === "select" || kind === "radio" || kind === "checkbox" ? "option" : "text";
}

export const questionAnswerNotSavedReasonSchema = z.enum([
  "not_requested",
  "sensitive",
  "blocked_protected",
  "blocked_attestation",
  "ambiguous",
  "fact_rule",
  "not_a_fact_value",
  "company_named",
  "company_specific",
  "why_interest",
  "consent",
  "essay",
  "contact",
  "workday_error",
  "not_reusable",
  "upload",
  "safeguard",
  "confirmation",
  "coursework"
]);
export type QuestionAnswerNotSavedReason = z.infer<typeof questionAnswerNotSavedReasonSchema>;

const NOT_SAVED_REASON_TEXT: Record<QuestionAnswerNotSavedReason, string> = {
  not_requested: "you asked to use it for this run only",
  sensitive: "sensitive questions are never saved",
  blocked_protected: "protected demographic questions are never saved",
  blocked_attestation: "attestations are answered each time",
  ambiguous: "it matches a saved-fact question that needs a country, place, or company the question does not give",
  fact_rule: "the saved-fact rules keep it for this run only",
  not_a_fact_value: "the chosen option is not a value the matching saved fact can hold",
  company_named: "it names the company",
  company_specific: "it is about this employer or role",
  why_interest: "why, interest, and motivation questions are answered for each application",
  consent: "acknowledgements and consents are answered each time",
  essay: "open-ended or long answers are written for each application",
  contact: "contact details come from your profile",
  workday_error: "it is a Workday error report, not a question",
  not_reusable: "the question or answer has no words to match on",
  upload: "it needs a document",
  safeguard: "it is a safeguard challenge",
  confirmation: "it confirms the attached resume for this run",
  coursework: "coursework answers come only from your saved courses (pnpm profile:coursework)"
};

/** Why an answer was used for one run only, in plain words; never includes the answer. */
export function notSavedReasonText(reason: QuestionAnswerNotSavedReason): string {
  return NOT_SAVED_REASON_TEXT[reason];
}

const WHY_INTEREST = /\bwhy\b|\binterest(?:s|ed|ing)?\b|\bmotivat\w*|\bexcit\w*|\bpassion\w*|\bwhat\s+(?:draws|attracts|brings)\s+you\b|\bappeal\w*/i;
const EMPLOYER_REFERENCE = /\b(?:here|for us|with us|join us|our\s+(?:company|team|organization|organisation|firm|mission|products?|culture|values)|this\s+(?:company|organization|organisation|firm|employer|team|role|position|job|internship|opportunity)|the\s+(?:company|organization|organisation|firm|employer))\b/i;
const COMPANY_SPECIFIC = /\b(?:salary|compensation|pay\s+(?:expectations?|range|requirements?)|desired\s+pay|expected\s+pay|referr\w*|referred)\b/i;
const CONSENT = /\b(?:agree\w*|acknowledg\w*|consent\w*|terms(?:\s+(?:and|&)\s+conditions)?|privacy\s+(?:policy|notice|statement)|certif\w*|attest\w*|signature|e-?sign\w*|i\s+understand)\b/i;
const SENSITIVE = /\b(?:social\s+security|ssn|national\s+(?:insurance|id(?:entity)?)|passport|driver'?s?\s+licen[cs]e|date\s+of\s+birth|birth\s*date|birthday|criminal|convict\w*|felon\w*|misdemeanou?rs?|arrest\w*|background\s+check|medical|health|accommodat\w*|religio\w*|marital|pregnan\w*|citizen\w*|immigration|visa\s+status|password|bank|credit\s+card|gender|sex|sexual|race|racial|ethnic\w*|hispanic|latin[oaxe]|lgbt\w*|veterans?|disabilit\w*|disabled|orientation|transgender|pronouns?)\b/i;
const CONTACT = /\b(?:e-?mail|phone|mobile|telephone|cell)\b/i;
const COURSEWORK_TOPIC = /\bcourse\s*work\b|\bcourses?\b|\bclasses\b/i;

export type QuestionRuleInput = {
  label: string;
  fieldId: string;
  fieldKind?: BrowserFieldKind;
  companyName?: string | null;
  sensitive?: boolean;
  upload?: boolean;
  safeguard?: boolean;
};

/**
 * A pause made from Workday's own error report: the single "(Workday errors)"
 * pause, a per-field `workday-error::<field>` pause, or an unattributed
 * `workday-error-<n>` one. Their labels carry Workday's error text, so their
 * answers never go to generic question memory.
 */
export function isWorkdayErrorPauseId(fieldId: string): boolean {
  return /::workday-errors$|::workday-error::|::workday-error-\d+$/.test(fieldId);
}

/** Why a question is never saved to, or reused from, question memory; null when it may be. First rule wins. */
export function questionSaveBlocker(input: QuestionRuleInput): QuestionAnswerNotSavedReason | null {
  const { label } = input;
  if (isWorkdayErrorPauseId(input.fieldId)) return "workday_error";
  if (input.safeguard) return "safeguard";
  if (input.upload || input.fieldKind === "file") return "upload";
  if (input.sensitive || SENSITIVE.test(label)) return "sensitive";
  if (COURSEWORK_TOPIC.test(label)) return "coursework";
  if (input.fieldKind === "email" || input.fieldKind === "tel" || CONTACT.test(label)) return "contact";
  if (input.companyName && mentionsCompany(label, input.companyName)) return "company_named";
  // (Track 89) A term question ("Which term are you interested in?") is not a why-interest question; its answer may be remembered for the same wording.
  if (WHY_INTEREST.test(label) && !isInternshipTermQuestion(label)) return "why_interest";
  if (EMPLOYER_REFERENCE.test(label) || COMPANY_SPECIFIC.test(label)) return "company_specific";
  if (CONSENT.test(label)) return "consent";
  if (input.fieldKind === "textarea" || isDraftableQuestion({ label, kind: input.fieldKind ?? "text" })) return "essay";
  if (label.length > 300 || normalizeQuestionText(label) === "") return "not_reusable";
  return null;
}

/** `questionSaveBlocker`, plus the answer's own rules: voice-draft pauses and long answers are essays, an answer needs words. */
export function genericSaveBlocker(
  input: QuestionRuleInput & { hasDraft?: boolean; answer?: string | null }
): QuestionAnswerNotSavedReason | null {
  const question = questionSaveBlocker(input);
  if (question) return question;
  if (input.hasDraft) return "essay";
  if (input.answer !== undefined && input.answer !== null) {
    if (input.answer.trim().length > GENERIC_ANSWER_MAX_LENGTH) return "essay";
    if (normalizeAnswerText(input.answer) === "") return "not_reusable";
  }
  return null;
}

/** True when a saved answer must never be reused for this field (it names the company or meets a never-save rule). */
export function questionReuseBlocked(
  field: { id: string; label: string; kind: BrowserFieldKind },
  companyName: string | null | undefined
): boolean {
  return questionSaveBlocker({ label: field.label, fieldId: field.id, fieldKind: field.kind, companyName }) !== null;
}

export const savedQuestionAnswerSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  questionKey: z.string().min(1).max(1000),
  question: z.string().min(1).max(300),
  answerKind: questionAnswerKindSchema,
  answer: z.string().min(1).max(GENERIC_ANSWER_MAX_LENGTH),
  answerKey: z.string().min(1).max(1000),
  sourceRunId: z.string().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable(),
  supersededById: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable()
});

export type SavedQuestionAnswer = z.infer<typeof savedQuestionAnswerSchema>;

/**
 * Recorded question wordings (migration 0036): each exact wording a stop
 * asked, recorded against the saved answer it matched (a candidate fact by key
 * and scope key, or a question-memory answer by its question key). An alias
 * stores no answer value and never widens a fact's scope.
 */
export const questionAliasSourceSchema = z.enum(["candidate_answer", "saved_answer_match", "ai_review"]);
export type QuestionAliasSource = z.infer<typeof questionAliasSourceSchema>;

export const questionAliasTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fact"), factKey: z.string().min(1).max(80), scopeKey: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("question"), questionKey: z.string().min(1).max(1000) })
]);
export type QuestionAliasTarget = z.infer<typeof questionAliasTargetSchema>;

export const questionAliasSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  wording: z.string().min(1).max(300),
  wordingKey: z.string().min(1).max(1000),
  target: questionAliasTargetSchema,
  atsKind: z.string().min(1).max(40),
  fieldKind: browserFieldKindSchema.nullable().optional(),
  options: z.array(z.string().max(200)).max(500),
  source: questionAliasSourceSchema,
  sourceRunId: z.string().min(1).max(200).nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  seenCount: z.number().int().min(1),
  revokedAt: z.iso.datetime().nullable()
});
export type QuestionAlias = z.infer<typeof questionAliasSchema>;

/** The start of the decision reason of an answer the AI review matched to a saved answer (aiReviewMatchReason). */
export const AI_REVIEW_MATCH_PREFIX = "AI review matched ";
const AI_REVIEW_MATCH_SUFFIX = " to your saved answer.";

/**
 * The decision reason of an answer the AI review matched to a saved answer,
 * naming the question by its label (whitespace collapsed, clipped to 150
 * characters) so the auto-submit approval can name it. Such a match passed
 * every deterministic guardrail, so it does not hold the run (the candidate's
 * decision, 2026-11-26).
 */
export function aiReviewMatchReason(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim().replaceAll('"', "'");
  const clipped = flat.length > 150 ? `${flat.slice(0, 149)}…` : flat;
  return `${AI_REVIEW_MATCH_PREFIX}"${clipped}"${AI_REVIEW_MATCH_SUFFIX}`.slice(0, 500);
}

/** Whether a decision reason marks an answer the AI review matched to a saved answer. */
export function isAiReviewMatchReason(reason: string | undefined | null): boolean {
  return aiReviewMatchLabel(reason) !== null;
}

/** The question label an AI-review match reason names, or null when the reason is not one. */
export function aiReviewMatchLabel(reason: string | undefined | null): string | null {
  if (!reason || !reason.startsWith(AI_REVIEW_MATCH_PREFIX) || !reason.endsWith(AI_REVIEW_MATCH_SUFFIX)) return null;
  const quoted = reason.slice(AI_REVIEW_MATCH_PREFIX.length, reason.length - AI_REVIEW_MATCH_SUFFIX.length);
  return quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"') ? quoted.slice(1, -1) : null;
}

/**
 * Whether a fact alias's scope applies to this question: a global fact always;
 * a country fact only on a posting in that country; a company fact only for
 * that company. Location and channel scopes never travel through an alias.
 */
export function aliasScopeAllowed(
  key: string,
  context: { companyName?: string | null; postingCountryCode?: string; countryCode?: string }
): boolean {
  if (key === "global") return true;
  if (key.startsWith("country:")) {
    const country = (context.postingCountryCode ?? context.countryCode)?.toUpperCase();
    return country !== undefined && `country:${country}` === key;
  }
  if (key.startsWith("company:")) {
    const name = context.companyName?.trim();
    if (!name) return false;
    try {
      return scopeKey({ kind: "company", name }) === key;
    } catch {
      return false;
    }
  }
  return false;
}
