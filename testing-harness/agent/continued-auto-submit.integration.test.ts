import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDatabase,
  getBrowserRun,
  getFitInputVersion,
  getJobPosting,
  listApplicationEvents,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  persistNormalizedPosting,
  reconcileApplicationHolds,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveBrowserRun,
  saveCandidateFact,
  saveSemanticFit,
  seedDevelopmentData,
  updateBrowserRun
} from "@internship-agent/db";
import { AUTO_SUBMIT_EVENT, companyCapReason, type BrowserRun } from "@internship-agent/domain";
import type { BrowserPage, RawControl } from "@internship-agent/browser";
import {
  acquirePipelineLock,
  advancePipeline,
  approveApplication,
  continueBrowserRun,
  continuedAutoSubmitBlocker,
  continuedAutoSubmitRuns,
  evaluateAndPersistMatch,
  prepareApplication,
  savePostSubmitEvidence,
  startBrowserRun,
  UnavailableModelProvider,
  type PageFactory,
  type PipelineSettings
} from "@internship-agent/agent";

import { runAnswerCommand, type RunCommandDeps } from "../../packages/agent/src/run-answer";

/**
 * Answered automatic runs under the auto-submit policy (candidate decision
 * 2026-11-21: "even if the application had to ask me a question, they should
 * still auto apply"): a run the pipeline started that paused, was answered
 * with `pnpm run:answer`, and reached the submit step clean is submitted on
 * the next pass through the same policy check, exactly once, with the
 * policy's approval. Runs the candidate started, open pauses, approval-only
 * sites, runs that may have reached the site, and manual checklist mode are
 * never submitted. Disposable SQLite and data directories, fake pages; no
 * browser, no network, no model.
 */

const temporaryDirectories: string[] = [];
const CLEARED_ENV = ["INTERNSHIP_AGENT_MANUAL_ONLY", "INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT", "INTERNSHIP_AGENT_SIGN_ATTESTATIONS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(CLEARED_ENV.map((name) => [name, process.env[name]]));
  for (const name of CLEARED_ENV) delete process.env[name];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function disposableDatabase(): DatabaseSync {
  return createDatabase(join(disposableDirectory("internship-agent-continued-"), "test.sqlite"));
}

/** In-memory stand-in for a page: records the submit click, never touches a browser. */
function fakePage(overrides: { controls?: RawControl[]; submitted?: { clicked: boolean } } = {}): BrowserPage {
  let submitted = false;
  return {
    url: () => "https://boards.greenhouse.io/example/jobs/2",
    title: async () => "Example",
    collectControls: async () => overrides.controls ?? [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "button", label: "Submit application" }
    ],
    bodyText: async () => (submitted ? "Thank you! Your application was received." : "Please fix the errors below."),
    fillField: async () => {},
    chooseOption: async () => {},
    setChecked: async () => {},
    uploadFile: async () => {},
    clickSubmit: async () => {
      submitted = true;
      if (overrides.submitted) overrides.submitted.clicked = true;
    },
    screenshot: async () => {},
    close: async () => {}
  };
}

/** A form with a question no saved fact answers, so the automatic run pauses for the candidate. */
const UNANSWERED: RawControl[] = [
  { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
  { tag: "input", type: "text", id: "q2", label: "Favorite color?", required: true },
  { tag: "button", label: "Submit application" }
];

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The seeded "Northstar Systems" posting on AI labels, with a strong current AI fit (approved for a candidate-started run). */
function seededJob(database: DatabaseSync, stopAt: "qualified" | "approved" = "qualified"): string {
  seedDevelopmentData(database);
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID, owner: "example", name: "evidence-demo", url: "https://github.com/example/evidence-demo",
    defaultBranch: "main", description: "Fixture evidence.", observedHeadSha: "sha-fixture"
  });
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id, name: "evidence-demo", summary: "Fixture project.",
    fullSnapshot: true, affectedPaths: ["README.md"],
    claims: [{
      kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.", evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme", commitSha: "sha-fixture", path: "README.md", startLine: 2, endLine: 2,
        sourceUrl: "https://github.com/example/evidence-demo/blob/sha-fixture/README.md#L2",
        excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0]!.claims[0]!;
  reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" });
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  if (stopAt === "approved") {
    prepareApplication(row.id, { database });
    approveApplication(row.id, { database });
  }
  saveFit(database, row.id, "MEDIUM");
  return row.id;
}

function saveFit(database: DatabaseSync, jobId: string, confidence: "MEDIUM" | "LOW") {
  saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
    score: 86, rating: "STRONG", confidence, summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
    decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
  });
}

