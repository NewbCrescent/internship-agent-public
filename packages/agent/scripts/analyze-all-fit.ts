import { getDiscoverySkip, getProfileDatabase, getSemanticFit, getSemanticFitFailure,
  listJobSummaries, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema, type JobPostingStatus } from "@internship-agent/domain";
import { z } from "zod";

import { mapWithConcurrency, modelConcurrency } from "../src/concurrency";
import { isPriorityPublication, prioritizeByPublication } from "../src/fit-backfill";
import { OpenAiCompatibleProvider } from "../src/model/openai-compatible-provider";
import { modelRateLimits, RATE_LIMIT_SAFETY } from "../src/model/rate-limiter";
import { automaticallyAnalyzeFit } from "../src/model/semantic-fit";
import { acquirePipelineLock } from "../src/pipeline-lock";

/**
 * AI-only backfill: scores every eligible posting with the competitiveness
 * judge without touching deterministic matches, statuses, or applications.
 * Selection mirrors advancePipeline's AI policy (skipped, terminal, and
 * NOT_QUALIFIED postings stay out unless --include-not-qualified is passed).
 * Holds the workspace pipeline lock; resumable because cached postings and
 * failures younger than 24 hours are skipped. Postings published within
 * --priority-days (default 3) run first so the freshest roles score earliest.
 *
 * The batch shares the Contributor tier with this agent session and the
 * dashboard, so run it at half the published limits, e.g.:
 * MODEL_REQUESTS_PER_MINUTE=50 MODEL_TOKENS_PER_MINUTE=1500000
 * INTERNSHIP_AGENT_MODEL_CONCURRENCY=48 pnpm exec tsx
 * --env-file-if-exists=.env packages/agent/scripts/analyze-all-fit.ts
 * --profile real
 */
const TERMINAL: ReadonlySet<JobPostingStatus> = new Set([
  "SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"
]);

async function main() {
  const args = process.argv.slice(2);
  const argument = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] ?? fallback;
  };
  const profile = workspaceProfileSchema.parse(argument("--profile", "real"));
  const limit = z.coerce.number().int().min(1).max(10000).parse(argument("--limit", "10000"));
  const offset = z.coerce.number().int().min(0).parse(argument("--offset", "0"));
  const priorityDays = z.coerce.number().int().min(0).max(365).parse(argument("--priority-days", "3"));
  const rawConcurrency = args.includes("--concurrency") ? argument("--concurrency", "") : "";
  const concurrency = rawConcurrency
    ? z.coerce.number().int().min(1).max(64).parse(rawConcurrency)
    : modelConcurrency();
  const includeNotQualified = args.includes("--include-not-qualified");
  const provider = new OpenAiCompatibleProvider();
  if (!provider.available) {
    console.error("The model provider is not configured; nothing was analyzed.");
    process.exitCode = 1;
    return;
  }
  const configured = modelRateLimits();
  const release = acquirePipelineLock(resolveProfileDataDirectory(profile));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { release(); process.exit(130); });
  }
  const database = getProfileDatabase(profile);
  const report = { profile, considered: 0, assessed: 0, failed: 0, skippedCached: 0, skippedRecentFailure: 0 };
  const started = Date.now();
  try {
    const eligible = listJobSummaries(database).filter((posting) => {
      if (TERMINAL.has(posting.status)) return false;
      if (posting.status === "NOT_QUALIFIED" && !includeNotQualified) return false;
      if (getDiscoverySkip(database, posting.id)) return false;
      const cached = getSemanticFit(database, posting.id);
      if (cached && !cached.stale) { report.skippedCached++; return false; }
      const failure = getSemanticFitFailure(database, posting.id);
      if (failure && Date.now() - Date.parse(failure) < 86_400_000) { report.skippedRecentFailure++; return false; }
      // Summaries already imply a current snapshot; a posting that fails to
      // hydrate is recorded as a per-posting failure by the analysis call.
      return true;
    });
    // Employer publication recency first (the same rolling window as the
    // dashboard's age filter); --priority-days 0 keeps pure import order.
    const ordered = prioritizeByPublication(eligible, priorityDays);
    const slice = ordered.slice(offset, offset + limit);
    const priorityCount = ordered.filter((posting) => isPriorityPublication(posting.publication, priorityDays)).length;
    console.log(`AI backfill on ${profile}: ${eligible.length} eligible (${priorityCount} posted within ${priorityDays}d first), ` +
      `running ${slice.length} (offset ${offset}), ${concurrency} concurrent, ` +
      `limiter ${Math.floor(configured.requestsPerMinute * RATE_LIMIT_SAFETY)} RPM / ` +
      `${Math.floor(configured.tokensPerMinute * RATE_LIMIT_SAFETY)} TPM effective.`);
    await mapWithConcurrency(slice, concurrency, async (posting) => {
      const assessment = await automaticallyAnalyzeFit(posting.id, database, provider);
      report.considered++;
      if (assessment) report.assessed++;
      else report.failed++;
      if (report.considered % 25 === 0 || report.considered === slice.length) {
        const elapsedMin = (Date.now() - started) / 60000;
        const rpm = elapsedMin > 0 ? (report.considered / elapsedMin).toFixed(1) : "n/a";
        console.log(`[${new Date().toISOString()}] ${report.considered}/${slice.length} ` +
          `assessed ${report.assessed} failed ${report.failed} (${rpm}/min)`);
      }
    });
    console.log(JSON.stringify({ finished: { ...report, elapsedMs: Date.now() - started } }));
  } finally { database.close(); release(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "AI backfill failed"); process.exitCode = 1; });
