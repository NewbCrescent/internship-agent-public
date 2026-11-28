/**
 * Ashby's voluntary checkbox groups (Track 82), in real Chromium against a
 * fictional fixture (fixtures/ashby-demographics.html, the markup shape
 * captured 2026-11-28 from a held run's stop evidence) served on Ashby's real
 * host name; every other request is aborted, so no network is used. Ashby
 * names each box after its own option, so no box name is the question's.
 * Proves: the pronoun, ethnicity, and sexual orientation groups read as
 * checkbox fields with every option, each with a data-ia-control tag as its
 * id (never an option's text); with fictional saved answers nothing pauses;
 * and the chosen options, none of them a group's first, are checked (the old
 * id, the first box's name, found only the first box: "the option was not
 * found").
 *
 * Usage: pnpm test:browser:ashby-demographics
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { chromium } from "playwright-core";

import {
  applyDecisions,
  createPlaywrightPage,
  matchSelfIdentificationOption,
  planAutofill,
  recognizeCurrentForm,
  type FieldResolution
} from "@internship-agent/browser";
import type { SelfIdentificationAnswers } from "@internship-agent/domain";

const PREFIX = "internship-agent-ashby-demographics-";
const HOST_PATH = "jobs.ashbyhq.com/fixturerobotics/00000000-0000-4000-8000-0000000000c1/application";
const URL_UNDER_TEST = `https://${HOST_PATH}`;
const PRONOUNS_LABEL = "What pronouns do you use?";
const ETHNICITY_LABEL = "Which ethnicity(ies) do you identify with? Please select all that apply.";
const ORIENTATION_LABEL = "How do you identify your sexual orientation? Please select all that apply.";
/** Fictional saved answers; option tables only, not a candidate. */
const ANSWERS: SelfIdentificationAnswers = { eeo_race_ethnicity: "white", eeo_sexual_orientation: "queer" };
const PRONOUNS: FieldResolution = { status: "RESOLVED", key: "pronouns", scope: "global", display: "they/them", value: "they/them" };
const EXPECTED_CHECKED = ["Queer", "They/them", "White"];
const PROFILE = { legalFirstName: "Jordan", legalLastName: "Rivera", email: "jordan@example.test" };

type FixtureState = { checked: string[] };

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const html = readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", "ashby-demographics.html"), "utf8");
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && request.resourceType() === "document" && `${url.hostname}${url.pathname}` === HOST_PATH) {
        await route.fulfill({ status: 200, contentType: "text/html", body: html });
      } else {
        await route.abort();
      }
    });
    const tab = await context.newPage();
    await tab.goto(URL_UNDER_TEST);
    const page = createPlaywrightPage(tab);
    const state = () => tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);

    // Recognition: three checkbox groups, each tagged, never named after an option.
    const form = await recognizeCurrentForm(page);
    const byLabel = (label: string) => form.fields.find((field) => field.label === label);
    const expectedOptions: Record<string, number> = { [PRONOUNS_LABEL]: 5, [ETHNICITY_LABEL]: 8, [ORIENTATION_LABEL]: 7 };
    for (const [label, count] of Object.entries(expectedOptions)) {
      const field = byLabel(label);
      check(field?.kind === "checkbox" && /^ia-control-\d+$/.test(field.id) && field.options?.length === count,
        `${label}: ${JSON.stringify(field && { kind: field.kind, id: field.id, options: field.options?.length })}`);
    }

    // Planning from the fictional answers.
    const resolutions = new Map<string, FieldResolution>();
    for (const field of form.fields) {
      if (field.label === PRONOUNS_LABEL) {
        resolutions.set(field.id, PRONOUNS);
        continue;
      }
      const saved = matchSelfIdentificationOption(field, ANSWERS);
      if (saved) resolutions.set(field.id, { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option });
    }
    check(resolutions.size === 3, `resolutions: ${resolutions.size} of 3`);
    const plan = planAutofill(form, { profile: PROFILE, resolutions, packageAnswers: [], variantId: null });
    check(plan.pauses.length === 0, `pauses: ${plan.pauses.map((pause) => pause.label).join(" | ")}`);
    const chosen = plan.decisions.filter((decision) => decision.action === "choose").map((decision) => decision.value).sort();
    check(JSON.stringify(chosen) === JSON.stringify(EXPECTED_CHECKED), `chosen: ${chosen.length}`);

    // Filling: every chosen option is checked, none of them its group's first.
    const applied = await applyDecisions(page, form, plan.decisions);
    check(applied.unfilled.length === 0, `unfilled: ${applied.unfilled.map((entry) => `${entry.fieldId}: ${entry.reason}`).join(" | ")}`);
    const filled = await state();
    check(JSON.stringify([...filled.checked].sort()) === JSON.stringify(EXPECTED_CHECKED), `checked: ${filled.checked.length} boxes`);
    await context.close();
  } finally {
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`ASHBY_DEMOGRAPHICS_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`ASHBY_DEMOGRAPHICS_REPORT {"status":"passed","scenarios":3}`);
}

main().catch((error) => {
  console.error(`ASHBY_DEMOGRAPHICS_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
