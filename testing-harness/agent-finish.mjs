import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { normalizeCliArgs } from "./support/agent-workflow.mjs";
import { enterGate } from "./support/gate-slots.mjs";
import { preserveNextEnv } from "./support/next-env.mjs";

const cliArgs = normalizeCliArgs(process.argv.slice(2));
const noWait = cliArgs.includes("--no-wait");
const args = cliArgs.filter((argument) => argument !== "--no-wait");
const feature = args[0] ?? null;
if (args.length > 1 || feature?.startsWith("--")) throw new Error("Usage: pnpm agent:finish [feature] [--no-wait]");

const commands = [
  { name: "doctor", command: "pnpm", args: feature ? ["agent:doctor", "--feature", feature] : ["agent:doctor"] },
  { name: "lint", command: "pnpm", args: ["exec", "eslint", "--quiet", "."] },
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "verification", command: "pnpm", args: feature ? ["verify:feature", feature] : ["agent:verify"] },
  { name: "build", command: "pnpm", args: ["build"] },
  { name: "diff-check", command: "git", args: ["diff", "--check"] }
];

let currentChild = null;
function runStep(step, env) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { stdio: "inherit", env });
    currentChild = child;
    child.on("exit", (code) => {
      currentChild = null;
      resolve(code);
    });
    child.on("error", () => {
      currentChild = null;
      resolve(null);
    });
  });
}

// One of the machine's gate slots (INTERNSHIP_AGENT_GATE_SLOTS, default 2) is
// held for the whole gate; the nested verification runner reuses it.
const gate = await enterGate({
  label: `agent:finish ${feature ?? "changed"}`,
  noWait,
  prefix: "[agent-finish]",
  onSignal: (signal) => currentChild?.kill(signal)
});

const startedAt = performance.now();
const results = [];
// `next build` rewrites the tracked next-env.d.ts; restore it after each step
// so diff-check and the working tree reflect only real changes.
const restoreNextEnv = preserveNextEnv();
try {
  for (const step of commands) {
    process.stdout.write(`\n[agent-finish] ${step.name}: ${step.command} ${step.args.join(" ")}\n`);
    const stepStart = performance.now();
    const exitCode = await runStep(step, gate.env);
    restoreNextEnv();
    results.push({ name: step.name, status: exitCode === 0 ? "passed" : "failed", exitCode, durationMs: Math.round(performance.now() - stepStart) });
    if (exitCode !== 0) break;
  }
} finally {
  gate.release();
}
const failed = results.some((result) => result.status === "failed");
process.stdout.write(`AGENT_FINISH_REPORT ${JSON.stringify({ schemaVersion: 1, feature, status: failed ? "failed" : "passed", durationMs: Math.round(performance.now() - startedAt), results })}\n`);
if (failed) process.exitCode = 1;
