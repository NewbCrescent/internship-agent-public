import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, seedDevelopmentData } from "@internship-agent/db";
import {
  getGitHubEvidenceWorkspace,
  reviewGitHubEvidenceClaim,
  syncGitHubRepository,
  type GitHubClient,
  type RemoteRepositorySnapshot,
  type RemoteTreeEntry
} from "@internship-agent/github";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("incremental GitHub evidence sync", () => {
  it("preserves unchanged approvals, resets changed claims, and stales deleted evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-github-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);
    const client = new FakeGitHubClient();

    const initial = await syncGitHubRepository("example/performance-demo", { database, client });
    expect(initial.status).toBe("SYNCED");
    expect(initial.fetchedFiles).toBe(3);
    let workspace = getGitHubEvidenceWorkspace(database);
    const initialMetric = workspace.projects[0].claims.find((claim) => claim.kind === "metric");
    expect(initialMetric?.reviewStatus).toBe("PENDING");
    expect(initialMetric?.evidence[0].locator.sourceUrl).toContain("sha-one/README.md#L5");
    expect(reviewGitHubEvidenceClaim({ claimId: initialMetric!.id, decision: "ALLOWED" }, database)).toBe(true);

    const unchanged = await syncGitHubRepository("https://github.com/example/performance-demo", { database, client });
    expect(unchanged.status).toBe("UNCHANGED");
    expect(unchanged.fetchedFiles).toBe(0);
    workspace = getGitHubEvidenceWorkspace(database);
    expect(workspace.projects[0].claims.find((claim) => claim.id === initialMetric!.id)?.reviewStatus).toBe("ALLOWED");

    client.advanceToChangedMetric();
    const changed = await syncGitHubRepository("example/performance-demo", { database, client });
    expect(changed.fetchedFiles).toBe(1);
    workspace = getGitHubEvidenceWorkspace(database);
    const revisedMetric = workspace.projects[0].claims.find((claim) => claim.id === initialMetric!.id);
    expect(revisedMetric?.text).toContain("12x");
    expect(revisedMetric?.reviewStatus).toBe("PENDING");
    expect(revisedMetric?.freshness).toBe("CURRENT");
    expect(database.prepare("SELECT COUNT(*) AS count FROM claim_revisions WHERE claim_id = ?")
      .get(initialMetric!.id)).toEqual({ count: 2 });

    client.advanceToDeletedReadme();
    const deleted = await syncGitHubRepository("example/performance-demo", { database, client });
    expect(deleted.fetchedFiles).toBe(0);
    workspace = getGitHubEvidenceWorkspace(database);
    const staleMetric = workspace.projects[0].claims.find((claim) => claim.id === initialMetric!.id);
    expect(staleMetric?.freshness).toBe("STALE");
    expect(reviewGitHubEvidenceClaim({ claimId: staleMetric!.id, decision: "ALLOWED" }, database)).toBe(false);
    database.close();
  });
});

class FakeGitHubClient implements GitHubClient {
  private version = 1;
  fileFetches = 0;

  async getRepositorySnapshot(): Promise<RemoteRepositorySnapshot> {
    return {
      owner: "example",
      name: "performance-demo",
      url: "https://github.com/example/performance-demo",
      defaultBranch: "main",
      description: "A compact systems performance experiment.",
      headSha: this.version === 1 ? "sha-one" : this.version === 2 ? "sha-two" : "sha-three",
      treeSha: this.version === 1 ? "tree-one" : this.version === 2 ? "tree-two" : "tree-three",
      topics: ["systems"],
      languages: { C: 1_000 },
      licenseName: "MIT"
    };
  }

  async getTree(): Promise<RemoteTreeEntry[]> {
    const common: RemoteTreeEntry[] = [
      { path: "package.json", type: "blob", sha: "package-one", size: 80 },
      { path: "src/vector.c", type: "blob", sha: "source-one", size: 80 }
    ];
    if (this.version === 3) return common;
    return [
      { path: "README.md", type: "blob", sha: this.version === 1 ? "readme-one" : "readme-two", size: 120 },
      ...common
    ];
  }

  async getFileContent(_owner: string, _name: string, entry: RemoteTreeEntry) {
    this.fileFetches += 1;
    const contents: Record<string, string> = {
      "readme-one": "# Demo\n\nA compact systems performance experiment.\n\nBenchmark improved throughput by 10x.",
      "readme-two": "# Demo\n\nA compact systems performance experiment.\n\nBenchmark improved throughput by 12x.",
      "package-one": JSON.stringify({ dependencies: { react: "19.0.0" } }, null, 2),
      "source-one": "#include <arm_neon.h>\n#pragma omp parallel for"
    };
    const content = contents[entry.sha];
    if (!content) throw new Error(`Missing fixture for ${entry.sha}`);
    return { path: entry.path, blobSha: entry.sha, size: content.length, content };
  }

  advanceToChangedMetric() {
    this.version = 2;
  }

  advanceToDeletedReadme() {
    this.version = 3;
  }
}
