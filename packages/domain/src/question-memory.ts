import { z } from "zod";

import { applicationChannelSchema, candidateFactKeySchema, candidateFactSchema, factScopeSchema } from "./candidate-facts";

export const questionContextSchema = z.object({
  countryCode: z.string().trim().min(2).max(3).transform((value) => value.toUpperCase()).optional(),
  location: z.string().trim().min(2).max(120).optional(),
  /** Set only when the question comes from a channel-specific application. */
  applicationChannel: applicationChannelSchema.optional(),
  /** The posting's employer, for company-scoped answers. */
  companyName: z.string().trim().min(1).max(200).optional(),
  /** The posting's one stated country; used only by relocation questions. */
  postingCountryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional()
});

export const mappedQuestionSchema = z.object({
  status: z.literal("MAPPED"),
  key: candidateFactKeySchema,
  scope: factScopeSchema,
  confidence: z.number().min(0).max(1),
  method: z.enum(["deterministic", "classifier"]),
  explanation: z.string()
});

export const questionMappingSchema = z.discriminatedUnion("status", [
  mappedQuestionSchema,
  z.object({ status: z.literal("AMBIGUOUS"), reason: z.string() }),
  z.object({ status: z.literal("UNMAPPED"), reason: z.string() }),
  z.object({
    status: z.literal("BLOCKED"),
    reason: z.string(),
    policy: z.enum(["protected", "attestation"])
  })
]);

export const questionResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("RESOLVED"),
    question: z.string(),
    mapping: mappedQuestionSchema,
    fact: candidateFactSchema,
    displayAnswer: z.string()
  }),
  z.object({
    status: z.literal("NEEDS_INPUT"),
    question: z.string(),
    mapping: mappedQuestionSchema,
    reason: z.string()
  }),
  z.object({
    status: z.literal("ANSWERED_ONCE"),
    question: z.string(),
    mapping: mappedQuestionSchema,
    displayAnswer: z.string(),
    reason: z.string()
  }),
  z.object({ status: z.literal("AMBIGUOUS"), question: z.string(), reason: z.string() }),
  z.object({ status: z.literal("UNMAPPED"), question: z.string(), reason: z.string() }),
  z.object({
    status: z.literal("REQUIRES_CONFIRMATION"),
    question: z.string(),
    reason: z.string(),
    policy: z.enum(["protected", "attestation", "fact_policy"]),
    fact: candidateFactSchema.optional()
  })
]);

export const rememberAnswerInputSchema = z.object({
  question: z.string().trim().min(3).max(1_000),
  answer: z.string().trim().min(1).max(500),
  remember: z.boolean(),
  context: questionContextSchema
});

export type QuestionContext = z.infer<typeof questionContextSchema>;
export type MappedQuestion = z.infer<typeof mappedQuestionSchema>;
export type QuestionMapping = z.infer<typeof questionMappingSchema>;
export type QuestionResolution = z.infer<typeof questionResolutionSchema>;
export type RememberAnswerInput = z.infer<typeof rememberAnswerInputSchema>;
