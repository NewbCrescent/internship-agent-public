import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabase,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  listProjectEvidenceProfiles,
  getDiscoverySkip,
  getFitInputVersion,
  getJobPosting,
  getRequirementLabelHold,
  holdRequirementLabels,
  logApplicationEvent,
  persistNormalizedPosting,
  saveSemanticFit,
  saveBrowserSession,
  saveCandidate,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import { AUTO_SUBMIT_EVENT, type BrowserField } from "@internship-agent/domain";
import {
  COVERING_DIALOG_REASON,
  FieldUnfillable,
  FORM_CHANGED_FIELD,
  recognizeFields,
  SubmissionChallenged,
  SubmissionCodeNotFound,
  SubmissionHeld,
  SubmissionNeedsInput,
  SubmissionRefused,
  SubmissionUnconfirmed,
  SUBMIT_TARGET_FIELD,
  submitEvidenceRoot,
  type BrowserPage,
  type CoveringDialog,
  type InvalidField,
  type StandingDialogCandidate,
  type WorkdayAccountOutcome,
  type WorkdayCredentials,
  type WorkdayPageError
} from "@internship-agent/browser";
import type { RawControl } from "@internship-agent/browser";
import {
  advancePipeline,
  AutomaticRunStopped,
  PostingClosed,
  getReviewQueue,
  pipelineSettings,
  approveApplication,
  approveRunSubmission,
  answerRunPause,
  canStartBrowserRun,
  cancelBrowserRun,
  confirmRunAts,
  connectHandshake,
  continueBrowserRun,
  getApplicationPackage,
  getReviewQueueWithResumeState,
  listJobResumeVariants,
  refreshApplications,
  resumeChangedSincePrepared,
  setCandidateResumeEntryOnResume,
  getBrowserRuns,
  getWorkdaySession,
  getWorkdayAccount,
  putWorkdayAccount,
  evaluateAndPersistMatch,
  getHandshakeSession,
  getResumeVariantUsage,
  prepareApplication,
  printResumeVariant,
  runEvidenceCommand,
  standingDialogEventText,
  startBrowserRun,
  storeBaseResume,
  storeCandidateDocument,
  submitBrowserRun,
  type MailMessage,
  type ModelProvider,
  type PipelineSettings,
  type StructuredRequest,
  type SessionWindow,
  type VerificationMailboxFactory
} from "@internship-agent/agent";
import { baseResumeFilePath, baseResumeUploadPath, candidateDocumentFilePath } from "@internship-agent/browser";
import { formatNotice, passNoticeItems, type NoticeLookup } from "../../packages/agent/src/pass-notice";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-browser-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-run-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A Playwright-style locator timeout, as `locator.fill` throws it. */
function playwrightTimeout(): Error {
  return Object.assign(new Error("locator.fill: Timeout 30000ms exceeded. waiting for getByLabel('Start typing...').first()"), { name: "TimeoutError" });
}

/** A text question the facts answer and a required radio set the candidate answers (Track 25's read-back). */
const CLUB_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
  { tag: "input", type: "radio", id: "club", label: "Which student club do you belong to?", required: true, options: ["Robotics", "Chess"] },
  { tag: "button", label: "Submit application" }
];

/** In-memory stand-in for a page: records fills, never touches a browser. */
function fakePage(overrides: {
  controls?: RawControl[];
  confirmation?: string | null;
  submitted?: { clicked: boolean };
  url?: string;
  title?: string;
  body?: string;
} = {}): BrowserPage & { filled: Map<string, string>; uploads: Map<string, string> } {
  const filled = new Map<string, string>();
  const uploads = new Map<string, string>();
  const state = { clicked: false };
  if (overrides.submitted) overrides.submitted.clicked = false;
  const confirmation = overrides.confirmation ?? "Thank you! Your application was received.";
  let submitted = false;
  return {
    filled,
    uploads,
    url: () => overrides.url ?? "https://app.joinhandshake.com/apply/900001",
    title: async () => overrides.title ?? "Handshake application",
    collectControls: async () => overrides.controls ?? [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "input", type: "text", id: "q2", label: "Favorite color?", required: false },
      { tag: "button", label: "Submit application" }
    ],
    bodyText: async () => {
      if (submitted) return confirmation;
      return overrides.body ?? "Please fix the errors below.";
    },
    fillField: async (field: BrowserField, value: string) => {
      filled.set(field.id, value);
    },
    chooseOption: async (field: BrowserField, option: string) => {
      filled.set(field.id, option);
    },
    setChecked: async (field: BrowserField, checked: boolean) => {
      filled.set(field.id, String(checked));
    },
    uploadFile: async (field: BrowserField, path: string) => {
      uploads.set(field.id, path);
    },
    clickSubmit: async () => {
      state.clicked = true;
      submitted = true;
      if (overrides.submitted) overrides.submitted.clicked = true;
    },
    screenshot: async () => {},
    close: async () => {}
  };
}

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

