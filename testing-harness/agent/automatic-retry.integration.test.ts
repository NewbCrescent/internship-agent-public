import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeProfileDatabase,
  createDatabase,
  getFitInputVersion,
  listApplicationEvents,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  persistNormalizedPosting,
  reconcileProjectEvidence,
  registerGitHubRepository,
  resolveProfileDataDirectory,
  reviewEvidenceClaim,
  saveBrowserRun,
  saveBrowserSession,
  saveCandidateFact,
  saveSemanticFit,
  seedDevelopmentData,
  updateBrowserRun
} from "@internship-agent/db";
import { AUTO_SUBMIT_EVENT, runStartedByPipeline, type BrowserRun, type PauseRecord } from "@internship-agent/domain";
import {
  SubmissionCodeNotFound,
  SubmissionNeedsInput,
  SubmissionUnconfirmed,
  type BrowserPage,
  type RawControl,
  type WorkdayPage,
  type WorkdayPageError
} from "@internship-agent/browser";
import {
  acquirePipelineLock,
  advancePipeline,
  answerRunPause,
  approveApplication,
  approveRunSubmission,
  AutomaticRetryRefused,
  automaticRetryBlocker,
  automaticSubmissionsSince,
  evaluateAndPersistMatch,
  getWorkdayAccount,
  listHeldRuns,
  prepareApplication,
  putWorkdayAccount,
  readPipelineLock,
  reopenUnsubmittedBlocker,
  releasableWorkdayHolds,
  reopenUnsubmittedRun,
  resolveWorkdayAccounts,
  retryAutomaticRun,
  runRetryCommand,
  savePostSubmitEvidence,
  startBrowserRun,
  submitBrowserRun,
  UnavailableModelProvider,
  unsubmittedEvidence,
  workdayAccountSettings,
  workdayAccountWait,
  type PageFactory,
  type PipelineReport,
  type PipelineSettings,
  type RetryCommandDeps,
  type VerificationMailboxFactory
} from "@internship-agent/agent";

import { evaluateMail, mailEventDetail, type AppliedJob } from "../../packages/agent/src/mail-outcomes";
import { runPipelinePass } from "../../packages/agent/scripts/pipeline-pass";

/**
 * Retrying held automatic runs after a fix (`pnpm pipeline:retry`): the run
 * is cancelled, its job goes back to READY_FOR_REVIEW, and the next pass
 * starts a fresh automatic run. Disposable SQLite and data directories, fake
 * pages as in the run-lifecycle suite; no browser, no network, no model.
 * `--reopen-unsubmitted --reason` reopens a failed submit only with positive
 * evidence the site did not complete it (Greenhouse's security-code email
 * after the click, or a verification-code evidence capture); it is refused
 * without evidence, before the click, for another company or sender, with a
 * confirmation, and for paused, submitted, or candidate-started runs. A run
 * held for a missing security code is paused with the approval withdrawn and
 * retryable as any held run. Workday: a run paused by Workday's page errors is
 * retried with --held, and --held releases Workday account holds of kind
 * "unexpected" in a temporary accounts file (never the real one).
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
  return createDatabase(join(disposableDirectory("internship-agent-retry-"), "test.sqlite"));
}

/** In-memory stand-in for a page: records fills, never touches a browser. */
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

/** A form with a question no saved fact answers, so the automatic run pauses (the "bogus pause" a fix removes). */
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

/** The seeded "Northstar Systems" posting, qualified on AI labels (or approved for a candidate-started run). */
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
  return row.id;
}

const on: PipelineSettings = { minFit: 0, autoApply: true };
const neverOpen: PageFactory = async () => { throw new Error("must not open a browser"); };

function pass(database: DatabaseSync, dataDir: string, openPage: PageFactory, extra: { retryStopped?: boolean } = {}) {
  return advancePipeline({
    database, dataDir, settings: on, openPage, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
    fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider(), ...extra
  });
}

