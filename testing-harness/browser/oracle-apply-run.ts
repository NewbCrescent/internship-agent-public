/**
 * Oracle Cloud HCM Candidate Experience's email and one-time-code step in
 * real Chromium against routed fictional pages (testing-harness/browser/
 * fixtures: oracle-candidate-experience.html, oracle-ce-email.html,
 * oracle-ce-section.html). Every host resolves to nothing
 * (`--host-resolver-rules=MAP * ~NOTFOUND`), every document is served by
 * `context.route`, and every other request is aborted, so no network is
 * used. Never reads process.env for Gmail; the mailbox is a fake.
 *
 * Proves: the screens are told apart (posting, email, PIN, section form,
 * identity check, already applied, an unknown page); the email is typed, the
 * terms box ticked through its span, and Next clicked once, never Resend;
 * declined terms and a visible hCaptcha leave the email box empty; the right
 * code passes the PIN with one Verify click and a wrong one stops after one;
 * Oracle Digital Assistant's chatbot box is never a field (fails on the old
 * code); a start run passes the email step and fills the single-section form
 * with the consent logged (fails on the old code, which stopped at the email
 * step); a returning candidate's emailed code is entered and the
 * several-section form then stops the run, with the code in no console line,
 * database row, or error; and Oracle's default terms label proceeds exactly
 * when the standing data-consent rule covers it.
 *
 * Track 63 (each fails on the old code): the one-page section's "Import your
 * profile" box gets no file, its read-only email is left as it is, its
 * "+1 (United States)" country code is chosen, and its Address Line 1
 * type-ahead with no suggestions keeps the saved address; the quick email
 * verification on the job page (its `data-route`) is the email step, with
 * its Next in the form or a disabled round icon button outside it; and a
 * section page drawn late, after the email step or opened directly, is
 * read once its form is drawn.
 *
 * Usage: pnpm test:browser:oracle-apply
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { chromium, type Page } from "playwright-core";

import {
  approveApplication,
  evaluateAndPersistMatch,
  getBrowserRuns,
  prepareApplication,
  startBrowserRun,
  type MailMessage,
  type VerificationMailboxFactory
} from "@internship-agent/agent";
import { createApplicationPage, createPlaywrightPage, oracleApplySteps, recognizeForm } from "@internship-agent/browser";
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
import { standingStatementDecision, type StandingConsentSettings } from "@internship-agent/domain";

const PREFIX = "internship-agent-oracle-apply-";
const EMAIL = "jordan@example.test";
const CODE = "482913";
const HOST = "fixture.fa.ocs.oraclecloud.com";
const JOB = `https://${HOST}/hcmUI/CandidateExperience/en/sites/CX_1/job/10001`;
/** A job page that asks for the email itself (the quick email verification, Track 63). */
const QUICK_JOB = `https://${HOST}/hcmUI/CandidateExperience/en/sites/CX_1/job/10002`;
const QUICK_ROUTE = "job-details.quick-email-verification";
const QUICK_LABEL = "What's your email?";
const ADDRESS = "1 Example Way";
/** Oracle draws a late section this long after load; STEP_WAIT (8 s) waits well beyond it. */
const LATE_MS = 2_500;
const EMAIL_STEP = `${JOB}/apply/email`;
const SECTION_PATH = "/hcmUI/CandidateExperience/en/sites/CX_1/job/10001/apply/section/1";
const TENANT_TERMS = "I agree with the terms and conditions and consent to the processing of my personal data";
const DEFAULT_TERMS = "I agree with the terms and conditions";
const ODA = "oda-work-summary-text-area|input";
const DATA: StandingConsentSettings = { acceptDataConsent: true, signAttestations: false };
const STEP_WAIT = { timeoutMs: 8_000, pollMs: 100 };

type Scenario = {
  flow: "new" | "pin" | "identity" | "already" | "stuck" | "captcha-after"; terms: string | null; captcha: boolean; pagination: "single" | "multi";
  route?: string; emailLabel?: string; nextMode?: "form" | "outside"; delay?: number; sessionEmail?: string;
};
type FixtureState = { email: string; terms: boolean; nextClicks: number; verifyClicks: number; resendClicks: number; codeRequests: number };

