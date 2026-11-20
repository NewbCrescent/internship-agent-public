import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { z } from "zod";

import { canonicalGitHubJobListUrl } from "./github-job-list-source";

/**
 * The GitHub job lists cannot notify anyone but their owners, so the
 * "interrupt" is a doorbell: one conditional request per list for its latest
 * commit. GitHub answers 304 Not Modified when nothing changed (it does not
 * count against the rate limit), and only a new commit wakes the pipeline.
 */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const entrySchema = z.object({ etag: z.string().max(200).nullable(), sha: z.string().max(80).nullable(), checkedAt: z.string() });
const stateSchema = z.record(z.string(), entrySchema);
export type DoorbellState = z.infer<typeof stateSchema>;

export type DoorbellResult = {
  /** Source ids whose list has a new commit (or was never seen). */
  changed: string[];
  state: DoorbellState;
  errors: string[];
};

export function doorbellStatePath(dataDir: string): string {
  return join(dataDir, "list-doorbell.json");
}

/** A missing or unreadable file starts fresh: every list counts as changed once. */
export function readDoorbellState(dataDir: string): DoorbellState {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(doorbellStatePath(dataDir), "utf8")) as unknown);
  } catch {
    return {};
  }
}

export function writeDoorbellState(dataDir: string, state: DoorbellState): void {
  const path = doorbellStatePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export async function ringListDoorbell(
  sources: ReadonlyArray<{ id: string; url: string }>,
  state: DoorbellState,
  options: { fetcher?: Fetcher; token?: string | null; now?: Date } = {}
): Promise<DoorbellResult> {
  const fetcher = options.fetcher ?? fetch;
  const checkedAt = (options.now ?? new Date()).toISOString();
  const next: DoorbellState = { ...state };
  const changed: string[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    let repository: string;
    try {
      repository = new URL(canonicalGitHubJobListUrl(source.url)).pathname.slice(1);
    } catch {
      continue; // Not one of the GitHub lists; the doorbell only watches those.
    }
    const previous = state[source.id];
    const headers: Record<string, string> = {
      accept: "application/vnd.github.sha",
      "user-agent": "internship-agent-doorbell",
      "x-github-api-version": "2022-11-28"
    };
    if (previous?.etag) headers["if-none-match"] = previous.etag;
    if (options.token) headers.authorization = "Bearer " + options.token;
    try {
      const response = await fetcher("https://api.github.com/repos/" + repository + "/commits/HEAD", {
        headers, redirect: "error", signal: AbortSignal.timeout(15_000)
      });
      if (response.status === 304) {
        await response.body?.cancel();
        next[source.id] = { etag: previous?.etag ?? null, sha: previous?.sha ?? null, checkedAt };
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        errors.push(`${repository}: GitHub answered ${response.status}.`);
        continue;
      }
      const sha = (await response.text()).trim().slice(0, 80);
      if (!/^[0-9a-f]{40}$/.test(sha)) { errors.push(`${repository}: GitHub returned no commit.`); continue; }
      next[source.id] = { etag: response.headers.get("etag"), sha, checkedAt };
      if (sha !== previous?.sha) changed.push(source.id);
    } catch (error) {
      errors.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { changed, state: next, errors };
}
