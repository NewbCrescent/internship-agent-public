import { z } from "zod";

export const evidenceKindSchema = z.enum(["repository_metadata", "readme", "manifest", "source"]);
export const claimKindSchema = z.enum(["project", "technology", "skill", "metric"]);
export const claimReviewStatusSchema = z.enum(["PENDING", "ALLOWED", "QUESTIONED", "REJECTED"]);
export const claimFreshnessSchema = z.enum(["CURRENT", "STALE"]);

export const evidenceLocatorSchema = z.object({
  repositoryUrl: z.url(),
  commitSha: z.string().min(1),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sourceUrl: z.url()
}).refine((value) => value.endLine >= value.startLine, {
  message: "Evidence end line must be at or after its start line."
});

export const evidenceItemSchema = z.object({
  id: z.string().uuid(),
  repositoryId: z.string().uuid(),
  kind: evidenceKindSchema,
  locator: evidenceLocatorSchema,
  excerpt: z.string().min(1).max(4_000),
  excerptHash: z.string().min(1),
  createdAt: z.iso.datetime()
});

export const evidenceClaimSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: claimKindSchema,
  normalizedKey: z.string().min(1).max(240),
  text: z.string().min(1).max(1_000),
  reviewStatus: claimReviewStatusSchema,
  freshness: claimFreshnessSchema,
  evidence: z.array(evidenceItemSchema).min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const projectEvidenceProfileSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  repositoryId: z.string().uuid(),
  name: z.string().min(1).max(200),
  summary: z.string().max(2_000).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  claims: z.array(evidenceClaimSchema)
});

export const claimReviewInputSchema = z.object({
  claimId: z.string().uuid(),
  decision: z.enum(["ALLOWED", "QUESTIONED", "REJECTED"]),
  note: z.string().trim().max(1_000).optional()
});

export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export type ClaimKind = z.infer<typeof claimKindSchema>;
export type ClaimReviewStatus = z.infer<typeof claimReviewStatusSchema>;
export type ClaimFreshness = z.infer<typeof claimFreshnessSchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type ProjectEvidenceProfile = z.infer<typeof projectEvidenceProfileSchema>;
export type ClaimReviewInput = z.infer<typeof claimReviewInputSchema>;
