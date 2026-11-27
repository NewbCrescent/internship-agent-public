import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabase,
  LOCAL_CANDIDATE_ID,
  listProjectEvidenceProfiles,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveCandidate,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import type { BrowserField, StandingConsentSettings } from "@internship-agent/domain";
import type { BrowserPage, OracleApplyScreen, OracleApplySteps, OracleEmailResult, OraclePinResult, RawControl } from "@internship-agent/browser";
import {
  answerRunPause,
  approveApplication,
  approveRunSubmission,
  AutomaticRunStopped,
  confirmRunAts,
  continueBrowserRun,
  evaluateAndPersistMatch,
  getBrowserRuns,
  prepareApplication,
  startBrowserRun,
  submitBrowserRun,
  type MailMessage,
  type OracleEmailStepSettings,
  type VerificationMailboxFactory
} from "@internship-agent/agent";

/**
 * Oracle Cloud HCM Candidate Experience's email and one-time-code step
 * through start, continue, and submit, with in-memory pages whose `oracle`
 * steps are scripted, and a fake mailbox. Every name, host, email, and code
 * is fictional; nothing reads the real .env, mailbox, or database.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-oracle-step-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-oracle-step-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

function saveFact(database: DatabaseSync, key: "authorized_to_work" | "requires_sponsorship" | "available_start_date", scope: { kind: "country"; code: string } | { kind: "global" }, value: boolean | string) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The seeded posting as an external application, analyzed and prepared; approved unless `qualified`. */
function externalJob(database: DatabaseSync, stopAt: "approved" | "qualified"): string {
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
  prepareApplication(row.id, { database });
  if (stopAt === "approved") approveApplication(row.id, { database });
  saveCandidate(database, LOCAL_CANDIDATE_ID, {
    fullName: "Jordan Rivera", email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera", phone: "+1 555 0100", addressCountry: "United States"
  });
  return row.id;
}

const EMAIL = "jordan@example.test";
const CODE = "482913";
const OTHER_CODE = "705162";
const HOST = "fixture.fa.ocs.oraclecloud.com";
const JOB = `https://${HOST}/hcmUI/CandidateExperience/en/sites/CX_1/job/10001`;
const EMAIL_STEP = `${JOB}/apply/email`;
const SECTION = `${JOB}/apply/section/1`;
const TERMS = "I agree with the terms and conditions and consent to the processing of my personal data";
const DATA: StandingConsentSettings = { acceptDataConsent: true, signAttestations: false };
const OFF: StandingConsentSettings = { acceptDataConsent: false, signAttestations: false };
const OLD_WALL = `Oracle Cloud HCM asks for your email at ${HOST}, then emails you a one-time code, before its application form; the agent does not take that step yet. Apply in your own browser.`;

const EMAIL_CONTROLS: RawControl[] = [
  { tag: "input", type: "email", id: "primary-email-0", label: "Email Address", required: true },
  { tag: "input", type: "checkbox", id: "legal-disclaimer-checkbox", label: TERMS, required: true },
  { tag: "button", label: "Next" }
];
const SECTION_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "firstName", label: "First Name", required: true },
  { tag: "input", type: "text", id: "lastName", label: "Last Name", required: true },
  { tag: "input", type: "email", id: "email", label: "Email Address", required: true },
  { tag: "input", type: "tel", id: "phone", label: "Phone Number", required: true },
  { tag: "button", label: "Submit" }
];
const QUESTION: RawControl = { tag: "input", type: "text", id: "robot", label: "Which robot did you build most recently?", required: true };

type Script = {
  /** What Next leads to: the form, the PIN, or a stop screen; or the email step's own result. */
  email?: "form" | "pin" | "identity" | "already-applied" | "captcha-before" | "stuck" | "unexpected";
  /** The terms statement the email step shows, or none. */
  terms?: string | null;
  /** The PIN accepts any code (`right`) or none (`wrong`). */
  pin?: "right" | "wrong";
  section?: RawControl[];
  /** The page opens at the section itself (a signed-in session), and its controls show only once formReady was awaited. */
  lateSection?: boolean;
};

