import { z } from "zod";
import { postingPublicationSchema } from "./posting-publication";

/**
 * Milestone 9 discovery. Sources feed raw posting texts; deterministic
 * dedupe collapses reposts; bulk cheap analysis (match-only) ranks the
 * corpus; threshold promotion prepares the top few so the review queue
 * reflects strong candidates instead of raw volume.
 */

export const discoverySourceKindSchema = z.enum(["manual-batch", "company-page"]);

export const discoverySourceSchema = z.object({
  id: z.string().uuid(),
  kind: discoverySourceKindSchema,
  label: z.string().min(1).max(160),
  url: z.string().max(2_000).nullable(),
  rateLimitPerMinute: z.number().int().min(1).max(600),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  lastFetchedAt: z.iso.datetime().nullable()
});

export const discoveredItemSchema = z.object({
  title: z.string().min(1).max(200),
  companyName: z.string().min(1).max(200),
  text: z.string().min(1).max(60_000),
  sourceUrl: z.string().max(2_000).nullable(),
  publication: postingPublicationSchema.nullable().optional()
});

export const discoveryRunSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  fetched: z.number().int().min(0),
  deduped: z.number().int().min(0),
  ingested: z.number().int().min(0),
  analyzed: z.number().int().min(0),
  promoted: z.number().int().min(0)
});

export const discoverySkipInputSchema = z.object({
  jobIds: z.array(z.string().uuid()).min(1).max(100),
  reason: z.string().trim().min(1).max(300),
  preferenceNote: z.string().trim().max(300).nullable()
});

export const discoveryFeedbackSchema = z.object({
  jobId: z.string().uuid(),
  decision: z.literal("SKIP"),
  reason: z.string().min(1).max(300),
  preferenceNote: z.string().max(300).nullable(),
  createdAt: z.iso.datetime()
});

export type DiscoverySource = z.infer<typeof discoverySourceSchema>;
export type DiscoveredItem = z.infer<typeof discoveredItemSchema>;
export type DiscoveryRun = z.infer<typeof discoveryRunSchema>;
export type DiscoveryFeedback = z.infer<typeof discoveryFeedbackSchema>;
