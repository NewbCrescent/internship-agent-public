/**
 * Forms on sites with no adapter (Track 35, 2026-11-25), in real Chromium
 * against three fictional, derived fixtures served on `.example` hosts; every
 * other request is aborted, so no network is used. Proves:
 * (a) Eightfold-style ARIA lists (fixtures/aria-list-application.html, an
 *     `input role="combobox"` naming a listbox drawn only while open) are read
 *     by opening them: readonly lists become plain lists with their options,
 *     the editable "How did you hear" list a searched list keeping them, the
 *     phone picker shows "+1", and no menu is left open; with fictional saved
 *     answers the plan chooses each list's option (pronoun prefix, saved
 *     "Sex" answer on its one matching option, the profile country on the
 *     picker), only the age question pauses, and every choice is kept;
 * (b) Rippling-style uploads and questions inside `label[aria-labelledby]`
 *     (fixtures/labelledby-application.html) take that label, never "Upload"
 *     or the random name, the resume upload is planned, and the phone
 *     popover's "Search" box is skipped;
 * (c) a Phenom-style posting's job-alert email box
 *     (fixtures/job-alert-posting.html) is not the application form: the walk
 *     follows Apply Now to the form, and the box is left empty.
 *
 * Usage: pnpm test:browser:unrecognized-forms
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium } from "playwright-core";

import {
  applyDecisions,
  classifyUploadRole,
  createApplicationPage,
  createPlaywrightPage,
  hasApplicationFields,
  matchSelfIdentificationOption,
  planAutofill,
  recognizeCurrentForm,
  type FieldResolution
} from "@internship-agent/browser";

const PREFIX = "internship-agent-unrecognized-forms-";
const ARIA_URL = "https://careers.fixtureaero.example/careers/apply?pid=1001";
const LABELLED_URL = "https://jobs.fixturehire.example/fixture/jobs/1/apply";
const POSTING_URL = "https://careers.fixturelabs.example/us/en/job/R100001/robotics-intern";
const APPLY_URL = "https://careers.fixturelabs.example/us/en/apply?jobSeqNo=R100001";
const PICKER = "Contact_Information_phone-country-code-picker";
/** Fictional profile and saved answers; never a candidate's. */
const PROFILE = { legalFirstName: "Jordan", legalLastName: "Rivera", email: "jordan@example.test", addressCountry: "United States" };
const EXPECTED: Record<string, string> = {
  [PICKER]: "United States (+1)",
  "input-7": "Yes",
  "input-11": "No",
  "input-19": "They/Them/Theirs",
  "input-23": "Female",
  "input-27": "Job Board"
};

