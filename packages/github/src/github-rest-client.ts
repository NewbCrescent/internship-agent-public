import type {
  GitHubClient,
  RemoteFileContent,
  RemoteRepositorySnapshot,
  RemoteTreeEntry
} from "./types";

const API_VERSION = "2022-11-28";

type RepositoryResponse = {
  name: string;
  owner: { login: string };
  html_url: string;
  default_branch: string;
  description: string | null;
  topics?: string[];
  license?: { name?: string } | null;
};

type CommitResponse = { sha: string; commit: { tree: { sha: string } } };
type TreeResponse = {
  truncated: boolean;
  tree: Array<{ path?: string; type?: string; sha?: string; size?: number }>;
};
type BlobResponse = { encoding: string; content: string; size: number };

export class GitHubRestClient implements GitHubClient {
  constructor(
    private readonly token = process.env.GITHUB_TOKEN?.trim() || null,
    private readonly apiBaseUrl = "https://api.github.com"
  ) {}

  async getRepositorySnapshot(owner: string, name: string): Promise<RemoteRepositorySnapshot> {
    const root = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const repository = await this.request<RepositoryResponse>(root);
    const [commit, languages] = await Promise.all([
      this.request<CommitResponse>(`${root}/commits/${encodeURIComponent(repository.default_branch)}`),
      this.request<Record<string, number>>(`${root}/languages`)
    ]);
    return {
      owner: repository.owner.login,
      name: repository.name,
      url: repository.html_url,
      defaultBranch: repository.default_branch,
      description: repository.description,
      headSha: commit.sha,
      treeSha: commit.commit.tree.sha,
      topics: repository.topics ?? [],
      languages,
      licenseName: repository.license?.name ?? null
    };
  }

  async getTree(owner: string, name: string, treeSha: string): Promise<RemoteTreeEntry[]> {
    const tree = await this.request<TreeResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`
    );
    if (tree.truncated) {
      throw new Error("This repository tree exceeds the bounded Milestone 2 ingestion limit.");
    }
    return tree.tree.flatMap((entry): RemoteTreeEntry[] => {
      if (!entry.path || !entry.sha || (entry.type !== "blob" && entry.type !== "tree")) return [];
      return [{ path: entry.path, sha: entry.sha, type: entry.type, size: entry.size ?? 0 }];
    });
  }

  async getFileContent(
    owner: string,
    name: string,
    entry: RemoteTreeEntry
  ): Promise<RemoteFileContent> {
    if (entry.type !== "blob") throw new Error(`Cannot read non-file tree entry ${entry.path}.`);
    const blob = await this.request<BlobResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${encodeURIComponent(entry.sha)}`
    );
    if (blob.encoding !== "base64") throw new Error(`Unsupported GitHub encoding for ${entry.path}.`);
    return {
      path: entry.path,
      blobSha: entry.sha,
      size: blob.size,
      content: Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString("utf8")
    };
  }

  private async request<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "internship-agent-local",
      "X-GitHub-Api-Version": API_VERSION
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { message?: string } | null;
      const rateLimit = response.headers.get("x-ratelimit-remaining") === "0"
        ? " GitHub's API rate limit is exhausted; configure a local GITHUB_TOKEN or retry after reset."
        : "";
      throw new Error(`GitHub request failed (${response.status}): ${detail?.message ?? response.statusText}.${rateLimit}`);
    }
    return await response.json() as T;
  }
}
