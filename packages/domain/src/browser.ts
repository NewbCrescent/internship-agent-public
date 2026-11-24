import { z } from "zod";

import { atsKindSchema } from "./ats";

/**
 * Milestone 7 browser automation. Deterministic Playwright mechanics fill
 * what the candidate already knows; semantic ambiguity pauses for the
 * candidate; final submission needs a second explicit approval. The browser
 * never guesses, never bypasses safeguards, and never submits unapproved.
 */

export const browserFieldKindSchema = z.enum([
  "text",
  "number",
  "email",
  "tel",
  "url",
  "date",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "file",
  "unknown"
]);

export const browserFieldSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  kind: browserFieldKindSchema,
  required: z.boolean(),
  /** Real forms list every country or school; recognition trims beyond this. */
  options: z.array(z.string().min(1).max(200)).max(500).optional(),
  /** A value the site already shows (a Workday default, a saved draft), kept when nothing better is known. */
  currentValue: z.string().min(1).max(300).optional(),
  /** A type-ahead field (Lever's location box, Ashby's "Start typing..." input, an async react-select): the value is typed and a suggestion picked. */
  widget: z.enum(["autocomplete"]).optional()
});

export const recognizedFormSchema = z.object({
  url: z.string().min(1).max(2_000),
  title: z.string().max(300),
  fields: z.array(browserFieldSchema).max(120)
});

/**
 * `keep` leaves a value the site already shows (a resume Handshake pre-attached)
 * exactly as it is. `remove` records a history row the run deleted because it
 * is not one of the candidate's (Workday's My Experience).
 */
export const fillActionSchema = z.enum(["fill", "choose", "check", "upload", "keep", "pause", "skip", "remove"]);

/** The candidate's local three-detector voice-proxy gate result for one draft. */
export const voiceGateSummarySchema = z.object({
  passed: z.boolean(),
  averagePercentile: z.number(),
  targetAverage: z.number(),
  detectors: z.record(z.string(), z.object({ score: z.number(), percentile: z.number(), passed: z.boolean() })),
  /** Detector-informed revisions used (0 when the first draft passed). */
  revisions: z.number().int().min(0)
});

/**
 * A model draft in the candidate's voice. Generated text is never candidate
 * truth: it fills a field only after the voice gate passes, and is shown for
 * review before the submit approval.
 */
export const voiceDraftSchema = z.object({
  text: z.string().max(4_000),
  gate: voiceGateSummarySchema.nullable(),
  /** Why the draft did not fill the field (gate failure, unsupported claim, …). */
  reason: z.string().max(500).nullable()
});

export const decisionBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("voice_draft"), gate: voiceGateSummarySchema }),
  z.object({ kind: z.literal("fact"), key: z.string().min(1), scope: z.string().min(1) }),
  z.object({ kind: z.literal("package-answer"), prompt: z.string().min(1) }),
  z.object({ kind: z.literal("profile"), field: z.string().min(1) }),
  z.object({ kind: z.literal("resume_entry"), entryId: z.string().uuid() }),
  z.object({ kind: z.literal("variant"), variantId: z.string().uuid() }),
  z.object({ kind: z.literal("base_resume"), baseResumeId: z.string().uuid() }),
  z.object({ kind: z.literal("candidate_document"), documentId: z.string().uuid() }),
  z.object({ kind: z.literal("question_answer"), answerId: z.string().uuid() }),
  /**
   * Accepted or signed under the candidate's standing settings
   * (standing-consent.ts): `group` is a StandingGroup, "e-signature", or
   * "signature-date"; `statement` is the field label as read.
   */
  z.object({
    kind: z.literal("standing_consent"),
    setting: z.enum(["accept_data_consent", "sign_attestations", "both"]),
    group: z.string().min(1).max(40),
    statement: z.string().min(1).max(300)
  })
]);

