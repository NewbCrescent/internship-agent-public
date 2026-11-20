import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { listApplicationEvents } from "@internship-agent/db";
import { applicationRecordPdfPath, countPdfPages } from "@internship-agent/browser";

import { cleanupTemporaryDirectories, disposableWorkspace, submitExternal, TRANSCRIPT_CONTROLS } from "./application-record-fixture";

/**
 * The real record writer with headless Chromium after a fake-page submission,
 * then `pnpm application:record` regenerating it, all in a temporary
 * workspace (the demo profile pointed at it); no network, no real profile.
 */
afterEach(() => cleanupTemporaryDirectories());

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("application record with real Chromium", () => {
  it("writes the record after submission and regenerates it with the CLI without printing paths", async () => {
    const { dataDir, database } = disposableWorkspace();
    const { jobId } = await submitExternal({ database, dataDir, controls: TRANSCRIPT_CONTROLS, applicationRecord: undefined });
    const recordPath = applicationRecordPdfPath(dataDir, jobId);
    expect(existsSync(recordPath)).toBe(true);
    const bytes = readFileSync(recordPath);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(countPdfPages(bytes)).toBeGreaterThanOrEqual(4);
    expect(listApplicationEvents(database, jobId).filter((event) => event.detail === "Application record saved locally.")).toHaveLength(1);
    database.close();

    rmSync(recordPath);
    const cli = spawnSync(process.execPath, ["--import", "tsx", "packages/agent/scripts/application-record.ts", "--profile", "demo"], {
      cwd: REPO_ROOT,
      env: { ...process.env, INTERNSHIP_AGENT_DATA_DIR: dataDir },
      encoding: "utf8"
    });
    expect(cli.status).toBe(0);
    expect(existsSync(recordPath)).toBe(true);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(cli.stdout).toContain("APPLICATION_RECORD_REPORT");
    expect(cli.stdout).toContain('"saved":1');
    expect(cli.stdout).not.toContain(dataDir);
  }, 90_000);
});