/** An in-memory page at Oracle's email step whose `oracle` steps follow the script and switch to the section form. */
function oraclePage(script: Script = {}) {
  const filled = new Map<string, string>();
  const state = { url: EMAIL_STEP, controls: EMAIL_CONTROLS, body: "You don't need to have an account\nEmail Address\nNext", submitted: false };
  const calls = { submitEmail: [] as string[], statements: [] as string[], enterCode: [] as string[], formReady: 0 };
  if (script.lateSection) Object.assign(state, { url: SECTION, controls: [] as RawControl[], body: "Job application form" });
  const toForm = () => Object.assign(state, { url: SECTION, controls: script.section ?? SECTION_CONTROLS, body: "Contact Information\nFirst Name\nSubmit" });
  let screen: OracleApplyScreen = "email";
  const oracle: OracleApplySteps = {
    screen: async () => screen,
    async submitEmail(email, accept): Promise<OracleEmailResult> {
      if (script.email === "captcha-before") return { result: "captcha" };
      if (script.email === "unexpected") return { result: "unexpected" };
      const terms = script.terms === undefined ? TERMS : script.terms;
      let accepted: string | null = null;
      if (terms !== null) {
        calls.statements.push(terms);
        if (!accept(terms)) return { result: "terms-declined", statement: terms };
        accepted = terms;
      }
      calls.submitEmail.push(email);
      const clickedAt = new Date();
      if (script.email === "stuck") return { result: "stuck", detail: "Enter a valid email address.", accepted };
      const next = script.email ?? "form";
      if (next === "form") toForm();
      screen = next;
      return { result: "next", screen: next, clickedAt, accepted };
    },
    async enterCode(code): Promise<OraclePinResult> {
      calls.enterCode.push(code);
      if (script.pin === "wrong") return { result: "wrong-code" };
      toForm();
      screen = "form";
      return { result: "next", screen: "form" };
    },
    async formReady() {
      calls.formReady += 1;
      // Oracle draws the section's blocks after the page loads.
      if (script.lateSection) toForm();
      return true;
    }
  };
  const page: BrowserPage & { oracle: OracleApplySteps } = {
    oracle,
    url: () => state.url,
    title: async () => "Robotics Software Intern - Fixture Robotics Careers",
    collectControls: async () => state.controls,
    bodyText: async () => (state.submitted ? "Thank you! Your application was received." : state.body),
    fillField: async (field: BrowserField, value: string) => { filled.set(field.id, value); },
    chooseOption: async (field: BrowserField, option: string) => { filled.set(field.id, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { filled.set(field.id, String(checked)); },
    uploadFile: async () => undefined,
    clickSubmit: async () => { state.submitted = true; },
    screenshot: async () => {},
    close: async () => {}
  };
  return { page, filled, calls, state };
}

/** A mailbox serving the given codes (as Oracle mail received now), recording its use. */
function fakeMailbox(codes: string[], options: { fail?: boolean; from?: string } = {}) {
  const calls = { opened: 0, closed: 0 };
  const factory: VerificationMailboxFactory = async () => {
    calls.opened += 1;
    if (options.fail) throw new Error("imap: server text that must not appear");
    return {
      messagesSince: async (_since, relevant) => codes
        .map((code): MailMessage => ({
          from: options.from ?? "Fixture Robotics Careers <fixture.fa.sender@workflow.mail.us2.cloud.oracle.com>", subject: "Confirm your identity",
          receivedAt: new Date(), text: `Your verification code is ${code}.`, html: ""
        }))
        .filter((message) => relevant({ from: message.from, subject: message.subject })),
      close: async () => { calls.closed += 1; }
    };
  };
  return { factory, calls };
}

function settings(mailbox: VerificationMailboxFactory | null, address: string | null = EMAIL): OracleEmailStepSettings {
  return { mailbox, mailboxAddress: address, codeWait: { pollMs: 1, timeoutMs: 5, sleep: async () => {} } };
}

const start = (database: DatabaseSync, jobId: string, page: BrowserPage, automatic: boolean, oracleEmailStep: OracleEmailStepSettings | null, standingConsent = DATA) =>
  startBrowserRun(jobId, EMAIL_STEP, {
    database, dataDir: disposableDataDir(), automatic, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page,
    standingConsent, oracleEmailStep
  });

const eventDetails = (database: DatabaseSync, jobId: string) =>
  (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
const jobStatus = (database: DatabaseSync, jobId: string) => (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;

function dumpTables(database: DatabaseSync): string {
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  return JSON.stringify(tables.map((table) => database.prepare(`SELECT * FROM "${table}"`).all()));
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

const CONSENT_EVENT = `Accepted data consent: '${TERMS}' (Oracle Cloud HCM email step at ${HOST})`;

describe("Oracle's email step in a start run", () => {
  it("types the email, accepts the terms under the setting, and fills the section form (new candidate)", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    const { page, filled, calls } = oraclePage({ email: "form" });
    const mailbox = fakeMailbox([CODE]);
    const { run } = await start(database, jobId, page, true, settings(mailbox.factory));
    expect(calls.submitEmail).toEqual([EMAIL]);
    expect(run.status).toBe("awaiting-approval");
    expect(run.applicationUrl).toBe(EMAIL_STEP);
    expect(filled.get("firstName")).toBe("Jordan");
    expect(filled.get("lastName")).toBe("Rivera");
    expect(filled.get("email")).toBe(EMAIL);
    expect(filled.has("phone")).toBe(true);
    expect(eventDetails(database, jobId)).toContain(CONSENT_EVENT);
    expect(mailbox.calls.opened).toBe(0);
    database.close();
  });

  it("accepts Oracle's default terms label under the standing data-consent setting and logs it", async () => {
    const defaultTerms = "I agree with the terms and conditions";
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    const { page, calls } = oraclePage({ email: "form", terms: defaultTerms });
    const { run } = await start(database, jobId, page, true, settings(fakeMailbox([CODE]).factory));
    expect(calls.statements).toEqual([defaultTerms]);
    expect(calls.submitEmail).toEqual([EMAIL]);
    expect(run.status).toBe("awaiting-approval");
    expect(eventDetails(database, jobId).filter((detail) => detail.startsWith("Accepted"))).toEqual([
      `Accepted data consent: '${defaultTerms}' (Oracle Cloud HCM email step at ${HOST})`
    ]);
    database.close();

    const declinedDatabase = disposableDatabase();
    const declinedJobId = externalJob(declinedDatabase, "qualified");
    const declined = oraclePage({ email: "form", terms: defaultTerms });
    const stopped = start(declinedDatabase, declinedJobId, declined.page, true, settings(fakeMailbox([CODE]).factory), OFF);
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(
      `Oracle Cloud HCM at ${HOST} asks you to accept "${defaultTerms}" before applying, and your standing data-consent setting does not cover it, so nothing was typed. Apply in your own browser.`
    );
    expect(declined.calls.submitEmail).toEqual([]);
    expect(declined.filled.size).toBe(0);
    expect(getBrowserRuns(declinedJobId, declinedDatabase)).toEqual([]);
    expect(eventDetails(declinedDatabase, declinedJobId).some((detail) => detail.startsWith("Accepted"))).toBe(false);
    declinedDatabase.close();
  });

  it("reads the emailed code once and enters it, and the code reaches no row, log, or report", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    const before = occurrences(dumpTables(database), CODE);
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    const { page, calls } = oraclePage({ email: "pin" });
    const mailbox = fakeMailbox([CODE]);
    const report = await start(database, jobId, page, true, settings(mailbox.factory));
    expect(calls.enterCode).toEqual([CODE]);
    expect(mailbox.calls).toEqual({ opened: 1, closed: 1 });
    expect(report.run.status).toBe("awaiting-approval");
    expect(getBrowserRuns(jobId, database)).toHaveLength(1);
    expect(occurrences(dumpTables(database), CODE)).toBe(before);
    expect(logged.some((line) => line.includes(CODE))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(CODE);
    database.close();
  });

  it("reads a code mailed from the posting's careers domain, naming neither the company nor the tenant (Track 63)", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    database.prepare("UPDATE jobs SET company_careers_url = ? WHERE id = ?").run("https://careers.northwind-group.example/jobs", jobId);
    const { page, calls } = oraclePage({ email: "pin" });
    const mailbox = fakeMailbox([CODE], { from: "STAFFING <staffing@mail.northwind-group.example>" });
    const report = await start(database, jobId, page, true, settings(mailbox.factory));
    expect(calls.enterCode).toEqual([CODE]);
    expect(report.run.status).toBe("awaiting-approval");
    database.close();
  });

  it("waits for a section page's form when the run opens at the section (Track 63, Corvane-shaped)", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    const { page, filled, calls } = oraclePage({ lateSection: true });
    const report = await startBrowserRun(jobId, SECTION, {
      database, dataDir: disposableDataDir(), automatic: true, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page,
      standingConsent: DATA, oracleEmailStep: settings(fakeMailbox([CODE]).factory)
    });
    expect(calls.formReady).toBe(1);
    expect(calls.submitEmail).toEqual([]);
    expect(report.run.status).toBe("awaiting-approval");
    expect(filled.get("firstName")).toBe("Jordan");
    expect(getBrowserRuns(jobId, database)).toHaveLength(1);
    database.close();
  });

  const stops: Array<{ name: string; script: Script; mailbox?: () => ReturnType<typeof fakeMailbox>; standing?: StandingConsentSettings; reason: string; typed: boolean; codes?: number }> = [
    {
      name: "no code arrives", script: { email: "pin" }, mailbox: () => fakeMailbox([]), typed: true, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} emailed you a one-time code, and none arrived in your mailbox within 1 minutes, so none was entered. Start the run again later, or apply in your own browser.`
    },
    {
      name: "two codes arrive", script: { email: "pin" }, mailbox: () => fakeMailbox([CODE, OTHER_CODE]), typed: true, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} emailed you a one-time code, and more than one code arrived, so none was entered. Apply in your own browser.`
    },
    {
      name: "the mailbox fails", script: { email: "pin" }, mailbox: () => fakeMailbox([CODE], { fail: true }), typed: true, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} emailed you a one-time code, and the mailbox could not be read (the mailbox could not be opened), so none was entered. Start the run again later, or apply in your own browser.`
    },
    {
      name: "the code is refused", script: { email: "pin", pin: "wrong" }, typed: true, codes: 1,
      reason: `Oracle Cloud HCM at ${HOST} did not accept the emailed code. The agent does not try again (Oracle locks the email after repeated wrong codes); apply in your own browser.`
    },
    {
      name: "an identity check follows", script: { email: "identity" }, typed: true, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} asks you to confirm your identity for this email (last name, date of birth, email, or phone) before the application; the agent does not answer that step. Apply in your own browser.`
    },
    {
      name: "the candidate already applied", script: { email: "already-applied" }, typed: true, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} says you already applied to this job; nothing was submitted. Check the application on the site.`
    },
    {
      name: "a CAPTCHA shows on the email step", script: { email: "captcha-before" }, typed: false, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} shows a CAPTCHA on its email step; the agent never solves CAPTCHAs, so nothing was typed. Apply in your own browser.`
    },
    {
      name: "the terms are not covered", script: { email: "form" }, standing: OFF, typed: false, codes: 0,
      reason: `Oracle Cloud HCM at ${HOST} asks you to accept "${TERMS}" before applying, and your standing data-consent setting does not cover it, so nothing was typed. Apply in your own browser.`
    }
  ];

  for (const entry of stops) {
    it(`stops truthfully when ${entry.name}, saving no run`, async () => {
      const database = disposableDatabase();
      const jobId = externalJob(database, "qualified");
      const status = jobStatus(database, jobId);
      const { page, filled, calls } = oraclePage(entry.script);
      const mailbox = (entry.mailbox ?? (() => fakeMailbox([CODE])))();
      const stopped = start(database, jobId, page, true, settings(mailbox.factory), entry.standing ?? DATA);
      await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
      await expect(stopped).rejects.toThrow(entry.reason);
      expect(calls.submitEmail).toEqual(entry.typed ? [EMAIL] : []);
      expect(calls.enterCode).toHaveLength(entry.codes ?? 0);
      expect(filled.size).toBe(0);
      expect(getBrowserRuns(jobId, database)).toEqual([]);
      expect(jobStatus(database, jobId)).toBe(status);
      if (entry.standing === OFF) expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Accepted"))).toBe(false);
      const error = await stopped.catch((caught: unknown) => caught as Error);
      expect(error.message).not.toContain(EMAIL);
      expect(error.message).not.toContain(CODE);
      database.close();
    });
  }

  const before: Array<{ name: string; candidateEmail: string | null; mailbox: boolean; address: string | null; reason: string }> = [
    {
      name: "the profile has no email", candidateEmail: null, mailbox: true, address: EMAIL,
      reason: `Oracle Cloud HCM at ${HOST} asks for your email first, and your profile has no email. Add it on the profile page, then start the run again.`
    },
    {
      name: "there is no mailbox", candidateEmail: EMAIL, mailbox: false, address: null,
      reason: `Oracle Cloud HCM at ${HOST} asks for your email and may email you a one-time code, and the agent has no mailbox to read it from (INTERNSHIP_AGENT_GMAIL_ADDRESS and INTERNSHIP_AGENT_GMAIL_APP_PASSWORD). Nothing was typed. Apply in your own browser, or set up the mailbox.`
    },
    {
      name: "the mailbox is another address", candidateEmail: EMAIL, mailbox: true, address: "someone.else@example.test",
      reason: `Oracle Cloud HCM at ${HOST} would email its one-time code to your profile email, which is not the mailbox the agent reads (INTERNSHIP_AGENT_GMAIL_ADDRESS). Nothing was typed. Apply in your own browser.`
    }
  ];

  for (const entry of before) {
    it(`stops before typing anything when ${entry.name}`, async () => {
      const database = disposableDatabase();
      const jobId = externalJob(database, "qualified");
      if (entry.candidateEmail === null) database.prepare("UPDATE candidates SET email = NULL").run();
      const { page, calls } = oraclePage({ email: "form" });
      const mailbox = fakeMailbox([CODE]);
      const stopped = start(database, jobId, page, true, settings(entry.mailbox ? mailbox.factory : null, entry.address));
      await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
      await expect(stopped).rejects.toThrow(entry.reason);
      expect(calls.submitEmail).toEqual([]);
      expect(calls.statements).toEqual([]);
      expect(mailbox.calls.opened).toBe(0);
      expect(getBrowserRuns(jobId, database)).toEqual([]);
      database.close();
    });
  }

  it("keeps today's email-step stop when the step is turned off", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "qualified");
    const { page, calls } = oraclePage({ email: "form" });
    const stopped = start(database, jobId, page, true, null);
    await expect(stopped).rejects.toThrow(OLD_WALL);
    expect(calls.submitEmail).toEqual([]);
    database.close();
  });

  it("stops a candidate-started run with a plain error", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "approved");
    const { page } = oraclePage({ email: "identity" });
    const stopped = start(database, jobId, page, false, settings(fakeMailbox([CODE]).factory));
    await expect(stopped).rejects.toThrow("asks you to confirm your identity");
    await expect(stopped).rejects.not.toBeInstanceOf(AutomaticRunStopped);
    database.close();
  });
});

