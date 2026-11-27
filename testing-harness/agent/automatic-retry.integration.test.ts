import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applicationHoldTrace,
  applicationReceiptConfirmed,
  closeProfileDatabase,
  createDatabase,
  getFitInputVersion,
  listApplicationEvents,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  persistNormalizedPosting,
  readApplicationReceiptCheck,
  reconcileProjectEvidence,
  recordApplicationReceipt,
  registerGitHubRepository,
  resolveProfileDataDirectory,
  reviewEvidenceClaim,
  saveBrowserRun,
  saveOutcomeEvent,
  saveBrowserSession,
  saveCandidateFact,
  saveSemanticFit,
  seedDevelopmentData,
  updateBrowserRun
} from "@internship-agent/db";
import { AUTO_SUBMIT_EVENT, runStartedByPipeline, type BrowserRun, type PauseRecord } from "@internship-agent/domain";
import {
  ASHBY_BUSY_DETAIL,
  ASHBY_NOT_SENT_DETAIL,
  SubmissionCodeNotFound,
  SubmissionNeedsInput,
  SubmissionUnconfirmed,
  type AshbySubmitCall,
  type AshbySubmitNetwork,
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
  closeUnsubmittedBlocker,
  closeUnsubmittedRun,
  continueBrowserRun,
  correctSubmittedBlocker,
  correctSubmittedRun,
  evaluateAndPersistMatch,
  getWorkdayAccount,
  listHeldRuns,
  prepareApplication,
  putWorkdayAccount,
  readPipelineLock,
  readStopEvidence,
  readSubmitEvidence,
  reopenUnsubmittedBlocker,
  requeueVerifiedHold,
  requeueVerifiedJobHold,
  releasableWorkdayHolds,
  reopenUnsubmittedRun,
  resolveWorkdayAccounts,
  retryAutomaticRun,
  runRetryCommand,
  savePostSubmitEvidence,
  saveStopEvidenceQuietly,
  startBrowserRun,
  submitBrowserRun,
  UnavailableModelProvider,
  unsubmittedEvidence,
  unsubmittedEvidenceRefusal,
  verifiedJobHoldBlocker,
  workdayAccountSettings,
  workdayAccountWait,
  type PageFactory,
  type PipelineReport,
  type PipelineSettings,
  type RetryCommandDeps,
  type VerificationMailboxFactory
} from "@internship-agent/agent";

import { mayHaveSubmitted, refreshApplicationHolds } from "../../packages/agent/src/application-holds";
import { evaluateMail, mailEventDetail, type AppliedJob, type MailHeader } from "../../packages/agent/src/mail-outcomes";
import type { MailSession, MailSessionFactory } from "../../packages/agent/src/mail-watch";
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
 * confirmation, and for paused, submitted, or candidate-started runs. It also
 * accepts synthetic captures that show the site never took the click (Ashby's
 * busy notice, Dover's Turnstile, older captures of the intact Ashby form or
 * of a Dover form with a Turnstile marker) and refuses each capture missing a
 * signal (another page, no submit control, no filled form, no Turnstile
 * marker, confirmation, failure or error text, invalid fields, another
 * challenge, a trusted receipt, no fresh receipt check, an older confirming
 * capture). `--close-unsubmitted` closes a never-clicked failed submit on a
 * closed posting (real auto-submit path) as skipped "Posting closed", and
 * `--correct-submitted` corrects a closed-dialog SUBMITTED relabel only with
 * `--confirm`, leaving a failed run held as a possible submission. A run
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
    events: database.prepare("SELECT COUNT(*) AS count FROM application_events").get(),
    feedback: database.prepare("SELECT COUNT(*) AS count FROM discovery_feedback").get(),
    holdEvents: database.prepare("SELECT COUNT(*) AS count FROM application_hold_events").get()
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
  applicationUrl?: string; atsKind?: BrowserRun["atsKind"];
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
    id: randomUUID(), jobId, applicationUrl: input.applicationUrl ?? sourceUrl, status: input.status ?? "paused-needs-input", packageId, variantId: null,
    baseResumeId: null, applicationProfile: "default", atsKind: input.atsKind ?? "greenhouse", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
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
    [["--run", "abcdef12", "--reopen-unsubmitted", "--reopen-unsubmitted", "--reason", "x"]],
    [["--run", "abcdef12", "--close-unsubmitted"]],
    [["--held", "--close-unsubmitted", "--reason", "x"]],
    [["--run", "abcdef12", "--close-unsubmitted", "--reason", "x", "--start"]],
    [["--run", "abcdef12", "--close-unsubmitted", "--reopen-unsubmitted", "--reason", "x"]],
    [["--run", "abcdef12", "--correct-submitted", "--reason", "x", "--start"]],
    [["--run", "abcdef12", "--confirm", "--reason", "x"]],
    [["--run", "abcdef12", "--correct-submitted", "--close-unsubmitted", "--reason", "x"]]
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

function receiptCheck(database: DatabaseSync, run: BrowserRun, result: "absent" | "ambiguous" | "unavailable" | "truncated" | "confirmed" = "absent", at = new Date(), attemptedAt = run.submissionApprovedAt!) {
  recordApplicationReceipt(database, { jobId: run.jobId, runId: run.id }, result, result === "confirmed" ? "a".repeat(32) : null, attemptedAt, at.toISOString());
}

describe("verified pre-submit hold retry", () => {
  it.each(["field-errors", "refused", "challenged", "verification-code", "unknown"] as const)(
    "refuses verified retry whenever %s evidence exists",
    async (outcome) => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-verified-evidence-");
      const run = syntheticHeldRun(database, { company: "Fixture", by: "pipeline", pauses: [] });
      const hold = refreshApplicationHolds(database, dataDir)[0]!;
      await savePostSubmitEvidence({
        database, dataDir, run, page: fakePage(),
        evidence: { outcome, url: "https://boards.greenhouse.io/example/jobs/2", bodyText: "", invalidFields: [], alertText: "", challenge: null }
      });
      expect(() => requeueVerifiedHold(database, dataDir, run.id, { revision: hold.revision, recheck: "abc123def" }, "Fixed"))
        .toThrow("may already have submitted");
      expect(listBrowserRuns(database, run.jobId)[0]?.status).toBe("paused-needs-input");
      database.close();
    }
  );

  it("still requeues a run whose only evidence is Track 42 stop captures (saved before any submit click)", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verified-stop-");
    const run = syntheticHeldRun(database, { company: "FixtureStop", by: "pipeline", pauses: [] });
    const hold = refreshApplicationHolds(database, dataDir)[0]!;
    await saveStopEvidenceQuietly({
      database, dataDir, run, page: fakePage(),
      stops: [
        { kind: "unfillable-field", reason: "the field did not respond in time", fieldLabel: "City", region: { kind: "field", fieldId: "city", label: "City" } },
        { kind: "run-failed", reason: "TimeoutError: locator.fill: Timeout 30000ms exceeded.", fieldLabel: null, region: { kind: "page" } }
      ]
    });
    expect(readStopEvidence(dataDir, run.jobId).map((entry) => entry.kind).sort()).toEqual(["run-failed", "unfillable-field"]);
    expect(requeueVerifiedHold(database, dataDir, run.id, { revision: hold.revision, recheck: "abc123def" }, "Fixed").status).toBe("cancelled");
    database.close();
  });

  it("requires the current manager revision and requeues only the selected automatic run with a trace", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verified-retry-");
    const target = syntheticHeldRun(database, { company: "FixtureTarget", by: "pipeline", status: "paused-needs-input", pauses: [] });
    const other = syntheticHeldRun(database, { company: "FixtureOther", by: "pipeline", status: "paused-needs-input", pauses: [] });
    const now = new Date("2026-11-22T10:00:00Z");
    const holds = refreshApplicationHolds(database, dataDir, now);
    const hold = holds.find((item) => item.runId === target.id)!;
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    const args = ["--run", target.id, "--verified-hold", "--recheck", "abc123def", "--reason", "Verified fixture repair", "--revision"];
    const before = snapshot(database);
    expect(await runRetryCommand([...args, String(hold.revision + 1)], deps)).toBe(0);
    expect(lines).toContainEqual(expect.stringContaining("hold revision changed"));
    expect(await runRetryCommand([...args, String(hold.revision), "--dry-run"], deps)).toBe(0);
    expect(snapshot(database)).toEqual(before);
    expect(await runRetryCommand([...args, String(hold.revision)], deps)).toBe(0);
    expect(listBrowserRuns(database, target.jobId)[0]?.status).toBe("cancelled");
    expect(statusOf(database, target.jobId)).toBe("READY_FOR_REVIEW");
    expect(listBrowserRuns(database, other.jobId)[0]?.status).toBe("paused-needs-input");
    expect(applicationHoldTrace(database, target.jobId).map((event) => event.event)).toEqual(["opened", "verified-retry", "resolved"]);
    database.close();
  });
});

/**
 * Track 31: a job-level hold (the automatic stop came before any run was
 * saved, as Workday's "No Workday application opened" did) is requeued with
 * `--job <ref> --verified-hold`, never by `--run` or `--held`.
 */
