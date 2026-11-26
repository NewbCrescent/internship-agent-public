/**
 * Forms on sites with no adapter (Track 35, 2026-11-25), in real Chromium
 * against three fictional, derived fixtures served on `.example` hosts; every
 * other request is aborted, so no network is used. Proves:
 * (a) Eightfold-style ARIA lists (fixtures/aria-list-application.html, an
 *     `input role="combobox"` naming a listbox drawn only while open) are read
 *     by opening them: every list that shows its options becomes a plain list
 *     (the editable "How did you hear" list too, Track 37), the
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
 *     follows Apply Now to the form, and the box is left empty;
 * Track 37 (2026-11-25), fixtures derived from read-only captures of live forms:
 * (d) the live-shaped Eightfold form (fixtures/eightfold-application.html):
 *     with its welcome dialog up, every editable Octuple list and the phone
 *     picker are read as plain lists (the dialog is closed by its own close
 *     button), the picker that already shows the profile's country is kept,
 *     fictional saved answers choose every list by clicking, and only the age
 *     question pauses;
 * (e) the same form with a layer that takes every trusted click once a resume
 *     is chosen (`?blocked=1`): the lists are still chosen and shown; with a
 *     modal "session expired" dialog instead (`?blocked=dialog`), nothing is
 *     clicked through and the lists are left unfilled; the first one hands
 *     over one evidence capture (Track 39) holding the page text, the
 *     query-stripped URL, and the dialog's text, role, aria attributes, and
 *     button labels, read without clicking either of its buttons;
 * (f) a picker that shows another country (`?country=ca`) is chosen to the
 *     profile's;
 * (g) a Phenom-style "Country Phone Code" select (fixtures/phenom-application.html)
 *     takes the profile country ("USA");
 * (h) Rippling-style custom questions (fixtures/rippling-application.html) read
 *     as their question text, never the random name or "Unlabeled …", and the
 *     Pronouns list takes the one single-set option the saved pronouns start.
 * Track 38 (2026-11-25), derived from a read-only capture of a live Phenom step 1 behind an Osano banner:
 * (i) a Phenom-style step 1 that mentions Workday (fixtures/phenom-steps-application.html) reads as an
 *     unknown site, never Workday; with the banner shown, dismissed (hidden, box kept), or absent, no
 *     submit control is found, so the banner's typeless Accept and the step's explicit-submit "Next" are
 *     never clicked as submit; the walk denies the banner, and the page is held as not at its last step.
 *
 * Usage: pnpm test:browser:unrecognized-forms
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium, type Page } from "playwright-core";

import {
  applyDecisions,
  atsFlowFor,
  classifyAts,
  COVERING_DIALOG_REASON,
  classifyUploadRole,
  createApplicationPage,
  createPlaywrightPage,
  hasApplicationFields,
  matchSelfIdentificationOption,
  planAutofill,
  UNLABELED_CONTROL_LABEL,
  recognizeCurrentForm,
  submitTargetHoldReason,
  type FieldResolution,
  type PostSubmitEvidence
} from "@internship-agent/browser";

const PREFIX = "internship-agent-unrecognized-forms-";
const ARIA_URL = "https://careers.fixtureaero.example/careers/apply?pid=1001";
const LABELLED_URL = "https://jobs.fixturehire.example/fixture/jobs/1/apply";
const POSTING_URL = "https://careers.fixturelabs.example/us/en/job/R100001/robotics-intern";
const APPLY_URL = "https://careers.fixturelabs.example/us/en/apply?jobSeqNo=R100001";
const PICKER = "Contact_Information_phone-country-code-picker";
const EIGHTFOLD_URL = "https://careers.fixtureaero.example/careers/apply?pid=2002";
const PHENOM_URL = "https://careers.fixturelabs.example/us/en/apply?jobSeqNo=R200002&step=1&stepname=personalInformation";
const RIPPLING_URL = "https://jobs.fixturehire.example/fixture/jobs/2/apply";
const PHENOM_STEPS_URL = "https://careers.fixturelabs.example/us/en/apply?jobSeqNo=R300003&step=1&stepname=personalInformation";
const US_PICKER = "🇺🇸 (+1) United States of America";
/** Fictional saved answers for the live-shaped Eightfold form (Track 37); never a candidate's. */
const EIGHTFOLD_EXPECTED: Record<string, string> = {
  "input-7": "She/Her/Hers",
  "input-10": "Job Board/Job Search Site",
  "input-16": "No",
  "input-19": "Yes",
  "input-22": "No",
  "input-58": "Female"
};
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

