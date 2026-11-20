import { getProfileDatabase, listJobSummaries, resolveProfileDataDirectory, savePostingPublication } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";
import { z } from "zod";

import { fetchEmployerPublication, postingLinkKey } from "../src/github-job-list-source";
import { pacePerHost } from "../src/host-pacer";
import { mapWithConcurrency } from "../src/concurrency";
import { acquirePipelineLock } from "../src/pipeline-lock";

/** Explicit public reads, at most 100 postings or 5 minutes per pass. No models or application actions. */
async function main() {
  const args = process.argv.slice(2);
  const argument = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1];
  };
  const profile = workspaceProfileSchema.parse(argument("--profile", "real"));
  const limit = z.coerce.number().int().min(1).max(100).parse(argument("--limit", "100"));
  const offset = z.coerce.number().int().min(0).parse(argument("--offset", "0"));
  const release = acquirePipelineLock(resolveProfileDataDirectory(profile));
  const database = getProfileDatabase(profile);
  const started = Date.now();
  const boards: Parameters<typeof fetchEmployerPublication>[2] = new Map();
  const report = { profile, offset, considered: 0, updated: 0, unknown: 0, failed: 0, nextOffset: offset, total: 0 };
  try {
    // Stable import ordering: metadata refreshes do not change createdAt.
    const postings = listJobSummaries(database);
    report.total = postings.length;
    const pacedFetch = pacePerHost(fetch, 350);
    await mapWithConcurrency(postings.slice(offset, offset + limit), 4, async (posting) => {
      if (Date.now() - started >= 300_000) return;
      report.considered++;
      report.nextOffset++;
      if (posting.publication) return;
      const key = postingLinkKey(posting.sourceUrl);
      if (!key || key.startsWith("lever:")) { report.unknown++; return; }
      try {
        const publication = await fetchEmployerPublication(posting.sourceUrl, pacedFetch, boards);
        if (publication) { savePostingPublication(database, posting.id, publication); report.updated++; }
        else report.unknown++;
      } catch { report.failed++; }
    });
    console.log(JSON.stringify({ finished: report }));
  } finally { database.close(); release(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Date refresh failed"); process.exitCode = 1; });
