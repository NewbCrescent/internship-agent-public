/**
 * Greenhouse's new job board forms, Ashby and Lever application forms,
 * visible CAPTCHA challenges, and the Oracle Cloud HCM and SmartRecruiters
 * recognition, in real Chromium against
 * fictional fixtures served on their real host names inside one browser
 * context (every other request, including the reCAPTCHA frames, is aborted,
 * so no network is used). Proves: labels come from aria-labelledby and
 * upload groups ("Resume/CV" and "Cover Letter", not "Attach"); react-select
 * lists are one select with their options, and their hidden required inputs
 * and the g-recaptcha-response token are not questions; a "How did you hear
 * about us?" checkbox group is one question answered from the saved how_heard
 * fact; the resume goes only to #resume; the invisible reCAPTCHA badge is not
 * a challenge while a visible reCAPTCHA, hCaptcha, Turnstile, or DataDome
 * frame is; a challenge or a refusal after the submit click is held, never
 * read as submitted. Greenhouse's Email text box is filled from the profile
 * and its async "Location (City)" list is typed into and the matching place
 * picked. Ashby (fixtures/ashby-application.html, from the 2026-11-19 capture)
 * is recognized and its labels read (no "Unlabeled", no "Start typing...", no
 * token; the "Autofill from resume" box is not a question); Name, Email, and
 * LinkedIn fill, the resume uploads, the optional cover letter stays empty,
 * and the "Start typing..." location picks the unique matching suggestion or,
 * with no match, comes back as an unfilled field (a pause), never a throw.
 * Dover (fixtures/dover-application.html, reduced from the 2026-11-20
 * read-only jobs.dover.com captures, served at jobs.dover.com where
 * app.dover.io links redirect) takes each label from the sibling
 * `styles__FormLabel-…` div, never the U+200B notched-outline legend, an
 * option's own "Yes" label, or a UUID name; the "Autofill from resume" drop
 * zone and the Turnstile token are not questions; it is classified dover with
 * the automatic flow; First and Last Name, Email, Phone Number, LinkedIn
 * Profile URL, and the resume fill from the profile, and the Apply submit's
 * "Thanks for applying!" is confirmed. Dover's Cloudflare Turnstile frame
 * inside a closed shadow root (?turnstile=) is a challenge when shown and not
 * when hidden, and one drawn by the Apply click holds the submit as challenged
 * with evidence while nothing is sent.
 * Lever (fixtures/lever-application.html, derived) labels carry no "✱" or
 * widget status text; Full name and Phone map; a radio question is one field
 * and the right radio is checked; the data-retention consent checkbox pauses
 * with a plain reason and stays unticked; "Berkeley, California" picks its
 * suggestion while a bare, ambiguous "Berkeley" is left unfilled. Detection is
 * read-only: nothing is solved or injected.
 * Greenhouse's education block is filled from the profile (School and
 * Discipline typed into their searched lists, "B.A. Computer Science" picks
 * "Bachelor’s Degree", start month and year from the education start month,
 * end month and year from the run's graduation date), the phone Country takes
 * "United States +1" for a "USA" profile although the list then shows only
 * "+1", an optional "Preferred First Name" stays empty with no preferred name
 * on the profile, and a City, ST value picks the spelled-out
 * suggestion on Greenhouse, Ashby, and Lever. Ashby's success
 * container after the click (fixture ?submitted=default|custom) is a
 * confirmation, even with a custom message; with none the submit fails closed.
 * Oracle's email step (fixtures/oracle-apply-email.html, derived) reads no
 * button ("Discard", "Back", "Cancel", "Next") as a field. Greenhouse's
 * optional employment block (same "Start date month" labels, employment ids)
 * is never filled from education data. The School catalog spells campuses
 * "System - Campus" ("University of Example - Springfield"): the profile's
 * "University of Example, Springfield" picks it by the same words; a school no
 * catalog entry matches leaves only School unfilled (its menu is closed and
 * its box emptied, so Degree, Discipline, and the dates below it still fill),
 * and no list menu is left open. A Greenhouse question description is
 * appended to a short heading label ("HISTORY WITH FIXTURE ROBOTICS: Have you
 * previously applied …?") but not to a label whose description asks nothing.
 * Ashby's location box (no id or name, as on the 2026-11-20 Fernwave capture) is
 * located by its data-ia-control tag, which stays the same across
 * recognitions; its Yes/No button pairs are radio questions with a `_required`
 * title read as required and clicked by their button; its fieldset radio
 * question takes its question title as label and pauses ("work from this
 * location" is never answered from a saved fact). Ashby's text-message consent
 * (fixtures/ashby-texting-consent.html, derived from Ashby's public bundle and
 * checked against a read-only 2026-11-24 capture): the communicationConsent
 * radios inside the phone field's entry take the consent text as their label
 * (never their name or the phone's title, and not required by the phone's
 * `_required`), the candidate's text-message rule answers Yes and the radio is
 * checked, and a fieldset checkbox group with no legend takes its title.
 * Posting pages behind an Apply link (fixtures derived from the 2026-11-20
 * read-only Jobvite and iCIMS captures): a careers posting's own "Apply for
 * this job" link is followed to its form, never "Apply with LinkedIn",
 * Indeed, or a share link, and a page with only those finds no entry; an
 * iCIMS job frame's Apply button is followed through its redirect (served by
 * a local server, since Playwright does not route redirected requests; the
 * browser resolves every other unrouted host to nothing) to the
 * email-first account step, which is named as a wall (and no button there is
 * a field); Jobvite's /apply link reaches its data-consent step, named as a
 * wall; both kinds are recognized for display and need the candidate's
 * approval. No followed page ever reaches linkedin.com or indeed.com.
 * Post-submit outcomes (fixtures derived from public knowledge, not
 * captured): Greenhouse's redirect to <job>/confirmation and an inline "Thank
 * you for applying" under a description that already says "Thank you for
 * your interest" confirm, as does Lever's /thanks page with a custom message;
 * Email and School re-rendered invalid after the click ("This field is
 * required.") are field errors with their labels and errors (needs input,
 * query-stripped URL); a banner is refused and a CAPTCHA after the click
 * challenged, each with evidence; a click that shows nothing is unconfirmed
 * with evidence; and a full-page screenshot is written. Greenhouse's emailed
 * security-code step (?code=1, derived from third-party descriptions): the
 * code from a fake mailbox is typed into the eight boxes and the step's own
 * Submit clicked (the form's Submit is not clicked again), then the
 * confirmation, with the code never in the returned text; no email and two
 * different codes hold the run (SubmissionCodeNotFound, verification-code
 * evidence) and nothing is sent. Ashby's answer saves (fixture ?saving= and
 * ?failure=, derived from Ashby's public bundle): a submit click made while an
 * answer is still saving (Ashby's "We're updating your application" notice,
 * which sends nothing) is made again once the notice is gone and exactly one
 * submission arrives; a save that never ends fails closed after one click
 * with the notice in the evidence; Ashby's spam-check failure container is
 * held as challenged and a generic one refused, neither clicked again.
 * Ashby's single- and multi-choice questions (fixtures/ashby-value-select.html,
 * derived from Ashby's public bundle, Track 22) are drawn without the
 * field-entry wrapper: the radio or checkbox group's `_required` title marks
 * them required, and the short "Visa Support" title takes its question from
 * Ashby's description. The form draws a fresh render id on every load and
 * React-controlled radios (Track 25): a run planned on one load fills, reads
 * back, and submits on another, and a radio that will not take is reported
 * unfilled and never reads back as chosen. Ashby's submit on the network (fixture ?network=,
 * answered by this harness's routes): the reCAPTCHA token request and the
 * ApiSubmitSingleApplicationFormAction submit are recorded (operation names,
 * statuses, booleans, codes and messages; never the answers, token, or
 * fingerprint the body holds); FormSubmitSuccess confirms with no success
 * container, RECAPTCHA_SCORE_BELOW_THRESHOLD is held as challenged after one
 * click, FormRender field errors pause the named field, and a token request
 * never followed by a submit or a 500 fails closed with the record in the
 * evidence.
 *
 * Usage: pnpm test:browser:greenhouse
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium, type Page } from "playwright-core";

import {
  applyDecisions,
  atsFlowFor,
  choicesNotTaken,
  classifyAts,
  applicationWallReason,
  createPlaywrightPage,
  INVISIBLE_CHARACTERS,
  isCaptchaTokenControl,
  planAutofill,
  postSubmitEvidenceOf,
  recognizeCurrentForm,
  ASHBY_ACCEPTED_CONFIRMATION,
  ASHBY_SPAM_CHECK_DETAIL,
  invalidFieldPauses,
  type AshbySubmitNetwork,
  submitAndConfirm,
  SubmissionChallenged,
  SubmissionCodeNotFound,
  SubmissionNeedsInput,
  SubmissionRefused,
  SubmissionUnconfirmed,
  UNLABELED_CONTROL_LABEL,
  type FieldResolution
} from "@internship-agent/browser";
import { greenhouseSecurityCodeLookup, type MailMessage, type VerificationMailboxFactory } from "@internship-agent/agent";
import type { FillDecision } from "@internship-agent/domain";

const PREFIX = "internship-agent-greenhouse-";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const GREENHOUSE = "https://job-boards.greenhouse.io/fixturerobotics/jobs/1000001";
const ORACLE = "https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001";
const SMARTRECRUITERS = "https://jobs.smartrecruiters.com/FixtureRobotics/744000000000001-robotics-software-intern";
const SMARTRECRUITERS_APPLY = "https://jobs.smartrecruiters.com/oneclick-ui/company/FixtureRobotics/publication/00000000-0000-4000-8000-000000000000";
const ASHBY = "https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a1/application";
const ASHBY_TEXTING = "https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a2/application";
const ASHBY_VALUE_SELECT = "https://jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a3/application";
/** The Visa Support question's field path in fixtures/ashby-value-select.html (its field id; its entry id is "<render id>_<path>"). */
const ASHBY_VISA_PATH = "9a0b1c2d-0000-4000-8000-0000000000d1";
const LEVER = "https://jobs.lever.co/fixturerobotics/00000000-0000-4000-8000-0000000000b1/apply";
/** Where app.dover.io application links land (they redirect to jobs.dover.com/job/<id>). */
const DOVER = "https://jobs.dover.com/job/00000000-0000-4000-8000-0000000000d1";
const CAREERS_POSTING = "https://careers.fixturerobotics.com/jobs/1001";
const CAREERS_AGGREGATED = "https://careers.fixturerobotics.com/jobs/1002";
const ICIMS_POSTING = "https://careers-fixture.icims.com/jobs/9001/job";
const JOBVITE_POSTING = "https://jobs.jobvite.com/fixturerobotics/job/oFixture1";
/** The candidate profile the Ashby and Lever scenarios fill from (fictional). */
const PROFILE = {
  fullName: "Jordan Rivera", email: "jordan@example.test", phone: "+1 555 555 0100",
  linkedinUrl: "https://www.linkedin.com/in/jordan-fixture", addressCity: "Berkeley", addressRegion: "CA"
};
/** The DataDome page the read-only capture browser met on SmartRecruiters' application page, reduced. */
const DATADOME_PAGE = `<!doctype html><html><head><title>smartrecruiters.com</title></head><body style="margin:0">
  <iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=FIXTURE" title="DataDome CAPTCHA" width="100%" height="600" frameborder="0"></iframe></body></html>`;

