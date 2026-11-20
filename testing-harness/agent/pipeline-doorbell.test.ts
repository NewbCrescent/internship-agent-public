import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { displayEnvironment, launchdPlist, readDoorbellState, ringListDoorbell, scheduleLabel, shellQuote, systemdUnits, writeDoorbellState } from "@internship-agent/agent";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const sources = [
  { id: "simplify", url: "https://github.com/SimplifyJobs/Summer2027-Internships" },
  { id: "vansh", url: "https://github.com/vanshb03/Summer2027-Internships" },
  { id: "board", url: "https://boards.greenhouse.io/example" }
];
const sha = (digit: string) => digit.repeat(40);

describe("list doorbell", () => {
  it("rings every list once on first sight, then stays quiet on 304", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const first = await ringListDoorbell(sources, {}, {
      token: "fixture-token",
      fetcher: async (url, init) => {
        seen.push({ url, headers: init?.headers as Record<string, string> });
        return new Response(url.includes("Simplify") ? sha("a") : sha("b"), { headers: { etag: url.includes("Simplify") ? '"e1"' : '"e2"' } });
      }
    });
    // The public board is not a GitHub list and is never asked.
    expect(seen.map((entry) => entry.url)).toEqual([
      "https://api.github.com/repos/SimplifyJobs/Summer2027-Internships/commits/HEAD",
      "https://api.github.com/repos/vanshb03/Summer2027-Internships/commits/HEAD"
    ]);
    expect(seen[0]!.headers).toMatchObject({ accept: "application/vnd.github.sha", authorization: "Bearer fixture-token" });
    expect(seen[0]!.headers["if-none-match"]).toBeUndefined();
    expect(first.changed).toEqual(["simplify", "vansh"]);

    const asked: Array<string | undefined> = [];
    const second = await ringListDoorbell(sources, first.state, {
      fetcher: async (_url, init) => { asked.push((init?.headers as Record<string, string>)["if-none-match"]); return new Response(null, { status: 304 }); }
    });
    expect(asked).toEqual(['"e1"', '"e2"']);
    expect(second.changed).toEqual([]);
    expect(second.state.simplify!.sha).toBe(sha("a"));
  });

  it("rings only the list with a new commit, and treats errors as no change", async () => {
    const state = {
      simplify: { etag: '"e1"', sha: sha("a"), checkedAt: "2026-11-17T00:00:00.000Z" },
      vansh: { etag: '"e2"', sha: sha("b"), checkedAt: "2026-11-17T00:00:00.000Z" }
    };
    const result = await ringListDoorbell(sources, state, {
      fetcher: async (url) => url.includes("Simplify") ? new Response(sha("c"), { headers: { etag: '"e3"' } }) : new Response("rate limited", { status: 403 })
    });
    expect(result.changed).toEqual(["simplify"]);
    expect(result.errors).toEqual(["vanshb03/Summer2027-Internships: GitHub answered 403."]);
    expect(result.state.vansh).toEqual(state.vansh);
    expect(result.state.simplify).toMatchObject({ etag: '"e3"', sha: sha("c") });
  });

  it("keeps its state in the workspace and starts fresh from a damaged file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "doorbell-"));
    directories.push(dataDir);
    expect(readDoorbellState(dataDir)).toEqual({});
    const state = { simplify: { etag: null, sha: sha("a"), checkedAt: "2026-11-17T00:00:00.000Z" } };
    writeDoorbellState(dataDir, state);
    expect(readDoorbellState(dataDir)).toEqual(state);
    writeFileSync(join(dataDir, "list-doorbell.json"), "{not json");
    expect(readDoorbellState(dataDir)).toEqual({});
  });
});

describe("doorbell schedule", () => {
  const options = { repository: "/Users/someone/Side Projects/it's-here", profile: "real" as const, intervalSeconds: 300, logDirectory: "/data/logs/" };

  it("writes a launchd agent that runs one check from a login shell", () => {
    const plist = launchdPlist(options);
    expect(scheduleLabel("real")).toBe("com.internship-agent.watch.real");
    expect(plist).toContain("<key>Label</key><string>com.internship-agent.watch.real</string>");
    expect(plist).toContain("<string>/bin/zsh</string><string>-lc</string>");
    expect(plist).toContain("cd &apos;".replace("&apos;", "'") + "/Users/someone/Side Projects/it'\\''s-here' &amp;&amp; exec pnpm pipeline:watch --once --profile real");
    expect(plist).toContain("<key>StartInterval</key><integer>300</integer>");
    expect(plist).toContain("<string>/data/logs/launchd.log</string>");
  });

  it("writes a systemd user service and timer", () => {
    const units = systemdUnits({ ...options, repository: "/home/someone/agent" });
    expect(units.service).toContain('ExecStart=/bin/bash -lc "cd \'/home/someone/agent\' && exec pnpm pipeline:watch --once --profile real"');
    expect(units.timer).toContain("OnUnitActiveSec=300");
    expect(units.timer).toContain("Persistent=true");
    // Without a display at install time, the unit sets none.
    expect(units.service).not.toContain("Environment=");
  });

  it("gives the systemd service the installer's display so runs can open a visible browser", () => {
    const units = systemdUnits({ ...options, repository: "/home/someone/agent", display: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } });
    expect(units.service).toContain("Environment=DISPLAY=:0\nEnvironment=WAYLAND_DISPLAY=wayland-0\nExecStart=");
    // Unset, blank, or unsafe values are left out rather than written into the unit.
    const odd = systemdUnits({ ...options, display: { DISPLAY: ":0\nExecStartPre=/bin/false", WAYLAND_DISPLAY: "  " } });
    expect(odd.service).not.toContain("Environment=");
    expect(displayEnvironment({ DISPLAY: " :1 " })).toEqual([["DISPLAY", ":1"]]);
  });

  it("runs the service on an Xvfb virtual screen when one is installed, without the desktop display", () => {
    const units = systemdUnits({ ...options, repository: "/home/someone/agent", virtualDisplay: "/usr/bin/xvfb-run", display: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } });
    expect(units.service).toContain('ExecStart=/usr/bin/xvfb-run -a /bin/bash -lc "cd \'/home/someone/agent\' && exec pnpm pipeline:watch --once --profile real"');
    expect(units.service).not.toContain("Environment=");
    // A relative or odd path is ignored, falling back to the installer's display.
    expect(systemdUnits({ ...options, virtualDisplay: "xvfb-run; rm", display: { DISPLAY: ":0" } }).service).toContain("Environment=DISPLAY=:0\nExecStart=/bin/bash");
  });

  it("quotes shell arguments safely", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
