import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { preserveNextEnv } from "../support/next-env.mjs";

const dataDirectory = mkdtempSync(join(tmpdir(), "internship-agent-browser-"));
// Next.js rewrites the tracked next-env.d.ts to point at NEXT_DIST_DIR.
const restoreNextEnv = preserveNextEnv();
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  INTERNSHIP_AGENT_DATA_DIR: dataDirectory,
  INTERNSHIP_AGENT_DEFAULT_PROFILE: "demo",
  INTERNSHIP_AGENT_BASE_URL: baseUrl,
  NEXT_DIST_DIR: ".next-verify"
};
const startedAt = performance.now();
let server;
let status = "failed";

try {
  const seed = spawnSync("pnpm", ["seed:browser"], { stdio: "inherit", env: environment });
  if (seed.status !== 0) throw new Error("Development seed failed.");

  server = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: new URL("../../apps/dashboard", import.meta.url),
    env: environment,
    stdio: "inherit",
    detached: true
  });
  await waitForServer(baseUrl, server);
  const result = spawnSync("pnpm", ["exec", "playwright", "test"], { stdio: "inherit", env: environment });
  if (result.status !== 0) throw new Error(`Playwright exited with ${result.status}.`);
  status = "passed";
} finally {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* The owned server already exited. */ }
  }
  if (!dataDirectory.startsWith(join(tmpdir(), "internship-agent-browser-"))) {
    throw new Error("Refusing to clean an unexpected browser data directory.");
  }
  rmSync(dataDirectory, { recursive: true, force: true });
  const nextEnvRestored = restoreNextEnv();
  process.stdout.write(`BROWSER_RUN_REPORT ${JSON.stringify({
    schemaVersion: 1,
    status,
    durationMs: Math.round(performance.now() - startedAt),
    temporaryDataRemoved: true,
    nextEnvRestored
  })}\n`);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a verification port."));
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Verification server exited with ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Verification server did not become ready at ${url}.`);
}
