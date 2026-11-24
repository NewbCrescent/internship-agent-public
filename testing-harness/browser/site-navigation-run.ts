/**
 * Navigation on sites the agent has no adapter for, and reject-first cookie
 * consent, in real Chromium against synthetic fixtures served on their host
 * names inside one browser context (every other request is aborted and every
 * host resolves to nothing, so no network is used). Proves:
 * (i) a OneTrust-shaped banner offering "Accept All Cookies" and "Reject
 * All" is rejected, never accepted, by the shared helper both on its own
 * (dismissCookieBanner) and on the posting's Apply-entry path
 * (followApplyEntry); a banner offering only accept gets no click; the
 * preference center's toggles, vendor search, filter and "switch" boxes, the
 * read-only copy-link box, and a "Leave this field blank" honeypot are never
 * controls. (ii) a posting on an unrecognized site is walked consent →
 * Apply → "Apply as guest" to its one-page form (never "Sign in", "Create
 * account", or "Apply with LinkedIn"), whose identity fields and resume are
 * filled from a fictional profile while the honeypot is no field. (iii) the
 * first page of a several-page form reads "Next" and no submit. (iv) the
 * Paylocity reconstruction (fixtures from the 2026-11-24 read-only capture):
 * its posting has no application field, the walk closes its accept-only
 * banner (never accepting) and follows Apply to the application page, which
 * is classified paylocity (confirm flow), fills First Name, Last Name, Email
 * Address, and Mobile Number, uploads the resume to the resume input only,
 * pauses the County it has no answer for, and reads "Next Step" and no
 * submit, so the several-page stop applies; the SmartRecruiters
 * reconstruction (a WeChat share box with neither id nor name) is walked
 * through "I'm interested" to the DataDome page and stops on the challenge;
 * the Oracle Cloud HCM reconstruction gives no field on its posting (its
 * copy-link box is skipped) and is walked through Apply Now to the email step,
 * named as a wall. No followed page reaches another site.
 *
 * Usage: pnpm test:browser:site-navigation
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium, type Page } from "playwright-core";

import {
  applyDecisions,
  atsFlowFor,
  classifyAts,
  createApplicationPage,
  createPlaywrightPage,
  dismissCookieBanner,
  hasApplicationFields,
  multiStepStopReason,
  planAutofill,
  recognizeCurrentForm,
  siteWallReason
} from "@internship-agent/browser";

const PREFIX = "internship-agent-site-navigation-";
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const CONSENT_POSTING = "https://careers.fixturerobotics.example/jobs/3001";
const GUEST_POSTING = "https://careers.fixturerobotics.example/jobs/2001";
const MULTISTEP = "https://careers.fixturerobotics.example/jobs/4001/apply";
const PAYLOCITY_POSTING = "https://recruiting.paylocity.com/Recruiting/Jobs/Details/1000001";
const PAYLOCITY_APPLY = "https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1000001";
const SMARTRECRUITERS_POSTING = "https://jobs.smartrecruiters.com/FixtureRobotics/744000000000002-robotics-software-intern";
const ORACLE_POSTING = "https://fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001";
/** The fictional candidate profile the forms are filled from. */
const PROFILE = { fullName: "Jordan Rivera", legalFirstName: "Jordan", legalLastName: "Rivera", email: "jordan@example.test", phone: "+1 555 555 0100" };
/** The DataDome page the read-only capture browsers met on SmartRecruiters' application page, reduced. */
const DATADOME_PAGE = `<!doctype html><html><head><title>smartrecruiters.com</title></head><body style="margin:0">
  <iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=FIXTURE" title="DataDome CAPTCHA" width="100%" height="600" frameborder="0"></iframe></body></html>`;