function approvedJobId(database: DatabaseSync, stopAt: "approved" | "qualified" | "ingested" = "approved"): string {
  seedDevelopmentData(database);
  // The automatic pipeline runs only on AI labels; the seed's rule labels stand in for them here.
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");

  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    owner: "example",
    name: "evidence-demo",
    url: "https://github.com/example/evidence-demo",
    defaultBranch: "main",
    description: "Fixture evidence.",
    observedHeadSha: "sha-fixture"
  });
  const sha = "sha-fixture";
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    repositoryId: repository.id,
    name: "evidence-demo",
    summary: "Fixture project.",
    fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology",
      normalizedKey: "python",
      text: "Shipped Python services in production.",
      evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme",
        commitSha: sha,
        path: "README.md",
        startLine: 2,
        endLine: 2,
        sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L2`,
        excerpt: "Python services in production.",
        excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0].claims[0];
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);

  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  if (stopAt === "ingested") return row.id;
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  if (stopAt === "qualified") return row.id;
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  return row.id;
}

describe("browser run lifecycle", () => {
  it("fills known answers, pauses on the unknown, and submits after approval", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const openPage = async () => fakePage();

    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database,
      dataDir,
      openPage: openPage as () => Promise<BrowserPage>
    });
    // Start date resolves from memory; favorite color is optional and skipped.
    expect(started.run.status).toBe("awaiting-approval");
    expect(started.applied).toBeGreaterThan(0);
    expect(database.prepare("SELECT status AS status FROM jobs WHERE id = ?").get(jobId)).toEqual({ status: "APPLYING" });

    const approved = approveRunSubmission(started.run.id, undefined, { database });
    expect(approved.submissionApprovedAt).not.toBe(null);

    const submittedFlag = { clicked: false };
    const submitted = await submitBrowserRun(started.run.id, {
      database,
      dataDir,
      openPage: (async () => fakePage({ submitted: submittedFlag })) as () => Promise<BrowserPage>
    });
    expect(submittedFlag.clicked).toBe(true);
    expect(submitted.status).toBe("submitted");
    expect(submitted.confirmationText).toContain("Thank you");
    expect(Object.keys(submitted.submittedAnswers ?? {}).length).toBeGreaterThan(0);
    expect(database.prepare("SELECT status AS status FROM jobs WHERE id = ?").get(jobId)).toEqual({ status: "SUBMITTED" });
    database.close();
  });

  it("pauses on unmapped required fields and continues after the candidate answers", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "essay", label: "What name should appear on your badge?", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database,
      dataDir,
      openPage: async () => fakePage({ controls })
    });
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses).toHaveLength(1);

    await answerRunPause(started.run.id, "essay", "Building local-first agent tooling.", true, { database });
    const continued = await continueBrowserRun(started.run.id, {
      database,
      dataDir,
      openPage: async () => fakePage({ controls })
    });
    expect(continued.run.status).toBe("awaiting-approval");
    expect(continued.run.decisions.find((decision) => decision.fieldId === "essay")?.action).toBe("fill");
    database.close();
  });

  it("refuses to start from unapproved packages and to submit without approval", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    seedDevelopmentData(database);
    const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
    let error: unknown = null;
    try {
      await startBrowserRun(row.id, "https://app.joinhandshake.com/apply/900001", {
        database,
        dataDir,
        openPage: async () => fakePage()
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error === null).toBe(false);
    database.close();
  });

  it("holds submission until the candidate confirms an unrecognized ATS", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const genericPage = async () => fakePage({
      url: "https://careers.example.com/apply/123",
      title: "Example careers",
      body: "Fill out the form below."
    });
    const started = await startBrowserRun(jobId, "https://careers.example.com/apply/123", {
      database,
      dataDir,
      openPage: genericPage
    });
    expect(started.run.atsKind).toBe("unknown");

    approveRunSubmission(started.run.id, undefined, { database });
    let submitError: unknown = null;
    try {
      await submitBrowserRun(started.run.id, { database, dataDir, openPage: genericPage });
    } catch (thrown) {
      submitError = thrown;
    }
    expect(submitError === null).toBe(false);

    const confirmed = confirmRunAts(started.run.id, "unknown", { database });
    expect(confirmed.atsKind).toBe("unknown");
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, openPage: genericPage });
    expect(submitted.status).toBe("submitted");
    database.close();
  });

  it("cancels an open run but never a submitted one", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database,
      dataDir,
      openPage: async () => fakePage()
    });
    expect(cancelBrowserRun(started.run.id, database).status).toBe("cancelled");
    database.close();
  });

  it("pauses with one safeguard when the page shows a visible CAPTCHA, never otherwise", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir,
      openPage: async () => ({ ...fakePage(), visibleChallenge: async () => ({ kind: "recaptcha" as const, detail: "a reCAPTCHA checkbox" }) })
    });
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "site-challenge", safeguard: true, status: "open" })]);
    expect(started.run.pauses[0]!.question).toContain("never solves CAPTCHAs");
    expect(() => approveRunSubmission(started.run.id, undefined, { database })).toThrow();
    database.close();
  });

  it("holds a run whose submit click brings up a CAPTCHA, and never marks it submitted", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const challenged = () => {
      const flag = { clicked: false };
      return { ...fakePage({ submitted: flag, confirmation: "Please complete the security step." }),
        visibleChallenge: async () => (flag.clicked ? { kind: "recaptcha" as const, detail: "a reCAPTCHA image challenge" } : null) };
    };
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => challenged() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    const failure = await submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => challenged() }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionChallenged);
    expect(String((failure as Error).message)).toContain("never solves CAPTCHAs");
    expect(getBrowserRuns(jobId, database)[0]!.status).toBe("failed");
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).not.toBe("SUBMITTED");
    database.close();
  });

  it("pauses a field whose fill times out instead of stopping the run, and never stores the raw Playwright message", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const page = { ...fakePage(), fillField: async (field: BrowserField) => { if (field.id === "q1") throw playwrightTimeout(); } };
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => page });
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "q1", status: "open", safeguard: false, upload: false })]);
    expect(started.run.pauses[0]!.question).toBe(`The agent could not fill "What is your available start date?": the field did not respond in time. Answer it here, or fill it in the browser.`);
    expect(started.run.decisions.find((decision) => decision.fieldId === "q1")).toMatchObject({ action: "pause" });
    expect(JSON.stringify(started.run)).not.toContain("Timeout 30000ms");
    database.close();
  });

  it("saves one capture of a dialog that covers the form for the run, redacted, and the pause says where to look (Track 39)", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    // Fictional: a modal "session expired" dialog over the form; the page's own email stands in for a value redaction removes.
    const dialog: CoveringDialog = {
      tag: "div", role: "dialog", label: "Your session has expired", description: "Signed in as jordan@example.test",
      ariaAttributes: [{ name: "aria-modal", value: "true" }, { name: "aria-labelledby", value: "expiredTitle" }],
      text: "Your session has expired Signed in as jordan@example.test Sign in again ×",
      buttons: [{ text: "Sign in again", ariaLabel: "", title: "", disabled: false }, { text: "×", ariaLabel: "Close", title: "Close", disabled: false }]
    };
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "input", type: "email", id: "email", label: "Email", required: true },
      { tag: "button", label: "Submit application" }
    ];
    let shots = 0;
    const covered = (): BrowserPage => ({
      ...fakePage({ controls, body: "Application form\nYour session has expired\nSigned in as jordan@example.test" }),
      fillField: async () => { throw new FieldUnfillable(COVERING_DIALOG_REASON); },
      coveringDialogs: async () => [dialog],
      screenshot: async (path: string) => { shots += 1; writeFileSync(path, "fictional png"); }
    });
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => covered() });
    const ref = started.run.id.slice(0, 8);
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses.map((pause) => pause.fieldId).sort()).toEqual(["email", "q1"]);
    expect(started.run.pauses.find((pause) => pause.fieldId === "q1")!.question).toBe(
      `The agent could not fill "What is your available start date?": a dialog covers the form, and the agent does not click through or close such a dialog. `
      + `Open the application in your browser to see what the dialog asks (pnpm run:evidence --run ${ref} shows what the agent saw), then answer it here, or fill it in the browser.`
    );

    // Two fields were covered; one capture, saved for the run while the page was open.
    const root = submitEvidenceRoot(dataDir, jobId);
    const folders = () => readdirSync(root);
    expect(folders()).toHaveLength(1);
    expect(shots).toBe(1);
    const dir = join(root, folders()[0]!);
    const stored = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
    expect(stored).toMatchObject({
      runId: started.run.id, jobId, outcome: "covering-dialog", screenshot: "screenshot.png", invalidFields: [],
      detail: `A dialog covered the form when the agent filled "What is your available start date?"; the agent left it open and clicked nothing in it.`,
      coveringDialogs: [{
        tag: "div", role: "dialog", label: "Your session has expired",
        ariaAttributes: [{ name: "aria-modal", value: "true" }, { name: "aria-labelledby", value: "expiredTitle" }],
        buttons: [{ text: "Sign in again", ariaLabel: "", title: "", disabled: false }, { text: "×", ariaLabel: "Close", title: "Close", disabled: false }]
      }]
    });
    expect(stored.text).toContain("Your session has expired");
    expect(JSON.stringify(stored)).not.toContain("jordan@example.test");
    expect(statSync(join(dir, "evidence.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "screenshot.png")).mode & 0o777).toBe(0o600);
    const savedEvents = () => (database.prepare("SELECT detail FROM application_events WHERE job_id = ? AND detail LIKE 'Covering dialog evidence%'").all(jobId) as Array<{ detail: string }>);
    expect(savedEvents()).toEqual([{ detail: `Covering dialog evidence saved (covering-dialog): applications/${jobId}/submit-evidence/${folders()[0]}; view it with pnpm run:evidence --run ${ref}.` }]);

    const lines: string[] = [];
    const io = { open: () => database, close: () => undefined, dataDir: () => dataDir, log: (line: string) => { lines.push(line); } };
    expect(await runEvidenceCommand(["--run", ref], io)).toBe(0);
    expect(lines.some((line) => line.endsWith(": covering-dialog (a dialog covered the form while the agent filled it)"))).toBe(true);
    expect(lines).toEqual(expect.arrayContaining([
      "Covering dialogs: 1",
      `  - dialog 1: <div> role "dialog"; aria-modal="true", aria-labelledby="expiredTitle"`,
      "    label: Your session has expired",
      "    buttons:",
      `      - "Sign in again"`,
      `      - "×" (aria-label "Close", title "Close")`
    ]));
    expect(lines.join("\n")).not.toContain("jordan@example.test");

    // Covered again on continue: still the run's one capture.
    const continued = await continueBrowserRun(started.run.id, { database, dataDir, openPage: async () => covered() });
    expect(continued.run.status).toBe("paused-needs-input");
    expect(folders()).toHaveLength(1);
    expect(shots).toBe(1);
    expect(savedEvents()).toHaveLength(1);
    database.close();
  });

  it("saves no dialog capture when a fill fails for another reason", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    let reads = 0;
    const page = { ...fakePage(), fillField: async () => { throw new FieldUnfillable("the site did not keep the suggestion"); }, coveringDialogs: async () => { reads += 1; return []; } };
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => page });
    expect(started.run.pauses[0]!.question).toBe(`The agent could not fill "What is your available start date?": the site did not keep the suggestion. Answer it here, or fill it in the browser.`);
    expect(reads).toBe(0);
    expect(existsSync(submitEvidenceRoot(dataDir, jobId))).toBe(false);
    database.close();
  });

  describe("a consent dialog over the form under the standing settings (Track 40)", () => {
    // Fictional: a privacy notice and system-use dialog, as readStandingDialogsIn reads it.
    const AGREE = "By clicking I Agree, you acknowledge that you have read and understand this notice and the Job Applicant Privacy Notice and consent to the collection and processing of your personal information as described above and in our Job Applicant Privacy Notice.";
    const PRIVACY_TEXT = [
      "Privacy Notice and Security Agreement",
      "System Use Acknowledgment: Use of this system is subject to monitoring for security purposes.",
      "How we use your resume/CV:",
      "Fixture Aero reads your resume/CV to consider you for the position you applied for.",
      AGREE
    ];
    const privacy: StandingDialogCandidate = {
      index: 0, label: "Privacy Notice and Security Agreement", text: PRIVACY_TEXT.join("\n"), overLimit: false, formControls: 0, frames: 0, expanders: 0,
      buttons: [
        { tag: "0-0", text: "×", ariaLabel: "Close", title: "", disabled: false },
        { tag: "0-1", text: "Cancel", ariaLabel: "", title: "", disabled: false },
        { tag: "0-2", text: "I Agree", ariaLabel: "", title: "", disabled: false }
      ]
    };
    const marketing: StandingDialogCandidate = {
      ...privacy, label: "Stay in touch",
      text: "Stay in touch\nBy clicking I Agree, you agree to receive the Fixture Aero newsletter and marketing emails about future opportunities.",
      buttons: [{ tag: "0-0", text: "Cancel", ariaLabel: "", title: "", disabled: false }, { tag: "0-1", text: "I Agree", ariaLabel: "", title: "", disabled: false }]
    };
    const BOTH = { acceptDataConsent: true, signAttestations: true };
    const OFF = { acceptDataConsent: false, signAttestations: false };
    const EXPECTED_EVENT = `Accepted data consent and attestation: '${AGREE}' — clicked "I Agree" on the dialog "Privacy Notice and Security Agreement" over the form. Dialog text: '${PRIVACY_TEXT.join(" ")}'.`;
    /** A page a dialog covers until its agree button is clicked; the clicks are counted. */
    const coveredBy = (candidate: StandingDialogCandidate, clicks: Array<[string, string]>, submitted?: { clicked: boolean }): BrowserPage => {
      let covered = true;
      return {
        ...fakePage({ submitted }),
        fillField: async () => { if (covered) throw new FieldUnfillable(COVERING_DIALOG_REASON); },
        standingDialogs: async () => (covered ? [candidate] : []),
        clickDialogButton: async (tag: string, name: string) => {
          clicks.push([tag, name]);
          covered = false;
          return "hidden" as const;
        },
        screenshot: async (path: string) => { writeFileSync(path, "fictional png"); }
      };
    };
    const events = (database: DatabaseSync, jobId: string) => (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string }>).map((row) => row.detail);
    const accepted = (database: DatabaseSync, jobId: string) => events(database, jobId).filter((detail) => detail.startsWith("Accepted data consent and attestation:"));

    it("agrees to it at the start, logs the exact text once, and pauses nothing", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const clicks: Array<[string, string]> = [];
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, standingConsent: BOTH, openPage: async () => coveredBy(privacy, clicks) });
      expect(started.run.status).toBe("awaiting-approval");
      expect(started.run.pauses).toEqual([]);
      expect(clicks).toEqual([["0-2", "I Agree"]]);
      expect(accepted(database, jobId)).toEqual([EXPECTED_EVENT]);
      expect(EXPECTED_EVENT).toBe(standingDialogEventText({
        label: privacy.label, text: PRIVACY_TEXT.join(" "), statements: [AGREE], button: "I Agree", setting: "both",
        groups: ["data-processing", "privacy-policy", "acknowledgment"], outcome: "accepted"
      }));
      expect(existsSync(submitEvidenceRoot(dataDir, jobId))).toBe(false);
      expect(events(database, jobId).some((detail) => detail.startsWith("Covering dialog evidence"))).toBe(false);
      database.close();
    });

    it("leaves it with the settings off (pauses and one capture, as Track 39), then agrees on continue once they are on", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const clicks: Array<[string, string]> = [];
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, standingConsent: OFF, openPage: async () => coveredBy(privacy, clicks) });
      expect(started.run.status).toBe("paused-needs-input");
      expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "q1", status: "open" })]);
      expect(started.run.pauses[0]!.question).toContain("a dialog covers the form");
      expect(clicks).toEqual([]);
      expect(readdirSync(submitEvidenceRoot(dataDir, jobId))).toHaveLength(1);
      expect(accepted(database, jobId)).toEqual([]);
      expect(events(database, jobId).some((detail) => detail.startsWith("Left "))).toBe(false);

      const continued = await continueBrowserRun(started.run.id, { database, dataDir, standingConsent: BOTH, openPage: async () => coveredBy(privacy, clicks) });
      expect(clicks).toEqual([["0-2", "I Agree"]]);
      expect(accepted(database, jobId)).toEqual([EXPECTED_EVENT]);
      expect(continued.run.status).toBe("awaiting-approval");
      expect(continued.run.decisions.find((decision) => decision.fieldId === "q1")?.action).toBe("fill");
      database.close();
    });

    it("never agrees to a marketing dialog: logs why it was left, captures it, and pauses as today", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const clicks: Array<[string, string]> = [];
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, standingConsent: BOTH, openPage: async () => coveredBy(marketing, clicks) });
      expect(started.run.status).toBe("paused-needs-input");
      expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "q1", status: "open" })]);
      expect(clicks).toEqual([]);
      expect(accepted(database, jobId)).toEqual([]);
      expect(events(database, jobId).filter((detail) => detail.startsWith("Left "))).toEqual([
        "Left the dialog \"Stay in touch\" over the form for you: it includes a marketing, newsletter, or job-alert opt-in."
      ]);
      expect(readdirSync(submitEvidenceRoot(dataDir, jobId))).toHaveLength(1);
      database.close();
    });

    it("agrees to it when the approved answers are applied again before the submit click, and submits", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, standingConsent: BOTH, openPage: async () => fakePage() });
      expect(started.run.status).toBe("awaiting-approval");
      approveRunSubmission(started.run.id, undefined, { database });
      const clicks: Array<[string, string]> = [];
      const flag = { clicked: false };
      const submitted = await submitBrowserRun(started.run.id, { database, dataDir, standingConsent: BOTH, openPage: async () => coveredBy(privacy, clicks, flag) });
      expect(clicks).toEqual([["0-2", "I Agree"]]);
      expect(flag.clicked).toBe(true);
      expect(submitted.status).toBe("submitted");
      expect(accepted(database, jobId)).toEqual([EXPECTED_EVENT]);
      database.close();
    });
  });

  it("holds a run whose field will not fill right before the submit click: nothing is clicked and the approval is withdrawn", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    const flag = { clicked: false };
    const failing = { ...fakePage({ submitted: flag }), fillField: async () => { throw playwrightTimeout(); } };
    const failure = await submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => failing }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionHeld);
    expect(String((failure as Error).message)).toContain(`could not fill 1 field(s) ("What is your available start date?")`);
    expect(flag.clicked).toBe(false);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual([expect.objectContaining({ fieldId: "q1", status: "open" })]);
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).not.toBe("SUBMITTED");
    database.close();
  });

  /** Starts a run on CLUB_CONTROLS, answers the club pause with "chess", continues, and approves the submission. */
  async function approvedClubRun(database: DatabaseSync, dataDir: string): Promise<{ jobId: string; runId: string }> {
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage({ controls: CLUB_CONTROLS }) });
    expect(started.run.pauses.map((pause) => pause.fieldId)).toContain("club");
    await answerRunPause(started.run.id, "club", "chess", false, { database });
    const continued = await continueBrowserRun(started.run.id, { database, dataDir, openPage: async () => fakePage({ controls: CLUB_CONTROLS }) });
    expect(continued.run.status).toBe("awaiting-approval");
    expect(continued.run.decisions.find((decision) => decision.fieldId === "club")).toMatchObject({ action: "choose", value: "Chess" });
    approveRunSubmission(started.run.id, undefined, { database });
    return { jobId, runId: started.run.id };
  }

  it("holds a run whose radio choice does not read back before the submit click: nothing is clicked and the approval is withdrawn", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const { jobId, runId } = await approvedClubRun(database, dataDir);
    const flag = { clicked: false };
    // The page took nothing: the radio set shows no option chosen.
    const page = { ...fakePage({ controls: CLUB_CONTROLS, submitted: flag }), readFields: async () => recognizeFields(CLUB_CONTROLS) };
    const failure = await submitBrowserRun(runId, { database, dataDir, openPage: async () => page }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionHeld);
    expect(String((failure as Error).message)).toContain(`"Which student club do you belong to?" did not take the choice`);
    expect(flag.clicked).toBe(false);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual(expect.arrayContaining([expect.objectContaining({
      fieldId: "club",
      status: "open",
      question: 'The agent could not fill "Which student club do you belong to?": the page did not take the choice. Answer it here, or fill it in the browser.'
    })]));
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).not.toBe("SUBMITTED");
    database.close();

    // Positive control: the same run whose page shows the choice made submits.
    const shownDatabase = disposableDatabase();
    const shownDataDir = disposableDataDir();
    const shown = await approvedClubRun(shownDatabase, shownDataDir);
    const shownFlag = { clicked: false };
    const chosen = CLUB_CONTROLS.map((control) => (control.id === "club" ? { ...control, value: "Chess" } : control));
    const shownPage = { ...fakePage({ controls: CLUB_CONTROLS, submitted: shownFlag }), readFields: async () => recognizeFields(chosen) };
    await submitBrowserRun(shown.runId, { database: shownDatabase, dataDir: shownDataDir, openPage: async () => shownPage });
    expect(getBrowserRuns(shown.jobId, shownDatabase)[0]!.status).toBe("submitted");
    expect(shownFlag.clicked).toBe(true);
    shownDatabase.close();
  });

  it("holds a run whose approved answer is no longer on the reloaded form, before anything is typed", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const { jobId, runId } = await approvedClubRun(database, dataDir);
    const flag = { clicked: false };
    // The radio set's id changed between loads, as Ashby's did.
    const page = fakePage({ controls: CLUB_CONTROLS.map((control) => (control.id === "club" ? { ...control, id: "club-reloaded" } : control)), submitted: flag });
    const failure = await submitBrowserRun(runId, { database, dataDir, openPage: async () => page }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionHeld);
    expect(String((failure as Error).message).startsWith("1 answer(s) the approval covered are no longer on the application form")).toBe(true);
    expect(flag.clicked).toBe(false);
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId: FORM_CHANGED_FIELD, safeguard: true, status: "open" })]));
    expect(run.decisions.find((decision) => decision.fieldId === FORM_CHANGED_FIELD)).toMatchObject({ action: "pause" });
    expect(run.decisions.find((decision) => decision.fieldId === "club")).toMatchObject({ action: "choose", value: "Chess" });
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).not.toBe("SUBMITTED");
    database.close();
  });

  it("holds a run whose CAPTCHA appears while the form fills, before the submit click: nothing is clicked and the approval is withdrawn", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    const flag = { clicked: false };
    const page = fakePage({ submitted: flag });
    // Like Dover's Turnstile: nothing on opening, the widget drawn once the form is being filled.
    const late = { ...page, visibleChallenge: async () => (page.filled.size > 0 && !flag.clicked ? { kind: "turnstile" as const, detail: "a Cloudflare Turnstile challenge" } : null) };
    const failure = await submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => late }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionChallenged);
    expect(String((failure as Error).message)).toContain("Before the submit click the site showed a Cloudflare Turnstile challenge");
    expect(flag.clicked).toBe(false);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId: "site-challenge", safeguard: true, status: "open" })]));
    expect(existsSync(join(dataDir, "applications", jobId, "submit-evidence"))).toBe(false);
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).not.toBe("SUBMITTED");
    database.close();
  });

  /** Starts an approved run on the default Handshake page, then submits through `page`; returns what the submit threw. */
  async function heldSubmit(page: BrowserPage) {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    const failure = await submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => page }).catch((error: unknown) => error);
    return { database, dataDir, jobId, failure };
  }

  function expectSubmitTargetHold(held: Awaited<ReturnType<typeof heldSubmit>>, flag: { clicked: boolean }, message: string) {
    const { database, dataDir, jobId, failure } = held;
    expect(failure).toBeInstanceOf(SubmissionHeld);
    expect(String((failure as Error).message)).toContain(message);
    expect(flag.clicked).toBe(false);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId: SUBMIT_TARGET_FIELD, safeguard: true, status: "open", label: "Submit button" })]));
    expect(run.decisions.find((decision) => decision.fieldId === SUBMIT_TARGET_FIELD)).toMatchObject({ action: "pause" });
    expect(existsSync(join(dataDir, "applications", jobId, "submit-evidence"))).toBe(false);
    expect(jobStatus(database, jobId)).not.toBe("SUBMITTED");
    database.close();
  }

  it("holds a submit whose page still shows a step's Next and no submit control: nothing is clicked and the approval is withdrawn (Track 38)", async () => {
    const flag = { clicked: false };
    const page = Object.assign(fakePage({ submitted: flag }), { stepButtons: async () => ({ submit: false, next: "Next" }) });
    expectSubmitTargetHold(await heldSubmit(page), flag, `still shows a "Next" button and no submit control`);
  });

  it("holds a submit when no submit control of the form's own is shown: nothing is clicked and the approval is withdrawn (Track 38)", async () => {
    const flag = { clicked: false };
    const page = { ...fakePage({ submitted: flag }), submitControlShown: async () => false };
    const held = await heldSubmit(page);
    expect(String((held.failure as Error).message).startsWith("No submit control of the application form itself")).toBe(true);
    expectSubmitTargetHold(held, flag, "a cookie banner's button or a step's \"Next\" is never clicked as submit");
  });

  it("chooses an answered list option on continue, and reopens an answer that is not among the options", async () => {
    const controls: RawControl[] = [
      { tag: "select", id: "team", label: "Which team do you prefer?", required: true, options: ["Platform", "Data"] },
      { tag: "button", label: "Submit application" }
    ];
    // The site changed the list while the run waited: the answer fits no option any more.
    const changed: RawControl[] = [
      { tag: "select", id: "team", label: "Which team do you prefer?", required: true, options: ["Platform", "Infrastructure"] },
      { tag: "button", label: "Submit application" }
    ];
    for (const [answer, expected] of [["data", "choose"], ["Robotics", "refused"], ["Data", "reopen"]] as const) {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const page = fakePage({ controls: expected === "reopen" ? changed : controls });
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage({ controls }) });
      expect(started.run.pauses.map((pause) => pause.fieldId)).toEqual(["team"]);
      if (expected === "refused") {
        // An answer that is not an offered option is refused when it is given, and the pause stays open.
        await expect(answerRunPause(started.run.id, "team", answer, false, { database })).rejects.toThrow("not one of the offered options");
        expect(getBrowserRuns(jobId, database)[0]!.pauses).toEqual([expect.objectContaining({ fieldId: "team", status: "open", answer: null })]);
        database.close();
        continue;
      }
      await answerRunPause(started.run.id, "team", answer, false, { database });
      const continued = await continueBrowserRun(started.run.id, { database, dataDir, openPage: async () => page });
      if (expected === "choose") {
        expect(continued.run.status).toBe("awaiting-approval");
        expect(continued.run.decisions.find((decision) => decision.fieldId === "team")).toMatchObject({ action: "choose", value: "Data" });
        expect(page.filled.get("team")).toBe("Data");
      } else {
        expect(continued.run.status).toBe("paused-needs-input");
        expect(continued.run.pauses).toEqual([expect.objectContaining({ fieldId: "team", status: "open", answer: null })]);
        expect(continued.run.decisions.find((decision) => decision.fieldId === "team")?.action).toBe("pause");
        expect(page.filled.has("team")).toBe(false);
      }
      database.close();
    }
  });

  it("chooses an answered radio set and type-ahead on continue, never typing into them", async () => {
    const controls: RawControl[] = [
      { tag: "input", type: "radio", id: "club", label: "Which student club do you belong to?", required: true, options: ["Robotics", "Chess"] },
      { tag: "input", type: "text", id: "community", label: "Favorite programming community", required: true, widget: "autocomplete" },
      { tag: "button", label: "Submit application" }
    ];
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage({ controls }) });
    expect(started.run.pauses.map((pause) => pause.fieldId).sort()).toEqual(["club", "community"]);
    await answerRunPause(started.run.id, "club", "chess", false, { database });
    await answerRunPause(started.run.id, "community", "Rust Users Forum", false, { database });
    const page = fakePage({ controls });
    const typed = new Set<string>();
    const chosen = new Map<string, string>();
    const continued = await continueBrowserRun(started.run.id, {
      database,
      dataDir,
      openPage: async () => ({
        ...page,
        fillField: async (field: BrowserField, value: string) => {
          typed.add(field.id);
          await page.fillField(field, value);
        },
        chooseOption: async (field: BrowserField, option: string) => {
          chosen.set(field.id, option);
          await page.chooseOption(field, option);
        }
      })
    });
    expect(continued.run.status).toBe("awaiting-approval");
    expect(Object.fromEntries(chosen)).toEqual({ club: "Chess", community: "Rust Users Forum" });
    expect(typed.has("club")).toBe(false);
    expect(typed.has("community")).toBe(false);
    expect(continued.run.decisions.filter((decision) => decision.fieldId === "club" || decision.fieldId === "community").map((decision) => decision.action))
      .toEqual(["choose", "choose"]);
    database.close();
  });
});

const FILE_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
  { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
  { tag: "button", label: "Submit application" }
];

/** A fictional Phenom-style apply step on an employer host (Track 38; MITRE's was taken for Workday). */
const PHENOM_STEPS_URL = "https://careers.fixturelabs.example/us/en/apply?jobSeqNo=R300003&step=1&stepname=personalInformation";

function setApplicationType(database: DatabaseSync, jobId: string, type: "HANDSHAKE_INTERNAL" | "EXTERNAL_ATS") {
  database.prepare("UPDATE jobs SET application_type = ? WHERE id = ?").run(type, jobId);
}

function jobStatus(database: DatabaseSync, jobId: string): string {
  return (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% fixture base resume\n%%EOF\n");

/** The default (2028) and alternate-profile (2029) graduation answers. */
function graduationFacts(database: DatabaseSync, alternate = true) {
  for (const [scope, value] of [
    [{ kind: "global" }, "2028-05-15"],
    ...(alternate ? [[{ kind: "application_channel", channel: "handshake_internal" }, "2029-05-15"]] as const : [])
  ] as const) {
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key: "graduation_date",
      scope,
      value,
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
      confidence: 1,
      rememberedAt: "2026-09-22T12:00:00.000Z"
    });
  }
}

describe("resume uploads and Handshake sessions", () => {
  it("uploads the uploaded 2029 resume byte for byte on Handshake Apply runs and prints nothing", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    graduationFacts(database);
    const resume = storeBaseResume({ channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const staged = baseResumeUploadPath(dataDir, jobId, resume.id, "resume-2029.pdf");
    const rendered: string[] = [];
    const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 1 }; };
    const startPage = fakePage({ controls: FILE_CONTROLS });

    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir, renderPdf, openPage: async () => startPage
    });
    expect(started.run.baseResumeId).toBe(resume.id);
    expect(startPage.uploads.get("resume")).toBe(staged);
    expect(new Uint8Array(readFileSync(staged))).toEqual(PDF_BYTES);
    expect(rendered).toHaveLength(0);
    expect(started.run.decisions.find((decision) => decision.fieldId === "resume")?.basis).toEqual({ kind: "base_resume", baseResumeId: resume.id });

    approveRunSubmission(started.run.id, undefined, { database });
    const submitPage = fakePage({ controls: FILE_CONTROLS });
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: async () => submitPage });
    expect(submitted.status).toBe("submitted");
    expect(submitPage.uploads.get("resume")).toBe(staged);
    expect(submitted.baseResumeId).toBe(resume.id);
    expect(rendered).toHaveLength(0);
    database.close();
  });

  it("prints the tailored resume with the 2029 graduation date on Handshake Apply runs when no 2029 resume is uploaded", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    graduationFacts(database);
    // Only a default resume exists; the 2029 profile never sends it.
    storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const rendered: Array<{ html: string; path: string }> = [];
    const renderPdf = async (html: string, path: string) => { rendered.push({ html, path }); return { pages: 1 }; };
    const startPage = fakePage({ controls: FILE_CONTROLS });

    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir, renderPdf, openPage: async () => startPage
    });
    expect(started.run.baseResumeId).toBe(null);
    expect(startPage.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);
    expect(started.run.decisions.find((decision) => decision.fieldId === "resume")?.basis).toEqual({ kind: "variant", variantId: started.run.variantId });
    expect(rendered[0]?.html).toContain("Expected May 2029");
    expect(rendered[0]?.html).not.toContain("Expected May 2028");
    expect(getHandshakeSession(database)?.status).toBe("connected");

    approveRunSubmission(started.run.id, undefined, { database });
    const submitPage = fakePage({ controls: FILE_CONTROLS });
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: async () => submitPage });
    expect(submitted.status).toBe("submitted");
    expect(submitPage.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);
    database.close();
  });

  it("uploads the generated resume as a PDF on other applications", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    // A 2029 resume exists, but the default profile never sends it.
    storeBaseResume({ channel: "handshake_internal", label: "Handshake", originalName: "h.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const rendered: Array<{ html: string; path: string }> = [];
    const page = fakePage({ controls: FILE_CONTROLS, url: "https://boards.greenhouse.io/example/jobs/1", title: "Example" });

    const started = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/1", {
      database,
      dataDir,
      renderPdf: async (html, path) => { rendered.push({ html, path }); return { pages: 1 }; },
      openPage: async () => page
    });
    expect(started.run.baseResumeId).toBe(null);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.path.endsWith(".pdf")).toBe(true);
    expect(rendered[0]?.html).toContain("<h1>Jordan Rivera</h1>");
    // Printed from the frozen structured resume: the seeded fictional entries.
    expect(rendered[0]?.html).toContain("<h2>Professional Experience</h2>");
    expect(rendered[0]?.html).toContain("Example Robotics Lab");
    expect(page.uploads.get("resume")).toBe(rendered[0]?.path);
    database.close();
  });

  it("uploads the uploaded default resume byte for byte on default-profile applications, and a two-page variant never stops it", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const defaultResume = storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "Jordan Rivera Resume.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const alternateBytes = new TextEncoder().encode("%PDF-1.7\n% fixture 2029 resume\n%%EOF\n");
    storeBaseResume({ channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: alternateBytes }, { database, dataDir });
    const staged = baseResumeUploadPath(dataDir, jobId, defaultResume.id, "Jordan Rivera Resume.pdf");
    const rendered: string[] = [];
    const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 2 }; };
    const url = "https://boards.greenhouse.io/example/jobs/1";
    const page = fakePage({ controls: FILE_CONTROLS, url, title: "Example" });

    const started = await startBrowserRun(jobId, url, { database, dataDir, renderPdf, openPage: async () => page });
    expect(started.run.status).toBe("awaiting-approval");
    expect(rendered).toHaveLength(0);
    expect(page.uploads.get("resume")).toBe(staged);
    expect(staged.endsWith("Jordan Rivera Resume.pdf")).toBe(true);
    expect(new Uint8Array(readFileSync(staged))).toEqual(PDF_BYTES);
    expect(started.run.baseResumeId).toBe(defaultResume.id);
    expect(started.run.applicationProfile).toBe("default");

    confirmRunAts(started.run.id, "greenhouse", { database });
    approveRunSubmission(started.run.id, undefined, { database });
    const submitPage = fakePage({ controls: FILE_CONTROLS, url, title: "Example" });
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: async () => submitPage });
    expect(submitted.status).toBe("submitted");
    expect(submitPage.uploads.get("resume")).toBe(staged);
    expect(rendered).toHaveLength(0);
    database.close();
  });

  it("sends the uploaded default resume into a Greenhouse group-labelled Resume/CV upload", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const defaultResume = storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const staged = baseResumeUploadPath(dataDir, jobId, defaultResume.id, "resume-2028.pdf");
    const url = "https://job-boards.greenhouse.io/example/jobs/1";
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "input", type: "file", id: "resume", label: "Resume/CV", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const page = fakePage({ controls, url, title: "Example" });
    const started = await startBrowserRun(jobId, url, { database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => page });
    expect(started.run.decisions.find((decision) => decision.fieldId === "resume")?.basis).toEqual({ kind: "base_resume", baseResumeId: defaultResume.id });
    expect(page.uploads.get("resume")).toBe(staged);
    expect(new Uint8Array(readFileSync(staged))).toEqual(PDF_BYTES);
    database.close();
  });

  it("INTERNSHIP_AGENT_RESUME_SOURCE=generated sends the tailored resume even when one is uploaded", async () => {
    const previous = process.env.INTERNSHIP_AGENT_RESUME_SOURCE;
    process.env.INTERNSHIP_AGENT_RESUME_SOURCE = "generated";
    try {
      const url = "https://boards.greenhouse.io/example/jobs/1";
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      setApplicationType(database, jobId, "EXTERNAL_ATS");
      storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume.pdf", bytes: PDF_BYTES }, { database, dataDir });
      const rendered: string[] = [];
      const page = fakePage({ controls: FILE_CONTROLS, url, title: "Example" });
      const started = await startBrowserRun(jobId, url, {
        database, dataDir, renderPdf: async (_html, path) => { rendered.push(path); return { pages: 1 }; }, openPage: async () => page
      });
      expect(rendered).toHaveLength(1);
      expect(page.uploads.get("resume")).toBe(rendered[0]);
      expect(started.run.baseResumeId).toBe(null);
      database.close();

      const second = disposableDatabase();
      const secondDir = disposableDataDir();
      const secondJob = approvedJobId(second);
      setApplicationType(second, secondJob, "EXTERNAL_ATS");
      storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume.pdf", bytes: PDF_BYTES }, { database: second, dataDir: secondDir });
      await expect(startBrowserRun(secondJob, url, {
        database: second, dataDir: secondDir, renderPdf: async () => ({ pages: 2 }),
        openPage: async () => fakePage({ controls: FILE_CONTROLS, url, title: "Example" })
      })).rejects.toThrow(/2 pages/);
      second.close();
    } finally {
      if (previous === undefined) delete process.env.INTERNSHIP_AGENT_RESUME_SOURCE;
      else process.env.INTERNSHIP_AGENT_RESUME_SOURCE = previous;
    }
  });

  it("refuses to upload a generated resume longer than one page", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    await expect(startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/1", {
      database,
      dataDir,
      renderPdf: async () => ({ pages: 2 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url: "https://boards.greenhouse.io/example/jobs/1", title: "Example" })
    })).rejects.toThrow(/2 pages/);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    database.close();
  });

  it("refuses a Handshake Apply upload without a 2029 graduation date", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    const rendered: string[] = [];
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database,
      dataDir,
      renderPdf: async (_html, path) => { rendered.push(path); return { pages: 1 }; },
      openPage: async () => fakePage({ controls: FILE_CONTROLS })
    })).rejects.toThrow(/no 2029 graduation date/);
    expect(rendered).toEqual([]);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    database.close();
  });

  it("fails closed when the uploaded resume changed on disk", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    graduationFacts(database);
    const resume = storeBaseResume({ channel: "handshake_internal", label: "Handshake", originalName: "h.pdf", bytes: PDF_BYTES }, { database, dataDir });
    appendFileSync(baseResumeFilePath(dataDir, resume.fileName), "tampered");
    const rendered: string[] = [];
    const page = fakePage({ controls: FILE_CONTROLS });
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir, renderPdf: async (_html, path) => { rendered.push(path); return { pages: 1 }; }, openPage: async () => page
    })).rejects.toThrow(/changed on disk/);
    expect(page.uploads.size).toBe(0);
    expect(rendered).toHaveLength(0);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    database.close();

    // A file that changes after the run started stops the submission before the click.
    const second = disposableDatabase();
    const secondDir = disposableDataDir();
    const secondJob = approvedJobId(second);
    setApplicationType(second, secondJob, "HANDSHAKE_INTERNAL");
    graduationFacts(second);
    const clean = storeBaseResume({ channel: "handshake_internal", label: "Handshake", originalName: "h.pdf", bytes: PDF_BYTES }, { database: second, dataDir: secondDir });
    const started = await startBrowserRun(secondJob, "https://app.joinhandshake.com/apply/900001", {
      database: second, dataDir: secondDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => fakePage({ controls: FILE_CONTROLS })
    });
    expect(started.run.baseResumeId).toBe(clean.id);
    appendFileSync(baseResumeFilePath(secondDir, clean.fileName), "tampered");
    approveRunSubmission(started.run.id, undefined, { database: second });
    const submittedFlag = { clicked: false };
    await expect(submitBrowserRun(started.run.id, {
      database: second, dataDir: secondDir, openPage: async () => fakePage({ controls: FILE_CONTROLS, submitted: submittedFlag })
    })).rejects.toThrow(/changed on disk/);
    expect(submittedFlag.clicked).toBe(false);
    second.close();
  });

  it("refuses to send an uploaded resume replaced after the run started", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const url = "https://boards.greenhouse.io/example/jobs/1";
    const first = storeBaseResume({ channel: "default", label: "Resume A", originalName: "a.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const started = await startBrowserRun(jobId, url, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => fakePage({ controls: FILE_CONTROLS, url, title: "Example" })
    });
    expect(started.run.baseResumeId).toBe(first.id);
    storeBaseResume({ channel: "default", label: "Resume B", originalName: "b.pdf", bytes: new TextEncoder().encode("%PDF-1.7\n% newer\n%%EOF\n") }, { database, dataDir });
    confirmRunAts(started.run.id, "greenhouse", { database });
    approveRunSubmission(started.run.id, undefined, { database });
    const submittedFlag = { clicked: false };
    await expect(submitBrowserRun(started.run.id, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url, title: "Example", submitted: submittedFlag })
    })).rejects.toThrow(/replaced by a newer upload/);
    expect(submittedFlag.clicked).toBe(false);
    database.close();
  });

  it("rejects non-PDF base resumes", () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    seedDevelopmentData(database);
    expect(() => storeBaseResume({
      channel: "default",
      label: "Resume",
      originalName: "resume.md",
      bytes: new TextEncoder().encode("# Resume")
    }, { database, dataDir })).toThrow(/PDF/);
    database.close();
  });

  it("stops before changing anything when Handshake is signed out", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir, openPage: async () => fakePage({ url: "https://app.joinhandshake.com/login" })
    })).rejects.toThrow(/signed out/);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    expect(getHandshakeSession(database)?.status).toBe("signed_out");
    database.close();
  });

  /** A stand-in window that walks through URLs, then is closed by the candidate. */
  function scriptedWindow(visited: string[]) {
    let step = 0;
    let closedByAgent = false;
    const window: SessionWindow = {
      urls: () => [visited[Math.min(step, visited.length - 1)]!],
      isClosed: () => step++ >= visited.length,
      close: async () => { closedByAgent = true; }
    };
    return { window, closedByAgent: () => closedByAgent };
  }

  it("keeps the window open through sign-in and records the page it was closed on", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const scripted = scriptedWindow([
      "https://app.joinhandshake.com/login",
      "https://app.joinhandshake.com/access",
      "https://auth.example.edu/cas/login",
      "https://app.joinhandshake.com/explore"
    ]);
    const session = await connectHandshake({ database, dataDir, pollMs: 1, openWindow: async () => scripted.window });
    expect(session.status).toBe("connected");
    // The candidate closed the window; the agent never closed it early.
    expect(scripted.closedByAgent()).toBe(false);
    database.close();
  });

  it("records signed out when the window is closed on Handshake's sign-in page", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    // A signed-out /login lands on /access, which must not read as signed in.
    const scripted = scriptedWindow(["https://app.joinhandshake.com/login", "https://app.joinhandshake.com/access?ref=x"]);
    const session = await connectHandshake({ database, dataDir, pollMs: 1, openWindow: async () => scripted.window });
    expect(session.status).toBe("signed_out");
    database.close();
  });

  it("closes the window itself only when the sign-in times out", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    let closed = false;
    const window: SessionWindow = {
      urls: () => ["https://app.joinhandshake.com/access"],
      isClosed: () => closed,
      close: async () => { closed = true; }
    };
    const session = await connectHandshake({ database, dataDir, pollMs: 1, timeoutMs: 20, openWindow: async () => window });
    expect(closed).toBe(true);
    expect(session.status).toBe("signed_out");
    expect(session.detail).toContain("timed out");
    database.close();
  });
});

describe("transcript applications", () => {
  const TRANSCRIPT_CONTROLS: RawControl[] = [
    { tag: "input", type: "text", id: "grad", label: "What is your expected graduation date?", required: true },
    { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
    { tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true },
    { tag: "button", label: "Submit application" }
  ];
  const EXTERNAL_URL = "https://boards.greenhouse.io/example/jobs/2";
  const externalPage = (controls: RawControl[]) => fakePage({ controls, url: EXTERNAL_URL, title: "Example" });

  function externalJob(database: DatabaseSync): string {
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    graduationFacts(database);
    return jobId;
  }

  it("uses the uploaded 2029 resume, the transcript, and 2029 answers when a form asks for a transcript", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = externalJob(database);
    storeBaseResume({ channel: "default", label: "2028", originalName: "d.pdf", bytes: new TextEncoder().encode("%PDF-1.7\n% default\n%%EOF\n") }, { database, dataDir });
    const resume = storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: "r.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const staged = baseResumeUploadPath(dataDir, jobId, resume.id, "r.pdf");
    const transcript = storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const rendered: string[] = [];
    const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 1 }; };
    const page = externalPage(TRANSCRIPT_CONTROLS);

    const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf, openPage: async () => page });
    expect(started.run.baseResumeId).toBe(resume.id);
    expect(started.run.applicationProfile).toBe("transcript");
    expect(page.uploads.get("resume")).toBe(staged);
    expect(page.uploads.get("transcript")).toBe(candidateDocumentFilePath(dataDir, transcript.fileName));
    expect(page.filled.get("grad")).toBe("2029-05-15");
    expect(rendered).toHaveLength(0);

    approveRunSubmission(started.run.id, undefined, { database });
    confirmRunAts(started.run.id, "greenhouse", { database });
    const submitPage = externalPage(TRANSCRIPT_CONTROLS);
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: async () => submitPage });
    expect(submitted.status).toBe("submitted");
    expect(submitPage.uploads.get("transcript")).toBe(candidateDocumentFilePath(dataDir, transcript.fileName));
    expect(submitPage.uploads.get("resume")).toBe(staged);
    expect(rendered).toHaveLength(0);
    database.close();
  });

  it("prints the tailored resume with 2029 when a form asks for a transcript and no 2029 resume is uploaded", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = externalJob(database);
    storeBaseResume({ channel: "default", label: "2028", originalName: "d.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const transcript = storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const rendered: string[] = [];
    const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 1 }; };
    const page = externalPage(TRANSCRIPT_CONTROLS);

    const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf, openPage: async () => page });
    expect(started.run.baseResumeId).toBe(null);
    expect(page.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);
    expect(page.uploads.get("transcript")).toBe(candidateDocumentFilePath(dataDir, transcript.fileName));
    expect(page.filled.get("grad")).toBe("2029-05-15");
    expect(rendered).toHaveLength(1);

    approveRunSubmission(started.run.id, undefined, { database });
    confirmRunAts(started.run.id, "greenhouse", { database });
    const submitPage = externalPage(TRANSCRIPT_CONTROLS);
    const submitted = await submitBrowserRun(started.run.id, { database, dataDir, renderPdf, openPage: async () => submitPage });
    expect(submitted.status).toBe("submitted");
    expect(submitPage.uploads.get("transcript")).toBe(candidateDocumentFilePath(dataDir, transcript.fileName));
    expect(submitPage.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);
    database.close();
  });

  it("keeps the default profile when the form does not ask for a transcript", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = externalJob(database);
    storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: "r.pdf", bytes: PDF_BYTES }, { database, dataDir });
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const controls = TRANSCRIPT_CONTROLS.filter((control) => control.id !== "transcript");
    const page = externalPage(controls);
    const started = await startBrowserRun(jobId, EXTERNAL_URL, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => page
    });
    expect(started.run.baseResumeId).toBe(null);
    expect(page.filled.get("grad")).toBe("2028-05-15");
    expect(page.uploads.get("resume")?.endsWith(".pdf")).toBe(true);
    expect(page.uploads.has("transcript")).toBe(false);
    database.close();
  });

  it("stops before changing anything when the transcript or the 2029 graduation date is missing", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    graduationFacts(database, false);
    await expect(startBrowserRun(jobId, EXTERNAL_URL, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => externalPage(TRANSCRIPT_CONTROLS)
    })).rejects.toThrow(/asks for your transcript/);
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    await expect(startBrowserRun(jobId, EXTERNAL_URL, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => externalPage(TRANSCRIPT_CONTROLS)
    })).rejects.toThrow(/no 2029 graduation date/);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    database.close();
  });

  it("refuses a changed transcript file and typed answers for upload pauses", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = externalJob(database);
    storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: "r.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const transcript = storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    appendFileSync(candidateDocumentFilePath(dataDir, transcript.fileName), "tampered");
    await expect(startBrowserRun(jobId, EXTERNAL_URL, {
      database, dataDir, openPage: async () => externalPage(TRANSCRIPT_CONTROLS)
    })).rejects.toThrow(/changed on disk/);

    const coverControls: RawControl[] = [
      { tag: "input", type: "file", id: "cover", label: "Cover letter", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const started = await startBrowserRun(jobId, EXTERNAL_URL, {
      database, dataDir, openPage: async () => externalPage(coverControls)
    });
    expect(started.run.status).toBe("paused-needs-input");
    await expect(answerRunPause(started.run.id, "cover", "Dear team…", false, { database })).rejects.toThrow(/needs a document/);
    database.close();
  });
});

describe("education block", () => {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const EDUCATION_CONTROLS: RawControl[] = [
    { tag: "select", id: "school--0", label: "School", required: true, options: ["Example State University", "Other"] },
    { tag: "select", id: "degree--0", label: "Degree", required: true, options: ["Bachelor's Degree", "Master's Degree"] },
    { tag: "select", id: "end-month--0", label: "End date month", required: true, options: MONTHS },
    { tag: "input", type: "number", id: "end-year--0", label: "End date year", required: true },
    { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
    { tag: "button", label: "Submit application" }
  ];
  const TRANSCRIPT: RawControl = { tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true };
  const EXTERNAL_URL = "https://job-boards.greenhouse.io/example/jobs/3";
  const externalPage = (controls: RawControl[]) => fakePage({ controls, url: EXTERNAL_URL, title: "Example" });

  function educationJob(database: DatabaseSync, alternate = true): string {
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    saveCandidate(database, LOCAL_CANDIDATE_ID, {
      fullName: "Jordan Rivera", school: "Example State University", degree: "B.S. Computer Science",
      graduationDate: "2027-05-15", educationStartMonth: "2024-08"
    });
    graduationFacts(database, alternate);
    return jobId;
  }

  it("fills the end month and year from the default profile's graduation answer, not the profile's own date", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = educationJob(database);
    const page = externalPage(EDUCATION_CONTROLS);
    const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => page });
    expect(started.run.applicationProfile).toBe("default");
    expect(page.filled.get("school--0")).toBe("Example State University");
    expect(page.filled.get("degree--0")).toBe("Bachelor's Degree");
    expect(page.filled.get("end-month--0")).toBe("May");
    expect(page.filled.get("end-year--0")).toBe("2028");
    const endYear = started.run.decisions.find((decision) => decision.fieldId === "end-year--0");
    expect(endYear?.basis).toEqual({ kind: "fact", key: "graduation_date", scope: "global" });
    database.close();
  });

  it("uses the transcript profile's 2029 answer on a form that asks for a transcript", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = educationJob(database);
    storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: "r.pdf", bytes: PDF_BYTES }, { database, dataDir });
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const page = externalPage([...EDUCATION_CONTROLS, TRANSCRIPT]);
    const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => page });
    expect(started.run.applicationProfile).toBe("transcript");
    expect(page.filled.get("end-month--0")).toBe("May");
    expect(page.filled.get("end-year--0")).toBe("2029");
    const endYear = started.run.decisions.find((decision) => decision.fieldId === "end-year--0");
    expect(endYear?.basis).toEqual({ kind: "fact", key: "graduation_date", scope: "channel:handshake_internal" });
    database.close();
  });

  it("pauses the end month and year on the transcript profile with no 2029 answer, never using 2028", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = educationJob(database, false);
    storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: "r.pdf", bytes: PDF_BYTES }, { database, dataDir });
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const page = externalPage([...EDUCATION_CONTROLS, TRANSCRIPT]);
    const started = await startBrowserRun(jobId, EXTERNAL_URL, { database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => page });
    expect(started.run.applicationProfile).toBe("transcript");
    const action = (id: string) => started.run.decisions.find((decision) => decision.fieldId === id)?.action;
    expect(action("end-month--0")).toBe("pause");
    expect(action("end-year--0")).toBe("pause");
    expect(page.filled.has("end-month--0")).toBe(false);
    expect(page.filled.has("end-year--0")).toBe(false);
    expect([...page.filled.values()]).not.toContain("2028");
    database.close();
  });
});

describe("Handshake Quick apply dialog", () => {
  const RESUME_NAME = "Jordan Rivera - Resume.pdf";
  const DIALOG_CONTROLS: RawControl[] = [{ tag: "button", label: "Submit Application" }];

  /** A Handshake job page whose Quick apply dialog shows the given attachments. */
  function quickApplyPage(options: { attached?: string[]; hasQuickApply?: boolean; submitted?: { clicked: boolean } } = {}) {
    const page = fakePage({ controls: DIALOG_CONTROLS, submitted: options.submitted, body: "Job page. Order confirmation emails vary." });
    let opened = false;
    return Object.assign(page, {
      openApplicationDialog: async () => {
        if (options.hasQuickApply === false) return false;
        opened = true;
        return true;
      },
      attachedDocumentNames: async () => (opened ? options.attached ?? [] : []),
      dialogOpened: () => opened
    });
  }

  function handshakeJob(database: DatabaseSync, dataDir: string) {
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    storeBaseResume({ channel: "handshake_internal", label: "2029", originalName: RESUME_NAME, bytes: PDF_BYTES }, { database, dataDir });
    return jobId;
  }

  it("opens the dialog and keeps the attached resume only after the candidate confirms it is current", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = handshakeJob(database, dataDir);
    const page = quickApplyPage({ attached: ["Anything I put on Handshake.pdf"] });
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/jobs/900001", { database, dataDir, openPage: async () => page });
    expect(page.dialogOpened()).toBe(true);
    expect(started.run.baseResumeId).toBe(null);
    expect(started.run.status).toBe("paused-needs-input");
    expect(started.run.pauses).toContainEqual(expect.objectContaining({
      fieldId: "handshake-attached-resume", status: "open", question: expect.stringContaining("Is it your current resume?")
    }));
    expect(started.run.decisions).toContainEqual(expect.objectContaining({ fieldId: "handshake-attached-resume", action: "keep", value: "Anything I put on Handshake.pdf" }));
    expect(page.uploads.size).toBe(0);
    expect(() => approveRunSubmission(started.run.id, undefined, { database })).toThrow(/awaiting approval/);
    await expect(answerRunPause(started.run.id, "handshake-attached-resume", "no", false, { database })).rejects.toThrow(/update your resume on Handshake/i);
    await answerRunPause(started.run.id, "handshake-attached-resume", "yes", false, { database });
    // A different attachment while the run waited is refused on continue.
    await expect(continueBrowserRun(started.run.id, {
      database, dataDir, openPage: async () => quickApplyPage({ attached: ["Other.pdf"] })
    })).rejects.toThrow(/changed since you confirmed/);
    const continued = await continueBrowserRun(started.run.id, {
      database, dataDir, openPage: async () => quickApplyPage({ attached: ["Anything I put on Handshake.pdf"] })
    });
    expect(continued.run.status).toBe("awaiting-approval");

    approveRunSubmission(started.run.id, undefined, { database });
    const submittedFlag = { clicked: false };
    const submitted = await submitBrowserRun(started.run.id, {
      database, dataDir, openPage: async () => quickApplyPage({ attached: ["Anything I put on Handshake.pdf"], submitted: submittedFlag })
    });
    expect(submittedFlag.clicked).toBe(true);
    expect(submitted.status).toBe("submitted");
    database.close();
  });

  it("stops when there is no Quick apply button", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = handshakeJob(database, dataDir);
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/jobs/900001", {
      database, dataDir, openPage: async () => quickApplyPage({ hasQuickApply: false })
    })).rejects.toThrow(/no Quick apply button/);
    expect(jobStatus(database, jobId)).toBe("APPROVED");
    database.close();
  });

  it("refuses to submit when the attachment changed after approval, without failing the run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = handshakeJob(database, dataDir);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/jobs/900001", {
      database, dataDir, openPage: async () => quickApplyPage({ attached: [RESUME_NAME] })
    });
    await answerRunPause(started.run.id, "handshake-attached-resume", "yes", false, { database });
    await continueBrowserRun(started.run.id, { database, dataDir, openPage: async () => quickApplyPage({ attached: [RESUME_NAME] }) });
    approveRunSubmission(started.run.id, undefined, { database });
    const submittedFlag = { clicked: false };
    await expect(submitBrowserRun(started.run.id, {
      database, dataDir, openPage: async () => quickApplyPage({ attached: ["Other.pdf"], submitted: submittedFlag })
    })).rejects.toThrow(/changed since you confirmed/);
    expect(submittedFlag.clicked).toBe(false);
    const run = database.prepare("SELECT status FROM browser_runs WHERE id = ?").get(started.run.id) as { status: string };
    expect(run.status).toBe("awaiting-approval");
    database.close();
  });
});

describe("resume variant usage", () => {
  it("labels which resume each application actually sends", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const [newest] = getResumeVariantUsage(jobId, database);
    expect(newest).toMatchObject({ used: true, label: expect.stringContaining("Will be uploaded") });

    database.prepare("UPDATE jobs SET status = 'QUALIFIED' WHERE id = ?").run(jobId);
    prepareApplication(jobId, { database });
    approveApplication(jobId, { database });
    const twice = getResumeVariantUsage(jobId, database);
    expect(twice.map((use) => use.label)).toEqual([expect.stringContaining("Will be uploaded"), "Earlier preparation, not used"]);

    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    expect(getResumeVariantUsage(jobId, database)[0]?.label).toBe("Printed with your 2029 graduation date if Handshake asks for an upload; Quick Apply keeps your Handshake resume once you confirm it");

    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const started = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/1", {
      database, dataDir, renderPdf: async () => ({ pages: 1 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url: "https://boards.greenhouse.io/example/jobs/1", title: "Example" })
    });
    expect(getResumeVariantUsage(jobId, database)[0]?.label).toBe("Used by the current browser run");
    approveRunSubmission(started.run.id, undefined, { database });
    confirmRunAts(started.run.id, "greenhouse", { database });
    await submitBrowserRun(started.run.id, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url: "https://boards.greenhouse.io/example/jobs/1", title: "Example" })
    });
    expect(getResumeVariantUsage(jobId, database)[0]).toMatchObject({ used: true, label: "Uploaded with the submitted application" });
    database.close();
  });

  it("labels a Handshake Apply run's variant as used and prints any variant on request", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    graduationFacts(database);
    await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => fakePage({ controls: FILE_CONTROLS })
    });
    const [use] = getResumeVariantUsage(jobId, database);
    expect(use).toMatchObject({ used: true, label: "Used by the current browser run" });

    let printedHtml = "";
    const printed = await printResumeVariant(database, dataDir, jobId, use!.variantId, async (html) => { printedHtml = html; return { pages: 1 }; });
    expect(printed?.path).toContain(`resume-${use!.variantId}.pdf`);
    expect(printedHtml).toContain("<h2>Professional Experience</h2>");
    database.close();
  });

  it("labels the variant as not used when an uploaded resume goes instead", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: PDF_BYTES }, { database, dataDir });
    expect(getResumeVariantUsage(jobId, database)[0]).toEqual(expect.objectContaining({
      used: false,
      label: 'Not used: this application will send your uploaded resume "Resume (Expected May 2028)" (the tailored resume printed with your 2029 graduation date if the form asks for a transcript)'
    }));

    setApplicationType(database, jobId, "HANDSHAKE_INTERNAL");
    expect(getResumeVariantUsage(jobId, database)[0]?.label).toBe("Printed with your 2029 graduation date if Handshake asks for an upload; Quick Apply keeps your Handshake resume once you confirm it");
    storeBaseResume({ channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: PDF_BYTES }, { database, dataDir });
    expect(getResumeVariantUsage(jobId, database)[0]).toEqual(expect.objectContaining({
      used: false,
      label: 'Not used: Handshake uploads send your uploaded 2029 resume "Resume (Expected May 2029)"; Quick Apply keeps your Handshake resume once you confirm it'
    }));

    setApplicationType(database, jobId, "EXTERNAL_ATS");
    expect(getResumeVariantUsage(jobId, database)[0]?.label).toBe(
      'Not used: this application will send your uploaded resume "Resume (Expected May 2028)" (or your uploaded 2029 resume "Resume (Expected May 2029)" if the form asks for a transcript)'
    );

    const url = "https://boards.greenhouse.io/example/jobs/1";
    const started = await startBrowserRun(jobId, url, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url, title: "Example" })
    });
    expect(getResumeVariantUsage(jobId, database)[0]).toEqual(expect.objectContaining({
      used: false, label: 'Not used: this application sends your uploaded resume "Resume (Expected May 2028)"'
    }));
    approveRunSubmission(started.run.id, undefined, { database });
    confirmRunAts(started.run.id, "greenhouse", { database });
    await submitBrowserRun(started.run.id, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }),
      openPage: async () => fakePage({ controls: FILE_CONTROLS, url, title: "Example" })
    });
    expect(getResumeVariantUsage(jobId, database)[0]).toEqual(expect.objectContaining({
      used: false, label: 'Not used: this application sent your uploaded resume "Resume (Expected May 2028)"'
    }));
    database.close();
  });
});

describe("retrying a browser run", () => {
  it("allows a new run after a failed one and never after a submission", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    // An open run blocks a second one.
    expect(canStartBrowserRun(jobId, database)).toBe(false);
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() }))
      .rejects.toThrow(/still open/);

    // A submit whose confirmation never arrives fails the run; the job stays APPLYING.
    approveRunSubmission(started.run.id, undefined, { database });
    database.prepare("UPDATE browser_runs SET status = 'failed' WHERE id = ?").run(started.run.id);
    expect(jobStatus(database, jobId)).toBe("APPLYING");
    expect(canStartBrowserRun(jobId, database)).toBe(true);
    const retried = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    const restarted = database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(jobId) as { detail: string };
    expect(restarted.detail).toContain("restarted");

    approveRunSubmission(retried.run.id, undefined, { database });
    await submitBrowserRun(retried.run.id, { database, dataDir, openPage: async () => fakePage() });
    database.prepare("UPDATE jobs SET status = 'APPLYING' WHERE id = ?").run(jobId);
    expect(canStartBrowserRun(jobId, database)).toBe(false);
    await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() }))
      .rejects.toThrow(/already has a submitted run/);
    database.close();
  });

  describe("automatic pipeline", () => {
    const on = { minFit: 0, autoApply: true };
    const statusOf = (database: DatabaseSync, jobId: string) =>
      (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;

    it("reads its settings from the environment with safe defaults", () => {
      expect(pipelineSettings({})).toEqual({ minFit: 0, autoApply: false });
      expect(pipelineSettings({ INTERNSHIP_AGENT_PREPARE_MIN_FIT: "45", INTERNSHIP_AGENT_AUTO_APPLY: "1" })).toEqual({ minFit: 45, autoApply: true });
      expect(pipelineSettings({ INTERNSHIP_AGENT_PREPARE_MIN_FIT: "abc", INTERNSHIP_AGENT_AUTO_APPLY: "yes" })).toEqual({ minFit: 0, autoApply: false });
    });

    it("prepares and fills a qualified posting, then stops at the submit approval", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const submittedFlag = { clicked: false };
      const opened: string[] = [];
      const report = await advancePipeline({
        database, dataDir, settings: on,
        openPage: (async (url: string) => { opened.push(url); return fakePage({ submitted: submittedFlag }); }) as (url: string) => Promise<BrowserPage>
      });
      expect(report.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
      expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      expect(opened).toHaveLength(1);
      expect(submittedFlag.clicked).toBe(false);
      expect(statusOf(database, jobId)).toBe("APPLYING");
      // No package approval is recorded on the candidate's behalf.
      const statuses = (database.prepare("SELECT to_status FROM application_events WHERE job_id = ?").all(jobId) as Array<{ to_status: string }>).map((row) => row.to_status);
      expect(statuses).not.toContain("APPROVED");
      expect(getReviewQueue(database).find((entry) => entry.jobId === jobId)).toMatchObject({ status: "APPLYING", runStatus: "awaiting-approval" });

      const runId = report.started.length ? (database.prepare("SELECT id FROM browser_runs WHERE job_id = ?").get(jobId) as { id: string }).id : "";
      await expect(submitBrowserRun(runId, { database, dataDir, openPage: (async () => fakePage()) as () => Promise<BrowserPage> }))
        .rejects.toThrow("explicit human approval");
      approveRunSubmission(runId, undefined, { database });
      const submitted = await submitBrowserRun(runId, { database, dataDir, openPage: (async () => fakePage({ submitted: submittedFlag })) as () => Promise<BrowserPage> });
      expect(submitted.status).toBe("submitted");
      expect(submittedFlag.clicked).toBe(true);
      database.close();
    });

    it("analyzes a posting an interrupted run left unanalyzed, then prepares it", async () => {
      const database = disposableDatabase();
      const jobId = approvedJobId(database, "ingested");
      expect(statusOf(database, jobId)).toBe("DISCOVERED");
      const report = await advancePipeline({
        database, dataDir: disposableDataDir(), settings: { minFit: 0, autoApply: false }
      });
      expect(report.analyzed).toEqual([jobId]);
      expect(report.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      database.close();
    });

    it("only prepares when auto-apply is off", async () => {
      const database = disposableDatabase();
      const jobId = approvedJobId(database, "qualified");
      const report = await advancePipeline({
        database, dataDir: disposableDataDir(), settings: { minFit: 0, autoApply: false },
        openPage: async () => { throw new Error("must not open a browser"); }
      });
      expect(report.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
      expect(report.started).toEqual([]);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      database.close();
    });

    it("does not start an automatic run on rule-labelled requirements", async () => {
      const database = disposableDatabase();
      const jobId = approvedJobId(database, "qualified");
      database.prepare("UPDATE job_requirements SET extraction = 'DETERMINISTIC' WHERE job_id = ?").run(jobId);
      const report = await advancePipeline({
        database, dataDir: disposableDataDir(), settings: on,
        openPage: async () => { throw new Error("must not open a browser"); }
      });
      expect(report.prepared.map((entry) => entry.jobId)).toContain(jobId);
      expect(report.started).toEqual([]);
      expect(report.errors.some((error) => error.includes("its requirement labels came from rules, not the AI"))).toBe(true);
      database.close();
    });

    it("neither prepares nor runs a held qualified posting until its AI labels arrive", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const snapshot = database.prepare("SELECT id FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL").get(jobId) as { id: string };
      holdRequirementLabels(database, { jobId, snapshotId: snapshot.id, reason: "AI requirement labels unavailable; will retry (fixture)." });
      const failing: ModelProvider = {
        available: true,
        async complete() { throw new Error("fetch failed"); }
      };
      const held = await advancePipeline({
        database, dataDir, settings: on, labelProvider: failing,
        openPage: async () => { throw new Error("must not open a browser"); }
      });
      expect(held.prepared).toEqual([]);
      expect(held.started).toEqual([]);
      expect(statusOf(database, jobId)).toBe("QUALIFIED");
      expect(getRequirementLabelHold(database, jobId)?.attempts).toBe(2);

      const labelling: ModelProvider = {
        available: true,
        async complete<T>(request: StructuredRequest<T>) {
          const decisions = [...request.input.matchAll(/^(\d+)\. /gm)].map((line) => ({
            index: Number(line[1]), category: "PREFERRED", subject: "SKILL", assertion: "STATED", confidence: 0.9
          }));
          return { value: request.schema.parse({ decisions }), model: "fake", inputTokens: 1, outputTokens: 1, reasoningTokens: 0, durationMs: 1 };
        }
      };
      const labelled = await advancePipeline({
        database, dataDir, settings: on, labelProvider: labelling,
        openPage: (async () => fakePage()) as () => Promise<BrowserPage>
      });
      expect(getRequirementLabelHold(database, jobId)).toBeNull();
      expect(labelled.analyzed).toContain(jobId);
      expect(labelled.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
      expect(labelled.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      database.close();
    });

    it.each([
      ["a sign-in page", [
        { tag: "input", type: "email", id: "email", label: "Email address", required: true },
        { tag: "input", type: "password", id: "password", label: "Password", required: true },
        { tag: "button", label: "Sign In" }
      ] as RawControl[], "sign in"],
      ["a page without a form", [{ tag: "button", label: "Apply" }] as RawControl[], "No application form"]
    ])("stops once on %s and leaves the package for the candidate", async (_name, controls, message) => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const page = fakePage({ controls });
      const first = await advancePipeline({ database, dataDir, settings: on, openPage: async () => page });
      expect(first.stopped).toHaveLength(1);
      expect(first.stopped[0]!.reason).toContain(message);
      expect(page.filled.size).toBe(0);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      const second = await advancePipeline({
        database, dataDir, settings: on,
        openPage: async () => { throw new Error("must not retry an automatic run"); }
      });
      expect(second.started).toEqual([]);
      expect(second.stopped).toEqual([]);
      database.close();
    });

    it("holds Workday applications without opening a browser until the site is connected, then runs them", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      prepareApplication(jobId, { database });
      database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?")
        .run("https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1", jobId);
      const noBrowser = async () => { throw new Error("no browser should open for Workday"); };
      const first = await advancePipeline({ database, dataDir, settings: on, openPage: noBrowser });
      expect(first.started).toEqual([]);
      expect(first.waiting).toEqual([{ jobId, siteKey: "workday:ngc.wd1.myworkdayjobs.com/External", reason: "workday-sign-in" }]);
      saveBrowserSession(database, { site: "workday:ngc.wd1.myworkdayjobs.com/External", status: "connected", detail: "Signed in.", checkedAt: new Date().toISOString() });
      // Once connected, the pipeline opens the site (here the stub refuses, so the attempt is a retryable failure).
      const second = await advancePipeline({ database, dataDir, settings: on, openPage: noBrowser });
      expect(second.waiting).toEqual([]);
      expect(second.stopped).toEqual([{ jobId, reason: "no browser should open for Workday" }]);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      database.close();
    });

    it("retries a stopped application only when asked", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const noForm = fakePage({ controls: [{ tag: "button", label: "Apply" }] });
      expect((await advancePipeline({ database, dataDir, settings: on, openPage: async () => noForm })).stopped).toHaveLength(1);
      const skipped = await advancePipeline({ database, dataDir, settings: on, openPage: async () => { throw new Error("must not reopen"); } });
      expect(skipped.started).toEqual([]);
      const retried = await advancePipeline({ database, dataDir, settings: on, retryStopped: true, openPage: async () => fakePage() });
      expect(retried.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      database.close();
    });

    it("retries an unexpected failure on the next pass", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const first = await advancePipeline({
        database, dataDir, settings: on,
        openPage: async () => { throw new Error("locator.evaluate: ReferenceError: __name is not defined"); }
      });
      expect(first.stopped).toHaveLength(1);
      expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
      const events = database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>;
      expect(events.some((event) => event.detail?.startsWith("Automatic browser run failed: locator.evaluate"))).toBe(true);

      const second = await advancePipeline({ database, dataDir, settings: on, openPage: async () => fakePage() });
      expect(second.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      database.close();
    });

    it("refuses an automatic start outside a verified, unapproved package and a manual start before approval", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      prepareApplication(jobId, { database });
      await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
        database, dataDir, openPage: async () => fakePage()
      })).rejects.toThrow("approved packages");
      database.prepare("UPDATE jobs SET status = 'NEEDS_INPUT' WHERE id = ?").run(jobId);
      await expect(startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
        database, dataDir, automatic: true, openPage: async () => fakePage()
      })).rejects.toThrow("approved packages");
      database.close();
    });
  });

  describe("automatic submission", () => {
    const target = { season: "summer", year: 2027 } as const;
    const policy = (dailyCap = 5) => ({ minFit: 0, autoApply: true, target, autoSubmit: { minFit: 80, dailyCap } });
    const unlimitedPolicy = () => pipelineSettings({
      INTERNSHIP_AGENT_AUTO_APPLY: "1",
      INTERNSHIP_AGENT_AUTO_SUBMIT: "1",
      INTERNSHIP_AGENT_TARGET_TERM: "summer-2027",
      INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT: "80",
      INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP: "unlimited"
    });
    const strongFit = (database: DatabaseSync, jobId: string, score = 86, rating: "STRONG" | "MODERATE" = "STRONG") =>
      saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
        score, rating, confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
        decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
      });
    const details = (database: DatabaseSync, jobId: string) =>
      (database.prepare("SELECT detail, to_status FROM application_events WHERE job_id = ? ORDER BY created_at").all(jobId) as Array<{ detail: string | null; to_status: string }>);

    it("reads the target and policy from the environment, and needs a target to submit", () => {
      const env = { INTERNSHIP_AGENT_AUTO_APPLY: "1", INTERNSHIP_AGENT_AUTO_SUBMIT: "1" };
      expect(pipelineSettings(env)).toEqual({ minFit: 0, autoApply: true });
      expect(pipelineSettings({ ...env, INTERNSHIP_AGENT_TARGET_TERM: "summer-2027" }))
        .toEqual({ minFit: 0, autoApply: true, target, autoSubmit: { minFit: 50, dailyCap: 10 } });
      expect(pipelineSettings({ ...env, INTERNSHIP_AGENT_TARGET_TERM: "summer-2027", INTERNSHIP_AGENT_MANUAL_ONLY: "1" }).autoSubmit).toBeUndefined();
    });

    it("submits a clean, on-target run and records the policy's approval, never the candidate's", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const flag = { clicked: false };
      const report = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: async () => fakePage({ submitted: flag }) });
      expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
      expect(report.held).toEqual([]);
      expect(flag.clicked).toBe(true);
      expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("SUBMITTED");
      const events = details(database, jobId);
      expect(events.some((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT + ": summer 2027 term, software or adjacent role, US location, AI fit 86"))).toBe(true);
      expect(events.map((event) => event.to_status)).not.toContain("APPROVED");
      database.close();
    });

    it("never takes a Phenom-shaped several-page form that mentions Workday for Workday, never approves or clicks it (Track 38)", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      setApplicationType(database, jobId, "EXTERNAL_ATS");
      strongFit(database, jobId);
      const flag = { clicked: false };
      const pages: Array<ReturnType<typeof fakePage>> = [];
      const report = await advancePipeline({
        database, dataDir, settings: policy(), voiceDrafter: null,
        openPage: async () => {
          const page = fakePage({
            url: PHENOM_STEPS_URL,
            title: "Applying for a job | Fixture Labs Careers",
            body: "My Information\nMy experience\nApplication Questions\nReview\nFor Fixture Labs internal employees, please submit your application internally directly through Workday.\nNext",
            // Fields the fixture's saved facts answer, so only the classification decides (before Track 38 it was submitted).
            controls: [
              { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
              { tag: "input", type: "text", id: "q2", label: "Favorite color?", required: false },
              { tag: "button", label: "Next" }
            ],
            submitted: flag
          });
          pages.push(page);
          return Object.assign(page, { stepButtons: async () => ({ submit: false, next: "Next" }) });
        }
      });
      expect(report.submitted).toEqual([]);
      expect(flag.clicked).toBe(false);
      expect(pages.every((page) => page.filled.size === 0)).toBe(true);
      expect(getBrowserRuns(jobId, database)).toEqual([]);
      expect(report.stopped).toEqual([{ jobId, reason: expect.stringContaining("continues over several pages") }]);
      expect(details(database, jobId).some((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT))).toBe(false);
      database.close();
    });

    it("holds an auto-submit whose page is not on the recognized kind's own site, typing and clicking nothing (Track 38)", async () => {
      const GREENHOUSE_URL = "https://job-boards.greenhouse.io/fixturelabs/jobs/1";
      const greenhouse = () => fakePage({ url: GREENHOUSE_URL, title: "Job Application for Intern at Fixture Labs", body: "Powered by Greenhouse" });
      for (const onSite of [false, true]) {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const jobId = approvedJobId(database, "qualified");
        strongFit(database, jobId);
        const flag = { clicked: false };
        const submitPage = fakePage({ url: onSite ? GREENHOUSE_URL : "https://careers.fixturelabs.example/apply", submitted: flag });
        let opens = 0;
        const report = await advancePipeline({
          database, dataDir, settings: policy(), voiceDrafter: null,
          openPage: async () => { opens += 1; return opens === 1 ? greenhouse() : submitPage; }
        });
        const run = getBrowserRuns(jobId, database)[0]!;
        // The run is recognized on Greenhouse's own page, but its recorded address is the posting's, off Greenhouse's site.
        expect(run.atsKind).toBe("greenhouse");
        if (onSite) {
          // Positive control: the same run submitted through Greenhouse's own page is sent.
          expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
          expect(flag.clicked).toBe(true);
        } else {
          expect(report.submitted).toEqual([]);
          expect(report.held).toEqual([{ jobId, reasons: [expect.stringContaining("is not on Greenhouse's own site")] }]);
          expect(flag.clicked).toBe(false);
          expect(submitPage.filled.size).toBe(0);
          expect(run.status).toBe("paused-needs-input");
          expect(run.submissionApprovedAt).toBeNull();
          expect(run.pauses).toEqual(expect.arrayContaining([expect.objectContaining({ fieldId: SUBMIT_TARGET_FIELD, safeguard: true, status: "open" })]));
          expect(jobStatus(database, jobId)).not.toBe("SUBMITTED");
        }
        database.close();
      }
    });

    it("submits a clean run with the uploaded resume and never prints the tailored one", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const resume = storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "Jordan Rivera Resume.pdf", bytes: PDF_BYTES }, { database, dataDir });
      const rendered: string[] = [];
      const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 2 }; };
      const flag = { clicked: false };
      const pages: Array<ReturnType<typeof fakePage>> = [];
      const report = await advancePipeline({
        database, dataDir, settings: policy(), voiceDrafter: null, renderPdf,
        openPage: async () => { const page = fakePage({ controls: FILE_CONTROLS, submitted: flag }); pages.push(page); return page; }
      });
      expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
      expect(report.held).toEqual([]);
      expect(flag.clicked).toBe(true);
      expect(rendered).toHaveLength(0);
      const run = getBrowserRuns(jobId, database)[0]!;
      expect(run.baseResumeId).toBe(resume.id);
      const staged = baseResumeUploadPath(dataDir, jobId, resume.id, "Jordan Rivera Resume.pdf");
      expect(pages.at(-1)?.uploads.get("resume")).toBe(staged);
      expect(new Uint8Array(readFileSync(staged))).toEqual(PDF_BYTES);
      expect(details(database, jobId).some((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT + ": summer 2027 term"))).toBe(true);
      database.close();
    });

    const lowBar = () => ({ minFit: 0, autoApply: true, target, autoSubmit: { minFit: 50, dailyCap: 5 } });

    it("submits a clean run at a moderate 55 with a bar of 50", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId, 55, "MODERATE");
      const flag = { clicked: false };
      const report = await advancePipeline({ database, dataDir, settings: lowBar(), voiceDrafter: null, openPage: async () => fakePage({ submitted: flag }) });
      expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
      expect(report.held).toEqual([]);
      expect(flag.clicked).toBe(true);
      expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("SUBMITTED");
      expect(details(database, jobId).some((event) => event.detail?.includes("AI fit 55 (moderate, medium confidence) at or above your bar of 50"))).toBe(true);
      database.close();
    });

    it("rules out a moderate 45 with a bar of 50 without preparing or opening it", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId, 45, "MODERATE");
      const noBrowser = async () => { throw new Error("must not open a browser below the skip line"); };
      const report = await advancePipeline({ database, dataDir, settings: lowBar(), voiceDrafter: null, openPage: noBrowser });
      expect(report.prepared).toEqual([]);
      expect(report.started).toEqual([]);
      expect(report.submitted).toEqual([]);
      expect(report.skipped).toEqual([{ jobId, reasons: ["Fit: AI score 45 (moderate) is below the skip line of 50."] }]);
      database.close();
    });

    it.each([
      ["no current AI judgment", null, "Fit: no current AI judgment."],
      ["a moderate AI judgment", 72, "Fit: AI score 72 is below 80."]
    ])("fills but holds a run with %s", async (_name, score, reason) => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      if (score !== null) strongFit(database, jobId, score, "MODERATE");
      const flag = { clicked: false };
      const report = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: async () => fakePage({ submitted: flag }) });
      expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      expect(report.submitted).toEqual([]);
      expect(report.held[0]!.reasons).toContain(reason);
      expect(flag.clicked).toBe(false);
      database.close();
    });

    it("holds a run whose form asked something it could not answer", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const controls: RawControl[] = [
        { tag: "input", type: "text", id: "badge", label: "Name of the employee who referred you", required: true },
        { tag: "button", label: "Submit application" }
      ];
      const report = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: async () => fakePage({ controls }) });
      expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
      expect(report.submitted).toEqual([]);
      expect(report.held[0]!.reasons).toContain("The form has unanswered questions waiting for you.");
      database.close();
    });

    it("rules out an off-target posting without preparing it, and logs it once", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      database.prepare("UPDATE jobs SET title = ? WHERE id = ?").run("Product Manager Intern (Fall 2026)", jobId);
      const noBrowser = async () => { throw new Error("must not open a browser for an off-target posting"); };
      const first = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: noBrowser });
      expect(first.prepared).toEqual([]);
      expect(first.skipped).toEqual([{ jobId, reasons: expect.arrayContaining(["Term: the title names fall, not summer."]) }]);
      const second = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: noBrowser });
      expect(second.skipped).toEqual([]);
      expect(details(database, jobId).filter((event) => event.detail?.startsWith("Not pursued for your target: "))).toHaveLength(1);
      database.close();
    });

    it.each([
      ["a Handshake posting", "https://app.joinhandshake.com/jobs/12345", null, "HANDSHAKE_INTERNAL"],
      ["a list row whose apply link is Handshake", "https://example.com/careers/intern", "https://joinhandshake.com/jobs/12345", "EMPLOYER_SITE"]
    ])("rules out %s even when it is otherwise on target, and logs it once", async (_name, sourceUrl, externalUrl, applicationType) => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      database.prepare("UPDATE jobs SET source_url = ?, external_application_url = ?, application_type = ? WHERE id = ?")
        .run(sourceUrl, externalUrl, applicationType, jobId);
      const noBrowser = async () => { throw new Error("must not open a browser for a Handshake posting"); };
      const first = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: noBrowser });
      expect(first.prepared).toEqual([]);
      expect(first.started).toEqual([]);
      expect(first.submitted).toEqual([]);
      expect(first.skipped).toEqual([{ jobId, reasons: ["Source: Handshake is out of scope (GitHub lists only)."] }]);
      const second = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: noBrowser });
      expect(second.skipped).toEqual([]);
      expect(details(database, jobId).filter((event) => event.detail === "Not pursued for your target: Source: Handshake is out of scope (GitHub lists only)."))
        .toHaveLength(1);
      database.close();
    });

    it("stops at the daily cap", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      logApplicationEvent(database, { jobId, fromStatus: "QUALIFIED", toStatus: "QUALIFIED", detail: AUTO_SUBMIT_EVENT + ": an earlier one today." });
      const report = await advancePipeline({ database, dataDir, settings: policy(1), voiceDrafter: null, openPage: async () => fakePage() });
      expect(report.submitted).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: ["Today's 1 automatic submissions are used up."] }]);
      database.close();
    });

    it("submits exactly once under the unlimited daily policy beyond the old ceiling", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const { jobId: historicalJobId } = persistNormalizedPosting(database, {
        companyName: "Fixture History Company",
        title: "Software Engineering Intern",
        employmentType: "INTERNSHIP",
        applicationType: "UNKNOWN",
        sourceUrl: "https://example.test/internships/approval-history",
        externalApplicationUrl: null,
        companyCareersUrl: null,
        contentHash: "fixture-approval-history",
        normalizedText: "Software Engineering Intern at Fixture History Company.",
        locations: [],
        compensation: null,
        requirements: [],
        technologies: [],
        constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
      });
      database.prepare("UPDATE jobs SET status = 'SUBMITTED' WHERE id = ?").run(historicalJobId);
      for (let approval = 0; approval < 51; approval += 1) {
        logApplicationEvent(database, {
          jobId: historicalJobId,
          fromStatus: "APPLYING",
          toStatus: "APPLYING",
          detail: AUTO_SUBMIT_EVENT + ": a historical approval today."
        });
      }

      const page = fakePage();
      const clickSubmit = vi.spyOn(page, "clickSubmit");
      const report = await advancePipeline({
        database, dataDir, settings: unlimitedPolicy(), voiceDrafter: null, openPage: async () => page
      });
      expect(report.held).toEqual([]);
      expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
      expect(clickSubmit).toHaveBeenCalledTimes(1);
      expect(getJobPosting(database, jobId)?.status).toBe("SUBMITTED");
      expect(details(database, jobId).filter((event) => event.detail?.startsWith(AUTO_SUBMIT_EVENT))).toHaveLength(1);
      database.close();
    });

    it("holds a run that shows a visible CAPTCHA, even with an unlimited daily cap", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const flag = { clicked: false };
      const report = await advancePipeline({
        database, dataDir, settings: unlimitedPolicy(), voiceDrafter: null,
        openPage: async () => ({ ...fakePage({ submitted: flag }), visibleChallenge: async () => ({ kind: "hcaptcha" as const, detail: "an hCaptcha challenge" }) })
      });
      expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
      expect(report.submitted).toEqual([]);
      expect(report.held[0]!.reasons).toContain("The site showed a safeguard challenge.");
      expect(flag.clicked).toBe(false);
      database.close();
    });

    it("lists a CAPTCHA that appears after the automatic submit click as held, not as an error", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const flag = { clicked: false };
      const report = await advancePipeline({
        database, dataDir, settings: policy(), voiceDrafter: null,
        openPage: async () => ({
          ...fakePage({ submitted: flag, confirmation: "Please complete the security step." }),
          visibleChallenge: async () => (flag.clicked ? { kind: "turnstile" as const, detail: "a Cloudflare Turnstile challenge" } : null)
        })
      });
      expect(flag.clicked).toBe(true);
      expect(report.submitted).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: [expect.stringContaining("never solves CAPTCHAs")] }]);
      expect(getBrowserRuns(jobId, database)[0]!.status).toBe("failed");
      expect(details(database, jobId).some((event) => event.detail?.startsWith("Automatic submission failed: After the submit click"))).toBe(true);
      database.close();
    });

    it("lists a field that will not fill before the automatic submit click as held, and clicks nothing", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      const flag = { clicked: false };
      let opens = 0;
      const report = await advancePipeline({
        database, dataDir, settings: policy(), voiceDrafter: null,
        openPage: async () => {
          opens += 1;
          // The start fills; the submit's refill times out.
          return opens === 1 ? fakePage() : { ...fakePage({ submitted: flag }), fillField: async () => { throw playwrightTimeout(); } };
        }
      });
      expect(flag.clicked).toBe(false);
      expect(report.submitted).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(report.held).toEqual([{ jobId, reasons: [expect.stringContaining("Before the submit click the agent could not fill 1 field(s)")] }]);
      expect(getBrowserRuns(jobId, database)[0]!.status).toBe("paused-needs-input");
      database.close();
    });

    it("never retries a failed automatic submission", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      strongFit(database, jobId);
      let opens = 0;
      const first = await advancePipeline({
        database, dataDir, settings: policy(), voiceDrafter: null,
        openPage: async () => { opens += 1; if (opens > 1) throw new Error("The site did not load."); return fakePage(); }
      });
      expect(first.submitted).toEqual([]);
      expect(first.errors).toEqual([`Automatic submission failed for ${jobId}: The site did not load.`]);
      expect(details(database, jobId).some((event) => event.detail === "Automatic submission failed: The site did not load.")).toBe(true);
      const second = await advancePipeline({ database, dataDir, settings: policy(), voiceDrafter: null, openPage: async () => { throw new Error("must not retry"); } });
      expect(second.started).toEqual([]);
      expect(second.submitted).toEqual([]);
      database.close();
    });
  });

  describe("voice drafts in a run", () => {
    const controls: RawControl[] = [
      { tag: "textarea", id: "why", label: "Why do you want to work at this company?", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const gate = { passed: true, averagePercentile: 41, targetAverage: 65, detectors: {}, revisions: 2 };

    it("fills a required open-ended answer with a gate-passing draft", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const page = fakePage({ controls });
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
        database, dataDir, openPage: async () => page,
        voiceDrafter: async () => ({ status: "filled", text: "A drafted answer in the candidate's voice.", gate })
      });
      expect(started.run.status).toBe("awaiting-approval");
      expect(started.run.decisions.find((decision) => decision.fieldId === "why")).toMatchObject({
        action: "fill", value: "A drafted answer in the candidate's voice.", basis: { kind: "voice_draft", gate }
      });
      expect(page.filled.get("why")).toBe("A drafted answer in the candidate's voice.");
      database.close();
    });

    it("leaves a failed draft blank with the best version, and never remembers the written answer", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const page = fakePage({ controls });
      const draft = { text: "Best version so far.", gate: { ...gate, passed: false, averagePercentile: 72, revisions: 5 }, reason: "Did not clear the gate." };
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", {
        database, dataDir, openPage: async () => page,
        voiceDrafter: async () => ({ status: "blank", draft })
      });
      expect(started.run.status).toBe("paused-needs-input");
      expect(page.filled.has("why")).toBe(false);
      expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "why", status: "open", draft, suggestedKey: null })]);

      const facts = database.prepare("SELECT COUNT(*) AS count FROM candidate_facts").get() as { count: number };
      const answered = await answerRunPause(started.run.id, "why", "My own answer.", false, { database });
      expect(answered.remembered).toBe(false);
      expect(database.prepare("SELECT COUNT(*) AS count FROM candidate_facts").get()).toEqual(facts);
      const continued = await continueBrowserRun(started.run.id, { database, dataDir, openPage: async () => fakePage({ controls }) });
      expect(continued.run.status).toBe("awaiting-approval");
      expect(continued.run.decisions.find((decision) => decision.fieldId === "why")).toMatchObject({ action: "fill", value: "My own answer." });
      database.close();
    });
  });

  describe("Workday runs", () => {
    const siteUrl = "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1";
    const siteKey = "workday:ngc.wd1.myworkdayjobs.com/External";
    type Step = { name: string; controls: RawControl[] };
    const flow: Step[] = [
      { name: "My Information", controls: [
        { tag: "input", type: "email", id: "formField-emailAddress", label: "Email", required: true },
        { tag: "input", type: "radio", id: "formField-prev", label: "Have you previously worked here?", required: true, options: ["Yes", "No"] }
      ] },
      { name: "Application Questions", controls: [
        { tag: "select", id: "formField-country", label: "Country / Territory", required: true, options: ["United States of America"], value: "United States of America" }
      ] },
      { name: "Review", controls: [] }
    ];

    /** An in-memory Workday tenant shared by every page of a test: accounts, verification, counters. */
    type FakeSite = {
      /** `silent`: the create submit gets no answer and stores nothing. */
      mode: "create" | "verify" | "exists" | "captcha" | "silent";
      accounts: Map<string, string>;
      verified: boolean;
      creates: number;
      signIns: number;
      opened: string[];
      link: string;
      onCreate?: (credentials: WorkdayCredentials) => void;
      onSignIn?: (credentials: WorkdayCredentials) => void;
    };
    const fakeSite = (mode: FakeSite["mode"], overrides: Partial<FakeSite> = {}): FakeSite => ({
      mode, accounts: new Map(), verified: false, creates: 0, signIns: 0, opened: [],
      link: "https://ngc.wd1.myworkdayjobs.com/External/activate/tok123", ...overrides
    });

    /** Account steps over a fake site; each page starts signed out unless told otherwise. */
    function accountSteps(site: FakeSite, session: { signedIn: boolean }) {
      return {
        accountScreen: async () => (site.mode === "captcha" ? "captcha" as const : "sign-in" as const),
        createAccount: async (credentials: WorkdayCredentials): Promise<{ outcome: WorkdayAccountOutcome; termsLabel: string | null }> => {
          site.creates += 1;
          site.onCreate?.(credentials);
          const termsLabel = "Yes, I have read and consent to the Terms and Conditions";
          if (site.mode === "exists") return { outcome: { result: "exists" }, termsLabel };
          if (site.mode === "silent") return { outcome: { result: "no-answer", detail: "Workday did not answer the create-account submit within 60 seconds" }, termsLabel };
          site.accounts.set(credentials.email, credentials.password);
          if (site.mode === "verify") return { outcome: { result: "verify-email" }, termsLabel };
          session.signedIn = true;
          return { outcome: { result: "signed-in" }, termsLabel };
        },
        signInToAccount: async (credentials: WorkdayCredentials): Promise<WorkdayAccountOutcome> => {
          site.signIns += 1;
          site.onSignIn?.(credentials);
          if (site.accounts.get(credentials.email) !== credentials.password) return { result: "wrong-password" };
          if (site.mode === "verify" && !site.verified) return { result: "verify-email" };
          session.signedIn = true;
          return { result: "signed-in" };
        },
        openInNewTab: async (url: string) => { site.opened.push(url); if (url === site.link) site.verified = true; },
        goto: async () => undefined
      };
    }

    /** An in-memory Workday flow: fills are recorded, required radios gate Save and Continue. */
    /** Workday's own account step, as real sites draw it inside the apply flow (employer-a.wd115, employer-b.wd3). */
    const accountStepControls: RawControl[] = [
      { tag: "input", type: "text", id: "formField-email", label: "Email Address", required: true },
      { tag: "input", type: "password", id: "formField-password", label: "Password", required: true },
      { tag: "input", type: "password", id: "formField-verifyPassword", label: "Verify New Password", required: true }
    ];

    /**
     * An in-memory Workday flow: fills are recorded, required radios gate Save and Continue.
     * `accountStep`: signed out, the flow opens on its "Create Account/Sign In" step and no
     * sign-in form is detected at entry (the real sites' render race).
     */
    function fakeWorkday(options: { signIn?: boolean; submitted?: { count: number }; account?: { site: FakeSite; signedIn?: boolean }; accountStep?: boolean; steps?: Step[] } = {}) {
      const steps = options.steps ?? flow;
      let index = 0;
      let done = false;
      const filled = new Map<string, string>();
      const session = { signedIn: options.account?.signedIn ?? false };
      const wall = () => (options.account ? !session.signedIn : Boolean(options.signIn));
      const onAccountStep = () => Boolean(options.accountStep) && wall();
      const page = {
        ...fakePage(),
        filled,
        url: () => siteUrl,
        title: async () => "Workday",
        collectControls: async () => (onAccountStep() ? accountStepControls : steps[index]!.controls),
        fillField: async (field: BrowserField, value: string) => { filled.set(field.id, value); },
        chooseOption: async (field: BrowserField, option: string) => { filled.set(field.id, option); },
        bodyText: async () => (done ? "Application Submitted. Thank you for applying." : "Review your application"),
        enterApplication: async () => (wall() && !options.accountStep ? "sign-in" as const : "flow" as const),
        signInRequired: async () => wall() && !options.accountStep,
        ...(options.account ? accountSteps(options.account.site, session) : {}),
        activeStep: async () => (onAccountStep()
          ? { index: 1, total: steps.length + 1, name: "Create Account/Sign In" }
          : { index: index + 1, total: steps.length, name: steps[index]!.name }),
        footerAction: async () => (steps[index]!.name === "Review" ? "Submit" : "Save and Continue"),
        // This site's steps have no Work Experience or Education sections.
        fillHistory: async () => null,
        backTo: async () => false,
        nextStep: async () => {
          if (onAccountStep()) return { moved: false, errors: ["Email Address is required"] };
          const missing = steps[index]!.controls.filter((control) => control.type === "radio" && !filled.has(control.id!));
          if (missing.length) return { moved: false, errors: missing.map((control) => `${control.label} is required`) };
          index += 1;
          return { moved: true, errors: [] };
        },
        clickSubmit: async () => { done = true; if (options.submitted) options.submitted.count += 1; }
      };
      return page;
    }

    function workdayJob(database: DatabaseSync): string {
      const jobId = approvedJobId(database, "qualified");
      prepareApplication(jobId, { database });
      database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?").run(siteUrl, jobId);
      saveBrowserSession(database, { site: siteKey, status: "connected", detail: "Signed in.", checkedAt: new Date().toISOString() });
      return jobId;
    }

    it("pauses a Workday step whose field will not fill, and never saves past it", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      approveApplication(jobId, { database });
      const steps: Step[] = [
        { name: "My Information", controls: [{ tag: "input", type: "email", id: "formField-emailAddress", label: "Email", required: true }] },
        { name: "Review", controls: [] }
      ];
      const base = fakeWorkday({ steps });
      let moved = 0;
      const page = { ...base, fillField: async () => { throw playwrightTimeout(); }, nextStep: async () => { moved += 1; return base.nextStep(); } };
      const started = await startBrowserRun(jobId, siteUrl, { database, dataDir, voiceDrafter: null, openPage: async () => page });
      expect(started.run.status).toBe("paused-needs-input");
      expect(moved).toBe(0);
      expect(started.run.pauses).toEqual([expect.objectContaining({ fieldId: "My Information::formField-emailAddress", status: "open" })]);
      expect(started.run.pauses[0]!.question).toContain("the field did not respond in time");
      expect(started.run.decisions.find((decision) => decision.fieldId === "My Information::formField-emailAddress")).toMatchObject({ action: "pause" });
      database.close();
    });

    it("never saves a Workday step from which it read no field, and stops it as blocked", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      approveApplication(jobId, { database });
      const steps: Step[] = [{ name: "My Information", controls: [] }, { name: "Review", controls: [] }];
      const base = fakeWorkday({ steps });
      let moved = 0;
      const page = { ...base, nextStep: async () => { moved += 1; return base.nextStep(); } };
      const started = await startBrowserRun(jobId, siteUrl, { database, dataDir, voiceDrafter: null, openPage: async () => page });
      expect(started.run.status).toBe("paused-needs-input");
      expect(moved).toBe(0);
      const open = started.run.pauses.filter((pause) => pause.status === "open");
      expect(open).toEqual([expect.objectContaining({ fieldId: "My Information::workday-errors" })]);
      expect(open[0]!.question).toContain("could not read any field");
      database.close();
    });

    it("reads a Workday step again when its first read found no field, and walks on once its fields appear", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      approveApplication(jobId, { database });
      database.prepare("UPDATE candidates SET legal_first_name = 'Jordan'").run();
      const firstName: RawControl = { tag: "input", type: "text", id: "formField-legalName--firstName", label: "First Name", required: true };
      const steps: Step[] = [{ name: "My Information", controls: [firstName] }, { name: "Review", controls: [] }];
      const base = fakeWorkday({ steps });
      // The step is drawn before its fields can be read: the first read finds none.
      let reads = 0;
      const page = { ...base, collectControls: async () => (reads++ === 0 ? [] : base.collectControls()) };
      const started = await startBrowserRun(jobId, siteUrl, { database, dataDir, voiceDrafter: null, openPage: async () => page });
      expect(started.run.status).toBe("awaiting-approval");
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(base.filled.get("formField-legalName--firstName")).toBe("Jordan");
      database.close();
    });

    it("uploads the uploaded default resume on Workday, and the 2029 resume on a step that asks for a transcript", async () => {
      const resumeField: RawControl = { tag: "input", type: "file", id: "resume", label: "Resume", required: true };
      const transcriptField: RawControl = { tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true };
      const alternateBytes = new TextEncoder().encode("%PDF-1.7\n% fixture 2029 resume\n%%EOF\n");

      // (a) No transcript asked: the default resume, nothing printed.
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      approveApplication(jobId, { database });
      const defaultResume = storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: PDF_BYTES }, { database, dataDir });
      storeBaseResume({ channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: alternateBytes }, { database, dataDir });
      const defaultSteps: Step[] = [{ name: "My Experience", controls: [resumeField] }, { name: "Review", controls: [] }];
      const rendered: string[] = [];
      const renderPdf = async (_html: string, path: string) => { rendered.push(path); return { pages: 1 }; };
      const page = fakeWorkday({ steps: defaultSteps });
      const started = await startBrowserRun(jobId, siteUrl, { database, dataDir, renderPdf, voiceDrafter: null, openPage: async () => page });
      expect(started.run.status).toBe("awaiting-approval");
      expect(page.uploads.get("resume")).toBe(baseResumeUploadPath(dataDir, jobId, defaultResume.id, "resume-2028.pdf"));
      expect(started.run.baseResumeId).toBe(defaultResume.id);
      expect(started.run.applicationProfile).toBe("default");
      expect(rendered).toHaveLength(0);
      approveRunSubmission(started.run.id, undefined, { database });
      const clicks = { count: 0 };
      const submitted = await submitBrowserRun(started.run.id, {
        database, dataDir, renderPdf, applicationRecord: null, openPage: async () => fakeWorkday({ steps: defaultSteps, submitted: clicks })
      });
      expect(submitted.status).toBe("submitted");
      expect(clicks.count).toBe(1);
      expect(submitted.baseResumeId).toBe(defaultResume.id);
      expect(rendered).toHaveLength(0);
      database.close();

      // (b) A step asks for a transcript: the 2029 resume and the transcript go together.
      const second = disposableDatabase();
      const secondDir = disposableDataDir();
      const secondJob = workdayJob(second);
      approveApplication(secondJob, { database: second });
      graduationFacts(second);
      storeBaseResume({ channel: "default", label: "Resume (Expected May 2028)", originalName: "resume-2028.pdf", bytes: PDF_BYTES }, { database: second, dataDir: secondDir });
      const alternate = storeBaseResume({ channel: "handshake_internal", label: "Resume (Expected May 2029)", originalName: "resume-2029.pdf", bytes: alternateBytes }, { database: second, dataDir: secondDir });
      const transcript = storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database: second, dataDir: secondDir });
      const transcriptPage = fakeWorkday({ steps: [{ name: "My Experience", controls: [resumeField, transcriptField] }, { name: "Review", controls: [] }] });
      const alternateRun = await startBrowserRun(secondJob, siteUrl, {
        database: second, dataDir: secondDir, renderPdf, voiceDrafter: null, openPage: async () => transcriptPage
      });
      expect(transcriptPage.uploads.get("resume")).toBe(baseResumeUploadPath(secondDir, secondJob, alternate.id, "resume-2029.pdf"));
      expect(transcriptPage.uploads.get("transcript")).toBe(candidateDocumentFilePath(secondDir, transcript.fileName));
      expect(alternateRun.run.applicationProfile).toBe("transcript");
      expect(alternateRun.run.baseResumeId).toBe(alternate.id);
      expect(rendered).toHaveLength(0);
      second.close();
    });

    it("walks a connected site to Review with the candidate's answers and submits only after approval", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      const started = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakeWorkday() });
      expect(started.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
      const run = database.prepare("SELECT id FROM browser_runs WHERE job_id = ?").get(jobId) as { id: string };
      const paused = getBrowserRuns(jobId, database)[0]!;
      expect(paused.atsKind).toBe("workday");
      expect(paused.pauses.filter((pause) => pause.status === "open").map((pause) => pause.fieldId)).toEqual(["My Information::formField-prev"]);
      expect(paused.decisions.find((decision) => decision.fieldId === "My Information::formField-emailAddress")).toMatchObject({ action: "fill", value: "jordan@example.test" });

      await answerRunPause(run.id, "My Information::formField-prev", "No", false, { database });
      const continued = await continueBrowserRun(run.id, { database, dataDir, openPage: async () => fakeWorkday() });
      expect(continued.run.status).toBe("awaiting-approval");
      expect(continued.run.decisions.find((decision) => decision.fieldId === "My Information::formField-prev")).toMatchObject({ action: "choose", value: "No" });
      expect(continued.run.decisions.find((decision) => decision.fieldId === "Application Questions::formField-country")).toMatchObject({ action: "keep" });

      const clicks = { count: 0 };
      await expect(submitBrowserRun(run.id, { database, dataDir, openPage: async () => fakeWorkday({ submitted: clicks }) })).rejects.toThrow("explicit human approval");
      expect(clicks.count).toBe(0);
      approveRunSubmission(run.id, undefined, { database });
      const submitted = await submitBrowserRun(run.id, { database, dataDir, openPage: async () => fakeWorkday({ submitted: clicks }) });
      expect(clicks.count).toBe(1);
      expect(submitted.status).toBe("submitted");
      expect(submitted.confirmationText).toContain("Application Submitted");
      expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("SUBMITTED");
      database.close();
    });

    it("pauses on each Workday error with the field's label, saves evidence, and fills the answer on continue", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      approveApplication(jobId, { database });
      // An optional-looking field the planner skips, which Workday says is required.
      const steps: Step[] = [
        { name: "My Information", controls: [
          { tag: "input", type: "email", id: "formField-emailAddress", label: "Email", required: true },
          { tag: "input", type: "text", id: "formField-referralCode", label: "Referral Code", required: false }
        ] },
        { name: "Review", controls: [] }
      ];
      const text = "The field Referral Code is required and must have a value.";
      const details: WorkdayPageError[] = [
        { fieldId: "formField-referralCode", label: "Referral Code", text, source: "field" },
        { fieldId: null, label: null, text: `Referral Code: ${text}`, source: "banner" }
      ];
      const strictWorkday = () => {
        const base = fakeWorkday({ steps });
        return {
          ...base,
          nextStep: async () => (base.filled.has("formField-referralCode")
            ? base.nextStep()
            : { moved: false, errors: [...new Set(details.map((error) => error.text))], details })
        };
      };
      const started = await startBrowserRun(jobId, siteUrl, { database, dataDir, voiceDrafter: null, openPage: async () => strictWorkday() });
      const run = started.run;
      expect(run.status).toBe("paused-needs-input");
      expect(run.pauses.filter((pause) => pause.status === "open")).toEqual([expect.objectContaining({
        fieldId: "My Information::workday-error::formField-referralCode",
        label: `Referral Code: ${text}`,
        fieldKind: "text"
      })]);
      expect(run.pauses.some((pause) => pause.label.endsWith("(Workday errors)"))).toBe(false);

      // Evidence for the run: the field with Workday's text, files 600, a relative path in the timeline.
      const shortId = run.id.slice(0, 8);
      const evidenceEvent = (database.prepare("SELECT detail FROM application_events WHERE job_id = ? AND detail LIKE 'Workday evidence saved%'").all(jobId) as Array<{ detail: string }>)
        .map((row) => row.detail);
      expect(evidenceEvent).toHaveLength(1);
      expect(evidenceEvent[0]).toMatch(new RegExp(`^Workday evidence saved \\(workday-errors\\): applications/${jobId}/submit-evidence/[0-9TZ-]+-${run.id}; view it with pnpm run:evidence --run ${shortId}\\.$`));
      const root = submitEvidenceRoot(dataDir, jobId);
      const [folder] = readdirSync(root);
      const evidencePath = join(root, folder!, "evidence.json");
      expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(readFileSync(evidencePath, "utf8")) as { runId: string; outcome: string; invalidFields: InvalidField[]; detail: string };
      expect(stored).toMatchObject({ runId: run.id, outcome: "workday-errors", detail: "Workday could not save My Information." });
      expect(stored.invalidFields).toEqual([{ ref: "formField-referralCode", label: "Referral Code", error: text }]);
      const lines: string[] = [];
      const io = { open: () => database, close: () => undefined, dataDir: () => dataDir, log: (line: string) => { lines.push(line); } };
      expect(await runEvidenceCommand(["--run", shortId], io)).toBe(0);
      expect(lines).toContain(`  - Referral Code: ${text}`);

      // The answer fills the field on continue, and the run moves on.
      await answerRunPause(run.id, "My Information::workday-error::formField-referralCode", "FRIEND-42", false, { database });
      const continued = await continueBrowserRun(run.id, { database, dataDir, voiceDrafter: null, openPage: async () => strictWorkday() });
      expect(continued.run.status).toBe("awaiting-approval");
      expect(continued.run.decisions.find((decision) => decision.fieldId === "My Information::formField-referralCode")).toMatchObject({ action: "fill", value: "FRIEND-42" });
      expect(continued.run.pauses.filter((pause) => pause.status === "open")).toEqual([]);
      database.close();
    });

    it("marks the site signed out when Workday asks for sign-in, and waits for the candidate after that", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      const first = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakeWorkday({ signIn: true }) });
      expect(first.stopped).toHaveLength(1);
      expect(first.stopped[0]!.reason).toContain("Workday accounts page");
      expect(getWorkdaySession(siteKey, database)?.status).toBe("signed_out");
      const second = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => { throw new Error("must wait for sign-in"); } });
      expect(second.waiting).toEqual([{ jobId, siteKey, reason: "workday-sign-in" }]);
      database.close();
    });

    it("reads Workday's Create Account/Sign In step as the sign-in wall, never as application questions", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = workdayJob(database);
      const report = await advancePipeline({
        database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakeWorkday({ signIn: true, accountStep: true })
      });
      expect(report.started).toEqual([]);
      expect(report.stopped).toHaveLength(1);
      expect(report.stopped[0]!.reason).toContain("Workday accounts page");
      expect(getWorkdaySession(siteKey, database)?.status).toBe("signed_out");
      const pauses = getBrowserRuns(jobId, database).flatMap((run) => run.pauses);
      expect(pauses.filter((pause) => /password|email address/i.test(`${pause.label} ${pause.fieldId}`))).toEqual([]);
      database.close();
    });

    describe("when the application does not open (Track 28)", () => {
      const eventDetails = (database: DatabaseSync, jobId: string) =>
        (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
      /** The job's one evidence folder: its name and evidence.json. */
      const entryEvidence = (dataDir: string, jobId: string) => {
        const root = submitEvidenceRoot(dataDir, jobId);
        const folders = readdirSync(root);
        expect(folders).toHaveLength(1);
        return { folder: folders[0]!, stored: JSON.parse(readFileSync(join(root, folders[0]!, "evidence.json"), "utf8")) as Record<string, unknown> };
      };
      const entering = (entered: "closed" | "challenge" | "missing") => async () => ({ ...fakeWorkday(), enterApplication: async () => entered });

      it("skips a posting Workday shows closed as \"Posting closed\", saves workday-entry evidence, and never runs it again", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const jobId = workdayJob(database);
        const report = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: entering("closed") });
        expect(report.stopped).toEqual([]);
        expect(report.skipped).toEqual([{ jobId, reasons: [expect.stringMatching(/^Posting closed: .*no longer exists/)] }]);
        expect(database.prepare("SELECT COUNT(*) AS count FROM browser_runs").get()).toEqual({ count: 0 });
        expect(jobStatus(database, jobId)).toBe("READY_FOR_REVIEW");
        expect(getDiscoverySkip(database, jobId)?.reason).toBe("Posting closed");
        const details = eventDetails(database, jobId);
        expect(details.some((detail) => detail.startsWith("Automatic browser run found the posting closed: "))).toBe(true);
        expect(details.some((detail) => detail.startsWith("Automatic browser run needs you: "))).toBe(false);
        const { folder, stored } = entryEvidence(dataDir, jobId);
        expect(folder).toMatch(/-workday-entry$/);
        expect(stored).toMatchObject({ runId: null, jobId, outcome: "workday-entry" });

        const second = await advancePipeline({
          database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => { throw new Error("must not run a closed posting"); }
        });
        expect(second.started).toEqual([]);
        expect(second.stopped).toEqual([]);
        expect(second.errors).toEqual([]);
        expect(second.skipped.filter((entry) => entry.jobId === jobId)).toEqual([]);
        database.close();
      });

      it("stops once with a security-check reason when Workday shows a check instead of the application", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const jobId = workdayJob(database);
        const report = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: entering("challenge") });
        expect(report.stopped).toHaveLength(1);
        expect(report.stopped[0]!.reason).toContain("security check");
        expect(report.stopped[0]!.reason).not.toContain("may be closed");
        expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Automatic browser run needs you: ") && detail.includes("security check"))).toBe(true);
        expect(getDiscoverySkip(database, jobId)).toBeNull();
        expect(entryEvidence(dataDir, jobId).stored).toMatchObject({ runId: null, jobId, outcome: "workday-entry" });

        const second = await advancePipeline({
          database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => { throw new Error("must not reopen a stopped posting"); }
        });
        expect(second.started).toEqual([]);
        expect(second.stopped).toEqual([]);
        expect(second.errors).toEqual([]);
        database.close();
      });

      it("names an entry with no application without claiming the posting closed", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const jobId = workdayJob(database);
        const report = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: entering("missing") });
        expect(report.stopped).toHaveLength(1);
        const reason = report.stopped[0]!.reason;
        expect(reason).toContain("No Workday application opened");
        expect(reason).toContain("neither the application nor its closed-posting page");
        expect(reason).not.toContain("may be closed");
        expect(entryEvidence(dataDir, jobId).stored).toMatchObject({ runId: null, jobId, outcome: "workday-entry" });
        expect(getDiscoverySkip(database, jobId)).toBeNull();
        database.close();
      });
    });

    describe("with agent-created accounts", () => {
      const host = "ngc.wd1.myworkdayjobs.com";
      const email = "jordan@example.test";
      const accountsFile = () => join(disposableDataDir(), "config", "workday-accounts.json");
      const settingsFor = (file: string, mailbox: VerificationMailboxFactory | null = null, accountEmail = email): PipelineSettings => ({
        minFit: 0, autoApply: true, workdayAccounts: { email: accountEmail, file, mailbox, mailPollMs: 5, mailTimeoutMs: 30 }
      });
      const noBrowser = async (): Promise<BrowserPage> => { throw new Error("must not open a browser while the account is held"); };
      /** A Workday job with no session (or a signed-out one) for the site. */
      function accountJob(database: DatabaseSync, session: "none" | "signed_out" | "connected" = "none"): string {
        const jobId = approvedJobId(database, "qualified");
        prepareApplication(jobId, { database });
        database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?").run(siteUrl, jobId);
        if (session !== "none") saveBrowserSession(database, { site: siteKey, status: session, detail: "Seeded.", checkedAt: new Date().toISOString() });
        return jobId;
      }
      const eventDetails = (database: DatabaseSync, jobId: string) =>
        (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
      const everyRow = (database: DatabaseSync) => JSON.stringify(["application_events", "browser_sessions", "browser_runs"]
        .map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
      const mailbox = (messages: () => MailMessage[]): VerificationMailboxFactory => async () => ({
        messagesSince: async () => messages(), close: async () => undefined
      });

      it("creates the account with the password saved before it is typed, signs in, and fills the application", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        let savedFirst = false;
        const site = fakeSite("create", {
          onCreate: (credentials) => {
            const saved = getWorkdayAccount(file, host);
            savedFirst = saved?.account === "pending" && saved.password === credentials.password && credentials.email === email;
          }
        });
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
        expect(report.waiting).toEqual([]);
        expect(savedFirst).toBe(true);
        expect(site.creates).toBe(1);
        const saved = getWorkdayAccount(file, host)!;
        expect(saved).toMatchObject({ host, email, account: "created", hold: null });
        expect(site.accounts.get(email)).toBe(saved.password);
        expect(getWorkdaySession(siteKey, database)?.status).toBe("connected");
        const events = eventDetails(database, jobId);
        expect(events).toContain(`Workday ${host}: account created with your email; the password is saved locally.`);
        expect(events).toContain(`Workday ${host}: checked "Yes, I have read and consent to the Terms and Conditions" on the create-account form, as part of your request that the agent create the account.`);
        expect(JSON.stringify(report)).not.toContain(saved.password!);
        expect(everyRow(database)).not.toContain(saved.password!);
        database.close();
      });

      it("creates the account when the account step appears inside the apply flow, then fills the application", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("create");
        const report = await advancePipeline({
          database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site }, accountStep: true })
        });
        expect(site.creates).toBe(1);
        expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
        expect(report.waiting).toEqual([]);
        const run = getBrowserRuns(jobId, database)[0]!;
        expect(run.pauses.filter((pause) => pause.status === "open").map((pause) => pause.fieldId)).toEqual(["My Information::formField-prev"]);
        const touched = [...run.pauses.map((pause) => `${pause.label} ${pause.fieldId}`), ...run.decisions.map((decision) => decision.fieldId)];
        expect(touched.filter((text) => /password|email address|create account/i.test(text))).toEqual([]);
        expect(getWorkdayAccount(file, host)).toMatchObject({ host, email, account: "created", hold: null });
        database.close();
      });

      it("signs in to a known host with the saved password and never creates another account", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database, "signed_out");
        const now = new Date().toISOString();
        putWorkdayAccount(file, { host, email, password: "Saved-Pass-1234!", account: "created", hold: null, createdAt: now, updatedAt: now });
        const used: WorkdayCredentials[] = [];
        const site = fakeSite("create", { accounts: new Map([[email, "Saved-Pass-1234!"]]), onSignIn: (credentials) => { used.push(credentials); } });
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
        expect(used).toEqual([{ email, password: "Saved-Pass-1234!" }]);
        expect(site.creates).toBe(0);
        expect(getWorkdaySession(siteKey, database)?.status).toBe("connected");
        expect(eventDetails(database, jobId)).toContain(`Workday ${host}: signed in with the saved account.`);
        expect(everyRow(database)).not.toContain("Saved-Pass-1234!");
        database.close();
      });

      it("waits without a browser when the profile email is not the account email", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const jobId = accountJob(database);
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(accountsFile(), null, "someone@example.test"), voiceDrafter: null, openPage: noBrowser });
        expect(report.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringMatching(/does not match/) }]);
        expect(report.stopped).toEqual([]);
        database.close();
      });

      it("opens the verification link from the mailbox in the run's browser, then signs in", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("verify");
        const mail = mailbox(() => [{
          from: "NGC <ngc@myworkday.com>", subject: "Verify your candidate account", receivedAt: new Date(), text: "",
          html: `<a href="${site.link}">Verify</a> <a href="https://evil.example/activate/x">Other</a>`
        }]);
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(file, mail), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(report.started).toEqual([{ jobId, runStatus: "paused-needs-input" }]);
        expect(site.opened).toEqual([site.link]);
        expect(site.signIns).toBe(1);
        expect(getWorkdayAccount(file, host)).toMatchObject({ account: "created", hold: null });
        expect(eventDetails(database, jobId)).toContain(`Workday ${host}: verification email found and opened.`);
        database.close();
      });

      it("holds when the verification email does not arrive, and waits without a browser until the hold is due", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("verify");
        const first = await advancePipeline({ database, dataDir, settings: settingsFor(file, mailbox(() => [])), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(first.started).toEqual([]);
        expect(first.stopped).toEqual([]);
        expect(first.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("verification email not found") }]);
        expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Automatic browser run waiting: ") && detail.includes("verification email not found"))).toBe(true);
        expect(getWorkdayAccount(file, host)).toMatchObject({ account: "created", hold: { kind: "verify-email", attempts: 1 } });
        expect(database.prepare("SELECT COUNT(*) AS count FROM browser_runs").get()).toEqual({ count: 0 });
        expect(jobStatus(database, jobId)).toBe("READY_FOR_REVIEW");
        const second = await advancePipeline({ database, dataDir, settings: settingsFor(file, mailbox(() => [])), voiceDrafter: null, openPage: noBrowser });
        expect(second.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("verification email not found") }]);
        expect(second.errors).toEqual([]);
        database.close();
      });

      it("holds an existing account for the candidate, even hours later, without a browser", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("exists");
        const first = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(first.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("already exists") }]);
        const held = getWorkdayAccount(file, host)!;
        expect(held).toMatchObject({ account: "refused", hold: { kind: "exists" } });
        const earlier = new Date(Date.now() - 2 * 3_600_000).toISOString();
        putWorkdayAccount(file, { ...held, hold: { ...held.hold!, at: earlier } });
        const second = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: noBrowser });
        expect(second.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("already exists") }]);
        expect(site.creates).toBe(1);
        // The saved password was tried once before holding.
        expect(site.signIns).toBe(1);
        database.close();
      });

      it("signs in once when Workday does not answer the create submit, then holds and saves evidence for the job", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("silent");
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(report.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("60 seconds") }]);
        expect(site.creates).toBe(1);
        expect(site.signIns).toBe(1);
        const held = getWorkdayAccount(file, host)!;
        expect(held.hold?.kind).toBe("interrupted");
        expect(database.prepare("SELECT COUNT(*) AS count FROM browser_runs").get()).toEqual({ count: 0 });

        const root = submitEvidenceRoot(dataDir, jobId);
        const folders = readdirSync(root);
        expect(folders).toHaveLength(1);
        expect(folders[0]).toMatch(/-workday-account$/);
        const raw = readFileSync(join(root, folders[0]!, "evidence.json"), "utf8");
        expect(JSON.parse(raw)).toMatchObject({ runId: null, jobId, outcome: "workday-account", detail: held.hold!.reason });
        expect(raw).not.toContain(held.password!);
        expect(raw.toLocaleLowerCase("en-US")).not.toContain(email);
        const jobRef = jobId.slice(0, 8);
        expect(eventDetails(database, jobId)).toContain(`Workday evidence saved (workday-account): applications/${jobId}/submit-evidence/${folders[0]}; view it with pnpm run:evidence --job ${jobRef}.`);
        const lines: string[] = [];
        const io = { open: () => database, close: () => undefined, dataDir: () => dataDir, log: (line: string) => { lines.push(line); } };
        expect(await runEvidenceCommand(["--job", jobRef], io)).toBe(0);
        expect(lines).toContain("Run: none (the account step stopped before a run was saved)");
        expect(lines).toContain(`Detail: ${held.hold!.reason}`);
        expect(everyRow(database)).not.toContain(held.password!);
        database.close();
      });

      it("holds a CAPTCHA before any password is generated or typed", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database);
        const site = fakeSite("captcha");
        const report = await advancePipeline({ database, dataDir, settings: settingsFor(file), voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site } }) });
        expect(report.waiting).toEqual([{ jobId, siteKey, reason: "workday-account", detail: expect.stringContaining("CAPTCHA") }]);
        expect(getWorkdayAccount(file, host)).toMatchObject({ password: null, account: null, hold: { kind: "captcha" } });
        expect(site.creates).toBe(0);
        expect(getWorkdaySession(siteKey, database)?.status).toBe("signed_out");
        database.close();
      });

      it("signs in with the saved password on the auto-submit path and never creates an account there", async () => {
        const database = disposableDatabase();
        const dataDir = disposableDataDir();
        const file = accountsFile();
        const jobId = accountJob(database, "connected");
        const now = new Date().toISOString();
        putWorkdayAccount(file, { host, email, password: "Saved-Pass-1234!", account: "created", hold: null, createdAt: now, updatedAt: now });
        const site = fakeSite("create", { accounts: new Map([[email, "Saved-Pass-1234!"]]) });
        await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakeWorkday({ account: { site, signedIn: true } }) });
        const run = database.prepare("SELECT id FROM browser_runs WHERE job_id = ?").get(jobId) as { id: string };
        await answerRunPause(run.id, "My Information::formField-prev", "No", false, { database });
        const continued = await continueBrowserRun(run.id, { database, dataDir, openPage: async () => fakeWorkday({ account: { site, signedIn: true } }) });
        expect(continued.run.status).toBe("awaiting-approval");
        approveRunSubmission(run.id, undefined, { database });
        const clicks = { count: 0 };
        const submitted = await submitBrowserRun(run.id, {
          database, dataDir, openPage: async () => fakeWorkday({ account: { site }, submitted: clicks }),
          workdayAccounts: { email, file, mailbox: null }
        });
        expect(submitted.status).toBe("submitted");
        expect(clicks.count).toBe(1);
        expect(site.signIns).toBe(1);
        expect(site.creates).toBe(0);
        database.close();
      });
    });
  });

  describe("resume refresh", () => {
    const projectId = (database: DatabaseSync) =>
      (database.prepare("SELECT id FROM resume_entries WHERE section = 'project' LIMIT 1").get() as { id: string }).id;

    it("flags a package whose resume changed and rebuilds it from the current resume", () => {
      const database = disposableDatabase();
      const jobId = approvedJobId(database, "qualified");
      prepareApplication(jobId, { database });
      expect(resumeChangedSincePrepared(jobId, database)).toBe(false);
      const before = getApplicationPackage(jobId, database)!.package.id;

      setCandidateResumeEntryOnResume(projectId(database), false, database);
      expect(resumeChangedSincePrepared(jobId, database)).toBe(true);
      expect(getReviewQueueWithResumeState(database).find((entry) => entry.jobId === jobId)?.resumeChanged).toBe(true);

      const report = refreshApplications([jobId], { database });
      expect(report.refreshed).toEqual([{ jobId, status: "READY_FOR_REVIEW" }]);
      expect(getApplicationPackage(jobId, database)!.package.id).not.toBe(before);
      expect(resumeChangedSincePrepared(jobId, database)).toBe(false);
      expect(refreshApplications([jobId], { database }).skipped[0]?.reason).toContain("already matches");
      database.close();
    });

    it("cancels an unsubmitted filled run, and the pipeline fills it again with the new resume", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database, "qualified");
      const first = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakePage() });
      expect(first.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      setCandidateResumeEntryOnResume(projectId(database), false, database);

      const report = refreshApplications([jobId], { database });
      expect(report.cancelledRuns).toHaveLength(1);
      expect(getBrowserRuns(jobId, database).map((run) => run.status)).toEqual(["cancelled"]);
      expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("READY_FOR_REVIEW");

      const second = await advancePipeline({ database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => fakePage() });
      expect(second.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
      const variant = listJobResumeVariants(jobId, database)[0]!;
      expect(getBrowserRuns(jobId, database)[0]!.variantId).toBe(variant.id);
      expect(variant.document?.projects).toEqual([]);
      database.close();
    });

    it("never touches a submitted application", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
      approveRunSubmission(started.run.id, undefined, { database });
      await submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => fakePage() });
      setCandidateResumeEntryOnResume(projectId(database), false, database);
      const report = refreshApplications([jobId], { database });
      expect(report.refreshed).toEqual([]);
      expect(report.skipped[0]?.reason).toContain("submitted");
      expect(getBrowserRuns(jobId, database)[0]!.status).toBe("submitted");
      database.close();
    });
  });
});

describe("posting pages behind an Apply link", () => {
  const POSTING_URL = "https://careers.fixturerobotics.example/jobs/1001";
  type Step = { url: string; controls: RawControl[]; body?: string };
  /** A posting page with no form whose followApplyEntry lands on `next` (or finds no entry when `next` is null). */
  function postingPage(next: Step | null) {
    const state: { url: string; controls: RawControl[]; body?: string; title: string } = {
      url: POSTING_URL, controls: [{ tag: "button", label: "Apply" }], body: "Robotics Software Intern\nApply", title: "Robotics Software Intern"
    };
    const page = fakePage(state);
    const follows: string[] = [];
    return Object.assign(page, {
      follows,
      followApplyEntry: async () => {
        follows.push(state.url);
        if (!next) return null;
        Object.assign(state, next);
        return next.url;
      }
    });
  }
  const formStep: Step = {
    url: `${POSTING_URL}/apply`,
    controls: [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
      { tag: "button", label: "Submit application" }
    ],
    body: "Apply for Robotics Software Intern"
  };
  const icimsStep: Step = {
    url: "https://careers-fixture.icims.com/jobs/9001/intern/login?in_iframe=1",
    controls: [
      { tag: "input", type: "email", id: "email", label: "Email", required: true },
      { tag: "input", type: "checkbox", id: "accept_gdpr", label: "I agree", required: true },
      { tag: "input", type: "submit", label: "Next" }
    ],
    body: "Enter Your Information\nEmail\nI agree\nSoftware Powered by iCIMS"
  };
  const jobviteStep: Step = {
    url: "https://jobs.jobvite.com/fixturerobotics/job/oFixture1/apply",
    controls: [
      { tag: "select", id: "jv-country-select", label: "Location of Residence and Language:", required: true, options: ["United States - English", "Fixtureland - English"] },
      { tag: "button", label: "Accept" }
    ],
    body: "Data Consent\nLocation of Residence and Language:\nAccept\nPowered by Jobvite"
  };
  function qualifiedExternalJob(database: DatabaseSync): string {
    const jobId = approvedJobId(database, "qualified");
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    prepareApplication(jobId, { database });
    return jobId;
  }
  const automaticStart = (database: DatabaseSync, jobId: string, page: BrowserPage) => startBrowserRun(jobId, POSTING_URL, {
    database, dataDir: disposableDataDir(), automatic: true, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page
  });

  it("follows the posting's Apply entry once, fills the form there, and saves the form's address", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = postingPage(formStep);
    const started = await automaticStart(database, jobId, page);
    expect(page.follows).toEqual([POSTING_URL]);
    expect(page.filled.get("q1")).toBe("06/01/2027");
    expect(page.uploads.has("resume")).toBe(true);
    expect(started.run.applicationUrl).toBe(`${POSTING_URL}/apply`);
    expect(getBrowserRuns(jobId, database)[0]!.applicationUrl).toBe(`${POSTING_URL}/apply`);
    database.close();
  });

  it("stops an automatic run at iCIMS's account step with the reason, typing nothing and saving no run", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = postingPage(icimsStep);
    const stopped = automaticStart(database, jobId, page);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/iCIMS needs an account at careers-fixture\.icims\.com/);
    expect(page.filled.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("stops a run the candidate started at iCIMS's account step too, before anything is typed", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const page = postingPage(icimsStep);
    const stopped = startBrowserRun(jobId, POSTING_URL, {
      database, dataDir: disposableDataDir(), voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page
    });
    await expect(stopped).rejects.toThrow(/iCIMS needs an account at careers-fixture\.icims\.com/);
    await expect(stopped).rejects.not.toBeInstanceOf(AutomaticRunStopped);
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("stops at Jobvite's data-consent step with the reason", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = postingPage(jobviteStep);
    await expect(automaticStart(database, jobId, page)).rejects.toThrow(/Jobvite asks you to accept its data-consent policy at jobs\.jobvite\.com/);
    expect(page.filled.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("keeps the no-form stop when the posting has no Apply entry to follow", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = postingPage(null);
    await expect(automaticStart(database, jobId, page)).rejects.toThrow(`No application form was found at ${POSTING_URL}. It may sit behind an Apply button; start the run yourself from the form's address.`);
    expect(page.follows).toEqual([POSTING_URL]);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  const WORKDAY_URL = "https://fixturechips.wd5.myworkdayjobs.com/External/job/US-CA-Santa-Clara/Robotics-Intern_JR1000001?source=Eightfold";
  const workdayStep: Step = { url: WORKDAY_URL, controls: [{ tag: "button", label: "Apply" }], body: "Robotics Intern\nApply" };

  it("hands an Apply entry that reaches a Workday posting to the Workday gates, and stops without a Workday sign-in", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = postingPage(workdayStep);
    const stopped = automaticStart(database, jobId, page);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/opens .*Workday posting at fixturechips\.wd5\.myworkdayjobs\.com/);
    expect(page.follows).toEqual([POSTING_URL]);
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("continues a candidate-started run in the Workday run once the posting page is closed", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    const posting = postingPage(workdayStep);
    let postingClosed = false;
    const close = posting.close;
    posting.close = async () => {
      postingClosed = true;
      await close();
    };
    const opened: Array<{ url: string; postingClosed: boolean }> = [];
    const stopped = startBrowserRun(jobId, POSTING_URL, {
      database, dataDir: disposableDataDir(), voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
      openPage: async (url: string) => {
        opened.push({ url, postingClosed });
        if (url === POSTING_URL) return posting;
        throw new Error("workday page opened");
      }
    });
    await expect(stopped).rejects.toThrow("workday page opened");
    expect(opened).toEqual([{ url: POSTING_URL, postingClosed: false }, { url: WORKDAY_URL, postingClosed: true }]);
    expect(posting.filled.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });
});

