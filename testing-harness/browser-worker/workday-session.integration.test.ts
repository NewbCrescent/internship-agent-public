import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquirePipelineLock,
  browserProfileBusy,
  connectWorkdaySite,
  getWorkdaySession,
  listWorkdaySites,
  type WorkdaySessionWindow
} from "@internship-agent/agent";
import { createDatabase, getBrowserSession, persistNormalizedPosting, saveBrowserSession, setJobStatus } from "@internship-agent/db";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-workday-"));
  directories.push(directory);
  return directory;
}

function workdayJob(database: DatabaseSync, company: string, url: string, status: "READY_FOR_REVIEW" | "NOT_QUALIFIED" = "READY_FOR_REVIEW"): string {
  const { jobId } = persistNormalizedPosting(database, {
    companyName: company, title: `Software Intern at ${company}`, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: url, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `hash-${url}`,
    normalizedText: `Software Intern at ${company}\nFixture Workday posting.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  setJobStatus(database, jobId, null, status, "Fixture status.");
  return jobId;
}

function stubWindow(answers: Array<boolean | null>): WorkdaySessionWindow & { opened: string[] } {
  let polls = 0;
  const opened: string[] = [];
  return {
    opened,
    urls: () => [],
    isClosed: () => polls >= answers.length,
    close: async () => {},
    signedIn: async () => answers[polls++] ?? null
  };
}

describe("Workday sessions", () => {
  it("keeps Handshake sessions through the migration and stores one row per Workday site", () => {
    const database = createDatabase(join(temporary(), "test.sqlite"));
    saveBrowserSession(database, { site: "handshake", status: "connected", detail: "Signed in.", checkedAt: new Date().toISOString() });
    saveBrowserSession(database, { site: "workday:ngc.wd1.myworkdayjobs.com/External", status: "signed_out", detail: "Not yet.", checkedAt: new Date().toISOString() });
    expect(getBrowserSession(database, "handshake")?.status).toBe("connected");
    expect(getWorkdaySession("workday:ngc.wd1.myworkdayjobs.com/External", database)?.status).toBe("signed_out");
    expect(() => database.prepare("INSERT INTO browser_sessions (site, status, detail, checked_at) VALUES (?, ?, ?, ?)")
      .run("lever", "connected", "x", new Date().toISOString())).toThrow();
    database.close();
  });

  it("groups waiting applications by Workday site", () => {
    const database = createDatabase(join(temporary(), "test.sqlite"));
    workdayJob(database, "Northrop", "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1");
    workdayJob(database, "Northrop", "https://ngc.wd1.myworkdayjobs.com/en-US/External/job/US-CA/Intern_R2");
    workdayJob(database, "Philips", "https://philips.wd3.myworkdayjobs.com/jobs-and-careers/job/Cambridge/Intern_R3");
    workdayJob(database, "Closed Co", "https://closed.wd5.myworkdayjobs.com/External/job/X/Intern_R4", "NOT_QUALIFIED");
    const sites = listWorkdaySites(database);
    expect(sites.map((site) => [site.siteKey, site.applications])).toEqual([
      ["workday:ngc.wd1.myworkdayjobs.com/External", 2],
      ["workday:philips.wd3.myworkdayjobs.com/jobs-and-careers", 1]
    ]);
    expect(sites[0]!.companies).toEqual(["Northrop"]);
    database.close();
  });

  it("records the last sign-in state Workday reported before the window closed", async () => {
    const dataDir = temporary();
    const database = createDatabase(join(dataDir, "test.sqlite"));
    workdayJob(database, "Northrop", "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1");
    const siteKey = "workday:ngc.wd1.myworkdayjobs.com/External";
    const opened: string[] = [];
    const signedIn = await connectWorkdaySite(siteKey, {
      database, dataDir, pollMs: 1,
      openWindow: async (url) => { opened.push(url); return stubWindow([false, null, true, null]); }
    });
    expect(opened).toEqual(["https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1"]);
    expect(signedIn).toMatchObject({ site: siteKey, status: "connected" });
    const abandoned = await connectWorkdaySite(siteKey, { database, dataDir, pollMs: 1, openWindow: async () => stubWindow([false, false]) });
    expect(abandoned.status).toBe("signed_out");
    const silent = await connectWorkdaySite(siteKey, { database, dataDir, pollMs: 1, openWindow: async () => stubWindow([null]) });
    expect(silent.status).toBe("unknown");
    database.close();
  });

  it("refuses to open a sign-in window while a pipeline run holds the browser", async () => {
    const dataDir = temporary();
    const database = createDatabase(join(dataDir, "test.sqlite"));
    workdayJob(database, "Northrop", "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1");
    const release = acquirePipelineLock(dataDir);
    try {
      expect(browserProfileBusy(dataDir)).toContain("pipeline run");
      await expect(connectWorkdaySite("workday:ngc.wd1.myworkdayjobs.com/External", {
        database, dataDir, openWindow: async () => { throw new Error("must not open"); }
      })).rejects.toThrow("pipeline run");
    } finally {
      release();
    }
    database.close();
  });
});
