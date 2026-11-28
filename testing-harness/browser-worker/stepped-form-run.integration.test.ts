/**
 * Track 74: a several-page form on a site without an adapter, walked step by
 * step through the orchestrator (start, answer, continue, approve, submit) on
 * an in-memory page and a disposable SQLite database. Every host, answer, and
 * profile value is fictional; the steps are modelled, not captured. The
 * helpers are copied from run-lifecycle.integration.test.ts rather than
 * imported from it. Track 80: the auto-submit policy on sites whose
 * confirmation page was never captured (one-page unknown and Oracle-shaped
 * forms and stepped forms), on the same in-memory pages.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getJobPosting,
  listApplicationEvents,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveCandidateFact,
  seedDevelopmentData,
  updateBrowserRun
} from "@internship-agent/db";
import { AUTO_SUBMIT_EVENT, autoSubmitBlockers, NO_APPLICATION_CONTENT_BLOCKER, type BrowserField } from "@internship-agent/domain";
import {
  SUBMIT_TARGET_FIELD,
  SubmissionChallenged,
  SubmissionHeld,
  SubmissionUnconfirmed,
  SubmissionUnverified,
  type BrowserPage,
  type RawControl,
  type StepButtons,
  type VisibleChallenge
} from "@internship-agent/browser";
import {
  answerRunPause,
  approveApplication,
  approveRunSubmission,
  approveRunSubmissionAutomatically,
  AutomaticRunStopped,
  confirmRunAts,
  continueBrowserRun,
  evaluateAndPersistMatch,
  getBrowserRuns,
  prepareApplication,
  startBrowserRun,
  submitBrowserRun
} from "@internship-agent/agent";
import { refreshApplicationHolds } from "../../packages/agent/src/application-holds";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-stepped-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-stepped-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

function approvedJobId(database: DatabaseSync, stopAt: "approved" | "qualified" = "approved"): string {
  seedDevelopmentData(database);
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID, owner: "example", name: "evidence-demo", url: "https://github.com/example/evidence-demo",
    defaultBranch: "main", description: "Fixture evidence.", observedHeadSha: "sha-fixture"
  });
  const sha = "sha-fixture";
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id, name: "evidence-demo", summary: "Fixture project.", fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.", evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme", commitSha: sha, path: "README.md", startLine: 2, endLine: 2,
        sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L2`, excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0]!.claims[0]!;
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  database.prepare("UPDATE jobs SET application_type = 'EXTERNAL_ATS' WHERE id = ?").run(row.id);
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  if (stopAt === "qualified") {
    prepareApplication(row.id, { database });
    return row.id;
  }
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  return row.id;
}

const FORM_URL = "https://careers.fixturerobotics.example/jobs/1001/apply";
const NEXT: StepButtons = { submit: false, next: "Next" };
const LAST: StepButtons = { submit: true, next: null };
type FakeStep = { controls: RawControl[]; buttons: StepButtons; body: string };

const START_DATE: RawControl = { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true };
const BADGE: RawControl = { tag: "input", type: "text", id: "badge", label: "What name should appear on your badge?", required: true };
const RESUME: RawControl = { tag: "input", type: "file", id: "resume", label: "Resume", required: true };

/** Three modelled steps shown in place ("Step n of 3", the address never changes), like a Paylocity-shaped form. */
function threeSteps(first: RawControl[] = [START_DATE]): FakeStep[] {
  return [
    { controls: [...first, { tag: "button", label: "Next" }], buttons: NEXT, body: "Robotics Software Intern\nStep 1 of 3\nInformation" },
    { controls: [RESUME, { tag: "button", label: "Next" }], buttons: NEXT, body: "Robotics Software Intern\nStep 2 of 3\nResume" },
    { controls: [{ tag: "button", label: "Submit Application" }], buttons: LAST, body: "Robotics Software Intern\nStep 3 of 3\nReview" }
  ];
}

type FakeOptions = { url?: string; title?: string; confirms?: boolean; challenge?: VisibleChallenge | null };

