import { z } from "zod";

const githubOwnerOrRepositoryName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);

export const githubRepositoryRefSchema = z.object({
  owner: githubOwnerOrRepositoryName,
  name: githubOwnerOrRepositoryName
});

export const githubSyncStatusSchema = z.enum(["IDLE", "SYNCING", "SYNCED", "FAILED"]);

export const githubRepositorySchema = githubRepositoryRefSchema.extend({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  url: z.url(),
  defaultBranch: z.string().min(1),
  description: z.string().nullable(),
  observedHeadSha: z.string().nullable(),
  analyzedHeadSha: z.string().nullable(),
  syncStatus: githubSyncStatusSchema,
  lastSyncedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const repositoryFileSchema = z.object({
  repositoryId: z.string().uuid(),
  path: z.string().min(1),
  blobSha: z.string().min(1),
  contentHash: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: z.enum(["readme", "manifest", "source"]),
  lastSeenSha: z.string().min(1)
});

export type GitHubRepositoryRef = z.infer<typeof githubRepositoryRefSchema>;
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
export type GitHubSyncStatus = z.infer<typeof githubSyncStatusSchema>;
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
