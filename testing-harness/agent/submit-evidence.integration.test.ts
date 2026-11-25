import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  applicationHoldTrace, createDatabase, listApplicationEvents, logApplicationEvent, persistNormalizedPosting, saveApplicationPackage,
  saveBrowserRun, saveVerificationReport, setJobStatus, updateBrowserRun
} from "@internship-agent/db";
import type { BrowserRun } from "@internship-agent/domain";
import {
  createAshbyDiagnosticsRecorder,
  createAshbyNetworkRecorder,
  scrubValuesFrom,
  submitEvidenceRoot,
  type BrowserPage,
  type PostSubmitEvidence
} from "@internship-agent/browser";
import {
  describeAshbyDiagnostics,
  describeAshbyNetwork,
  readJobEvidence,
  readSubmitEvidence,
  redactEvidenceText,
  runEvidenceCommand,
  savePostSubmitEvidence,
  savePostSubmitEvidenceQuietly,
  submitEvidenceFileSchema
} from "@internship-agent/agent";
import { refreshApplicationHolds } from "../../packages/agent/src/application-holds";
import { answerRunPause, continueBrowserRun } from "../../packages/agent/src/browser-orchestrator";
import { buildAgentPrompt, deliverManagerAudit, readPipelineAudit } from "../../packages/agent/scripts/pipeline-audit";

