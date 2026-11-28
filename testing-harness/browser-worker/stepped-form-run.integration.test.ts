/**
 * Track 74: a several-page form on a site without an adapter, walked step by
 * step through the orchestrator (start, answer, continue, approve, submit) on
 * an in-memory page and a disposable SQLite database. Every host, answer, and
 * profile value is fictional; the steps are modelled, not captured. The
 * helpers are copied from run-lifecycle.integration.test.ts rather than
 * imported from it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import { autoSubmitBlockers, STEPPED_FORM_BLOCKER, type BrowserField } from "@internship-agent/domain";
import type { BrowserPage, RawControl, StepButtons } from "@internship-agent/browser";
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

/** An in-memory several-page page: Next moves to the next step; Submit shows a confirmation; nothing touches a browser. */
function steppedPage(steps: FakeStep[]) {
  const state = { index: 0, nextClicks: 0, submitClicks: [] as number[], submitted: false, opened: 0, filled: new Map<string, string>(), uploads: new Map<string, string>() };
  const current = () => steps[Math.min(state.index, steps.length - 1)]!;
  const page: BrowserPage & { stepButtons(): Promise<StepButtons>; clickStepNext(text: string): Promise<boolean> } = {
    url: () => FORM_URL,
    title: async () => "Robotics Software Intern - Fixture Robotics",
    collectControls: async () => current().controls,
    bodyText: async () => (state.submitted ? "Thank you for applying! Your application was received." : current().body),
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
function opener(steps: () => FakeStep[]) {
  const opened: Array<ReturnType<typeof steppedPage>> = [];
  return {
    opened,
    openPage: async () => {
      const made = steppedPage(steps());
      opened.push(made);
      return made.page;
    }
  };
}

const renderPdf = async () => ({ pages: 1 });

describe("several-page forms on sites without an adapter (Track 74)", () => {
  it("walks an automatic run to the last step and keeps it for the candidate's approval", async () => {
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
    expect(autoSubmitBlockers(started.run)).toContain(STEPPED_FORM_BLOCKER);
    expect(() => approveRunSubmissionAutomatically(started.run.id, ["fixture"], { database })).toThrow(/Not submitted automatically/);
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

  it("never lets the auto-submit policy submit a stepped run, opening and clicking nothing", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const pages = opener(() => threeSteps());
    const started = await startBrowserRun(jobId, FORM_URL, { database, dataDir, voiceDrafter: null, pauseReviewer: null, renderPdf, openPage: pages.openPage });
    confirmRunAts(started.run.id, "unknown", { database });
    approveRunSubmission(started.run.id, undefined, { database });
    await expect(submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: pages.openPage, applicationRecord: null, policyApproval: true }))
      .rejects.toThrow("The auto-submit policy does not submit several-page forms on sites the agent has no adapter for");
    expect(pages.opened).toHaveLength(1);
    expect(pages.opened[0]!.state.submitClicks).toEqual([]);
    const after = getBrowserRuns(jobId, database)[0]!;
    expect(after.submissionApprovedAt).toBeNull();
    expect(after.status).toBe("awaiting-approval");
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
