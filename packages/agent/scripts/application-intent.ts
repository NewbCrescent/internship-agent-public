import {
  clearApplicationIntent, closeProfileDatabase, getApplicationIntent, getCandidate, getProfileDatabase, LOCAL_CANDIDATE_ID,
  resolveProfileDataDirectory, saveApplicationIntent
} from "@internship-agent/db";
import { APPLICATION_INTENT_EXAMPLE, workspaceProfileSchema } from "@internship-agent/domain";

import { acquirePipelineLock } from "../src/pipeline-lock";

/**
 * The candidate's application intent statement, the AI fit judgment's
 * context for what internships they want.
 *
 *   pnpm fit:intent [--profile real|demo]              shows it
 *   pnpm fit:intent --set "<statement>" [--profile …]  stores it
 *   pnpm fit:intent --clear [--profile …]              removes it
 *
 * Changing it marks every AI fit out of date, so following pipeline passes
 * re-score them (at most 25 per pass).
 */
const USAGE = 'Usage: pnpm fit:intent [--profile real|demo] [--set "<statement>" | --clear]';

function parseArgs(args: string[]) {
  const profileIndex = args.indexOf("--profile");
  const profile = workspaceProfileSchema.parse(profileIndex < 0 ? "real" : args[profileIndex + 1]);
  const setIndex = args.indexOf("--set");
  let set: string | null = null;
  if (setIndex >= 0) {
    const value = args[setIndex + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--set needs a statement.\n${USAGE}`);
    set = value;
  }
  const clear = args.includes("--clear");
  if (set !== null && clear) throw new Error(`Use --set or --clear, not both.\n${USAGE}`);
  return { profile, set, clear };
}

function main() {
  const { profile, set, clear } = parseArgs(process.argv.slice(2));
  try {
    const database = getProfileDatabase(profile);
    if (set === null && !clear) {
      const intent = getApplicationIntent(database, LOCAL_CANDIDATE_ID);
      if (intent) {
        process.stdout.write(`${intent.statement}\n(updated ${intent.updatedAt})\n`);
      } else {
        process.stdout.write(`No application intent is stored for this workspace.\nExample:\n${APPLICATION_INTENT_EXAMPLE}\n`);
      }
      return;
    }
    if (!getCandidate(database, LOCAL_CANDIDATE_ID)) throw new Error("Save the candidate profile first.");
    // A context bump mid-pass would make the pass's in-flight fit saves fail.
    const release = acquirePipelineLock(resolveProfileDataDirectory(profile));
    try {
      if (set !== null) {
        const before = getApplicationIntent(database, LOCAL_CANDIDATE_ID);
        const saved = saveApplicationIntent(database, LOCAL_CANDIDATE_ID, set);
        if (before && before.updatedAt === saved.updatedAt) {
          process.stdout.write(`The application intent is unchanged:\n${saved.statement}\n`);
        } else {
          process.stdout.write(`Stored the application intent:\n${saved.statement}\nAI fits will be re-scored on the next pipeline passes.\n`);
        }
      } else if (clearApplicationIntent(database, LOCAL_CANDIDATE_ID)) {
        process.stdout.write("Cleared the application intent. AI fits will be re-scored on the next pipeline passes.\n");
      } else {
        process.stdout.write("No application intent was stored; nothing was cleared.\n");
      }
    } finally {
      release();
    }
  } finally {
    closeProfileDatabase(profile);
  }
}

main();
