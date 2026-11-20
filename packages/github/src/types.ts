export type RemoteRepositorySnapshot = {
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  description: string | null;
  headSha: string;
  treeSha: string;
  topics: string[];
  languages: Record<string, number>;
  licenseName: string | null;
};

export type RemoteTreeEntry = {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size: number;
};

export type RemoteFileContent = {
  path: string;
  blobSha: string;
  size: number;
  content: string;
};

export interface GitHubClient {
  getRepositorySnapshot(owner: string, name: string): Promise<RemoteRepositorySnapshot>;
  getTree(owner: string, name: string, treeSha: string): Promise<RemoteTreeEntry[]>;
  getFileContent(owner: string, name: string, entry: RemoteTreeEntry): Promise<RemoteFileContent>;
}