describe("runs that never reached an application form", () => {
  const ORACLE_JOB = "https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001";
  const POSTING_URL = "https://careers.fixturerobotics.example/jobs/1001";
  /**
   * An Oracle Candidate Experience posting: a read-only copy-link box and the Apply Now button, no question.
   * The page's control reader never reports a text box's value, so the box carries none here either.
   */
  const ORACLE_POSTING: RawControl[] = [
    { tag: "input", type: "text", id: "copy-link-00000000-0000-4000-8000-000000000001", label: "Copy link" },
    { tag: "button", label: "Apply Now" }
  ];
  /** A cookie preference panel's toggles and vendor search, read as optional controls. */
  const CONSENT_PANEL: RawControl[] = [
    { tag: "input", type: "checkbox", id: "ot-group-id-C0004", name: "ot-group-id-C0004", label: "Targeting Cookies", required: false },
    { tag: "input", type: "checkbox", id: "ot-group-id-C0002", name: "ot-group-id-C0002", label: "Performance Cookies", required: false },
    { tag: "input", type: "checkbox", id: "chkbox-id", label: "checkbox label", required: false },
    { tag: "input", type: "text", id: "vendor-search-handler", name: "vendor-search-handler", label: "vendor-search-handler", required: false },
    { tag: "input", type: "radio", id: "switch", name: "switch", label: "Switch Label", required: false, options: ["on"] },
    { tag: "button", label: "Apply" }
  ];
  const FORM: RawControl[] = [
    { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
    { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
    { tag: "button", label: "Submit application" }
  ];
  function qualifiedExternalJob(database: DatabaseSync): string {
    const jobId = approvedJobId(database, "qualified");
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    prepareApplication(jobId, { database });
    return jobId;
  }
  function approvedExternalJob(database: DatabaseSync): string {
    const jobId = approvedJobId(database);
    setApplicationType(database, jobId, "EXTERNAL_ATS");
    return jobId;
  }
  const start = (database: DatabaseSync, jobId: string, url: string, page: BrowserPage, automatic: boolean) => startBrowserRun(jobId, url, {
    database, dataDir: disposableDataDir(), automatic, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page
  });

  it("stops an automatic run on an Oracle posting whose only control is a copy-link box, saving nothing", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const before = jobStatus(database, jobId);
    const page = fakePage({ url: ORACLE_JOB, title: "Robotics Software Intern - Fixture Careers", controls: ORACLE_POSTING, body: "Robotics Software Intern\nApply Now" });
    const stopped = start(database, jobId, ORACLE_JOB, page, true);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/^No application form was reached at /);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    expect(jobStatus(database, jobId)).toBe(before);
    expect(jobStatus(database, jobId)).not.toBe("APPLYING");
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    database.close();
  });

  it("stops an automatic run whose page shows only a cookie preference panel's toggles", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const page = fakePage({ url: POSTING_URL, title: "Robotics Software Intern", controls: CONSENT_PANEL, body: "Robotics Software Intern\nApply" });
    const stopped = start(database, jobId, POSTING_URL, page, true);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/^No application form was reached at /);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    expect(jobStatus(database, jobId)).not.toBe("APPLYING");
    expect(page.filled.size).toBe(0);
    database.close();
  });

  it("stops a run the candidate started on the same page with the same reason, saving nothing", async () => {
    const database = disposableDatabase();
    const jobId = approvedExternalJob(database);
    const page = fakePage({ url: ORACLE_JOB, title: "Robotics Software Intern - Fixture Careers", controls: ORACLE_POSTING, body: "Robotics Software Intern\nApply Now" });
    const stopped = start(database, jobId, ORACLE_JOB, page, false);
    await expect(stopped).rejects.toThrow(`No application form was reached at ${ORACLE_JOB}: the page shows no question the agent can fill or ask you about. It may sit behind an Apply button or a step the agent cannot take; start the run yourself from the form's address.`);
    await expect(stopped).rejects.not.toBeInstanceOf(AutomaticRunStopped);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    expect(page.filled.size).toBe(0);
    database.close();
  });

  it("keeps a paused run paused when the page it reopens to continue shows none of its fields", async () => {
    const database = disposableDatabase();
    const jobId = approvedExternalJob(database);
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "essay", label: "What name should appear on your badge?", required: true },
      { tag: "button", label: "Submit application" }
    ];
    const started = await start(database, jobId, POSTING_URL, fakePage({ url: POSTING_URL, controls }), false);
    expect(started.run.status).toBe("paused-needs-input");
    await answerRunPause(started.run.id, "essay", "Jordan", true, { database });
    const elsewhere = fakePage({ url: POSTING_URL, controls: [{ tag: "button", label: "Apply" }] });
    await expect(continueBrowserRun(started.run.id, { database, dataDir: disposableDataDir(), openPage: async () => elsewhere }))
      .rejects.toThrow(/No application form was reached/);
    expect(getBrowserRuns(jobId, database)[0]!.status).toBe("paused-needs-input");
    expect(elsewhere.filled.size).toBe(0);
    database.close();
  });

  it("never clicks submit when the approved form is gone from the page it reopens", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    const clicked = { clicked: false };
    const gone = fakePage({ submitted: clicked, controls: [{ tag: "button", label: "Submit application" }] });
    await expect(submitBrowserRun(started.run.id, { database, dataDir, openPage: async () => gone }))
      .rejects.toThrow(/application form was not found .* nothing was clicked/);
    expect(clicked.clicked).toBe(false);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("awaiting-approval");
    expect(run.submissionApprovedAt).not.toBe(null);
    database.close();
  });

  it("walks an unrecognized site to its form, fills it there, and saves the address the walk reached", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const state: { url: string; controls: RawControl[]; body: string; title: string } = {
      url: POSTING_URL, controls: [{ tag: "button", label: "Apply" }], body: "Robotics Software Intern\nApply", title: "Robotics Software Intern"
    };
    const walks: string[] = [];
    const page = Object.assign(fakePage(state), {
      followApplyEntry: async () => null,
      advanceToApplicationForm: async () => {
        walks.push(state.url);
        Object.assign(state, { url: `${POSTING_URL}/application`, controls: FORM, body: "Apply for Robotics Software Intern" });
        return { url: state.url, moved: true, hops: [{ kind: "apply" as const, text: "Apply" }], stop: "form" as const };
      }
    });
    const started = await start(database, jobId, POSTING_URL, page, true);
    expect(walks).toEqual([POSTING_URL]);
    expect(page.filled.get("q1")).toBe("06/01/2027");
    expect(page.uploads.has("resume")).toBe(true);
    expect(started.run.applicationUrl).toBe(`${POSTING_URL}/application`);
    expect(started.run.atsKind).toBe("unknown");
    expect(started.run.suggestedAtsKind).toBeNull();
    database.close();
  });

  it("names Oracle's email step before anything is typed, on automatic and candidate-started runs", async () => {
    const emailStep: RawControl[] = [
      { tag: "input", type: "email", id: "primary-email", label: "Email Address", required: true },
      { tag: "input", type: "checkbox", id: "legal-disclaimer", label: "I agree with the terms and conditions", required: true },
      { tag: "button", label: "Next" }
    ];
    const url = `${ORACLE_JOB}/apply/email`;
    const message = "Oracle Cloud HCM asks for your email at fixture.fa.ocs.oraclecloud.com, then emails you a one-time code, before its application form; the agent does not take that step yet. Apply in your own browser.";
    for (const automatic of [true, false]) {
      const database = disposableDatabase();
      const jobId = automatic ? qualifiedExternalJob(database) : approvedExternalJob(database);
      const page = fakePage({ url, title: "Robotics Software Intern - Fixture Careers", controls: emailStep, body: "Email Address\nI agree with the terms and conditions\nNext" });
      const stopped = start(database, jobId, url, page, automatic);
      await expect(stopped).rejects.toThrow(message);
      if (automatic) await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
      else await expect(stopped).rejects.not.toBeInstanceOf(AutomaticRunStopped);
      expect(page.filled.size).toBe(0);
      expect(getBrowserRuns(jobId, database)).toEqual([]);
      database.close();
    }
  });

  it("stops at the first page of a several-page form on an unrecognized site, typing nothing", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const url = `${POSTING_URL}/apply`;
    const page = Object.assign(fakePage({ url, controls: FORM, body: "Step 1 of 5" }), {
      stepButtons: async () => ({ submit: false, next: "Next" })
    });
    const stopped = start(database, jobId, url, page, true);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(`The application at careers.fixturerobotics.example continues over several pages (its button says "Next"), and the agent fills several-page forms only on sites it has an adapter for. Finish this application in your own browser.`);
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("names a posting page that says the job is closed, on automatic and candidate-started runs", async () => {
    for (const automatic of [true, false]) {
      const database = disposableDatabase();
      const jobId = automatic ? qualifiedExternalJob(database) : approvedExternalJob(database);
      const page = fakePage({ url: POSTING_URL, title: "Job Not Found", controls: [{ tag: "button", label: "Apply" }], body: "We're sorry, that job does not exist or is not currently active." });
      const stopped = start(database, jobId, POSTING_URL, page, automatic);
      await expect(stopped).rejects.toThrow(/says "that job does not exist or is not currently active": the posting looks closed/);
      if (automatic) {
        await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
        await expect(stopped).rejects.toBeInstanceOf(PostingClosed);
      } else await expect(stopped).rejects.not.toBeInstanceOf(AutomaticRunStopped);
      expect(page.filled.size).toBe(0);
      expect(getBrowserRuns(jobId, database)).toEqual([]);
      database.close();
    }
  });

  it("skips a careers page that says the posting is closed as \"Posting closed\" in the pipeline, once, and never runs it again", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = qualifiedExternalJob(database);
    const report = await advancePipeline({
      database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null,
      openPage: async () => fakePage({ url: POSTING_URL, title: "Job Not Found", controls: [{ tag: "button", label: "Apply" }], body: "We're sorry, that job does not exist or is not currently active." })
    });
    expect(report.stopped).toEqual([]);
    expect(report.skipped).toEqual([{ jobId, reasons: [expect.stringMatching(/^Posting closed: The posting page at careers\.fixturerobotics\.example says "that job does not exist or is not currently active"/)] }]);
    expect(getDiscoverySkip(database, jobId)?.reason).toBe("Posting closed");
    const details = (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
    expect(details.filter((detail) => detail.startsWith("Automatic browser run found the posting closed: "))).toHaveLength(1);
    expect(details.some((detail) => detail.startsWith("Automatic browser run needs you: "))).toBe(false);
    expect(getBrowserRuns(jobId, database)).toEqual([]);

    const second = await advancePipeline({
      database, dataDir, settings: { minFit: 0, autoApply: true }, voiceDrafter: null, openPage: async () => { throw new Error("must not run a closed posting"); }
    });
    expect(second.started).toEqual([]);
    expect(second.stopped).toEqual([]);
    expect(second.errors).toEqual([]);
    database.close();
  });

  it("never applies the several-page stop to a supported adapter's site", async () => {
    const database = disposableDatabase();
    const jobId = qualifiedExternalJob(database);
    const url = "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001";
    const page = Object.assign(fakePage({ url, title: "Job Application for Robotics Software Intern at Fixture Robotics", controls: FORM, body: "Powered by Greenhouse" }), {
      stepButtons: async () => ({ submit: false, next: "Next" })
    });
    const started = await start(database, jobId, url, page, true);
    expect(started.run.atsKind).toBe("greenhouse");
    expect(page.filled.get("q1")).toBe("06/01/2027");
    expect(getBrowserRuns(jobId, database)).toHaveLength(1);
    database.close();
  });
});

