import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
import {
  CONSENT_QUESTION,
  SIGNATURE_QUESTION,
  submitEvidenceRoot,
  type BrowserPage,
  type IcimsAccountScreen,
  type IcimsAccountSteps,
  type IcimsProfileInput,
  type JobviteConsentOutcome,
  type RawControl
} from "@internship-agent/browser";
import {
  advancePipeline,
  approveApplication,
  AutomaticRunStopped,
  evaluateAndPersistMatch,
  getBrowserRuns,
  getIcimsAccount,
  prepareApplication,
  readJobEvidence,
  startBrowserRun,
  type IcimsAccountRuntime,
  type PipelineSettings
} from "@internship-agent/agent";

/**
 * Standing consent and attestations, Jobvite's Data Consent step, and iCIMS's
 * account step through browser runs with in-memory pages. Every name, host,
 * and email is fictional; nothing reads the real .env, mailbox, or accounts
 * file.
 */
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-account-consent-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-account-consent-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

type PageState = { url: string; controls: RawControl[]; body: string; title: string };

/** In-memory stand-in for a page: records fills, never touches a browser. */
function fakePage(initial: PageState): BrowserPage & { filled: Map<string, string>; uploads: Map<string, string>; state: PageState } {
  const filled = new Map<string, string>();
  const uploads = new Map<string, string>();
  const state = { ...initial };
  return {
    filled,
    uploads,
    state,
    url: () => state.url,
    title: async () => state.title,
    collectControls: async () => state.controls,
    bodyText: async () => state.body,
    fillField: async (field: BrowserField, value: string) => { filled.set(field.id, value); },
    chooseOption: async (field: BrowserField, option: string) => { filled.set(field.id, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { filled.set(field.id, String(checked)); },
    uploadFile: async (field: BrowserField, path: string) => { uploads.set(field.id, path); },
    clickSubmit: async () => { throw new Error("no submit in these tests"); },
    screenshot: async () => {},
    close: async () => {}
  };
}

function saveFact(database: DatabaseSync, key: "authorized_to_work" | "requires_sponsorship" | "available_start_date", scope: { kind: "country"; code: string } | { kind: "global" }, value: boolean | string) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The seeded posting, analyzed and (by default) approved, with fictional evidence. */
function approvedJobId(database: DatabaseSync, stopAt: "approved" | "qualified" = "approved"): string {
  seedDevelopmentData(database);
  // The automatic pipeline runs only on AI labels; the seed's rule labels stand in for them here.
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
  if (stopAt === "qualified") return row.id;
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  return row.id;
}

/** Fictional legal names; the account email is the seed's. */
const EMAIL = "jordan@example.test";
function saveProfile(database: DatabaseSync) {
  saveCandidate(database, LOCAL_CANDIDATE_ID, {
    fullName: "Jordan Rivera", email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera", addressCountry: "United States"
  });
}

const eventDetails = (database: DatabaseSync, jobId: string) =>
  (database.prepare("SELECT detail FROM application_events WHERE job_id = ? ORDER BY rowid").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");

const OFF: StandingConsentSettings = { acceptDataConsent: false, signAttestations: false };
const DATA: StandingConsentSettings = { acceptDataConsent: true, signAttestations: false };
const ATTEST: StandingConsentSettings = { acceptDataConsent: false, signAttestations: true };
const BOTH: StandingConsentSettings = { acceptDataConsent: true, signAttestations: true };

const FORM_URL = "https://careers.fixturerobotics.example/jobs/1003/apply";
const CLO = "Fixture Robotics has my consent to retain my data for the purpose of considering me for employment and for up to 3 years thereafter.";
const CERTIFY = "I certify that the information in this application is true and complete, and I understand that false statements may result in disqualification.";
const SIGNATURE = "Electronic Signature (type your full legal name)";
const SIGNED_ON = "Date (MM/DD/YYYY)";
const US_PERSON = "I certify that I am a U.S. person under U.S. export-control regulations.";

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
}

const start = (database: DatabaseSync, jobId: string, page: BrowserPage, standingConsent: StandingConsentSettings, extra: Partial<Parameters<typeof startBrowserRun>[2]> = {}) =>
  startBrowserRun(jobId, page.url(), {
    database, dataDir: disposableDataDir(), voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page, standingConsent, ...extra
  });

describe("standing data consent through a run", () => {
  const controls: RawControl[] = [
    { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
    { tag: "input", type: "checkbox", id: "retain", label: CLO, required: true },
    { tag: "button", label: "Submit application" }
  ];

  it("ticks a CLO-style data-retention box under the setting and logs the exact text", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const page = fakePage({ url: FORM_URL, controls, body: "Apply", title: "Apply" });
    const { run } = await start(database, jobId, page, DATA);
    expect(page.filled.get("retain")).toBe("true");
    expect(run.decisions.find((decision) => decision.fieldId === "retain")).toMatchObject({
      action: "check", basis: { kind: "standing_consent", setting: "accept_data_consent", group: "data-retention", statement: CLO }
    });
    expect(run.pauses).toEqual([]);
    expect(eventDetails(database, jobId)).toContain(`Accepted data consent: '${CLO}'`);
    database.close();
  });

  it("pauses the same box without the setting, leaves it untouched, and logs nothing", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const page = fakePage({ url: FORM_URL, controls, body: "Apply", title: "Apply" });
    const { run } = await start(database, jobId, page, OFF);
    expect(page.filled.has("retain")).toBe(false);
    expect(run.pauses.map((pause) => [pause.fieldId, pause.question])).toEqual([["retain", CONSENT_QUESTION]]);
    expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Accepted"))).toBe(false);
    database.close();
  });
});

describe("standing attestations through a run", () => {
  const controls: RawControl[] = [
    { tag: "input", type: "checkbox", id: "certify", label: CERTIFY, required: true },
    { tag: "input", type: "text", id: "signature", label: SIGNATURE, required: true },
    { tag: "input", type: "text", id: "signed-on", label: SIGNED_ON, required: true },
    { tag: "input", type: "checkbox", id: "us-person", label: US_PERSON, required: true },
    { tag: "button", label: "Submit application" }
  ];

  it("signs with the saved legal name and today's date, logs each, and still pauses the U.S.-person statement", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const page = fakePage({ url: FORM_URL, controls, body: "Apply", title: "Apply" });
    const { run } = await start(database, jobId, page, BOTH);
    expect(page.filled.get("certify")).toBe("true");
    expect(page.filled.get("signature")).toBe("Jordan Rivera");
    expect(page.filled.get("signed-on")).toBe(today());
    expect(page.filled.has("us-person")).toBe(false);
    expect(run.pauses.map((pause) => pause.fieldId)).toEqual(["us-person"]);
    const events = eventDetails(database, jobId);
    expect(events).toContain(`Accepted attestation: '${CERTIFY}'`);
    expect(events).toContain(`Signed attestation: '${SIGNATURE}' — signed as Jordan Rivera`);
    expect(events).toContain(`Dated the signature: '${SIGNED_ON}' as ${today()}`);
    expect(events.some((detail) => detail.includes(US_PERSON))).toBe(false);
    database.close();
  });

  it("waits for the candidate on the signature without the attestation setting", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const page = fakePage({ url: FORM_URL, controls, body: "Apply", title: "Apply" });
    const { run } = await start(database, jobId, page, DATA);
    expect(page.filled.has("signature")).toBe(false);
    expect(page.filled.has("certify")).toBe(false);
    expect(run.pauses.find((pause) => pause.fieldId === "signature")?.question).toBe(SIGNATURE_QUESTION);
    expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Signed attestation") || detail.startsWith("Accepted"))).toBe(false);
    database.close();
  });
});