/** An in-memory several-page page: Next moves to the next step; Submit shows a confirmation; nothing touches a browser. */
function steppedPage(steps: FakeStep[], options: FakeOptions = {}) {
  const state = { index: 0, nextClicks: 0, submitClicks: [] as number[], submitted: false, opened: 0, filled: new Map<string, string>(), uploads: new Map<string, string>() };
  const current = () => steps[Math.min(state.index, steps.length - 1)]!;
  const page: BrowserPage & { stepButtons(): Promise<StepButtons>; clickStepNext(text: string): Promise<boolean> } = {
    url: () => options.url ?? FORM_URL,
    title: async () => options.title ?? "Robotics Software Intern - Fixture Robotics",
    collectControls: async () => current().controls,
    bodyText: async () => (state.submitted && options.confirms !== false ? "Thank you for applying! Your application was received." : current().body),
    visibleChallenge: async () => options.challenge ?? null,
    submitControlLabel: async () => (current().buttons.submit
      ? (current().controls.find((control) => control.tag === "button" && control.label !== "Next")?.label ?? null)
      : null),
    fillField: async (field: BrowserField, value: string) => { state.filled.set(`${state.index + 1}:${field.id}`, value); },
    chooseOption: async (field: BrowserField, option: string) => { state.filled.set(`${state.index + 1}:${field.id}`, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { state.filled.set(`${state.index + 1}:${field.id}`, String(checked)); },
    uploadFile: async (field: BrowserField, path: string) => { state.uploads.set(`${state.index + 1}:${field.id}`, path); },
    clickSubmit: async () => {
      state.submitClicks.push(state.index + 1);
      state.submitted = true;
    },
    screenshot: async () => {},
    close: async () => {},
    stepButtons: async () => current().buttons,
    clickStepNext: async (text: string) => {
      if (text !== current().buttons.next) return false;
      state.nextClicks += 1;
      state.index += 1;
      return true;
    }
  };
  return { page, state };
}

/** A factory that opens a fresh copy of the steps each time, keeping each page's state. */
function opener(steps: () => FakeStep[], options: FakeOptions = {}) {
  const opened: Array<ReturnType<typeof steppedPage>> = [];
  return {
    opened,
    openPage: async () => {
      const made = steppedPage(steps(), options);
      opened.push(made);
      return made.page;
    }
  };
}

const renderPdf = async () => ({ pages: 1 });

describe("several-page forms on sites without an adapter (Track 74)", () => {
  it("walks an automatic run to the last step and keeps it at the submit step", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, "qualified");
    const pages = opener(() => threeSteps());
    const started = await startBrowserRun(jobId, FORM_URL, {
      database, dataDir: disposableDataDir(), automatic: true, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage
    });
    const { state } = pages.opened[0]!;
    expect(started.run.status).toBe("awaiting-approval");
    expect(started.run.atsConfirmed).toBe(false);
    expect(started.run.atsKind).toBe("unknown");
    expect(started.run.decisions.map((decision) => decision.fieldId)).toEqual(["step-1::q1", "step-2::resume"]);
    expect(state.filled.get("1:q1")).toBe("06/01/2027");
    expect(state.uploads.has("2:resume")).toBe(true);
    expect(state.nextClicks).toBe(2);
    expect(state.submitClicks).toEqual([]);
    expect(autoSubmitBlockers(started.run)).toEqual([]);
    expect(getBrowserRuns(jobId, database)[0]!.submissionApprovedAt).toBeNull();
    database.close();
  });

  it("pauses on a step's open question, then continues with the candidate's answer to the last step", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const pages = opener(() => threeSteps([START_DATE, BADGE]));
    const started = await startBrowserRun(jobId, FORM_URL, { database, dataDir, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage });
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses.filter((pause) => pause.status === "open").map((pause) => pause.fieldId)).toEqual(["step-1::badge"]);
    expect(pages.opened[0]!.state.nextClicks).toBe(0);
    await answerRunPause(started.run.id, "step-1::badge", "Jordan R.", false, { database });
    const continued = await continueBrowserRun(started.run.id, { database, dataDir, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage });
    const { state } = pages.opened[1]!;
    expect(continued.run.status).toBe("awaiting-approval");
    expect(state.filled.get("1:badge")).toBe("Jordan R.");
    expect(state.filled.get("1:q1")).toBe("06/01/2027");
    expect(state.nextClicks).toBe(2);
    expect(state.submitClicks).toEqual([]);
    expect(continued.run.pauses.find((pause) => pause.fieldId === "step-1::badge")?.status).toBe("answered");
    database.close();
  });

  it("submits on the last step only with the candidate's approval", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const pages = opener(() => threeSteps());
    const started = await startBrowserRun(jobId, FORM_URL, { database, dataDir, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage });
    expect(started.run.status).toBe("awaiting-approval");
    confirmRunAts(started.run.id, "unknown", { database });
    approveRunSubmission(started.run.id, undefined, { database });
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null });
    const { state } = pages.opened[1]!;
    expect(submitted.status).toBe("submitted");
    expect(submitted.confirmationText).toContain("Thank you for applying");
    expect(state.submitClicks).toEqual([3]);
    expect(state.nextClicks).toBe(2);
    expect(Object.keys(submitted.submittedAnswers ?? {})).toEqual(["step-1::q1"]);
    expect(pages.opened[0]!.state.submitClicks).toEqual([]);
    database.close();
  });

  it("stops an automatic run whose later step shows Next with no step count, saving no run", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, "qualified");
    const steps = (): FakeStep[] => {
      const [first, second] = threeSteps();
      return [first!, { ...second!, body: "Robotics Software Intern\nResume" }];
    };
    const pages = opener(steps);
    const stopped = startBrowserRun(jobId, FORM_URL, {
      database, dataDir: disposableDataDir(), automatic: true, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage
    });
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/^The application at careers\.fixturerobotics\.example continues over several pages; the agent filled it up to step 2/);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    expect(pages.opened[0]!.state.submitClicks).toEqual([]);
    expect(pages.opened[0]!.state.nextClicks).toBe(1);
    database.close();
  });
});

