import { readFileSync } from "node:fs";

import { suiteManifest, validateSuiteManifest } from "./manifest.mjs";
import { normalizeCliArgs } from "./support/agent-workflow.mjs";
import { inspectPrerequisites } from "./support/agent-preflight.mjs";

const args = normalizeCliArgs(process.argv.slice(2));
let feature = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--feature") feature = args[++index] ?? null;
  else throw new Error(`Unknown argument: ${args[index]}`);
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const suites = suiteManifest.filter((suite) => suite.tier !== "benchmark" && (!feature || suite.features.includes(feature)));
const errors = validateSuiteManifest(packageJson.scripts ?? {});
if (feature && suites.length === 0) errors.push(`Unknown feature: ${feature}`);
const preflight = inspectPrerequisites(suites);
errors.push(...preflight.errors);
for (const check of preflight.checks) process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
process.stdout.write(`AGENT_DOCTOR_REPORT ${JSON.stringify({ schemaVersion: 1, feature, suites: suites.map((suite) => suite.id), capabilities: preflight.capabilities, status: errors.length ? "failed" : "passed", errors })}\n`);
if (errors.length) process.exitCode = 1;
