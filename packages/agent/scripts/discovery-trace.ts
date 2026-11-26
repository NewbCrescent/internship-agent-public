import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { summarizeDiscoveryTrace } from "../src/discovery-trace";

/** Read-only: summarizes the workspace's discovery traces, or finds one listing in them. */
const USAGE = "Usage: pnpm discovery:trace [--profile real|demo] [--passes N] [--find <text>]";
const args = process.argv.slice(2);
let profileValue = "real";
let passes = 10;
let find: string | undefined;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (value === undefined) usage();
  else if (flag === "--profile") profileValue = value;
  else if (flag === "--passes" && /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100) passes = Number(value);
  else if (flag === "--find" && value.trim()) find = value.trim();
  else usage();
}
const profile = workspaceProfileSchema.safeParse(profileValue);
if (!profile.success) usage();
else {
  for (const line of summarizeDiscoveryTrace(resolveProfileDataDirectory(profile.data), { passes, ...(find !== undefined ? { find } : {}) })) {
    console.log(line);
  }
}

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}
