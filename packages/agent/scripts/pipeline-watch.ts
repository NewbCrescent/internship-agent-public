import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { runWatchTick } from "./pipeline-pass";

/**
 * Rings the GitHub list doorbell and runs a pipeline pass only for lists
 * with a new commit. `--once` checks one time and exits (what the OS timer
 * runs); without it the process keeps checking every --interval seconds
 * (default 300). Lines go to stdout and <workspace data>/pipeline-logs/<date>.log.
 *
 *   pnpm pipeline:watch [--profile real|demo] [--once] [--interval 300]
 */
async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  const intervalSeconds = Math.max(60, Number.parseInt(value("--interval") ?? "300", 10) || 300);
  const dataDir = resolveProfileDataDirectory(profile);
  const logDirectory = join(dataDir, "pipeline-logs");
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    const day = new Date().toLocaleDateString("en-CA");
    appendFileSync(join(logDirectory, `${day}.log`), stamped + "\n", { mode: 0o600 });
  };

  for (;;) {
    await runWatchTick({ profile, log });
    if (args.includes("--once")) return;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