/** A one-page form (a single step whose last button submits), with its final button's label. */
function onePage(button: string | null = "Submit Application"): FakeStep[] {
  return [{
    controls: [START_DATE, RESUME, ...(button === null ? [] : [{ tag: "button", label: button } as RawControl])],
    buttons: LAST,
    body: "Robotics Software Intern\nApply"
  }];
}

const ORACLE_URL = "https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/1001/apply";
const QUICK = { timeoutMs: 2_000, pollMs: 10 };

describe("the auto-submit policy on sites whose confirmation page was never captured (Track 80)", () => {
  async function start(steps: () => FakeStep[], options: FakeOptions = {}, url = FORM_URL) {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const pages = opener(steps, options);
    const started = await startBrowserRun(jobId, url, { database, dataDir, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage });
    return { database, dataDir, jobId, pages, run: started.run };
  }

  /** The run is failed with the policy's approval kept, nothing marked submitted, and the hold refresh holds it as a possible submission. */
  function expectPossibleSubmission(database: DatabaseSync, dataDir: string, jobId: string, runId: string) {
    const after = getBrowserRuns(jobId, database).find((run) => run.id === runId)!;
    expect(after.status).toBe("failed");
    expect(after.submissionApprovedAt).not.toBeNull();
    expect(after.confirmationText).toBeNull();
    expect(getJobPosting(database, jobId)?.status).not.toBe("SUBMITTED");
    expect(refreshApplicationHolds(database, dataDir)).toContainEqual(expect.objectContaining({ runId, reason: "possible-submission" }));
  }

  /** The submission approvals on the job's timeline (the package approval is not one). */
  function approvalEvents(database: DatabaseSync, jobId: string): string[] {
    return listApplicationEvents(database, jobId).map((event) => event.detail ?? "").filter((detail) => /submission approved/i.test(detail));
  }

  it("submits a clean stepped run once on its last step and holds it as a possible submission", async () => {
    const { database, dataDir, jobId, pages, run } = await start(() => threeSteps());
    expect(run.status).toBe("awaiting-approval");
    expect(autoSubmitBlockers(run)).toEqual([]);
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionUnverified);
    await expect(submit).rejects.toThrow(/held as a possible submission/);
    const { state } = pages.opened[1]!;
    expect(state.submitClicks).toEqual([3]);
    expect(state.nextClicks).toBe(2);
    const after = getBrowserRuns(jobId, database)[0]!;
    expect(after.atsConfirmed).toBe(true);
    expect(after.atsKind).toBe("unknown");
    expectPossibleSubmission(database, dataDir, jobId, run.id);
    const approvals = approvalEvents(database, jobId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.startsWith(AUTO_SUBMIT_EVENT)).toBe(true);
    expect(approvals[0]).toContain("Site: not a recognized application site type");
    expect(approvals[0]).toContain("never captured");
    await expect(submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK }))
      .rejects.toThrow("Only runs awaiting approval can be submitted.");
    expect(pages.opened).toHaveLength(2);
    database.close();
  });

  it("submits a clean one-page run on an unrecognized site once and holds it as a possible submission", async () => {
    const { database, dataDir, jobId, pages, run } = await start(() => onePage());
    expect(run.status).toBe("awaiting-approval");
    expect(run.decisions.some((decision) => decision.fieldId.startsWith("step-"))).toBe(false);
    expect(run.atsConfirmed).toBe(false);
    expect(run.atsKind).toBe("unknown");
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionUnverified);
    await expect(submit).rejects.toThrow(/held as a possible submission/);
    expect(pages.opened[1]!.state.submitClicks).toEqual([1]);
    expectPossibleSubmission(database, dataDir, jobId, run.id);
    expect(approvalEvents(database, jobId)[0]).toContain("Site: not a recognized application site type");
    await expect(submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK }))
      .rejects.toThrow("Only runs awaiting approval can be submitted.");
    expect(pages.opened).toHaveLength(2);
    database.close();
  });

  it("submits a clean Oracle Cloud HCM run on its own site once and holds it as a possible submission", async () => {
    const { database, dataDir, jobId, pages, run } = await start(() => onePage(), { url: ORACLE_URL, title: "Candidate Experience" }, ORACLE_URL);
    expect(run.status).toBe("awaiting-approval");
    expect(run.atsConfirmed).toBe(false);
    expect(run.suggestedAtsKind).toBe("oracle");
    expect(autoSubmitBlockers(run)).toEqual([]);
    const approved = approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    expect(approved.atsKind).toBe("oracle");
    expect(approved.atsConfirmed).toBe(true);
    expect(approvalEvents(database, jobId)[0]).toContain("Site: Oracle Cloud HCM");
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionUnverified);
    await expect(submit).rejects.toThrow(/the Oracle Cloud HCM application/);
    expect(pages.opened[1]!.state.submitClicks).toEqual([1]);
    expectPossibleSubmission(database, dataDir, jobId, run.id);
    database.close();
  });

  it("still refuses a run with an open question, clicking nothing", async () => {
    const { database, pages, run } = await start(() => threeSteps([START_DATE, BADGE]));
    expect(run.status).toBe("paused-needs-input");
    expect(autoSubmitBlockers(run)).toContain("The form has unanswered questions waiting for you.");
    expect(() => approveRunSubmissionAutomatically(run.id, ["fixture"], { database })).toThrow(/Not submitted automatically/);
    expect(pages.opened.every((opened) => opened.state.submitClicks.length === 0)).toBe(true);
    database.close();
  });

  it("still holds a run whose page shows a CAPTCHA, clicking nothing, and says it is the only step left", async () => {
    const challenge: VisibleChallenge = { kind: "recaptcha", detail: "a reCAPTCHA checkbox" };
    const { database, dataDir, jobId, run } = await start(() => onePage());
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const challenged = opener(() => onePage(), { challenge });
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: challenged.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionChallenged);
    await expect(submit).rejects.toThrow(/only step left for you/);
    expect(challenged.opened[0]!.state.submitClicks).toEqual([]);
    const after = getBrowserRuns(jobId, database)[0]!;
    expect(after.status).toBe("paused-needs-input");
    expect(after.submissionApprovedAt).toBeNull();
    expect(after.pauses.some((pause) => pause.safeguard && pause.status === "open")).toBe(true);
    database.close();

    const shown = await start(() => onePage(), { challenge });
    expect(shown.run.pauses.some((pause) => pause.safeguard)).toBe(true);
    expect(autoSubmitBlockers(shown.run)).toContain("The site showed a safeguard challenge.");
    expect(shown.pages.opened[0]!.state.submitClicks).toEqual([]);
    shown.database.close();
  });

  it("still refuses a run with an answer drafted in the candidate's voice", async () => {
    const { database, run } = await start(() => onePage());
    const gate = { passed: true, averagePercentile: 41, targetAverage: 65, detectors: {}, revisions: 2 };
    const drafted = updateBrowserRun(database, run.id, {
      decisions: run.decisions.map((decision) => (decision.fieldId === "q1" ? { ...decision, basis: { kind: "voice_draft" as const, gate } } : decision))
    });
    expect(autoSubmitBlockers(drafted)).toContain("An answer was drafted in your voice; you review those.");
    expect(() => approveRunSubmissionAutomatically(run.id, ["fixture"], { database })).toThrow(/Not submitted automatically/);
    database.close();
  });

  it.each([
    ["Upload", "Upload"],
    ["Next", "Next"],
    ["no button", null]
  ])("holds a policy submit whose control does not read as the final submit (%s), clicking nothing", async (_name, button) => {
    const { database, dataDir, jobId, pages, run } = await start(() => onePage(button));
    expect(run.status).toBe("awaiting-approval");
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionHeld);
    await expect(submit).rejects.toThrow(/No control reading as the application's final submit/);
    expect(pages.opened[1]!.state.submitClicks).toEqual([]);
    const after = getBrowserRuns(jobId, database)[0]!;
    expect(after.status).toBe("paused-needs-input");
    expect(after.submissionApprovedAt).toBeNull();
    expect(after.pauses.find((pause) => pause.fieldId === SUBMIT_TARGET_FIELD)).toMatchObject({ safeguard: true, status: "open" });
    database.close();
  });

  it("holds a policy submit on a stepped run whose last control reads Next, clicking nothing", async () => {
    const steps = (): FakeStep[] => {
      const [first, second] = threeSteps();
      return [first!, second!, { controls: [{ tag: "button", label: "Next" }], buttons: LAST, body: "Robotics Software Intern\nStep 3 of 3\nReview" }];
    };
    const { database, dataDir, jobId, pages, run } = await start(steps);
    expect(run.status).toBe("awaiting-approval");
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const submit = submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK });
    await expect(submit).rejects.toBeInstanceOf(SubmissionHeld);
    await expect(submit).rejects.toThrow(/No control reading as the application's final submit/);
    expect(pages.opened[1]!.state.submitClicks).toEqual([]);
    const after = getBrowserRuns(jobId, database)[0]!;
    expect(after.status).toBe("paused-needs-input");
    expect(after.submissionApprovedAt).toBeNull();
    expect(after.pauses.find((pause) => pause.fieldId === SUBMIT_TARGET_FIELD)).toMatchObject({ safeguard: true, status: "open" });
    database.close();
  });

  it("holds a policy click with no confirmation as a possible submission and never submits it again", async () => {
    const { database, dataDir, jobId, pages, run } = await start(() => onePage(), { confirms: false });
    approveRunSubmissionAutomatically(run.id, ["fixture"], { database });
    const failure = await submitBrowserRun(run.id, {
      database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: { timeoutMs: 100, pollMs: 10 }
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionUnconfirmed);
    expect(failure).not.toBeInstanceOf(SubmissionUnverified);
    expect(pages.opened[1]!.state.submitClicks).toEqual([1]);
    expectPossibleSubmission(database, dataDir, jobId, run.id);
    await expect(submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK }))
      .rejects.toThrow("Only runs awaiting approval can be submitted.");
    expect(pages.opened).toHaveLength(2);
    database.close();
  });

  it("still refuses a SmartRecruiters run", async () => {
    const { database, run } = await start(() => onePage());
    const held = updateBrowserRun(database, run.id, { suggestedAtsKind: "smartrecruiters" });
    expect(autoSubmitBlockers(held)[0]).toMatch(/^SmartRecruiters application sites are recognized/);
    expect(() => approveRunSubmissionAutomatically(run.id, ["fixture"], { database })).toThrow(/Not submitted automatically/);
    database.close();
  });

  it("never auto-submits an unknown-site newsletter-only form and holds it with the reason (Track 80)", async () => {
    // Track 77 found unknown sites whose only captured "form" was an in-page newsletter email box.
    const newsletter = (): FakeStep[] => [{
      controls: [{ tag: "input", type: "email", id: "email", label: "Email address" }, { tag: "button", label: "Submit" }],
      buttons: LAST,
      body: "Get product news\nEmail address\nSubmit"
    }];
    const { database, jobId, pages, run } = await start(newsletter);
    expect(run.status).toBe("awaiting-approval");
    expect(run.atsConfirmed).toBe(false);
    expect(run.decisions.filter((decision) => decision.action !== "skip").map((decision) => ({ action: decision.action, basis: decision.basis })))
      .toEqual([{ action: "fill", basis: { kind: "profile", field: "email" } }]);
    expect(autoSubmitBlockers(run)).toEqual([NO_APPLICATION_CONTENT_BLOCKER]);
    expect(() => approveRunSubmissionAutomatically(run.id, ["fixture"], { database })).toThrow(/no application content/);
    expect(getBrowserRuns(jobId, database)[0]!.submissionApprovedAt).toBeNull();
    expect(pages.opened.every((opened) => opened.state.submitClicks.length === 0)).toBe(true);
    expect(approvalEvents(database, jobId)).toEqual([]);
    database.close();

    // A name with the email passes the content guard, but a Subscribe control is never the final submit.
    const signup = (): FakeStep[] => [{
      controls: [
        { tag: "input", type: "text", id: "name", label: "Full name" },
        { tag: "input", type: "email", id: "email", label: "Email address" },
        { tag: "button", label: "Subscribe" }
      ],
      buttons: LAST,
      body: "Get product news\nFull name\nEmail address\nSubscribe"
    }];
    const named = await start(signup);
    expect(named.run.status).toBe("awaiting-approval");
    expect(autoSubmitBlockers(named.run)).toEqual([]);
    approveRunSubmissionAutomatically(named.run.id, ["fixture"], { database: named.database });
    const submit = submitBrowserRun(named.run.id, {
      database: named.database, dataDir: named.dataDir, renderPdf, openPage: named.pages.openPage, applicationRecord: null, policyApproval: true, submitWait: QUICK
    });
    await expect(submit).rejects.toBeInstanceOf(SubmissionHeld);
    await expect(submit).rejects.toThrow(/No control reading as the application's final submit/);
    expect(named.pages.opened.every((opened) => opened.state.submitClicks.length === 0)).toBe(true);
    const after = getBrowserRuns(named.jobId, named.database)[0]!;
    expect(after.status).toBe("paused-needs-input");
    expect(after.submissionApprovedAt).toBeNull();
    named.database.close();
  });

  it("leaves the candidate's own approval unchanged: a recognized confirmation marks it submitted", async () => {
    const { database, dataDir, pages, run } = await start(() => onePage());
    confirmRunAts(run.id, "unknown", { database });
    approveRunSubmission(run.id, undefined, { database });
    const submitted = await submitBrowserRun(run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, submitWait: QUICK });
    expect(submitted.status).toBe("submitted");
    expect(submitted.confirmationText).toContain("Thank you for applying");
    expect(pages.opened[1]!.state.submitClicks).toEqual([1]);
    database.close();
  });
});
