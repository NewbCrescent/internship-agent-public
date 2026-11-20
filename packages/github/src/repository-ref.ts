import { githubRepositoryRefSchema, type GitHubRepositoryRef } from "@internship-agent/domain";

export function parseGitHubRepositoryRef(input: string): GitHubRepositoryRef {
  const value = input.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return githubRepositoryRefSchema.parse({ owner: sshMatch[1], name: sshMatch[2] });

  if (!value.includes("://")) {
    const parts = value.split("/");
    if (parts.length === 2) return githubRepositoryRefSchema.parse({ owner: parts[0], name: parts[1] });
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a GitHub repository URL or owner/repository.");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only github.com repository URLs are supported in Milestone 2.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("Enter a repository URL such as https://github.com/owner/repository.");
  return githubRepositoryRefSchema.parse({ owner: parts[0], name: parts[1] });
}

export function canonicalGitHubUrl(reference: GitHubRepositoryRef): string {
  return `https://github.com/${reference.owner}/${reference.name}`;
}