const statusOf = (database: DatabaseSync, jobId: string) =>
  (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;
const details = (database: DatabaseSync, jobId: string) => listApplicationEvents(database, jobId).map((event) => event.detail ?? "");
const applyingEvents = (database: DatabaseSync, jobId: string) => listApplicationEvents(database, jobId)
  .filter((event) => event.toStatus === "APPLYING").map((event) => ({ detail: event.detail, at: event.createdAt }));

/** Every row a retry could change, to prove a refusal or a dry run wrote nothing. */
function snapshot(database: DatabaseSync) {
  return {
    runs: database.prepare("SELECT id, status, updated_at FROM browser_runs ORDER BY id").all(),
    jobs: database.prepare("SELECT id, status, updated_at FROM jobs ORDER BY id").all(),
    events: database.prepare("SELECT COUNT(*) AS count FROM application_events").get()
  };
}

/** One pipeline pass on the seeded posting that leaves an automatic run held for the candidate. */
async function heldAutomaticRun(database: DatabaseSync, dataDir: string, controls: RawControl[] | null = UNANSWERED): Promise<{ jobId: string; run: BrowserRun }> {
  const jobId = seededJob(database);
  const report = await pass(database, dataDir, async () => fakePage({ controls: controls ?? undefined }));
  expect(report.started).toHaveLength(1);
  return { jobId, run: listBrowserRuns(database, jobId)[0]! };
}

const AUTO_START = "Browser run started automatically from the verified package; your approval is required before submission.";
const CANDIDATE_START = "Browser run started from the approved package.";

/** A synthetic applying posting with a held run started by the pipeline or the candidate (for the command's selection). */
function syntheticHeldRun(database: DatabaseSync, input: {
  company: string; by: "pipeline" | "candidate"; status?: BrowserRun["status"]; pauses?: PauseRecord[];
}): BrowserRun {
  const title = "Software Engineering Intern";
  const sourceUrl = `https://example.test/internships/${input.company.toLowerCase().replace(/\W+/g, "-")}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.company, title, employmentType: "INTERNSHIP", applicationType: "EXTERNAL_ATS",
    sourceUrl, externalApplicationUrl: null, companyCareersUrl: null, contentHash: `hash-${sourceUrl}`,
    normalizedText: `${title}\nFixture posting for retry selection.`, locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  logApplicationEvent(database, { jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "APPLYING", detail: input.by === "pipeline" ? AUTO_START : CANDIDATE_START });
  database.prepare("UPDATE jobs SET status = 'APPLYING' WHERE id = ?").run(jobId);
  const packageId = randomUUID();
  database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
    .run(packageId, jobId, new Date().toISOString(), "{}");
  const now = new Date().toISOString();
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: sourceUrl, status: input.status ?? "paused-needs-input", packageId, variantId: null,
    baseResumeId: null, applicationProfile: "default", atsKind: "greenhouse", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
    decisions: [], pauses: input.pauses ?? [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: now, updatedAt: now
  });
}

function answeredPause(): PauseRecord {
  return {
    fieldId: "q9", label: "Favorite color?", question: "Favorite color?", suggestedKey: null, suggestedScope: null, safeguard: false,
    sensitive: false, upload: false, status: "answered", answer: "Blue", draft: null
  };
}

/** Command dependencies over a disposable database; the lock is recorded, never written to the real workspace. */
function commandDeps(database: DatabaseSync, overrides: Partial<RetryCommandDeps> = {}) {
  const lines: string[] = [];
  const lock = { taken: 0, released: 0, held: false };
  const deps: Partial<RetryCommandDeps> = {
    open: () => database,
    close: () => {},
    dataDir: () => "/nonexistent/retry-test",
    log: (line) => lines.push(line),
    acquireLock: () => {
      lock.taken += 1;
      lock.held = true;
      return () => { lock.released += 1; lock.held = false; };
    },
    env: { INTERNSHIP_AGENT_AUTO_APPLY: "1" },
    ...overrides
  };
  return { deps, lines, lock };
}

describe("retryAutomaticRun", () => {
  it.each([
    ["paused for input", UNANSWERED, "paused-needs-input"],
    ["awaiting approval", null, "awaiting-approval"]
  ] as const)("retries an automatic run %s: cancelled, job back to READY_FOR_REVIEW, event logged", async (_name, controls, status) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir, controls);
    expect(run.status).toBe(status);
    expect(statusOf(database, jobId)).toBe("APPLYING");

    const cancelled = retryAutomaticRun(database, run.id, { reason: "  Greenhouse unlabeled fields\nare fixed. " });
    expect(cancelled.status).toBe("cancelled");
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe("Automatic run retried after a fix: Greenhouse unlabeled fields are fixed.");
    database.close();
  });

  it("lets the next pass start a fresh automatic run under the current code", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir);
    // Without a retry the held run blocks every later pass.
    expect((await pass(database, dataDir, neverOpen)).started).toEqual([]);

    retryAutomaticRun(database, run.id, { reason: "fixed" });
    const next = await pass(database, dataDir, async () => fakePage());
    expect(next.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    const runs = listBrowserRuns(database, jobId);
    expect(runs).toHaveLength(2);
    const fresh = runs.find((entry) => entry.id !== run.id)!;
    expect(fresh.status).toBe("awaiting-approval");
    // Started as an automatic run again, so the cap and auto-submit treat it as the pipeline's.
    expect(details(database, jobId).at(-1)).toBe(AUTO_START);
    expect(runStartedByPipeline(fresh.createdAt, applyingEvents(database, jobId))).toBe(true);
    expect(statusOf(database, jobId)).toBe("APPLYING");
    database.close();
  });

  it("starts the fresh run even after an earlier automatic stop on the same application", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = seededJob(database);
    const stopped = await pass(database, dataDir, async () => fakePage({ controls: [{ tag: "button", label: "Apply" }] }));
    expect(stopped.stopped).toHaveLength(1);
    const held = await pass(database, dataDir, async () => fakePage({ controls: UNANSWERED }), { retryStopped: true });
    expect(held.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);

    retryAutomaticRun(database, listBrowserRuns(database, jobId)[0]!.id, { reason: "fixed" });
    const next = await pass(database, dataDir, async () => fakePage());
    expect(next.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);

    // A stop after the retry blocks again, as any automatic stop does.
    retryAutomaticRun(database, listBrowserRuns(database, jobId)[0]!.id, { reason: "fixed again" });
    expect((await pass(database, dataDir, async () => fakePage({ controls: [{ tag: "button", label: "Apply" }] }))).stopped).toHaveLength(1);
    expect((await pass(database, dataDir, neverOpen)).started).toEqual([]);
    database.close();
  });

  it("applies the company cap to the fresh run as usual", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir);
    syntheticHeldRun(database, { company: "Northstar Systems, Inc.", by: "pipeline", status: "submitted" });
    syntheticHeldRun(database, { company: "NORTHSTAR SYSTEMS", by: "pipeline", status: "awaiting-approval" });

    retryAutomaticRun(database, run.id, { reason: "fixed" });
    const next = await pass(database, dataDir, neverOpen);
    expect(next.started).toEqual([]);
    expect(next.skipped).toEqual([{ jobId, reasons: ["Company cap: already 2 applications to Northstar Systems."] }]);
    database.close();
  });

  it("refuses a run the candidate started", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = seededJob(database, "approved");
    const { run } = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/2", {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), voiceDrafter: null, openPage: async () => fakePage({ controls: UNANSWERED })
    });
    expect(run.status).toBe("paused-needs-input");
    const before = snapshot(database);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(AutomaticRetryRefused);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/you started it yourself/);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("refuses a run with a pause the candidate already answered", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { run } = await heldAutomaticRun(database, dataDir);
    const pause = run.pauses.find((entry) => entry.label === "Favorite color?")!;
    await answerRunPause(run.id, pause.fieldId, "Blue", false, { database });
    const before = snapshot(database);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/already answered/);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("refuses a run whose submission was approved, and a failed submit", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    const before = snapshot(database);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/submission was approved/);
    updateBrowserRun(database, run.id, { status: "failed" });
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/submission was approved/);
    expect(snapshot(database).jobs).toEqual(before.jobs);
    database.close();
  });

  it("refuses a submitted application", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    await submitBrowserRun(run.id, { database, dataDir, openPage: async () => fakePage(), applicationRecord: null });
    expect(statusOf(database, jobId)).toBe("SUBMITTED");
    const before = snapshot(database);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/it is submitted/);
    // A held run beside a submitted one on the same application is refused too.
    database.prepare("UPDATE jobs SET status = 'APPLYING' WHERE id = ?").run(jobId);
    const now = new Date().toISOString();
    const extra = saveBrowserRun(database, { ...run, id: randomUUID(), status: "paused-needs-input", submissionApprovedAt: null, createdAt: now, updatedAt: now });
    expect(() => retryAutomaticRun(database, extra.id, { reason: "fixed" })).toThrow(/already has a submitted run/);
    expect(snapshot(database).runs).toHaveLength(before.runs.length + 1);
    database.close();
  });

  /** A page whose submit click never confirms; with field errors, it marks the start-date field invalid after the click. */
  function unconfirmedPage(fieldErrors: boolean): BrowserPage {
    const flag = { clicked: false };
    return {
      ...fakePage({ submitted: flag }),
      bodyText: async () => "Please fix the errors below.",
      invalidFields: async () => (fieldErrors && flag.clicked ? [{ ref: "q1", label: "What is your available start date?", error: "This field is required." }] : []),
      submitControlShown: async () => true
    };
  }
  const submitWait = { timeoutMs: 50, pollMs: 5 };

  it("retries a run held by field errors after the submit click", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    await expect(submitBrowserRun(run.id, { database, dataDir, submitWait, openPage: async () => unconfirmedPage(true), applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionNeedsInput);
    const held = listBrowserRuns(database, jobId)[0]!;
    expect(held.status).toBe("paused-needs-input");
    expect(held.submissionApprovedAt).toBeNull();
    expect(automaticRetryBlocker(database, held)).toBeNull();
    expect(retryAutomaticRun(database, run.id, { reason: "School field fixed" }).status).toBe("cancelled");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe("Automatic run retried after a fix: School field fixed");
    database.close();
  });

  it("still refuses a failed unconfirmed submit", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    await expect(submitBrowserRun(run.id, { database, dataDir, submitWait, openPage: async () => unconfirmedPage(false), applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmed);
    expect(listBrowserRuns(database, jobId)[0]!.status).toBe("failed");
    const before = snapshot(database);
    expect(() => retryAutomaticRun(database, run.id, { reason: "fixed" })).toThrow(/submission was approved/);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });
});

describe("pnpm pipeline:retry", () => {
  it("--held retries every eligible held automatic run and reports the rest as skipped, under the lock", async () => {
    const database = disposableDatabase();
    const eligible = syntheticHeldRun(database, { company: "Acme Robotics", by: "pipeline" });
    const awaiting = syntheticHeldRun(database, { company: "Birch Analytics", by: "pipeline", status: "awaiting-approval" });
    const mine = syntheticHeldRun(database, { company: "Cedar Labs", by: "candidate" });
    const answered = syntheticHeldRun(database, { company: "Delta Systems", by: "pipeline", pauses: [answeredPause()] });
    expect(listHeldRuns(database).map((run) => run.id).sort()).toEqual([eligible.id, awaiting.id, mine.id, answered.id].sort());

    const { deps, lines, lock } = commandDeps(database);
    expect(await runRetryCommand(["--held", "--reason", "Ashby is recognized now."], deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^retried ${eligible.id.slice(0, 8)} Acme Robotics`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^retried ${awaiting.id.slice(0, 8)} Birch Analytics`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^skipped ${mine.id.slice(0, 8)} Cedar Labs.*\\(you started it yourself`)));
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^skipped ${answered.id.slice(0, 8)} Delta Systems.*already answered`)));
    expect(lines).toContain("Retried 2; skipped 2.");
    for (const run of [eligible, awaiting]) {
      expect(listBrowserRuns(database, run.jobId)[0]!.status).toBe("cancelled");
      expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
      expect(details(database, run.jobId).at(-1)).toBe("Automatic run retried after a fix: Ashby is recognized now.");
    }
    for (const run of [mine, answered]) {
      expect(listBrowserRuns(database, run.jobId)[0]!.status).toBe("paused-needs-input");
      expect(statusOf(database, run.jobId)).toBe("APPLYING");
    }
    database.close();
  });

  it("--run takes full ids and 8-character prefixes, and names what it cannot find", async () => {
    const database = disposableDatabase();
    const first = syntheticHeldRun(database, { company: "Acme Robotics", by: "pipeline" });
    const second = syntheticHeldRun(database, { company: "Birch Analytics", by: "pipeline" });
    const { deps, lines } = commandDeps(database);
    expect(await runRetryCommand(["--run", first.id, second.id.slice(0, 8), "--run", "0000000z"], deps)).toBe(0);
    expect(lines.filter((line) => line.startsWith("retried "))).toHaveLength(2);
    expect(lines).toContain('skipped 0000000z (no browser run matches "0000000z".)');
    expect(lines.at(-1)).toBe("Retried 2; skipped 1.");
    expect(details(database, first.jobId).at(-1)).toBe("Automatic run retried after a fix: the bug that held it is fixed.");
    database.close();
  });

  it("--dry-run writes nothing and takes no lock", async () => {
    const database = disposableDatabase();
    const eligible = syntheticHeldRun(database, { company: "Acme Robotics", by: "pipeline" });
    syntheticHeldRun(database, { company: "Cedar Labs", by: "candidate" });
    const before = snapshot(database);
    const { deps, lines, lock } = commandDeps(database, { acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
    expect(await runRetryCommand(["--held", "--dry-run"], deps)).toBe(0);
    expect(lock.taken).toBe(0);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^would retry ${eligible.id.slice(0, 8)} Acme Robotics`)));
    expect(lines.at(-1)).toBe("Dry run: would retry 1; skipped 1; nothing written.");
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("refuses to run while another process holds the pipeline lock, and releases its own", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-lock-");
    const eligible = syntheticHeldRun(database, { company: "Acme Robotics", by: "pipeline" });
    const before = snapshot(database);
    const held = acquirePipelineLock(dataDir);
    const blocked = commandDeps(database, { dataDir: () => dataDir, acquireLock: undefined });
    delete blocked.deps.acquireLock;
    expect(await runRetryCommand(["--held"], blocked.deps)).toBe(1);
    expect(blocked.lines).toEqual([expect.stringMatching(/^Not run: A pipeline run is already in progress/)]);
    expect(snapshot(database)).toEqual(before);
    held();

    const seen: Array<number | undefined> = [];
    const free = commandDeps(database, {
      dataDir: () => dataDir,
      open: () => { seen.push(readPipelineLock(dataDir)?.pid); return database; }
    });
    delete free.deps.acquireLock;
    expect(await runRetryCommand(["--run", eligible.id], free.deps)).toBe(0);
    expect(seen).toEqual([process.pid]);
    expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    expect(statusOf(database, eligible.jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  it("--start runs one pass while still holding the lock, and the pass starts the fresh automatic run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir);
    const reports: PipelineReport[] = [];
    const { deps, lines, lock } = commandDeps(database, {
      startPass: async (_profile, log) => {
        expect(lock.held).toBe(true);
        const report = await pass(database, dataDir, async () => fakePage());
        log(`browser runs started ${report.started.length}`);
        reports.push(report);
      }
    });
    expect(await runRetryCommand(["--run", run.id.slice(0, 8), "--start"], deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(reports[0]!.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(lines.slice(-2)).toEqual(["Starting one pipeline pass without discovery.", "browser runs started 1"]);
    database.close();
  });

  it("--start runs no pass when nothing was retried", async () => {
    const database = disposableDatabase();
    syntheticHeldRun(database, { company: "Cedar Labs", by: "candidate" });
    const { deps, lines } = commandDeps(database, { startPass: async () => { throw new Error("must not run a pass"); } });
    expect(await runRetryCommand(["--held", "--start"], deps)).toBe(0);
    expect(lines.at(-1)).toBe("Nothing retried; no pass started.");
    database.close();
  });

  it("notes when auto-apply is off, and refuses in manual checklist mode", async () => {
    const database = disposableDatabase();
    const eligible = syntheticHeldRun(database, { company: "Acme Robotics", by: "pipeline" });
    const manual = commandDeps(database, { env: { INTERNSHIP_AGENT_MANUAL_ONLY: "1", INTERNSHIP_AGENT_AUTO_APPLY: "1" } });
    expect(await runRetryCommand(["--held"], manual.deps)).toBe(1);
    expect(manual.lock.taken).toBe(0);
    expect(statusOf(database, eligible.jobId)).toBe("APPLYING");

    const off = commandDeps(database, { env: {} });
    expect(await runRetryCommand(["--held"], off.deps)).toBe(0);
    expect(off.lines.at(-1)).toMatch(/^Auto-apply is off/);
    database.close();
  });

  it.each([
    [[]],
    [["--held", "--run", "abcdef12"]],
    [["--held", "--dry-run", "--start"]],
    [["--run"]],
    [["--held", "--reason", "   "]],
    [["--held", "--profile", "other"]],
    [["--held", "--bogus"]],
    [["--held", "--reopen-unsubmitted", "--reason", "x"]],
    [["--run", "abcdef12", "--reopen-unsubmitted"]],
    [["--run", "abcdef12", "--reopen-unsubmitted", "--reopen-unsubmitted", "--reason", "x"]]
  ])("prints the usage for %j", async (argv) => {
    const database = disposableDatabase();
    const { deps, lines, lock } = commandDeps(database);
    expect(await runRetryCommand(argv, deps)).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^Usage: pnpm pipeline:retry/)]);
    expect(lock.taken).toBe(0);
    database.close();
  });
});

