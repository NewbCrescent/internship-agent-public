import { existsSync } from "node:fs";

import {
  closeProfileDatabase,
  getProfileDatabase,
  openApplicationAuditDatabase,
  resolveProfileDatabasePath,
  resolveProfileDataDirectory
} from "@internship-agent/db";
import { workspaceProfileSchema, type WorkspaceProfile } from "@internship-agent/domain";

import {
  applyBoardLocationBackfill,
  boardLocationBackfillCounts,
  boardLocationBackfillLines,
  planBoardLocationBackfill
} from "../src/board-location-backfill";
import { discoveryTimeBudgetLine, discoveryTimeBudgetMs, startDiscoveryTimeBudget } from "../src/discovery-time-budget";
import { acquirePipelineLock } from "../src/pipeline-lock";

/**
 * `pnpm backfill:board-locations --profile real|demo [--apply]` (Track 73).
 * Lists board-hosted postings with no `Location:` line and no country, by
 * their board: to re-read, kept past the approval gate, or with no board
 * source. The dry run (the default) opens the database read-only, takes no
 * lock, and fetches nothing. --apply takes the pipeline lock and re-reads
 * those boards now through the normal board check (no 6-hour interval,
 * back-off kept), so the stated location comes only from the board's own API
 * fields, stored as a normal revision with its discovery run and trace.
 * Postings past the approval gate are never revised; requeue them first.
 * The workspace is required, so it is never aimed at the real workspace by
 * accident.
 */
const USAGE = "Usage: pnpm backfill:board-locations --profile real|demo [--apply]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let profileValue: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--apply") { apply = true; continue; }
    if (flag !== "--profile") usage();
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || profileValue !== undefined) usage();
    profileValue = value;
    index += 1;
  }
  if (profileValue === undefined) usage();
  const parsedProfile = workspaceProfileSchema.safeParse(profileValue);
  if (!parsedProfile.success) usage();
  const profile: WorkspaceProfile = parsedProfile.data;

  if (!apply) {
    const path = resolveProfileDatabasePath(profile);
    if (!existsSync(path)) throw new Error(`No ${profile} workspace database at ${path}.`);
    const database = openApplicationAuditDatabase(profile);
    try {
      const plan = planBoardLocationBackfill(database);
      for (const line of boardLocationBackfillLines(plan)) console.log(line);
      console.log(`BOARD_LOCATION_BACKFILL_REPORT ${JSON.stringify({ profile, applied: false, ...boardLocationBackfillCounts(plan) })}`);
      console.log("Dry run: nothing was fetched or written. Re-run with --apply to re-read these boards now.");
    } finally {
      database.close();
    }
    return;
  }

  const dataDir = resolveProfileDataDirectory(profile);
  const release = acquirePipelineLock(dataDir);
  try {
    const database = getProfileDatabase(profile);
    const plan = planBoardLocationBackfill(database);
    const countsBefore = boardLocationBackfillCounts(plan);
    for (const line of boardLocationBackfillLines(plan)) console.log(line);
    const budget = startDiscoveryTimeBudget(discoveryTimeBudgetMs());
    await applyBoardLocationBackfill(database, plan, { log: (line) => console.log(line), budget, traceDirectory: dataDir });
    const budgetLine = discoveryTimeBudgetLine(budget);
    if (budgetLine) {
      console.log(budgetLine);
      console.log("Postings whose analysis waits are resumed by the next pass that checks sources.");
    }
    const after = boardLocationBackfillCounts(planBoardLocationBackfill(database));
    console.log(`BOARD_LOCATION_BACKFILL_REPORT ${JSON.stringify({ profile, applied: true, ...countsBefore, after })}`);
  } finally {
    closeProfileDatabase(profile);
    release();
  }
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