describe("verified job-level hold requeue (--job)", () => {
  const RECHECK = "abc123def";
  const REASON = "Workday entry fixed and rechecked";
  const NO_FORM: RawControl[] = [{ tag: "button", label: "Apply" }];

  /** The seeded posting, stopped by the pipeline before a run was saved, with its manager-owned job-level hold. */
  async function jobStoppedBeforeRun(database: DatabaseSync, dataDir: string) {
    const jobId = seededJob(database);
    const stopped = await pass(database, dataDir, async () => fakePage({ controls: NO_FORM }));
    expect(stopped.stopped).toHaveLength(1);
    expect(listBrowserRuns(database, jobId)).toEqual([]);
    expect(details(database, jobId).at(-1)).toMatch(/^Automatic browser run needs you: /);
    const hold = refreshApplicationHolds(database, dataDir).find((item) => item.jobId === jobId)!;
    expect(hold).toMatchObject({ key: `job:${jobId}`, runId: null, owner: "manager", reason: "automation-fault", revision: 1 });
    return { jobId, hold };
  }

  const jobArgs = (jobId: string, revision: number, extra: string[] = []) =>
    ["--job", jobId.slice(0, 8), "--verified-hold", "--revision", String(revision), "--recheck", RECHECK, "--reason", REASON, ...extra];

  it("requeues the job with a dry run first, releases the hold for good, and the next pass starts a fresh automatic run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-job-hold-");
    const { jobId, hold } = await jobStoppedBeforeRun(database, dataDir);
    // Without the requeue the stop blocks every later pass, and the run-level modes find nothing.
    expect((await pass(database, dataDir, neverOpen)).started).toEqual([]);
    const byRun = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", jobId.slice(0, 8), "--verified-hold", "--revision", "1", "--recheck", RECHECK, "--reason", REASON], byRun.deps)).toBe(0);
    expect(byRun.lines).toContainEqual(expect.stringContaining("no browser run matches"));

    const before = snapshot(database);
    const dry = commandDeps(database, { dataDir: () => dataDir, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
    expect(await runRetryCommand(jobArgs(jobId, hold.revision, ["--dry-run"]), dry.deps)).toBe(0);
    expect(dry.lines[0]).toMatch(new RegExp(`^would requeue job ${jobId.slice(0, 8)} Northstar Systems — .+ \\(ready for review\\) after verified pre-submit fix`));
    expect(dry.lines.at(-1)).toBe("Dry run: would retry 1; skipped 0; nothing written.");
    expect(snapshot(database)).toEqual(before);

    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(jobArgs(jobId, hold.revision), deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(lines[0]).toMatch(/^requeued job .+ its job-level hold is released; the next pass may start it under the usual checks\.$/);
    expect(lines).toContain("Retried 1; skipped 0.");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe(`Automatic run retried after a fix: ${REASON}`);
    expect(holdTrace(database, jobId)).toEqual(["opened", "verified-retry", "resolved"]);
    expect(applicationHoldTrace(database, jobId).find((event) => event.event === "verified-retry")).toMatchObject({ revision: 1, actionRef: RECHECK });
    // A later refresh does not reopen it: the requeue note is newer than the stop.
    expect(refreshApplicationHolds(database, dataDir).filter((item) => item.jobId === jobId)).toEqual([]);
    expect(storedActiveHolds(database, jobId)).toEqual([]);
    // Nothing is left to requeue: the released hold is no longer active.
    expect(() => requeueVerifiedJobHold(database, dataDir, jobId, { revision: 2, recheck: RECHECK }, REASON)).toThrow(AutomaticRetryRefused);

    const next = await pass(database, dataDir, async () => fakePage());
    expect(next.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(details(database, jobId).at(-1)).toBe(AUTO_START);
    database.close();
  });

  it("requeues a job whose stop before any run saved a Track 42 capture, never reading it as a submit attempt", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-job-hold-");
    const { jobId, hold } = await jobStoppedBeforeRun(database, dataDir);
    // The no-form stop saved a job-level capture; another job-level capture is added like the ZOLL crash's.
    await saveStopEvidenceQuietly({
      database, dataDir, run: { id: null, jobId }, page: fakePage(),
      stops: [{ kind: "run-failed", reason: "TimeoutError: locator.focus: Timeout 30000ms exceeded.", fieldLabel: null, region: { kind: "page" } }]
    });
    expect(readStopEvidence(dataDir, jobId).map((entry) => [entry.kind, entry.runId]).sort()).toEqual([["no-form", null], ["run-failed", null]]);
    expect(verifiedJobHoldBlocker(database, dataDir, jobId, { revision: hold.revision, recheck: RECHECK })).toBeNull();
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(jobArgs(jobId, hold.revision), deps)).toBe(0);
    expect(lines).toContain("Retried 1; skipped 0.");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  type Refusal = [string, (database: DatabaseSync, dataDir: string, jobId: string) => Promise<number | void> | number | void, RegExp];
  const liveRun = (database: DatabaseSync, jobId: string, status: BrowserRun["status"], extra: Partial<BrowserRun> = {}): BrowserRun => {
    const packageId = (database.prepare("SELECT id FROM application_packages WHERE job_id = ? AND superseded_at IS NULL").get(jobId) as { id: string }).id;
    const now = new Date().toISOString();
    return saveBrowserRun(database, {
      id: randomUUID(), jobId, applicationUrl: "https://boards.greenhouse.io/example/jobs/2", status, packageId, variantId: null,
      baseResumeId: null, applicationProfile: "default", atsKind: "greenhouse", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
      decisions: [], pauses: [], submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: now, updatedAt: now, ...extra
    });
  };
  const REFUSED: Refusal[] = [
    ["a run that is not cancelled exists", (database, _dataDir, jobId) => { liveRun(database, jobId, "paused-needs-input"); }, /has a browser run that is not cancelled .*use --run/],
    ["the revision is not the current one", () => 2, /the hold revision changed/],
    ["an approval was logged on the timeline", (database, _dataDir, jobId) => {
      logApplicationEvent(database, { jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "READY_FOR_REVIEW", detail: `${AUTO_SUBMIT_EVENT}.` });
    }, /timeline records a submit approval, attempt, or submission/],
    ["a cancelled run had a submit approval", (database, _dataDir, jobId) => {
      liveRun(database, jobId, "cancelled", { submissionApprovedAt: new Date(Date.now() - 60_000).toISOString() });
    }, /had a submit approval or confirmation/],
    ["post-submit evidence was saved for a cancelled run", async (database, dataDir, jobId) => {
      const run = liveRun(database, jobId, "cancelled");
      await savePostSubmitEvidence({
        database, dataDir, run, page: fakePage(),
        evidence: { outcome: "unknown", url: "https://boards.greenhouse.io/example/jobs/2", bodyText: "", invalidFields: [], alertText: "", challenge: null }
      });
    }, /records unknown after a submit click/],
    ["a cancelled run has a receipt", (database, _dataDir, jobId) => {
      const run = liveRun(database, jobId, "cancelled");
      recordApplicationReceipt(database, { jobId, runId: run.id }, "confirmed", "a".repeat(32), run.createdAt, new Date().toISOString());
    }, /has a receipt check/],
    ["the hold is not manager-owned", (database, _dataDir, jobId) => {
      database.prepare("UPDATE application_holds SET owner = 'candidate' WHERE hold_key = ?").run(`job:${jobId}`);
    }, /no active manager-owned job-level automation fault/]
  ];

  it.each(REFUSED)("refuses when %s and writes nothing", async (_name, setup, reason) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-job-hold-");
    const { jobId, hold } = await jobStoppedBeforeRun(database, dataDir);
    const revision = (await setup(database, dataDir, jobId)) ?? hold.revision;
    expect(verifiedJobHoldBlocker(database, dataDir, jobId, { revision, recheck: RECHECK })).toMatch(reason);
    const before = snapshot(database);
    expect(() => requeueVerifiedJobHold(database, dataDir, jobId, { revision, recheck: RECHECK }, REASON)).toThrow(AutomaticRetryRefused);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(jobArgs(jobId, revision), deps)).toBe(0);
    expect(lines[0]).toMatch(/^skipped job /);
    expect(lines[0]).toMatch(reason);
    expect(lines.at(-1)).toBe("Retried 0; skipped 1.");
    expect(snapshot(database)).toEqual(before);
    expect(details(database, jobId).some((detail) => detail.startsWith("Automatic run retried after a fix: "))).toBe(false);
    database.close();
  });

  it("takes --job only with --verified-hold, one job, and no --run, --held, or --start", async () => {
    const database = disposableDatabase();
    const { deps, lines } = commandDeps(database);
    const fix = ["--verified-hold", "--revision", "1", "--recheck", RECHECK, "--reason", REASON];
    for (const argv of [
      ["--job", "0907ae2c", "--reason", REASON],
      ["--job", "0907ae2c", "--held", ...fix],
      ["--job", "0907ae2c", "--run", "5aa7e33e", ...fix],
      ["--job", "0907ae2c", "--job", "5aa7e33e", ...fix],
      ["--job", "0907ae2c", "--start", ...fix],
      ["--job", ...fix]
    ]) expect(await runRetryCommand(argv, deps)).toBe(2);
    expect(lines.every((line) => line.startsWith("Usage: pnpm pipeline:retry"))).toBe(true);
    database.close();
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
    receiptCheck(database, run);
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
    receiptCheck(database, run);
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
    receiptCheck(database, run);
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
    expect(reopenUnsubmittedBlocker(paused, pausedData, held.run)).toBe("it is paused-needs-input; --reopen-unsubmitted reopens only a failed submit or a run held on Greenhouse's emailed security code.");
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
    expect(command.lines).toContainEqual(expect.stringMatching(/\(it is submitted; --reopen-unsubmitted reopens only a failed submit or a run held on Greenhouse's emailed security code\.\)$/));
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
    receiptCheck(database, run);
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

  it("requires a fresh complete check of this attempt and vetoes a trusted receipt", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-receipt-");
    const { jobId, run } = await failedUnconfirmed(database, dataDir);
    securityCodeEvent(database, jobId, "Northstar Systems");
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    for (const result of ["ambiguous", "unavailable", "truncated"] as const) {
      receiptCheck(database, run, result);
      expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    }
    receiptCheck(database, run, "absent", new Date(), "2025-01-01T00:00:00Z");
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    receiptCheck(database, run, "absent", new Date(Date.now() - 16 * 60_000));
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    receiptCheck(database, run, "confirmed");
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("trusted application receipt");
    expect(() => reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);
    expect(statusOf(database, jobId)).toBe("APPLYING");
    database.close();
  });

  it.each([
    ["matched", "q1", "What is your available start date?", "candidate-question"],
    ["unmatched", "missing-field", "Unrecognized site field", "manual-field-correction"]
  ] as const)("routes a %s post-submit field rejection to candidate action", async (match, ref, label, reason) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-retry-field-");
    const { run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    expect(refreshApplicationHolds(database, dataDir)[0]).toMatchObject({ owner: "manager", reason: "form-review" });

    const flag = { clicked: false };
    let submitClicks = 0;
    const page = fakePage({ submitted: flag });
    const rejected: BrowserPage = {
      ...page,
      clickSubmit: async () => { submitClicks += 1; await page.clickSubmit(); },
      bodyText: async () => "Please fix the errors below.",
      submitControlShown: async () => true,
      invalidFields: async () => flag.clicked ? [{ ref, label, error: "This field is required." }] : []
    };
    await expect(submitBrowserRun(run.id, { database, dataDir, submitWait, openPage: async () => rejected, applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionNeedsInput);
    const current = listBrowserRuns(database, run.jobId)[0]!;
    expect(current.submissionApprovedAt).toBeNull();
    expect(current.pauses).toContainEqual(expect.objectContaining({
      fieldId: match === "matched" ? "q1" : "site-error-1", safeguard: match === "unmatched", status: "open"
    }));
    expect(refreshApplicationHolds(database, dataDir)[0]).toMatchObject({ owner: "candidate", reason });
    if (match === "matched") {
      await answerRunPause(run.id, "q1", "2027-05-15", false, { database });
      const continued = await continueBrowserRun(run.id, { database, dataDir, openPage: async () => ({
        ...fakePage(), clickSubmit: async () => { submitClicks += 1; }
      }) });
      expect(continued.run).toMatchObject({ id: run.id, status: "awaiting-approval", submissionApprovedAt: null });
      expect(refreshApplicationHolds(database, dataDir)[0]).toMatchObject({ owner: "candidate", reason: "approval" });
      const saved = readSubmitEvidence(dataDir, continued.run);
      expect(saved.map(({ outcome }) => outcome)).toEqual(["field-errors"]);
      expect(mayHaveSubmitted(continued.run, saved)).toBe(true);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date(Date.parse(saved[0]!.capturedAt) + 1_000));
        approveRunSubmission(run.id, undefined, { database });
      } finally { vi.useRealTimers(); }
      expect(refreshApplicationHolds(database, dataDir)[0]).toMatchObject({ owner: "manager", reason: "form-review" });
      expect(readSubmitEvidence(dataDir, run)).toEqual(saved);
      expect(submitClicks).toBe(1);
    }
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
    expect(refreshApplicationHolds(database, dataDir)[0]).toMatchObject({ owner: "manager", reason: "automation-fault" });
    expect(automaticRetryBlocker(database, held)).toBeNull();
    expect(retryAutomaticRun(database, run.id, { reason: "Security code read" }).status).toBe("cancelled");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });
});

/** Fictional Ashby and Dover pages, shaped like the real captures (scrubbed: no candidate or company data). */
const ASHBY_RUN_URL = "https://jobs.ashbyhq.com/fixture-robotics/0b6c1f1e-4c1a-4f37-9d3e-2f0a7c1d5e11/application";
const DOVER_RUN_URL = "https://app.dover.io/apply/job/5d2e8f4a-1b3c-4d5e-9f60-7a8b9c0d1e2f/";
const DOVER_EVIDENCE_URL = "https://jobs.dover.com/job/5d2e8f4a-1b3c-4d5e-9f60-7a8b9c0d1e2f";
const GREENHOUSE_RUN_URL = "https://boards.greenhouse.io/fixture-labs/jobs/1";
const TURNSTILE = "a Cloudflare Turnstile challenge";
const ASHBY_FORM = [
  "Software Engineering Intern", "Application", "Autofill from resume", "Upload file", "Name", "Email", "Resume",
  "resume-fixture.pdf", "Replace", "or drag and drop here", "Have you built a robot before?", "Yes", "No",
  "Submit Application", "Powered by"
].join("\n");
const DOVER_FORM = [
  "Software Engineering Intern", "Fixture Labs builds test rigs for small robots.", "Apply", "Autofill from resume",
  "First Name *", "Email *", "Resume *", "Resume: resume-fixture.pdf", "Are you based in the United States?", "Yes", "No",
  "Apply", "Jobs powered by"
].join("\n");
const REOPENED = "Automatic run retried after a fix: reopened as not submitted (";

/** A pipeline-started run whose approved submit failed with no confirmation, approved a minute ago. */
function failedSubmit(database: DatabaseSync, input: { company: string; applicationUrl: string; atsKind?: BrowserRun["atsKind"] }): BrowserRun {
  const run = syntheticHeldRun(database, { company: input.company, by: "pipeline", pauses: [], applicationUrl: input.applicationUrl, atsKind: input.atsKind });
  return updateBrowserRun(database, run.id, { status: "failed", submissionApprovedAt: new Date(Date.now() - 60_000).toISOString() });
}

/** One stored post-submit capture for the run (savePostSubmitEvidence, as the submit path writes it). */
async function capture(database: DatabaseSync, dataDir: string, run: BrowserRun, evidence: {
  outcome: "unknown" | "challenged" | "refused" | "field-errors" | "verification-code"; url: string; bodyText: string;
  detail?: string | null; challenge?: string | null; alertText?: string; invalidFields?: Array<{ ref: string | null; label: string; error: string }>; now?: Date;
  ashbyNetwork?: AshbySubmitNetwork | null;
}) {
  await savePostSubmitEvidence({
    database, dataDir, run, page: fakePage(), now: evidence.now,
    evidence: {
      outcome: evidence.outcome, url: evidence.url, bodyText: evidence.bodyText, detail: evidence.detail ?? null,
      challenge: evidence.challenge ?? null, alertText: evidence.alertText ?? "", invalidFields: evidence.invalidFields ?? [],
      ...(evidence.ashbyNetwork ? { ashbyNetwork: evidence.ashbyNetwork } : {})
    }
  });
}

/** An Ashby network record (Track 22) with the given submits and one reCAPTCHA token request per click. */
function ashbyNetwork(submits: Array<Partial<AshbySubmitCall>>): AshbySubmitNetwork {
  const full = submits.map((entry): AshbySubmitCall => ({
    operation: "ApiSubmitSingleApplicationFormAction", status: 200, failed: false, clicks: 1, recaptchaToken: "present",
    resultType: null, success: false, errorCodes: [], errorMessages: [], formErrorMessages: [], fieldErrors: [], blockMessage: false,
    ...entry
  }));
  return {
    calls: [{ operation: "ApiSetFormValue", status: 200, failed: false, clicks: 0 }, ...full.map((entry) => ({ operation: entry.operation, status: entry.status, failed: entry.failed, clicks: entry.clicks }))],
    submits: full,
    recaptchaTokenRequests: 1,
    recaptchaTokenStatuses: [200]
  };
}

const current = (database: DatabaseSync, run: BrowserRun) => listBrowserRuns(database, run.jobId).find((entry) => entry.id === run.id)!;
const activeHolds = (database: DatabaseSync, dataDir: string, jobId: string) =>
  refreshApplicationHolds(database, dataDir).filter((hold) => hold.jobId === jobId);
/**
 * The job's stored active holds, without a refresh: a refresh of a synthetic
 * READY_FOR_REVIEW job would read its placeholder package ("{}").
 */
const storedActiveHolds = (database: DatabaseSync, jobId: string) =>
  database.prepare("SELECT run_id AS runId, reason FROM application_holds WHERE job_id = ? AND active = 1").all(jobId);
const holdTrace = (database: DatabaseSync, jobId: string) => applicationHoldTrace(database, jobId).map((event) => event.event);

describe("pnpm pipeline:retry --reopen-unsubmitted with evidence the site never took the submit", () => {
  const REASON = "The site never took the click; the saved evidence shows the form.";

  type Case = {
    site: "ashby" | "dover"; outcome: "unknown" | "challenged"; detail?: string | null; challenge?: string | null; text: string; kind: string;
    ashbyNetwork?: AshbySubmitNetwork;
  };
  const ACCEPTED: Array<[string, Case]> = [
    ["Ashby's busy notice at the last click", { site: "ashby", outcome: "unknown", detail: ASHBY_BUSY_DETAIL, text: ASHBY_FORM, kind: "ashby-busy-evidence" }],
    ["Dover's Turnstile challenge (redirected page)", { site: "dover", outcome: "challenged", challenge: TURNSTILE, text: DOVER_FORM, kind: "dover-turnstile-evidence" }],
    ["an older capture of the intact Ashby form", { site: "ashby", outcome: "unknown", text: ASHBY_FORM, kind: "intact-form-evidence" }],
    ["an older Dover capture with a Turnstile marker", {
      site: "dover", outcome: "unknown", text: DOVER_FORM.replace("\nApply\nJobs", "\nVerify you are human\nApply\nJobs"), kind: "dover-turnstile-evidence"
    }],
    ["an intact Ashby capture whose network record shows a token request and no submit", {
      site: "ashby", outcome: "unknown", text: ASHBY_FORM, kind: "intact-form-evidence", ashbyNetwork: ashbyNetwork([])
    }]
  ];

  async function failedWith(database: DatabaseSync, dataDir: string, item: Case): Promise<BrowserRun> {
    const run = failedSubmit(database, item.site === "ashby"
      ? { company: "Fixture Robotics", applicationUrl: ASHBY_RUN_URL, atsKind: "ashby" }
      : { company: "Fixture Labs", applicationUrl: DOVER_RUN_URL, atsKind: "dover" });
    await capture(database, dataDir, run, {
      outcome: item.outcome, url: item.site === "ashby" ? ASHBY_RUN_URL : DOVER_EVIDENCE_URL, bodyText: item.text,
      detail: item.detail ?? null, challenge: item.challenge ?? null, ashbyNetwork: item.ashbyNetwork
    });
    return run;
  }

  it.each(ACCEPTED)("accepts %s: reopened, ready for review, and its possible-submission hold resolved", async (_name, item) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-never-taken-");
    const run = await failedWith(database, dataDir, item);
    expect(activeHolds(database, dataDir, run.jobId)).toEqual([expect.objectContaining({ runId: run.id, reason: "possible-submission" })]);
    const evidence = unsubmittedEvidence(database, dataDir, run);
    expect(evidence).toEqual({ kind: item.kind, text: expect.stringMatching(/^its post-submit evidence shows /) });
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    receiptCheck(database, run);
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toBeNull();
    const reopened = reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON });
    expect(reopened.run.status).toBe("cancelled");
    expect(reopened.evidence).toEqual(evidence);
    expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, run.jobId).at(-1)).toBe(`${REOPENED}${evidence!.text}): ${REASON}`);
    expect(storedActiveHolds(database, run.jobId)).toEqual([]);
    expect(holdTrace(database, run.jobId).slice(-2)).toEqual(["reopened-unsubmitted", "resolved"]);
    database.close();
  });

  it("reopens an older Ashby capture through the command, with a dry run first", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-never-taken-");
    const run = await failedWith(database, dataDir, ACCEPTED[2]![1]);
    receiptCheck(database, run);
    const text = unsubmittedEvidence(database, dataDir, run)!.text;
    const ref = run.id.slice(0, 8);
    const before = snapshot(database);
    const dry = commandDeps(database, { dataDir: () => dataDir, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
    expect(await runRetryCommand(["--run", ref, "--reopen-unsubmitted", "--reason", REASON, "--dry-run"], dry.deps)).toBe(0);
    expect(dry.lines).toContain(`would reopen ${ref} Fixture Robotics — Software Engineering Intern (failed) (${text})`);
    expect(dry.lines.at(-1)).toBe("Dry run: would reopen 1; skipped 0; nothing written.");
    expect(dry.lock.taken).toBe(0);
    expect(snapshot(database)).toEqual(before);

    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", ref, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(lines).toContain(`reopened ${ref} Fixture Robotics — Software Engineering Intern (failed): cancelled as not submitted (${text}); the application is back to ready for review.`);
    expect(lines).toContain("Reopened 1; skipped 0.");
    expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  const ashby: Case = ACCEPTED[2]![1];
  const REFUSED: Array<[string, Case & { setup?: (database: DatabaseSync, dataDir: string, run: BrowserRun) => Promise<void> | void; url?: string; alertText?: string; invalid?: boolean; receipt?: "none" | "confirmed" }, RegExp | string]> = [
    ["an older Dover capture without a Turnstile marker", { site: "dover", outcome: "unknown", text: DOVER_FORM, kind: "" }, /no Turnstile marker/],
    ["a capture without the submit control", { ...ashby, text: ASHBY_FORM.replace("\nSubmit Application", "") }, /does not show the submit control \("Submit Application"\)/],
    ["an older capture without the filled form", { ...ashby, text: ASHBY_FORM.replace("\nresume-fixture.pdf\nReplace", "") }, /does not show the filled form/],
    ["a capture of another Ashby job", { ...ashby, url: "https://jobs.ashbyhq.com/fixture-robotics/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d/application" }, /another address/],
    ["a capture with success text", { ...ashby, text: `${ASHBY_FORM}\nThanks for applying!` }, /shows confirmation text \("Thanks for applying"\)/],
    ["a capture with a required-field message", { ...ashby, text: ASHBY_FORM.replace("Submit Application", "This field is required.\nSubmit Application") }, /failure or correction text/],
    ["a capture with the site's error text", { ...ashby, alertText: "Something went wrong" }, /shows the site's error text/],
    ["a capture with an invalid field", { ...ashby, invalid: true }, /marked invalid/],
    ["a confirmed receipt", { ...ashby, receipt: "confirmed" }, "a trusted application receipt was found, so it stays as it is."],
    ["no fresh receipt check", { ...ashby, receipt: "none" }, /completed receipt check/],
    ["a Turnstile challenge on a Greenhouse page", { ...ashby, outcome: "challenged", challenge: TURNSTILE, url: GREENHOUSE_RUN_URL }, /only on an Ashby or Dover application page/],
    ["Ashby's busy detail on a Greenhouse page", { ...ashby, detail: ASHBY_BUSY_DETAIL, url: GREENHOUSE_RUN_URL }, /only on an Ashby or Dover application page/],
    ["Ashby's spam check", { ...ashby, outcome: "challenged", challenge: "Ashby's spam check (reCAPTCHA Enterprise)" }, /a challenge other than Dover's Turnstile/],
    // Track 27: a click on Ashby's own submit button that sent nothing is held as a site safeguard, never reopened.
    ["Ashby's not-sent hold", { ...ashby, outcome: "challenged", challenge: ASHBY_NOT_SENT_DETAIL }, /a challenge other than Dover's Turnstile/],
    ["a capture saved only before the approval", { ...ashby, setup: async (database, dataDir, run) => {
      rmSync(join(dataDir, "applications"), { recursive: true, force: true });
      await capture(database, dataDir, run, { outcome: "unknown", url: ASHBY_RUN_URL, bodyText: ASHBY_FORM, now: new Date(Date.parse(run.submissionApprovedAt!) - 30_000) });
    } }, /no post-submit evidence saved after it/],
    ["an older capture with a confirmation before a newer clean one", { ...ashby, setup: async (database, dataDir, run) => {
      await capture(database, dataDir, run, { outcome: "unknown", url: ASHBY_RUN_URL, bodyText: `Thank you for applying\n${ASHBY_FORM}`, now: new Date(Date.now() - 40_000) });
    } }, /shows confirmation text \("Thank you for applying"\)/],
    // Ashby's network record (Track 22): its server's answer outranks the intact page.
    ["Ashby's reCAPTCHA rejection in the network record", { ...ashby, ashbyNetwork: ashbyNetwork([{ errorCodes: ["RECAPTCHA_SCORE_BELOW_THRESHOLD"] }]) }, /reCAPTCHA \(spam check\) rejection/],
    ["Ashby's server accepting the submission", { ...ashby, ashbyNetwork: ashbyNetwork([{ resultType: "FormSubmitSuccess", success: true }]) }, /server accepting the submission/],
    ["a submit request with no answer", { ...ashby, ashbyNetwork: ashbyNetwork([{ status: null }]) }, /does not show that Ashby refused it/]
  ];

  it.each(REFUSED)("refuses %s and writes nothing", async (_name, item, reason) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-never-taken-");
    const pageUrl = item.url ?? (item.site === "ashby" ? ASHBY_RUN_URL : DOVER_EVIDENCE_URL);
    const run = failedSubmit(database, item.site === "ashby"
      ? { company: "Fixture Robotics", applicationUrl: item.url === GREENHOUSE_RUN_URL ? GREENHOUSE_RUN_URL : ASHBY_RUN_URL, atsKind: "ashby" }
      : { company: "Fixture Labs", applicationUrl: DOVER_RUN_URL, atsKind: "dover" });
    await capture(database, dataDir, run, {
      outcome: item.outcome, url: pageUrl, bodyText: item.text, detail: item.detail ?? null, challenge: item.challenge ?? null,
      alertText: item.alertText, invalidFields: item.invalid ? [{ ref: "q1", label: "Email", error: "Enter a valid email." }] : [],
      ashbyNetwork: item.ashbyNetwork
    });
    await item.setup?.(database, dataDir, run);
    if (item.receipt === "confirmed") receiptCheck(database, run, "confirmed");
    else if (item.receipt !== "none") receiptCheck(database, run);
    const blocker = reopenUnsubmittedBlocker(database, dataDir, run);
    if (typeof reason === "string") expect(blocker).toBe(reason);
    else expect(blocker).toMatch(reason);
    if (item.receipt === undefined) {
      expect(blocker).toMatch(/^there is no evidence the site did not complete it \(no security-code email after the submit click/);
      expect(unsubmittedEvidence(database, dataDir, run)).toBeNull();
      expect(unsubmittedEvidenceRefusal(database, dataDir, run)).toMatch(reason);
    }
    const before = snapshot(database);
    expect(() => reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lines.at(-1)).toBe("Reopened 0; skipped 1.");
    expect(snapshot(database)).toEqual(before);
    expect(current(database, run).status).toBe("failed");
    database.close();
  });

  /**
   * Track 31: Ashby's autofill banner and legal boilerplate read as correction
   * text. A network record that shows no submit request was sent decides;
   * without a record, or with a submit sent, the text heuristic still applies.
   */
  const BOILERPLATE_FORM = ASHBY_FORM.replace("\nName", "\nAutofill completed!\nPlease review the information we filled in for you below.\nName")
    .replace("\nSubmit Application", "\nEqual Opportunity Employer\nPlease review the statement below and confirm.\nI Acknowledge/Accept this Statement\nSubmit Application");
  const boilerplate: Case = { site: "ashby", outcome: "unknown", text: BOILERPLATE_FORM, kind: "intact-form-evidence" };

  it("reopens an intact Ashby capture with review boilerplate when its network record shows no submit request", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-never-taken-");
    const run = await failedWith(database, dataDir, { ...boilerplate, ashbyNetwork: ashbyNetwork([]) });
    expect(unsubmittedEvidence(database, dataDir, run)).toEqual({ kind: "intact-form-evidence", text: expect.stringMatching(/^its post-submit evidence shows /) });
    // The fresh receipt-check gate still applies.
    expect(reopenUnsubmittedBlocker(database, dataDir, run)).toContain("completed receipt check");
    receiptCheck(database, run);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lines).toContain("Reopened 1; skipped 0.");
    expect(current(database, run).status).toBe("cancelled");
    expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
    expect(storedActiveHolds(database, run.jobId)).toEqual([]);
    database.close();
  });

  it.each<[string, Partial<Case>, "absent" | "confirmed", RegExp | string]>([
    ["no network record", {}, "absent", /shows failure or correction text/],
    ["a network record with a submit Ashby refused with field errors",
      { ashbyNetwork: ashbyNetwork([{ resultType: "FormRender", fieldErrors: [{ fieldEntryId: "q1", message: "Required" }] }]) }, "absent", /shows failure or correction text/],
    ["a network record with an unanswered submit request", { ashbyNetwork: ashbyNetwork([{ status: null }]) }, "absent", /does not show that Ashby refused it/],
    ["a confirmed receipt", { ashbyNetwork: ashbyNetwork([]) }, "confirmed", "a trusted application receipt was found, so it stays as it is."]
  ])("still refuses review boilerplate with %s", async (_name, extra, receipt, reason) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-never-taken-");
    const run = await failedWith(database, dataDir, { ...boilerplate, ...extra });
    receiptCheck(database, run, receipt);
    const blocker = reopenUnsubmittedBlocker(database, dataDir, run);
    if (typeof reason === "string") expect(blocker).toBe(reason);
    else expect(blocker).toMatch(reason);
    const before = snapshot(database);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
    expect(lines.at(-1)).toBe("Reopened 0; skipped 1.");
    expect(snapshot(database)).toEqual(before);
    expect(current(database, run).status).toBe("failed");
    database.close();
  });
});

describe("pnpm pipeline:retry --correct-submitted", () => {
  const REASON = "The closed-dialog relabel was not a confirmation.";
  const RELABEL = "Submitted with confirmation: Modal dialog closed after submit without errors";
  const RELABEL_EVENT = "Submitted on Dover/Ashby: modal dialog closed after submit without errors.";

  /** A SUBMITTED record that rests only on the closed-dialog relabel (the 2026-11-21 shape), with or without saved evidence. */
  async function relabelledSubmitted(database: DatabaseSync, dataDir: string, options: { evidence?: boolean; text?: string } = {}): Promise<BrowserRun> {
    const failed = failedSubmit(database, { company: "Fixture Robotics", applicationUrl: ASHBY_RUN_URL, atsKind: "ashby" });
    if (options.evidence !== false) {
      await capture(database, dataDir, failed, { outcome: "unknown", url: ASHBY_RUN_URL, bodyText: options.text ?? ASHBY_FORM, now: new Date(Date.now() - 30_000) });
    }
    const run = updateBrowserRun(database, failed.id, { status: "submitted", confirmationText: RELABEL });
    logApplicationEvent(database, { jobId: run.jobId, fromStatus: "APPLYING", toStatus: "SUBMITTED", detail: RELABEL_EVENT });
    database.prepare("UPDATE jobs SET status = 'SUBMITTED' WHERE id = ?").run(run.jobId);
    return run;
  }

  it("refuses to run without --confirm and writes nothing", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-correct-");
    const run = await relabelledSubmitted(database, dataDir);
    const before = snapshot(database);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id.slice(0, 8), "--correct-submitted", "--reason", REASON], deps)).toBe(1);
    expect(lines).toEqual(["Not run: --correct-submitted changes a SUBMITTED record; add --confirm once the candidate has agreed, or --dry-run to check it."]);
    expect(lock.taken).toBe(0);
    expect(() => correctSubmittedRun(database, dataDir, run.id, { reason: REASON, confirm: false })).toThrow(AutomaticRetryRefused);
    expect(snapshot(database)).toEqual(before);
    expect(current(database, run)).toMatchObject({ status: "submitted", confirmationText: RELABEL });
    database.close();
  });

  it("--dry-run names what it would correct, writes nothing, and takes no lock", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-correct-");
    const run = await relabelledSubmitted(database, dataDir);
    expect(correctSubmittedBlocker(database, dataDir, run)).toBeNull();
    const text = unsubmittedEvidence(database, dataDir, run)!.text;
    const ref = run.id.slice(0, 8);
    const before = snapshot(database);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
    expect(await runRetryCommand(["--run", ref, "--correct-submitted", "--reason", REASON, "--dry-run"], deps)).toBe(0);
    expect(lines).toEqual([`would correct ${ref} Fixture Robotics — Software Engineering Intern (submitted) (${text})`, "Dry run: would correct 1; skipped 0; nothing written."]);
    expect(lock.taken).toBe(0);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("--confirm corrects the record, keeps history, holds it as a possible submission, and the normal reopen follows", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-correct-");
    const run = await relabelledSubmitted(database, dataDir);
    const text = unsubmittedEvidence(database, dataDir, run)!.text;
    const ref = run.id.slice(0, 8);
    const eventsBefore = listApplicationEvents(database, run.jobId);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", ref, "--correct-submitted", "--reason", REASON, "--confirm"], deps)).toBe(0);
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(lines).toEqual([
      `corrected ${ref} Fixture Robotics — Software Engineering Intern (submitted): no longer submitted (${text}); the application is applying again with the run failed and held as a possible submission. Check its receipt with pnpm mail:scan --receipt ${ref} before any reopen.`,
      "Corrected 1; skipped 0."
    ]);
    const corrected = current(database, run);
    expect(corrected).toMatchObject({ status: "failed", confirmationText: null, submissionApprovedAt: run.submissionApprovedAt });
    expect(statusOf(database, run.jobId)).toBe("APPLYING");
    const eventsAfter = listApplicationEvents(database, run.jobId);
    expect(eventsAfter).toHaveLength(eventsBefore.length + 1);
    expect(eventsAfter.filter((event) => event.detail === RELABEL_EVENT)).toHaveLength(1);
    const correction = eventsAfter.at(-1)!;
    expect(correction).toMatchObject({ fromStatus: "SUBMITTED", toStatus: "APPLYING" });
    expect(correction.detail).toBe(`Submitted record corrected: not submitted (${text}); it was recorded as submitted only from "${RELABEL}": ${REASON}`);
    expect(activeHolds(database, dataDir, run.jobId)).toEqual([expect.objectContaining({ runId: run.id, owner: "manager", reason: "possible-submission" })]);

    expect(reopenUnsubmittedBlocker(database, dataDir, corrected)).toContain("completed receipt check");
    receiptCheck(database, corrected);
    expect(reopenUnsubmittedBlocker(database, dataDir, corrected)).toBeNull();
    expect(reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON }).run.status).toBe("cancelled");
    expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
    expect(storedActiveHolds(database, run.jobId)).toEqual([]);
    expect(holdTrace(database, run.jobId).slice(-2)).toEqual(["reopened-unsubmitted", "resolved"]);
    database.close();
  });

  const REFUSED: Array<[string, (database: DatabaseSync, dataDir: string) => Promise<BrowserRun>, RegExp]> = [
    ["a record with no saved evidence", (database, dataDir) => relabelledSubmitted(database, dataDir, { evidence: false }),
      /^there is no evidence the site did not take it \(no security-code email after the submit click and no post-submit evidence saved after it\)\.$/],
    ["a record whose evidence shows success text", (database, dataDir) => relabelledSubmitted(database, dataDir, { text: `Thank you for applying\n${ASHBY_FORM}` }),
      /no evidence the site did not take it .*confirmation text/],
    ["another confirmation text", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      return updateBrowserRun(database, run.id, { confirmationText: "Application submitted (application dialog closed)" });
    }, /not the closed-dialog relabel/],
    ["a second SUBMITTED event", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      logApplicationEvent(database, { jobId: run.jobId, fromStatus: "APPLYING", toStatus: "SUBMITTED", detail: "Checked off as submitted by you." });
      return run;
    }, /does not rest only on the closed-dialog relabel/],
    ["a confirmed receipt", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      receiptCheck(database, run, "confirmed");
      return run;
    }, /^a trusted application receipt was found, so it stays as it is\.$/],
    ["a recorded employer outcome", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      saveOutcomeEvent(database, run.jobId, "RESPONSE", null);
      return run;
    }, /employer outcome/],
    ["an email after the submit", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      logApplicationEvent(database, { jobId: run.jobId, fromStatus: "SUBMITTED", toStatus: "SUBMITTED", detail: "Email received: Recruiter reply from example.test: \"Your application\"" });
      return run;
    }, /email about it arrived/],
    ["an application moved on to interview", async (database, dataDir) => {
      const run = await relabelledSubmitted(database, dataDir);
      database.prepare("UPDATE jobs SET status = 'INTERVIEW' WHERE id = ?").run(run.jobId);
      return run;
    }, /^its application is interview, not submitted\.$/],
    ["a failed run", async (database) => failedSubmit(database, { company: "Fixture Robotics", applicationUrl: ASHBY_RUN_URL, atsKind: "ashby" }),
      /^it is failed; --correct-submitted corrects only a submitted record\.$/]
  ];

  it.each(REFUSED)("refuses %s, even with --confirm, and writes nothing", async (_name, setup, reason) => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-correct-");
    const run = current(database, await setup(database, dataDir));
    expect(correctSubmittedBlocker(database, dataDir, run)).toMatch(reason);
    const before = snapshot(database);
    expect(() => correctSubmittedRun(database, dataDir, run.id, { reason: REASON, confirm: true })).toThrow(AutomaticRetryRefused);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(["--run", run.id, "--correct-submitted", "--reason", REASON, "--confirm"], deps)).toBe(0);
    expect(lines[0]).toMatch(/^skipped /);
    expect(lines.at(-1)).toBe("Corrected 0; skipped 1.");
    expect(snapshot(database)).toEqual(before);
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
    receiptCheck(database, failed);
    reopenUnsubmittedRun(database, dataDir, failed.id, { reason: "Greenhouse security code step handled." });
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);
    const second = await autoPass(database, dataDir, async () => fakePage());
    expect(second.held).toEqual([]);
    expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    expect(automaticSubmissionsSince(database, startOfToday())).toBe(1);
    database.close();
  });

  /**
   * `--close-unsubmitted`: the auto-submit found no submit control on a
   * posting that had closed (the Greenhouse board root says so), so the click
   * never happened. The run is cancelled, the job skipped as "Posting closed",
   * and no pass starts it again. Never retried.
   */
  describe("pnpm pipeline:retry --close-unsubmitted", () => {
    const REASON = "posting closed; the submit was never clicked";
    const NEVER_CLICKED = "Automatic submission failed: No submit control was found.";
    const CLOSED_TEXT = "The job you are looking for is no longer open.\nCurrent openings at Example";
    const feedback = (database: DatabaseSync, jobId: string) =>
      database.prepare("SELECT reason FROM discovery_feedback WHERE job_id = ?").all(jobId) as Array<{ reason: string }>;

    it("closes a never-clicked auto-submit on a closed posting (real path), and no pass starts it again", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-close-");
      const jobId = qualifiedForAutoSubmit(database);
      const closedPage: BrowserPage = {
        ...fakePage(),
        url: () => "https://boards.greenhouse.io/example",
        bodyText: async () => CLOSED_TEXT,
        clickSubmit: async () => { throw new Error("No submit control was found."); }
      };
      // The walk sees the open form; the approved submit opens the page after the posting closed.
      const first = await autoPass(database, dataDir, async () => (listBrowserRuns(database, jobId)[0]?.submissionApprovedAt ? closedPage : fakePage()));
      expect(first.submitted).toEqual([]);
      const failed = listBrowserRuns(database, jobId)[0]!;
      expect(failed.status).toBe("failed");
      const events = details(database, jobId);
      expect(events.filter((detail) => detail.startsWith("Automatic submission failed: ")).at(-1)).toBe(NEVER_CLICKED);
      expect(readSubmitEvidence(dataDir, failed).map(({ outcome }) => outcome)).toEqual(["unknown"]);
      expect(activeHolds(database, dataDir, jobId)).toEqual([expect.objectContaining({ runId: failed.id, reason: "possible-submission" })]);
      expect(closeUnsubmittedBlocker(database, dataDir, failed)).toBeNull();
      // A reopen is still refused: a closed Greenhouse page is not evidence the click was refused.
      expect(reopenUnsubmittedBlocker(database, dataDir, failed)).toMatch(/only on an Ashby or Dover application page/);

      const ref = failed.id.slice(0, 8);
      const before = snapshot(database);
      const dry = commandDeps(database, { dataDir: () => dataDir, acquireLock: () => { throw new Error("a dry run must not take the lock"); } });
      expect(await runRetryCommand(["--run", ref, "--close-unsubmitted", "--reason", REASON, "--dry-run"], dry.deps)).toBe(0);
      expect(dry.lines).toEqual([
        expect.stringMatching(new RegExp(
          `^would close ${ref} Northstar Systems .*\\(failed\\) \\(the submit was never clicked: no submit control was found, and its post-submit evidence shows the posting closed\\)$`)),
        "Dry run: would close 1; skipped 0; nothing written."
      ]);
      expect(dry.lock.taken).toBe(0);
      expect(snapshot(database)).toEqual(before);

      const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
      expect(await runRetryCommand(["--run", ref, "--close-unsubmitted", "--reason", REASON], deps)).toBe(0);
      expect(lock).toEqual({ taken: 1, released: 1, held: false });
      expect(lines).toEqual([
        expect.stringMatching(new RegExp(`^closed ${ref} Northstar Systems .*: cancelled as never submitted \\(the submit was never clicked: .*\\); the application is skipped as "Posting closed" and will not be retried\\.$`)),
        "Closed 1; skipped 0."
      ]);
      expect(listBrowserRuns(database, jobId).map((run) => run.status)).toEqual(["cancelled"]);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      expect(feedback(database, jobId)).toEqual([{ reason: "Posting closed" }]);
      const last = details(database, jobId).at(-1)!;
      expect(last.startsWith("Closed as never submitted (")).toBe(true);
      expect(last.endsWith(`: ${REASON}`)).toBe(true);
      expect(activeHolds(database, dataDir, jobId)).toEqual([]);
      const next = await pass(database, dataDir, async () => fakePage());
      expect(next.started).toEqual([]);
      expect(listBrowserRuns(database, jobId)).toHaveLength(1);
      database.close();
    });

    /** A synthetic never-clicked Greenhouse auto-submit on a closed posting, varied by `variant`. */
    async function neverClicked(database: DatabaseSync, dataDir: string, variant: {
      event?: string; text?: string; outcome?: "unknown" | "challenged"; receipt?: "ambiguous" | "confirmed"; jobStatus?: string;
    } = {}): Promise<BrowserRun> {
      const run = failedSubmit(database, { company: "Fixture Labs", applicationUrl: GREENHOUSE_RUN_URL });
      logApplicationEvent(database, { jobId: run.jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: variant.event ?? NEVER_CLICKED });
      await capture(database, dataDir, run, {
        outcome: variant.outcome ?? "unknown", url: "https://job-boards.greenhouse.io/fixture-labs", bodyText: variant.text ?? CLOSED_TEXT,
        challenge: variant.outcome === "challenged" ? "a reCAPTCHA challenge" : null
      });
      if (variant.receipt) receiptCheck(database, run, variant.receipt);
      if (variant.jobStatus) database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(variant.jobStatus, run.jobId);
      return current(database, run);
    }

    it.each([
      ["a capture of an open posting", { text: "Software Engineering Intern\nApply for this job\nSubmit application" }, /does not show the posting closed/],
      ["a submit that was clicked", { event: "Automatic submission failed: The submit button was clicked but no new confirmation appeared." }, /no record that its submit was never clicked/],
      ["a challenged capture", { outcome: "challenged" as const }, /may have been clicked/],
      ["an ambiguous receipt check", { receipt: "ambiguous" as const }, /^its receipt check is ambiguous; check the application on the site\.$/],
      ["a confirmed receipt", { receipt: "confirmed" as const }, /^a trusted application receipt was found, so it stays as it is\.$/],
      ["an application no longer applying", { jobStatus: "READY_FOR_REVIEW" }, /not applying/]
    ])("refuses %s and writes nothing", async (_name, variant, reason) => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-close-");
      const baseline = await neverClicked(database, dataDir);
      expect(closeUnsubmittedBlocker(database, dataDir, baseline)).toBeNull();
      database.close();

      const refused = disposableDatabase();
      const refusedData = disposableDirectory("internship-agent-close-");
      const run = await neverClicked(refused, refusedData, variant);
      expect(closeUnsubmittedBlocker(refused, refusedData, run)).toMatch(reason);
      const before = snapshot(refused);
      expect(() => closeUnsubmittedRun(refused, refusedData, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);
      const { deps, lines } = commandDeps(refused, { dataDir: () => refusedData });
      expect(await runRetryCommand(["--run", run.id, "--close-unsubmitted", "--reason", REASON], deps)).toBe(0);
      expect(lines.at(-1)).toBe("Closed 0; skipped 1.");
      expect(snapshot(refused)).toEqual(before);
      expect(feedback(refused, run.jobId)).toEqual([]);
      refused.close();
    });
  });

  /**
   * `--reopen-unsubmitted` on a run held on Greenhouse's emailed security code
   * (the Artefact case, Track 24): the policy approved it and clicked submit,
   * Greenhouse asked for the emailed code, the code was not found in time, and
   * the run went back to paused-needs-input with the approval withdrawn and the
   * `site-security-code` safeguard its only open pause. Greenhouse completes
   * nothing until the code is entered, so that shape is the proof: no receipt
   * check is needed. The approval time comes from the timeline's approval event.
   */
  describe("pnpm pipeline:retry --reopen-unsubmitted on a run held on Greenhouse's security code", () => {
    const REASON = "Greenhouse security codes are read since Track 19.";
    const HOLD_TEXT = "it is held on Greenhouse's emailed security code, which was never entered, and its post-submit evidence shows that step";
    const emptyMailbox: VerificationMailboxFactory = async () => ({ messagesSince: async () => [], close: async () => undefined });

    /** The real auto-submit path to the hold, plus an answered single-use pause as on the real run (so a plain retry refuses). */
    async function securityCodeHeld(database: DatabaseSync, dataDir: string): Promise<{ jobId: string; run: BrowserRun }> {
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
      const first = await autoPass(database, dataDir, async () => codeStep, { securityCodeMailbox: emptyMailbox });
      expect(first.submitted).toEqual([]);
      expect(flag.clicked).toBe(true);
      const held = listBrowserRuns(database, jobId)[0]!;
      const run = updateBrowserRun(database, held.id, { pauses: [answeredPause(), ...held.pauses] });
      expect(run).toMatchObject({ status: "paused-needs-input", submissionApprovedAt: null, confirmationText: null });
      expect(run.pauses.filter((pause) => pause.status === "open"))
        .toEqual([expect.objectContaining({ fieldId: "site-security-code", safeguard: true })]);
      expect(readSubmitEvidence(dataDir, run).map(({ outcome }) => outcome)).toEqual(["verification-code"]);
      expect(details(database, jobId).filter((detail) => detail.startsWith(AUTO_SUBMIT_EVENT))).toHaveLength(1);
      return { jobId, run };
    }

    const approvalAt = (database: DatabaseSync, jobId: string) =>
      listApplicationEvents(database, jobId).find((event) => (event.detail ?? "").startsWith(AUTO_SUBMIT_EVENT))!.createdAt;

    it("reopens it with no receipt check, and the next pass submits a fresh run under the same policy", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-code-hold-");
      const { jobId, run } = await securityCodeHeld(database, dataDir);
      expect(automaticRetryBlocker(database, run)).toMatch(/already answered one of its questions/);
      expect(readApplicationReceiptCheck(database, run.id)).toBeNull();
      expect(reopenUnsubmittedBlocker(database, dataDir, run)).toBeNull();
      expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);

      const before = snapshot(database);
      const dry = commandDeps(database, { dataDir: () => dataDir });
      expect(await runRetryCommand(["--run", run.id.slice(0, 8), "--reopen-unsubmitted", "--reason", REASON, "--dry-run"], dry.deps)).toBe(0);
      expect(dry.lines[0]).toMatch(new RegExp(`^would reopen ${run.id.slice(0, 8)} `));
      expect(dry.lines[0]!.endsWith(`(paused-needs-input) (${HOLD_TEXT})`)).toBe(true);
      expect(dry.lines.at(-1)).toBe("Dry run: would reopen 1; skipped 0; nothing written.");
      expect(dry.lock.taken).toBe(0);
      expect(snapshot(database)).toEqual(before);

      const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir });
      expect(await runRetryCommand(["--run", run.id.slice(0, 8), "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
      expect(lines[0]!.endsWith(`: cancelled as not submitted (${HOLD_TEXT}); the application is back to ready for review.`)).toBe(true);
      expect(lines.at(-1)).toBe("Reopened 1; skipped 0.");
      expect(lock).toMatchObject({ taken: 1, released: 1, held: false });
      expect(current(database, run).status).toBe("cancelled");
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      expect(details(database, jobId).at(-1)).toBe(`${REOPENED}${HOLD_TEXT}): ${REASON}`);
      expect(readApplicationReceiptCheck(database, run.id)).toBeNull();
      expect(automaticSubmissionsSince(database, startOfToday())).toBe(0);

      const second = await autoPass(database, dataDir, async () => fakePage());
      expect(second.held).toEqual([]);
      expect(second.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
      const fresh = listBrowserRuns(database, jobId).find((entry) => entry.id !== run.id)!;
      expect(fresh.status).toBe("submitted");
      expect(fresh.pauses.some((pause) => pause.status === "answered")).toBe(false);
      expect(activeHolds(database, dataDir, jobId)).toEqual([]);
      database.close();
    });

    it.each([
      ["another open pause", /^it has open pauses besides Greenhouse's emailed security code, so it stays as it is\.$/],
      ["a CAPTCHA safeguard instead of the code pause",
        /^it is paused-needs-input; --reopen-unsubmitted reopens only a failed submit or a run held on Greenhouse's emailed security code\.$/],
      ["newer evidence that is not verification-code", /^its post-submit evidence of \S+ records unknown, not Greenhouse's security-code step\.$/],
      ["no evidence", /^no post-submit evidence was saved after its approval of \S+, so nothing shows Greenhouse's security-code step\.$/],
      ["newer code-step evidence on another site", /^its post-submit evidence is not on a Greenhouse board, so it stays as it is\.$/],
      ["a confirmed receipt", /^a trusted application receipt was found, so it stays as it is\.$/],
      ["a capture taken before the approval event", /^no post-submit evidence was saved after its approval of \S+, so nothing shows Greenhouse's security-code step\.$/],
      ["an approval that was not withdrawn", /^its submit approval was not withdrawn, so it may have reached the site\.$/],
      ["no approval on the timeline", /^no submit approval is logged for it, so nothing shows its submit was clicked\.$/]
    ] as const)("refuses a security-code hold with %s", async (variant, refusal) => {
      const database = disposableDatabase();
      const dataDir = disposableDirectory("internship-agent-code-hold-");
      const { jobId, run } = await securityCodeHeld(database, dataDir);
      const later = new Date(Date.now() + 60_000);
      if (variant === "another open pause") {
        updateBrowserRun(database, run.id, { pauses: [...run.pauses, {
          fieldId: "q7", label: "Portfolio URL?", question: "Portfolio URL?", suggestedKey: null, suggestedScope: null, safeguard: false,
          sensitive: false, upload: false, status: "open", answer: null, draft: null
        }] });
      } else if (variant === "a CAPTCHA safeguard instead of the code pause") {
        updateBrowserRun(database, run.id, { pauses: run.pauses.map((pause) => pause.fieldId === "site-security-code"
          ? { ...pause, fieldId: "captcha-1", label: "CAPTCHA", question: "The page shows a CAPTCHA; complete it on the site." }
          : pause) });
      } else if (variant === "newer evidence that is not verification-code") {
        await capture(database, dataDir, run, { outcome: "unknown", url: "https://boards.greenhouse.io/example/jobs/2", bodyText: "Please fix the errors below.", now: later });
      } else if (variant === "no evidence") {
        rmSync(readSubmitEvidence(dataDir, run)[0]!.dir, { recursive: true, force: true });
      } else if (variant === "newer code-step evidence on another site") {
        await capture(database, dataDir, run, { outcome: "verification-code", url: ASHBY_RUN_URL, bodyText: "We emailed you a code.", now: later });
      } else if (variant === "a confirmed receipt") {
        recordApplicationReceipt(database, { jobId, runId: run.id }, "confirmed", "a".repeat(32), approvalAt(database, jobId), new Date().toISOString());
      } else if (variant === "a capture taken before the approval event") {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(later);
          logApplicationEvent(database, { jobId, fromStatus: "APPLYING", toStatus: "APPLYING", detail: `${AUTO_SUBMIT_EVENT}: a later approval.` });
        } finally { vi.useRealTimers(); }
      } else if (variant === "an approval that was not withdrawn") {
        updateBrowserRun(database, run.id, { submissionApprovedAt: new Date().toISOString() });
      } else {
        database.prepare("DELETE FROM application_events WHERE job_id = ? AND detail LIKE ?").run(jobId, `${AUTO_SUBMIT_EVENT}%`);
      }
      const held = current(database, run);
      expect(reopenUnsubmittedBlocker(database, dataDir, held)).toMatch(refusal);
      const before = snapshot(database);
      expect(() => reopenUnsubmittedRun(database, dataDir, run.id, { reason: REASON })).toThrow(AutomaticRetryRefused);
      const { deps, lines } = commandDeps(database, { dataDir: () => dataDir });
      expect(await runRetryCommand(["--run", run.id, "--reopen-unsubmitted", "--reason", REASON], deps)).toBe(0);
      expect(lines[0]).toMatch(/^skipped /);
      expect(lines.at(-1)).toBe("Reopened 0; skipped 1.");
      expect(snapshot(database)).toEqual(before);
      expect(statusOf(database, jobId)).toBe("APPLYING");
      database.close();
    });
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

describe("pnpm pipeline:retry --reopen-unsubmitted --candidate-verdict not-submitted (Track 66)", () => {
  const submitWait = { timeoutMs: 50, pollMs: 5 };
  // The candidate's decision (2026-11-27) on the possible submissions held with no receipt: "1. retry."
  const VERDICT = 'Candidate 2026-11-27: "1. retry." (treat the possible submissions as not submitted and retry)';
  const VERDICT_ARGS = (ref: string) => ["--run", ref, "--reopen-unsubmitted", "--candidate-verdict", "not-submitted", "--reason", VERDICT];
  const VERDICT_EVENT = `Reopened on the candidate's verdict that it was not submitted: ${VERDICT}`;

  /** A page whose submit click never confirms and shows nothing recognizable. */
  function unconfirmedPage(): BrowserPage {
    return { ...fakePage(), bodyText: async () => "Please fix the errors below.", invalidFields: async () => [], submitControlShown: async () => true };
  }

  /** An automatic run whose approved submit failed unconfirmed, held by the hold refresh as a possible submission. */
  async function possibleSubmission(database: DatabaseSync, dataDir: string): Promise<{ jobId: string; run: BrowserRun }> {
    const { jobId, run } = await heldAutomaticRun(database, dataDir, null);
    approveRunSubmission(run.id, undefined, { database });
    await expect(submitBrowserRun(run.id, { database, dataDir, submitWait, openPage: async () => unconfirmedPage(), applicationRecord: null }))
      .rejects.toBeInstanceOf(SubmissionUnconfirmed);
    const failed = listBrowserRuns(database, jobId)[0]!;
    expect(failed.status).toBe("failed");
    refreshApplicationHolds(database, dataDir);
    expect(storedActiveHolds(database, jobId)).toEqual([{ runId: failed.id, reason: "possible-submission" }]);
    return { jobId, run: failed };
  }

  type FakeMessage = Omit<MailHeader, "uid" | "messageId" | "bulk"> & { body: string };

  /** An in-memory read-only mailbox (no IMAP, no Gmail); `fail` makes every connection fail. */
  function fakeMailbox(messages: FakeMessage[], options: { fail?: boolean } = {}): { connect: MailSessionFactory; connects: () => number } {
    let connects = 0;
    const stored = messages.map(({ body, ...header }, index) => ({
      header: { ...header, uid: index + 1, messageId: `<receipt-${index + 1}@example.test>`, bulk: false } satisfies MailHeader, body
    }));
    const connect: MailSessionFactory = async () => {
      connects += 1;
      if (options.fail) throw new Error("the mailbox is unreachable");
      let close: () => void = () => {};
      const closed = new Promise<void>((resolve) => { close = resolve; });
      const session: MailSession = {
        uidValidity: "1",
        uidNext: stored.length + 1,
        uidsAfter: async (after, filter) => stored
          .filter(({ header }) => header.uid > after && (!filter?.since || header.receivedAt.getTime() >= filter.since.getTime()))
          .map(({ header }) => header.uid),
        headers: async (uids) => stored.filter(({ header }) => uids.includes(header.uid)).map(({ header }) => header),
        bodyText: async (uid, maxBytes) => (stored.find(({ header }) => header.uid === uid)?.body ?? "").slice(0, maxBytes),
        onNewMail: () => {},
        closed,
        close: async () => { close(); }
      };
      return session;
    };
    return { connect, connects: () => connects };
  }

  /** A trusted Greenhouse receipt for the seeded Northstar Systems posting, sent after the run's submit approval. */
  function northstarReceipt(database: DatabaseSync, run: BrowserRun): FakeMessage {
    const { title } = database.prepare("SELECT title FROM jobs WHERE id = ?").get(run.jobId) as { title: string };
    return {
      fromAddress: "no-reply@us.greenhouse-mail.io", fromName: "Northstar Systems", subject: "Northstar Systems — Application received",
      receivedAt: new Date(Date.parse(run.submissionApprovedAt!) + 1_000), body: `We have received your application for ${title}.`
    };
  }

  const receiptRows = (database: DatabaseSync) => database.prepare("SELECT COUNT(*) AS count FROM application_receipt_checks").get();
  const holdRows = (database: DatabaseSync) => database.prepare("SELECT * FROM application_holds ORDER BY hold_key").all();
  const verdictEvents = (database: DatabaseSync, jobId: string) =>
    details(database, jobId).filter((detail) => detail.startsWith("Reopened on the candidate's verdict"));

  it("with no receipt at check time, reopens the run, logs the candidate's verdict, and the next pass starts a fresh run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([]);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    const started = Date.now();

    expect(await runRetryCommand(VERDICT_ARGS(ref), deps)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^reopened ${ref} Northstar Systems .* on the candidate's verdict that it was not submitted \\(fresh receipt check: absent\\): cancelled; its possible-submission hold is released and the application is back to ready for review\\.$`));
    expect(lines).toContain("Reopened 1; skipped 0.");
    expect(lock).toEqual({ taken: 1, released: 1, held: false });
    expect(box.connects()).toBe(1);
    const check = readApplicationReceiptCheck(database, run.id)!;
    expect(check.result).toBe("absent");
    expect(Date.parse(check.checkedAt)).toBeGreaterThanOrEqual(started - 1_000);
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, jobId).at(-1)).toBe(VERDICT_EVENT);
    expect(holdTrace(database, jobId).filter((event) => ["receipt-check", "reopened-unsubmitted", "resolved"].includes(event)))
      .toEqual(["receipt-check", "reopened-unsubmitted", "resolved"]);
    expect(storedActiveHolds(database, jobId)).toEqual([]);
    expect(refreshApplicationHolds(database, dataDir).filter((hold) => hold.jobId === jobId)).toEqual([]);

    const next = await pass(database, dataDir, async () => fakePage());
    expect(next.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    database.close();
  });

  it("with a trusted receipt at check time, records it and does not reopen", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([northstarReceipt(database, run)]);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });

    expect(await runRetryCommand(VERDICT_ARGS(ref), deps)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^receipt found for ${ref} Northstar Systems .*: a trusted receipt matches this attempt, so it went through; the receipt is recorded, its possible-submission hold is resolved, and it is not reopened\\.$`));
    expect(lines.slice(-2)).toEqual(["Reopened 0; skipped 1.", "Receipts found for 1 run(s): recorded as received, not reopened."]);
    expect(applicationReceiptConfirmed(database, run.id)).toBe(true);
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["failed"]);
    expect(statusOf(database, jobId)).toBe("APPLYING");
    expect(verdictEvents(database, jobId)).toEqual([]);
    expect(storedActiveHolds(database, jobId)).toEqual([]);
    expect((await pass(database, dataDir, neverOpen)).started).toEqual([]);
    database.close();
  });

  it("is refused without --run, including with --held", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    await possibleSubmission(database, dataDir);
    const box = fakeMailbox([]);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    const before = snapshot(database);
    for (const argv of [
      ["--held", "--reopen-unsubmitted", "--candidate-verdict", "not-submitted", "--reason", VERDICT],
      ["--reopen-unsubmitted", "--candidate-verdict", "not-submitted", "--reason", VERDICT]
    ]) expect(await runRetryCommand(argv, deps)).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("Usage: pnpm pipeline:retry") && line.includes("--candidate-verdict not-submitted"))).toBe(true);
    expect(box.connects()).toBe(0);
    expect(lock.taken).toBe(0);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("is refused without the candidate's words as --reason, without --reopen-unsubmitted, or with another verdict", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([]);
    const { deps, lines, lock } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    const before = snapshot(database);
    for (const argv of [
      ["--run", ref, "--reopen-unsubmitted", "--candidate-verdict", "not-submitted"],
      ["--run", ref, "--reopen-unsubmitted", "--candidate-verdict", "not-submitted", "--reason", "   "],
      ["--run", ref, "--candidate-verdict", "not-submitted", "--reason", VERDICT],
      ["--run", ref, "--reopen-unsubmitted", "--candidate-verdict", "submitted", "--reason", VERDICT],
      ["--run", ref, "--reopen-unsubmitted", "--candidate-verdict", "--reason", VERDICT]
    ]) expect(await runRetryCommand(argv, deps)).toBe(2);
    expect(lines).toHaveLength(5);
    expect(lines.every((line) => line.startsWith("Usage: pnpm pipeline:retry") && line.includes("--candidate-verdict not-submitted"))).toBe(true);
    expect(box.connects()).toBe(0);
    expect(lock.taken).toBe(0);
    expect(snapshot(database)).toEqual(before);

    // Without the read-only mailbox the fresh receipt check cannot run, so nothing starts.
    const bare = commandDeps(database, { dataDir: () => dataDir });
    expect(await runRetryCommand(VERDICT_ARGS(ref), bare.deps)).toBe(1);
    expect(bare.lines).toEqual(["Not run: --candidate-verdict needs the read-only mailbox for its fresh receipt check; set INTERNSHIP_AGENT_GMAIL_ADDRESS and INTERNSHIP_AGENT_GMAIL_APP_PASSWORD in the root .env first."]);
    expect(bare.lock.taken).toBe(0);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });

  it("leaves automatic passes, --held, plain --run, and evidence-less --reopen-unsubmitted skipping possible submissions; only the verdict reopens", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([]);
    const before = snapshot(database);

    expect((await pass(database, dataDir, neverOpen)).started).toEqual([]);
    const held = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(["--held"], held.deps)).toBe(0);
    expect(held.lines[0]).toBe("No held runs.");
    const plain = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(["--run", ref], plain.deps)).toBe(0);
    expect(plain.lines[0]).toMatch(new RegExp(`^skipped ${ref} .*\\(its submission was approved, so it may have reached the site\\.\\)$`));
    receiptCheck(database, run);
    const reopen = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(["--run", ref, "--reopen-unsubmitted", "--reason", "x"], reopen.deps)).toBe(0);
    expect(reopen.lines[0]).toMatch(new RegExp(`^skipped ${ref} .*\\(there is no evidence the site did not complete it `));
    expect(box.connects()).toBe(0);
    const after = snapshot(database);
    expect({ jobs: after.jobs, runs: after.runs }).toEqual({ jobs: before.jobs, runs: before.runs });
    expect(statusOf(database, jobId)).toBe("APPLYING");

    const verdict = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(VERDICT_ARGS(ref), verdict.deps)).toBe(0);
    expect(verdict.lines).toContain("Reopened 1; skipped 0.");
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  it("checks the receipt on a dry run but records and writes nothing and takes no lock", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const state = () => ({ snapshot: snapshot(database), receipts: receiptRows(database), holds: holdRows(database) });
    const before = state();
    const noLock = () => { throw new Error("a dry run must not take the lock"); };

    const empty = fakeMailbox([]);
    const first = commandDeps(database, { dataDir: () => dataDir, mailbox: empty.connect, acquireLock: noLock });
    expect(await runRetryCommand([...VERDICT_ARGS(ref), "--dry-run"], first.deps)).toBe(0);
    expect(first.lines[0]).toMatch(new RegExp(`^would reopen ${ref} Northstar Systems .* on the candidate's verdict that it was not submitted \\(fresh receipt check: absent; nothing recorded\\)\\.$`));
    expect(first.lines.at(-1)).toBe("Dry run: would reopen 1; skipped 0; nothing written.");
    expect(empty.connects()).toBe(1);
    expect(state()).toEqual(before);

    const receipt = fakeMailbox([northstarReceipt(database, run)]);
    const second = commandDeps(database, { dataDir: () => dataDir, mailbox: receipt.connect, acquireLock: noLock });
    expect(await runRetryCommand([...VERDICT_ARGS(ref), "--dry-run"], second.deps)).toBe(0);
    expect(second.lines[0]).toMatch(new RegExp(`^receipt found for ${ref} Northstar Systems .* \\(dry run, nothing recorded\\): a trusted receipt matches this attempt, so it went through and would not be reopened\\.$`));
    expect(second.lines.slice(-2)).toEqual(["Dry run: would reopen 0; skipped 1; nothing written.", "Dry run: receipts found for 1 run(s); nothing recorded."]);
    expect(receipt.connects()).toBe(1);
    expect(state()).toEqual(before);
    expect(applicationReceiptConfirmed(database, run.id)).toBe(false);
    expect(statusOf(database, jobId)).toBe("APPLYING");
    database.close();
  });

  it("keeps the run held when the fresh receipt check is unavailable", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([], { fail: true });
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(VERDICT_ARGS(ref), deps)).toBe(1);
    expect(lines[0]).toMatch(new RegExp(`^skipped ${ref} Northstar Systems .* \\(its fresh receipt check is unavailable, so it stays held as a possible submission\\.\\)$`));
    expect(box.connects()).toBe(1);
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["failed"]);
    expect(statusOf(database, jobId)).toBe("APPLYING");
    expect(verdictEvents(database, jobId)).toEqual([]);
    expect(storedActiveHolds(database, jobId)).toEqual([{ runId: run.id, reason: "possible-submission" }]);
    database.close();
  });

  it("lets the target rule out the fresh run of a posting that is now unpaid", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const { deps } = commandDeps(database, { dataDir: () => dataDir, mailbox: fakeMailbox([]).connect });
    expect(await runRetryCommand(VERDICT_ARGS(run.id.slice(0, 8)), deps)).toBe(0);
    database.prepare("UPDATE jobs SET title = ? WHERE id = ?").run("Software Engineering Intern (UNPAID)", jobId);
    const target = { season: "summer", year: 2027 } as const;
    const report = await advancePipeline({
      database, dataDir, settings: { ...on, target }, openPage: neverOpen, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
      fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider()
    });
    expect(report.started).toEqual([]);
    const skip = details(database, jobId).find((detail) => detail.startsWith("Not pursued for your target: "));
    expect(skip).toContain("Pay: the posting says the internship is unpaid.");
    expect(listBrowserRuns(database, jobId).map((entry) => entry.status)).toEqual(["cancelled"]);
    database.close();
  });

  it("still stops the fresh run at a CAPTCHA and never submits it", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const { jobId, run } = await possibleSubmission(database, dataDir);
    const { deps } = commandDeps(database, { dataDir: () => dataDir, mailbox: fakeMailbox([]).connect });
    expect(await runRetryCommand(VERDICT_ARGS(run.id.slice(0, 8)), deps)).toBe(0);
    let clicks = 0;
    const page: BrowserPage = {
      ...fakePage(),
      clickSubmit: async () => { clicks += 1; },
      visibleChallenge: async () => ({ kind: "hcaptcha" as const, detail: "an hCaptcha challenge" })
    };
    await pass(database, dataDir, async () => page);
    expect(clicks).toBe(0);
    const runs = listBrowserRuns(database, jobId);
    expect(runs.some((entry) => entry.status === "submitted" || entry.status === "submitting")).toBe(false);
    expect(statusOf(database, jobId)).not.toBe("SUBMITTED");
    const fresh = runs.find((entry) => entry.id !== run.id);
    const pausedOnSafeguard = !!fresh && fresh.pauses.some((pause) => pause.safeguard === true && pause.status === "open");
    const stoppedOnCaptcha = details(database, jobId).some((detail) => detail.startsWith("Automatic browser run ") && /captcha/i.test(detail));
    expect(pausedOnSafeguard || stoppedOnCaptcha).toBe(true);
    database.close();
  });

  it("reopens a paused run whose submit approval still stands (the EP Wealth shape) with no receipt", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const synthetic = syntheticHeldRun(database, {
      company: "Harborline Advisors", by: "pipeline", status: "paused-needs-input", applicationUrl: "https://jobs.lever.co/harborline/1/apply", atsKind: "lever",
      pauses: [{
        fieldId: "site-challenge", label: "CAPTCHA", question: "The page shows an hCaptcha challenge; complete it on the site.", suggestedKey: null,
        suggestedScope: null, safeguard: true, sensitive: false, upload: false, status: "open", answer: null, draft: null
      }]
    });
    const run = updateBrowserRun(database, synthetic.id, { submissionApprovedAt: new Date(Date.now() - 60_000).toISOString() });
    await capture(database, dataDir, run, { outcome: "unknown", url: "https://jobs.lever.co/harborline/1/apply", bodyText: "" });
    refreshApplicationHolds(database, dataDir);
    expect(storedActiveHolds(database, run.jobId)).toEqual([{ runId: run.id, reason: "possible-submission" }]);
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([]);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    expect(await runRetryCommand(VERDICT_ARGS(ref), deps)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^reopened ${ref} Harborline Advisors .* on the candidate's verdict that it was not submitted \\(fresh receipt check: absent\\)`));
    expect(lines).toContain("Reopened 1; skipped 0.");
    expect(box.connects()).toBe(1);
    expect(listBrowserRuns(database, run.jobId).map((entry) => entry.status)).toEqual(["cancelled"]);
    expect(statusOf(database, run.jobId)).toBe("READY_FOR_REVIEW");
    expect(details(database, run.jobId).at(-1)).toBe(VERDICT_EVENT);
    expect(storedActiveHolds(database, run.jobId)).toEqual([]);
    database.close();
  });

  it("skips a held run whose submit was never approved without touching the mailbox", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDirectory("internship-agent-verdict-");
    const run = syntheticHeldRun(database, { company: "Quietwater Labs", by: "pipeline", status: "paused-needs-input" });
    const ref = run.id.slice(0, 8);
    const box = fakeMailbox([]);
    const { deps, lines } = commandDeps(database, { dataDir: () => dataDir, mailbox: box.connect });
    const before = snapshot(database);
    expect(await runRetryCommand(VERDICT_ARGS(ref), deps)).toBe(0);
    expect(lines[0]).toMatch(new RegExp(`^skipped ${ref} .*\\(its submit was never approved, so it is not a possible submission; retry it without --reopen-unsubmitted\\.\\)$`));
    expect(lines).toContain("Reopened 0; skipped 1.");
    expect(box.connects()).toBe(0);
    expect(snapshot(database)).toEqual(before);
    database.close();
  });
});
