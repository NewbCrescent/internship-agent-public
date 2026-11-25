/**
 * iCIMS accounts, Jobvite's Data Consent step, and standing attestations in
 * real Chromium against routed fictional pages (testing-harness/browser/
 * fixtures: icims-account.html, icims-account-frame.html, jobvite-posting.html, jobvite-consent-policy
 * .html, jobvite-application.html, attestation-application.html). Every host
 * resolves to nothing (`--host-resolver-rules=MAP * ~NOTFOUND`), every
 * document is served by `context.route`, and every other request is aborted,
 * so no network is used. Never reads process.env for accounts or Gmail.
 *
 * Proves: a new iCIMS account is created with the data-consent box ticked and
 * logged, the job-alerts box untouched, the password saved (0600, pending)
 * at the moment of the create submit, and the legal name typed; a second call
 * signs in with the saved password; an existing account with no saved
 * password, a CAPTCHA, the consent setting off, and a refused saved password
 * hold before anything is typed (and a refused password is never typed
 * again); a verification link from a fake mailbox is opened before signing
 * in; the same flow when iCIMS draws its account screens inside the career
 * site's same-host content frame (created, signed in again, and a CAPTCHA
 * inside the frame held before anything is typed); a privacy-notice
 * acknowledgment whose legal text sits in the box's own block (iCIMS's
 * #gdpr_container) is read whole, without iCIMS's screen-reader-only
 * description, ticked under the attestation setting and logged "Accepted
 * attestation", and held as attestation-setting with the data-consent setting
 * alone; a box whose legal text is empty ("I accept") stays held as
 * consent-unknown. Jobvite's residence follows the profile country and Accept is clicked,
 * with no click when no option matches. An attestation form is signed and
 * dated under the settings, and nothing is checked without them. The password
 * never reaches database rows, console output, or caught errors.
 *
 * Usage: pnpm test:browser:account-consent
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium, type Page } from "playwright-core";

import {
  ensureIcimsAccount,
  getIcimsAccount,
  IcimsAccountHeld,
  putIcimsAccount,
  readIcimsAccounts,
  type IcimsAccountRuntime,
  type MailMessage,
  type VerificationMailboxFactory
} from "@internship-agent/agent";
import {
  applyDecisions,
  chooseResidenceOption,
  createApplicationPage,
  createPlaywrightPage,
  planAutofill,
  recognizeCurrentForm,
  type StandingInputs
} from "@internship-agent/browser";
import { createDatabase, seedDevelopmentData } from "@internship-agent/db";

const PREFIX = "internship-agent-account-consent-";
const EMAIL = "jordan@example.test";
const COMPANY = "Fixture Robotics";
const CANDIDATE = { email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera", phone: null };
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const PASSWORD_RULE = /^(?=.*[A-HJ-NP-Z])(?=.*[a-km-z])(?=.*[2-9])(?=.*[!@#$%^&*])[A-HJ-NP-Za-km-z2-9!@#$%^&*]{16}$/;
const JOBVITE_POSTING = "https://jobs.jobvite.com/fixturerobotics/job/oFixture2";
const ATTESTATION_FORM = "https://careers.fixturerobotics.com/jobs/1003/apply";

type FixtureIcims = { gdprChecked: boolean; alertsChecked: boolean; emailSubmits: number; creates: number; signIns: number; typedFirst: string; typedLast: string };

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const captured: string[] = [];
  const caughtMessages: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  let scenarios = 0;
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const database = createDatabase(join(temp, "test.sqlite"));
    seedDevelopmentData(database);
    const jobId = (database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string }).id;
    const file = join(temp, "config", "icims-accounts.json");
    let mail: () => Promise<MailMessage[]> = async () => [];
    const mailbox: VerificationMailboxFactory = async () => ({ messagesSince: () => mail(), close: async () => undefined });
    const runtime: IcimsAccountRuntime = { email: EMAIL, file, mailbox, mailPollMs: 50, mailTimeoutMs: 500, accountWait: { timeoutMs: 8_000, pollMs: 100 } };

    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const icimsFlow = fixture("icims-account.html");
    const icimsWrapper = fixture("icims-account-frame.html");
    const documents: Record<string, string> = {
      "jobs.jobvite.com/fixturerobotics/job/oFixture2": fixture("jobvite-posting.html").replaceAll("oFixture1", "oFixture2"),
      "jobs.jobvite.com/fixturerobotics/job/oFixture2/apply": fixture("jobvite-consent-policy.html"),
      "jobs.jobvite.com/fixturerobotics/job/oFixture2/apply/consent": fixture("jobvite-application.html"),
      "careers.fixturerobotics.com/jobs/1003/apply": fixture("attestation-application.html")
    };
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && request.resourceType() === "document") {
        if (/^careers-fixture\d*\.icims\.com$/.test(url.hostname)) {
          const wrapper = url.searchParams.get("in_iframe") !== "1" && /\/login\/?$/.test(url.pathname);
          await route.fulfill({ status: 200, contentType: "text/html", body: wrapper ? icimsWrapper : icimsFlow });
          return;
        }
        const body = documents[`${url.hostname}${url.pathname.replace(/\/$/, "")}`];
        if (body) {
          await route.fulfill({ status: 200, contentType: "text/html", body });
          return;
        }
      }
      await route.abort();
    });
    // At the moment of a create submit, the accounts file must already hold the pending password.
    const savedBeforeSubmit = new Map<string, boolean>();
    await context.exposeBinding("onFixtureIcimsSubmit", async (source, kind: string) => {
      if (kind !== "create") return;
      const host = new URL(source.page.url()).hostname;
      const entry = (() => { try { return getIcimsAccount(file, host); } catch { return null; } })();
      savedBeforeSubmit.set(host, entry?.account === "pending" && typeof entry.password === "string" && PASSWORD_RULE.test(entry.password));
    });
    context.on("console", (message) => captured.push(message.text()));
    for (const level of ["log", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    }

    const events = () => (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");
    const fixtureState = (tab: Page) => tab.evaluate(() => JSON.parse(localStorage.getItem("fixture-icims-state") || "{}") as FixtureIcims);
    const loginUrl = (host: string, mode: string) => `https://${host}/jobs/9001/intern/login?in_iframe=1&fixture=${mode}`;
    const framedLoginUrl = (host: string, mode: string) => `https://${host}/jobs/9001/intern/login?fixture=${mode}`;
    const inputValue = (tab: Page, selector: string) => tab.evaluate((query) => (document.querySelector(query) as HTMLInputElement | null)?.value ?? null, selector);
    const contentFrame = (tab: Page) => tab.frame({ name: "icims_content_iframe" });
    const frameInputValue = async (tab: Page, selector: string) => {
      const frame = contentFrame(tab);
      if (!frame) return null;
      return frame.evaluate((query) => (document.querySelector(query) as HTMLInputElement | null)?.value ?? null, selector);
    };

    async function icims(name: string, host: string, mode: string, acceptDataConsent = true, framed = false, signAttestations = false): Promise<{ tab: Page; result: string | null; error: Error | null }> {
      scenarios += 1;
      const tab = await context.newPage();
      const applicationUrl = framed ? framedLoginUrl(host, mode) : loginUrl(host, mode);
      await tab.goto(applicationUrl);
      const page = createApplicationPage(tab);
      try {
        const result = await ensureIcimsAccount(page, {
          database, jobId, applicationUrl, company: COMPANY, candidate: CANDIDATE, runtime, acceptDataConsent, signAttestations
        });
        return { tab, result, error: null };
      } catch (error) {
        const caught = error instanceof Error ? error : new Error(String(error));
        caughtMessages.push(caught.message);
        if (!(caught instanceof IcimsAccountHeld)) failures.push(`${name}: unexpected ${caught.name}: ${caught.message}`);
        return { tab, result: null, error: caught };
      }
    }
    const heldWith = (name: string, outcome: { error: Error | null; result: string | null }, text: string) => {
      if (!(outcome.error instanceof IcimsAccountHeld)) failures.push(`${name}: expected a hold, got ${outcome.result ?? outcome.error?.message}`);
      else if (!outcome.error.message.includes(text)) failures.push(`${name}: the hold does not say "${text}": ${outcome.error.message}`);
    };

    // A new account: consent ticked and logged, alerts untouched, password saved first, legal name typed.
    const newHost = "careers-fixture.icims.com";
    const created = await icims("new", newHost, "new");
    check(created.result === "created", `new: expected "created", got ${created.result ?? created.error?.message}`);
    check(savedBeforeSubmit.get(newHost) === true, "new: the password was not saved (pending) before the create submit");
    check((statSync(file).mode & 0o777) === 0o600, `new: accounts file mode ${(statSync(file).mode & 0o777).toString(8)}`);
    const newEntry = getIcimsAccount(file, newHost);
    check(newEntry?.account === "created" && newEntry.hold === null, `new: entry is ${newEntry?.account} / ${newEntry?.hold?.kind}`);
    check(Boolean(newEntry?.password && PASSWORD_RULE.test(newEntry.password)), "new: the saved password breaks the password policy");
    const newState = await fixtureState(created.tab);
    check(newState.gdprChecked && !newState.alertsChecked, `new: gdpr ${newState.gdprChecked}, alerts ${newState.alertsChecked}`);
    check(newState.typedFirst === "Jordan" && newState.typedLast === "Rivera", "new: the legal name was not typed");
    check(/\/candidate\?/.test(created.tab.url()), `new: not on the application (${created.tab.url()})`);
    check(events().some((detail) => detail.startsWith("Accepted data consent: 'I consent to Fixture Robotics collecting, processing and storing my personal data") && detail.endsWith(`(iCIMS email step at ${newHost})`)), "new: no data-consent event");
    check(events().includes(`iCIMS ${newHost}: account created with your email; the password is saved locally.`), "new: no account-created event");
    await created.tab.close();

    // The same host again: signed in with the saved password, nothing created.
    const again = await icims("again", newHost, "new");
    check(again.result === "signed-in", `again: expected "signed-in", got ${again.result ?? again.error?.message}`);
    const againState = await fixtureState(again.tab);
    check(againState.creates === 1 && againState.signIns === 1, `again: ${againState.creates} creates, ${againState.signIns} sign-ins`);
    check(events().includes(`iCIMS ${newHost}: signed in with the saved account.`), "again: no signed-in event");
    await again.tab.close();

    // An existing account with no saved password: held with the exact text, the password box untouched.
    const existingHost = "careers-fixture2.icims.com";
    const existing = await icims("existing", existingHost, "existing");
    heldWith("existing", existing, `iCIMS ${existingHost}: an iCIMS account exists for your email at ${existingHost} but no password is saved.`);
    check((await inputValue(existing.tab, "#loginPassword")) === "", "existing: something was typed into the password box");
    check(getIcimsAccount(file, existingHost)?.hold?.kind === "exists-no-password", "existing: the hold is not exists-no-password");
    await existing.tab.close();

    // hCaptcha: held before anything is typed.
    const captchaHost = "careers-fixture3.icims.com";
    const captcha = await icims("captcha", captchaHost, "captcha");
    heldWith("captcha", captcha, "the agent never solves CAPTCHAs");
    check((await inputValue(captcha.tab, "#email")) === "", "captcha: the email was typed");
    check(getIcimsAccount(file, captchaHost)?.hold?.kind === "captcha", "captcha: the hold is not captcha");
    await captcha.tab.close();

    // Email verification: the emailed link is opened, then the agent signs in.
    const verifyHost = "careers-fixture4.icims.com";
    mail = async () => [{
      from: "Fixture Robotics via iCIMS <no-reply@icims.com>", subject: "Verify your email address", receivedAt: new Date(),
      text: `Verify your account: https://${verifyHost}/jobs/9001/intern/verify?token=fixture-token`, html: ""
    }];
    const verified = await icims("verify", verifyHost, "verify");
    mail = async () => [];
    check(verified.result === "created", `verify: expected "created", got ${verified.result ?? verified.error?.message}`);
    check(events().includes(`iCIMS ${verifyHost}: verification email found and opened.`), "verify: no verification event");
    const verifyState = await fixtureState(verified.tab);
    check(verifyState.creates === 1 && verifyState.signIns === 1, `verify: ${verifyState.creates} creates, ${verifyState.signIns} sign-ins`);
    await verified.tab.close();

    // The data-consent setting off: held, the email never submitted.
    const consentHost = "careers-fixture5.icims.com";
    const consent = await icims("consent-off", consentHost, "new", false);
    heldWith("consent-off", consent, "only under your standing data-consent setting");
    check(getIcimsAccount(file, consentHost)?.hold?.kind === "consent-setting", "consent-off: the hold is not consent-setting");
    check((await fixtureState(consent.tab)).emailSubmits === undefined || (await fixtureState(consent.tab)).emailSubmits === 0, "consent-off: the email was submitted");
    check((await inputValue(consent.tab, "#email")) === "", "consent-off: the email was typed");
    await consent.tab.close();

    // A saved password iCIMS refuses: held once, and never typed again.
    const wrongHost = "careers-fixture6.icims.com";
    const stamp = new Date().toISOString();
    putIcimsAccount(file, { host: wrongHost, email: EMAIL, password: "Saved-Pass-1234!", account: "created", hold: null, createdAt: stamp, updatedAt: stamp });
    const wrong = await icims("wrong-password", wrongHost, "wrongpw");
    heldWith("wrong-password", wrong, "iCIMS refused the saved password");
    check(getIcimsAccount(file, wrongHost)?.hold?.kind === "wrong-password", "wrong-password: the hold is not wrong-password");
    await wrong.tab.close();
    const wrongAgain = await icims("wrong-password again", wrongHost, "wrongpw");
    heldWith("wrong-password again", wrongAgain, "iCIMS refused the saved password");
    check((await fixtureState(wrongAgain.tab)).signIns === 1, "wrong-password again: the refused password was typed again");
    check((await inputValue(wrongAgain.tab, "#email")) === "", "wrong-password again: the email was typed again");
    await wrongAgain.tab.close();

    // iCIMS's account screens inside the career site's same-host content frame: created, consent logged, legal name typed.
    const framedHost = "careers-fixture7.icims.com";
    const framed = await icims("framed new", framedHost, "new", true, true);
    check(framed.result === "created", `framed new: expected "created", got ${framed.result ?? framed.error?.message}`);
    check(savedBeforeSubmit.get(framedHost) === true, "framed new: the password was not saved (pending) before the create submit");
    const framedEntry = getIcimsAccount(file, framedHost);
    check(framedEntry?.account === "created" && framedEntry.hold === null, `framed new: entry is ${framedEntry?.account} / ${framedEntry?.hold?.kind}`);
    const framedState = await fixtureState(framed.tab);
    check(framedState.gdprChecked && !framedState.alertsChecked, `framed new: gdpr ${framedState.gdprChecked}, alerts ${framedState.alertsChecked}`);
    check(framedState.typedFirst === "Jordan" && framedState.typedLast === "Rivera", "framed new: the legal name was not typed");
    check(/\/login\?/.test(framed.tab.url()), `framed new: the top page left the wrapper (${framed.tab.url()})`);
    check(/\/candidate\?/.test(contentFrame(framed.tab)?.url() ?? ""), `framed new: the content frame is not on the application (${contentFrame(framed.tab)?.url()})`);
    check(events().some((detail) => detail.startsWith("Accepted data consent: 'I consent to Fixture Robotics collecting") && detail.endsWith(`(iCIMS email step at ${framedHost})`)), "framed new: no data-consent event");
    await framed.tab.close();

    // The framed host again: signed in with the saved password, nothing created.
    const framedAgain = await icims("framed again", framedHost, "new", true, true);
    check(framedAgain.result === "signed-in", `framed again: expected "signed-in", got ${framedAgain.result ?? framedAgain.error?.message}`);
    const framedAgainState = await fixtureState(framedAgain.tab);
    check(framedAgainState.creates === 1 && framedAgainState.signIns === 1, `framed again: ${framedAgainState.creates} creates, ${framedAgainState.signIns} sign-ins`);
    await framedAgain.tab.close();

    // A privacy-notice acknowledgment beside the box (the box's own block): read whole, ticked under the attestation setting.
    const ackHost = "careers-fixture9.icims.com";
    const ack = await icims("ack", ackHost, "ack", true, false, true);
    check(ack.result === "created", `ack: expected "created", got ${ack.result ?? ack.error?.message}`);
    const ackEvent = events().find((detail) => detail.endsWith(`(iCIMS email step at ${ackHost})`)) ?? "";
    check(ackEvent.startsWith("Accepted attestation: 'Please review the Fixture Robotics Applicant Privacy Notice"), `ack: the event is ${ackEvent}`);
    check(ackEvent.includes("I acknowledge I have reviewed and understand the Fixture Robotics Applicant Privacy Notice."), `ack: the event misses the acknowledgment: ${ackEvent}`);
    check(!ackEvent.includes("You must indicate"), `ack: the screen-reader description was read as the statement: ${ackEvent}`);
    check((await fixtureState(ack.tab)).gdprChecked, "ack: the acknowledgment box was not ticked");
    await ack.tab.close();

    // The same acknowledgment with the data-consent setting alone: held as attestation-setting, nothing typed.
    const ackOffHost = "careers-fixture10.icims.com";
    const ackOff = await icims("ack without attestations", ackOffHost, "ack", true, false, false);
    heldWith("ack without attestations", ackOff, "only under your standing attestation setting");
    check(getIcimsAccount(file, ackOffHost)?.hold?.kind === "attestation-setting", `ack without attestations: the hold is ${getIcimsAccount(file, ackOffHost)?.hold?.kind}`);
    check(((await fixtureState(ackOff.tab)).emailSubmits ?? 0) === 0, "ack without attestations: the email was submitted");
    check((await inputValue(ackOff.tab, "#email")) === "", "ack without attestations: the email was typed");
    await ackOff.tab.close();

    // A box whose legal text is empty ("I accept"): held as consent-unknown with both settings on, nothing typed.
    const blankHost = "careers-fixture11.icims.com";
    const blank = await icims("blank", blankHost, "blank", true, false, true);
    heldWith("blank", blank, `asks you to agree to "I accept"`);
    check(getIcimsAccount(file, blankHost)?.hold?.kind === "consent-unknown", `blank: the hold is ${getIcimsAccount(file, blankHost)?.hold?.kind}`);
    check((await inputValue(blank.tab, "#email")) === "", "blank: the email was typed");
    await blank.tab.close();

    // hCaptcha inside the content frame: held before anything is typed.
    const framedCaptchaHost = "careers-fixture8.icims.com";
    const framedCaptcha = await icims("framed captcha", framedCaptchaHost, "captcha", true, true);
    heldWith("framed captcha", framedCaptcha, "the agent never solves CAPTCHAs");
    check(getIcimsAccount(file, framedCaptchaHost)?.hold?.kind === "captcha", "framed captcha: the hold is not captcha");
    check((await frameInputValue(framedCaptcha.tab, "#email")) === "", "framed captcha: the email was typed");
    await framedCaptcha.tab.close();

    // Jobvite: the posting's Apply, then the residence from the profile country and Accept.
    scenarios += 1;
    const jobviteTab = await context.newPage();
    await jobviteTab.goto(JOBVITE_POSTING);
    const jobvite = createApplicationPage(jobviteTab);
    const reached = await jobvite.followApplyEntry!();
    check(reached === `${JOBVITE_POSTING}/apply`, `jobvite: Apply followed to ${reached}`);
    const accepted = await jobvite.jobviteConsent((options) => chooseResidenceOption("United States", options));
    check(accepted.result === "accepted" && accepted.residence === "US Based Applicants (English)", `jobvite: ${JSON.stringify(accepted)}`);
    check(accepted.result === "accepted" && accepted.policyText.includes("processes and stores your application data"), "jobvite: the policy text was not read");
    const behind = await recognizeCurrentForm(jobvite);
    check(behind.fields.some((field) => field.label === "First Name"), `jobvite: the form behind the consent step: ${behind.fields.map((field) => field.label).join(", ")}`);
    for (const [fieldId, option, controlId] of [["work", "Yes", "jv-work-yes"], ["visa", "No", "jv-visa-no"]]) {
      const field = behind.fields.find((entry) => entry.id === fieldId);
      check(field?.options?.includes(option) === true, `jobvite: ${fieldId} should expose ${option}`);
      check(await jobviteTab.locator(`#${controlId}`).evaluate((input) => input.classList.contains("ng-invalid")), `jobvite: ${fieldId} should start with ng-invalid`);
      const result = await applyDecisions(jobvite, behind, [
        { fieldId, action: "choose", value: option, basis: null, reason: "Fixture answer", pause: null }
      ]);
      check(result.applied === 1 && await jobviteTab.locator(`#${controlId}`).isChecked(), `jobvite: ${fieldId} should select ${option} by its visible label`);
      check(await jobviteTab.locator(`#${controlId}`).evaluate((input) => input.classList.contains("ng-valid") && !input.classList.contains("ng-invalid")), `jobvite: ${fieldId} should trigger Angular ng-valid`);
    }
    // Styled radio without an associated label: falls back to dispatching click on target and triggers ng-valid.
    await jobviteTab.locator('label[for="jv-visa-yes"]').evaluate((label) => label.remove());
    const dispatchResult = await applyDecisions(jobvite, behind, [
      { fieldId: "visa", action: "choose", value: "Yes", basis: null, reason: "Fixture answer", pause: null }
    ]);
    check(dispatchResult.applied === 1 && await jobviteTab.locator("#jv-visa-yes").isChecked(), "jobvite: visa should select Yes via dispatched click when no label is found");
    check(await jobviteTab.locator("#jv-visa-yes").evaluate((input) => input.classList.contains("ng-valid")), "jobvite: dispatched click should trigger Angular ng-valid");
    await jobviteTab.locator('label[for="jv-work-no"]').evaluate((label) => { label.textContent = "Yes"; });
    const ambiguous = await recognizeCurrentForm(jobvite);
    const refused = await applyDecisions(jobvite, ambiguous, [
      { fieldId: "work", action: "choose", value: "Yes", basis: null, reason: "Fixture answer", pause: null }
    ]);
    check(refused.applied === 0 && refused.unfilled.length === 1, "jobvite: duplicate labels must leave the radio group unchanged");
    await jobviteTab.close();

    scenarios += 1;
    const canadaTab = await context.newPage();
    await canadaTab.goto(`${JOBVITE_POSTING}/apply`);
    const canada = await createApplicationPage(canadaTab).jobviteConsent((options) => chooseResidenceOption("Canada", options));
    check(canada.result === "no-residence", `jobvite canada: ${JSON.stringify(canada)}`);
    const clicks = await canadaTab.evaluate(() => (window as unknown as { fixtureJobvite: { acceptClicks: number } }).fixtureJobvite.acceptClicks);
    check(clicks === 0 && /\/apply$/.test(canadaTab.url()), `jobvite canada: ${clicks} Accept clicks, at ${canadaTab.url()}`);
    await canadaTab.close();

    // An attestation form, with the settings on and off.
    const signedName = "Jordan Rivera";
    const fillAttestations = async (standing: StandingInputs | undefined) => {
      scenarios += 1;
      const tab = await context.newPage();
      await tab.goto(ATTESTATION_FORM);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      const plan = planAutofill(form, {
        profile: { fullName: signedName, email: EMAIL, legalFirstName: "Jordan", legalLastName: "Rivera" },
        resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID, standing
      });
      await applyDecisions(page, form, plan.decisions);
      const dom = await tab.evaluate(() => {
        const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
        const checked = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;
        return {
          signature: value("signature"), date: value("signature_date"),
          certify: checked("certify"), background: checked("background"), retain: checked("retain"), usPerson: checked("us_person"), marketing: checked("marketing")
        };
      });
      await tab.close();
      return { plan, dom };
    };
    const signed = await fillAttestations({ acceptDataConsent: true, signAttestations: true, signatureName: signedName, today: "2026-11-20" });
    check(signed.dom.signature === signedName && signed.dom.date === "11/20/2026", `attestation: signature "${signed.dom.signature}", date "${signed.dom.date}"`);
    check(signed.dom.certify && signed.dom.background && signed.dom.retain, `attestation: boxes ${JSON.stringify(signed.dom)}`);
    check(!signed.dom.usPerson && !signed.dom.marketing, "attestation: the export-control or marketing box was checked");
    check(signed.plan.pauses.map((pause) => pause.fieldId).join(",") === "us_person", `attestation: pauses ${signed.plan.pauses.map((pause) => pause.fieldId).join(",")}`);
    const unsigned = await fillAttestations(undefined);
    check(!unsigned.dom.certify && !unsigned.dom.background && !unsigned.dom.retain && !unsigned.dom.usPerson && !unsigned.dom.marketing, `no settings: boxes ${JSON.stringify(unsigned.dom)}`);
    check(unsigned.dom.signature === "" && unsigned.dom.date === "", "no settings: the signature or date was filled");
    const unsignedPauses = new Set(unsigned.plan.pauses.map((pause) => pause.fieldId));
    check(["certify", "signature", "signature_date", "background", "retain", "us_person"].every((id) => unsignedPauses.has(id)), `no settings: pauses ${[...unsignedPauses].join(",")}`);

    // No password anywhere it must not be.
    const passwords = Object.values(readIcimsAccounts(file)).map((entry) => entry.password).filter((value): value is string => Boolean(value));
    check(passwords.length >= 3, `expected at least 3 saved passwords, found ${passwords.length}`);
    const rows = JSON.stringify(["application_events", "browser_sessions", "browser_runs"].map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
    for (const password of passwords) {
      if (rows.includes(password)) failures.push("a password reached the database");
      if (captured.some((line) => line.includes(password))) failures.push("a password reached the console");
      if (caughtMessages.some((message) => message.includes(password))) failures.push("a password reached an error message");
    }
    if (caughtMessages.some((message) => message.includes(EMAIL))) failures.push("the account email reached an error message");
    if (captured.some((line) => line.includes("Rivera"))) failures.push("the legal name reached the console");
    database.close();
    await context.close();
  } finally {
    Object.assign(console, originals);
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`ACCOUNT_CONSENT_RUN_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`ACCOUNT_CONSENT_RUN_REPORT {"status":"passed","scenarios":${scenarios}}`);
}

main().catch((error) => {
  console.error(`ACCOUNT_CONSENT_RUN_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
