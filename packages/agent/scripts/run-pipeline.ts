import { workspaceProfileSchema } from "@internship-agent/domain";

import { runPipelinePass } from "./pipeline-pass";

/**
 * One pass of the whole pipeline for a workspace: check every enabled
 * discovery source, prepare qualified postings, and (with
 * INTERNSHIP_AGENT_AUTO_APPLY=1) fill verified applications up to the
 * submit step. Only the opt-in auto-submit policy (INTERNSHIP_AGENT_AUTO_SUBMIT=1
 * with a target term) submits, and only runs it finds clean.
 *
 *   pnpm pipeline:run [--profile real|demo] [--skip-discovery] [--retry-stopped]
 */
async function main() {
  const args = process.argv.slice(2);
  const profileIndex = args.indexOf("--profile");
  const profile = workspaceProfileSchema.parse(profileIndex >= 0 ? args[profileIndex + 1] : "real");
  await runPipelinePass({
    profile,
    sourceIds: args.includes("--skip-discovery") ? [] : "all",
    retryStopped: args.includes("--retry-stopped"),
    log: (line) => console.log(line)
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