/**
 * Post-submit evidence (submit-evidence.ts) against a disposable SQLite
 * database and data directory: private files, redaction, the timeline event,
 * quiet failure, reads, and `pnpm run:evidence`, including Workday stops
 * saved for the job before any run existed. Fictional data only; fake pages;
 * no browser, no network, no model, nothing sent to Discord.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function disposableDatabase(): DatabaseSync {
  return createDatabase(join(disposableDirectory("internship-agent-evidence-"), "test.sqlite"));
}

describe("pipeline audit of Workday account stops", () => {
  const WAIT = "Automatic browser run waiting: Workday fixture.wd1.myworkdayjobs.com: ";
  const TIMEOUT = WAIT + "the account step stopped (Workday did not answer the create-account submit within 60 seconds; no same-host request observed; no page transition observed, and the sign-in after it stopped (a page the agent does not recognize)).";

  function readyJob(database: DatabaseSync, company: string, blocked = false): { jobId: string; packageId: string; sourceUrl: string } {
    const title = "Engineering Intern";
    const sourceUrl = `https://fixture.wd1.myworkdayjobs.com/en-US/careers/job/${company}`;
    const { jobId } = persistNormalizedPosting(database, {
      companyName: company, title, employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
      sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `hash-${sourceUrl}`,
      normalizedText: title, locations: [], compensation: null, requirements: [], technologies: [],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
    const packageId = randomUUID();
    const at = new Date().toISOString();
    saveApplicationPackage(database, { id: packageId, jobId, createdAt: at, summary: "Verified fixture", answers: [], bullets: [], claims: [] });
    saveVerificationReport(database, { packageId, jobId, verifiedAt: at, checks: [], blocked });
    setJobStatus(database, jobId, "DISCOVERED", "READY_FOR_REVIEW");
    return { jobId, packageId, sourceUrl };
  }

  function wait(database: DatabaseSync, jobId: string, detail = TIMEOUT): void {
    logApplicationEvent(database, { jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "READY_FOR_REVIEW", detail });
  }

  it("includes a verified posting with a pre-run timeout in the agent prompt without exposing the event text", () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-audit-data-");
    const { jobId } = readyJob(database, "FixtureTimeout");
    wait(database, jobId, TIMEOUT + " fixture-private-context");

    const audit = readPipelineAudit(database, dataDir);
    expect(audit.total).toBe(0);
    expect(audit.categories.ATS_BUG).toEqual([expect.objectContaining({ jobId, runId: null, ats: "workday" })]);
    const prompt = buildAgentPrompt(audit);
    expect(prompt).toContain("FixtureTimeout");
    expect(prompt).toContain("Workday account step timed out");
    expect(prompt).toContain(`Job ID: ${jobId.slice(0, 8)}`);
    expect(prompt).not.toContain("fixture-private-context");
    expect(prompt).not.toContain("no same-host request observed");
    expect(prompt).not.toContain("no page transition observed");
    database.close();
  });

  it("skips a timeout superseded by a manual gate, a later browser run, or a blocked verification", () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-audit-data-");
    const captcha = readyJob(database, "FixtureCaptcha");
    const signIn = readyJob(database, "FixtureSignIn");
    const started = readyJob(database, "FixtureStarted");
    const blocked = readyJob(database, "FixtureBlocked", true);
    for (const { jobId } of [captcha, signIn, started, blocked]) wait(database, jobId);
    wait(database, captcha.jobId, WAIT + "Workday shows a CAPTCHA, and the agent never solves CAPTCHAs.");
    wait(database, signIn.jobId, WAIT + "the account step stopped (a text-message, app or other sign-in method).");
    const now = new Date().toISOString();
    saveBrowserRun(database, {
      id: randomUUID(), jobId: started.jobId, applicationUrl: started.sourceUrl, status: "awaiting-approval",
      packageId: started.packageId, variantId: null, baseResumeId: null, applicationProfile: "default",
      atsKind: "workday", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
      decisions: [], pauses: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: null,
      createdAt: now, updatedAt: now
    });

    const audit = readPipelineAudit(database, dataDir);
    expect(audit.categories.ATS_BUG).toEqual([]);
    expect(audit.categories.AWAITING_APPROVAL).toEqual([expect.objectContaining({ jobId: started.jobId })]);
    const prompt = buildAgentPrompt(audit);
    expect(prompt).not.toMatch(/FixtureCaptcha|FixtureSignIn|FixtureBlocked|account step timed out/);
    database.close();
  });

  it("reports a Workday timeout only when it is newer than a target skip", () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-audit-data-");
    const skipped = readyJob(database, "FixtureTargetSkip");
    const unresolved = readyJob(database, "FixtureUnresolved");
    const skip = "Not pursued for your target: Fit: AI score 30 (weak) is below the skip line of 50.";
    wait(database, skipped.jobId);
    wait(database, skipped.jobId, skip);
    wait(database, unresolved.jobId, skip);
    wait(database, unresolved.jobId);

    const audit = readPipelineAudit(database, dataDir);
    expect(audit.categories.ATS_BUG).toEqual([expect.objectContaining({ jobId: unresolved.jobId })]);
    expect(buildAgentPrompt(audit)).not.toContain("FixtureTargetSkip");
    database.close();
  });

  it("restarts without repeating delivered findings, retries failed injection, and traces resolution", () => {
    const dataDir = disposableDirectory("internship-agent-audit-data-");
    const dbPath = join(dataDir, "audit.sqlite");
    let database = createDatabase(dbPath);
    const prompts: string[] = [];
    const now = new Date("2026-11-22T10:00:00Z");
    const tick = (ok = true, idle = true) => deliverManagerAudit({
      database, dataDir, destination: "fixture-pane", now, idle: () => idle,
      inject(prompt) { prompts.push(prompt); return ok; }
    });
    const first = readyJob(database, "FixtureFirst");
    wait(database, first.jobId, TIMEOUT + " PRIVATE_HELD_PAGE");
    expect(tick(false)).toBe(false);
    expect(tick(true, false)).toBe(false);
    expect(tick()).toBe(true);
    database.close();

    database = createDatabase(dbPath);
    expect(tick()).toBe(false);
    const second = readyJob(database, "FixtureSecond");
    wait(database, second.jobId);
    expect(tick()).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("FixtureSecond");
    expect(prompts[2]).not.toContain("FixtureFirst");
    expect(prompts.join("\n")).not.toContain("PRIVATE_HELD_PAGE");
    wait(database, second.jobId, "Not pursued for your target: fixture");
    expect(tick()).toBe(false);
    expect(applicationHoldTrace(database, second.jobId).map((event) => event.event)).toEqual(["opened", "resolved"]);
    wait(database, second.jobId);
    expect(tick()).toBe(true);
    expect(applicationHoldTrace(database, second.jobId).map((event) => event.event)).toEqual(["opened", "resolved", "reopened"]);
    database.close();
  });
});

/** A synthetic applying posting with one failed run (fictional company). */
function syntheticRun(database: DatabaseSync, company = "Fixture Robotics", atsKind: BrowserRun["atsKind"] = "greenhouse"): BrowserRun {
  const title = "Software Engineering Intern";
  const sourceUrl = `https://example.test/internships/${company.toLowerCase().replace(/\W+/g, "-")}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: company, title, employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
    sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `hash-${sourceUrl}`,
    normalizedText: `${title}\nFixture posting for post-submit evidence.`, locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  database.prepare("UPDATE jobs SET status = 'APPLYING' WHERE id = ?").run(jobId);
  const packageId = randomUUID();
  database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
    .run(packageId, jobId, new Date().toISOString(), "{}");
  const now = new Date().toISOString();
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: sourceUrl, status: "failed", packageId, variantId: null,
    baseResumeId: null, applicationProfile: "default", atsKind, atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
    decisions: [], pauses: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: now, createdAt: now, updatedAt: now
  });
}

describe("post-submit hold evidence routing", () => {
  function withdrawApproval(database: DatabaseSync, run: BrowserRun) {
    updateBrowserRun(database, run.id, {
      status: "paused-needs-input", submissionApprovedAt: null,
      // The pause decision a field-errors hold leaves for the field (invalidFieldPauses).
      decisions: [{ fieldId: "school", action: "pause", value: null, basis: null, reason: "The site marked School invalid.", pause: null }],
      pauses: [{ fieldId: "school", label: "School", question: "School: invalid value", suggestedKey: null, suggestedScope: null,
        safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null }]
    });
  }

  const before = new Date("2026-11-20T09:00:00.000Z");
  const after = new Date("2026-11-20T10:00:00.000Z");
  /** The reopened application form, still showing the School field the answer fills (a page without it keeps the run paused). */
  const formPage = (): BrowserPage => ({ ...stubPage(), collectControls: async () => [{ tag: "input", type: "text", id: "school", label: "School", required: true }] });

  it("changes prior uncertainty when withdrawn approval and structured field errors explain it", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    expect(refreshApplicationHolds(database, dataDir, before)[0]).toMatchObject({ reason: "possible-submission", revision: 1 });
    withdrawApproval(database, run);
    await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence(), now: after });
    expect(refreshApplicationHolds(database, dataDir, after)[0]).toMatchObject({ owner: "candidate", reason: "candidate-question", revision: 2 });
    expect(applicationHoldTrace(database, run.jobId).map((event) => event.event)).toEqual(["opened", "changed"]);
    database.close();
  });

  it("retains an older conflicting capture as the uncertainty anchor if it disappears", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const unknown = await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence({ outcome: "unknown" }), now: before });
    const initial = refreshApplicationHolds(database, dataDir, before)[0]!;
    withdrawApproval(database, run);
    await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence(), now: after });
    expect(refreshApplicationHolds(database, dataDir, after)[0]).toEqual(initial);

    rmSync(join(dataDir, unknown.relativeDir), { recursive: true });
    expect(refreshApplicationHolds(database, dataDir, after)[0]).toEqual(initial);
    expect(refreshApplicationHolds(database, dataDir, after)[0]).toEqual(initial);
    database.close();
  });

  it.each(["field-errors", "refused"] as const)(
    "routes a continued run to candidate approval after fixing a %s pause",
    async (outcome) => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-evidence-data-");
      const run = syntheticRun(database, `Fixture ${outcome}`);
      withdrawApproval(database, run);
      await savePostSubmitEvidence({
        database,
        dataDir,
        run,
        page: stubPage(),
        evidence: evidence({
          outcome,
          invalidFields: [{ ref: "school", label: "School", error: "This field is required." }]
        }),
        now: after
      });
      await answerRunPause(run.id, "school", "UC Berkeley", false, { database });
      const continued = await continueBrowserRun(run.id, {
        database,
        dataDir,
        openPage: async () => formPage()
      });
      expect(continued.run.status).toBe("awaiting-approval");
      expect(continued.run.submissionApprovedAt).toBeNull();
      const holds = refreshApplicationHolds(database, dataDir, new Date("2026-11-20T10:30:00Z"));
      const hold = holds.find((h) => h.jobId === run.jobId);
      expect(hold).toMatchObject({ owner: "candidate", reason: "approval" });
      database.close();
    }
  );

  it.each([
    { outcome: "unknown" as const, invalidFields: [] },
    { outcome: "refused" as const, invalidFields: [] }
  ])(
    "keeps ambiguous $outcome submission held in possible-submission after continuation",
    async ({ outcome, invalidFields }) => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-evidence-data-");
      const run = syntheticRun(database, `Fixture Ambiguous ${outcome}`);
      withdrawApproval(database, run);
      await savePostSubmitEvidence({
        database,
        dataDir,
        run,
        page: stubPage(),
        evidence: evidence({ outcome, invalidFields }),
        now: after
      });
      await answerRunPause(run.id, "school", "UC Berkeley", false, { database });
      const continued = await continueBrowserRun(run.id, {
        database,
        dataDir,
        openPage: async () => formPage()
      });
      expect(continued.run.status).toBe("awaiting-approval");
      const holds = refreshApplicationHolds(database, dataDir, new Date("2026-11-20T10:30:00Z"));
      const hold = holds.find((h) => h.jobId === run.jobId);
      expect(hold).toMatchObject({ owner: "manager", reason: "possible-submission" });
      database.close();
    }
  );
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubPage(screenshot: "write" | "throw" = "write"): BrowserPage & { shots: Array<{ path: string; fullPage: boolean | undefined }> } {
  const shots: Array<{ path: string; fullPage: boolean | undefined }> = [];
  return {
    shots,
    url: () => "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001",
    title: async () => "Apply",
    collectControls: async () => [],
    bodyText: async () => "",
    fillField: async () => {},
    chooseOption: async () => {},
    setChecked: async () => {},
    uploadFile: async () => {},
    clickSubmit: async () => { throw new Error("must not click"); },
    screenshot: async (path, options) => {
      shots.push({ path, fullPage: options?.fullPage });
      if (screenshot === "throw") throw new Error("Target page, context or browser has been closed");
      writeFileSync(path, PNG_BYTES);
    },
    close: async () => {}
  };
}

function evidence(overrides: Partial<PostSubmitEvidence> = {}): PostSubmitEvidence {
  return {
    outcome: "field-errors",
    url: "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001",
    bodyText: [
      "Apply for Software Engineering Intern",
      "",
      "Email: jordan@example.test",
      "Student number 12345678",
      "Resume link https://files.example.test/resume.pdf?signature=abc#page",
      "This field is required."
    ].join("\n"),
    invalidFields: [
      { ref: "email", label: "Email", error: "This field is required." },
      { ref: "school--0", label: "School", error: "This field is required." }
    ],
    alertText: "This field is required. Contact jordan@example.test",
    challenge: null,
    ...overrides
  };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const EVENT = /^Post-submit evidence saved \(field-errors\): applications\/[0-9a-f-]{36}\/submit-evidence\/[0-9TZ-]+-[0-9a-f-]{36}; view it with pnpm run:evidence --run [0-9a-f]{8}\.$/;

describe("post-submit evidence files", () => {
  it("writes a private folder with a full-page screenshot and redacted evidence, and logs only a relative path", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const page = stubPage();
    const saved = await savePostSubmitEvidence({ database, dataDir, run, page, evidence: evidence(), now: new Date("2026-11-20T10:15:00.123Z") });
    expect(saved.screenshotSaved).toBe(true);
    expect(saved.relativeDir).toBe(`applications/${run.jobId}/submit-evidence/2026-11-20T10-15-00-123Z-${run.id}`);
    const root = submitEvidenceRoot(dataDir, run.jobId);
    const dir = join(dataDir, saved.relativeDir);
    expect(mode(root)).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "evidence.json"))).toBe(0o600);
    expect(mode(join(dir, "screenshot.png"))).toBe(0o600);
    expect(page.shots).toEqual([{ path: join(dir, "screenshot.png"), fullPage: true }]);
    expect(readdirSync(dir).sort()).toEqual(["evidence.json", "screenshot.png"]);

    const raw = readFileSync(join(dir, "evidence.json"), "utf8");
    const stored = submitEvidenceFileSchema.parse(JSON.parse(raw));
    expect(stored).toMatchObject({
      version: 1, runId: run.id, jobId: run.jobId, capturedAt: "2026-11-20T10:15:00.123Z", outcome: "field-errors",
      url: "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001", screenshot: "screenshot.png", challenge: null
    });
    expect(stored.invalidFields).toEqual(evidence().invalidFields);
    expect(stored.alertText).toBe("This field is required. Contact [email]");
    expect(stored.text).toBe([
      "Apply for Software Engineering Intern",
      "Email: [email]",
      "Student number [number]",
      "Resume link https://files.example.test/resume.pdf",
      "This field is required."
    ].join("\n"));
    expect(raw).not.toContain("jordan@example.test");
    expect(raw).not.toContain("12345678");
    expect(raw).not.toContain("signature=");

    const events = listApplicationEvents(database, run.jobId).map((event) => event.detail ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(EVENT);
    expect(events[0]).not.toContain(dataDir);
    expect(events[0]).not.toContain(tmpdir());
    database.close();
  });

  it("caps the visible text at 20,000 characters", () => {
    expect(redactEvidenceText("a".repeat(30_000))).toHaveLength(20_000);
    expect(redactEvidenceText("one\r\n\r\n two  words \nthree")).toBe("one\ntwo words\nthree");
  });

  it("keeps evidence.json without a screenshot when the screenshot fails", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const saved = await savePostSubmitEvidence({ database, dataDir, run, page: stubPage("throw"), evidence: evidence({ outcome: "unknown", invalidFields: [] }) });
    expect(saved.screenshotSaved).toBe(false);
    const dir = join(dataDir, saved.relativeDir);
    expect(readdirSync(dir)).toEqual(["evidence.json"]);
    expect(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")).screenshot).toBeNull();
    database.close();
  });

  it("fails quietly with a plain event when the folder cannot be written", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    // A file where the applications folder should be.
    writeFileSync(join(dataDir, "applications"), "not a folder");
    await expect(savePostSubmitEvidenceQuietly({ database, dataDir, run, page: stubPage(), evidence: evidence() })).resolves.toBeUndefined();
    expect(listApplicationEvents(database, run.jobId).map((event) => event.detail)).toEqual(["Post-submit evidence not saved."]);
    database.close();
  });

  it("reads a run's evidence newest first and skips other runs and damaged files", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence({ outcome: "unknown" }), now: new Date("2026-11-20T09:00:00.000Z") });
    await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence({ outcome: "refused" }), now: new Date("2026-11-20T11:00:00.000Z") });
    await savePostSubmitEvidence({ database, dataDir, run: { ...run, id: randomUUID() }, page: stubPage(), evidence: evidence(), now: new Date("2026-11-20T12:00:00.000Z") });
    const damaged = join(submitEvidenceRoot(dataDir, run.jobId), "damaged");
    mkdirSync(damaged);
    writeFileSync(join(damaged, "evidence.json"), "{ not json");
    const read = readSubmitEvidence(dataDir, run);
    expect(read.map((entry) => entry.outcome)).toEqual(["refused", "unknown"]);
    expect(readSubmitEvidence(dataDir, { id: run.id, jobId: randomUUID() })).toEqual([]);
    database.close();
  });

  it("distinguishes the latest unconfirmed submission evidence from unproven ATS failures", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-audit-data-");
    const unknown = syntheticRun(database, "Fixture Unknown", "dover");
    const superseded = syntheticRun(database, "Fixture Superseded", "ashby");
    const missing = syntheticRun(database, "Fixture Missing", "smartrecruiters");
    const before = new Date("2026-11-20T09:00:00.000Z");
    const after = new Date("2026-11-20T10:00:00.000Z");
    const unconfirmed = evidence({ outcome: "unknown", text: "fixture-private-evidence" });
    await savePostSubmitEvidence({ database, dataDir, run: unknown, page: stubPage(), evidence: unconfirmed, now: after });
    await savePostSubmitEvidence({ database, dataDir, run: superseded, page: stubPage(), evidence: unconfirmed, now: before });
    await savePostSubmitEvidence({ database, dataDir, run: superseded, page: stubPage(), evidence: evidence({ outcome: "refused" }), now: after });

    const audit = readPipelineAudit(database, dataDir);
    expect(audit.categories.UNCONFIRMED_SUBMISSION).toEqual([expect.objectContaining({ runId: unknown.id })]);
    expect(audit.categories.RUN_NEEDS_REVIEW.map((item) => item.runId)).toEqual(expect.arrayContaining([superseded.id, missing.id]));
    expect(audit.categories.ATS_BUG).toEqual([]);
    const prompt = buildAgentPrompt(audit);
    expect(prompt).toContain("UNCONFIRMED SUBMISSIONS");
    expect(prompt).toContain("Fixture Unknown");
    expect(prompt).toContain("Confirm whether the employer received the application");
    expect(prompt).not.toMatch(/\bretry\b|fixture-private-evidence|modal dialog closed|SmartRecruiters application adapter issue/i);
    database.close();
  });

  it("takes no screenshot once an emailed security code was typed, and stores the verification-code outcome", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const page = stubPage();
    const saved = await savePostSubmitEvidence({
      database, dataDir, run, page,
      evidence: evidence({ outcome: "verification-code", invalidFields: [], alertText: "", bodyText: "Security code [code]", securityCodeEntered: true })
    });
    expect(saved.screenshotSaved).toBe(false);
    expect(page.shots).toEqual([]);
    const dir = join(dataDir, saved.relativeDir);
    expect(readdirSync(dir)).toEqual(["evidence.json"]);
    const stored = submitEvidenceFileSchema.parse(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")));
    expect(stored).toMatchObject({ outcome: "verification-code", screenshot: null, text: "Security code [code]" });
    // Before a code is typed, the hold's screenshot is taken as usual.
    const before = await savePostSubmitEvidence({ database, dataDir, run, page, evidence: evidence({ outcome: "verification-code" }), now: new Date("2026-11-20T08:00:00.000Z") });
    expect(before.screenshotSaved).toBe(true);
    expect(page.shots).toHaveLength(1);
    database.close();
  });

  it("saves a Workday account-step stop for the job, with no run and every secret redacted", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const password = "Fixture-Pass-9876!";
    const saved = await savePostSubmitEvidence({
      database, dataDir, run: { id: null, jobId: run.jobId }, page: stubPage(), now: new Date("2026-11-20T08:31:00.000Z"),
      secrets: ["Jordan@Example.test", password, ""],
      evidence: evidence({
        outcome: "workday-account",
        url: "https://fixture.wd5.myworkdayjobs.com/External/job/x/apply",
        bodyText: `Create Account\nEmail Address jordan@example.test\nPassword ${password}`,
        invalidFields: [{ ref: "formField-email", label: "Email Address", error: `Unknown user JORDAN@EXAMPLE.TEST` }],
        alertText: `Workday could not create the account for jordan@example.test`,
        detail: "Workday fixture.wd5.myworkdayjobs.com: Workday did not answer the create-account submit within 60 seconds."
      })
    });
    expect(saved.relativeDir).toBe(`applications/${run.jobId}/submit-evidence/2026-11-20T08-31-00-000Z-workday-account`);
    const raw = readFileSync(join(dataDir, saved.relativeDir, "evidence.json"), "utf8");
    expect(raw).not.toContain(password);
    expect(raw.toLocaleLowerCase("en-US")).not.toContain("jordan@example.test");
    const stored = submitEvidenceFileSchema.parse(JSON.parse(raw));
    expect(stored).toMatchObject({
      runId: null, jobId: run.jobId, outcome: "workday-account",
      detail: "Workday fixture.wd5.myworkdayjobs.com: Workday did not answer the create-account submit within 60 seconds.",
      text: "Create Account\nEmail Address [redacted]\nPassword [redacted]",
      alertText: "Workday could not create the account for [redacted]",
      invalidFields: [{ ref: "formField-email", label: "Email Address", error: "Unknown user [redacted]" }]
    });
    expect(listApplicationEvents(database, run.jobId).map((event) => event.detail)).toEqual([
      `Workday evidence saved (workday-account): ${saved.relativeDir}; view it with pnpm run:evidence --job ${run.jobId.slice(0, 8)}.`
    ]);
    expect(readJobEvidence(dataDir, run.jobId).map((entry) => entry.outcome)).toEqual(["workday-account"]);
    expect(readSubmitEvidence(dataDir, run)).toEqual([]);
    database.close();
  });

  it("names the run on a Workday errors capture and reads old files without a detail", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const saved = await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage(), evidence: evidence({ outcome: "workday-errors", detail: "Workday could not save My Information." })
    });
    expect(listApplicationEvents(database, run.jobId).map((event) => event.detail)).toEqual([
      `Workday evidence saved (workday-errors): ${saved.relativeDir}; view it with pnpm run:evidence --run ${run.id.slice(0, 8)}.`
    ]);
    const old = submitEvidenceFileSchema.parse({
      version: 1, runId: run.id, jobId: run.jobId, capturedAt: "2026-11-19T10:00:00.000Z", outcome: "unknown", url: "", invalidFields: [],
      alertText: "", challenge: null, text: "", screenshot: null
    });
    expect(old.detail).toBeNull();
    database.close();
  });
});

describe("pnpm run:evidence", () => {
  function deps(database: DatabaseSync, dataDir: string) {
    const lines: string[] = [];
    const closed: string[] = [];
    return {
      lines,
      closed,
      io: {
        open: () => database,
        close: (profile: string) => { closed.push(profile); },
        dataDir: () => dataDir,
        log: (line: string) => { lines.push(line); }
      }
    };
  }

  it("prints usage for missing, unknown, or repeated flags", async () => {
    const database = disposableDatabase();
    const { io, lines } = deps(database, "/nonexistent/evidence-test");
    for (const argv of [[], ["--run"], ["--run", "abc", "--run", "def"], ["--run", "abc", "--all", "--all"], ["--run", "abc", "--profile", "other"], ["--bogus"],
      ["--run", "abc", "--job", "def"], ["--job"], ["--job", "abc", "--job", "def"]]) {
      expect(await runEvidenceCommand(argv, io)).toBe(2);
    }
    expect(new Set(lines)).toEqual(new Set(["Usage: pnpm run:evidence (--run <id or 8-character prefix> | --job <id or 8-character prefix>) [--all] [--profile real|demo]"]));
    database.close();
  });

  it("names a run it cannot find, and says when a run has no evidence", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const missing = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", "ffffffff"], missing.io)).toBe(1);
    expect(missing.lines).toEqual(['No browser run matches "ffffffff".']);
    const none = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", run.id.slice(0, 8), "--profile", "demo"], none.io)).toBe(0);
    expect(none.lines).toEqual([
      `Run ${run.id.slice(0, 8)}: Fixture Robotics — Software Engineering Intern (failed)`,
      "No post-submit evidence is stored for this run."
    ]);
    expect(none.closed).toEqual(["demo"]);
    database.close();
  });

  it("prints the newest evidence, or all of it with --all, never an email", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const older = await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage("throw"), now: new Date("2026-11-20T09:00:00.000Z"),
      evidence: evidence({ outcome: "challenged", invalidFields: [], alertText: "", challenge: "a reCAPTCHA image challenge", bodyText: "Verify you are human" })
    });
    const newer = await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence(), now: new Date("2026-11-20T10:15:00.000Z") });

    const latest = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", run.id], latest.io)).toBe(0);
    expect(latest.lines).toEqual([
      `Run ${run.id.slice(0, 8)}: Fixture Robotics — Software Engineering Intern (failed)`,
      "Evidence 1 of 2, captured 2026-11-20T10:15:00.000Z: field-errors (the site marked fields invalid)",
      "URL: https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001",
      "Invalid fields:",
      "  - Email: This field is required.",
      "  - School: This field is required.",
      "Site error text: This field is required. Contact [email]",
      `Screenshot: ${join(dataDir, newer.relativeDir, "screenshot.png")}`,
      "Visible text (redacted):",
      "Apply for Software Engineering Intern\nEmail: [email]\nStudent number [number]\nResume link https://files.example.test/resume.pdf\nThis field is required."
    ]);
    expect(latest.closed).toEqual(["real"]);

    const all = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", run.id.slice(0, 8), "--all"], all.io)).toBe(0);
    expect(all.lines.filter((line) => line.startsWith("Evidence "))).toEqual([
      "Evidence 1 of 2, captured 2026-11-20T10:15:00.000Z: field-errors (the site marked fields invalid)",
      "Evidence 2 of 2, captured 2026-11-20T09:00:00.000Z: challenged (a CAPTCHA appeared after the click)"
    ]);
    expect(all.lines).toContain("Invalid fields: none");
    expect(all.lines).toContain("Challenge: a reCAPTCHA image challenge");
    expect(all.lines).toContain("Screenshot: not saved");
    expect(older.screenshotSaved).toBe(false);
    expect(all.lines.join("\n")).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    database.close();
  });

  it("names the verification-code outcome and the skipped screenshot", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage(), now: new Date("2026-11-20T10:09:00.000Z"),
      evidence: evidence({ outcome: "verification-code", invalidFields: [], alertText: "", bodyText: "Security code", securityCodeEntered: true })
    });
    const shown = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", run.id], shown.io)).toBe(0);
    expect(shown.lines).toContain("Evidence 1 of 1, captured 2026-11-20T10:09:00.000Z: verification-code (the site asked for a security code it emailed)");
    expect(shown.lines).toContain("Screenshot: not saved");
    database.close();
  });

  it("prints a job's evidence, naming the run or its absence and the agent's detail", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const detail = "Workday fixture.wd5.myworkdayjobs.com: Workday did not answer the create-account submit within 60 seconds.";
    await savePostSubmitEvidence({
      database, dataDir, run: { id: null, jobId: run.jobId }, page: stubPage("throw"), now: new Date("2026-11-20T08:31:00.000Z"),
      evidence: evidence({ outcome: "workday-account", invalidFields: [], alertText: "", bodyText: "Create Account", detail })
    });
    await savePostSubmitEvidence({ database, dataDir, run, page: stubPage("throw"), evidence: evidence({ outcome: "unknown" }), now: new Date("2026-11-20T07:00:00.000Z") });

    const latest = deps(database, dataDir);
    expect(await runEvidenceCommand(["--job", run.jobId.slice(0, 8)], latest.io)).toBe(0);
    expect(latest.lines.slice(0, 5)).toEqual([
      `Job ${run.jobId.slice(0, 8)}: Fixture Robotics — Software Engineering Intern (APPLYING)`,
      "Evidence 1 of 2, captured 2026-11-20T08:31:00.000Z: workday-account (the Workday account step stopped)",
      "Run: none (the account step stopped before a run was saved)",
      "URL: https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001",
      `Detail: ${detail}`
    ]);
    const all = deps(database, dataDir);
    expect(await runEvidenceCommand(["--job", run.jobId, "--all"], all.io)).toBe(0);
    expect(all.lines).toContain(`Run: ${run.id.slice(0, 8)}`);
    expect(all.lines.filter((line) => line.startsWith("Detail: "))).toEqual([`Detail: ${detail}`]);
    // The run's own view leaves out the job-level capture.
    const byRun = deps(database, dataDir);
    expect(await runEvidenceCommand(["--run", run.id, "--all"], byRun.io)).toBe(0);
    expect(byRun.lines.filter((line) => line.startsWith("Evidence "))).toEqual(["Evidence 1 of 1, captured 2026-11-20T07:00:00.000Z: unknown (no confirmation was recognized)"]);

    const missing = deps(database, dataDir);
    expect(await runEvidenceCommand(["--job", "ffffffff"], missing.io)).toBe(1);
    expect(missing.lines).toEqual(['No job matches "ffffffff".']);
    database.close();
  });

  it("says when a job has no evidence", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const none = deps(database, dataDir);
    expect(await runEvidenceCommand(["--job", run.jobId.slice(0, 8)], none.io)).toBe(0);
    expect(none.lines).toEqual([
      `Job ${run.jobId.slice(0, 8)}: Fixture Robotics — Software Engineering Intern (APPLYING)`,
      "No evidence is stored for this job."
    ]);
    database.close();
  });
});

describe("Ashby's network record in the evidence (Track 22)", () => {
  const PERSONAL = ["Jordan Rivera", "jordan.rivera@example.test", "jordan@example.test", "+1 555 010 0199", "tok-5c2d", "fp-77aa", "UNIVERSAL_ENT"];
  const ENTRY = "9a0b1c2d-0000-4000-8000-0000000000d1_0b1c2d3e-0000-4000-8000-0000000000d2";

  async function recordedNetwork() {
    const recorder = createAshbyNetworkRecorder();
    const save = {};
    recorder.request(save, "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue", () => JSON.stringify({ variables: { value: "Jordan Rivera" } }));
    recorder.response(save, 200, async () => JSON.stringify({ data: { value: "Jordan Rivera" } }));
    recorder.noteClick();
    const token = {};
    recorder.request(token, "https://www.recaptcha.net/recaptcha/enterprise/reload?k=fixture", () => null);
    recorder.response(token, 200, async () => "");
    const submit = {};
    recorder.request(submit, "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSubmitSingleApplicationFormAction", () => JSON.stringify({
      variables: { recaptchaToken: "UNIVERSAL_ENT===tok-5c2d", deviceFingerprint: "fp-77aa", answers: { name: "Jordan Rivera", email: "jordan.rivera@example.test", phone: "+1 555 010 0199" } }
    }));
    recorder.response(submit, 200, async () => JSON.stringify({
      errors: [{ message: "fixture", extensions: { ashbyErrorType: "FIXTURE_ERROR", message: "Contact jordan@example.test for help." } }],
      data: { submitApplicationFormAction: { applicationFormResult: {
        __typename: "FormRender",
        fieldValues: { name: "Jordan Rivera", email: "jordan.rivera@example.test", phone: "+1 555 010 0199" },
        errorMessages: ["Missing entry for required field: Visa Support"],
        formErrors: [{ message: "Missing entry for required field: Visa Support", fieldEntryId: ENTRY }]
      } } }
    }));
    return recorder.snapshot();
  }

  it("stores the record with its messages redacted and nothing personal, and reads older files as null", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const ashbyNetwork = await recordedNetwork();
    const saved = await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage(), now: new Date("2026-11-25T10:00:00.000Z"),
      evidence: evidence({ outcome: "unknown", url: "https://jobs.ashbyhq.com/fixturerobotics/1/application", invalidFields: [], alertText: "", bodyText: "Submit Application", ashbyNetwork })
    });
    const raw = readFileSync(join(dataDir, saved.relativeDir, "evidence.json"), "utf8");
    const stored = submitEvidenceFileSchema.parse(JSON.parse(raw));
    expect(stored.ashbyNetwork).toEqual({
      calls: [
        { operation: "ApiSetFormValue", status: 200, failed: false, clicks: 0 },
        { operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1 }
      ],
      submits: [{
        operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1, recaptchaToken: "present",
        resultType: "FormRender", success: false, errorCodes: ["FIXTURE_ERROR"], errorMessages: ["Contact [email] for help."],
        formErrorMessages: ["Missing entry for required field: Visa Support"],
        fieldErrors: [{ fieldEntryId: ENTRY, message: "Missing entry for required field: Visa Support" }], blockMessage: false
      }],
      recaptchaTokenRequests: 1,
      recaptchaTokenStatuses: [200]
    });
    for (const secret of PERSONAL) expect(raw).not.toContain(secret);
    const old = submitEvidenceFileSchema.parse({
      version: 1, runId: run.id, jobId: run.jobId, capturedAt: "2026-11-19T10:00:00.000Z", outcome: "unknown", url: "", invalidFields: [],
      alertText: "", challenge: null, text: "", screenshot: null
    });
    expect(old.ashbyNetwork).toBeNull();
    const plain = await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence(), now: new Date("2026-11-25T11:00:00.000Z") });
    expect(JSON.parse(readFileSync(join(dataDir, plain.relativeDir, "evidence.json"), "utf8")).ashbyNetwork).toBeNull();
    database.close();
  });

  it("prints the record with pnpm run:evidence, nothing personal", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage("throw"), now: new Date("2026-11-25T10:00:00.000Z"),
      evidence: evidence({ outcome: "unknown", url: "https://jobs.ashbyhq.com/fixturerobotics/1/application", invalidFields: [], alertText: "", bodyText: "Submit Application", ashbyNetwork: await recordedNetwork() })
    });
    const lines: string[] = [];
    expect(await runEvidenceCommand(["--run", run.id], { open: () => database, close: () => {}, dataDir: () => dataDir, log: (line) => { lines.push(line); } })).toBe(0);
    expect(lines).toContain("Ashby network: 2 GraphQL call(s) recorded; reCAPTCHA token requests: 1 (HTTP 200)");
    expect(lines).toContain("  - ApiSubmitSingleApplicationFormAction after click 1: HTTP 200; token present; result FormRender; error codes: FIXTURE_ERROR; errors: Contact [email] for help.; form errors: Missing entry for required field: Visa Support; field errors: 1");
    const text = lines.join("\n");
    for (const secret of PERSONAL) expect(text).not.toContain(secret);
    expect(describeAshbyNetwork({ calls: [], submits: [], recaptchaTokenRequests: 1, recaptchaTokenStatuses: [null] })).toEqual([
      "Ashby network: 0 GraphQL call(s) recorded; reCAPTCHA token requests: 1 (HTTP no answer)",
      "  - no submit request was sent"
    ]);
    expect(describeAshbyNetwork({
      calls: [], recaptchaTokenRequests: 0, recaptchaTokenStatuses: [],
      submits: [{ operation: "ApiSubmitSingleApplicationFormAction", status: null, failed: true, clicks: 1, recaptchaToken: "dummy", resultType: "FormSubmitSuccess", success: true, errorCodes: [], errorMessages: [], formErrorMessages: [], fieldErrors: [], blockMessage: true }]
    })).toEqual([
      "Ashby network: 0 GraphQL call(s) recorded; reCAPTCHA token requests: 0",
      "  - ApiSubmitSingleApplicationFormAction after click 1: request failed; token dummy; result FormSubmitSuccess (accepted); error codes: none; block message shown"
    ]);
    expect(describeAshbyNetwork(null)).toEqual([]);
    database.close();
  });
});

describe("Ashby's submit diagnostics in the evidence (Track 27)", () => {
  const PERSONAL = ["Jordan Rivera", "Rivera", "jordan.rivera@example.test", "jordan@example.test", "5550100199", "signature=", "fixture-secret"];
  const URL = "https://jobs.ashbyhq.com/fixturerobotics/1/application";

  /** As the page adapter builds it: the page's values scrubbed at snapshot, plus raw texts the writer must redact again. */
  function recordedDiagnostics() {
    const recorder = createAshbyDiagnosticsRecorder();
    recorder.noteClick({ ashbySubmitButton: true, hitTarget: true, hitElement: null, tag: "button", typeAttribute: null, text: "Submit Application" });
    const token = {};
    recorder.request(token, "https://www.recaptcha.net/recaptcha/enterprise/reload?k=fixture-secret", "POST", "fetch");
    recorder.response(token, 200);
    const upload = {};
    recorder.request(upload, "https://files.example.test/uploads/5550100199/Jordan-Rivera-resume.pdf?signature=abc", "PUT", "fetch");
    recorder.failed(upload);
    recorder.consoleMessage("error", "Submit failed for Jordan Rivera <jordan.rivera@example.test> see https://telemetry.fixture.invalid/r?token=fixture-secret");
    recorder.pageError("Error: no session for Jordan Rivera");
    const snapshot = recorder.snapshot(scrubValuesFrom(["Jordan Rivera", "jordan.rivera@example.test"]), ["Fixture notice for Jordan Rivera"]);
    return {
      ...snapshot,
      // Raw texts (as if a value could not be matched): the writer redacts emails, URL queries, and long numbers again.
      visibleErrors: [...snapshot.visibleErrors, "Call 5550100199 or mail jordan@example.test about https://help.fixture.invalid/a?signature=abc"]
    };
  }

  it("stores the diagnostics redacted again, nothing personal, and reads older files as null", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    const saved = await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage(), now: new Date("2026-11-25T10:00:00.000Z"),
      evidence: evidence({ outcome: "challenged", url: URL, invalidFields: [], alertText: "", bodyText: "Submit Application", challenge: "fixture challenge", ashbyDiagnostics: recordedDiagnostics() })
    });
    const raw = readFileSync(join(dataDir, saved.relativeDir, "evidence.json"), "utf8");
    const stored = submitEvidenceFileSchema.parse(JSON.parse(raw));
    expect(stored.ashbyDiagnostics).toEqual({
      clicks: [{ ashbySubmitButton: true, hitTarget: true, hitElement: null, tag: "button", typeAttribute: null, text: "Submit Application" }],
      requests: [
        { method: "POST", host: "www.recaptcha.net", path: "/recaptcha/enterprise/reload", resourceType: "fetch", clicks: 1, count: 1, lastStatus: 200, failed: false },
        { method: "PUT", host: "files.example.test", path: "/uploads/[number]/[file]", resourceType: "fetch", clicks: 1, count: 1, lastStatus: null, failed: true }
      ],
      requestsDropped: 0,
      console: [
        { kind: "error", text: "Submit failed for [redacted] <[redacted]> see telemetry.fixture.invalid/r", clicks: 1 },
        { kind: "page-error", text: "Error: no session for [redacted]", clicks: 1 }
      ],
      consoleDropped: 0,
      visibleErrors: ["Fixture notice for [redacted]", "Call [number] or mail [email] about https://help.fixture.invalid/a"]
    });
    for (const secret of PERSONAL) expect(raw).not.toContain(secret);
    const old = submitEvidenceFileSchema.parse({
      version: 1, runId: run.id, jobId: run.jobId, capturedAt: "2026-11-19T10:00:00.000Z", outcome: "unknown", url: "", invalidFields: [],
      alertText: "", challenge: null, text: "", screenshot: null
    });
    expect(old.ashbyDiagnostics).toBeNull();
    const plain = await savePostSubmitEvidence({ database, dataDir, run, page: stubPage(), evidence: evidence(), now: new Date("2026-11-25T11:00:00.000Z") });
    expect(JSON.parse(readFileSync(join(dataDir, plain.relativeDir, "evidence.json"), "utf8")).ashbyDiagnostics).toBeNull();
    database.close();
  });

  it("prints the diagnostics with pnpm run:evidence, nothing personal", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-evidence-data-");
    const run = syntheticRun(database);
    await savePostSubmitEvidence({
      database, dataDir, run, page: stubPage("throw"), now: new Date("2026-11-25T10:00:00.000Z"),
      evidence: evidence({ outcome: "challenged", url: URL, invalidFields: [], alertText: "", bodyText: "Submit Application", challenge: "fixture challenge", ashbyDiagnostics: recordedDiagnostics() })
    });
    const lines: string[] = [];
    expect(await runEvidenceCommand(["--run", run.id], { open: () => database, close: () => {}, dataDir: () => dataDir, log: (line) => { lines.push(line); } })).toBe(0);
    expect(lines).toEqual(expect.arrayContaining([
      "Ashby submit click(s): 1",
      "  - click 1: on Ashby's submit button: yes; hit test at its centre: yes; button, no type attribute; \"Submit Application\"",
      "Requests after the first click: 2 (0 not kept)",
      "  - POST www.recaptcha.net/recaptcha/enterprise/reload ×1 after click 1: HTTP 200",
      "  - PUT files.example.test/uploads/[number]/[file] ×1 after click 1: failed",
      "Console after the watch started: 2",
      "  - [error, click 1] Submit failed for [redacted] <[redacted]> see telemetry.fixture.invalid/r",
      "  - [page-error, click 1] Error: no session for [redacted]",
      "Visible errors:",
      "  - Fixture notice for [redacted]"
    ]));
    const text = lines.join("\n");
    for (const secret of PERSONAL) expect(text).not.toContain(secret);
    expect(describeAshbyDiagnostics(null)).toEqual([]);
    expect(describeAshbyDiagnostics({
      clicks: [{ ashbySubmitButton: false, hitTarget: false, hitElement: "div.overlay", tag: "button", typeAttribute: "button", text: "Upload file" }],
      requests: [], requestsDropped: 3, console: [{ kind: "warning", text: "", clicks: 0 }], consoleDropped: 0, visibleErrors: []
    })).toEqual([
      "Ashby submit click(s): 1",
      "  - click 1: on Ashby's submit button: no; hit test at its centre: no, found div.overlay; button, type \"button\"; \"Upload file\"",
      "Requests after the first click: 0 (3 not kept)",
      "Console after the watch started: 1",
      "  - [warning, click 0] (not kept)",
      "Visible errors: none"
    ]);
    database.close();
  });
});
