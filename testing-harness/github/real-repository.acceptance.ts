import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, seedDevelopmentData } from "@internship-agent/db";
import { getGitHubEvidenceWorkspace, syncGitHubRepository } from "@internship-agent/github";

void awaitMain().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function awaitMain(): Promise<void> {
  const repository = repositoryArgument(process.argv.slice(2))
    ?? process.env.INTERNSHIP_AGENT_GITHUB_REPOSITORY?.trim();
  if (!repository) throw new Error("Usage: pnpm verify:github:real -- --repo owner/repository");

  const directory = mkdtempSync(join(tmpdir(), "internship-agent-github-real-"));
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    database = createDatabase(join(directory, "acceptance.sqlite"));
    seedDevelopmentData(database);
    const result = await syncGitHubRepository(repository, { database });
    const workspace = getGitHubEvidenceWorkspace(database);
    const project = workspace.projects.find((item) => item.repositoryId === result.repositoryId);
    if (!project || project.claims.length === 0) throw new Error("The repository produced no reviewable project claims.");
    const evidence = project.claims.flatMap((claim) => claim.evidence);
    if (evidence.length === 0 || evidence.some((item) => !item.locator.sourceUrl.includes(result.headSha))) {
      throw new Error("One or more extracted claims lack commit-pinned source evidence.");
    }
    process.stdout.write(`GITHUB_REAL_REPOSITORY_REPORT ${JSON.stringify({
      schemaVersion: 1,
      repository: result.repository,
      headSha: result.headSha,
      selectedFiles: result.selectedFiles,
      fetchedFiles: result.fetchedFiles,
      candidateClaims: project.claims.length,
      evidenceItems: evidence.length,
      reviewStatus: "candidate_review_required",
      status: "passed"
    })}\n`);
  } finally {
    database?.close();
    if (!directory.startsWith(join(tmpdir(), "internship-agent-github-real-"))) {
      throw new Error("Refusing to clean an unexpected real-repository verification directory.");
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function repositoryArgument(args: string[]): string | null {
  const index = args.indexOf("--repo");
  return index >= 0 ? args[index + 1]?.trim() || null : null;
}
