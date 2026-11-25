import { z } from "zod";

import type { CandidateFactKey } from "./candidate-facts";

/**
 * Milestone 4 keeps three states distinct: a STATED value the posting asserts,
 * an INFERRED reading (which can never fail eligibility), and an absent value
 * (the posting is silent, which is never converted into a decision).
 */
export const eligibilityOutcomeSchema = z.enum(["PASS", "FAIL", "UNKNOWN"]);

export const eligibilityFindingSchema = z.object({
  /** Constraint kind (`graduation`, `authorization`, ...) or requirement subject. */
  subject: z.string().min(1).max(40),
  requirementId: z.string().uuid().nullable(),
  outcome: eligibilityOutcomeSchema,
  /** Human-readable explanation. Quotes posting text; never invents facts. */
  reason: z.string().min(1).max(500),
  /** Exact posting excerpt behind a FAIL, when one exists. */
  statedExcerpt: z.string().max(600).nullable()
});

export const matchVerdictSchema = z.enum(["QUALIFIED", "NOT_QUALIFIED", "NEEDS_REVIEW"]);

export const fitReasonSchema = z.object({
  factor: z.string().min(1).max(80),
  /** Signed score contribution, so the dashboard can show why, not just a number. */
  delta: z.number().int(),
  detail: z.string().min(1).max(500)
});

export const jobMatchReportSchema = z.object({
  jobId: z.string().uuid(),
  verdict: matchVerdictSchema,
  eligible: z.boolean(),
  fitScore: z.number().int().min(0).max(100),
  findings: z.array(eligibilityFindingSchema),
  reasons: z.array(fitReasonSchema),
  evaluatedAt: z.iso.datetime(),
  scoringVersion: z.number().int().default(1)
});

export type EligibilityOutcome = z.infer<typeof eligibilityOutcomeSchema>;
export type EligibilityFinding = z.infer<typeof eligibilityFindingSchema>;
export type MatchVerdict = z.infer<typeof matchVerdictSchema>;
export type FitReason = z.infer<typeof fitReasonSchema>;
export type JobMatchReport = z.infer<typeof jobMatchReportSchema>;


export const fitCitationSchema = z.object({ evidenceId: z.string().min(1), quote: z.string().min(1).max(2000) }).strict();
export const semanticFitDecisionSchema = z.object({
  requirementId: z.string().uuid(), postingQuote: z.string().min(1).max(2000),
  assessment: z.enum(["SUPPORTED", "PARTIAL", "MISSING", "UNKNOWN"]),
  citations: z.array(fitCitationSchema).max(8)
}).strict();
export const semanticFitResponseSchema = z.object({ decisions: z.array(semanticFitDecisionSchema).max(120) }).strict();
const legacySemanticFitAssessmentSchema = z.object({
  ...semanticFitResponseSchema.shape,
  score: z.number().int().min(0).max(100), model: z.string().min(1), evaluatedAt: z.iso.datetime(),
  unknownCount: z.number().int().nonnegative(), version: z.literal(1)
});
/** AI judges overall competitiveness; the score is not a hiring probability. */
const competitivenessPointSchema = z.object({
  text: z.string().min(1).max(1200),
  postingQuote: z.string().min(1).max(2000),
  citations: z.array(fitCitationSchema).max(8)
}).strict();
export const competitivenessResponseSchema = z.object({
  score: z.number().int().min(0).max(100),
  rating: z.enum(["STRONG", "MODERATE", "WEAK", "INSUFFICIENT_INFORMATION"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  summary: z.string().min(1).max(2000),
  strengths: z.array(competitivenessPointSchema).max(8),
  gaps: z.array(competitivenessPointSchema).max(8),
  unknowns: z.array(z.string().min(1).max(600)).min(1).max(12)
}).strict();
const competitivenessAssessmentSchema = competitivenessResponseSchema.extend({
  model: z.string().min(1), evaluatedAt: z.iso.datetime(), version: z.literal(2),
  decisions: z.array(semanticFitDecisionSchema).length(0), unknownCount: z.number().int().nonnegative()
});
export const semanticFitAssessmentSchema = z.discriminatedUnion("version", [
  legacySemanticFitAssessmentSchema, competitivenessAssessmentSchema
]);
export type CompetitivenessResponse = z.infer<typeof competitivenessResponseSchema>;
export type SemanticFitResponse = z.infer<typeof semanticFitResponseSchema>;
export type SemanticFitAssessment = z.infer<typeof semanticFitAssessmentSchema>;
export type FitEvidence = { id: string; text: string };

/**
 * The candidate facts the AI-fit prompt reads (packages/agent semantic-fit.ts).
 * Migration 0034's candidate_facts triggers bump the fit context version only
 * for these keys, so other saved answers leave fits current. A key the fit
 * starts reading goes here and, in a new migration, into those triggers.
 */
export const FIT_CONTEXT_FACT_KEYS = ["graduation_date"] as const satisfies readonly CandidateFactKey[];
export type FitContextFactKey = (typeof FIT_CONTEXT_FACT_KEYS)[number];
