import { z } from "zod";

import { resumeDocumentSchema } from "./resume-document";

/**
 * Milestone 5 application packages. The writer assembles only from explicit
 * candidate facts and ALLOWED + CURRENT evidence claims; the verifier then
 * independently re-checks every factual assertion before a package may reach
 * READY_FOR_REVIEW. Generated writing may be creative about presentation,
 * never about facts.
 */

export const claimBasisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("evidence"),
    /** Stable claim id the assertion leans on. */
    claimId: z.string().uuid()
  }),
  z.object({
    kind: z.literal("fact"),
    key: z.string().min(1).max(80),
    scope: z.string().min(1).max(160)
  }),
  /**
   * A quotation of the posting itself (role title, location, stated stack).
   * Verifiable against the current snapshot; a revised posting invalidates it.
   */
  z.object({
    kind: z.literal("posting"),
    excerpt: z.string().min(1).max(600)
  }),
  /**
   * Non-factual connective tissue ("I am excited to apply"). Carries no
   * truth value and needs no verification, but must never smuggle a fact.
   */
  z.object({ kind: z.literal("presentation") }),
  /**
   * A line from the candidate's own approved resume entry: a heading, a
   * bullet, or a skills line. Verified against the entry's current revision.
   */
  z.object({
    kind: z.literal("resume_entry"),
    entryId: z.string().uuid(),
    revisionId: z.string().uuid()
  })
]);

export const extractedClaimSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(500),
  basis: claimBasisSchema,
  /** Character offsets into the answer or bullet the claim was read from. */
  sourceField: z.string().min(1).max(80)
});

export const claimVerdictSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "CONTESTED"]);

export const claimCheckSchema = z.object({
  claimId: z.string().uuid(),
  verdict: claimVerdictSchema,
  reason: z.string().min(1).max(500)
});

export const tailoredAnswerSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(1).max(300),
  text: z.string().min(1).max(2_000),
  claimIds: z.array(z.string().uuid())
});

export const resumeBulletSchema = z.object({
  id: z.string().uuid(),
  text: z.string().min(1).max(500),
  claimIds: z.array(z.string().uuid())
});

export const applicationPackageSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  summary: z.string().min(1).max(1_000),
  answers: z.array(tailoredAnswerSchema).max(10),
  bullets: z.array(resumeBulletSchema).max(120),
  claims: z.array(extractedClaimSchema).max(240)
});

export const verificationReportSchema = z.object({
  packageId: z.string().uuid(),
  jobId: z.string().uuid(),
  verifiedAt: z.iso.datetime(),
  checks: z.array(claimCheckSchema),
  /** An unsupported factual claim blocks READY_FOR_REVIEW. */
  blocked: z.boolean()
});

export const resumeVariantSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  jobId: z.string().uuid().nullable(),
  label: z.string().min(1).max(120),
  bullets: z.array(resumeBulletSchema),
  /** Frozen structured resume; absent on variants made before structured entries. */
  document: resumeDocumentSchema.nullable().default(null),
  createdAt: z.iso.datetime()
});

export type ClaimBasis = z.infer<typeof claimBasisSchema>;
export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type ClaimVerdict = z.infer<typeof claimVerdictSchema>;
export type ClaimCheck = z.infer<typeof claimCheckSchema>;
export type TailoredAnswer = z.infer<typeof tailoredAnswerSchema>;
export type ResumeBullet = z.infer<typeof resumeBulletSchema>;
export type ApplicationPackage = z.infer<typeof applicationPackageSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
export type ResumeVariant = z.infer<typeof resumeVariantSchema>;