type FixtureState = { uploads: Record<string, string | null>; checked: string[]; selects: Record<string, string>; submitted: boolean };

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  // A page that answers with a redirect: Playwright never routes the redirected request, so the
  // iCIMS account step after its 302 is served by a local server the browser resolves that host to.
  // Every other host resolves to nothing, so an unrouted request can never reach the network.
  const icimsLogin = readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", "icims-login.html"), "utf8");
  const redirectedRequests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    redirectedRequests.push(url.href);
    if (url.pathname === "/jobs/9001/intern/login") response.writeHead(200, { "content-type": "text/html" }).end(icimsLogin);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP careers-fixture.icims.com 127.0.0.1:${port}, MAP * ~NOTFOUND`] }).catch((error: unknown) => {
    server.close();
    throw error;
  });
  try {
    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const pages: Record<string, string> = {
      "job-boards.greenhouse.io": fixture("greenhouse-application.html"),
      "fixture.fa.ocs.oraclecloud.com": fixture("oracle-candidate-experience.html"),
      "jobs.smartrecruiters.com": fixture("smartrecruiters-application.html"),
      "jobs.ashbyhq.com": fixture("ashby-application.html"),
      "jobs.lever.co": fixture("lever-application.html"),
      "jobs.dover.com": fixture("dover-application.html")
    };
    const oracleEmail = fixture("oracle-apply-email.html");
    // Posting pages behind an Apply link, chosen by host and path.
    const byPath: Record<string, string> = {
      "careers.fixturerobotics.com/jobs/1001": fixture("careers-posting.html"),
      "careers.fixturerobotics.com/jobs/1001/apply": fixture("careers-apply.html"),
      "careers.fixturerobotics.com/jobs/1002": fixture("aggregator-posting.html"),
      "jobs.jobvite.com/fixturerobotics/job/oFixture1": fixture("jobvite-posting.html"),
      "jobs.jobvite.com/fixturerobotics/job/oFixture1/apply": fixture("jobvite-consent.html"),
      "jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a2/application": fixture("ashby-texting-consent.html"),
      "jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000a3/application": fixture("ashby-value-select.html"),
      // Post-submit confirmation pages.
      "job-boards.greenhouse.io/fixturerobotics/jobs/1000001/confirmation": fixture("greenhouse-confirmation.html"),
      "jobs.lever.co/fixturerobotics/00000000-0000-4000-8000-0000000000b1/thanks": fixture("lever-thanks.html")
    };
    const icimsPosting = fixture("icims-posting.html");
    const icimsFrame = fixture("icims-job-frame.html");
    const documentRequests: string[] = [];
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && request.resourceType() === "document") documentRequests.push(url.href);
      // Ashby's submit on the network (fixtures/ashby-value-select.html): reCAPTCHA's token request, then the
      // submit mutation, answered per the requesting page's ?network= scenario.
      if (url && url.hostname === "www.recaptcha.net" && url.pathname === "/recaptcha/enterprise/reload") {
        await route.fulfill({ status: 200, contentType: "text/plain", body: ")]}'\n[\"rresp\",\"fixture-rresp\"]" });
        return;
      }
      if (url && url.hostname === "jobs.ashbyhq.com" && url.pathname === "/api/non-user-graphql") {
        let pageUrl = "";
        try { pageUrl = request.frame().url(); } catch { pageUrl = ""; }
        if (!pageUrl) pageUrl = request.headers()["referer"] ?? "";
        let scenario: string | null = null;
        try { scenario = new URL(pageUrl).searchParams.get("network"); } catch { scenario = null; }
        let answers: { name?: unknown; email?: unknown } = {};
        let render = "";
        try {
          const variables = (JSON.parse(request.postData() ?? "{}") as { variables?: { answers?: typeof answers; formRenderIdentifier?: unknown } }).variables;
          answers = variables?.answers ?? {};
          render = typeof variables?.formRenderIdentifier === "string" ? variables.formRenderIdentifier : "";
        } catch {
          answers = {};
          render = "";
        }
        const json = (status: number, payload: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
        if (scenario === "accepted") {
          await json(200, { data: { submitApplicationFormAction: { applicationFormResult: { __typename: "FormSubmitSuccess" }, messages: { blockMessageForCandidateHtml: null } } } });
        } else if (scenario === "recaptcha") {
          await json(200, { data: null, errors: [{ message: "fixture refusal", extensions: { ashbyErrorType: "RECAPTCHA_SCORE_BELOW_THRESHOLD", message: "Your application could not be verified." } }] });
        } else if (scenario === "form-errors") {
          // Ashby's FormRender echoes the form's values back; the record must never keep them.
          await json(200, { data: { submitApplicationFormAction: {
            applicationFormResult: {
              __typename: "FormRender",
              id: "fixture-render",
              sections: [{ title: "Fixture section", fieldEntries: [] }],
              fieldValues: { _systemfield_name: answers.name ?? null, _systemfield_email: answers.email ?? null },
              errorMessages: ["Missing entry for required field: Visa Support"],
              formErrors: [{ message: "Missing entry for required field: Visa Support", fieldEntryId: `${render}_${ASHBY_VISA_PATH}` }]
            },
            messages: { blockMessageForCandidateHtml: null }
          } } });
        } else if (scenario === "server-error") {
          await json(500, { errors: [{ message: "Internal fixture error" }] });
        } else {
          await route.abort();
        }
        return;
      }
      // iCIMS answers its Apply link with a redirect to the account step.
      if (url && request.resourceType() === "document" && url.hostname === "careers-fixture.icims.com" && url.searchParams.get("mode") === "apply") {
        await route.fulfill({ status: 302, headers: { location: "http://careers-fixture.icims.com/jobs/9001/intern/login?in_iframe=1" } });
        return;
      }
      const body = url && request.resourceType() === "document"
        ? (url.hostname === "jobs.smartrecruiters.com" && url.pathname.startsWith("/oneclick-ui/") ? DATADOME_PAGE
          : url.hostname === "fixture.fa.ocs.oraclecloud.com" && url.pathname.endsWith("/apply/email") ? oracleEmail
            : url.hostname === "careers-fixture.icims.com" && url.pathname === "/jobs/9001/job"
              ? (url.searchParams.get("in_iframe") === "1" ? icimsFrame : icimsPosting)
              : byPath[`${url.hostname}${url.pathname}`] ?? pages[url.hostname])
        : undefined;
      if (body) await route.fulfill({ status: 200, contentType: "text/html", body });
      else await route.abort();
    });
    const open = async (url: string): Promise<Page> => {
      const tab = await context.newPage();
      await tab.goto(url);
      return tab;
    };
    const state = (tab: Page) => tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);

    // Recognition of the new board's form.
    const tab = await open(GREENHOUSE);
    const page = createPlaywrightPage(tab);
    const form = await recognizeCurrentForm(page);
    const byLabel = (label: string) => form.fields.filter((field) => field.label === label);
    check(!form.fields.some((field) => UNLABELED_CONTROL_LABEL.test(field.label)), `unlabeled fields: ${form.fields.filter((field) => UNLABELED_CONTROL_LABEL.test(field.label)).map((field) => field.label).join(", ")}`);
    check(!form.fields.some((field) => isCaptchaTokenControl({ id: field.id, name: field.label }) || /recaptcha/i.test(field.label)), "the CAPTCHA token field was read as a question");
    check(form.fields.filter((field) => field.kind === "file").map((field) => field.label).join("|") === "Resume/CV|Cover Letter",
      `file fields: ${form.fields.filter((field) => field.kind === "file").map((field) => field.label).join("|")}`);
    check(!form.fields.some((field) => field.label === "Attach"), "an upload is still labelled Attach");
    const hearAbout = byLabel("How did you hear about us?");
    check(hearAbout.length === 1 && hearAbout[0]!.kind === "checkbox" && hearAbout[0]!.options?.join("|") === "LinkedIn|Glassdoor|Indeed|Referred by a friend",
      `hear-about group: ${JSON.stringify(hearAbout)}`);
    check(byLabel("LinkedIn").length === 0 && byLabel("Glassdoor").length === 0, "checkbox options were read as separate questions");
    const authorization = byLabel("Are you legally authorized to work in the United States?")[0];
    check(authorization?.kind === "select" && authorization.options?.join("|") === "Yes|No", `authorization: ${JSON.stringify(authorization)}`);
    check(byLabel("Country")[0]?.options?.includes("United States +1") === true, "the phone country list options were not read");
    check(form.fields.some((field) => field.id === "start-year--0" && field.label === "Start date year"), "the education Start date year is missing");
    const firstName = byLabel("First Name")[0];
    check(firstName?.required === true, "First Name is not required");
    check(!form.fields.some((field) => field.label.endsWith("*")), "a label still ends with *");
    check(byLabel("HISTORY WITH FIXTURE ROBOTICS: Have you previously applied to a position at Fixture Robotics?").length === 1
      && byLabel("HISTORY WITH FIXTURE ROBOTICS").length === 0, `HISTORY question label: ${form.fields.filter((field) => /HISTORY/.test(field.label)).map((field) => field.label).join("|")}`);
    check(byLabel("Legal First Name").length === 1, `Legal First Name label: ${form.fields.filter((field) => /Legal First/.test(field.label)).map((field) => field.label).join("|")}`);
    const opened = await tab.locator('[role="listbox"]').count();
    check(opened === 0, "a react-select list was left open");
    const untouched = await state(tab);
    check(Object.keys(untouched.selects).length === 0, "reading the lists selected an option");

    // Planning and filling.
    const resolutions = new Map<string, FieldResolution>();
    if (hearAbout[0]) resolutions.set(hearAbout[0].id, { status: "RESOLVED", key: "how_heard", scope: "global", display: "Online job board", value: "Online job board" });
    if (authorization) resolutions.set(authorization.id, { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true });
    const school = byLabel("School")[0];
    check(school?.kind === "select" && school.widget === "autocomplete", `School is not a searched type-ahead: ${JSON.stringify(school)}`);
    check(byLabel("Discipline")[0]?.widget === "autocomplete", `Discipline is not a searched type-ahead: ${JSON.stringify(byLabel("Discipline")[0])}`);
    check(byLabel("Degree")[0]?.widget === undefined && byLabel("Degree")[0]?.options?.includes("Bachelor’s Degree") === true, `Degree: ${JSON.stringify(byLabel("Degree")[0])}`);
    check(byLabel("Preferred First Name")[0]?.required === false, `Preferred First Name: ${JSON.stringify(byLabel("Preferred First Name")[0])}`);
    // Planning: the education block from the profile (the run profile's graduation date for the end), the
    // phone Country from a "USA" profile, the City, ST value for the city list, and no preferred name invented.
    const plan = planAutofill(form, {
      profile: {
        email: "jordan@example.test", legalFirstName: "Jordan", legalLastName: "Rivera", addressCity: "Berkeley", addressRegion: "CA",
        addressCountry: "USA", fieldOfStudy: "Computer Science"
      },
      resolutions, packageAnswers: [], variantId: VARIANT_ID,
      education: {
        school: "University of Example, Springfield", degree: "B.A. Computer Science", startMonth: "2024-08",
        graduation: { date: "2028-05-15", basis: { kind: "fact", key: "graduation_date", scope: "global" } }
      }
    });
    const decisionFor = (label: string) => plan.decisions.find((decision) => decision.fieldId === byLabel(label)[0]?.id);
    const expected: Array<[string, string, string | null]> = [
      ["School", "choose", "University of Example, Springfield"], ["Degree", "choose", "Bachelor’s Degree"],
      ["Discipline", "choose", "Computer Science"], ["Start date month", "choose", "August"], ["Start date year", "fill", "2024"],
      ["End date month", "choose", "May"], ["End date year", "fill", "2028"], ["Country", "choose", "United States +1"],
      ["Location (City)", "choose", "Berkeley, CA"], ["Preferred First Name", "skip", null]
    ];
    for (const [label, action, value] of expected) {
      const decision = decisionFor(label);
      check(decision?.action === action && decision.value === value, `${label}: ${JSON.stringify(decision)}`);
    }
    // The employment block repeats the education date labels; it never takes education dates.
    const EMPLOYMENT_IDS = ["start-date-month--0", "start-date-year--0", "end-date-month--0", "end-date-year--0"];
    for (const id of EMPLOYMENT_IDS) {
      check(form.fields.some((field) => field.id === id), `employment field ${id} was not recognized`);
      const decision = plan.decisions.find((entry) => entry.fieldId === id);
      check(decision?.action === "skip" && decision.value === null, `employment ${id} took a value: ${JSON.stringify(decision)}`);
    }
    const educationPauses = plan.pauses.filter((pause) => expected.some(([label]) => label === pause.label));
    check(educationPauses.length === 0, `pauses on profile-covered fields: ${JSON.stringify(educationPauses.map((pause) => pause.label))}`);
    check(decisionFor("Resume/CV")?.action === "upload", `resume: ${JSON.stringify(decisionFor("Resume/CV"))}`);
    check(decisionFor("Cover Letter")?.action === "skip" && !plan.pauses.some((pause) => pause.label === "Cover Letter"), `the optional cover letter is not left empty: ${JSON.stringify(decisionFor("Cover Letter"))}`);
    check(decisionFor("Email")?.action === "fill" && decisionFor("Email")?.value === "jordan@example.test", `the Email text box is not filled from the profile: ${JSON.stringify(decisionFor("Email"))}`);
    const cityList = byLabel("Location (City)")[0];
    check(cityList?.kind === "select" && cityList.widget === "autocomplete", `Location (City) is not a type-ahead: ${JSON.stringify(cityList)}`);
    const hear = decisionFor("How did you hear about us?");
    check(hear?.action === "choose" && hear.value === "LinkedIn" && hear.basis?.kind === "fact" && hear.basis.key === "how_heard", `hear-about: ${JSON.stringify(hear)}`);
    check(decisionFor("Are you legally authorized to work in the United States?")?.action === "choose"
      && decisionFor("Are you legally authorized to work in the United States?")?.value === "Yes", "authorization is not chosen");
    check(!plan.safeguardHalt && !plan.pauses.some((pause) => pause.safeguard), "a safeguard pause on a page with only the invisible badge");
    const resumePdf = join(temp, "resume.pdf");
    writeFileSync(resumePdf, "%PDF-1.7\n% fixture resume\n%%EOF\n");
    const applied = await applyDecisions(page, form, plan.decisions, (decision) => (decision.action === "upload" ? resumePdf : null));
    check(applied.unfilled.length === 0, `Greenhouse unfilled: ${JSON.stringify(applied.unfilled)}`);
    check(await tab.locator('[class*="select__menu"]').filter({ visible: true }).count() === 0, "a list menu was left open after filling");
    const filled = await state(tab);
    check(await tab.inputValue("#email") === "jordan@example.test", "Email was not filled");
    check(filled.selects["candidate-location"] === "Berkeley, California, United States", `Location (City) picked: ${filled.selects["candidate-location"]}`);
    check(filled.uploads.resume === "resume.pdf" && filled.uploads.cover_letter === null, `uploads: ${JSON.stringify(filled.uploads)}`);
    check(filled.checked.join("|") === "LinkedIn", `checked: ${filled.checked.join("|")}`);
    check(filled.selects[authorization?.id ?? ""] === "Yes", `selects: ${JSON.stringify(filled.selects)}`);
    check(await tab.inputValue("#first_name") === "Jordan", "First Name was not filled");
    check(await tab.inputValue("#preferred_name") === "", "Preferred First Name was filled with no preferred name on the profile");
    const picked: Record<string, string> = {
      "school--0": "University of Example - Springfield", "degree--0": "Bachelor’s Degree", "discipline--0": "Computer Science",
      "start-month--0": "August", "end-month--0": "May", country: "United States +1"
    };
    for (const [id, value] of Object.entries(picked)) check(filled.selects[id] === value, `${id} picked: ${filled.selects[id]}`);
    check(await tab.inputValue("#start-year--0") === "2024" && await tab.inputValue("#end-year--0") === "2028",
      `education years: ${await tab.inputValue("#start-year--0")} / ${await tab.inputValue("#end-year--0")}`);
    for (const id of ["start-date-month--0", "end-date-month--0"]) check(filled.selects[id] === undefined, `employment ${id} picked: ${filled.selects[id]}`);
    for (const id of ["#start-date-year--0", "#end-date-year--0", "#company-name--0", "#title--0"]) {
      check(await tab.inputValue(id) === "", `employment ${id} was filled: ${await tab.inputValue(id)}`);
    }

    // A school no catalog entry matches: only School is left unfilled; its menu never covers the fields below.
    {
      const cascadeTab = await open(GREENHOUSE);
      const cascadePage = createPlaywrightPage(cascadeTab);
      const cascadeForm = await recognizeCurrentForm(cascadePage);
      const EDUCATION_IDS = new Set(["school--0", "degree--0", "discipline--0", "start-month--0", "start-year--0", "end-month--0", "end-year--0"]);
      const educationOnly = { ...cascadeForm, fields: cascadeForm.fields.filter((field) => EDUCATION_IDS.has(field.id)) };
      const cascadePlan = planAutofill(educationOnly, {
        profile: { fieldOfStudy: "Computer Science" }, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID,
        education: {
          school: "Nowhere Institute of Examples", degree: "B.A. Computer Science", startMonth: "2024-08",
          graduation: { date: "2028-05-15", basis: { kind: "fact", key: "graduation_date", scope: "global" } }
        }
      });
      const cascade = await applyDecisions(cascadePage, educationOnly, cascadePlan.decisions);
      check(cascade.unfilled.length === 1 && cascade.unfilled[0]!.fieldId === "school--0" && cascade.unfilled[0]!.reason === 'no suggestion matched "Nowhere Institute of Examples"',
        `no-match school unfilled: ${JSON.stringify(cascade.unfilled)}`);
      const cascadeState = await state(cascadeTab);
      const cascadePicked: Record<string, string> = { "degree--0": "Bachelor’s Degree", "discipline--0": "Computer Science", "start-month--0": "August", "end-month--0": "May" };
      for (const [id, value] of Object.entries(cascadePicked)) check(cascadeState.selects[id] === value, `no-match school: ${id} picked ${cascadeState.selects[id]}`);
      check(cascadeState.selects["school--0"] === undefined, `no-match school: School picked ${cascadeState.selects["school--0"]}`);
      check(await cascadeTab.inputValue("#start-year--0") === "2024" && await cascadeTab.inputValue("#end-year--0") === "2028",
        `no-match school years: ${await cascadeTab.inputValue("#start-year--0")} / ${await cascadeTab.inputValue("#end-year--0")}`);
      check(await cascadeTab.locator('[class*="select__menu"]').filter({ visible: true }).count() === 0, "no-match school: a list menu was left open");
      check(await cascadeTab.inputValue('[id="school--0"]') === "", `no-match school: the School box kept "${await cascadeTab.inputValue('[id="school--0"]')}"`);
      await cascadeTab.close();
    }

    // Challenges: the invisible badge and hidden token are not one; visible widgets are.
    check(await page.visibleChallenge!() === null, "the invisible reCAPTCHA badge was read as a challenge");
    for (const [variant, kind] of [["checkbox", "recaptcha"], ["hcaptcha", "hcaptcha"], ["turnstile", "turnstile"]] as const) {
      const challengeTab = await open(`${GREENHOUSE}?captcha=${variant}`);
      const challenge = await createPlaywrightPage(challengeTab).visibleChallenge!();
      check(challenge?.kind === kind, `?captcha=${variant}: ${JSON.stringify(challenge)}`);
      await challengeTab.close();
    }
    const datadomeTab = await open(SMARTRECRUITERS_APPLY);
    check((await createPlaywrightPage(datadomeTab).visibleChallenge!())?.kind === "challenge-page", "the DataDome page was not read as a challenge");
    await datadomeTab.close();

    // Submission: a confirmation passes; a challenge or a refusal after the click is held.
    await tab.fill("#last_name", "Rivera");
    await tab.fill("#email", "jordan@example.test");
    await tab.fill("#phone", "5555550100");
    const country = byLabel("Country")[0];
    if (country) await page.chooseOption(country, "United States +1");
    else failures.push("no Country list to choose the phone country in");
    const confirmation = await submitAndConfirm(page, { timeoutMs: 5_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
    check(confirmation.includes("Thank you for applying"), `default submit: ${confirmation.slice(0, 200)}`);
    for (const [query, expected, text, outcomeKind] of [
      ["captcha=after-submit", SubmissionChallenged, "never solves CAPTCHAs", "challenged"],
      ["refuse=1", SubmissionRefused, "There was a problem", "refused"]
    ] as const) {
      const heldTab = await open(`${GREENHOUSE}?${query}`);
      const outcome = await submitAndConfirm(createPlaywrightPage(heldTab), { timeoutMs: 1_500, pollMs: 100 }).then(() => null, (error: unknown) => error);
      check(outcome instanceof expected && String((outcome as Error).message).includes(text), `?${query}: ${outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : "submitted"}`);
      const evidence = postSubmitEvidenceOf(outcome);
      check(evidence?.outcome === outcomeKind && evidence.url === GREENHOUSE, `?${query} evidence: ${JSON.stringify(evidence && { outcome: evidence.outcome, url: evidence.url })}`);
      if (outcomeKind === "refused") check(evidence?.alertText.includes("There was a problem") === true, `?${query} evidence alert: ${evidence?.alertText}`);
      if (outcomeKind === "challenged") check(evidence?.challenge === "a reCAPTCHA image challenge", `?${query} evidence challenge: ${evidence?.challenge}`);
      check((await state(heldTab)).submitted === false, `?${query}: the fixture recorded a submission`);
      await heldTab.close();
    }

    // Post-submit outcomes: Greenhouse's confirmation redirect, an inline thanks under a description that
    // already says "thank you", field errors re-rendered after the click, and a click that shows nothing.
    {
      const redirectTab = await open(`${GREENHOUSE}?confirm=redirect`);
      const redirected = await submitAndConfirm(createPlaywrightPage(redirectTab), { timeoutMs: 5_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
      check(redirected.includes("Thank you for applying") && redirectTab.url() === `${GREENHOUSE}/confirmation`,
        `?confirm=redirect: ${redirected.slice(0, 200)} at ${redirectTab.url()}`);
      await redirectTab.close();

      const inlineTab = await open(`${GREENHOUSE}?confirm=inline`);
      const inline = await submitAndConfirm(createPlaywrightPage(inlineTab), { timeoutMs: 3_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
      check(inline.includes("Thank you for applying"), `?confirm=inline: ${inline.slice(0, 200)}`);
      await inlineTab.close();

      const invalidTab = await open(`${GREENHOUSE}?invalid=1`);
      const invalid = await submitAndConfirm(createPlaywrightPage(invalidTab), { timeoutMs: 1_500, pollMs: 100 }).then(() => null, (error: unknown) => error);
      const invalidEvidence = postSubmitEvidenceOf(invalid);
      check(invalid instanceof SubmissionNeedsInput
        && JSON.stringify(invalid.invalidFields) === JSON.stringify([
          { ref: "email", label: "Email", error: "This field is required." },
          { ref: "school--0", label: "School", error: "This field is required." }
        ])
        && !invalid.message.includes("This field is required"),
      `?invalid=1: ${invalid instanceof SubmissionNeedsInput ? JSON.stringify(invalid.invalidFields) : invalid instanceof Error ? `${invalid.constructor.name}: ${invalid.message}` : "submitted"}`);
      check(invalidEvidence?.outcome === "field-errors" && invalidEvidence.url === GREENHOUSE, `?invalid=1 evidence: ${JSON.stringify(invalidEvidence && { outcome: invalidEvidence.outcome, url: invalidEvidence.url })}`);
      check((await state(invalidTab)).submitted === false, "?invalid=1: the fixture recorded a submission");
      // A full-page screenshot of what the page showed, as the evidence writer takes it.
      const shot = join(temp, "full.png");
      await createPlaywrightPage(invalidTab).screenshot(shot, { fullPage: true });
      check(readFileSync(shot).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "the full-page screenshot is not a PNG");
      await invalidTab.close();

      const silentTab = await open(`${GREENHOUSE}?silent=1`);
      const silent = await submitAndConfirm(createPlaywrightPage(silentTab), { timeoutMs: 1_500, pollMs: 100 }).then(() => null, (error: unknown) => error);
      check(silent instanceof SubmissionUnconfirmed && silent.evidence.outcome === "unknown" && silent.evidence.invalidFields.length === 0 && silent.evidence.url === GREENHOUSE,
        `?silent=1: ${silent instanceof SubmissionUnconfirmed ? JSON.stringify({ outcome: silent.evidence.outcome, invalid: silent.evidence.invalidFields, url: silent.evidence.url }) : silent instanceof Error ? `${silent.constructor.name}: ${silent.message}` : "submitted"}`);
      await silentTab.close();
    }

    // Greenhouse's emailed security-code step (?code=1): the code from a fake mailbox is typed into the eight boxes
    // and the step's own Submit clicked, then the confirmation; no email or two codes hold, nothing sent.
    // Failure messages carry booleans and counts only, never the code.
    {
      const CODE = "K7QPZXMW";
      const OTHER_CODE = "QWERTYUI";
      const securityMail = (code: string): Omit<MailMessage, "receivedAt"> => ({
        from: "Greenhouse <no-reply@us.greenhouse-mail.io>",
        subject: "Security code for your application to Fixture Robotics",
        text: `Copy and paste this code into the security code field on your application: ${code}\n\nAfter you enter the code, resubmit your application.`,
        html: ""
      });
      const fakeMailbox = (messages: () => Array<Omit<MailMessage, "receivedAt">>): VerificationMailboxFactory => async () => ({
        messagesSince: async (_since, relevant) => messages().map((message) => ({ ...message, receivedAt: new Date() })).filter(relevant),
        close: async () => undefined
      });
      const lookupFor = (messages: Array<Omit<MailMessage, "receivedAt">>) =>
        greenhouseSecurityCodeLookup({ mailbox: fakeMailbox(() => messages), company: "Fixture Robotics", wait: { pollMs: 50, timeoutMs: 600 } });
      type CodeState = FixtureState & { formSubmits: number; securitySubmits: number; codeAccepted: boolean };
      const codeState = (codeTab: Page) => codeTab.evaluate(() => (window as unknown as { fixture: CodeState }).fixture);

      const enteredTab = await open(`${GREENHOUSE}?code=1`);
      const entered = await submitAndConfirm(createPlaywrightPage(enteredTab), { timeoutMs: 5_000, pollMs: 100, securityCode: lookupFor([securityMail(CODE)]) })
        .then((text) => ({ text, error: null as unknown }), (error: unknown) => ({ text: "", error }));
      const enteredState = await codeState(enteredTab);
      check(entered.text.includes("Thank you for applying") && !entered.text.includes(CODE),
        `?code=1 with the email: confirmed=${entered.text.includes("Thank you for applying")} codeInText=${entered.text.includes(CODE)} error=${entered.error instanceof Error ? entered.error.constructor.name : "none"}`);
      check(enteredState.codeAccepted && enteredState.formSubmits === 1 && enteredState.securitySubmits === 1,
        `?code=1 with the email: accepted=${enteredState.codeAccepted} formSubmits=${enteredState.formSubmits} securitySubmits=${enteredState.securitySubmits}`);
      await enteredTab.close();

      const noMailTab = await open(`${GREENHOUSE}?code=1`);
      const noMail = await submitAndConfirm(createPlaywrightPage(noMailTab), { timeoutMs: 5_000, pollMs: 100, securityCode: lookupFor([]) }).then(() => null, (error: unknown) => error);
      const noMailEvidence = postSubmitEvidenceOf(noMail);
      const noMailState = await codeState(noMailTab);
      check(noMail instanceof SubmissionCodeNotFound && noMail.message.startsWith("Greenhouse emailed a security code; it was not found")
        && noMailEvidence?.outcome === "verification-code" && noMailEvidence.url === GREENHOUSE,
      `?code=1 without an email: ${noMail instanceof Error ? `${noMail.constructor.name}: ${noMail.message}` : "submitted"} evidence=${noMailEvidence?.outcome ?? "none"}`);
      check(!noMailState.submitted && noMailState.securitySubmits === 0, `?code=1 without an email: submitted=${noMailState.submitted} securitySubmits=${noMailState.securitySubmits}`);
      await noMailTab.close();

      const twoTab = await open(`${GREENHOUSE}?code=1`);
      const two = await submitAndConfirm(createPlaywrightPage(twoTab), { timeoutMs: 5_000, pollMs: 100, securityCode: lookupFor([securityMail(CODE), securityMail(OTHER_CODE)]) })
        .then(() => null, (error: unknown) => error);
      const twoState = await codeState(twoTab);
      check(two instanceof SubmissionCodeNotFound && two.message.includes("not found unambiguously") && !two.message.includes(CODE) && !two.message.includes(OTHER_CODE),
        `?code=1 with two codes: ${two instanceof Error ? two.constructor.name : "submitted"} ambiguous=${two instanceof Error && two.message.includes("not found unambiguously")}`);
      check(!twoState.submitted && twoState.securitySubmits === 0, `?code=1 with two codes: submitted=${twoState.submitted} securitySubmits=${twoState.securitySubmits}`);
      await twoTab.close();
    }

    // Ashby: recognized, labels read, the resume and profile fields filled, the location picked from its suggestions,
    // the Yes/No buttons answered from saved facts, and the "work from this location" radio paused.
    {
      const ashbyTab = await open(ASHBY);
      const ashby = createPlaywrightPage(ashbyTab);
      const ashbyForm = await recognizeCurrentForm(ashby);
      const labels = ashbyForm.fields.map((field) => field.label);
      const AUTHORIZATION = "Do you have work authorization to work in that country?";
      const SPONSORSHIP = "Will you now or in the future require visa sponsorship to work in that country?";
      const ON_SITE = "This role is based in our Fixture City office and involves working primarily in person. Are you willing and able to work from this location?";
      check(labels.join("|") === ["Name", "Email", "Resume", "Location", "LinkedIn", "Cover Letter", AUTHORIZATION, SPONSORSHIP, ON_SITE].join("|"), `Ashby labels: ${labels.join("|")}`);
      check(!labels.some((label) => UNLABELED_CONTROL_LABEL.test(label) || /start typing|recaptcha/i.test(label)), `Ashby: an unlabeled, placeholder, or token field: ${labels.join("|")}`);
      const ashbyField = (label: string) => ashbyForm.fields.find((field) => field.label === label);
      const location = ashbyField("Location");
      check(location?.widget === "autocomplete" && location.required && !/^input-\d+$/.test(location.id), `Ashby location: ${JSON.stringify(location)}`);
      // A second recognition of the same tab names the same element.
      const again = await recognizeCurrentForm(ashby);
      check(again.fields.find((field) => field.label === "Location")?.id === location?.id, `Ashby location id changed: ${location?.id} then ${again.fields.find((field) => field.label === "Location")?.id}`);
      const authorizationField = ashbyField(AUTHORIZATION);
      const sponsorshipField = ashbyField(SPONSORSHIP);
      const onSite = ashbyField(ON_SITE);
      check(authorizationField?.kind === "radio" && authorizationField.options?.join("|") === "Yes|No" && !authorizationField.required, `Ashby authorization: ${JSON.stringify(authorizationField)}`);
      check(sponsorshipField?.kind === "radio" && sponsorshipField.options?.join("|") === "Yes|No" && sponsorshipField.required, `Ashby sponsorship: ${JSON.stringify(sponsorshipField)}`);
      check(onSite?.kind === "radio" && onSite.required && onSite.options?.join("|") === "Yes|Yes, but I would need to relocate|No", `Ashby on-site radio: ${JSON.stringify(onSite)}`);
      const ashbyResolutions = new Map<string, FieldResolution>();
      if (authorizationField) ashbyResolutions.set(authorizationField.id, { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true });
      if (sponsorshipField) ashbyResolutions.set(sponsorshipField.id, { status: "RESOLVED", key: "requires_sponsorship", scope: "country:US", display: "No", value: false });
      const ashbyPlan = planAutofill(ashbyForm, { profile: PROFILE, resolutions: ashbyResolutions, packageAnswers: [], variantId: VARIANT_ID });
      const actionsOf = (plan: typeof ashbyPlan) => Object.fromEntries(plan.decisions.map((decision) => [ashbyForm.fields.find((field) => field.id === decision.fieldId)?.label ?? decision.fieldId, [decision.action, decision.value]]));
      check(JSON.stringify(actionsOf(ashbyPlan)) === JSON.stringify({
        Name: ["fill", "Jordan Rivera"], Email: ["fill", "jordan@example.test"], Resume: ["upload", null], Location: ["choose", "Berkeley, CA"],
        LinkedIn: ["fill", "https://www.linkedin.com/in/jordan-fixture"], "Cover Letter": ["skip", null],
        [AUTHORIZATION]: ["choose", "Yes"], [SPONSORSHIP]: ["choose", "No"], [ON_SITE]: ["pause", null]
      }), `Ashby plan: ${JSON.stringify(actionsOf(ashbyPlan))}`);
      check(ashbyPlan.pauses.length === 1 && ashbyPlan.pauses[0]!.label === ON_SITE, `Ashby pauses: ${JSON.stringify(ashbyPlan.pauses.map((pause) => pause.label))}`);
      const ashbyResult = await applyDecisions(ashby, ashbyForm, ashbyPlan.decisions, (decision) => (decision.action === "upload" ? resumePdf : null));
      check(ashbyResult.unfilled.length === 0, `Ashby unfilled: ${JSON.stringify(ashbyResult.unfilled)}`);
      type AshbyState = { uploads: Record<string, string | null>; location: string | null; yesno: Record<string, string>; radio: string | null };
      const ashbyState = await ashbyTab.evaluate(() => (window as unknown as { fixture: AshbyState }).fixture);
      check(ashbyState.uploads._systemfield_resume === "resume.pdf" && Object.keys(ashbyState.uploads).length === 1, `Ashby uploads: ${JSON.stringify(ashbyState.uploads)}`);
      check(ashbyState.location === "Berkeley, California, United States", `Ashby location picked: ${ashbyState.location}`);
      check(ashbyState.yesno[authorizationField?.id ?? ""] === "yes" && ashbyState.yesno[sponsorshipField?.id ?? ""] === "no" && Object.keys(ashbyState.yesno).length === 2,
        `Ashby Yes/No: ${JSON.stringify(ashbyState.yesno)}`);
      check(ashbyState.radio === null, `Ashby on-site radio was answered: ${ashbyState.radio}`);
      check(await ashbyTab.inputValue("#_systemfield_name") === "Jordan Rivera", "Ashby Name was not filled");
      check(await ashby.visibleChallenge!() === null, "Ashby's invisible badge was read as a challenge");
      // Without saved answers: the optional authorization stays empty, the required ones pause.
      const unresolved = planAutofill(ashbyForm, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
      const unresolvedActions = actionsOf(unresolved);
      check(JSON.stringify(unresolvedActions[AUTHORIZATION]) === JSON.stringify(["skip", null]) && JSON.stringify(unresolvedActions[SPONSORSHIP]) === JSON.stringify(["pause", null])
        && JSON.stringify(unresolvedActions[ON_SITE]) === JSON.stringify(["pause", null]), `Ashby without saved answers: ${JSON.stringify(unresolvedActions)}`);
      // A value no suggestion matches is reported unfilled (the run pauses), never thrown, and the typed text is cleared.
      const nowhere = await applyDecisions(ashby, ashbyForm, [{ fieldId: location?.id ?? "missing-location", action: "choose", value: "Atlantis", basis: null, reason: "fixture", pause: null }]);
      check(nowhere.unfilled.length === 1 && nowhere.unfilled[0]!.reason === 'no suggestion matched "Atlantis"', `Ashby no-match: ${JSON.stringify(nowhere.unfilled)}`);
      check(await ashbyTab.inputValue(".ashby-application-form-input-autocomplete") === "", "Ashby: the unmatched typed text was left in the box");
      await ashbyTab.close();
    }

    // Ashby's text-message consent (fixtures/ashby-texting-consent.html): the radios inside the phone field's entry take the
    // consent text as their question (never their name or the phone's title, and not required by the phone's `_required`),
    // the candidate's text rule answers Yes and the radio is checked; a fieldset checkbox group with no legend takes its title.
    {
      const textingTab = await open(ASHBY_TEXTING);
      const texting = createPlaywrightPage(textingTab);
      const textingForm = await recognizeCurrentForm(texting);
      const CONSENT = "Check Yes or No to indicate your agreement to receive text message updates from Fixture Robotics Inc. regarding your job application. Frequency may vary. Message and data rates may apply. Reply STOP to opt out of future messaging.";
      const YES = "Yes - I consent to receiving text messages";
      const NO = "No - I do not consent to receiving text messages";
      const TOOLS = "Which of these tools have you used?";
      const textingLabels = textingForm.fields.map((field) => field.label);
      check(textingLabels.join("|") === ["Name", "Email", "Phone Number", CONSENT, TOOLS].join("|"), `Ashby texting labels: ${textingLabels.join("|")}`);
      const consent = textingForm.fields.find((field) => field.id === "communicationConsent");
      check(consent?.kind === "radio" && consent.label === CONSENT && consent.options?.join("|") === `${YES}|${NO}` && !consent.required, `Ashby texting consent: ${JSON.stringify(consent)}`);
      const tools = textingForm.fields.find((field) => field.label === TOOLS);
      check(tools?.kind === "checkbox" && tools.options?.join("|") === "ROS|Git|Docker", `Ashby checkbox group: ${JSON.stringify(tools)}`);
      const textingPlan = planAutofill(textingForm, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
      const consentDecision = textingPlan.decisions.find((decision) => decision.fieldId === "communicationConsent");
      check(consentDecision?.action === "choose" && consentDecision.value === YES && consentDecision.basis === null, `Ashby texting consent decision: ${JSON.stringify(consentDecision)}`);
      check(!textingPlan.pauses.some((pause) => pause.fieldId === "communicationConsent"), `Ashby texting consent paused: ${JSON.stringify(textingPlan.pauses.map((pause) => pause.label))}`);
      const textingResult = await applyDecisions(texting, textingForm, textingPlan.decisions.filter((decision) => decision.fieldId === "communicationConsent"));
      check(textingResult.unfilled.length === 0, `Ashby texting consent unfilled: ${JSON.stringify(textingResult.unfilled)}`);
      const textingState = await textingTab.evaluate(() => (window as unknown as { fixture: { consent: string | null } }).fixture);
      check(textingState.consent === "given", `Ashby texting consent chosen: ${textingState.consent}`);
      await textingTab.close();
    }

    // Ashby's success container after the click is a confirmation, with its default or a custom message; nothing shown fails closed.
    for (const [query, text] of [["submitted=custom", "We got it"], ["submitted=default", "successfully submitted"]] as const) {
      const submittedTab = await open(`${ASHBY}?${query}`);
      const outcome = await submitAndConfirm(createPlaywrightPage(submittedTab), { timeoutMs: 3_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
      check(outcome.includes(text), `Ashby ?${query}: ${outcome.slice(0, 200)}`);
      await submittedTab.close();
    }
    {
      const silentTab = await open(ASHBY);
      const outcome = await submitAndConfirm(createPlaywrightPage(silentTab), { timeoutMs: 1_500, pollMs: 100 }).then(() => null, (error: unknown) => error);
      check(outcome instanceof Error && /no (?:new )?confirmation/.test(outcome.message) && outcome.message.includes("not marked submitted"),
        `Ashby with no success state: ${outcome instanceof Error ? outcome.message : "submitted"}`);
      check(outcome instanceof SubmissionUnconfirmed && outcome.evidence.outcome === "unknown" && outcome.evidence.url === ASHBY,
        `Ashby with no success state, evidence: ${outcome instanceof SubmissionUnconfirmed ? JSON.stringify({ outcome: outcome.evidence.outcome, url: outcome.evidence.url }) : "none"}`);
      await silentTab.close();
    }

    // Ashby saves each answer as it is set and answers a submit click during a save with "We're updating your
    // application", sending nothing (all five real Ashby submits, 2026-11-20 to 2026-11-25; behaviour from Ashby's public
    // bundle). The agent lets the saves settle, clicks again once the notice is gone, and exactly one submission arrives;
    // a save that never ends fails closed after one click; the spam check is held as challenged and an error refused,
    // neither clicked again.
    {
      type AshbySubmits = { busyClicks: number; submitClicks: number; submitted: boolean };
      const submits = (tab: Page) => tab.evaluate(() => (window as unknown as { fixture: AshbySubmits }).fixture);
      const fillThenSubmit = async (query: string, timeoutMs: number) => {
        const tab = await open(`${ASHBY}?${query}`);
        const page = createPlaywrightPage(tab);
        const form = await recognizeCurrentForm(page);
        const id = (label: string) => form.fields.find((field) => field.label === label)?.id ?? `missing-${label}`;
        const filled = await applyDecisions(page, form, [
          { fieldId: id("Name"), action: "fill", value: PROFILE.fullName, basis: null, reason: "fixture", pause: null },
          { fieldId: id("Resume"), action: "upload", value: null, basis: null, reason: "fixture", pause: null }
        ], (decision) => (decision.action === "upload" ? resumePdf : null));
        check(filled.unfilled.length === 0, `Ashby ?${query} unfilled: ${JSON.stringify(filled.unfilled)}`);
        const outcome = await submitAndConfirm(page, { timeoutMs, pollMs: 100, atsKind: "ashby" }).then((text) => text, (error: unknown) => error);
        return { tab, outcome, sent: await submits(tab) };
      };
      const race = await fillThenSubmit("submitted=default&saving=3000", 8_000);
      check(typeof race.outcome === "string" && race.outcome.includes("successfully submitted"), `Ashby submit during a save: ${race.outcome instanceof Error ? race.outcome.message : String(race.outcome)}`);
      check(race.sent.submitted && race.sent.submitClicks === 1 && race.sent.busyClicks <= 2, `Ashby submit during a save, fixture: ${JSON.stringify(race.sent)}`);
      await race.tab.close();
      const stuck = await fillThenSubmit("submitted=default&saving=forever", 2_500);
      check(stuck.outcome instanceof SubmissionUnconfirmed && /still saving/.test(stuck.outcome.message) && stuck.outcome.message.includes("not marked submitted")
        && /We're updating your application/.test(stuck.outcome.evidence.detail ?? ""), `Ashby save that never ends: ${stuck.outcome instanceof Error ? stuck.outcome.message : String(stuck.outcome)}`);
      check(stuck.sent.busyClicks === 1 && stuck.sent.submitClicks === 0, `Ashby save that never ends, fixture: ${JSON.stringify(stuck.sent)}`);
      await stuck.tab.close();
      for (const [failure, Expected, outcomeKind] of [["spam", SubmissionChallenged, "challenged"], ["error", SubmissionRefused, "refused"]] as const) {
        const tab = await open(`${ASHBY}?failure=${failure}`);
        const outcome = await submitAndConfirm(createPlaywrightPage(tab), { timeoutMs: 3_000, pollMs: 100, atsKind: "ashby" }).then(() => null, (error: unknown) => error);
        check(outcome instanceof Expected && postSubmitEvidenceOf(outcome)?.outcome === outcomeKind, `Ashby ?failure=${failure}: ${outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : "submitted"}`);
        if (failure === "spam") check(postSubmitEvidenceOf(outcome)?.challenge === "Ashby's spam check (reCAPTCHA Enterprise)", `Ashby ?failure=spam challenge: ${postSubmitEvidenceOf(outcome)?.challenge}`);
        const sent = await submits(tab);
        check(sent.submitClicks === 1 && !sent.submitted, `Ashby ?failure=${failure} clicked again: ${JSON.stringify(sent)}`);
        await tab.close();
      }
    }

    // Ashby's single- and multi-choice questions (fixtures/ashby-value-select.html, derived from Ashby's public bundle and
    // checked against the First Resonance evidence): drawn without the field-entry wrapper, they take their required mark
    // from the radio or checkbox group's `_required` title, and the short "Visa Support" title takes the question from
    // its description. Then Ashby's submit on the network (Track 22): the server's answer is recorded (names, statuses,
    // booleans, codes and messages; never a body) and judged: FormSubmitSuccess confirms, the reCAPTCHA rejection is held
    // as challenged, FormRender field errors pause the named field, and a hang or a 5xx fails closed.
    {
      const VISA = "Visa Support: Do you require any visa support to work in the U.S.?";
      const TEAM = "Preferred team";
      const TOOLS = "Which of these tools have you used?";
      const recognizeValueSelect = async (query: string) => {
        const tab = await open(`${ASHBY_VALUE_SELECT}${query}`);
        const page = createPlaywrightPage(tab);
        return { tab, page, form: await recognizeCurrentForm(page) };
      };
      {
        const { tab, form } = await recognizeValueSelect("");
        const labels = form.fields.map((field) => field.label);
        check(labels.join("|") === ["Name", "Email", VISA, TEAM, TOOLS].join("|"), `Ashby value-select labels: ${labels.join("|")}`);
        const visa = form.fields.find((field) => field.label === VISA);
        check(visa?.kind === "radio" && visa.required && visa.options?.join("|") === "Yes|No" && visa.id === ASHBY_VISA_PATH, `Ashby Visa Support: ${JSON.stringify(visa)}`);
        const team = form.fields.find((field) => field.label === TEAM);
        check(team?.kind === "radio" && !team.required, `Ashby optional single choice: ${JSON.stringify(team)}`);
        const tools = form.fields.find((field) => field.label === TOOLS);
        check(tools?.kind === "checkbox" && tools.required && tools.options?.join("|") === "ROS|Git|Docker", `Ashby required multi choice: ${JSON.stringify(tools)}`);
        await tab.close();
      }
      const leaked = (network: AshbySubmitNetwork | null | undefined): string[] => {
        const text = JSON.stringify(network ?? null);
        return [PROFILE.fullName, PROFILE.email, "fixture-token", "UNIVERSAL_ENT", "fixture-fingerprint"].filter((secret) => text.includes(secret));
      };
      for (const scenario of ["accepted", "recaptcha", "form-errors", "hang", "server-error"] as const) {
        const { tab, page, form } = await recognizeValueSelect(`?network=${scenario}`);
        const id = (label: string) => form.fields.find((field) => field.label === label)?.id ?? `missing-${label}`;
        const decisions: FillDecision[] = [
          { fieldId: id("Name"), action: "fill", value: PROFILE.fullName, basis: null, reason: "fixture", pause: null },
          { fieldId: id("Email"), action: "fill", value: PROFILE.email, basis: null, reason: "fixture", pause: null },
          { fieldId: id(VISA), action: "choose", value: "No", basis: null, reason: "fixture", pause: null }
        ];
        const filled = await applyDecisions(page, form, decisions);
        check(filled.unfilled.length === 0, `Ashby ?network=${scenario} unfilled: ${JSON.stringify(filled.unfilled)}`);
        check((await choicesNotTaken(page, form, decisions)).length === 0, `Ashby ?network=${scenario}: the Visa Support choice did not read back`);
        const outcome = await submitAndConfirm(page, { timeoutMs: scenario === "hang" ? 2_000 : 3_000, pollMs: 100, atsKind: "ashby" })
          .then((text) => text, (error: unknown) => error);
        const evidence = postSubmitEvidenceOf(outcome);
        const sent = await tab.evaluate(() => (window as unknown as { fixture: { submitClicks: number; radios: Record<string, string>; render: string } }).fixture);
        check(sent.radios[ASHBY_VISA_PATH] === "No", `Ashby ?network=${scenario} Visa Support chosen: ${JSON.stringify(sent.radios)}`);
        const described = outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : String(outcome);
        if (scenario === "accepted") {
          check(outcome === ASHBY_ACCEPTED_CONFIRMATION, `Ashby ?network=accepted: ${described}`);
          const network = await page.ashbySubmitNetwork!();
          const submit = network?.submits[0];
          check(network?.submits.length === 1 && submit?.operation === "ApiSubmitSingleApplicationFormAction" && submit.clicks === 1 && submit.status === 200
            && submit.success && submit.recaptchaToken === "present", `Ashby ?network=accepted submit: ${JSON.stringify(network?.submits)}`);
          check(network?.recaptchaTokenRequests === 1 && JSON.stringify(network.recaptchaTokenStatuses) === "[200]", `Ashby ?network=accepted token requests: ${JSON.stringify(network)}`);
          check(leaked(network).length === 0, `Ashby ?network=accepted record kept: ${leaked(network).join(", ")}`);
        } else if (scenario === "recaptcha") {
          check(outcome instanceof SubmissionChallenged && evidence?.challenge === ASHBY_SPAM_CHECK_DETAIL, `Ashby ?network=recaptcha: ${described}`);
          check(JSON.stringify(evidence?.ashbyNetwork?.submits[0]?.errorCodes) === JSON.stringify(["RECAPTCHA_SCORE_BELOW_THRESHOLD"]), `Ashby ?network=recaptcha codes: ${JSON.stringify(evidence?.ashbyNetwork)}`);
          check(sent.submitClicks === 1, `Ashby ?network=recaptcha clicked again: ${sent.submitClicks}`);
        } else if (scenario === "form-errors") {
          check(outcome instanceof SubmissionNeedsInput, `Ashby ?network=form-errors: ${described}`);
          const invalid = outcome instanceof SubmissionNeedsInput ? outcome.invalidFields : [];
          check(invalid[0]?.ref === id(VISA) && invalid[0]?.error === "Missing entry for required field: Visa Support", `Ashby ?network=form-errors fields: ${JSON.stringify(invalid)}`);
          const paused = invalidFieldPauses(form, [], [], invalid);
          check(paused.pauses.length === 1 && paused.pauses[0]!.fieldId === id(VISA) && !paused.pauses[0]!.safeguard, `Ashby ?network=form-errors pauses: ${JSON.stringify(paused.pauses)}`);
        } else if (scenario === "hang") {
          check(outcome instanceof SubmissionUnconfirmed, `Ashby ?network=hang: ${described}`);
          check(JSON.stringify(evidence?.ashbyNetwork?.submits) === "[]" && evidence?.ashbyNetwork?.recaptchaTokenRequests === 1, `Ashby ?network=hang record: ${JSON.stringify(evidence?.ashbyNetwork)}`);
        } else {
          check(outcome instanceof SubmissionUnconfirmed, `Ashby ?network=server-error: ${described}`);
          check(evidence?.ashbyNetwork?.submits[0]?.status === 500 && evidence.ashbyNetwork.submits[0].success === false, `Ashby ?network=server-error record: ${JSON.stringify(evidence?.ashbyNetwork)}`);
        }
        if (scenario !== "accepted") check(leaked(evidence?.ashbyNetwork).length === 0, `Ashby ?network=${scenario} record kept: ${leaked(evidence?.ashbyNetwork).join(", ")}`);
        await tab.close();
      }
      // Track 25: Ashby gives the form a new render id on every load and names a single-choice question's radios by it.
      // The run plans on one load and submits on another: the choice is still made, read back, and submitted.
      {
        const first = await recognizeValueSelect("");
        const firstRender = await first.tab.evaluate(() => (window as unknown as { fixture: { render: string } }).fixture.render);
        const fid = (label: string) => first.form.fields.find((field) => field.label === label)?.id ?? `missing-${label}`;
        const decisions: FillDecision[] = [
          { fieldId: fid("Name"), action: "fill", value: PROFILE.fullName, basis: null, reason: "fixture", pause: null },
          { fieldId: fid("Email"), action: "fill", value: PROFILE.email, basis: null, reason: "fixture", pause: null },
          { fieldId: fid(VISA), action: "choose", value: "No", basis: null, reason: "fixture", pause: null }
        ];
        await first.tab.close();
        const { tab, page, form } = await recognizeValueSelect("?network=accepted");
        const fixtureState = () => tab.evaluate(() => (window as unknown as { fixture: { submitClicks: number; radios: Record<string, string>; render: string } }).fixture);
        check((await fixtureState()).render !== firstRender, "Ashby per-load: the fixture kept its render id");
        check(form.fields.find((field) => field.label === VISA)?.id === fid(VISA) && fid(VISA) === ASHBY_VISA_PATH, `Ashby per-load: Visa Support's id changed between loads: ${fid(VISA)} → ${form.fields.find((field) => field.label === VISA)?.id}`);
        const filled = await applyDecisions(page, form, decisions);
        check(filled.unfilled.length === 0 && filled.skipped === 0 && filled.applied === 3, `Ashby per-load fills: ${JSON.stringify(filled)}`);
        check((await choicesNotTaken(page, form, decisions)).length === 0, "Ashby per-load: the Visa Support choice did not read back");
        const outcome = await submitAndConfirm(page, { timeoutMs: 3_000, pollMs: 100, atsKind: "ashby" }).then((text) => text, (error: unknown) => error);
        check(outcome === ASHBY_ACCEPTED_CONFIRMATION, `Ashby per-load submit: ${outcome instanceof Error ? outcome.message : String(outcome)}`);
        const sent = await fixtureState();
        check(sent.radios[ASHBY_VISA_PATH] === "No" && sent.submitClicks === 1, `Ashby per-load sent: ${JSON.stringify(sent)}`);
        await tab.close();
      }
      // A required radio that will not take: the choice is reported unfilled, and a DOM-only `checked` (the old
      // fallback's) still reads back as not taken, since the read-back reads Ashby's own state. Nothing is clicked.
      {
        const { tab, page, form } = await recognizeValueSelect("?network=accepted&stuck=1");
        const id = (label: string) => form.fields.find((field) => field.label === label)?.id ?? `missing-${label}`;
        const decisions: FillDecision[] = [{ fieldId: id(VISA), action: "choose", value: "No", basis: null, reason: "fixture", pause: null }];
        const filled = await applyDecisions(page, form, decisions);
        check(filled.unfilled.length === 1 && filled.unfilled[0]?.fieldId === id(VISA) && filled.unfilled[0]?.reason === "the site did not keep the choice", `Ashby stuck radio fill: ${JSON.stringify(filled.unfilled)}`);
        await tab.evaluate((path) => {
          const radios = Array.from(document.querySelectorAll(`[data-field-path="${path}"] input[type="radio"]`)) as HTMLInputElement[];
          const no = radios.find((radio) => document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent === "No");
          if (no) no.checked = true;
        }, ASHBY_VISA_PATH);
        const notTaken = await choicesNotTaken(page, form, decisions);
        check(notTaken.length === 1 && notTaken[0]?.fieldId === id(VISA) && notTaken[0]?.reason === "the page did not take the choice", `Ashby stuck radio read-back: ${JSON.stringify(notTaken)}`);
        const sent = await tab.evaluate(() => (window as unknown as { fixture: { submitClicks: number; radios: Record<string, string> } }).fixture);
        check(sent.submitClicks === 0 && sent.radios[ASHBY_VISA_PATH] === undefined, `Ashby stuck radio state: ${JSON.stringify(sent)}`);
        await tab.close();
      }
    }

    // Dover (jobs.dover.com, where app.dover.io links redirect): labels come from the sibling FormLabel div, never the
    // U+200B legend, an option's "Yes", or a UUID name; the autofill drop zone and the Turnstile token are not questions;
    // the contact fields and the resume fill from the profile; the Apply submit shows "Thanks for applying!".
    {
      const doverTab = await open(DOVER);
      const dover = createPlaywrightPage(doverTab);
      check(await dover.visibleChallenge!() === null, "Dover: the hidden Turnstile token was read as a challenge");
      const doverForm = await recognizeCurrentForm(dover);
      const labels = doverForm.fields.map((field) => field.label);
      const RELOCATION = "Are you open to relocation?";
      const VISA = "What is your Visa Status?";
      const WHY = "Why do you want to join Fixture Robotics?";
      check(labels.join("|") === ["First Name", "Last Name", "Email", "Resume", "LinkedIn Profile URL", "Phone Number", RELOCATION, VISA, WHY].join("|"), `Dover labels: ${labels.join("|")}`);
      const required = doverForm.fields.filter((field) => field.required).map((field) => field.label);
      check(required.join("|") === ["First Name", "Last Name", "Email", "Resume", RELOCATION, VISA].join("|"), `Dover required: ${required.join("|")}`);
      const invisible = new RegExp(INVISIBLE_CHARACTERS.source);
      const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      check(!labels.some((label) => invisible.test(label) || uuid.test(label) || UNLABELED_CONTROL_LABEL.test(label)), `Dover: an invisible, UUID, or unlabeled label: ${JSON.stringify(labels)}`);
      check(doverForm.fields.filter((field) => field.kind === "file").length === 1, `Dover: the autofill drop zone was read as a question: ${labels.join("|")}`);
      check(!doverForm.fields.some((field) => /turnstile/i.test(field.id) || /turnstile/i.test(field.label)), "Dover: the Turnstile token was read as a question");
      const relocation = doverForm.fields.find((field) => field.label === RELOCATION);
      check(relocation?.kind === "radio" && relocation.options?.join("|") === "Yes|No", `Dover relocation: ${JSON.stringify(relocation)}`);
      const doverKind = classifyAts(doverForm.url, doverForm.title, await dover.bodyText());
      check(doverKind.kind === "dover" && atsFlowFor(doverKind) === "auto", `Dover kind: ${doverKind.kind} (${atsFlowFor(doverKind)})`);
      const doverProfile = { ...PROFILE, legalFirstName: "Jordan", legalLastName: "Rivera" };
      const doverPlan = planAutofill(doverForm, { profile: doverProfile, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
      const doverActions = Object.fromEntries(doverPlan.decisions.map((decision) => [doverForm.fields.find((field) => field.id === decision.fieldId)?.label ?? decision.fieldId, [decision.action, decision.value]]));
      const expectedDover: Record<string, [string, string | null]> = {
        "First Name": ["fill", "Jordan"], "Last Name": ["fill", "Rivera"], Email: ["fill", PROFILE.email], Resume: ["upload", null],
        "LinkedIn Profile URL": ["fill", PROFILE.linkedinUrl], "Phone Number": ["fill", PROFILE.phone]
      };
      for (const [label, action] of Object.entries(expectedDover)) {
        check(JSON.stringify(doverActions[label]) === JSON.stringify(action), `Dover ${label}: ${JSON.stringify(doverActions[label])}`);
      }
      check(doverActions[RELOCATION]?.[0] !== "choose" && doverActions[VISA]?.[0] !== "fill", `Dover: an answer was invented: ${JSON.stringify(doverActions)}`);
      const doverResult = await applyDecisions(dover, doverForm, doverPlan.decisions, (decision) => (decision.action === "upload" ? resumePdf : null));
      check(doverResult.unfilled.length === 0, `Dover unfilled: ${JSON.stringify(doverResult.unfilled)}`);
      type DoverState = { uploads: Record<string, string | null>; submitted: boolean };
      const doverState = await doverTab.evaluate(() => (window as unknown as { fixture: DoverState }).fixture);
      check(JSON.stringify(doverState.uploads) === JSON.stringify({ resume: "resume.pdf" }), `Dover uploads: ${JSON.stringify(doverState.uploads)}`);
      check(await doverTab.inputValue('[name="firstName"]') === "Jordan" && await doverTab.inputValue('[name="phoneNumber"]') === PROFILE.phone, "Dover contact fields were not filled");
      const doverConfirmation = await submitAndConfirm(dover, { timeoutMs: 5_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
      check(doverConfirmation.includes("Thanks for applying"), `Dover confirmation: ${doverConfirmation.slice(0, 200)}`);
      await doverTab.close();
    }

    // Dover's Turnstile (2026-11-24 real runs): its frame sits in a closed shadow root the page's own DOM read never
    // reaches. Shown it is a challenge, hidden (invisible mode) it is not; drawn by the Apply click it holds the
    // submit as challenged with evidence, and the fixture records no submission.
    {
      for (const [variant, expected] of [["shown", "turnstile"], ["hidden", null]] as const) {
        const turnstileTab = await open(`${DOVER}?turnstile=${variant}`);
        const challenge = await createPlaywrightPage(turnstileTab).visibleChallenge!();
        check((challenge?.kind ?? null) === expected, `Dover ?turnstile=${variant}: ${JSON.stringify(challenge)}`);
        await turnstileTab.close();
      }
      const afterTab = await open(`${DOVER}?turnstile=after-submit`);
      const afterPage = createPlaywrightPage(afterTab);
      check(await afterPage.visibleChallenge!() === null, "Dover ?turnstile=after-submit: a challenge before the click");
      const outcome = await submitAndConfirm(afterPage, { timeoutMs: 1_500, pollMs: 100, atsKind: "dover" }).then(() => null, (error: unknown) => error);
      check(outcome instanceof SubmissionChallenged && String((outcome as Error).message).includes("never solves CAPTCHAs"),
        `Dover ?turnstile=after-submit: ${outcome instanceof Error ? `${outcome.constructor.name}: ${outcome.message}` : "submitted"}`);
      const evidence = postSubmitEvidenceOf(outcome);
      check(evidence?.outcome === "challenged" && evidence.challenge === "a Cloudflare Turnstile challenge" && evidence.url === DOVER,
        `Dover ?turnstile=after-submit evidence: ${JSON.stringify(evidence && { outcome: evidence.outcome, challenge: evidence.challenge, url: evidence.url })}`);
      const sent = await afterTab.evaluate(() => (window as unknown as { fixture: { submitted: boolean } }).fixture.submitted);
      check(sent === false, "Dover ?turnstile=after-submit: the fixture recorded a submission");
      await afterTab.close();
    }

    // Lever's /thanks page confirms by its URL, whatever message the company set.
    {
      const thanksTab = await open(`${LEVER}?confirm=thanks`);
      const thanks = await submitAndConfirm(createPlaywrightPage(thanksTab), { timeoutMs: 5_000, pollMs: 100 }).catch((error: unknown) => `ERROR ${String(error)}`);
      check(thanks.includes("Thanks for your application") && thanksTab.url() === LEVER.replace(/\/apply$/, "/thanks"), `Lever ?confirm=thanks: ${thanks.slice(0, 200)} at ${thanksTab.url()}`);
      await thanksTab.close();
    }

    // Oracle Cloud HCM's email step: buttons and their label spans never become fields.
    {
      const oracleTab = await open(`${ORACLE}/apply/email`);
      const oracleForm = await recognizeCurrentForm(createPlaywrightPage(oracleTab));
      const labels = oracleForm.fields.map((field) => field.label);
      check(!labels.some((label) => /^(?:discard|back|next|cancel|submit)$/i.test(label)), `Oracle: a button became a field: ${labels.join("|")}`);
      check(oracleForm.fields.some((field) => field.label === "Email Address"), `Oracle: no Email Address field: ${labels.join("|")}`);
      await oracleTab.close();
    }

    // Lever: clean labels, radio questions as one field, the consent checkbox paused, the location typed and picked.
    {
      const leverTab = await open(LEVER);
      const lever = createPlaywrightPage(leverTab);
      const leverForm = await recognizeCurrentForm(lever);
      const labels = leverForm.fields.map((field) => field.label);
      check(!labels.some((label) => /[✱*]|No location found|Loading|Analyzing|ATTACH/i.test(label)), `Lever labels keep markers or status text: ${labels.join("|")}`);
      const field = (label: string) => leverForm.fields.find((entry) => entry.label === label);
      check(field("Resume/CV")?.kind === "file" && field("Resume/CV")?.required === true, `Lever resume: ${JSON.stringify(field("Resume/CV"))}`);
      check(field("Full name")?.required === true && field("Phone")?.required === true, "Lever required markers were not read");
      check(field("Current location")?.widget === "autocomplete", `Lever location: ${JSON.stringify(field("Current location"))}`);
      const nationality = field("What is your nationality status for this role?");
      check(nationality?.kind === "radio" && nationality.options?.length === 3 && nationality.required
        && nationality.options[2] === "Non Applicable I am a national of a Member State of the European Union", `Lever radio question: ${JSON.stringify(nationality)}`);
      check(!labels.some((label) => /^(?:Yes|No|I hold a valid work permit|I need a work permit)$/.test(label)), `Lever radio options read as questions: ${labels.join("|")}`);
      check(!leverForm.fields.some((entry) => /h-captcha/i.test(entry.id) || /h-captcha/i.test(entry.label)), "Lever's h-captcha-response field was read as a question");
      const authorized = field("Are you legally authorized to work in the United States?");
      const consent = leverForm.fields.find((entry) => entry.kind === "checkbox");
      const leverResolutions = new Map<string, FieldResolution>();
      if (authorized) leverResolutions.set(authorized.id, { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true });
      if (nationality) leverResolutions.set(nationality.id, { status: "RESOLVED", key: "custom", scope: "global", display: "EU citizen", value: "EU citizen" });
      if (consent) leverResolutions.set(consent.id, { status: "RESOLVED", key: "custom", scope: "global", display: "Yes", value: true });
      const leverPlan = planAutofill(leverForm, { profile: PROFILE, resolutions: leverResolutions, packageAnswers: [], variantId: VARIANT_ID });
      const decision = (entry: { id: string } | undefined) => leverPlan.decisions.find((candidate) => candidate.fieldId === entry?.id);
      check(decision(field("Full name"))?.value === "Jordan Rivera" && decision(field("Phone"))?.value === PROFILE.phone
        && decision(field("Email"))?.value === PROFILE.email && decision(field("LinkedIn URL"))?.value === PROFILE.linkedinUrl, "Lever contact fields are not mapped");
      check(decision(nationality)?.action === "pause", `Lever: an unmatched radio answer was not paused: ${JSON.stringify(decision(nationality))}`);
      check(decision(authorized)?.action === "choose" && decision(authorized)?.value === "Yes", `Lever authorization: ${JSON.stringify(decision(authorized))}`);
      check(decision(consent)?.action === "pause" && leverPlan.pauses.some((pause) => pause.fieldId === consent?.id && pause.question === "consent checkbox: needs your OK"),
        `Lever consent: ${JSON.stringify(decision(consent))}`);
      check(decision(field("Current location"))?.action === "choose" && decision(field("Current location"))?.value === "Berkeley, CA", "Lever location is not typed");
      const leverResult = await applyDecisions(lever, leverForm, leverPlan.decisions, (entry) => (entry.action === "upload" ? resumePdf : null));
      check(leverResult.unfilled.length === 0, `Lever unfilled: ${JSON.stringify(leverResult.unfilled)}`);
      type LeverState = { uploads: Record<string, string | null>; location: string | null; radios: Record<string, string>; consent: boolean };
      const leverState = await leverTab.evaluate(() => (window as unknown as { fixture: LeverState }).fixture);
      check(leverState.location === "Berkeley, California, United States", `Lever location picked: ${leverState.location}`);
      check(JSON.stringify(leverState.radios) === JSON.stringify({ "cards[0b1c2d3e-0000-4000-8000-000000000001][field1]": "Yes" }), `Lever radios: ${JSON.stringify(leverState.radios)}`);
      check(leverState.consent === false, "Lever: the consent checkbox was ticked");
      check(leverState.uploads["resume-upload-input"] === "resume.pdf", `Lever uploads: ${JSON.stringify(leverState.uploads)}`);
      check(await leverTab.inputValue('[name="name"]') === "Jordan Rivera", "Lever Full name was not filled");
      // A bare "Berkeley" matches two suggestions: never a guess, the field is left unfilled for the candidate.
      const ambiguous = await applyDecisions(lever, leverForm, [{ fieldId: field("Current location")?.id ?? "missing-location", action: "choose", value: "Berkeley", basis: null, reason: "fixture", pause: null }]);
      check(ambiguous.unfilled.length === 1 && ambiguous.unfilled[0]!.reason === 'no suggestion matched "Berkeley"', `Lever ambiguous: ${JSON.stringify(ambiguous.unfilled)}`);
      // A radio is never typed into.
      const typed = await applyDecisions(lever, leverForm, [{ fieldId: nationality?.id ?? "missing-radio", action: "fill", value: "EU citizen", basis: null, reason: "fixture", pause: null }]);
      check(typed.unfilled.length === 1, `Lever: a fill into a radio question was not refused: ${JSON.stringify(typed.unfilled)}`);
      await leverTab.close();
    }

    // Site kinds: Oracle Cloud HCM and SmartRecruiters are recognized for display and wait for the candidate.
    for (const [url, kind, flow] of [[GREENHOUSE, "greenhouse", "auto"], [ORACLE, "oracle", "confirm"], [SMARTRECRUITERS, "smartrecruiters", "confirm"], [ASHBY, "ashby", "auto"], [LEVER, "lever", "auto"]] as const) {
      const kindTab = await open(url);
      const classification = classifyAts(kindTab.url(), await kindTab.title(), await kindTab.evaluate(() => document.body.innerText));
      check(classification.kind === kind && atsFlowFor(classification) === flow, `${url}: ${classification.kind} (${atsFlowFor(classification)})`);
      await kindTab.close();
    }

    // Posting pages behind an Apply link: the site's own entry is followed once; third-party ones never.
    const thirdParty = (href: string) => /(?:^|\.)(?:linkedin\.com|indeed\.com)$/i.test(new URL(href).hostname);
    const careersTab = await open(CAREERS_POSTING);
    const careersReached = await createPlaywrightPage(careersTab).followApplyEntry!();
    check(careersReached === `${CAREERS_POSTING}/apply`, `careers posting followed to: ${careersReached}`);
    const careersForm = await recognizeCurrentForm(createPlaywrightPage(careersTab));
    check(careersForm.fields.some((field) => field.label === "Email" && field.kind === "email") && careersForm.fields.some((field) => field.label === "Resume" && field.kind === "file"),
      `careers form: ${careersForm.fields.map((field) => `${field.label}:${field.kind}`).join(", ")}`);
    await careersTab.close();
    const aggregatedTab = await open(CAREERS_AGGREGATED);
    const aggregatedReached = await createPlaywrightPage(aggregatedTab).followApplyEntry!();
    check(aggregatedReached === null && aggregatedTab.url() === CAREERS_AGGREGATED, `only third-party apply buttons, yet followed to: ${aggregatedReached} (${aggregatedTab.url()})`);
    await aggregatedTab.close();

    const icimsTab = await open(ICIMS_POSTING);
    const icimsPage = createPlaywrightPage(icimsTab);
    const icimsReached = await icimsPage.followApplyEntry!();
    check(icimsReached?.endsWith("/jobs/9001/intern/login?in_iframe=1") === true, `iCIMS Apply followed to: ${icimsReached}`);
    const icimsBody = await icimsPage.bodyText();
    check(applicationWallReason(icimsTab.url(), icimsBody)?.includes("careers-fixture.icims.com") === true, `iCIMS wall: ${applicationWallReason(icimsTab.url(), icimsBody)}`);
    const icimsForm = await recognizeCurrentForm(icimsPage);
    check(icimsForm.fields.some((field) => field.label === "Email") && !icimsForm.fields.some((field) => /^next$/i.test(field.label)),
      `iCIMS account step fields: ${icimsForm.fields.map((field) => field.label).join(", ")}`);
    const icimsKind = classifyAts(icimsTab.url(), await icimsTab.title(), icimsBody);
    check(icimsKind.kind === "icims" && atsFlowFor(icimsKind) === "confirm", `iCIMS kind: ${icimsKind.kind} (${atsFlowFor(icimsKind)})`);
    await icimsTab.close();

    const jobviteTab = await open(JOBVITE_POSTING);
    const jobvitePage = createPlaywrightPage(jobviteTab);
    const jobviteReached = await jobvitePage.followApplyEntry!();
    check(jobviteReached === `${JOBVITE_POSTING}/apply`, `Jobvite Apply followed to: ${jobviteReached}`);
    const jobviteBody = await jobvitePage.bodyText();
    check(applicationWallReason(jobviteTab.url(), jobviteBody)?.startsWith("Jobvite asks you to accept its data-consent policy at jobs.jobvite.com") === true,
      `Jobvite wall: ${applicationWallReason(jobviteTab.url(), jobviteBody)}`);
    const jobviteKind = classifyAts(jobviteTab.url(), await jobviteTab.title(), jobviteBody);
    check(jobviteKind.kind === "jobvite" && atsFlowFor(jobviteKind) === "confirm", `Jobvite kind: ${jobviteKind.kind} (${atsFlowFor(jobviteKind)})`);
    await jobviteTab.close();
    check(redirectedRequests.some((href) => href.endsWith("/jobs/9001/intern/login?in_iframe=1")), `the iCIMS redirect was not followed: ${redirectedRequests.join(", ")}`);
    const leaked = [...documentRequests, ...redirectedRequests].filter(thirdParty);
    check(leaked.length === 0, `a followed entry reached a third-party site: ${leaked.join(", ")}`);
    await context.close();
  } finally {
    await browser.close();
    server.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`GREENHOUSE_FIXTURE_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`GREENHOUSE_FIXTURE_REPORT {"status":"passed","scenarios":25}`);
}

main().catch((error) => {
  console.error(`GREENHOUSE_FIXTURE_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