describe("post-submit outcomes", () => {
  const wait = { timeoutMs: 50, pollMs: 5 };
  const START_DATE_ERROR: InvalidField = { ref: "q1", label: "What is your available start date?", error: "This field is required." };
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const EVIDENCE_EVENT = /^Post-submit evidence saved \((field-errors|refused|challenged|verification-code|unknown)\): applications\/[0-9a-f-]{36}\/submit-evidence\/[0-9TZ-]+-[0-9a-f-]{36}; view it with pnpm run:evidence --run [0-9a-f]{8}\.$/;

  /** A fake page whose submit click never confirms; what it shows afterwards is set per test. */
  function outcomePage(options: {
    invalidAfter?: InvalidField[];
    alert?: string;
    body?: string;
    challenge?: boolean;
    screenshot?: "write" | "throw";
    flag?: { clicked: boolean };
  } = {}): BrowserPage {
    const flag = options.flag ?? { clicked: false };
    const base = fakePage({ submitted: flag, confirmation: options.body ?? "Please fix the errors below. FIXTURE-PAGE-TEXT" });
    return {
      ...base,
      invalidFields: async () => (flag.clicked ? options.invalidAfter ?? [] : []),
      submitControlShown: async () => true,
      alertText: async () => (flag.clicked ? options.alert ?? "" : ""),
      visibleChallenge: async () => (options.challenge && flag.clicked ? { kind: "recaptcha" as const, detail: "a reCAPTCHA image challenge" } : null),
      screenshot: async (path: string) => {
        if (options.screenshot === "throw") throw new Error("Target page, context or browser has been closed");
        writeFileSync(path, PNG_BYTES);
      }
    };
  }

  async function approvedRun(database: DatabaseSync, dataDir: string, jobId: string): Promise<string> {
    const started = await startBrowserRun(jobId, "https://app.joinhandshake.com/apply/900001", { database, dataDir, openPage: async () => fakePage() });
    expect(started.run.status).toBe("awaiting-approval");
    approveRunSubmission(started.run.id, undefined, { database });
    return started.run.id;
  }

  function evidenceFolders(dataDir: string, jobId: string): Array<{ dir: string; json: Record<string, unknown> }> {
    const root = submitEvidenceRoot(dataDir, jobId);
    if (!existsSync(root)) return [];
    return readdirSync(root).map((name) => {
      const dir = join(root, name);
      return { dir, json: JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")) as Record<string, unknown> };
    });
  }

  const mode = (path: string) => statSync(path).mode & 0o777;

  function evidenceEvents(database: DatabaseSync, jobId: string): string[] {
    return (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY created_at").all(jobId) as Array<{ detail: string | null }>)
      .map((row) => row.detail ?? "")
      .filter((detail) => detail.startsWith("Post-submit evidence"));
  }

  function expectPrivateEvidence(database: DatabaseSync, dataDir: string, jobId: string, outcome: string) {
    const folders = evidenceFolders(dataDir, jobId);
    expect(folders).toHaveLength(1);
    const { dir, json } = folders[0]!;
    expect(json.outcome).toBe(outcome);
    expect(mode(submitEvidenceRoot(dataDir, jobId))).toBe(0o700);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "evidence.json"))).toBe(0o600);
    if (json.screenshot) expect(mode(join(dir, "screenshot.png"))).toBe(0o600);
    const events = evidenceEvents(database, jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(EVIDENCE_EVENT);
    expect(events[0]).toContain(`(${outcome})`);
    expect(events[0]).not.toContain(dataDir);
    expect(events[0]).not.toContain(tmpdir());
    expect(events[0]).not.toContain("@");
    return { dir, json };
  }

  it("pauses a run whose submit click brings back field errors, with the approval withdrawn and evidence kept", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    const flag = { clicked: false };
    const failure = await submitBrowserRun(runId, {
      database, dataDir, submitWait: wait,
      openPage: async () => outcomePage({ flag, invalidAfter: [START_DATE_ERROR], alert: "This field is required." })
    }).catch((error: unknown) => error);
    expect(flag.clicked).toBe(true);
    expect(failure).toBeInstanceOf(SubmissionNeedsInput);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expect(run.pauses).toEqual([expect.objectContaining({
      fieldId: "q1", status: "open", safeguard: false, question: "What is your available start date?: This field is required."
    })]);
    expect(run.decisions.find((decision) => decision.fieldId === "q1")).toMatchObject({ action: "pause" });
    expect(jobStatus(database, jobId)).not.toBe("SUBMITTED");
    const { dir, json } = expectPrivateEvidence(database, dataDir, jobId, "field-errors");
    expect(json.invalidFields).toEqual([START_DATE_ERROR]);
    expect(json.screenshot).toBe("screenshot.png");
    expect(readFileSync(join(dir, "screenshot.png"))).toEqual(Buffer.from(PNG_BYTES));
    database.close();
  });

  it("lists an automatic submit refused with field errors as held, without page text, and never restarts it", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database, "qualified");
    saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
      score: 86, rating: "STRONG", confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
      decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
    });
    const settings: PipelineSettings = { minFit: 0, autoApply: true, target: { season: "summer", year: 2027 }, autoSubmit: { minFit: 80, dailyCap: 5 } };
    const flag = { clicked: false };
    let opens = 0;
    const report = await advancePipeline({
      database, dataDir, settings, voiceDrafter: null, submitWait: wait,
      openPage: async () => {
        opens += 1;
        return opens === 1 ? fakePage() : outcomePage({ flag, invalidAfter: [START_DATE_ERROR], alert: "This field is required." });
      }
    });
    expect(flag.clicked).toBe(true);
    expect(report.submitted).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(report.held).toEqual([{ jobId, reasons: [expect.stringContaining("marked 1 field(s) invalid")] }]);
    expect(JSON.stringify(report)).not.toContain("This field is required");
    expect(JSON.stringify(report)).not.toContain("FIXTURE-PAGE-TEXT");
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("paused-needs-input");
    expect(run.submissionApprovedAt).toBeNull();
    expectPrivateEvidence(database, dataDir, jobId, "field-errors");
    const second = await advancePipeline({
      database, dataDir, settings, voiceDrafter: null, submitWait: wait,
      openPage: async () => { throw new Error("must not retry"); }
    });
    expect(second.started).toEqual([]);
    expect(second.submitted).toEqual([]);
    expect(getBrowserRuns(jobId, database)).toHaveLength(1);
    database.close();
  });

  it("fails a run the site refused with a banner, keeps the approval, and saves the evidence", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    const failure = await submitBrowserRun(runId, {
      database, dataDir, submitWait: wait,
      openPage: async () => outcomePage({ alert: "There was a problem submitting your application." })
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionRefused);
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("failed");
    expect(run.submissionApprovedAt).not.toBeNull();
    const { json } = expectPrivateEvidence(database, dataDir, jobId, "refused");
    expect(json.alertText).toBe("There was a problem submitting your application.");
    database.close();
  });

  it("saves evidence when a CAPTCHA appears after the submit click", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    const failure = await submitBrowserRun(runId, {
      database, dataDir, submitWait: wait, openPage: async () => outcomePage({ challenge: true })
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionChallenged);
    expect(getBrowserRuns(jobId, database)[0]!.status).toBe("failed");
    const { json } = expectPrivateEvidence(database, dataDir, jobId, "challenged");
    expect(json.challenge).toBe("a reCAPTCHA image challenge");
    database.close();
  });

  it("fails closed when nothing is recognized, with the old message and redacted evidence", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    const body = "Please review your application.\nContact jordan@example.test about it.\nSee https://jobs.example.test/fixture/apply?token=abc for details.";
    const failure = await submitBrowserRun(runId, {
      database, dataDir, submitWait: wait, openPage: async () => outcomePage({ body })
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SubmissionUnconfirmed);
    expect((failure as Error).message).toBe("The submit button was clicked but no new confirmation appeared. Check the application on the site before retrying; the run is not marked submitted.");
    const run = getBrowserRuns(jobId, database)[0]!;
    expect(run.status).toBe("failed");
    expect(run.submissionApprovedAt).not.toBeNull();
    const { dir, json } = expectPrivateEvidence(database, dataDir, jobId, "unknown");
    expect(mode(join(dir, "screenshot.png"))).toBe(0o600);
    expect(json.invalidFields).toEqual([]);
    expect(json.text).toContain("Contact [email] about it.");
    expect(json.text).toContain("https://jobs.example.test/fixture/apply for details.");
    expect(readFileSync(join(dir, "evidence.json"), "utf8")).not.toContain("jordan@example.test");
    expect(readFileSync(join(dir, "evidence.json"), "utf8")).not.toContain("?token");
    database.close();
  });

  it("saves no evidence for a confirmed submission", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    const submitted = await submitBrowserRun(runId, { database, dataDir, submitWait: wait, applicationRecord: null, openPage: async () => fakePage() });
    expect(submitted.status).toBe("submitted");
    expect(existsSync(submitEvidenceRoot(dataDir, jobId))).toBe(false);
    expect(evidenceEvents(database, jobId)).toEqual([]);
    database.close();
  });

  it("still saves evidence.json when the screenshot fails", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    const runId = await approvedRun(database, dataDir, jobId);
    await expect(submitBrowserRun(runId, {
      database, dataDir, submitWait: wait, openPage: async () => outcomePage({ screenshot: "throw" })
    })).rejects.toBeInstanceOf(SubmissionUnconfirmed);
    const { dir, json } = expectPrivateEvidence(database, dataDir, jobId, "unknown");
    expect(json.screenshot).toBeNull();
    expect(existsSync(join(dir, "screenshot.png"))).toBe(false);
    database.close();
  });

  describe("Greenhouse's emailed security code", () => {
    // Fictional codes; the step's wording follows third-party descriptions, not a capture.
    const CODE = "K7QPZXMW";
    const OTHER_CODE = "R4TV9BNC";
    // Automatic submits start on this Greenhouse address too: the policy submits only on the recognized kind's own site (Track 38).
    const CODE_STEP_URL = "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001";
    const STEP_TEXT = "Robotics Software Intern. We sent an 8-character security code to your email address. Enter it below, then submit your application again.";
    const codeWait = { pollMs: 1, timeoutMs: 50, sleep: async () => undefined };

    /** A fake Greenhouse page whose submit click shows the emailed security-code step; a matching code confirms. */
    function codeStepPage(options: { flag?: { clicked: boolean }; echo?: boolean; stillAsks?: boolean } = {}) {
      const flag = options.flag ?? { clicked: false };
      const base = fakePage({ submitted: flag, url: CODE_STEP_URL });
      const entry = { calls: 0, matched: false, typed: null as string | null, screenshots: 0 };
      const accepted = () => entry.typed !== null && !options.stillAsks;
      const page: BrowserPage = {
        ...base,
        bodyText: async () => {
          if (accepted()) return `Thank you for applying. Your application has been received.${options.echo ? ` Reference ${entry.typed}.` : ""}`;
          if (flag.clicked) return `${STEP_TEXT}${options.echo && entry.typed ? ` You typed ${entry.typed}.` : ""}`;
          return "Robotics Software Intern. Please fix the errors below.";
        },
        invalidFields: async () => [],
        submitControlShown: async () => true,
        alertText: async () => "",
        visibleChallenge: async () => null,
        screenshot: async (path: string) => {
          entry.screenshots += 1;
          writeFileSync(path, PNG_BYTES);
        },
        securityCodeInputs: async () => (accepted() ? 0 : flag.clicked ? 8 : 0),
        submitSecurityCode: async (code: string) => {
          entry.calls += 1;
          entry.matched = code === CODE;
          entry.typed = code;
        }
      };
      return { page, entry, flag };
    }

    type Mail = Omit<MailMessage, "receivedAt"> & { ageMs?: number };
    const securityMail = (company: string, code = CODE, overrides: Partial<Mail> = {}): Mail => ({
      from: "Greenhouse <no-reply@us.greenhouse-mail.io>",
      subject: `Security code for your application to ${company}`,
      text: `Copy and paste this code into the security code field on your application: ${code}\n\nAfter you enter the code, resubmit your application.`,
      html: "",
      ...overrides
    });
    /** A mailbox that only ever returns these messages, received `ageMs` before each read (default: just now). */
    function fakeMailbox(messages: Mail[]): VerificationMailboxFactory {
      return async () => ({
        messagesSince: async (_since, relevant) => messages
          .map(({ ageMs, ...message }) => ({ ...message, receivedAt: new Date(Date.now() - (ageMs ?? 0)) }))
          .filter((message) => relevant({ from: message.from, subject: message.subject })),
        close: async () => undefined
      });
    }
    const companyOf = (database: DatabaseSync, jobId: string) => getJobPosting(database, jobId)!.companyName;

    async function heldFor(mailbox: (company: string) => VerificationMailboxFactory | null) {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const runId = await approvedRun(database, dataDir, jobId);
      const step = codeStepPage();
      const failure = await submitBrowserRun(runId, {
        database, dataDir, submitWait: wait, applicationRecord: null, openPage: async () => step.page,
        securityCodeMailbox: mailbox(companyOf(database, jobId)), securityCodeWait: codeWait
      }).catch((error: unknown) => error);
      return { database, dataDir, jobId, runId, step, failure };
    }

    function expectCodeHold(held: Awaited<ReturnType<typeof heldFor>>, message: string) {
      const { database, dataDir, jobId, runId, step, failure } = held;
      expect(step.flag.clicked).toBe(true);
      expect(failure).toBeInstanceOf(SubmissionCodeNotFound);
      expect((failure as Error).message).toBe(message);
      const run = getBrowserRuns(jobId, database)[0]!;
      expect(run.status).toBe("paused-needs-input");
      expect(run.submissionApprovedAt).toBeNull();
      const open = run.pauses.filter((pause) => pause.status === "open" && pause.fieldId === "site-security-code");
      expect(open).toEqual([expect.objectContaining({ fieldId: "site-security-code", safeguard: true, label: "Emailed security code" })]);
      expect(open[0]!.question.startsWith(message.startsWith("Greenhouse emailed a security code; it was not found") ? "Greenhouse emailed a security code; it was not found" : message)).toBe(true);
      expect(open[0]!.question).toContain(`pnpm pipeline:retry --run ${runId.slice(0, 8)}`);
      expect(run.decisions.find((decision) => decision.fieldId === "site-security-code")).toMatchObject({ action: "pause", pause: { safeguard: true } });
      expect(jobStatus(database, jobId)).not.toBe("SUBMITTED");
      const { json } = expectPrivateEvidence(database, dataDir, jobId, "verification-code");
      // Nothing was typed, so the screenshot is taken as for any hold.
      expect(json.screenshot).toBe("screenshot.png");
      expect(step.entry.calls).toBe(0);
      database.close();
    }

    it("enters the emailed code and records the submission, with the code nowhere", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = approvedJobId(database);
      const runId = await approvedRun(database, dataDir, jobId);
      const step = codeStepPage({ echo: true });
      const submitted = await submitBrowserRun(runId, {
        database, dataDir, submitWait: wait, applicationRecord: null, openPage: async () => step.page,
        securityCodeMailbox: fakeMailbox([securityMail(companyOf(database, jobId))]), securityCodeWait: codeWait
      });
      expect(submitted.status).toBe("submitted");
      expect(jobStatus(database, jobId)).toBe("SUBMITTED");
      expect(step.entry).toMatchObject({ calls: 1, matched: true });
      expect(submitted.confirmationText).toContain("Thank you for applying");
      expect(submitted.confirmationText?.includes(CODE)).toBe(false);
      expect(existsSync(submitEvidenceRoot(dataDir, jobId))).toBe(false);
      database.close();
    });

    it("holds the run with the approval withdrawn when no email arrives in time", async () => {
      expectCodeHold(await heldFor(() => fakeMailbox([])), "Greenhouse emailed a security code; it was not found in your mailbox in time, so nothing was sent. The run waits for you with the approval withdrawn; it is not marked submitted.");
    });

    it("holds the run when two different codes arrived", async () => {
      const held = await heldFor((company) => fakeMailbox([securityMail(company), securityMail(company, OTHER_CODE)]));
      expectCodeHold(held, "Greenhouse emailed a security code; it was not found unambiguously (more than one code arrived), so nothing was sent. The run waits for you with the approval withdrawn; it is not marked submitted.");
    });

    it.each<[string, (company: string) => Mail]>([
      ["another sender", (company) => securityMail(company, CODE, { from: "Fixture <no-reply@greenhouse.io.example.test>" })],
      ["another company", () => securityMail("Other Fixture Works")],
      ["mail from before the click", (company) => securityMail(company, CODE, { ageMs: 60_000 })]
    ])("holds the run for mail from %s", async (_name, mail) => {
      const held = await heldFor((company) => fakeMailbox([mail(company)]));
      expectCodeHold(held, "Greenhouse emailed a security code; it was not found in your mailbox in time, so nothing was sent. The run waits for you with the approval withdrawn; it is not marked submitted.");
    });

    it("holds the run when no mailbox is set up", async () => {
      expectCodeHold(await heldFor(() => null), "Greenhouse emailed a security code; it was not found because no mailbox is set up (INTERNSHIP_AGENT_GMAIL_ADDRESS and _APP_PASSWORD), so nothing was sent. The run waits for you with the approval withdrawn; it is not marked submitted.");
    });

    /** Every place the code could end up: database rows, files under the data directory, the console, the report, the Discord notice. */
    function expectCodeNowhere(database: DatabaseSync, dataDir: string, report: unknown, lookup: NoticeLookup, consoleCalls: unknown[]) {
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
      for (const table of tables) {
        const rows = JSON.stringify(database.prepare(`SELECT * FROM "${table}"`).all());
        expect(rows.includes(CODE), `table ${table}`).toBe(false);
      }
      const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
      for (const file of files(dataDir)) {
        const bytes = readFileSync(file);
        expect(bytes.toString("utf8").includes(CODE) || bytes.toString("latin1").includes(CODE), `file ${file}`).toBe(false);
      }
      expect(JSON.stringify(consoleCalls).includes(CODE)).toBe(false);
      expect(JSON.stringify(report).includes(CODE)).toBe(false);
      expect(formatNotice(passNoticeItems(report as Parameters<typeof passNoticeItems>[0], lookup)).includes(CODE)).toBe(false);
    }
    const noticeLookup = (database: DatabaseSync): NoticeLookup => ({
      posting: (jobId) => getJobPosting(database, jobId),
      latestRun: (jobId) => getBrowserRuns(jobId, database)[0] ?? null
    });
    const automatic: PipelineSettings = { minFit: 0, autoApply: true, target: { season: "summer", year: 2027 }, autoSubmit: { minFit: 80, dailyCap: 5 } };
    function qualifiedJob(database: DatabaseSync): string {
      const jobId = approvedJobId(database, "qualified");
      saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
        score: 86, rating: "STRONG", confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
        decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
      });
      return jobId;
    }
    async function withConsoleSpy<T>(run: () => Promise<T>): Promise<{ result: T; calls: unknown[] }> {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
      try {
        const result = await run();
        return { result, calls: spies.flatMap((spy) => spy.mock.calls) };
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    it("keeps the code out of the database, files, console, report, and notice on an automatic submit", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = qualifiedJob(database);
      const step = codeStepPage({ echo: true });
      let opens = 0;
      const { result: report, calls } = await withConsoleSpy(() => advancePipeline({
        database, dataDir, settings: automatic, voiceDrafter: null, submitWait: wait,
        securityCodeMailbox: fakeMailbox([securityMail(companyOf(database, jobId))]), securityCodeWait: codeWait,
        openPage: async () => { opens += 1; return opens === 1 ? fakePage({ url: CODE_STEP_URL }) : step.page; }
      }));
      expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("Thank you for applying") }]);
      expect(step.entry).toMatchObject({ calls: 1, matched: true });
      expect(getBrowserRuns(jobId, database)[0]!.status).toBe("submitted");
      expectCodeNowhere(database, dataDir, report, noticeLookup(database), calls);
      database.close();
    });

    it("fails closed when the step is still shown after the code, with no screenshot and the code nowhere", async () => {
      const database = disposableDatabase();
      const dataDir = disposableDataDir();
      const jobId = qualifiedJob(database);
      const step = codeStepPage({ echo: true, stillAsks: true });
      let opens = 0;
      const { result: report, calls } = await withConsoleSpy(() => advancePipeline({
        database, dataDir, settings: automatic, voiceDrafter: null, submitWait: wait,
        securityCodeMailbox: fakeMailbox([securityMail(companyOf(database, jobId))]), securityCodeWait: codeWait,
        openPage: async () => { opens += 1; return opens === 1 ? fakePage({ url: CODE_STEP_URL }) : step.page; }
      }));
      expect(report.submitted).toEqual([]);
      expect(step.entry).toMatchObject({ calls: 1, matched: true });
      const run = getBrowserRuns(jobId, database)[0]!;
      expect(run.status).toBe("failed");
      expect(run.submissionApprovedAt).not.toBeNull();
      expect(JSON.stringify(report)).toContain("still asks for it");
      const { dir, json } = expectPrivateEvidence(database, dataDir, jobId, "verification-code");
      expect(json.screenshot).toBeNull();
      expect(existsSync(join(dir, "screenshot.png"))).toBe(false);
      expect(step.entry.screenshots).toBe(0);
      expect(String(json.text)).toContain("You typed [code].");
      expectCodeNowhere(database, dataDir, report, noticeLookup(database), calls);
      database.close();
    });
  });
});
