import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { normalizeCliArgs } from "./support/agent-workflow.mjs";
import { preserveNextEnv } from "./support/next-env.mjs";

const args = normalizeCliArgs(process.argv.slice(2));
const feature = args[0] ?? null;
if (args.length > 1 || feature?.startsWith("--")) throw new Error("Usage: pnpm agent:finish [feature]");

const commands = [
  { name: "doctor", command: "pnpm", args: feature ? ["agent:doctor", "--feature", feature] : ["agent:doctor"] },
  { name: "lint", command: "pnpm", args: ["exec", "eslint", "--quiet", "."] },
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "verification", command: "pnpm", args: feature ? ["verify:feature", feature] : ["agent:verify"] },
  { name: "build", command: "pnpm", args: ["build"] },
  { name: "diff-check", command: "git", args: ["diff", "--check"] }
];

const startedAt = performance.now();
const results = [];
// `next build` rewrites the tracked next-env.d.ts; restore it after each step
// so diff-check and the working tree reflect only real changes.
const restoreNextEnv = preserveNextEnv();
for (const step of commands) {
  process.stdout.write(`\n[agent-finish] ${step.name}: ${step.command} ${step.args.join(" ")}\n`);
  const stepStart = performance.now();
  const result = spawnSync(step.command, step.args, { stdio: "inherit", env: process.env });
  restoreNextEnv();
  results.push({ name: step.name, status: result.status === 0 ? "passed" : "failed", exitCode: result.status, durationMs: Math.round(performance.now() - stepStart) });
  if (result.status !== 0) break;
}
const failed = results.some((result) => result.status === "failed");
process.stdout.write(`AGENT_FINISH_REPORT ${JSON.stringify({ schemaVersion: 1, feature, status: failed ? "failed" : "passed", durationMs: Math.round(performance.now() - startedAt), results })}\n`);
if (failed) process.exitCode = 1;