const target = { season: "summer", year: 2027 } as const;
const policy: PipelineSettings = { minFit: 0, autoApply: true, target, autoSubmit: { minFit: 50, dailyCap: 10 } };
const UNANSWERED_NOTE = "The form has unanswered questions waiting for you.";
const AUTO_START = "Browser run started automatically from the verified package; your approval is required before submission.";
const CANDIDATE_START = "Browser run started from the approved package.";

function pass(database: DatabaseSync, dataDir: string, openPage: PageFactory, settings: PipelineSettings = policy) {
  return advancePipeline({
    database, dataDir, settings, openPage, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
    fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider(), submitWait: { timeoutMs: 50, pollMs: 5 },
    securityCodeMailbox: null, securityCodeWait: { pollMs: 1, timeoutMs: 20, sleep: async () => undefined }
  });
}

/** A form page whose submit click is recorded in `flag`. */
const formPage = (flag: { clicked: boolean }): PageFactory => async () => fakePage({ controls: UNANSWERED, submitted: flag });

function autoSubmitEvents(database: DatabaseSync, jobId: string) {
  return listApplicationEvents(database, jobId).filter((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT));
}

function stubPolicyEnv() {
  vi.stubEnv("INTERNSHIP_AGENT_AUTO_APPLY", "1");
  vi.stubEnv("INTERNSHIP_AGENT_AUTO_SUBMIT", "1");
  vi.stubEnv("INTERNSHIP_AGENT_TARGET_TERM", "summer-2027");
}

/** `pnpm run:answer` over the disposable workspace: the run continues on a fake page, under the real pipeline lock. */
function answerDeps(database: DatabaseSync, dataDir: string, output: string[]): Partial<RunCommandDeps> {
  return {
    open: () => database,
    close: () => {},
    dataDir: () => dataDir,
    log: (line) => output.push(line),
    acquireLock: (directory) => acquirePipelineLock(directory),
    continueRun: (runId, options) => continueBrowserRun(runId, { ...options, openPage: async () => fakePage({ controls: UNANSWERED }) })
  };
}

/** Answers the run's only open question ("Favorite color?") for this run only; returns run:answer's output. */
async function answerFavoriteColor(database: DatabaseSync, dataDir: string, run: BrowserRun): Promise<string[]> {
  const q = run.pauses.findIndex((pause) => pause.status === "open" && pause.label === "Favorite color?") + 1;
  expect(q).toBeGreaterThan(0);
  const output: string[] = [];
  expect(await runAnswerCommand(["--run", run.id, "--q", String(q), "--answer", "Blue", "--once"], answerDeps(database, dataDir, output))).toBe(0);
  const answered = getBrowserRun(database, run.id)!;
  expect(answered.status).toBe("awaiting-approval");
  expect(answered.pauses.some((pause) => pause.status === "open")).toBe(false);
  return output;
}