describe("Oracle's email step in continue and submit", () => {
  it("takes the step again on continue and fills the answered pause", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "approved");
    const section = [...SECTION_CONTROLS.slice(0, 4), QUESTION, SECTION_CONTROLS[4]!];
    const first = oraclePage({ email: "form", section });
    const { run } = await start(database, jobId, first.page, false, settings(fakeMailbox([CODE]).factory));
    expect(run.status).toBe("paused-needs-input");
    expect(run.applicationUrl).toBe(EMAIL_STEP);
    await answerRunPause(run.id, "robot", "A line-following rover.", false, { database });
    const again = oraclePage({ email: "pin", section });
    const mailbox = fakeMailbox([CODE]);
    const continued = await continueBrowserRun(run.id, {
      database, dataDir: disposableDataDir(), openPage: async () => again.page, renderPdf: async () => ({ pages: 1 }),
      standingConsent: DATA, oracleEmailStep: settings(mailbox.factory)
    });
    expect(again.calls.submitEmail).toEqual([EMAIL]);
    expect(again.calls.enterCode).toEqual([CODE]);
    expect(again.filled.get("robot")).toBe("A line-following rover.");
    expect(continued.run.status).toBe("awaiting-approval");
    database.close();
  });

  it("takes the step again on submit and submits; a stop there keeps the run waiting for approval", async () => {
    const database = disposableDatabase();
    const jobId = externalJob(database, "approved");
    const first = oraclePage({ email: "form" });
    const { run } = await start(database, jobId, first.page, false, settings(fakeMailbox([CODE]).factory));
    expect(run.status).toBe("awaiting-approval");
    confirmRunAts(run.id, "unknown", { database });
    approveRunSubmission(run.id, undefined, { database });

    const refused = oraclePage({ email: "pin", pin: "wrong" });
    const failure = submitBrowserRun(run.id, {
      database, dataDir: disposableDataDir(), openPage: async () => refused.page, renderPdf: async () => ({ pages: 1 }),
      applicationRecord: null, securityCodeMailbox: null, standingConsent: DATA, oracleEmailStep: settings(fakeMailbox([CODE]).factory),
      submitWait: { timeoutMs: 200, pollMs: 10 }
    });
    await expect(failure).rejects.toThrow(`Oracle Cloud HCM at ${HOST} did not accept the emailed code. The agent does not try again (Oracle locks the email after repeated wrong codes); apply in your own browser. Nothing was submitted, and the run still waits for approval.`);
    const waiting = getBrowserRuns(jobId, database)[0]!;
    expect(waiting.status).toBe("awaiting-approval");
    expect(waiting.submissionApprovedAt).not.toBeNull();
    expect(refused.state.submitted).toBe(false);

    const accepted = oraclePage({ email: "pin" });
    const submitted = await submitBrowserRun(run.id, {
      database, dataDir: disposableDataDir(), openPage: async () => accepted.page, renderPdf: async () => ({ pages: 1 }),
      applicationRecord: null, securityCodeMailbox: null, standingConsent: DATA, oracleEmailStep: settings(fakeMailbox([CODE]).factory),
      submitWait: { timeoutMs: 2_000, pollMs: 10 }
    });
    expect(accepted.calls.enterCode).toEqual([CODE]);
    expect(accepted.filled.get("firstName")).toBe("Jordan");
    expect(accepted.state.submitted).toBe(true);
    expect(submitted.status).toBe("submitted");
    expect(jobStatus(database, jobId)).toBe("SUBMITTED");
    database.close();
  });
});
