import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { HARNESS_REPORT_SCHEMA_VERSION, suiteManifest, validateSuiteManifest } from "./manifest.mjs";
import { changedPaths, normalizeCliArgs, selectChangedFeatures } from "./support/agent-workflow.mjs";
import { inspectPrerequisites } from "./support/agent-preflight.mjs";
import { enterGate } from "./support/gate-slots.mjs";

function parseArgs(argv) {
  const options = { tier: null, feature: null, changed: false, list: false, noWait: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tier") options.tier = argv[++index] ?? null;
    else if (arg === "--feature") options.feature = argv[++index] ?? null;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--no-wait") options.noWait = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.list && !options.tier && !options.feature && !options.changed) throw new Error("Choose --tier, --feature, --changed, or --list.");
  return options;
}

function selectSuites(options, changedSelection) {
  return suiteManifest.filter((suite) => {
    if (suite.tier === "benchmark") return false;
    if (options.feature && !suite.features.includes(options.feature)) return false;
    if (changedSelection && !suite.features.some((feature) => changedSelection.features.includes(feature))) return false;
    if (!options.tier) return true;
    if (options.tier === "local") return suite.tier === "fast" || suite.tier === "local";
    return suite.tier === options.tier;
  });
}

let currentChild = null;
function runSuite(suite, env) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let timedOut = false;
    const child = spawn("pnpm", [suite.script], { stdio: "inherit", env });
    currentChild = child;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, suite.timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      currentChild = null;
      resolve({
        id: suite.id,
        script: suite.script,
        status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed",
        exitCode: code,
        signal,
        durationMs: Math.round(performance.now() - startedAt)
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      currentChild = null;
      resolve({ id: suite.id, script: suite.script, status: "failed", exitCode: null, durationMs: Math.round(performance.now() - startedAt), error: error.message });
    });
  });
}

try {
  const options = parseArgs(normalizeCliArgs(process.argv.slice(2)));
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifestErrors = validateSuiteManifest(packageJson.scripts ?? {});
  if (manifestErrors.length > 0) throw new Error(`Harness manifest is invalid:\n- ${manifestErrors.join("\n- ")}`);
  if (options.list) {
    process.stdout.write(`HARNESS_MANIFEST ${JSON.stringify({ schemaVersion: HARNESS_REPORT_SCHEMA_VERSION, suites: suiteManifest })}\n`);
  } else {
    const paths = options.changed ? changedPaths(process.cwd()) : null;
    const changedSelection = paths ? { paths, ...selectChangedFeatures(paths) } : null;
    const suites = selectSuites(options, changedSelection);
    if (suites.length === 0) throw new Error("No suites matched the selection.");
    const preflight = inspectPrerequisites(suites);
    if (preflight.errors.length > 0) throw new Error(`Harness preflight failed:\n- ${preflight.errors.join("\n- ")}`);
    const startedAt = performance.now();
    const results = [];
    for (const suite of suites) {
      // A browser-tier suite first takes one of the machine's gate slots (or
      // reuses the slot its agent:finish parent holds); the wait is not part
      // of the suite's timeout.
      const gate = suite.tier === "browser"
        ? await enterGate({ label: `verify ${suite.id}`, noWait: options.noWait, prefix: "[testing-harness]", onSignal: (signal) => currentChild?.kill(signal) })
        : null;
      process.stdout.write(`\n[testing-harness] ${suite.id}: pnpm ${suite.script}\n`);
      try {
        results.push(await runSuite(suite, gate?.env ?? process.env));
      } finally {
        gate?.release();
      }
    }
    const failed = results.some((result) => result.status !== "passed");
    process.stdout.write(`HARNESS_RUN_REPORT ${JSON.stringify({
      schemaVersion: HARNESS_REPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      selection: { tier: options.tier, feature: options.feature, changed: changedSelection },
      status: failed ? "failed" : "passed",
      durationMs: Math.round(performance.now() - startedAt),
      results
    })}\n`);
    if (failed) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