type FixtureState = { chosen: Record<string, string>; opened: number; dialogClicks?: number };

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
      "careers.fixturelabs.example/us/en/apply": fixture("job-alert-posting.html"),
      // Track 37: the live-shaped fixtures; a pid or jobSeqNo picks them on a path Track 35's fixtures share.
      "careers.fixtureaero.example/careers/apply?pid=2002": fixture("eightfold-application.html"),
      "careers.fixturelabs.example/us/en/apply?jobSeqNo=R200002": fixture("phenom-application.html"),
      "jobs.fixturehire.example/fixture/jobs/2/apply": fixture("rippling-application.html"),
      // Track 38: picked by jobSeqNo, so the `&banner=0` variant routes here too.
      "careers.fixturelabs.example/us/en/apply?jobSeqNo=R300003": fixture("phenom-steps-application.html")
    };
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      const pick = url && (url.searchParams.get("pid") ? `?pid=${url.searchParams.get("pid")}` : url.searchParams.get("jobSeqNo") ? `?jobSeqNo=${url.searchParams.get("jobSeqNo")}` : "");
      const body = url && request.resourceType() === "document"
        ? byPath[`${url.hostname}${url.pathname}${pick}`] ?? byPath[`${url.hostname}${url.pathname}`]
        : undefined;
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
      for (const id of [PICKER, "input-7", "input-11", "input-19", "input-23", "input-27", "input-31"]) {
        const field = byId(id);
        check(field?.kind === "select" && field.widget === undefined && (field.options?.length ?? 0) >= 2,
          `${id} was not read as a plain list: ${JSON.stringify(field && { kind: field.kind, widget: field.widget, options: field.options })}`);
      }
      check(JSON.stringify(byId("input-19")?.options) === JSON.stringify(["He/Him/His", "She/Her/Hers", "They/Them/Theirs", "Prefer not to say"]),
        `pronoun options: ${JSON.stringify(byId("input-19")?.options)}`);
      check(byId("input-27")?.options?.length === 4, `how-heard options: ${JSON.stringify(byId("input-27")?.options)}`);
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

    // Track 37: a fictional resume, written to the suite's own temp directory.
    const resumePath = join(temp, "fixture-resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n% fictional fixture resume\n%%EOF\n");
    const listsOpen = (tab: Page) => tab.locator('[role="listbox"]').filter({ visible: true }).count();
    const shownValues = (tab: Page, ids: string[]) =>
      tab.evaluate((list) => Object.fromEntries(list.map((id) => [id, (document.getElementById(id) as HTMLInputElement | null)?.value ?? null])), ids);
    const fixtureState = (tab: Page) => tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);

    // (d) The live-shaped Eightfold form, its welcome dialog up.
    {
      const tab = await open(EIGHTFOLD_URL);
      const page = createPlaywrightPage(tab);
      check(await tab.locator("#welcomeModal").isVisible(), "the welcome dialog was not shown on load");
      const form = await recognizeCurrentForm(page);
      const byId = (id: string) => form.fields.find((field) => field.id === id);
      for (const id of [PICKER, "input-7", "input-10", "input-13", "input-16", "input-19", "input-22", "input-58"]) {
        const field = byId(id);
        check(field?.kind === "select" && field.widget === undefined && (field.options?.length ?? 0) >= 2,
          `(d) ${id} was not read as a plain list: ${JSON.stringify(field && { kind: field.kind, widget: field.widget, options: field.options })}`);
      }
      check(JSON.stringify(byId(PICKER)?.options) === JSON.stringify([US_PICKER, "🇨🇦 (+1) Canada", "🇲🇽 (+52) Mexico"]), `(d) picker options: ${JSON.stringify(byId(PICKER)?.options)}`);
      check(byId(PICKER)?.currentValue === US_PICKER, `(d) picker shows ${JSON.stringify(byId(PICKER)?.currentValue)}`);
      check(byId("input-10")?.options?.length === 4, `(d) how-heard options: ${JSON.stringify(byId("input-10")?.options)}`);
      check(!(await tab.locator("#welcomeModal").isVisible()), "(d) the welcome dialog was still shown after reading the form");
      check(await listsOpen(tab) === 0, "(d) a list was left open after reading the form");

      const resolutions = new Map<string, FieldResolution>([
        ["input-7", { status: "RESOLVED", key: "pronouns", scope: "global", display: "she/her", value: "she/her" }],
        ["input-10", { status: "RESOLVED", key: "how_heard", scope: "global", display: "Job Board/Job Search Site", value: "Job Board/Job Search Site" }],
        ["input-16", { status: "RESOLVED", key: "previously_employed_here", scope: "global", display: "No", value: false }],
        ["input-19", { status: "RESOLVED", key: "authorized_to_work", scope: "country:US", display: "Yes", value: true }],
        ["input-22", { status: "RESOLVED", key: "requires_sponsorship", scope: "country:US", display: "No", value: false }]
      ]);
      const sex = byId("input-58");
      const saved = sex ? matchSelfIdentificationOption(sex, { eeo_gender: "female" }) : null;
      check(saved?.option === "Female", `(d) the saved answer matched ${JSON.stringify(saved)}`);
      if (saved) resolutions.set("input-58", { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option });
      const plan = planAutofill(form, { profile: { ...PROFILE, phone: "555-0100" }, resolutions, packageAnswers: [], variantId: "variant-fixture" });
      for (const [id, value] of Object.entries(EIGHTFOLD_EXPECTED)) {
        const decision = plan.decisions.find((entry) => entry.fieldId === id);
        check(decision?.action === "choose" && decision.value === value, `(d) ${id} decision: ${JSON.stringify(decision && { action: decision.action, value: decision.value })}`);
      }
      const kept = plan.decisions.find((entry) => entry.fieldId === PICKER);
      check(kept?.action === "keep" && kept.value === US_PICKER, `(d) picker decision: ${JSON.stringify(kept && { action: kept.action, value: kept.value })}`);
      check(plan.pauses.length === 1 && plan.pauses[0]!.fieldId === "input-13", `(d) pauses: ${plan.pauses.map((pause) => pause.label).join(" | ")}`);

      const applied = await applyDecisions(page, form, plan.decisions, (decision) => decision.action === "upload" ? resumePath : null);
      check(applied.unfilled.length === 0, `(d) unfilled: ${applied.unfilled.map((entry) => `${entry.fieldId}: ${entry.reason}`).join(" | ")}`);
      const state = await fixtureState(tab);
      check(JSON.stringify(Object.keys(state.chosen).sort()) === JSON.stringify(Object.keys(EIGHTFOLD_EXPECTED).sort()), `(d) lists chosen: ${Object.keys(state.chosen).join(", ")}`);
      const shown = await shownValues(tab, [...Object.keys(EIGHTFOLD_EXPECTED), PICKER, "input-13"]);
      for (const [id, value] of Object.entries(EIGHTFOLD_EXPECTED)) {
        check(state.chosen[id] === value, `(d) ${id} was not given its fixture option`);
        check(shown[id] === value, `(d) ${id} shows ${JSON.stringify(shown[id])}, not ${JSON.stringify(value)}`);
      }
      check(shown[PICKER] === US_PICKER, `(d) the picker shows ${JSON.stringify(shown[PICKER])}`);
      check(shown["input-13"] === "", "(d) the age list was answered");
      check(await listsOpen(tab) === 0, "(d) a list was left open after filling");
      await tab.close();
    }

    // (e) Trusted clicks stop landing once a resume is chosen; a modal "session expired" dialog is never clicked through.
    {
      const tab = await open(`${EIGHTFOLD_URL}&blocked=1&welcome=0`);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      await tab.locator("#Resume_CV_resume").setInputFiles(resumePath);
      const decisions = [
        { fieldId: "input-19", action: "choose" as const, value: "Yes", basis: null, reason: "fixture", pause: null },
        { fieldId: "input-22", action: "choose" as const, value: "No", basis: null, reason: "fixture", pause: null }
      ];
      const applied = await applyDecisions(page, form, decisions);
      check(applied.unfilled.length === 0, `(e) unfilled behind the layer: ${applied.unfilled.map((entry) => `${entry.fieldId}: ${entry.reason}`).join(" | ")}`);
      const state = await fixtureState(tab);
      const shown = await shownValues(tab, ["input-19", "input-22"]);
      check(state.chosen["input-19"] === "Yes" && state.chosen["input-22"] === "No", `(e) chosen behind the layer: ${JSON.stringify(state.chosen)}`);
      check(shown["input-19"] === "Yes" && shown["input-22"] === "No", `(e) shown behind the layer: ${JSON.stringify(shown)}`);
      await tab.close();
    }
    {
      const tab = await open(`${EIGHTFOLD_URL}&blocked=dialog&welcome=0`);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      check((await page.coveringDialogs!()).length === 0, "(e) a covering dialog was read before the resume was chosen");
      await tab.locator("#Resume_CV_resume").setInputFiles(resumePath);
      // Track 39: the first field the dialog leaves unfilled hands over one capture of it, read while it is up; nothing in it is clicked.
      const captures: PostSubmitEvidence[] = [];
      const applied = await applyDecisions(page, form, [
        { fieldId: "input-19", action: "choose", value: "Yes", basis: null, reason: "fixture", pause: null },
        { fieldId: "input-22", action: "choose", value: "No", basis: null, reason: "fixture", pause: null }
      ], undefined, { onCoveringDialog: async (evidence) => { captures.push(evidence); } });
      check(applied.unfilled.length === 2 && applied.unfilled.every((entry) => entry.reason === COVERING_DIALOG_REASON) && applied.unfilled[0]!.fieldId === "input-19",
        `(e) under the session dialog: ${JSON.stringify(applied.unfilled)}`);
      const state = await fixtureState(tab);
      check(state.chosen["input-19"] === undefined && state.chosen["input-22"] === undefined, `(e) a list was chosen through the session dialog: ${JSON.stringify(state.chosen)}`);
      check(state.dialogClicks === 0, `(e) the session dialog's buttons were clicked ${state.dialogClicks} time(s)`);
      check(await tab.locator(".expired").isVisible(), "(e) the session dialog was closed");
      check(captures.length === 1, `(e) covering-dialog captures: ${captures.length}, expected 1`);
      const capture = captures[0];
      const label19 = form.fields.find((field) => field.id === "input-19")?.label ?? "";
      check(capture?.outcome === "covering-dialog" && Boolean(label19) && (capture.detail ?? "").includes(label19),
        `(e) capture outcome and detail: ${JSON.stringify({ outcome: capture?.outcome, detail: capture?.detail })}`);
      check((capture?.bodyText ?? "").includes("Your session has expired"), "(e) the capture's visible text misses the dialog");
      check(capture?.url === EIGHTFOLD_URL.split("?")[0], `(e) the capture's URL keeps its query: ${capture?.url}`);
      const dialog = capture?.coveringDialogs?.length === 1 ? capture.coveringDialogs[0]! : null;
      const aria = Object.fromEntries((dialog?.ariaAttributes ?? []).map((attribute) => [attribute.name, attribute.value]));
      check(dialog !== null && dialog.tag === "div" && dialog.role === "dialog" && dialog.label === "Your session has expired"
        && dialog.description === "Reload the page to continue." && dialog.text.includes("Your session has expired")
        && aria["aria-modal"] === "true" && aria["aria-labelledby"] === "expiredTitle" && aria["aria-describedby"] === "expiredText",
        `(e) the covering dialog as read: ${JSON.stringify(capture?.coveringDialogs)}`);
      const buttons = (dialog?.buttons ?? []).map((button) => `${button.text}|${button.ariaLabel}|${button.title}|${button.disabled}`);
      check(JSON.stringify(buttons) === JSON.stringify(["Sign in again|||false", "×|Close|Close|false"]), `(e) the dialog's buttons as read: ${JSON.stringify(buttons)}`);
      await tab.close();
    }

    // (f) A picker showing another country is chosen to the profile's.
    {
      const tab = await open(`${EIGHTFOLD_URL}&country=ca&welcome=0`);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      const picker = form.fields.find((field) => field.id === PICKER);
      check(picker?.currentValue === "🇨🇦 (+1) Canada", `(f) picker shows ${JSON.stringify(picker?.currentValue)}`);
      const plan = planAutofill(form, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: null });
      const decision = plan.decisions.find((entry) => entry.fieldId === PICKER);
      check(decision?.action === "choose" && decision.value === US_PICKER, `(f) picker decision: ${JSON.stringify(decision && { action: decision.action, value: decision.value })}`);
      const applied = await applyDecisions(page, form, decision ? [decision] : []);
      check(applied.unfilled.length === 0, `(f) unfilled: ${JSON.stringify(applied.unfilled)}`);
      const shown = await shownValues(tab, [PICKER]);
      check(shown[PICKER] === US_PICKER && (await fixtureState(tab)).chosen[PICKER] === US_PICKER, `(f) the picker shows ${JSON.stringify(shown[PICKER])}`);
      await tab.close();
    }

    // (g) A Phenom-style "Country Phone Code" select takes the profile country.
    {
      const tab = await open(PHENOM_URL);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      const code = form.fields.find((field) => field.id === "phoneWidget.countryPhoneCode");
      check(code?.kind === "select" && code.label === "Country Phone Code", `(g) phone code read as ${JSON.stringify(code && { kind: code.kind, label: code.label })}`);
      const plan = planAutofill(form, { profile: PROFILE, resolutions: new Map(), packageAnswers: [], variantId: null });
      const decision = plan.decisions.find((entry) => entry.fieldId === "phoneWidget.countryPhoneCode");
      check(decision?.action === "choose" && decision.value === "USA" && decision.basis?.kind === "profile" && decision.basis.field === "addressCountry",
        `(g) phone code decision: ${JSON.stringify(decision && { action: decision.action, value: decision.value, basis: decision.basis })}`);
      check(!plan.pauses.some((pause) => pause.fieldId === "phoneWidget.countryPhoneCode"), "(g) the phone code paused");
      const applied = await applyDecisions(page, form, decision ? [decision] : []);
      check(applied.unfilled.length === 0, `(g) unfilled: ${JSON.stringify(applied.unfilled)}`);
      const picked = await tab.evaluate(() => {
        const select = document.getElementById("phoneWidget.countryPhoneCode") as HTMLSelectElement;
        return select.options[select.selectedIndex]?.text ?? "";
      });
      check(picked === "USA", `(g) the phone code shows ${JSON.stringify(picked)}`);
      await tab.close();
    }

    // (h) Rippling-style custom questions and the Pronouns list.
    {
      const tab = await open(RIPPLING_URL);
      const page = createPlaywrightPage(tab);
      const form = await recognizeCurrentForm(page);
      const byId = (id: string) => form.fields.find((field) => field.id === id);
      check(byId("field-90")?.label === "What is your expected graduation date?", `(h) field-90 read as ${JSON.stringify(byId("field-90")?.label)}`);
      check(byId("field-94")?.label === "Which city would you prefer to work in?", `(h) field-94 read as ${JSON.stringify(byId("field-94")?.label)}`);
      check(byId("field-124")?.kind === "textarea" && (byId("field-124")?.label ?? "").startsWith("Why are you interested in Fixture Hire?"),
        `(h) field-124 read as ${JSON.stringify(byId("field-124")?.label)}`);
      check(byId("field-8")?.label === "First name", `(h) field-8 read as ${JSON.stringify(byId("field-8")?.label)}`);
      const tokens = new Set(["Qm7rTz2pLk", "Vb8nWq1sYe", "Lp4wXc9_Rd", "Ty2-hBn6Qa"]);
      check(!form.fields.some((field) => tokens.has(field.label) || UNLABELED_CONTROL_LABEL.test(field.label)),
        `(h) labels: ${form.fields.map((field) => field.label).join(" | ")}`);
      const pronouns = byId("field-20");
      check(pronouns?.kind === "select" && pronouns.widget === undefined && pronouns.options?.length === 7 && pronouns.label === "Pronouns",
        `(h) pronouns read as ${JSON.stringify(pronouns && { kind: pronouns.kind, widget: pronouns.widget, label: pronouns.label, options: pronouns.options })}`);
      const resolutions = new Map<string, FieldResolution>([
        ["field-20", { status: "RESOLVED", key: "pronouns", scope: "global", display: "she/her", value: "she/her" }]
      ]);
      const plan = planAutofill(form, { profile: PROFILE, resolutions, packageAnswers: [], variantId: null });
      const decision = plan.decisions.find((entry) => entry.fieldId === "field-20");
      check(decision?.action === "choose" && decision.value === "She/her/hers", `(h) pronouns decision: ${JSON.stringify(decision && { action: decision.action, value: decision.value })}`);
      const applied = await applyDecisions(page, form, decision ? [decision] : []);
      check(applied.unfilled.length === 0, `(h) unfilled: ${JSON.stringify(applied.unfilled)}`);
      const shown = await shownValues(tab, ["field-20"]);
      check(shown["field-20"] === "She/her/hers" && (await fixtureState(tab)).chosen["field-20"] === "She/her/hers", `(h) pronouns show ${JSON.stringify(shown["field-20"])}`);
      check(await listsOpen(tab) === 0, "(h) a list was left open after filling");
      await tab.close();
    }

    // (i) Track 38: a Phenom-style step 1 that mentions Workday, behind an Osano-style banner.
    {
      type StepsState = { accepted: boolean; denied: boolean; next: boolean };
      const stepsState = (tab: Page) => tab.evaluate(() => (window as unknown as { fixture: StepsState }).fixture);
      const clickResult = (page: ReturnType<typeof createPlaywrightPage>) =>
        page.clickSubmit().then(() => "clicked", (error: unknown) => (error instanceof Error ? error.message : String(error)));
      const tab = await open(PHENOM_STEPS_URL);
      // A click that waits on a hidden control fails fast instead of after 30 s.
      tab.setDefaultTimeout(5_000);
      const page = createPlaywrightPage(tab);
      const classification = classifyAts(tab.url(), await tab.title(), await page.bodyText());
      check(classification.kind === "unknown" && atsFlowFor(classification) === "generic",
        `(i) classified as ${JSON.stringify({ kind: classification.kind, confidence: classification.confidence, flow: atsFlowFor(classification) })}`);
      check(await page.submitControlShown?.() === false, "(i) a submit control was found with the banner shown");
      const shownClick = await clickResult(page);
      check(shownClick === "No submit control was found.", `(i) submit with the banner shown: ${shownClick}`);
      let state = await stepsState(tab);
      check(!state.accepted && !state.next, `(i) banner shown: ${JSON.stringify(state)}`);
      const walk = await createApplicationPage(tab).advanceToApplicationForm();
      state = await stepsState(tab);
      check(walk.stop === "form" && walk.hops.some((hop) => hop.kind === "consent") && state.denied && !state.accepted,
        `(i) walk: ${JSON.stringify({ stop: walk.stop, hops: walk.hops, state })}`);
      check(await page.submitControlShown?.() === false, "(i) a submit control was found with the banner dismissed");
      const hiddenClick = await clickResult(page);
      check(hiddenClick === "No submit control was found.", `(i) submit with the banner dismissed: ${hiddenClick}`);
      state = await stepsState(tab);
      check(!state.accepted && !state.next, `(i) banner dismissed: ${JSON.stringify(state)}`);
      const stepButtons = await createApplicationPage(tab).stepButtons();
      check(stepButtons.submit === false && stepButtons.next === "Next", `(i) step buttons: ${JSON.stringify(stepButtons)}`);
      const held = submitTargetHoldReason({ url: tab.url(), submitShown: false, stepButtons });
      check(held?.startsWith("The application at careers.fixturelabs.example still shows") === true, `(i) hold reason: ${held}`);
      await tab.close();

      const bare = await open(`${PHENOM_STEPS_URL}&banner=0`);
      bare.setDefaultTimeout(5_000);
      const barePage = createPlaywrightPage(bare);
      check(await barePage.submitControlShown?.() === false, "(i) a submit control was found with no banner");
      const bareClick = await clickResult(barePage);
      check(bareClick === "No submit control was found.", `(i) submit with no banner: ${bareClick}`);
      check(!(await stepsState(bare)).next, "(i) the step's Next was clicked as submit with no banner");
      await bare.close();
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
  console.log(`UNRECOGNIZED_FORMS_REPORT {"status":"passed","scenarios":9}`);
}

main().catch((error) => {
  console.error(`UNRECOGNIZED_FORMS_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
