import { getProfileDatabase, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";
import { z } from "zod";
import { backfillPlaceAndPay } from "@internship-agent/jobs";

import { acquirePipelineLock } from "../src/pipeline-lock";

/**
 * Re-reads location and pay from stored posting text with the current
 * extractor. Local only: no network, no models, no status changes. Prints a
 * report and writes nothing unless --apply is passed; --days N limits it to
 * postings the employer published within the last N days.
 */
function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  const profile = workspaceProfileSchema.parse(index < 0 ? "real" : args[index + 1]);
  const apply = args.includes("--apply");
  const daysAt = args.indexOf("--days");
  const postedWithinDays = daysAt < 0 ? null : z.coerce.number().int().min(1).max(365).parse(args[daysAt + 1]);
  const release = acquirePipelineLock(resolveProfileDataDirectory(profile));
  try {
    const report = backfillPlaceAndPay(getProfileDatabase(profile), { apply, postedWithinDays });
    process.stdout.write(`EXTRACTION_BACKFILL_REPORT ${JSON.stringify({ profile, ...report })}\n`);
    if (!apply) process.stdout.write("Dry run: nothing was written. Re-run with --apply to save these changes.\n");
  } finally {
    release();
  }
}

main();