describe("Jobvite's Data Consent step", () => {
  const APPLY = "https://jobs.jobvite.com/fixturerobotics/job/oFixture2/apply";
  const POLICY = "Fixture Robotics processes and stores your application data to consider you for employment.";
  function jobvitePage() {
    const page = fakePage({
      url: APPLY,
      title: "Fixture Robotics Careers",
      body: "Data Consent\nLocation of Residence and Language:\nAccept\nPowered by Jobvite",
      controls: [
        { tag: "select", id: "jv-country-select", label: "Location of Residence and Language:", required: true, options: ["US Based Applicants (English)", "Other (English)"] },
        { tag: "button", label: "Accept" }
      ]
    });
    const calls: string[][] = [];
    const jobviteConsent = async (choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome> => {
      const options = ["US Based Applicants (English)", "Other (English)"];
      calls.push(options);
      const residence = choose(options);
      if (!residence) return { result: "no-residence", options };
      Object.assign(page.state, {
        url: `${APPLY}/consent`,
        body: "Software Intern\nFirst Name\nLast Name\nEmail\nResume\nSend Application",
        controls: [
          { tag: "input", type: "text", id: "firstName", label: "First Name", required: true },
          { tag: "input", type: "text", id: "lastName", label: "Last Name", required: true },
          { tag: "input", type: "email", id: "email", label: "Email", required: true },
          { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
          { tag: "button", label: "Send Application" }
        ]
      });
      return { result: "accepted", residence, policyText: POLICY, acceptText: "Accept" };
    };
    return Object.assign(page, { jobviteConsent, calls });
  }

  it("chooses the residence from the profile country, accepts, logs the policy text, and fills the form behind it", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const page = jobvitePage();
    const { run } = await start(database, jobId, page, DATA, { automatic: true });
    expect(page.calls).toHaveLength(1);
    expect(page.filled.get("firstName")).toBe("Jordan");
    expect(page.filled.get("email")).toBe(EMAIL);
    expect(run.applicationUrl).toBe(APPLY);
    expect(getBrowserRuns(jobId, database)).toHaveLength(1);
    expect(eventDetails(database, jobId)).toContain(`Accepted data consent: '${POLICY}' (Jobvite Data Consent at jobs.jobvite.com; residence "US Based Applicants (English)")`);
    database.close();
  });

  it("keeps today's stop without the setting: the step is never taken and no run is saved", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const page = jobvitePage();
    const stopped = start(database, jobId, page, ATTEST, { automatic: true });
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/Jobvite asks you to accept its data-consent policy at jobs\.jobvite\.com/);
    expect(page.calls).toEqual([]);
    expect(page.filled.size).toBe(0);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    expect(eventDetails(database, jobId).some((detail) => detail.startsWith("Accepted"))).toBe(false);
    database.close();
  });
});