const NOT_CONTROLS = /^(?:ot-|vendor-search-handler$|chkbox-id$|switch$|select-all-|copy-link-|website-confirm$|hp_field$)/;

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const byPath: Record<string, string> = {
      "careers.fixturerobotics.example/jobs/3001": fixture("consent-banner-posting.html"),
      "careers.fixturerobotics.example/jobs/3001/apply": fixture("multistep-application.html"),
      "careers.fixturerobotics.example/jobs/2001": fixture("guest-posting.html"),
      "careers.fixturerobotics.example/jobs/2001/apply": fixture("guest-choice.html"),
      "careers.fixturerobotics.example/jobs/4001/apply": fixture("multistep-application.html"),
      "recruiting.paylocity.com/Recruiting/Jobs/Details/1000001": fixture("paylocity-posting.html"),
      "recruiting.paylocity.com/Recruiting/Jobs/Apply/1000001": fixture("paylocity-application.html"),
      "jobs.smartrecruiters.com/FixtureRobotics/744000000000002-robotics-software-intern": fixture("smartrecruiters-share-posting.html"),
      "fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001": fixture("oracle-candidate-experience.html"),
      "fixture.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10001/apply/email": fixture("oracle-apply-email.html")
    };
    const documentRequests: string[] = [];
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      // Main-frame documents only: the DataDome page's own CAPTCHA frame is not a followed entry (it is aborted).
      if (url && request.resourceType() === "document" && request.frame().parentFrame() === null) documentRequests.push(url.href);
      const body = url && request.resourceType() === "document"
        ? (url.hostname === "jobs.smartrecruiters.com" && url.pathname.startsWith("/oneclick-ui/") ? DATADOME_PAGE : byPath[`${url.hostname}${url.pathname}`])
        : undefined;
      if (body) await route.fulfill({ status: 200, contentType: "text/html", body });
      else await route.abort();
    });
    const open = async (url: string): Promise<Page> => {
      const tab = await context.newPage();
      await tab.goto(url);
      return tab;
    };
    const resumePdf = join(temp, "resume.pdf");
    writeFileSync(resumePdf, "%PDF-1.7\n% fixture resume\n%%EOF\n");

    // (i) The cookie banner is rejected, never accepted; consent, copy-link, and honeypot controls are never fields.
    {
      const tab = await open(CONSENT_POSTING);
      const controls = await createPlaywrightPage(tab).collectControls();
      const leaked = controls.filter((control) => NOT_CONTROLS.test(control.id ?? control.name ?? ""));
      check(leaked.length === 0, `consent, copy-link, or honeypot controls were read: ${leaked.map((control) => control.id ?? control.name).join(", ")}`);
      check(!controls.some((control) => /cookie|leave this field blank/i.test(control.label ?? "")), `a cookie button or the honeypot was read: ${controls.map((control) => control.label).join("|")}`);
      check(await dismissCookieBanner(tab), "the banner with a Reject All button was not dismissed");
      const consent = await tab.evaluate(() => (window as unknown as { fixture: { consent: string | null } }).fixture.consent);
      check(consent === "rejected", `the banner's choice was ${consent}, not rejected`);
      await tab.close();

      const acceptOnly = await open(`${CONSENT_POSTING}?acceptOnly=1`);
      check(!(await dismissCookieBanner(acceptOnly)), "a banner offering only accept was clicked");
      const untouched = await acceptOnly.evaluate(() => (window as unknown as { fixture: { consent: string | null } }).fixture.consent);
      check(untouched === null, `the accept-only banner's choice was ${untouched}`);
      await acceptOnly.close();

      // The posting's Apply-entry path shares the reject-first helper.
      const entryTab = await open(CONSENT_POSTING);
      const reached = await createPlaywrightPage(entryTab).followApplyEntry!();
      check(reached === `${CONSENT_POSTING}/apply`, `Apply entry followed to: ${reached}`);
      const entryConsent = await entryTab.evaluate(() => sessionStorage.getItem("consent"));
      check(entryConsent === "rejected", `followApplyEntry left the banner ${entryConsent}, not rejected`);
      await entryTab.close();
    }

    // (ii) A guest-apply flow on an unrecognized site: consent → Apply → Apply as guest → the form.
    {
      const tab = await open(GUEST_POSTING);
      const page = createApplicationPage(tab);
      const outcome = await page.advanceToApplicationForm();
      check(outcome.stop === "form", `guest walk stopped at ${outcome.stop} (${outcome.url})`);
      check(JSON.stringify(outcome.hops.map((hop) => hop.kind)) === JSON.stringify(["consent", "apply", "guest"]), `guest walk hops: ${JSON.stringify(outcome.hops)}`);
      check(outcome.moved && outcome.url === `${GUEST_POSTING}/apply`, `guest walk ended at ${outcome.url}`);
      check(await tab.evaluate(() => sessionStorage.getItem("consent")) === "rejected", "the guest posting's banner was not rejected");
      const clicks = await tab.evaluate(() => (window as unknown as { fixture: { clicks: Record<string, number> } }).fixture.clicks);
      check(clicks.signIn === 0 && clicks.createAccount === 0 && clicks.guest === 1, `choice clicks: ${JSON.stringify(clicks)}`);
      const form = await recognizeCurrentForm(page);
      const labels = form.fields.map((field) => field.label);
      check(["First Name", "Last Name", "Email", "Phone", "Resume"].every((label) => labels.includes(label)), `guest form fields: ${labels.join("|")}`);
      check(!form.fields.some((field) => field.id === "hp_field" || /leave this field blank/i.test(field.label)), "the honeypot was read as a field");
      check(hasApplicationFields(form.fields), "the guest form has no application field");
      const plan = planAutofill(form, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
      const applied = await applyDecisions(page, form, plan.decisions, (decision) => (decision.action === "upload" ? resumePdf : null));
      check(applied.unfilled.length === 0, `guest form unfilled: ${JSON.stringify(applied.unfilled)}`);
      const values = await tab.evaluate(() => Object.fromEntries(["first_name", "last_name", "email", "phone", "hp_field"].map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])));
      check(values.first_name === "Jordan" && values.last_name === "Rivera" && values.email === PROFILE.email && values.phone === PROFILE.phone && values.hp_field === "",
        `guest form values: ${JSON.stringify(values)}`);
      check(await tab.evaluate(() => (document.getElementById("resume") as HTMLInputElement).files?.[0]?.name ?? null) === "resume.pdf", "the resume was not attached");
      check(!(await tab.evaluate(() => (window as unknown as { fixture: { submitted: boolean } }).fixture.submitted)), "the guest form was submitted");
      await tab.close();
    }

    // (iii) The first page of a several-page form: "Next" and no submit.
    {
      const tab = await open(MULTISTEP);
      const buttons = await createApplicationPage(tab).stepButtons();
      check(buttons.submit === false && buttons.next === "Next", `several-page buttons: ${JSON.stringify(buttons)}`);
      check(multiStepStopReason(tab.url(), buttons)?.startsWith("The application at careers.fixturerobotics.example continues over several pages") === true,
        `several-page stop: ${multiStepStopReason(tab.url(), buttons)}`);
      await tab.close();
    }

    // (iv) Paylocity: the posting's accept-only banner is closed, Apply is followed, and the five-step form stops at its first page.
    {
      const tab = await open(PAYLOCITY_POSTING);
      const page = createApplicationPage(tab);
      const posting = await recognizeCurrentForm(page);
      check(!hasApplicationFields(posting.fields) && posting.fields.length === 0, `Paylocity posting fields: ${posting.fields.map((field) => `${field.id}:${field.label}`).join("|")}`);
      const outcome = await page.advanceToApplicationForm();
      check(outcome.stop === "form" && outcome.url === PAYLOCITY_APPLY, `Paylocity walk: ${outcome.stop} at ${outcome.url}`);
      check(JSON.stringify(outcome.hops.map((hop) => hop.kind)) === JSON.stringify(["consent", "apply"]), `Paylocity hops: ${JSON.stringify(outcome.hops)}`);
      check(await tab.evaluate(() => sessionStorage.getItem("consent")) === "closed", "the Paylocity banner was not closed (or was accepted)");
      const form = await recognizeCurrentForm(page);
      const kind = classifyAts(tab.url(), await tab.title(), await page.bodyText());
      check(kind.kind === "paylocity" && atsFlowFor(kind) === "confirm", `Paylocity kind: ${kind.kind} (${atsFlowFor(kind)})`);
      const labels = form.fields.map((field) => field.label);
      check(["First Name", "Last Name", "Email Address", "Mobile Number"].every((label) => labels.includes(label)), `Paylocity labels: ${labels.join("|")}`);
      check(!labels.some((label) => /\(required\)|\*$/.test(label)), `a Paylocity label kept its marker: ${labels.join("|")}`);
      const plan = planAutofill(form, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: VARIANT_ID });
      const byId = (id: string) => plan.decisions.find((decision) => decision.fieldId === id);
      const expected: Record<string, [string, string | null]> = {
        "info.firstName": ["fill", "Jordan"], "info.lastName": ["fill", "Rivera"], "info.email": ["fill", PROFILE.email], "info.cellPhone": ["fill", PROFILE.phone], "btn-resume": ["upload", null]
      };
      for (const [id, [action, value]] of Object.entries(expected)) {
        const decision = byId(id);
        check(decision?.action === action && (value === null || decision.value === value), `Paylocity ${id}: ${JSON.stringify(decision)}`);
      }
      check(plan.decisions.filter((decision) => decision.action === "upload").map((decision) => decision.fieldId).join("|") === "btn-resume",
        `Paylocity uploads: ${plan.decisions.filter((decision) => decision.action === "upload").map((decision) => decision.fieldId).join("|")}`);
      check(byId("public-site-address-county")?.action === "pause", `Paylocity County: ${JSON.stringify(byId("public-site-address-county"))}`);
      const applied = await applyDecisions(page, form, plan.decisions, (decision) => (decision.action === "upload" ? resumePdf : null));
      check(applied.unfilled.length === 0, `Paylocity unfilled: ${JSON.stringify(applied.unfilled)}`);
      const state = await tab.evaluate(() => (window as unknown as { fixture: { uploads: Record<string, string | null>; nextClicked: boolean } }).fixture);
      check(JSON.stringify(state.uploads) === JSON.stringify({ "btn-resume": "resume.pdf" }), `Paylocity upload state: ${JSON.stringify(state.uploads)}`);
      const buttons = await page.stepButtons();
      check(buttons.submit === false && buttons.next === "Next Step", `Paylocity step buttons: ${JSON.stringify(buttons)}`);
      check(multiStepStopReason(tab.url(), buttons) !== null, "the several-page stop does not apply to Paylocity's first step");
      check(await page.visibleChallenge!() === null, "Paylocity's form shows a challenge");
      check(!state.nextClicked, "Paylocity's Next Step was clicked");
      await tab.close();
    }

    // (iv) SmartRecruiters: the share box is no application field; I'm interested leads to DataDome, a challenge.
    {
      const tab = await open(SMARTRECRUITERS_POSTING);
      const page = createApplicationPage(tab);
      const posting = await recognizeCurrentForm(page);
      check(!hasApplicationFields(posting.fields), `SmartRecruiters posting fields: ${posting.fields.map((field) => field.label).join("|")}`);
      const outcome = await page.advanceToApplicationForm();
      check(outcome.stop === "challenge" && new URL(outcome.url).pathname.startsWith("/oneclick-ui/"), `SmartRecruiters walk: ${outcome.stop} at ${outcome.url}`);
      check(JSON.stringify(outcome.hops) === JSON.stringify([{ kind: "apply", text: "I'm interested" }]), `SmartRecruiters hops: ${JSON.stringify(outcome.hops)}`);
      await tab.close();
    }

    // (iv) Oracle Cloud HCM: no field on the posting; Apply Now reaches the email step, a wall.
    {
      const tab = await open(ORACLE_POSTING);
      const page = createApplicationPage(tab);
      const posting = await recognizeCurrentForm(page);
      check(posting.fields.length === 0, `Oracle posting fields: ${posting.fields.map((field) => `${field.id}:${field.label}`).join("|")}`);
      const outcome = await page.advanceToApplicationForm();
      check(outcome.stop === "wall" && outcome.url === `${ORACLE_POSTING}/apply/email`, `Oracle walk: ${outcome.stop} at ${outcome.url}`);
      const email = await recognizeCurrentForm(page);
      check(siteWallReason(tab.url(), email.fields)?.startsWith("Oracle Cloud HCM asks for your email at fixture.fa.ocs.oraclecloud.com") === true,
        `Oracle wall: ${siteWallReason(tab.url(), email.fields)}`);
      await tab.close();
    }

    const thirdParty = documentRequests.filter((href) => {
      const host = new URL(href).hostname;
      return !["careers.fixturerobotics.example", "recruiting.paylocity.com", "jobs.smartrecruiters.com", "fixture.fa.ocs.oraclecloud.com"].includes(host);
    });
    check(thirdParty.length === 0, `a followed entry reached another site: ${thirdParty.join(", ")}`);
    await context.close();
  } finally {
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`SITE_NAVIGATION_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`SITE_NAVIGATION_REPORT {"status":"passed","scenarios":6}`);
}

main().catch((error) => {
  console.error(`SITE_NAVIGATION_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