function saveFact(database: DatabaseSync, key: "authorized_to_work" | "requires_sponsorship" | "available_start_date", scope: { kind: "country"; code: string } | { kind: "global" }, value: boolean | string) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The seeded posting as an approved external application (fictional evidence and profile). */
function approvedJob(database: DatabaseSync): string {
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
  if (!reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })) throw new Error("the fixture evidence was not allowed");
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  database.prepare("UPDATE jobs SET application_type = 'EXTERNAL_ATS' WHERE id = ?").run(row.id);
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  saveCandidate(database, LOCAL_CANDIDATE_ID, {
    fullName: "Jordan Rivera", email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera", phone: "+1 555 0100", addressCountry: "United States",
    addressLine1: ADDRESS
  });
  return row.id;
}

function dumpTables(database: DatabaseSync): string {
  const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
  return JSON.stringify(tables.map((table) => database.prepare(`SELECT * FROM "${table}"`).all()));
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  let scenarios = 0;
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const posting = fixture("oracle-candidate-experience.html");
    const emailTemplate = fixture("oracle-ce-email.html");
    const sectionTemplate = fixture("oracle-ce-section.html");
    let scenario: Scenario = { flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single" };
    const emailDocument = () => {
      let html = emailTemplate
        .replaceAll("__ROUTE__", scenario.route ?? "")
        .replaceAll("__EMAIL_LABEL__", scenario.emailLabel ?? "Email Address")
        .replaceAll("__NEXT_MODE__", scenario.nextMode ?? "form")
        .replaceAll("__FLOW__", scenario.flow)
        .replaceAll("__CODE__", CODE)
        .replaceAll("__CAPTCHA__", scenario.captcha ? '<iframe class="captcha-frame" src="https://newassets.hcaptcha.com/captcha/v1/fixture"></iframe>' : "");
      if (scenario.terms === null) html = html.replace(/<!--TERMS-->[\s\S]*?<!--\/TERMS-->/, "");
      else html = html.replaceAll("__TERMS__", scenario.terms);
      return html;
    };
    const sectionDocument = () => sectionTemplate
      .replaceAll("__PAGINATION__", scenario.pagination)
      .replaceAll("__DELAY__", String(scenario.delay ?? 0))
      .replaceAll("__SESSION_EMAIL__", scenario.sessionEmail ?? "");
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && url.hostname === HOST && request.resourceType() === "document") {
        const path = url.pathname.replace(/\/$/, "");
        const body = path === new URL(JOB).pathname ? posting
          : path.endsWith("/apply/email") || path === new URL(QUICK_JOB).pathname ? emailDocument()
            : path.endsWith("/apply/section/1") ? sectionDocument()
              : path.endsWith("/apply/unknown") ? "<!doctype html><html><head><title>Fixture</title></head><body><main><p>Loading your application.</p></main></body></html>"
                : null;
        if (body !== null) {
          await route.fulfill({ status: 200, contentType: "text/html", body });
          return;
        }
      }
      await route.abort();
    });
    // The code "arrives" in the fake mailbox only once the fixture asked Oracle for it.
    let codeRequestedAt: Date | null = null;
    await context.exposeBinding("fixtureOracleCodeRequested", () => { codeRequestedAt = new Date(); });
    const mailbox: VerificationMailboxFactory = async () => ({
      messagesSince: async (_since, relevant) => {
        if (!codeRequestedAt) return [];
        const message: MailMessage = {
          from: "Fixture Robotics Careers <fixture.fa.sender@workflow.mail.us2.cloud.oracle.com>", subject: "Confirm your identity",
          receivedAt: new Date(codeRequestedAt.getTime() + 1_000), text: `Your verification code is ${CODE}. It expires in 10 minutes.`, html: ""
        };
        return [message].filter((entry) => relevant({ from: entry.from, subject: entry.subject }));
      },
      close: async () => undefined
    });
    context.on("console", (message) => captured.push(message.text()));
    for (const level of ["log", "warn", "error", "info", "debug"] as const) {
      console[level] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    }

    const state = (tab: Page) => tab.evaluate(() => JSON.parse(localStorage.getItem("fixture-oracle") || "{}") as FixtureState);
    const imports = (tab: Page) => tab.evaluate(() => (JSON.parse(localStorage.getItem("fixture-oracle-section") || "{}") as { imported?: number }).imported ?? -1);
    const value = (tab: Page, selector: string) => tab.evaluate((query) => (document.querySelector(query) as HTMLInputElement | null)?.value ?? null, selector);
    const open = async (next: Partial<Scenario>, url = EMAIL_STEP) => {
      scenario = { flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single", ...next };
      codeRequestedAt = null;
      const tab = await context.newPage();
      await tab.goto(url);
      return tab;
    };
    const always = () => true;

    // (1) The screens.
    scenarios += 1;
    {
      const tab = await open({}, JOB);
      const steps = oracleApplySteps(tab);
      const screen = await steps.screen();
      check(screen !== "email" && screen !== "form", `screens: the posting reads as ${screen}`);
      await tab.goto(EMAIL_STEP);
      check((await steps.screen()) === "email", `screens: the email step reads as ${await steps.screen()}`);
      await tab.goto(`https://${HOST}${SECTION_PATH}`);
      check((await steps.screen()) === "form", `screens: the section reads as ${await steps.screen()}`);
      await tab.goto(`${JOB}/apply/unknown`);
      check((await steps.screen()) === "other", `screens: an unknown page reads as ${await steps.screen()}`);
      await tab.close();
      for (const [flow, expected] of [["pin", "pin"], ["identity", "identity"], ["already", "already-applied"]] as const) {
        const flowTab = await open({ flow });
        const result = await oracleApplySteps(flowTab).submitEmail(EMAIL, always, STEP_WAIT);
        check(result.result === "next" && result.screen === expected, `screens: ${flow} after Next reads as ${JSON.stringify(result)}`);
        check((await oracleApplySteps(flowTab).screen()) === expected, `screens: ${flow} screen() reads as ${await oracleApplySteps(flowTab).screen()}`);
        await flowTab.close();
      }
    }

    // (2) A new candidate: the email typed, the terms ticked through the span, Next clicked once.
    scenarios += 1;
    {
      const tab = await open({ flow: "new" });
      const statements: string[] = [];
      const result = await oracleApplySteps(tab).submitEmail(EMAIL, (statement) => { statements.push(statement); return true; }, STEP_WAIT);
      check(result.result === "next" && result.screen === "form" && result.accepted === TENANT_TERMS, `new: ${JSON.stringify(result)}`);
      check(statements.length === 1 && statements[0] === TENANT_TERMS, `new: the terms statement read was ${JSON.stringify(statements)}`);
      check(new URL(tab.url()).pathname === SECTION_PATH, `new: not on the section (${tab.url()})`);
      const after = await state(tab);
      check(after.email === EMAIL && after.terms && after.nextClicks === 1 && after.resendClicks === 0, `new: fixture state ${JSON.stringify(after)}`);
      await tab.close();
    }

    // (3) Terms declined: nothing typed, Next never clicked.
    scenarios += 1;
    {
      const tab = await open({ flow: "new" });
      const result = await oracleApplySteps(tab).submitEmail(EMAIL, () => false, STEP_WAIT);
      check(result.result === "terms-declined" && result.statement === TENANT_TERMS, `declined: ${JSON.stringify(result)}`);
      check((await value(tab, "#primary-email-0")) === "", "declined: the email was typed");
      check((await state(tab)).nextClicks === 0, "declined: Next was clicked");
      await tab.close();
    }

    // (4) A visible hCaptcha on the email step: nothing typed.
    scenarios += 1;
    {
      const tab = await open({ flow: "new", captcha: true });
      const result = await oracleApplySteps(tab).submitEmail(EMAIL, always, STEP_WAIT);
      check(result.result === "captcha", `captcha: ${JSON.stringify(result)}`);
      check((await value(tab, "#primary-email-0")) === "", "captcha: the email was typed");
      check((await state(tab)).nextClicks === 0, "captcha: Next was clicked");
      await tab.close();
    }

    // (5) The PIN: the right code passes with one Verify; a wrong one stops after one, never Resend.
    scenarios += 1;
    {
      const tab = await open({ flow: "pin", terms: null });
      const steps = oracleApplySteps(tab);
      const emailed = await steps.submitEmail(EMAIL, always, STEP_WAIT);
      check(emailed.result === "next" && emailed.screen === "pin" && emailed.accepted === null, `pin: ${JSON.stringify(emailed)}`);
      const entered = await steps.enterCode(CODE, STEP_WAIT);
      check(entered.result === "next" && entered.screen === "form", `pin right: ${JSON.stringify(entered)}`);
      const after = await state(tab);
      check(after.verifyClicks === 1 && after.resendClicks === 0, `pin right: fixture state ${JSON.stringify(after)}`);
      await tab.close();

      const wrongTab = await open({ flow: "pin", terms: null });
      const wrongSteps = oracleApplySteps(wrongTab);
      await wrongSteps.submitEmail(EMAIL, always, STEP_WAIT);
      const refused = await wrongSteps.enterCode("111111", STEP_WAIT);
      check(refused.result === "wrong-code", `pin wrong: ${JSON.stringify(refused)}`);
      const wrongState = await state(wrongTab);
      check(wrongState.verifyClicks === 1 && wrongState.resendClicks === 0, `pin wrong: fixture state ${JSON.stringify(wrongState)}`);
      check(!(await wrongTab.locator("#keep-signed-in").isChecked()), "pin wrong: keep-signed-in was checked");
      await wrongTab.close();
    }

    // (6) Oracle Digital Assistant's chatbot box is never a field (email step and section).
    scenarios += 1;
    {
      for (const url of [EMAIL_STEP, `https://${HOST}${SECTION_PATH}`]) {
        const tab = await open({ flow: "new" }, url);
        const controls = await createPlaywrightPage(tab).collectControls();
        const form = recognizeForm(tab.url(), await tab.title(), controls);
        check(!controls.some((control) => control.id === ODA), `oda: ${url} reports the chatbot box as a control`);
        check(!form.fields.some((field) => field.id === ODA || field.id.includes("oda-work-summary")), `oda: ${url} reports the chatbot box as a field`);
        await tab.close();
      }
    }

    // The run closes its page; the kept tab stays open so the DOM can be read after the run.
    const tabs: Page[] = [];
    const openPage = async (url: string) => {
      const tab = await context.newPage();
      tabs.push(tab);
      await tab.goto(url);
      return { ...createApplicationPage(tab), close: async () => undefined };
    };
    const renderPdf = async (_html: string, outputPath: string) => {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, "%PDF-1.7\n% fixture resume\n%%EOF\n");
      return { pages: 1 };
    };
    /** The section's values by their first-drawn ids (an import redraw renames them, so they read null). */
    const sectionValues = (tab: Page) => tab.evaluate(() => {
      const read = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? null;
      return {
        first: read("firstName-1"), last: read("lastName-2"), email: read("email-3"), phone: read("phoneNumber-4"),
        countryCode: read("phoneCountryCode-6"), address: read("addressLine1-7"),
        emailReadOnly: (document.getElementById("email-3") as HTMLInputElement | null)?.readOnly === true,
        resume: (document.getElementById("attachment-upload-5") as HTMLInputElement | null)?.files?.length ?? 0,
        importFiles: (document.getElementById("profile-import-upload") as HTMLInputElement | null)?.files?.length ?? 0,
        oda: (document.getElementById("oda-work-summary-text-area|input") as HTMLTextAreaElement | null)?.value ?? null
      };
    });
    /** A start run from `url` in a fresh database; the report, or the error it stopped with. */
    const startRun = async (name: string, url: string, next: Scenario) => {
      scenario = next;
      codeRequestedAt = null;
      const database = createDatabase(join(temp, `${name}.sqlite`));
      const jobId = approvedJob(database);
      try {
        const report = await startBrowserRun(jobId, url, {
          database, dataDir: join(temp, `data-${name}`), openPage, renderPdf, voiceDrafter: null,
          standingConsent: DATA, oracleEmailStep: { mailbox, mailboxAddress: EMAIL, codeWait: { pollMs: 50, timeoutMs: 3_000 }, stepWait: STEP_WAIT }
        });
        return { database, jobId, report, error: null };
      } catch (error) {
        return { database, jobId, report: null, error: error instanceof Error ? error : new Error(String(error)) };
      }
    };

    // (7) A start run: the email step passed, the single-section form filled, the consent logged.
    scenarios += 1;
    {
      scenario = { flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single" };
      codeRequestedAt = null;
      const database = createDatabase(join(temp, "start.sqlite"));
      const jobId = approvedJob(database);
      try {
        const report = await startBrowserRun(jobId, JOB, {
          database, dataDir: join(temp, "data-start"), openPage, renderPdf, voiceDrafter: null,
          standingConsent: DATA, oracleEmailStep: { mailbox, mailboxAddress: EMAIL, codeWait: { pollMs: 50, timeoutMs: 3_000 }, stepWait: STEP_WAIT }
        });
        check(report.run.status === "awaiting-approval", `start: run status ${report.run.status} (pauses ${report.run.pauses.map((pause) => pause.label).join(" | ")})`);
        check(report.run.applicationUrl === EMAIL_STEP, `start: saved address ${report.run.applicationUrl}`);
        const events = (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
        check(events.includes(`Accepted data consent: '${TENANT_TERMS}' (Oracle Cloud HCM email step at ${HOST})`), "start: no consent event");
        const tab = tabs.at(-1)!;
        check(new URL(tab.url()).pathname === SECTION_PATH, `start: the page is at ${tab.url()}`);
        const dom = await sectionValues(tab);
        check(dom.first === "Jordan" && dom.last === "Rivera" && dom.email === EMAIL && Boolean(dom.phone), `start: section values ${JSON.stringify(dom)}`);
        check(dom.resume === 1, `start: ${dom.resume} resume files uploaded`);
        check(dom.oda === "", "start: the chatbot box was typed into");
        check((await state(tab)).nextClicks === 1, "start: Next was not clicked exactly once");
        // Track 63: the import box, the read-only email, the "+1 (United States)" code, and the address type-ahead.
        check((await imports(tab)) === 0, `start: the profile import box received ${await imports(tab)} files`);
        check(dom.importFiles === 0, "start: a file sits in the profile import box");
        check(dom.emailReadOnly, "start: the email box is no longer read-only");
        check(dom.countryCode === "+1 (United States)", `start: the country code shows ${JSON.stringify(dom.countryCode)}`);
        check(dom.address === ADDRESS, `start: Address Line 1 holds ${JSON.stringify(dom.address)}`);
        check(report.run.pauses.length === 0, `start: paused on ${report.run.pauses.map((pause) => pause.label).join(" | ")}`);
      } catch (error) {
        failures.push(`start: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const tab of tabs.splice(0)) await tab.close();
      database.close();
    }

    // (8) A returning candidate: the emailed code entered, then the several-section form stops the run.
    scenarios += 1;
    {
      scenario = { flow: "pin", terms: null, captcha: false, pagination: "multi" };
      codeRequestedAt = null;
      const database = createDatabase(join(temp, "pin.sqlite"));
      const jobId = approvedJob(database);
      const before = occurrences(dumpTables(database), CODE);
      let caught: Error | null = null;
      try {
        await startBrowserRun(jobId, JOB, {
          database, dataDir: join(temp, "data-pin"), openPage, renderPdf, voiceDrafter: null,
          standingConsent: DATA, oracleEmailStep: { mailbox, mailboxAddress: EMAIL, codeWait: { pollMs: 50, timeoutMs: 5_000 }, stepWait: STEP_WAIT }
        });
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      check(codeRequestedAt !== null, "pin run: the fixture never asked for a code");
      check(caught !== null && caught.message.includes(`The application at ${HOST} continues over several pages`), `pin run: ${caught?.message ?? "no stop"}`);
      check(getBrowserRuns(jobId, database).length === 0, "pin run: a run was saved");
      const pinTab = tabs.at(-1);
      check(pinTab !== undefined && (await state(pinTab)).verifyClicks === 1 && (await state(pinTab)).resendClicks === 0, "pin run: Verify was not clicked exactly once, or Resend was clicked");
      for (const tab of tabs.splice(0)) await tab.close();
      check(occurrences(dumpTables(database), CODE) === before, "pin run: the code reached the database");
      check(!(caught?.message ?? "").includes(CODE), "pin run: the code reached the error");
      database.close();
    }

    // (9) Oracle's default terms label is accepted under the standing data-consent setting (terms-of-use group) and declined without it.
    scenarios += 1;
    {
      const tab = await open({ flow: "new", terms: DEFAULT_TERMS });
      const result = await oracleApplySteps(tab).submitEmail(EMAIL, (statement) => standingStatementDecision(statement, DATA).verdict === "accept", STEP_WAIT);
      check(result.result === "next" && result.screen === "form" && result.accepted === DEFAULT_TERMS, `default terms (data consent on): ${JSON.stringify(result)}`);
      check((await state(tab)).email === EMAIL, "default terms (data consent on): the email was not submitted");
      await tab.close();
      const noConsent: StandingConsentSettings = { ...DATA, acceptDataConsent: false };
      const declinedTab = await open({ flow: "new", terms: DEFAULT_TERMS });
      const declined = await oracleApplySteps(declinedTab).submitEmail(EMAIL, (statement) => standingStatementDecision(statement, noConsent).verdict === "accept", STEP_WAIT);
      check(declined.result === "terms-declined" && declined.statement === DEFAULT_TERMS, `default terms (data consent off): ${JSON.stringify(declined)}`);
      check((await value(declinedTab, "#primary-email-0")) === "", "default terms (data consent off): the email was typed");
      check((await state(declinedTab)).nextClicks === 0, "default terms (data consent off): Next was clicked");
      await declinedTab.close();
    }

    // (10) The quick email verification on the job page (its data-route) is the email step: typed, Next clicked once.
    scenarios += 1;
    {
      const tab = await open({ flow: "new", route: QUICK_ROUTE, emailLabel: QUICK_LABEL }, QUICK_JOB);
      const steps = oracleApplySteps(tab);
      check((await steps.screen()) === "email", `quick: the job page's email step reads as ${await steps.screen()}`);
      const result = await steps.submitEmail(EMAIL, always, STEP_WAIT);
      check(result.result === "next" && result.screen === "form" && result.accepted === TENANT_TERMS, `quick: ${JSON.stringify(result)}`);
      const after = await state(tab);
      check(after.email === EMAIL && after.nextClicks === 1 && after.resendClicks === 0, `quick: fixture state ${JSON.stringify(after)}`);
      await tab.close();
    }

    // (11) Its Next outside the form, disabled until the email and the terms are given: clicked once; declined terms type nothing.
    scenarios += 1;
    {
      const quick: Partial<Scenario> = { flow: "new", route: QUICK_ROUTE, emailLabel: QUICK_LABEL, nextMode: "outside" };
      const tab = await open(quick, QUICK_JOB);
      check((await tab.locator(".apply-flow-pagination__round-button").isDisabled()), "quick outside: the round Next starts enabled");
      const result = await oracleApplySteps(tab).submitEmail(EMAIL, always, STEP_WAIT);
      check(result.result === "next" && result.screen === "form", `quick outside: ${JSON.stringify(result)}`);
      const after = await state(tab);
      check(after.email === EMAIL && after.nextClicks === 1, `quick outside: fixture state ${JSON.stringify(after)}`);
      await tab.close();
      const declinedTab = await open(quick, QUICK_JOB);
      const declined = await oracleApplySteps(declinedTab).submitEmail(EMAIL, () => false, STEP_WAIT);
      check(declined.result === "terms-declined", `quick outside declined: ${JSON.stringify(declined)}`);
      check((await value(declinedTab, "#primary-email-0")) === "", "quick outside declined: the email was typed");
      check((await state(declinedTab)).nextClicks === 0, "quick outside declined: Next was clicked");
      await declinedTab.close();
    }

    // (12) A start run from the quick job page passes its email step and fills the section.
    scenarios += 1;
    {
      const { database, jobId, report, error } = await startRun("quick", QUICK_JOB, { flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single", route: QUICK_ROUTE, emailLabel: QUICK_LABEL, nextMode: "outside" });
      check(error === null, `quick run: stopped: ${error?.message ?? ""}`);
      check(report?.run.status === "awaiting-approval", `quick run: run status ${report?.run.status} (pauses ${report?.run.pauses.map((pause) => pause.label).join(" | ")})`);
      check(getBrowserRuns(jobId, database).length === 1, "quick run: no run was saved");
      const tab = tabs.at(-1);
      const dom = tab ? await sectionValues(tab) : null;
      check(dom?.first === "Jordan" && dom.email === EMAIL, `quick run: section values ${JSON.stringify(dom)}`);
      for (const each of tabs.splice(0)) await each.close();
      database.close();
    }

    // (13) A section Oracle draws late after the email step is read once drawn.
    scenarios += 1;
    {
      const { database, jobId, report, error } = await startRun("late", JOB, { flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single", delay: LATE_MS });
      check(error === null, `late section: stopped: ${error?.message ?? ""}`);
      check(report?.run.status === "awaiting-approval", `late section: run status ${report?.run.status} (pauses ${report?.run.pauses.map((pause) => pause.label).join(" | ")})`);
      check(getBrowserRuns(jobId, database).length === 1, "late section: no run was saved");
      const tab = tabs.at(-1);
      const dom = tab ? await sectionValues(tab) : null;
      check(dom?.first === "Jordan" && dom.last === "Rivera" && dom.resume === 1 && dom.importFiles === 0, `late section: section values ${JSON.stringify(dom)}`);
      for (const each of tabs.splice(0)) await each.close();
      database.close();
    }

    // (14) A run opened at a late section (a signed-in session skips the email step) is read once drawn.
    scenarios += 1;
    {
      const { database, jobId, report, error } = await startRun("direct", `https://${HOST}${SECTION_PATH}`, {
        flow: "new", terms: TENANT_TERMS, captcha: false, pagination: "single", delay: LATE_MS, sessionEmail: EMAIL
      });
      check(error === null, `direct section: stopped: ${error?.message ?? ""}`);
      check(report?.run.status === "awaiting-approval", `direct section: run status ${report?.run.status} (pauses ${report?.run.pauses.map((pause) => pause.label).join(" | ")})`);
      check(getBrowserRuns(jobId, database).length === 1, "direct section: no run was saved");
      const tab = tabs.at(-1);
      const dom = tab ? await sectionValues(tab) : null;
      check(dom?.first === "Jordan" && dom.resume === 1 && dom.importFiles === 0, `direct section: section values ${JSON.stringify(dom)}`);
      for (const each of tabs.splice(0)) await each.close();
      database.close();
    }

    if (captured.some((line) => line.includes(CODE))) failures.push("the code reached the console");
    await context.close();
  } finally {
    Object.assign(console, originals);
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`ORACLE_APPLY_REPORT {"status":"failed","scenarios":${scenarios},"failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`ORACLE_APPLY_REPORT {"status":"passed","scenarios":${scenarios}}`);
}

main().catch((error) => {
  console.error(`ORACLE_APPLY_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
