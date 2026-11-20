import type { DatabaseSync } from "node:sqlite";

import {
  completeGitHubRepositorySync,
  findGitHubRepository,
  getCandidate,
  getDatabase,
  listGitHubRepositories,
  listProjectEvidenceProfiles,
  listRepositoryFiles,
  LOCAL_CANDIDATE_ID,
  markGitHubRepositoryFailed,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim
} from "@internship-agent/db";
import { claimReviewInputSchema, type ClaimReviewInput } from "@internship-agent/domain";

import { extractRepositoryClaims, type AnalyzedFile } from "./extractors";
import { selectEvidenceFiles, type SelectedTreeEntry } from "./file-policy";
import { GitHubRestClient } from "./github-rest-client";
import { sha256 } from "./provenance";
import { canonicalGitHubUrl, parseGitHubRepositoryRef } from "./repository-ref";
import type { GitHubClient, RemoteFileContent } from "./types";

export type GitHubSyncResult = {
  repositoryId: string;
  repository: string;
  headSha: string;
  status: "SYNCED" | "UNCHANGED";
  selectedFiles: number;
  fetchedFiles: number;
  extractedClaims: number;
};

export async function syncGitHubRepository(
  repositoryInput: string,
  options: { database?: DatabaseSync; client?: GitHubClient } = {}
): Promise<GitHubSyncResult> {
  const database = options.database ?? getDatabase();
  if (!getCandidate(database, LOCAL_CANDIDATE_ID)) {
    throw new Error("Create the local candidate first by running pnpm seed:dev or saving the Profile form.");
  }
  const client = options.client ?? new GitHubRestClient();
  const requested = parseGitHubRepositoryRef(repositoryInput);
  const snapshot = await client.getRepositorySnapshot(requested.owner, requested.name);
  const canonicalRef = parseGitHubRepositoryRef(`${snapshot.owner}/${snapshot.name}`);
  const existingBeforeRegistration = findGitHubRepository(database, LOCAL_CANDIDATE_ID, canonicalRef);
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    ...canonicalRef,
    url: snapshot.url || canonicalGitHubUrl(canonicalRef),
    defaultBranch: snapshot.defaultBranch,
    description: snapshot.description,
    observedHeadSha: snapshot.headSha
  });

  try {
    const existingFiles = listRepositoryFiles(database, repository.id);
    if (existingBeforeRegistration?.analyzedHeadSha === snapshot.headSha) {
      database.exec("BEGIN IMMEDIATE;");
      try {
        completeGitHubRepositorySync(database, repository.id, snapshot.headSha, existingFiles);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      return {
        repositoryId: repository.id,
        repository: `${snapshot.owner}/${snapshot.name}`,
        headSha: snapshot.headSha,
        status: "UNCHANGED",
        selectedFiles: existingFiles.length,
        fetchedFiles: 0,
        extractedClaims: 0
      };
    }

    const tree = await client.getTree(snapshot.owner, snapshot.name, snapshot.treeSha);
    const selected = selectEvidenceFiles(tree);
    const previousByPath = new Map(existingFiles.map((file) => [file.path, file]));
    const selectedByPath = new Map(selected.map((file) => [file.path, file]));
    const changed = selected.filter((file) => previousByPath.get(file.path)?.blobSha !== file.sha);
    const deletedPaths = existingFiles.filter((file) => !selectedByPath.has(file.path)).map((file) => file.path);
    const fetched = await fetchInBatches(client, snapshot.owner, snapshot.name, changed);
    const fetchedByPath = new Map(fetched.map((file) => [file.path, file]));
    const analyzedFiles: AnalyzedFile[] = changed.map((entry) => {
      const file = fetchedByPath.get(entry.path);
      if (!file) throw new Error(`GitHub did not return selected file ${entry.path}.`);
      return { ...file, kind: entry.kind, contentHash: sha256(file.content) };
    });
    const files = selected.map((entry) => {
      const analyzed = analyzedFiles.find((file) => file.path === entry.path);
      const previous = previousByPath.get(entry.path);
      if (!analyzed && !previous) throw new Error(`Missing file state for ${entry.path}.`);
      return {
        repositoryId: repository.id,
        path: entry.path,
        blobSha: entry.sha,
        contentHash: analyzed?.contentHash ?? previous!.contentHash,
        size: entry.size,
        kind: entry.kind,
        lastSeenSha: snapshot.headSha
      };
    });

    const extracted = extractRepositoryClaims(snapshot, analyzedFiles);
    const previousProject = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)
      .find((project) => project.repositoryId === repository.id);
    const changedReadme = changed.some((file) => file.kind === "readme");
    const summary = snapshot.description?.trim()
      || (changedReadme || !existingBeforeRegistration ? extracted.summary : previousProject?.summary ?? null);
    const affectedPaths = [
      ".github/repository-metadata.json",
      ...changed.map((file) => file.path),
      ...deletedPaths
    ];

    database.exec("BEGIN IMMEDIATE;");
    try {
      reconcileProjectEvidence(database, {
        candidateId: LOCAL_CANDIDATE_ID,
        repositoryId: repository.id,
        name: snapshot.name,
        summary,
        claims: extracted.claims,
        fullSnapshot: !existingBeforeRegistration?.analyzedHeadSha,
        affectedPaths
      });
      completeGitHubRepositorySync(database, repository.id, snapshot.headSha, files);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }

    return {
      repositoryId: repository.id,
      repository: `${snapshot.owner}/${snapshot.name}`,
      headSha: snapshot.headSha,
      status: "SYNCED",
      selectedFiles: selected.length,
      fetchedFiles: fetched.length,
      extractedClaims: extracted.claims.length
    };
  } catch (error) {
    markGitHubRepositoryFailed(database, repository.id, errorMessage(error));
    throw error;
  }
}

export function getGitHubEvidenceWorkspace(database: DatabaseSync = getDatabase()) {
  return {
    repositories: listGitHubRepositories(database, LOCAL_CANDIDATE_ID),
    projects: listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)
  };
}

export function reviewGitHubEvidenceClaim(
  input: ClaimReviewInput,
  database: DatabaseSync = getDatabase()
): boolean {
  return reviewEvidenceClaim(database, claimReviewInputSchema.parse(input));
}

async function fetchInBatches(
  client: GitHubClient,
  owner: string,
  name: string,
  entries: SelectedTreeEntry[]
): Promise<RemoteFileContent[]> {
  const results: RemoteFileContent[] = [];
  for (let index = 0; index < entries.length; index += 6) {
    results.push(...await Promise.all(entries.slice(index, index + 6)
      .map((entry) => client.getFileContent(owner, name, entry))));
  }
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