describe("iCIMS's account step on an automatic run", () => {
  const HOST = "careers-fixture.icims.com";
  const LOGIN = `https://${HOST}/jobs/9001/intern/login?in_iframe=1`;
  const GDPR = "I consent to Fixture Robotics collecting, processing and storing my personal data for recruitment purposes as described in its privacy policy. I agree";
  const loginControls: RawControl[] = [
    { tag: "input", type: "email", id: "email", label: "Email", required: true },
    { tag: "input", type: "checkbox", id: "accept_gdpr", label: "I agree", required: true },
    { tag: "input", type: "submit", label: "Next" }
  ];

  function icimsPage(file: string, mode: "new" | "existing") {
    const page = fakePage({ url: LOGIN, title: "Fixture Robotics Careers", controls: loginControls, body: `Enter Your Information\nEmail\nI agree\nSoftware Powered by iCIMS` });
    const state = { screen: "email" as IcimsAccountScreen, creates: 0, signIns: 0, savedFirst: false, typed: [] as string[] };
    const icims: IcimsAccountSteps = {
      screen: async () => state.screen,
      submitEmail: async (email, accept) => {
        state.typed.push(email);
        if (!accept(GDPR)) return { accepted: [], result: "consent-needed", statement: GDPR };
        state.screen = mode === "existing" ? "sign-in" : "create";
        return { accepted: [GDPR], result: "next", screen: state.screen };
      },
      createProfile: async (input: IcimsProfileInput, _accept, beforeSubmit) => {
        const before = getIcimsAccount(file, HOST);
        beforeSubmit();
        const atSubmit = getIcimsAccount(file, HOST);
        state.savedFirst = before?.password === input.password && atSubmit?.account === "pending" && atSubmit.password === input.password;
        state.typed.push(input.firstName, input.lastName);
        state.creates += 1;
        state.screen = "application";
        page.state.body = `Candidate Profile\nSigned in as ${EMAIL}\nAddress\nResume\nNext`;
        return { accepted: [], result: "next", screen: "application" };
      },
      signIn: async () => {
        state.signIns += 1;
        return { accepted: [], result: "error", kind: "wrong-password", message: "The password you entered is incorrect." };
      },
      openInNewTab: async () => {},
      goto: async () => {}
    };
    return Object.assign(page, { icims, icimsState: state });
  }

  const accountsFile = () => join(disposableDataDir(), "config", "icims-accounts.json");
  const runtimeFor = (file: string): IcimsAccountRuntime => ({ email: EMAIL, file, mailbox: null });

  it("creates the account with the password saved first, then stops at iCIMS's application with evidence and no run", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const file = accountsFile();
    const page = icimsPage(file, "new");
    const logs: string[] = [];
    for (const level of ["log", "warn", "error", "info"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const stopped = startBrowserRun(jobId, LOGIN, {
      database, dataDir, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page,
      automatic: true, icimsAccounts: runtimeFor(file), standingConsent: DATA
    });
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    const message = await stopped.catch((error: Error) => error.message);
    expect(message).toContain(HOST);
    expect(message).toContain(`pnpm icims:account --site ${HOST}`);
    expect(page.icimsState.savedFirst).toBe(true);
    expect(page.icimsState.creates).toBe(1);
    expect(page.icimsState.typed).toEqual([EMAIL, "Jordan", "Rivera"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = getIcimsAccount(file, HOST)!;
    expect(saved).toMatchObject({ host: HOST, email: EMAIL, account: "created", hold: null });
    expect(saved.password).toMatch(/^.{16}$/);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    const events = eventDetails(database, jobId);
    expect(events).toContain(`Accepted data consent: '${GDPR}' (iCIMS email step at ${HOST})`);
    expect(events).toContain(`iCIMS ${HOST}: account created with your email; the password is saved locally.`);
    expect(events.some((detail) => detail.startsWith("iCIMS evidence saved (icims-application)"))).toBe(true);
    const evidence = readJobEvidence(dataDir, jobId);
    expect(evidence.map((entry) => [entry.outcome, entry.runId])).toEqual([["icims-application", null]]);
    // Neither the password nor the account email reaches errors, events, evidence, or the console; nor the legal name the console or errors.
    const evidenceFiles = readdirSync(submitEvidenceRoot(dataDir, jobId), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n");
    const rows = JSON.stringify(["application_events", "browser_runs"].map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
    for (const secret of [saved.password!, EMAIL]) {
      expect(message).not.toContain(secret);
      expect(rows).not.toContain(secret);
      expect(evidenceFiles).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    expect(message).not.toContain("Rivera");
    expect(logs.join("\n")).not.toContain("Rivera");
    database.close();
  });

  it("keeps today's stop without the iCIMS opt-in, never taking the account step", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    saveProfile(database);
    const page = icimsPage(accountsFile(), "new");
    const stopped = start(database, jobId, page, BOTH, { automatic: true });
    await expect(stopped).rejects.toBeInstanceOf(AutomaticRunStopped);
    await expect(stopped).rejects.toThrow(/iCIMS needs an account at careers-fixture\.icims\.com/);
    expect(page.icimsState.typed).toEqual([]);
    expect(getBrowserRuns(jobId, database)).toEqual([]);
    database.close();
  });

  it("waits on an existing account with no saved password, and the next pass opens no browser", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = approvedJobId(database, "qualified");
    prepareApplication(jobId, { database });
    database.prepare("UPDATE jobs SET source_url = ?, external_application_url = ? WHERE id = ?").run(LOGIN, LOGIN, jobId);
    const file = accountsFile();
    const page = icimsPage(file, "existing");
    const settings: PipelineSettings = { minFit: 0, autoApply: true, icimsAccounts: { email: EMAIL, file, mailbox: null } };
    // The pipeline reads the candidate's standing data-consent setting from the environment.
    vi.stubEnv("INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT", "1");
    const first = await advancePipeline({ database, dataDir, settings, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: async () => page });
    const held = `iCIMS ${HOST}: an iCIMS account exists for your email at ${HOST} but no password is saved. Sign in at ${HOST} yourself, then start the run yourself.`;
    expect(first.waiting).toEqual([{ jobId, siteKey: `icims:${HOST}`, reason: "icims-account", detail: held }]);
    expect(first.started).toEqual([]);
    expect(page.icimsState.signIns).toBe(0);
    expect(getIcimsAccount(file, HOST)?.hold?.kind).toBe("exists-no-password");
    expect(eventDetails(database, jobId)).toContain(`Automatic browser run waiting: ${held}`);
    const opened = vi.fn(async (): Promise<BrowserPage> => { throw new Error("must not open a browser while the host is held"); });
    const second = await advancePipeline({ database, dataDir, settings, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }), openPage: opened });
    expect(opened).not.toHaveBeenCalled();
    expect(second.waiting).toEqual([{ jobId, siteKey: `icims:${HOST}`, reason: "icims-account", detail: held }]);
    expect(readJobEvidence(dataDir, jobId).map((entry) => entry.outcome)).toEqual(["icims-account"]);
    database.close();
  });
});
