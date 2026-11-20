import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  githubRepositorySchema,
  repositoryFileSchema,
  type GitHubRepository,
  type GitHubRepositoryRef,
  type RepositoryFile
} from "@internship-agent/domain";

type RepositoryRow = {
  id: string;
  candidate_id: string;
  owner: string;
  name: string;
  url: string;
  default_branch: string;
  description: string | null;
  observed_head_sha: string | null;
  analyzed_head_sha: string | null;
  sync_status: GitHubRepository["syncStatus"];
  last_synced_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type FileRow = {
  repository_id: string;
  path: string;
  blob_sha: string;
  content_hash: string;
  size: number;
  kind: RepositoryFile["kind"];
  last_seen_sha: string;
};

export type RepositoryRegistration = GitHubRepositoryRef & {
  candidateId: string;
  url: string;
  defaultBranch: string;
  description: string | null;
  observedHeadSha: string;
};

export function registerGitHubRepository(
  database: DatabaseSync,
  input: RepositoryRegistration
): GitHubRepository {
  const existing = findGitHubRepository(database, input.candidateId, input);
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  if (existing) {
    database.prepare(`
      UPDATE github_repositories SET
        owner = ?, name = ?, url = ?, default_branch = ?, description = ?,
        observed_head_sha = ?, sync_status = 'SYNCING', last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      input.owner,
      input.name,
      input.url,
      input.defaultBranch,
      input.description,
      input.observedHeadSha,
      now,
      existing.id
    );
    const repository = getGitHubRepository(database, existing.id);
    if (!repository) throw new Error("GitHub repository was not updated.");
    return repository;
  }
  database.prepare(`
    INSERT INTO github_repositories (
      id, candidate_id, owner, name, url, default_branch, description,
      observed_head_sha, analyzed_head_sha, sync_status, last_synced_at,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'SYNCING', NULL, NULL, ?, ?)
  `).run(
    id,
    input.candidateId,
    input.owner,
    input.name,
    input.url,
    input.defaultBranch,
    input.description,
    input.observedHeadSha,
    now,
    now
  );
  const repository = findGitHubRepository(database, input.candidateId, input);
  if (!repository) throw new Error("GitHub repository was not registered.");
  return repository;
}

export function findGitHubRepository(
  database: DatabaseSync,
  candidateId: string,
  reference: GitHubRepositoryRef
): GitHubRepository | null {
  const row = database.prepare(`
    SELECT * FROM github_repositories
    WHERE candidate_id = ? AND owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE
  `).get(candidateId, reference.owner, reference.name) as RepositoryRow | undefined;
  return row ? mapRepository(row) : null;
}

export function getGitHubRepository(database: DatabaseSync, repositoryId: string): GitHubRepository | null {
  const row = database.prepare("SELECT * FROM github_repositories WHERE id = ?")
    .get(repositoryId) as RepositoryRow | undefined;
  return row ? mapRepository(row) : null;
}

export function listGitHubRepositories(database: DatabaseSync, candidateId: string): GitHubRepository[] {
  const rows = database.prepare(`
    SELECT * FROM github_repositories WHERE candidate_id = ? ORDER BY updated_at DESC
  `).all(candidateId) as RepositoryRow[];
  return rows.map(mapRepository);
}

export function markGitHubRepositoryFailed(
  database: DatabaseSync,
  repositoryId: string,
  message: string
): void {
  database.prepare(`
    UPDATE github_repositories
    SET sync_status = 'FAILED', last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(message.slice(0, 1_000), new Date().toISOString(), repositoryId);
}

export function completeGitHubRepositorySync(
  database: DatabaseSync,
  repositoryId: string,
  headSha: string,
  files: RepositoryFile[]
): void {
  const now = new Date().toISOString();
  database.prepare("DELETE FROM repository_files WHERE repository_id = ?").run(repositoryId);
  const insert = database.prepare(`
    INSERT INTO repository_files (
      repository_id, path, blob_sha, content_hash, size, kind, last_seen_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const value of files) {
    const file = repositoryFileSchema.parse(value);
    insert.run(file.repositoryId, file.path, file.blobSha, file.contentHash, file.size, file.kind, file.lastSeenSha);
  }
  database.prepare(`
    UPDATE github_repositories
    SET analyzed_head_sha = ?, observed_head_sha = ?, sync_status = 'SYNCED',
        last_synced_at = ?, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(headSha, headSha, now, now, repositoryId);
}

export function listRepositoryFiles(database: DatabaseSync, repositoryId: string): RepositoryFile[] {
  const rows = database.prepare(`
    SELECT * FROM repository_files WHERE repository_id = ? ORDER BY path
  `).all(repositoryId) as FileRow[];
  return rows.map((row) => repositoryFileSchema.parse({
    repositoryId: row.repository_id,
    path: row.path,
    blobSha: row.blob_sha,
    contentHash: row.content_hash,
    size: row.size,
    kind: row.kind,
    lastSeenSha: row.last_seen_sha
  }));
}

function mapRepository(row: RepositoryRow): GitHubRepository {
  return githubRepositorySchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    owner: row.owner,
    name: row.name,
    url: row.url,
    defaultBranch: row.default_branch,
    description: row.description,
    observedHeadSha: row.observed_head_sha,
    analyzedHeadSha: row.analyzed_head_sha,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
