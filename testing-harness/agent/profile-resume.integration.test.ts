import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getBaseResume, getCurrentBaseResume, LOCAL_CANDIDATE_ID, seedDevelopmentData } from "@internship-agent/db";
import { baseResumeFilePath } from "@internship-agent/browser";
import { acquirePipelineLock } from "@internship-agent/agent";

import { runProfileResume, type ProfileResumeDeps } from "../../packages/agent/src/profile-resume";
import { minimalPdf } from "./application-record-fixture";

/**
 * `pnpm profile:resume` against a disposable workspace with fictional PDFs;
 * never the real profile.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-profile-resume-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  const dataDir = join(directory, "data");
  const files = new Map<string, Uint8Array>();
  const output: string[] = [];
  let closes = 0;
  const run = (argv: string[], extra: Partial<ProfileResumeDeps> = {}) => {
    output.splice(0);
    return runProfileResume(argv, {
      open: () => database,
      close: () => { closes += 1; },
      dataDir: () => dataDir,
      readFile: (path) => {
        const bytes = files.get(path);
        if (bytes === undefined) throw new Error("missing");
        return bytes;
      },
      log: (line) => { output.push(line); },
      ...extra
    });
  };
  return { database, dataDir, files, output, run, closes: () => closes };
}

const rowCount = (database: DatabaseSync) =>
  (database.prepare("SELECT COUNT(*) AS count FROM base_resumes").get() as { count: number }).count;

describe("pnpm profile:resume", () => {
  it("stores a one-page PDF byte for byte with its label, page count, and checksum", async () => {
    const { database, dataDir, files, output, run, closes } = workspace();
    const bytes = minimalPdf(1);
    files.set("/in/Jordan Rivera Resume.pdf", bytes);
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/Jordan Rivera Resume.pdf", "--label", "Resume (Expected May 2028)"])).toBe(0);
    expect(output).toEqual([expect.stringMatching(
      new RegExp(`^stored default "Resume \\(Expected May 2028\\)" \\(originally Jordan Rivera Resume\\.pdf\\): 1 page, [0-9.]+ KB, sha256 ${sha256(bytes)}$`)
    )]);
    const current = getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "default")!;
    expect(current).toMatchObject({ label: "Resume (Expected May 2028)", originalName: "Jordan Rivera Resume.pdf", sha256: sha256(bytes) });
    const path = baseResumeFilePath(dataDir, current.fileName);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(closes()).toBe(1);
  });

  it("supersedes the channel's previous upload, warns on a PDF that is not one page, and keeps the channels apart", async () => {
    const { database, files, output, run } = workspace();
    files.set("/in/one.pdf", minimalPdf(1));
    files.set("/in/two.pdf", minimalPdf(2));
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/one.pdf", "--label", "First"])).toBe(0);
    const first = getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "default")!;

    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/two.pdf", "--label", "Second"])).toBe(0);
    expect(output[0]).toMatch(/^stored default "Second" \(originally two\.pdf\): 2 pages, /);
    expect(output).toContain(`superseded default "First" (sha256 ${first.sha256.slice(0, 12)}…)`);
    expect(output).toContain("warning: this PDF has 2 pages; applications expect a one-page resume.");
    expect(getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "default")?.label).toBe("Second");
    expect(getBaseResume(database, first.id)?.supersededAt).not.toBe(null);

    expect(await run(["--profile", "demo", "--channel", "handshake_internal", "--file", "/in/one.pdf", "--label", "2029"])).toBe(0);
    expect(output.some((line) => line.startsWith("superseded"))).toBe(false);
    expect(getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "handshake_internal")?.label).toBe("2029");
    expect(getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "default")?.label).toBe("Second");
  });

  it("skips identical bytes and writes nothing on a dry run", async () => {
    const { database, dataDir, files, output, run } = workspace();
    const bytes = minimalPdf(1);
    files.set("/in/r.pdf", bytes);
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/r.pdf", "--label", "Resume"])).toBe(0);
    const before = rowCount(database);
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/r.pdf", "--label", "Again"])).toBe(0);
    expect(output).toEqual([`unchanged default "Resume": already the current upload (sha256 ${sha256(bytes)})`]);
    expect(rowCount(database)).toBe(before);

    files.set("/in/new.pdf", minimalPdf(3));
    const stored = readdirSync(join(dataDir, "resumes")).length;
    expect(await run(["--profile", "demo", "--channel", "handshake_internal", "--file", "/in/new.pdf", "--dry-run"])).toBe(0);
    expect(output[0]).toMatch(/^would store handshake_internal "Handshake resume" \(originally new\.pdf\): 3 pages, /);
    expect(output).toContain("warning: this PDF has 3 pages; applications expect a one-page resume.");
    expect(rowCount(database)).toBe(before);
    expect(readdirSync(join(dataDir, "resumes")).length).toBe(stored);
  });

  it("refuses non-PDFs, bad arguments, and a held pipeline lock", async () => {
    const { database, dataDir, files, output, run } = workspace();
    const before = rowCount(database);
    files.set("/in/resume.md", new TextEncoder().encode("# Resume"));
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/resume.md"])).toBe(1);
    expect(output).toEqual(["Base resumes must be PDF files."]);
    expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/absent.pdf"])).toBe(1);
    expect(output).toEqual(["The PDF could not be read."]);

    for (const argv of [
      ["--channel", "default", "--file", "/in/r.pdf"],
      ["--profile", "demo", "--file", "/in/r.pdf"],
      ["--profile", "demo", "--channel", "default"],
      ["--profile", "demo", "--channel", "bogus", "--file", "/in/r.pdf"],
      ["--profile", "demo", "--dry-run"],
      ["--profile", "demo", "--label", "x"],
      ["--profile", "demo", "--unknown"]
    ]) {
      expect(await run(argv)).toBe(2);
      expect(output[0]).toMatch(/^Usage: pnpm profile:resume/);
    }

    files.set("/in/r.pdf", minimalPdf(1));
    const release = acquirePipelineLock(dataDir);
    try {
      expect(await run(["--profile", "demo", "--channel", "default", "--file", "/in/r.pdf"])).toBe(1);
      expect(output[0]).toMatch(/^Not stored: A pipeline run is already in progress/);
    } finally {
      release();
    }
    expect(rowCount(database)).toBe(before);
    expect(existsSync(join(dataDir, "resumes"))).toBe(false);
  });

  it("lists the current uploads and flags a file that changed on disk", async () => {
    const { database, dataDir, files, output, run } = workspace();
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output).toEqual(["default: none", "handshake_internal: none"]);

    files.set("/in/a.pdf", minimalPdf(1));
    files.set("/in/b.pdf", minimalPdf(2));
    await run(["--profile", "demo", "--channel", "default", "--file", "/in/a.pdf", "--label", "Default"]);
    await run(["--profile", "demo", "--channel", "handshake_internal", "--file", "/in/b.pdf", "--label", "2029"]);
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output[0]).toMatch(new RegExp(`^default "Default" \\(originally a\\.pdf\\): 1 page, [0-9.]+ KB, sha256 ${sha256(minimalPdf(1))}, stored `));
    expect(output[1]).toMatch(/^handshake_internal "2029" \(originally b\.pdf\): 2 pages, /);

    const alternate = getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "handshake_internal")!;
    appendFileSync(baseResumeFilePath(dataDir, alternate.fileName), "tampered");
    expect(await run(["--profile", "demo"])).toBe(0);
    expect(output[1]).toBe(`handshake_internal "2029" (originally b.pdf): file changed on disk; upload it again`);
  });
});
