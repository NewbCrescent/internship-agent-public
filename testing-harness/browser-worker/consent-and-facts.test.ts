import { describe, expect, it } from "vitest";

import type { BrowserField, RecognizedForm } from "@internship-agent/domain";
import { planAutofill, unfilledPause, type ContactProfile, type FieldResolution, type StandingInputs } from "@internship-agent/browser";

/**
 * Terms consent and the 2026-11-24 fact-option rules in the planner. Fictional
 * labels, places, and dates; Fixture Robotics is not a real employer.
 */
const DATA_ON: StandingInputs = { acceptDataConsent: true, signAttestations: false, today: "2026-11-24" };
const ALL_OFF: StandingInputs = { acceptDataConsent: false, signAttestations: false, today: "2026-11-24" };
const TERMS = "By checking this box, I accept the Terms of Use of the Fixture Robotics career site";

const form = (...fields: BrowserField[]): RecognizedForm => ({ url: "https://job-boards.greenhouse.io/fixturerobotics/jobs/7000001", title: "Apply", fields });
const box = (id: string, label: string, required = true): BrowserField => ({ id, label, kind: "checkbox", required });
const list = (id: string, label: string, options: string[], extra: Partial<BrowserField> = {}): BrowserField =>
  ({ id, label, kind: "select", required: true, options, ...extra });
const resolved = (key: string, value: boolean | string, display: string, scope = "global"): FieldResolution => ({ status: "RESOLVED", key, scope, display, value });

function decide(
  field: BrowserField,
  options: { standing?: StandingInputs; resolution?: FieldResolution; profile?: ContactProfile; postingLocations?: string[] } = {}
) {
  const result = planAutofill(form(field), {
    profile: options.profile ?? {},
    resolutions: new Map(options.resolution ? [[field.id, options.resolution]] : []),
    packageAnswers: [],
    variantId: null,
    standing: options.standing,
    ...(options.postingLocations ? { postingLocations: options.postingLocations } : {})
  });
  return { decision: result.decisions[0]!, pauses: result.pauses };
}

describe("terms consent under the standing data-consent setting", () => {
  it("checks a required terms box with its exact statement, and pauses without the setting", () => {
    expect(decide(box("terms", TERMS), { standing: DATA_ON }).decision).toMatchObject({
      action: "check", value: "true",
      basis: { kind: "standing_consent", setting: "accept_data_consent", group: "terms-of-use", statement: TERMS }
    });
    for (const standing of [undefined, ALL_OFF]) {
      const { decision, pauses } = decide(box("terms", TERMS), { standing });
      expect(decision.action).toBe("pause");
      expect(pauses.map((pause) => pause.fieldId)).toEqual(["terms"]);
    }
  });

  it("leaves an optional terms box unchecked: terms are accepted only as a condition of applying", () => {
    expect(decide(box("terms", TERMS, false), { standing: DATA_ON }).decision).toMatchObject({ action: "skip", value: null, basis: null });
  });

  it("chooses Yes on a required terms list, and never on an optional one", () => {
    const required = list("terms-list", "Do you agree to the Terms and Conditions?", ["Yes", "No"]);
    expect(decide(required, { standing: DATA_ON }).decision).toMatchObject({
      action: "choose", value: "Yes", basis: { kind: "standing_consent", group: "terms-of-use" }
    });
    const optional = { ...required, required: false };
    expect(decide(optional, { standing: DATA_ON }).decision.action).not.toBe("choose");
  });

  it("never checks a terms box that bundles marketing", () => {
    const bundled = "I agree to the Terms and Conditions and to receive marketing emails and job alerts";
    expect(decide(box("bundle", bundled), { standing: DATA_ON }).decision.action).toBe("pause");
    expect(decide(box("bundle", bundled, false), { standing: DATA_ON }).decision).toMatchObject({ action: "skip", basis: null });
  });

  it("leaves a terms box that also asks about texts to the text-message rule", () => {
    const application = decide(box("texts", "I agree to the Terms of Use and consent to texting about my application."), { standing: DATA_ON }).decision;
    expect(application.basis?.kind).not.toBe("standing_consent");
    expect(application.reason).toMatch(/^Your text-message rule/);
    const marketing = decide(box("alerts", "I agree to the Terms of Use and to receive texts about new job openings."), { standing: DATA_ON }).decision;
    expect(["pause", "skip"]).toContain(marketing.action);
    expect(marketing.basis?.kind).not.toBe("standing_consent");
  });
});

