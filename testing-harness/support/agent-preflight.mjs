import { spawnSync } from "node:child_process";

import { requiredCapabilities } from "./agent-workflow.mjs";

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { ok: result.status === 0, detail: (result.stdout || result.stderr || "unavailable").trim().split("\n")[0] };
}

export function inspectPrerequisites(suites) {
  const capabilities = requiredCapabilities(suites);
  const checks = [];
  const errors = [];
  const record = (name, result) => {
    checks.push({ name, ...result });
    if (!result.ok) errors.push(`${name}: ${result.detail}`);
  };

  if (capabilities.includes("node")) record("node", { ok: true, detail: process.version });
  if (capabilities.includes("pnpm")) record("pnpm", commandAvailable("pnpm"));
  if (capabilities.includes("git")) record("git", commandAvailable("git"));
  if (capabilities.includes("node-sqlite")) {
    const sqlite = spawnSync(process.execPath, ["-e", "require('node:sqlite').DatabaseSync"], { encoding: "utf8" });
    record("node-sqlite", { ok: sqlite.status === 0, detail: sqlite.status === 0 ? "node:sqlite is available" : "node:sqlite is unavailable" });
  }
  if (capabilities.includes("playwright-chromium")) {
    const installed = spawnSync("pnpm", ["exec", "playwright", "install", "--list"], { encoding: "utf8" });
    const output = `${installed.stdout ?? ""}\n${installed.stderr ?? ""}`;
    record("playwright-chromium", {
      ok: installed.status === 0 && /chromium-\d+/.test(output),
      detail: /chromium-\d+/.test(output) ? "Chromium is installed" : "Run pnpm exec playwright install chromium"
    });
  }
  return { capabilities, checks, errors };
}