type FixtureState = { chosen: Record<string, string>; opened: number };

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const fixture = (name: string) => readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", name), "utf8");
    const byPath: Record<string, string> = {
      "careers.fixtureaero.example/careers/apply": fixture("aria-list-application.html"),
      "jobs.fixturehire.example/fixture/jobs/1/apply": fixture("labelledby-application.html"),
      "careers.fixturelabs.example/us/en/job/R100001/robotics-intern": fixture("job-alert-posting.html"),
      "careers.fixturelabs.example/us/en/apply": fixture("job-alert-posting.html")
    };
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      const body = url && request.resourceType() === "document" ? byPath[`${url.hostname}${url.pathname}`] : undefined;
      if (body) await route.fulfill({ status: 200, contentType: "text/html", body });
      else await route.abort();
    });
    const open = async (url: string) => {
      const tab = await context.newPage();
      await tab.goto(url);
      return tab;
    };

    // (a) Eightfold-style ARIA lists.
    {
      const tab = await open(ARIA_URL);
      const page = createPlaywrightPage(tab);
      const menusOpen = () => tab.locator('[role="listbox"]').filter({ visible: true }).count();
      const form = await recognizeCurrentForm(page);
      const byId = (id: string) => form.fields.find((field) => field.id === id);
      for (const id of [PICKER, "input-7", "input-11", "input-19", "input-23", "input-31"]) {
        const field = byId(id);
        check(field?.kind === "select" && field.widget === undefined && (field.options?.length ?? 0) >= 2,
          `${id} was not read as a plain list: ${JSON.stringify(field && { kind: field.kind, widget: field.widget, options: field.options })}`);
      }
      check(JSON.stringify(byId("input-19")?.options) === JSON.stringify(["He/Him/His", "She/Her/Hers", "They/Them/Theirs", "Prefer not to say"]),
        `pronoun options: ${JSON.stringify(byId("input-19")?.options)}`);
      const heard = byId("input-27");
      check(heard?.kind === "select" && heard.widget === "autocomplete" && heard.options?.length === 4,
        `the editable list was not read as a searched list: ${JSON.stringify(heard && { kind: heard.kind, widget: heard.widget, options: heard.options })}`);
      check(byId(PICKER)?.currentValue === "+1", `picker shows ${JSON.stringify(byId(PICKER)?.currentValue)}`);
      check(byId("input-7")?.required === true && byId("input-31")?.required === true, "a starred list is not required");
      check(await menusOpen() === 0, "a list menu was left open after reading the lists");

      const resolutions = new Map<string, FieldResolution>([
        ["input-7", { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true }],
        ["input-11", { status: "RESOLVED", key: "requires_sponsorship", scope: "country:US", display: "No", value: false }],
        ["input-19", { status: "RESOLVED", key: "pronouns", scope: "global", display: "they/them", value: "they/them" }],
        // A fictional saved how-heard answer: the suite does not depend on the job-board fallback.
        ["input-27", { status: "RESOLVED", key: "how_heard", scope: "global", display: "Job Board", value: "Job Board" }]
      ]);
      const sex = byId("input-23");
      const saved = sex ? matchSelfIdentificationOption(sex, { eeo_gender: "female" }) : null;
      check(saved?.option === "Female", `the saved answer matched ${JSON.stringify(saved)}`);
      if (saved) resolutions.set("input-23", { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option });
      const plan = planAutofill(form, { profile: PROFILE, resolutions, packageAnswers: [], variantId: null });
      for (const [id, value] of Object.entries(EXPECTED)) {
        const decision = plan.decisions.find((entry) => entry.fieldId === id);
        check(decision?.action === "choose" && decision.value === value, `${id} decision: ${JSON.stringify(decision && { action: decision.action, value: decision.value })}`);
      }
      check(plan.pauses.length === 1 && plan.pauses[0]!.fieldId === "input-31", `pauses: ${plan.pauses.map((pause) => pause.label).join(" | ")}`);

      const applied = await applyDecisions(page, form, plan.decisions);
      check(applied.unfilled.length === 0, `unfilled: ${applied.unfilled.map((entry) => `${entry.fieldId}: ${entry.reason}`).join(" | ")}`);
      const state = await tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);
      check(JSON.stringify(Object.keys(state.chosen).sort()) === JSON.stringify(Object.keys(EXPECTED).sort()), `lists chosen: ${Object.keys(state.chosen).join(", ")}`);
      for (const [id, value] of Object.entries(EXPECTED)) check(state.chosen[id] === value, `${id} was not given its fixture option`);
      const shown = await tab.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, (document.getElementById(id) as HTMLInputElement).value])), Object.keys(EXPECTED));
      for (const [id, value] of Object.entries(EXPECTED)) {
        const wanted = id === PICKER ? "+1" : value;
        check(shown[id] === wanted, `${id} shows ${JSON.stringify(shown[id])}, not ${JSON.stringify(wanted)}`);
      }
      check(await tab.evaluate(() => (document.getElementById("input-31") as HTMLInputElement).value) === "", "the age list was answered");
      check(await menusOpen() === 0, "a list menu was left open after filling");
      await tab.close();
    }

    // (b) Rippling-style label[aria-labelledby] uploads and questions.
    {
      const tab = await open(LABELLED_URL);
      const form = await recognizeCurrentForm(createPlaywrightPage(tab));
      const byId = (id: string) => form.fields.find((field) => field.id === id);
      const resume = byId("field-60");
      check(resume?.kind === "file" && resume.label === "Resume" && resume.required === true && classifyUploadRole(resume.label, resume.id) === "resume",
        `upload read as ${JSON.stringify(resume && { label: resume.label, required: resume.required })}`);
      check(byId("field-94")?.label === "What is your expected graduation date?", `custom question read as ${JSON.stringify(byId("field-94")?.label)}`);
      check(!form.fields.some((field) => field.label === "cn8cnAwlo2" || field.label === "Xk3pQ9wL_z"), "a generated name labelled a field");
      const plan = planAutofill(form, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: "variant-fixture" });
      check(plan.decisions.find((decision) => decision.fieldId === "field-60")?.action === "upload", "the resume upload was not planned");
      check(plan.decisions.find((decision) => decision.fieldId === "field-38")?.action === "skip", "the list's Search box was not skipped");
      check(!plan.pauses.some((pause) => pause.fieldId === "field-38" || pause.fieldId === "field-60"), `pauses: ${plan.pauses.map((pause) => pause.label).join(" | ")}`);
      await tab.close();
    }

    // (c) A Phenom-style posting's job-alert box is not the form.
    {
      const tab = await open(POSTING_URL);
      const posting = await recognizeCurrentForm(createPlaywrightPage(tab));
      check(posting.fields.some((field) => field.id === "notifiedEmail"), "the job-alert box was not read");
      check(!hasApplicationFields(posting.fields), "the posting's job-alert box counted as an application field");
      const skipped = planAutofill(posting, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: null });
      check(skipped.decisions.find((decision) => decision.fieldId === "notifiedEmail")?.action === "skip", "the job-alert box was not left empty");
      check(!skipped.pauses.some((pause) => pause.fieldId === "notifiedEmail"), "the job-alert box paused");
      const outcome = await createApplicationPage(tab).advanceToApplicationForm();
      check(outcome.stop === "form" && outcome.moved && outcome.hops.some((hop) => hop.kind === "apply") && outcome.url === APPLY_URL,
        `walk: ${JSON.stringify(outcome)}`);
      const form = await recognizeCurrentForm(createPlaywrightPage(tab));
      check(["First Name", "Last Name", "Email", "Resume"].every((label) => form.fields.some((field) => field.label === label)),
        `apply form fields: ${form.fields.map((field) => field.label).join("|")}`);
      await tab.close();
    }
    await context.close();
  } finally {
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`UNRECOGNIZED_FORMS_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`UNRECOGNIZED_FORMS_REPORT {"status":"passed","scenarios":3}`);
}

main().catch((error) => {
  console.error(`UNRECOGNIZED_FORMS_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