/** A pipeline-started run that paused on its first pass and was answered with run:answer. */
async function answeredRun(database: DatabaseSync, dataDir: string, flag: { clicked: boolean }, beforeAnswer?: () => void) {
  const jobId = seededJob(database);
  const first = await pass(database, dataDir, formPage(flag));
  expect(first.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
  const run = listBrowserRuns(database, jobId)[0]!;
  expect(run.pauses.filter((pause) => pause.status === "open").map((pause) => pause.label)).toEqual(["Favorite color?"]);
  beforeAnswer?.();
  const output = await answerFavoriteColor(database, dataDir, run);
  return { jobId, run: getBrowserRun(database, run.id)!, output, first };
}

/** A posting at another company (or the same one) with one earlier run in `status`, started by the pipeline or the candidate. */
function historyRun(database: DatabaseSync, input: {
  companyName: string; status: BrowserRun["status"]; jobStatus: string; by: "pipeline" | "candidate";
  createdAt?: string; applicationProfile?: "default" | "transcript";
}): BrowserRun {
  const title = "Software Engineering Intern";
  const sourceUrl = `https://example.test/internships/${randomUUID()}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.companyName, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `hash-${sourceUrl}`,
    normalizedText: `${title}\nFixture posting for company history.`, locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  const at = input.createdAt ?? new Date().toISOString();
  database.prepare("INSERT INTO application_events (id, job_id, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), jobId, "READY_FOR_REVIEW", "APPLYING", input.by === "pipeline" ? AUTO_START : CANDIDATE_START, at);
  database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(input.jobStatus, jobId);
  const packageId = randomUUID();
  database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
    .run(packageId, jobId, at, "{}");
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: sourceUrl, status: input.status, packageId, variantId: null, baseResumeId: null,
    applicationProfile: input.applicationProfile ?? "default", atsKind: "greenhouse", atsConfidence: 1, suggestedAtsKind: null,
    atsConfirmed: true, decisions: [], pauses: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: null,
    createdAt: at, updatedAt: at
  });
}

describe("answered automatic runs under the auto-submit policy", () => {
  it("submits an answered, clean, pipeline-started run on the next pass, once, with the policy's approval", async () => {
    stubPolicyEnv();
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const flag = { clicked: false };
    const { jobId, run, output, first } = await answeredRun(database, dataDir, flag);
    expect(first.submitted).toEqual([]);
    expect(first.held.find((entry) => entry.jobId === jobId)?.reasons).toContain(UNANSWERED_NOTE);
    expect(output).toContain(`Run ${run.id.slice(0, 8)} continued: awaiting-approval.`);
    expect(output.some((line) => line.startsWith("The next pipeline pass submits it under your auto-submit policy"))).toBe(true);
    expect(flag.clicked).toBe(false);
    expect(autoSubmitEvents(database, jobId)).toEqual([]);

    const second = await pass(database, dataDir, formPage(flag));
    expect(second.errors).toEqual([]);
    expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    expect(flag.clicked).toBe(true);
    expect(getBrowserRun(database, run.id)?.status).toBe("submitted");
    expect(getJobPosting(database, jobId)?.status).toBe("SUBMITTED");
    const approvals = autoSubmitEvents(database, jobId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.detail).toContain("or from your own answers to this run's questions");
    // The approval is the policy's, never the candidate's.
    expect(listApplicationEvents(database, jobId).some((event) => event.toStatus === "APPROVED")).toBe(false);

    const third = await pass(database, dataDir, formPage(flag));
    expect(third.submitted).toEqual([]);
    expect(autoSubmitEvents(database, jobId)).toHaveLength(1);
    database.close();
  });

  it("leaves a run the candidate started for the candidate", async () => {
    stubPolicyEnv();
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const jobId = seededJob(database, "approved");
    const { run: started } = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/2", {
      database, dataDir, openPage: async () => fakePage({ controls: UNANSWERED }), voiceDrafter: null
    });
    expect(started.status).toBe("paused-needs-input");
    const output = await answerFavoriteColor(database, dataDir, started);
    expect(output.some((line) => line.startsWith("It waits for your submit approval: you started this run yourself"))).toBe(true);

    const flag = { clicked: false };
    const report = await pass(database, dataDir, formPage(flag));
    expect(report.submitted).toEqual([]);
    expect(flag.clicked).toBe(false);
    expect(autoSubmitEvents(database, jobId)).toEqual([]);
    const run = getBrowserRun(database, started.id)!;
    expect(run).toMatchObject({ status: "awaiting-approval", submissionApprovedAt: null });
    expect(continuedAutoSubmitBlocker(database, dataDir, run)).toContain("you started this run yourself");
    database.close();
  });

  it("never submits a run with an open pause", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const jobId = seededJob(database);
    const flag = { clicked: false };
    await pass(database, dataDir, formPage(flag));
    const second = await pass(database, dataDir, formPage(flag));
    expect(second.submitted).toEqual([]);
    expect(flag.clicked).toBe(false);
    expect(autoSubmitEvents(database, jobId)).toEqual([]);
    expect(listBrowserRuns(database, jobId)[0]?.status).toBe("paused-needs-input");
    database.close();
  });

  it("holds an approval-only site", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const flag = { clicked: false };
    const { jobId, run } = await answeredRun(database, dataDir, flag);
    updateBrowserRun(database, run.id, { atsConfirmed: false, suggestedAtsKind: "icims" });
    const report = await pass(database, dataDir, formPage(flag));
    expect(report.submitted).toEqual([]);
    expect(flag.clicked).toBe(false);
    expect(autoSubmitEvents(database, jobId)).toEqual([]);
    expect(continuedAutoSubmitBlocker(database, dataDir, getBrowserRun(database, run.id)!)).toContain("no adapter that walks their application");
    database.close();
  });

  it.each([
    ["an active possible-submission hold", "hold"],
    ["post-submit evidence of the run", "evidence"],
    ["an earlier automatic approval of the run", "approval"]
  ] as const)("never submits a run that may have reached the site: %s", async (_name, kind) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const flag = { clicked: false };
    const { jobId, run } = await answeredRun(database, dataDir, flag);
    if (kind === "hold") {
      reconcileApplicationHolds(database, () => ({
        observations: [{ jobId, runId: run.id, owner: "manager", reason: "possible-submission", identity: "fixture", evidenceRef: null, sourceEventId: null }],
        resolved: new Set<string>()
      }), new Date().toISOString());
    } else if (kind === "evidence") {
      await savePostSubmitEvidence({
        database, dataDir, run, page: fakePage(),
        evidence: { outcome: "unknown", url: "https://boards.greenhouse.io/example/jobs/2", bodyText: "", invalidFields: [], alertText: "", challenge: null }
      });
    } else {
      logApplicationEvent(database, { jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: AUTO_SUBMIT_EVENT + ": earlier." });
    }
    const blocker = continuedAutoSubmitBlocker(database, dataDir, getBrowserRun(database, run.id)!);
    expect(blocker).toBe(kind === "approval"
      ? "its submission was already approved or attempted, so it is never submitted again automatically."
      : "it may already have reached the site.");
    const report = await pass(database, dataDir, formPage(flag));
    expect(report.submitted).toEqual([]);
    expect(flag.clicked).toBe(false);
    expect(autoSubmitEvents(database, jobId)).toHaveLength(kind === "approval" ? 1 : 0);
    database.close();
  });

  describe("re-checks the target, AI fit, company cap, and graduation profile on the later pass", () => {
    it("holds the run when the AI fit no longer says apply", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-continued-data-");
      const flag = { clicked: false };
      const { jobId } = await answeredRun(database, dataDir, flag);
      saveFit(database, jobId, "LOW");
      const report = await pass(database, dataDir, formPage(flag));
      expect(report.submitted).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: ["Fit: the AI's confidence is low."] }]);
      expect(flag.clicked).toBe(false);
      database.close();
    });

    it("holds the run when the company cap filled up since its start", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-continued-data-");
      const flag = { clicked: false };
      const { jobId } = await answeredRun(database, dataDir, flag, () => {
        for (let index = 0; index < 2; index += 1) {
          historyRun(database, { companyName: "Northstar Systems", status: "submitted", jobStatus: "SUBMITTED", by: "pipeline" });
        }
      });
      const company = getJobPosting(database, jobId)!.companyName;
      const report = await pass(database, dataDir, formPage(flag));
      expect(report.submitted).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: [companyCapReason(company, 2)] }]);
      expect(flag.clicked).toBe(false);
      database.close();
    });

    it("holds the run when today's automatic submissions are used up", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-continued-data-");
      const flag = { clicked: false };
      const { jobId } = await answeredRun(database, dataDir, flag);
      const other = historyRun(database, { companyName: "Tidewave", status: "submitted", jobStatus: "SUBMITTED", by: "pipeline" });
      logApplicationEvent(database, { jobId: other.jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: AUTO_SUBMIT_EVENT + ": earlier today." });
      const report = await pass(database, dataDir, formPage(flag), { ...policy, autoSubmit: { minFit: 50, dailyCap: 1 } });
      expect(report.submitted).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: ["Today's 1 automatic submissions are used up."] }]);
      expect(flag.clicked).toBe(false);
      database.close();
    });

    it("holds the run when its company already saw another graduation profile", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-continued-data-");
      const flag = { clicked: false };
      const { jobId, run } = await answeredRun(database, dataDir, flag);
      historyRun(database, {
        companyName: "Northstar Systems", status: "submitted", jobStatus: "SUBMITTED", by: "candidate",
        createdAt: "2026-11-01T00:00:00.000Z", applicationProfile: "transcript"
      });
      expect(run.applicationProfile).toBe("default");
      const report = await pass(database, dataDir, formPage(flag));
      expect(report.submitted).toEqual([]);
      expect(report.held).toHaveLength(1);
      expect(report.held[0]!.jobId).toBe(jobId);
      expect(report.held[0]!.reasons.join(" ")).toContain("should see one graduation year");
      expect(flag.clicked).toBe(false);
      database.close();
    });
  });

  it("submits nothing in manual checklist mode", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-continued-data-");
    const flag = { clicked: false };
    await answeredRun(database, dataDir, flag);
    process.env.INTERNSHIP_AGENT_MANUAL_ONLY = "1";
    expect(continuedAutoSubmitRuns(database, dataDir)).toEqual([]);
    const report = await pass(database, dataDir, formPage(flag));
    expect(report.submitted).toEqual([]);
    expect(flag.clicked).toBe(false);
    database.close();
  });
});
