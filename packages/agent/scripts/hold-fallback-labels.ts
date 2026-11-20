import { getProfileDatabase, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { acquirePipelineLock } from "../src/pipeline-lock";
import { holdFallbackRequirementLabels } from "../src/requirement-relabel";

/**
 * Holds postings whose stored requirement labels may have come from the old
 * rule fallback (a rule label is stored, or a classification call failed
 * before the posting was stored), so the next pipeline pass relabels them with
 * the AI. Local only: no network, no models, no deletes, no status changes.
 * Prints a report and writes nothing unless --apply is passed.
 */
function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  const profile = workspaceProfileSchema.parse(index < 0 ? "real" : args[index + 1]);
  const apply = args.includes("--apply");
  const release = acquirePipelineLock(resolveProfileDataDirectory(profile));
  try {
    const report = holdFallbackRequirementLabels(getProfileDatabase(profile), { apply });
    process.stdout.write(`REQUIREMENT_LABEL_HOLD_REPORT ${JSON.stringify({ profile, ...report })}\n`);
    if (!apply) process.stdout.write("Dry run: nothing was written. Re-run with --apply to hold these postings for AI labels.\n");
  } finally {
    release();
  }
}

main();