describe("saved facts that pick an offered option", () => {
  const RULE = resolved("salary_expectation_rule", "posting_pay_hourly", "posting_pay_hourly");
  const salary = list("salary", "If posted, are you comfortable with the advertised salary range?", ["Agree", "Disagree"]);

  it("agrees with the advertised range from the salary rule, and never echoes or suggests the rule", () => {
    expect(decide(salary, { resolution: RULE }).decision).toMatchObject({
      action: "choose", value: "Agree", basis: { kind: "fact", key: "salary_expectation_rule", scope: "global" }
    });
    const typeAhead = { ...salary, widget: "autocomplete" as const, options: [] };
    const held = decide(typeAhead, { resolution: RULE });
    expect(held.decision.action).toBe("pause");
    expect(JSON.stringify(held)).not.toContain("posting_pay_hourly");
    const unclear = decide(list("salary2", "Are you comfortable with the posted pay range?", ["Maybe", "Unsure"]), { resolution: RULE });
    expect(unclear.decision.action).toBe("pause");
    expect(JSON.stringify(unclear)).not.toContain("posting_pay_hourly");
  });

  const relocation = list("relocate", "Are you located in or near to the city of the advertised role? If not, are you willing to relocate at your own expense?", [
    "Yes, I am located in or near the city", "Yes, I am willing to relocate at my own expense", "No"
  ]);
  const OWN = resolved("willing_to_relocate_at_own_expense", true, "Yes", "country:US");
  const HOME: ContactProfile = { addressCity: "Fixture City", addressRegion: "CA" };

  it("picks the own-expense option away from the posting's place, and the located option only at its one place", () => {
    expect(decide(relocation, { resolution: OWN, profile: HOME, postingLocations: ["Testville, TX"] }).decision)
      .toMatchObject({ action: "choose", value: "Yes, I am willing to relocate at my own expense" });
    expect(decide(relocation, { resolution: OWN, profile: HOME, postingLocations: ["Fixture City, CA"] }).decision)
      .toMatchObject({ action: "choose", value: "Yes, I am located in or near the city", reason: "Your saved current location is the posting's location." });
    expect(decide(relocation, { resolution: OWN, profile: HOME, postingLocations: ["Fixture City, CA", "Testville, TX"] }).decision)
      .toMatchObject({ action: "choose", value: "Yes, I am willing to relocate at my own expense" });
    expect(decide(relocation, { resolution: OWN, profile: HOME }).decision)
      .toMatchObject({ action: "choose", value: "Yes, I am willing to relocate at my own expense" });
    expect(decide(relocation, { resolution: resolved("willing_to_relocate_at_own_expense", false, "No", "country:US"), profile: HOME, postingLocations: ["Testville, TX"] })
      .decision.action).toBe("pause");
  });

  const start = list("start", "If offered a position, how soon would you be available to start?", ["Immediately", "2 weeks", "2–4 weeks", "4–6 weeks", "6+ weeks"]);
  const DATE = resolved("available_start_date", "2027-05-15", "2027-05-15");

  it("picks the offer-relative start bucket from today and the available start date", () => {
    expect(decide(start, { resolution: DATE, standing: { acceptDataConsent: false, signAttestations: false, today: "2026-11-24" } }).decision)
      .toMatchObject({ action: "choose", value: "6+ weeks", basis: { kind: "fact", key: "available_start_date" } });
    expect(decide(start, { resolution: DATE }).decision.action).toBe("pause");
  });

  it("answers background-check willingness from its own fact", () => {
    const check = list("bg", "Are you willing to undergo a background check?", ["Yes, I am willing", "No"]);
    expect(decide(check, { resolution: resolved("willing_background_check", true, "Yes") }).decision)
      .toMatchObject({ action: "choose", value: "Yes, I am willing", basis: { kind: "fact", key: "willing_background_check" } });
  });
});

describe("a demographic field the page would not take", () => {
  it("stays sensitive in its pause", () => {
    const gender = list("question_7002", "How would you describe your gender identity? (mark all that apply)", ["Man", "Non-binary", "Woman", "I don't wish to answer"]);
    const held = unfilledPause(gender, "the page did not accept the value");
    expect(held.pause.sensitive).toBe(true);
    expect(held.pause.question).toContain(gender.label);
    expect(unfilledPause(list("q", "Preferred office", ["North", "South"]), "the page did not accept the value").pause.sensitive).toBe(false);
  });
});
