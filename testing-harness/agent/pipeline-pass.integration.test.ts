import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addCompanySource, readDoorbellState } from "@internship-agent/agent";
import { closeProfileDatabase, createDatabase, resolveProfileDatabasePath, resolveProfileDataDirectory } from "@internship-agent/db";

import { runPipelinePass, runWatchTick } from "../../packages/agent/scripts/pipeline-pass";
import type { DiscordFetch } from "../../packages/agent/src/discord-notify";
import type { PipelineReport } from "../../packages/agent/src/pipeline-orchestrator";

/**
 * The watcher and its pass share one cached handle per workspace. Against a
 * temporary data directory with no network: a GitHub fetcher and a source
 * fetch are injected, and the workspace has no postings, so the pass opens
 * no browser and calls no model.
 */
const LIST_URL = "https://github.com/SimplifyJobs/Summer2027-Internships";
const sha = (digit: string) => digit.repeat(40);
const pipelineEnv = ["INTERNSHIP_AGENT_AUTO_APPLY", "INTERNSHIP_AGENT_AUTO_SUBMIT", "INTERNSHIP_AGENT_TARGET_TERM", "GITHUB_TOKEN",
  "INTERNSHIP_AGENT_DISCORD_BOT_TOKEN", "INTERNSHIP_AGENT_DISCORD_USER_ID"];

let directory = "";
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "internship-agent-pass-"));
  saved = Object.fromEntries(["INTERNSHIP_AGENT_DATA_DIR", ...pipelineEnv].map((name) => [name, process.env[name]]));
  process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
  for (const name of pipelineEnv) delete process.env[name];
  // Seed the temporary real workspace with one watched list, outside the shared cache.
  const seed = createDatabase(resolveProfileDatabasePath("real"));
  addCompanySource("Simplify Summer 2027", LIST_URL, 6, seed);
  seed.close();
});

afterEach(() => {
  closeProfileDatabase("real");
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("pipeline watcher pass", () => {
  it("runs the pass after its own sources read, tick after tick in one process, and releases the lock", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    expect(dataDir.startsWith(directory)).toBe(true);
    let head = sha("a");
    const fetcher = async () => new Response(head, { headers: { etag: `"${head.slice(0, 4)}"` } });
    const fetched: string[] = [];
    const fetchBatch = async (source: { label: string; url: string }) => { fetched.push(source.url); return []; };

    for (const next of ["a", "b"]) {
      head = sha(next);
      const lines: string[] = [];
      await runWatchTick({ profile: "real", log: (line) => lines.push(line), fetcher, fetchBatch });
      expect(lines.filter((line) => line.startsWith("Pass failed"))).toEqual([]);
      expect(lines).toContain("Doorbell: new commits on Simplify Summer 2027.");
      // The pass opened the workspace, reached the source, and finished.
      expect(lines, lines.join("\n")).toContainEqual(expect.stringMatching(/^Workspace real;/));
      expect(lines, lines.join("\n")).toContainEqual(expect.stringMatching(/^Analyzed 0 left over;/));
      expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
      expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);
      // Saved only after a pass that finished.
      expect(Object.values(readDoorbellState(dataDir))[0]?.sha).toBe(sha(next));
    }
    // The first pass fetched the list; the second, a minute's rate limit later, still opened the workspace and finished.
    expect(fetched).toEqual([LIST_URL]);
  });

  it("releases the pipeline lock when the pass fails early", async () => {
    const dataDir = resolveProfileDataDirectory("real");
    const failingLog = () => { throw new Error("log unavailable"); };
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: failingLog })).rejects.toThrow("log unavailable");
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    // The next pass can take the lock and open the workspace again.
    const lines: string[] = [];
    await runPipelinePass({ profile: "real", sourceIds: [], log: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^Workspace real;/);
  });

  it("DMs what is new after releasing the lock, once per item, and a failed DM never fails the pass", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = "123456789012345678";
    const dataDir = resolveProfileDataDirectory("real");
    const report: PipelineReport = {
      analyzed: [], prepared: [], started: [], stopped: [], waiting: [], held: [], skipped: [],
      submitted: [{ jobId: "9f0c2f4e-0000-4000-8000-000000000001", confirmation: "Thanks" }],
      errors: ["Preparation failed for x: boom"]
    };
    const advance = async () => report;

    const failing: DiscordFetch = async () => new Response("{}", { status: 500 });
    const failedLines: string[] = [];
    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: (line) => failedLines.push(line), advance, notify: { fetch: failing } }))
      .resolves.toBe(report);
    expect(failedLines).toContain("Discord notify failed: 500");
    for (const line of failedLines) expect(line).not.toContain(TOKEN);
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(existsSync(join(dataDir, "pipeline-status.json"))).toBe(true);

    const { fetch, calls, contents } = recordingFetch(dataDir);
    await runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } });
    expect(calls).toEqual([false, false]);
    const sent = contents.join("\n");
    expect(sent).toContain("Preparation failed for x: boom");
    expect(sent).toContain("Unknown posting (job ");
    expect(sent).not.toContain("Thanks");

    await runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } });
    expect(calls).toHaveLength(2);
  });

  it("a pass that throws still releases the lock, notifies the failure once, and rethrows", async () => {
    process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN = TOKEN;
    process.env.INTERNSHIP_AGENT_DISCORD_USER_ID = "123456789012345678";
    const dataDir = resolveProfileDataDirectory("real");
    const advance = async (): Promise<PipelineReport> => { throw new Error("database is not open"); };
    const { fetch, calls, contents } = recordingFetch(dataDir);

    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } }))
      .rejects.toThrow("database is not open");
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(calls).toEqual([false, false]);
    expect(contents.join("\n")).toContain("Pass failed: database is not open");

    await expect(runPipelinePass({ profile: "real", sourceIds: [], log: () => undefined, advance, notify: { fetch } }))
      .rejects.toThrow("database is not open");
    expect(calls).toHaveLength(2);
  });
});

const TOKEN = "tok-SECRET-123";

/** A Discord fetch that answers the DM channel and the message, recording whether the pipeline lock was held at each call. */
function recordingFetch(dataDir: string) {
  const calls: boolean[] = [];
  const contents: string[] = [];
  const fetch: DiscordFetch = async (url, init) => {
    calls.push(existsSync(join(dataDir, "pipeline.lock")));
    if (url.endsWith("/users/@me/channels")) return new Response(JSON.stringify({ id: "987654321" }), { status: 200 });
    contents.push(String((JSON.parse(String(init.body)) as { content: unknown }).content));
    return new Response("{}", { status: 200 });
  };
  return { fetch, calls, contents };
}