export const pauseSuggestionSchema = z.object({
  question: z.string().min(1).max(500),
  key: z.string().min(1).max(80).nullable(),
  scope: z.string().min(1).max(160).nullable(),
  safeguard: z.boolean()
});

export const fillDecisionSchema = z.object({
  fieldId: z.string().min(1).max(200),
  action: fillActionSchema,
  value: z.string().max(4_000).nullable(),
  basis: decisionBasisSchema.nullable(),
  reason: z.string().min(1).max(500),
  pause: pauseSuggestionSchema.nullable()
});

export const pauseStatusSchema = z.enum(["open", "answered"]);

export const pauseRecordSchema = z.object({
  fieldId: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
  question: z.string().min(1).max(500),
  suggestedKey: z.string().min(1).max(80).nullable(),
  suggestedScope: z.string().min(1).max(160).nullable(),
  safeguard: z.boolean(),
  /** Sensitive pauses (EEO/demographic) are never filled from memory and never remembered. */
  sensitive: z.boolean(),
  /** File-upload pauses: the candidate attaches the document; text answers never fill them. */
  upload: z.boolean().default(false),
  status: pauseStatusSchema,
  answer: z.string().max(4_000).nullable(),
  /** The best voice draft when drafting could not fill the field; the candidate writes the answer. */
  draft: voiceDraftSchema.nullable().default(null),
  /** The field's kind and offered options when the pause was recorded; absent on older runs. */
  fieldKind: browserFieldKindSchema.optional(),
  options: z.array(z.string().min(1).max(200)).max(500).optional()
});

export const browserRunStatusSchema = z.enum([
  "started",
  "paused-needs-input",
  "awaiting-approval",
  "submitting",
  "submitted",
  "failed",
  "cancelled"
]);

/** The graduation profile a run used: the default answer, or the alternate profile a transcript form needs. */
export const applicationProfileSchema = z.enum(["default", "transcript"]);

export const browserRunSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  applicationUrl: z.url(),
  status: browserRunStatusSchema,
  packageId: z.string().uuid(),
  variantId: z.string().uuid().nullable(),
  /** Set when the run uploads a candidate-supplied base resume instead of the rendered variant. */
  baseResumeId: z.string().uuid().nullable().default(null),
  /** The graduation profile the run used (default, or the alternate transcript profile); absent on runs saved before migration 0029. */
  applicationProfile: applicationProfileSchema.nullable().optional(),
  atsKind: atsKindSchema,
  atsConfidence: z.number().min(0).max(1),
  suggestedAtsKind: atsKindSchema.nullable(),
  /** Explicit candidate confirmation (auto-classified or manually confirmed, including generic). */
  atsConfirmed: z.boolean(),
  decisions: z.array(fillDecisionSchema),
  pauses: z.array(pauseRecordSchema),
  submittedAnswers: z.record(z.string(), z.string()).nullable(),
  confirmationText: z.string().max(2_000).nullable(),
  submissionApprovedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export type BrowserFieldKind = z.infer<typeof browserFieldKindSchema>;
export type BrowserField = z.infer<typeof browserFieldSchema>;
export type RecognizedForm = z.infer<typeof recognizedFormSchema>;
export type FillAction = z.infer<typeof fillActionSchema>;
export type DecisionBasis = z.infer<typeof decisionBasisSchema>;
export type PauseSuggestion = z.infer<typeof pauseSuggestionSchema>;
export type FillDecision = z.infer<typeof fillDecisionSchema>;
export type PauseStatus = z.infer<typeof pauseStatusSchema>;
export type PauseRecord = z.infer<typeof pauseRecordSchema>;
export type BrowserRunStatus = z.infer<typeof browserRunStatusSchema>;
export type BrowserRun = z.infer<typeof browserRunSchema>;
export type ApplicationProfile = z.infer<typeof applicationProfileSchema>;
export type VoiceGateSummary = z.infer<typeof voiceGateSummarySchema>;
export type VoiceDraft = z.infer<typeof voiceDraftSchema>;