describe("pnpm pipeline:retry and Workday", () => {
  const siteUrl = "https://granite.wd5.myworkdayjobs.com/External/job/US-VA/Intern_R1";
  const errorText = "The field Referral Code is required and must have a value.";

  /** A minimal Workday tenant whose My Information step Workday will not save: Referral Code looks optional but is required. */
  function strictWorkday(): WorkdayPage {
    const steps = [
      { name: "My Information", controls: [
        { tag: "input", type: "email", id: "formField-emailAddress", label: "Email", required: true },
        { tag: "input", type: "text", id: "formField-referralCode", label: "Referral Code", required: false }
      ] as RawControl[] },
      { name: "Review", controls: [] as RawControl[] }
    ];
    let index = 0;
    const filled = new Set<string>();
    const details: WorkdayPageError[] = [
      { fieldId: "formField-referralCode", label: "Referral Code", text: errorText, source: "field" },
      { fieldId: null, label: null, text: `Referral Code: ${errorText}`, source: "banner" }
    ];
    return {
      ...fakePage(),
      url: () => siteUrl,
      title: async () => "Workday",
      collectControls: async () => steps[index]!.controls,
      fillField: async (field) => { filled.add(field.id); },
      enterApplication: async () => "flow",
      signInRequired: async () => false,
      activeStep: async () => ({ index: index + 1, total: steps.length, name: steps[index]!.name }),
      footerAction: async () => (steps[index]!.name === "Review" ? "Submit" : "Save and Continue"),
      fillHistory: async () => null,
      backTo: async () => false,
      nextStep: async () => {
        if (!filled.has("formField-referralCode")) return { moved: false, errors: [...new Set(details.map((error) => error.text))], details };
        index += 1;
        return { moved: true, errors: [] };
      }
    };
  }

  it("--held retries an automatic Workday run paused by Workday's page errors", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = seededJob(database);
    prepareApplication(jobId, { database });
    database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?").run(siteUrl, jobId);
    saveBrowserSession(database, { site: "workday:granite.wd5.myworkdayjobs.com/External", status: "connected", detail: "Signed in.", checkedAt: new Date().toISOString() });
    const report = await pass(database, dataDir, async () => strictWorkday());
    expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
    const run = listBrowserRuns(database, jobId)[0]!;
    expect(run.pauses.filter((pause) => pause.status === "open").map((pause) => [pause.fieldId, pause.label])).toEqual([
      ["My Information::workday-error::formField-referralCode", `Referral Code: ${errorText}`]
    ]);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--held"], deps)).toBe(0);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^retried ${run.id.slice(0, 8)} .*: cancelled; the application is back to ready for review\\.$`)));
    expect(lines).toContain("Retried 1; skipped 0.");
    expect(listBrowserRuns(database, jobId)[0]!.status).toBe("cancelled");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  describe("Workday account holds", () => {
    const email = "jordan@example.test";
    const stamp = "2026-11-20T08:31:00.000Z";
    const unexpectedReason = "Workday examplebrands.wd5.myworkdayjobs.com: the account step stopped (Workday did not answer within 20 seconds). Sign in yourself with Open sign-in on the Workday accounts page.";

    function accountsFixture() {
      const file = join(disposableDirectory("internship-agent-retry-accounts-"), "config", "workday-accounts.json");
      const env = { INTERNSHIP_AGENT_AUTO_APPLY: "1", INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL: email, INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE: file };
      putWorkdayAccount(file, {
        host: "examplebrands.wd5.myworkdayjobs.com", email, password: "Fixture-Pass-1234!", account: "pending",
        hold: { kind: "unexpected", reason: unexpectedReason, at: stamp, attempts: 1 }, createdAt: stamp, updatedAt: stamp
      });
      putWorkdayAccount(file, {
        host: "captcha.wd1.myworkdayjobs.com", email, password: null, account: null,
        hold: { kind: "captcha", reason: "Workday captcha.wd1.myworkdayjobs.com: Workday shows a CAPTCHA.", at: stamp, attempts: 1 }, createdAt: stamp, updatedAt: stamp
      });
      putWorkdayAccount(file, {
        host: "lost.wd1.myworkdayjobs.com", email, password: "Fixture-Pass-5678!", account: "pending",
        hold: { kind: "interrupted", reason: "Workday lost.wd1.myworkdayjobs.com: the account was probably not created.", at: stamp, attempts: 1 }, createdAt: stamp, updatedAt: stamp
      });
      return { file, env };
    }

    it("--held --dry-run lists the unexpected hold and changes nothing", async () => {
      const database = disposableDatabase();
      const { file, env } = accountsFixture();
      const before = readFileSync(file, "utf8");
      const { deps, lines, lock } = commandDeps(database, { env, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
      expect(await runRetryCommand(["--held", "--dry-run"], deps)).toBe(0);
      expect(lock.taken).toBe(0);
      expect(lines).toEqual([
        "No held runs.",
        `would release the Workday account hold on examplebrands.wd5.myworkdayjobs.com (${unexpectedReason})`,
        "Dry run: would retry 0; skipped 0; nothing written.",
        "Dry run: would release 1 Workday account hold(s)."
      ]);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(releasableWorkdayHolds(file).map((entry) => entry.host)).toEqual(["examplebrands.wd5.myworkdayjobs.com"]);
      database.close();
    });

    it("--held releases only the unexpected hold, keeps the saved password, and opens the account gate", async () => {
      const database = disposableDatabase();
      const { file, env } = accountsFixture();
      const resolved = resolveWorkdayAccounts(workdayAccountSettings(env)!, undefined, env);
      expect(workdayAccountWait(resolved, "examplebrands.wd5.myworkdayjobs.com", email)).toBe(unexpectedReason);
      const { deps, lines, lock } = commandDeps(database, { env });
      expect(await runRetryCommand(["--held"], deps)).toBe(0);
      expect(lock).toEqual({ taken: 1, released: 1, held: false });
      expect(lines).toEqual([
        "No held runs.",
        `released the Workday account hold on examplebrands.wd5.myworkdayjobs.com (${unexpectedReason}): the next pass signs in with the saved password.`,
        "Retried 0; skipped 0.",
        "Released 1 Workday account hold(s)."
      ]);
      expect(getWorkdayAccount(file, "examplebrands.wd5.myworkdayjobs.com")).toMatchObject({
        hold: null, password: "Fixture-Pass-1234!", account: "pending", email, createdAt: stamp
      });
      expect(getWorkdayAccount(file, "captcha.wd1.myworkdayjobs.com")?.hold?.kind).toBe("captcha");
      expect(getWorkdayAccount(file, "lost.wd1.myworkdayjobs.com")?.hold?.kind).toBe("interrupted");
      expect(workdayAccountWait(resolved, "examplebrands.wd5.myworkdayjobs.com", email)).toBeNull();
      expect(workdayAccountWait(resolved, "lost.wd1.myworkdayjobs.com", email)).toContain("probably not created");
      database.close();
    });

    it("--held --start runs a pass when only an account hold was released", async () => {
      const database = disposableDatabase();
      const { env } = accountsFixture();
      let passes = 0;
      const { deps, lines } = commandDeps(database, { env, startPass: async () => { passes += 1; } });
      expect(await runRetryCommand(["--held", "--start"], deps)).toBe(0);
      expect(passes).toBe(1);
      expect(lines.at(-1)).toBe("Starting one pipeline pass without discovery.");
      database.close();
    });

    it("leaves the accounts file alone without the account settings", async () => {
      const database = disposableDatabase();
      const { file } = accountsFixture();
      const before = readFileSync(file, "utf8");
      const { deps, lines } = commandDeps(database, { env: { INTERNSHIP_AGENT_AUTO_APPLY: "1", INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE: file } });
      expect(await runRetryCommand(["--held"], deps)).toBe(0);
      expect(lines).toEqual(["No held runs.", "Retried 0; skipped 0."]);
      expect(readFileSync(file, "utf8")).toBe(before);
      database.close();
    });
  });
});

describe("pnpm pipeline:retry --reopen-unsubmitted", () => {
  const submitWait = { timeoutMs: 50, pollMs: 5 };
  const REASON = "Greenhouse security code step handled.";
  const EMAIL_TEXT = "Greenhouse emailed a security code after the submit click";
  const EVIDENCE_TEXT = "its post-submit evidence shows the site's emailed security-code step";

  /** A page whose submit click never confirms and shows nothing recognizable. */
  function unconfirmedPage(): BrowserPage {
    return { ...fakePage(), bodyText: async () => "Please fix the errors below.", invalidFields: async () => [], submitControlShown: async () => true };
  }

  /** The Gmail watcher's timeline note for Greenhouse's security-code email (mailEventDetail's format). */
  function securityCodeEvent(database: DatabaseSync, jobId: string, company: string, options: { domain?: string; label?: string } = {}) {
    logApplicationEvent(database, {
      jobId, fromStatus: "APPLYING", toStatus: "APPLYING",
      detail: `Email received: ${options.label ?? "Recruiter reply"} from ${options.domain ?? "us.greenhouse-mail.io"}: "Security code for your application to ${company}"`
    });
  }

  // The watcher once filed the email as a recruiter reply (the note already stored for Tidewave); it now files it as a verification code.
  it.each(["Recruiter reply", "Verification code"])("reads Greenhouse's security-code email noted as \"%s\" as evidence", async (label) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    securityCodeEvent(database, jobId, "Northstar Systems", { label });
    expect(unsubmittedEvidence(database, dataDir, run)).toEqual({ kind: "security-code-email", text: EMAIL_TEXT });
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toBeNull();
    expect(reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON }).run.status).toBe("cancelled");
    database.close();
  });

  it("reads the note the Gmail watcher writes today for Greenhouse's security-code email as evidence", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    const job: AppliedJob = {
      id: jobId, companyName: "Northstar Systems", title: "Software Engineering Intern", status: "APPLYING", submitted: false,
      sourceUrl: "https://boards.greenhouse.io/northstar/jobs/2", externalApplicationUrl: null
    };
    const item = evaluateMail({
      header: { uid: 1, messageId: "<code@example.test>", fromName: "", fromAddress: "no-reply@us.greenhouse-mail.io",
        subject: "Security code for your application to Northstar Systems", receivedAt: new Date(), bulk: false },
      body: "Copy and paste this code into the security code field on your application: Qz8Lm3Xp", jobs: [job], uidValidity: "1"
    })!;
    expect(item.category).toBe("verification");
    logApplicationEvent(database, { jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: mailEventDetail(item) });
    expect(unsubmittedEvidence(database, dataDir, run)).toEqual({ kind: "security-code-email", text: EMAIL_TEXT });
    database.close();
  });

  /** An automatic run whose approved submit click failed unconfirmed (as "still refuses a failed unconfirmed submit"). */
  async function failedUnconfirmed(database: DatabaseSync, dataDir: string): Promise<{ jobId: string; run: BrowserRun }> {
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    await expect(submitBrowserRun(run.id, { database, dataDir, submitWait, openPage: async () => unconfirmedPage(), applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmed);
    const failed = listBrowserRuns(database, jobId)[0]!;
    expect(failed.status).toBe("failed");
    return { jobId, run: failed };
  }

  it("reopens a failed submit with Greenhouse's security-code email after the click, and the next pass starts a fresh run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    securityCodeEvent(database, jobId, "Northstar Systems");
    const ref = run.id.slice(0, 8);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", ref, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(
      `^reopened ${ref} Northstar Systems .*: cancelled as not submitted \\(${EMAIL_TEXT}\\); the application is back to ready for review\\.$`)));
    expect(lines).toContain("Reopened 1; skipped 0.");
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe(`Automatic run retried after a fix: reopened as not submitted (${EMAIL_TEXT}): ${REASON}`);
    const next = await pass(database, dataDir, async () => fakePage());
    expect(next.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    database.close();
  });

  it("reopens a failed submit whose stored evidence shows the security-code step", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    expect(unsubmittedEvidence(database, dataDir, run)).toBeNull();
    await savePostSubmitEvidence({
      database, dataDir, run, page: fakePage(),
      evidence: { outcome: "verification-code", url: "https://boards.greenhouse.io/example/jobs/2", bodyText: "Security code", invalidFields: [], alertText: "", challenge: null }
    });
    expect(unsubmittedEvidence(database, dataDir, run)).toEqual({ kind: "verification-code-evidence", text: EVIDENCE_TEXT });
    const { run: cancelled, evidence } = reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON });
    expect(cancelled.status).toBe("cancelled");
    expect(evidence.kind).toBe("verification-code-evidence");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe(`Automatic run retried after a fix: reopened as not submitted (${EVIDENCE_TEXT}): ${REASON}`);
    database.close();
  });

  it("refuses a failed submit with no evidence, and plain --run still refuses it with the email", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    const before = snapshot(database);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lines).toContainEqual(expect.stringMatching(/^skipped .*\(there is no evidence the site did not complete it/));
    expect(lines.at(-1)).toBe("Reopened 0; skipped 1.");
    expect(snapshot(database)).toEqual(before);
    expect(() => reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);

    securityCodeEvent(database, jobId, "Northstar Systems");
    const withEmail = snapshot(database);
    const plain = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--reason", REASON], plain.deps)).toBe(0);
    expect(plain.lines).toContainEqual(expect.stringMatching(/^skipped .*\(its submission was approved, so it may have reached the site\.\)$/));
    expect(snapshot(database)).toEqual(withEmail);
    database.close();
  });

  it.each([
    ["an email logged before the approval", "before"],
    ["an email about another company", "company"],
    ["an email from a look-alike sender", "sender"]
  ] as const)("refuses %s", async (_name, variant) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    if (variant === "company") securityCodeEvent(database, jobId, "Other Fixture Works");
    else if (variant === "sender") securityCodeEvent(database, jobId, "Northstar Systems", { domain: "greenhouse.io.example.test" });
    else {
      securityCodeEvent(database, jobId, "Northstar Systems");
      updateBrowserRun(database, run.id, { submissionApprovedAt: new Date(Date.now() + 60_000).toISOString() });
    }
    const current = listBrowserRuns(database, jobId)[0]!;
    expect(reopenUnsubmittedBlocker(database, dataDir, current)).toMatch(/^there is no evidence the site did not complete it/);
    const before = snapshot(database);
    expect(() => reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("refuses a paused, a submitted, a confirmed, and a candidate-started run", async () => {
    const paused = disposableDatabase();
    const pausedData = disposableDirectory("internship-agent-retry-data-");
    const held = await heldAutomaticRun(paused, pausedData);
    securityCodeEvent(paused, held.jobId, "Northstar Systems");
    expect(reopenUnsubmittedBlocker(paused, pausedData, held.run)).toBe("it is paused-needs-input; --reopen-unsubmitted reopens only a failed submit.");
    paused.close();

    const submitted = disposableDatabase();
    const submittedData = disposableDirectory("internship-agent-retry-data-");
    const sent = await heldAutomaticRun(submitted, submittedData, null);
    approveRunSubmission(sent.run.id, undefined, { database: submitted });
    await submitBrowserRun(sent.run.id, { database: submitted, dataDir: submittedData, openPage: async () => fakePage(), applicationRecord: null });
    securityCodeEvent(submitted, sent.jobId, "Northstar Systems");
    const before = snapshot(submitted);
    const command = commandDeps(submitted, { dataDir: () => submittedData });
    expect(await runRetryCommand(["--run", sent.run.id, "--reopen-unsubmitted", "--reason", REASON], command.deps)).toBe(0);
    expect(command.lines).toContainEqual(expect.stringMatching(/\(it is submitted; --reopen-unsubmitted reopens only a failed submit\.\)$/));
    expect(snapshot(submitted)).toEqual(before);
    submitted.close();

    const confirmed = disposableDatabase();
    const synthetic = syntheticHeldRun(confirmed, { company: "Acme Robotics", by: "pipeline", status: "failed" });
    updateBrowserRun(confirmed, synthetic.id, { submissionApprovedAt: new Date(Date.now() - 60_000).toISOString(), confirmationText: "Thank you for applying." });
    securityCodeEvent(confirmed, synthetic.jobId, "Acme Robotics");
    const confirmedRun = listBrowserRuns(confirmed, synthetic.jobId)[0]!;
    expect(reopenUnsubmittedBlocker(confirmed, "/nonexistent/retry-test", confirmedRun)).toBe("a confirmation was recognized, so it stays as it is.");
    confirmed.close();

    const mine = disposableDatabase();
    const mineData = disposableDirectory("internship-agent-retry-data-");
    const jobId = seededJob(mine, "approved");
    const { run } = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/2", {
      database: mine, dataDir: mineData, renderPdf: async () => ({ pages: 1 }), voiceDrafter: null, openPage: async () => fakePage()
    });
    approveRunSubmission(run.id, undefined, { database: mine });
    await expect(submitBrowserRun(run.id, { database: mine, dataDir: mineData, submitWait, openPage: async () => unconfirmedPage(), applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmed);
    securityCodeEvent(mine, jobId, "Northstar Systems");
    const mineRun = listBrowserRuns(mine, jobId)[0]!;
    expect(mineRun.status).toBe("failed");
    expect(reopenUnsubmittedBlocker(mine, mineData, mineRun)).toBe("you started it yourself; only runs the pipeline started are reopened.");
    mine.close();
  });

  it("--dry-run names what it would reopen, writes nothing, and takes no lock", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    securityCodeEvent(database, jobId, "Northstar Systems");
    const before = snapshot(database);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
    expect(await runRetryCommand(["--run", run.id.slice(0, 8), "--reopen-unsubmitted", "--reason", REASON, "--dry-run"], deps)).toBe(0);
    expect(lock.taken).toBe(0);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^would reopen ${run.id.slice(0, 8)} Northstar Systems .*\\(${EMAIL_TEXT}\\)$`)));
    expect(lines.at(-1)).toBe("Dry run: would reopen 1; skipped 0; nothing written.");
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("--start runs no pass when nothing was reopened", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { run } = await failedUnconfirmed(database, dataDir);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir, startPass: async () => { throw new Error("must not run a pass"); } });
    expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON, "--start"], deps)).toBe(0);
    expect(lines.at(-1)).toBe("Nothing reopened; no pass started.");
    database.close();
  });

  it("leaves a run held for a missing security code paused with the approval withdrawn, and retryable", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    const flag = { clicked: false };
    const codeStep: BrowserPage = {
      ...fakePage({ submitted: flag }),
      bodyText: async () => (flag.clicked ? "We sent a security code to your email address. Enter it below, then submit your application again." : "Please fix the errors below."),
      invalidFields: async () => [],
      submitControlShown: async () => true,
      securityCodeInputs: async () => (flag.clicked ? 8 : 0),
      submitSecurityCode: async () => { throw new Error("must not type a code"); }
    };
    const emptyMailbox: VerificationMailboxFactory = async () => ({ messagesSince: async () => [], close: async () => undefined });
    await expect(submitBrowserRun(run.id, {
      database, dataDir, submitWait, openPage: async () => codeStep, applicationRecord: null,
      securityCodeMailbox: emptyMailbox, securityCodeWait: { pollMs: 1, timeoutMs: 20, sleep: async () => undefined }
    })).rejects.toBeInstanceOf(SubmissionCodeNotFound);
    const held = listBrowserRuns(database, jobId)[0]!;
    expect(held.status).toBe("paused-needs-input");
    expect(held.submissionApprovedAt).toBeNull();
    expect(held.pauses).toContainEqual(expect.objectContaining({ fieldId: "site-security-code", safeguard: true, status: "open" }));
    expect(automaticRetryBlocker(database, held)).toBeNull();
    expect(retryAutomaticRun(database, run.id, { reason: "Security code read" }).status).toBe("cancelled");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });
});

/**
 * The daily auto-submit cap counts only automatic approvals that may have
 * reached the site: a withdrawn approval (field errors, a missing security
 * code) or a failed submit reopened as not submitted frees its slot; a
 * submitted, submitting, failed, or still-approved run keeps it.
 */
describe("daily auto-submit cap", () => {
  const target = { season: "summer", year: 2027 } as const;
  const capOne: PipelineSettings = { minFit: 0, autoApply: true, target, autoSubmit: { minFit: 80, dailyCap: 1 } };
  const submitWait = { timeoutMs: 50, pollMs: 5 };
  const usedUp = "Today's 1 automatic submissions are used up.";
  const startOfToday = () => { const midnight = new Date(); midnight.setHours(0, 0, 0, 0); return midnight.toISOString(); };

  /** The seeded posting, qualified with a strong current AI fit, so a clean run is submitted automatically. */
  function qualifiedForAutoSubmit(database: DatabaseSync): string {
    const jobId = seededJob(database);
    saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
      score: 86, rating: "STRONG", confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
      decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
    });
    return jobId;
  }

  function autoPass(database: DatabaseSync, dataDir: string, openPage: PageFactory, extra: { securityCodeMailbox?: VerificationMailboxFactory } = {}) {
    return advancePipeline({
      database, dataDir, settings: capOne, openPage, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
      fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider(), submitWait,
      securityCodeMailbox: extra.securityCodeMailbox ?? null, securityCodeWait: { pollMs: 1, timeoutMs: 20, sleep: async () => undefined }
    });
  }

  /** An earlier automatic approval today on another company's run, left in `status` (approval kept or withdrawn). */
  function earlierApproval(database: DatabaseSync, status: BrowserRun["status"], approval: "kept" | "withdrawn"): BrowserRun {
    const run = syntheticHeldRun(database, { company: "Tidewave", by: "pipeline", status });
    logApplicationEvent(database, { jobId: run.jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: AUTO_SUBMIT_EVENT + ": earlier today." });
    return approval === "kept" ? updateBrowserRun(database, run.id, { submissionApprovedAt: new Date().toISOString() }) : run;
  }

  /** A page whose submit click never confirms; with field errors, it marks the start-date field invalid after the click. */
  function unconfirmedPage(fieldErrors: boolean): BrowserPage {
    const flag = { clicked: false };
    return {
      ...fakePage({ submitted: flag }),
      bodyText: async () => "Please fix the errors below.",
      invalidFields: async () => (fieldErrors && flag.clicked ? [{ ref: "q1", label: "What is your available start date?", error: "This field is required." }] : []),
      submitControlShown: async () => true
    };
  }

  it.each([
    ["submitted", "submitted"],
    ["still submitting", "submitting"],
    ["failed with an unknown outcome", "failed"],
    ["approved and not yet submitted", "awaiting-approval"],
    ["cancelled without a reopen", "cancelled"]
  ] as const)("counts an approval whose run is %s", async (_name, status) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = qualifiedForAutoSubmit(database);
    earlierApproval(database, status, "kept");
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    const flag = { clicked: false };
    const report = await autoPass(database, dataDir, async () => fakePage({ submitted: flag }));
    expect(report.submitted).toEqual([]);
    expect(report.held).toEqual([{ jobId, reasons: [usedUp] }]);
    expect(flag.clicked).toBe(false);
    database.close();
  });

  it("does not count an approval withdrawn into paused-needs-input", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = qualifiedForAutoSubmit(database);
    earlierApproval(database, "paused-needs-input", "withdrawn");
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);
    const report = await autoPass(database, dataDir, async () => fakePage());
    expect(report.held).toEqual([]);
    expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    database.close();
  });

  it("frees the slot of a submit the site refused with field errors, so the retried run is submitted the same day", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = qualifiedForAutoSubmit(database);
    const first = await autoPass(database, dataDir, async () => unconfirmedPage(true));
    expect(first.submitted).toEqual([]);
    const held = listBrowserRuns(database, jobId)[0]!;
    expect(held).toMatchObject({ status: "paused-needs-input", submissionApprovedAt: null });
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);
    retryAutomaticRun(database, held.id, { reason: "School field fixed" });
    const second = await autoPass(database, dataDir, async () => fakePage());
    expect(second.held).toEqual([]);
    expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    database.close();
  });

  it("frees the slot of a run held for a missing security code", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = qualifiedForAutoSubmit(database);
    const flag = { clicked: false };
    const codeStep: BrowserPage = {
      ...fakePage({ submitted: flag }),
      bodyText: async () => (flag.clicked ? "We sent a security code to your email address. Enter it below, then submit your application again." : "Please fix the errors below."),
      invalidFields: async () => [],
      submitControlShown: async () => true,
      securityCodeInputs: async () => (flag.clicked ? 8 : 0),
      submitSecurityCode: async () => { throw new Error("must not type a code"); }
    };
    const emptyMailbox: VerificationMailboxFactory = async () => ({ messagesSince: async () => [], close: async () => undefined });
    const first = await autoPass(database, dataDir, async () => codeStep, { securityCodeMailbox: emptyMailbox });
    expect(first.submitted).toEqual([]);
    const held = listBrowserRuns(database, jobId)[0]!;
    expect(held).toMatchObject({ status: "paused-needs-input", submissionApprovedAt: null });
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);
    retryAutomaticRun(database, held.id, { reason: "Security code read" });
    const second = await autoPass(database, dataDir, async () => fakePage());
    expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    database.close();
  });

  it("counts a failed submit until it is reopened as not submitted, then frees its slot (the Tidewave case)", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-data-");
    const jobId = qualifiedForAutoSubmit(database);
    const first = await autoPass(database, dataDir, async () => unconfirmedPage(false));
    expect(first.submitted).toEqual([]);
    const failed = listBrowserRuns(database, jobId)[0]!;
    expect(failed.status).toBe("failed");
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    logApplicationEvent(database, {
      jobId, fromStatus: "APPLYING", toStatus: "APPLYING",
      detail: `Email received: Recruiter reply from us.greenhouse-mail.io: "Security code for your application to Northstar Systems"`
    });
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    reopenUnsubmittedRun(database, dataDir, failed.id, { reason: "Greenhouse security code step handled." });
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);
    const second = await autoPass(database, dataDir, async () => fakePage());
    expect(second.held).toEqual([]);
    expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    database.close();
  });
});

describe("pipeline pass under a held lock", () => {
  it("runs only when this process holds the lock, and leaves the lock to its holder", async () => {
    const directory = disposableDirectory("internship-agent-retry-pass-");
    const saved = Object.fromEntries(["INTERNSHIP_AGENT_DATA_DIR", "INTERNSHIP_AGENT_DISCORD_BOT_TOKEN", "INTERNSHIP_AGENT_DISCORD_USER_ID"]
      .map((name) => [name, process.env[name]]));
    process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
    delete process.env.INTERNSHIP_AGENT_DISCORD_BOT_TOKEN;
    delete process.env.INTERNSHIP_AGENT_DISCORD_USER_ID;
    try {
      const dataDir = resolveProfileDataDirectory("real");
      expect(dataDir.startsWith(directory)).toBe(true);
      const empty: PipelineReport = { analyzed: [], prepared: [], started: [], stopped: [], waiting: [], submitted: [], held: [], skipped: [], errors: [] };
      const advance = async () => empty;
      await expect(runPipelinePass({ profile: "real", sourceIds: [], log: () => {}, lockHeld: true, advance }))
        .rejects.toThrow("not held by this process");
      const release = acquirePipelineLock(dataDir);
      await runPipelinePass({ profile: "real", sourceIds: [], log: () => {}, lockHeld: true, advance });
      expect(readPipelineLock(dataDir)?.pid).toBe(process.pid);
      release();
      expect(existsSync(join(dataDir, "pipeline.lock"))).toBe(false);
    } finally {
      closeProfileDatabase("real");
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
