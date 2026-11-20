import { existsSync, readFileSync } from "node:fs";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { readPipelineLock } from "../src/pipeline-lock";
import { statusPath } from "./pipeline-pass";

/** Prints the last pass's summary: what was submitted, what waits for you, and why. */
const args = process.argv.slice(2);
const profileIndex = args.indexOf("--profile");
const profile = workspaceProfileSchema.parse(profileIndex >= 0 ? args[profileIndex + 1] : "real");
const dataDir = resolveProfileDataDirectory(profile);
const lock = readPipelineLock(dataDir);
if (lock) console.log(`A pass is running now (process ${lock.pid}, started ${lock.startedAt}).`);
const path = statusPath(dataDir);
console.log(existsSync(path) ? readFileSync(path, "utf8") : "No pass has finished in this workspace yet.");
