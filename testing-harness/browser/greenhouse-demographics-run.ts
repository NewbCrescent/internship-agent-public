/**
 * Greenhouse's one-option terms question and its "mark all that apply"
 * voluntary self-identification multi-selects (2026-11-24), in real Chromium
 * against a fictional fixture (fixtures/greenhouse-demographics.html) served
 * on Greenhouse's real host name; every other request is aborted, so no
 * network is used. Proves: the lone "I agree and consent" box takes its
 * fieldset legend in front ("Terms of Use and Privacy Notice: I agree and
 * consent") and is required; the standing data-consent setting checks it as
 * terms of use, and without the setting it pauses; the three multi lists are
 * selects with their options; with fictional saved answers each list's one
 * matching option is chosen and kept as a react-select chip (no "did not
 * accept the option"); choosing a chosen option again succeeds without a
 * click; the single transgender list takes "No" for a saved "not
 * transgender"; and no list menu is left open.
 *
 * Usage: pnpm test:browser:greenhouse-demographics
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

const PREFIX = "internship-agent-greenhouse-demographics-";
const URL_UNDER_TEST = "https://job-boards.greenhouse.io/fixturerobotics/jobs/7000001";
const TERMS_LABEL = "Terms of Use and Privacy Notice: I agree and consent";
/** Fictional saved answers; option tables only, not a candidate. */
const ANSWERS: SelfIdentificationAnswers = {
  eeo_gender: "non_binary",
  eeo_race_ethnicity: "white",
  eeo_sexual_orientation: "queer",
  eeo_transgender: "not_transgender"
};
const EXPECTED: Record<string, string | string[]> = {
  question_7002: ["Non-binary"],
  question_7003: ["White or European"],
  question_7004: ["Queer"],
  question_7005: "No"
};
const PROFILE = { legalFirstName: "Jordan", legalLastName: "Rivera", email: "jordan@example.test" };

type FixtureState = { checked: string[]; selects: Record<string, string | string[]> };

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), PREFIX));
  const failures: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
  try {
    const html = readFileSync(join(process.cwd(), "testing-harness/browser/fixtures", "greenhouse-demographics.html"), "utf8");
    const context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url: URL | null = null;
      try { url = new URL(request.url()); } catch { /* not a URL */ }
      if (url && request.resourceType() === "document" && `${url.hostname}${url.pathname}` === "job-boards.greenhouse.io/fixturerobotics/jobs/7000001") {
        await route.fulfill({ status: 200, contentType: "text/html", body: html });
      } else {
        await route.abort();
      }
    });
    const tab = await context.newPage();
    await tab.goto(URL_UNDER_TEST);
    const page = createPlaywrightPage(tab);
    const state = () => tab.evaluate(() => (window as unknown as { fixture: FixtureState }).fixture);
    const menusOpen = () => tab.locator('[class*="select__menu"]').filter({ visible: true }).count();

    // Recognition.
    const form = await recognizeCurrentForm(page);
    const byId = (id: string) => form.fields.find((field) => field.id === id);
    const terms = form.fields.find((field) => field.kind === "checkbox" && field.id.startsWith("question_7001"));
    check(terms?.label === TERMS_LABEL, `one-box terms label: ${JSON.stringify(terms?.label)}`);
    check(terms?.required === true, "the one-box terms question is not required");
    for (const id of ["question_7002", "question_7003", "question_7004", "question_7005"]) {
      const field = byId(id);
      check(field?.kind === "select" && field.widget === undefined && (field.options?.length ?? 0) >= 3, `${id}: ${JSON.stringify(field && { kind: field.kind, widget: field.widget, options: field.options?.length })}`);
    }
    check(await menusOpen() === 0, "a list menu was left open after reading the lists");

    // Planning: terms under the standing setting; self-identification from the fictional answers.
    const resolutions = new Map<string, FieldResolution>();
    for (const field of form.fields) {
      const saved = matchSelfIdentificationOption(field, ANSWERS);
      if (saved) resolutions.set(field.id, { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option });
    }
    check(resolutions.size === 4, `self-identification matches: ${resolutions.size} of 4`);
    const inputs = { profile: PROFILE, resolutions, packageAnswers: [], variantId: null };
    const off = planAutofill(form, { ...inputs, standing: { acceptDataConsent: false, signAttestations: false } });
    check(off.decisions.find((decision) => decision.fieldId === terms?.id)?.action === "pause", "the terms box did not pause without the setting");
    const plan = planAutofill(form, { ...inputs, standing: { acceptDataConsent: true, signAttestations: false } });
    const termsDecision = plan.decisions.find((decision) => decision.fieldId === terms?.id);
    check(termsDecision?.action === "check" && termsDecision.basis?.kind === "standing_consent" && termsDecision.basis.group === "terms-of-use"
      && termsDecision.basis.statement === TERMS_LABEL, `terms decision: ${JSON.stringify(termsDecision && { action: termsDecision.action, basis: termsDecision.basis })}`);
    check(plan.pauses.length === 0, `pauses: ${plan.pauses.map((pause) => pause.label).join(" | ")}`);

    // Filling.
    const applied = await applyDecisions(page, form, plan.decisions);
    check(applied.unfilled.length === 0, `unfilled: ${applied.unfilled.map((entry) => `${entry.fieldId}: ${entry.reason}`).join(" | ")}`);
    const filled = await state();
    check(filled.checked.length === 1 && filled.checked[0] === "I agree and consent", `checked: ${filled.checked.length}`);
    for (const [id, expected] of Object.entries(EXPECTED)) {
      check(JSON.stringify(filled.selects[id]) === JSON.stringify(expected), `${id} was not filled with its fixture option`);
    }
    const chips = await tab.locator('[class*="multi-value__label"]').allInnerTexts();
    check(chips.length === 3, `chips shown: ${chips.length}`);
    check(await menusOpen() === 0, "a list menu was left open after filling");

    // Choosing an already-chosen multi option again keeps it and clicks nothing.
    const gender = byId("question_7002");
    if (gender) {
      let again: unknown = null;
      await page.chooseOption(gender, "Non-binary").catch((error: unknown) => { again = error; });
      check(again === null, "choosing a chosen option again threw");
      const after = await state();
      check(JSON.stringify(after.selects.question_7002) === JSON.stringify(["Non-binary"]), "choosing a chosen option again changed the list");
      check(await menusOpen() === 0, "choosing a chosen option again left its menu open");
    }
    await context.close();
  } finally {
    await browser.close();
    if (basename(temp).startsWith(PREFIX)) rmSync(temp, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`GREENHOUSE_DEMOGRAPHICS_REPORT {"status":"failed","failures":${JSON.stringify(failures)}}`);
    process.exit(1);
  }
  console.log(`GREENHOUSE_DEMOGRAPHICS_REPORT {"status":"passed","scenarios":6}`);
}

main().catch((error) => {
  console.error(`GREENHOUSE_DEMOGRAPHICS_REPORT {"status":"failed","failures":${JSON.stringify([error instanceof Error ? error.message : String(error)])}}`);
  process.exit(1);
});
