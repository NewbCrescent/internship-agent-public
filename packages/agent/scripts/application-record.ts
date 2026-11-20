import { closeProfileDatabase, getProfileDatabase, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema, type WorkspaceProfile } from "@internship-agent/domain";
import { z } from "zod";

import { regenerateApplicationRecords, type ApplicationRecordSelection } from "../src/application-record";
import { acquirePipelineLock } from "../src/pipeline-lock";

/**
 * Writes the local PDF record of what each submitted application sent, next
 * to that application's files in the workspace data directory (mode 600).
 * Local only: no network, and the PDF is never attached to messages or sent
 * anywhere. Takes the workspace's pipeline lock while it writes.
 *
 * Usage: pnpm application:record [--profile real|demo] [--job <id>] [--all-submitted]
 *   no flags          write only the records that are missing
 *   --job <id>        (re)write that application's record
 *   --all-submitted   rewrite every submitted application's record
 */
const USAGE = "Usage: pnpm application:record [--profile real|demo] [--job <id>] [--all-submitted]";

type Options = { profile: WorkspaceProfile; select: ApplicationRecordSelection };

function parseArgs(args: string[]): Options | null {
  let profile: WorkspaceProfile = "real";
  let jobId: string | null = null;
  let all = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      const parsed = workspaceProfileSchema.safeParse(args[index + 1]);
      if (!parsed.success) return null;
      profile = parsed.data;
      index += 1;
    } else if (arg === "--job") {
      const parsed = z.string().uuid().safeParse(args[index + 1]);
      if (!parsed.success) return null;
      jobId = parsed.data;
      index += 1;
    } else if (arg === "--all-submitted") {
      all = true;
    } else {
      return null;
    }
  }
  if (jobId && all) return null;
  return { profile, select: jobId ? { kind: "job", jobId } : all ? { kind: "all" } : { kind: "missing" } };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(`${USAGE}\n`);
    return 1;
  }
  const { profile, select } = options;
  const dataDir = resolveProfileDataDirectory(profile);
  let release: () => void;
  try {
    release = acquirePipelineLock(dataDir);
  } catch (error) {
    process.stdout.write(`Not run: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const results = await regenerateApplicationRecords({ database: getProfileDatabase(profile), dataDir, select });
    if (results.length === 0) process.stdout.write("No submitted applications.\n");
    for (const result of results) {
      process.stdout.write(`${result.status} ${result.companyName ?? "Unknown"} — ${result.title ?? ""} (job ${result.jobId.slice(0, 8)}): ${result.detail}\n`);
    }
    const count = (status: string) => results.filter((result) => result.status === status).length;
    const report = { profile, saved: count("saved"), skipped: count("skipped"), failed: count("failed"), results };
    process.stdout.write(`APPLICATION_RECORD_REPORT ${JSON.stringify(report)}\n`);
    return report.failed > 0 ? 1 : 0;
  } finally {
    closeProfileDatabase(profile);
    release();
  }
}

process.exitCode = await main();
