import { describe, expect, it } from "vitest";

import { DeterministicQuestionMapper } from "@internship-agent/agent";
import { planAutofill, recognizeForm, type RawControl } from "@internship-agent/browser";
import type { QuestionContext } from "@internship-agent/domain";

/**
 * Track 83 regression corpus (2026-11-28): wordings, option lists, and form shapes of real held runs, with company
 * and place names replaced by fictional ones; every candidate value here is fictional. The mapper rows pin which
 * saved fact a held relocation or start-date question maps to; the planner rows pin Ashby's education dates, its
 * "Still Student?" box, and the type-ahead texts typed for a state code and a field of study.
 */

const mapper = new DeterministicQuestionMapper();
const US: QuestionContext = { postingCountryCode: "US", companyName: "Fixture Co" };
const FIXTURE_CITY: QuestionContext = { postingCountryCode: "US", postingPlaces: [{ city: "Fixture City", countryCode: "US" }] };

describe("held-question corpus: relocation and start-date mapping (Track 83)", () => {
  it("reads the destination before a conditional tail", async () => {
    const mapped = await mapper.map("If this position is located in Fixture City, CO as Hybrid, are you willing to relocate to Fixture City if you are not already local?", FIXTURE_CITY);
    expect(mapped).toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "location" }, broader: true });
    expect(mapped.status === "MAPPED" && mapped.scope.kind === "location" ? mapped.scope.name.toLowerCase() : null).toBe("fixture city");
  });

  it("reads \"do so\", \"any of the locations below\" and \"state/cities where\" as no place", async () => {
    expect(await mapper.map("Are you able to work onsite in the Fixture Co location of this job posting, or relocate to do so?", US))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" } });
    expect(await mapper.map("Are you able to relocate to any of the locations below following the end of the internship, at Fixture's discretion?", US))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" }, broader: true });
    expect(await mapper.map("Will you be willing to commute/drive or temporarily relocate to state/cities where there is a Fixture Co office in your region during the program?NOTE: Fixture Co does not provide relocation support or housing.", US))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" } });
  });

  it("reads a note that the employer pays nothing as the own-expense question", async () => {
    expect(await mapper.map("At this time we do not offer relocation assistance to interns. If hired, are you able to relocate on your own if you are not based locally?", US))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" } });
    expect(await mapper.map("Are you able to work onsite at the location specified during the role's duration? Please note that, while this role is paid, a separate relocation stipend will not be provided.", US))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" }, broader: true });
  });

  it("never reads full-time availability after graduation as the internship start date", async () => {
    for (const question of [
      "Our internships may lead to a full-time role. If you were to receive a full-time offer, when would you be available to start?",
      "I am available to begin a potential full-time role in 2028 / before September 2028."
    ]) {
      const mapped = await mapper.map(question, US);
      expect(mapped.status === "MAPPED" ? mapped.key : mapped.status, question).not.toBe("available_start_date");
    }
    expect(await mapper.map("When can you start?", US)).toMatchObject({ status: "MAPPED", key: "available_start_date" });
    expect(await mapper.map("What is your available start date?", US)).toMatchObject({ status: "MAPPED", key: "available_start_date" });
  });
});

const TODAY = "2026-11-27";
const PROFILE = { fullName: "Avery Example", addressRegion: "CA", fieldOfStudy: "Computer Science" };
const education = (graduation: string) => ({
  school: "Example State University", degree: "B.A. Computer Science", startMonth: "2024-08",
  graduation: { date: graduation, basis: { kind: "fact", key: "graduation_date", scope: "global" } as const }
});
const MONTHS = ["Month...", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const years = (from: number, to: number) => ["Year...", ...Array.from({ length: from - to + 1 }, (_, index) => String(from - index))];
const list = (ref: string, label: string, options: string[]): RawControl => ({ tag: "select", ref, id: ref, label, required: true, options });
const STILL_STUDENT: RawControl = { tag: "input", type: "checkbox", id: "_systemfield_education_history-isCurrent", label: "Still Student?", required: false };

/** An Ashby education history entry as the executor reads it; `endYears` is the End Date year list. */
function ashbyEducation(endYears: string[], stillStudent: boolean): RawControl[] {
  return [
    list("ia-control-1", "Education Start Date month", MONTHS),
    list("ia-control-2", "Education Start Date year", years(2027, 1950)),
    list("ia-control-3", "Education End Date month", MONTHS),
    list("ia-control-4", "Education End Date year", endYears),
    ...(stillStudent ? [STILL_STUDENT] : [])
  ];
}

function plan(controls: RawControl[], graduation = "2028-05-15") {
  const form = recognizeForm("https://jobs.ashbyhq.com/fixture/00000000-0000-4000-8000-000000000083/application", "Apply", controls);
  const result = planAutofill(form, {
    profile: PROFILE,
    resolutions: new Map(),
    packageAnswers: [],
    variantId: null,
    education: education(graduation),
    standing: { acceptDataConsent: true, signAttestations: true, today: TODAY }
  });
  const byLabel = new Map(form.fields.map((field, index) => [field.label, result.decisions[index]!]));
  return (label: string) => byLabel.get(label) ?? null;
}

describe("held-question corpus: Ashby education history (Track 83)", () => {
  it("chooses the start month and year from the profile", () => {
    const decision = plan(ashbyEducation(years(2027, 1950), true));
    expect(decision("Education Start Date month")).toMatchObject({ action: "choose", value: "August" });
    expect(decision("Education Start Date year")).toMatchObject({ action: "choose", value: "2024" });
  });

  it("leaves the end date empty, month and year, and ticks Still Student? when the year list stops before graduation", () => {
    const decision = plan(ashbyEducation(years(2027, 1950), true));
    expect(decision("Education End Date month")).toMatchObject({ action: "skip" });
    expect(decision("Education End Date year")).toMatchObject({ action: "skip" });
    // The education rule ticks it, not a consent or attestation rule.
    expect(decision("Still Student?")).toMatchObject({ action: "check", value: "true", reason: "Your graduation date is still ahead, so you are still a student." });
  });

  it("chooses the end month and year when the year list has the graduation year", () => {
    const decision = plan(ashbyEducation(years(2031, 1950), true));
    expect(decision("Education End Date month")).toMatchObject({ action: "choose", value: "May" });
    expect(decision("Education End Date year")).toMatchObject({ action: "choose", value: "2028" });
  });

  it("pauses the end year without a Still Student? box, and leaves Still Student? to the usual rules after graduation", () => {
    expect(plan(ashbyEducation(years(2027, 1950), false))("Education End Date year")).toMatchObject({ action: "pause" });
    const graduated = plan([STILL_STUDENT], "2026-05-15");
    expect(graduated("Still Student?")?.action).not.toBe("check");
  });
});

describe("held-question corpus: type-ahead texts (Track 83)", () => {
  it("types the state's name for a two-letter state code, and the code in a State Abbreviation box", () => {
    const decision = plan([
      { tag: "input", type: "text", widget: "autocomplete", id: "state", label: "Which state do you currently reside in?", required: true },
      { tag: "input", type: "text", widget: "autocomplete", id: "abbreviation", label: "State Abbreviation", required: true }
    ]);
    expect(decision("Which state do you currently reside in?")).toMatchObject({ action: "choose", value: "California" });
    expect(decision("State Abbreviation")).toMatchObject({ action: "choose", value: "CA" });
  });

  it("types the listed category naming the field of study", () => {
    const options = ["Business", "Engineering - Computer Science / Software", "Engineering - Electrical", "Mathematics"];
    const decision = plan([{ tag: "input", type: "text", widget: "autocomplete", id: "discipline--0", label: "Discipline", required: true, options }]);
    expect(decision("Discipline")).toMatchObject({ action: "choose", value: "Engineering - Computer Science / Software" });
    const unread = plan([{ tag: "input", type: "text", widget: "autocomplete", id: "discipline--0", label: "Discipline", required: true }]);
    expect(unread("Discipline")).toMatchObject({ action: "choose", value: "Computer Science" });
  });
});

// Round 2 (2026-11-28): full-time availability, county, clearance lists, the ACT "did not take" option, and address
// labels. Wordings and option shapes are captured from held runs; company names, places, and dates are fictional.
const keyOf = async (question: string, context: QuestionContext = US) => {
  const mapped = await mapper.map(question, context);
  return mapped.status === "MAPPED" ? mapped.key : mapped.status;
};

describe("held-question corpus: full-time availability and county (Track 83, round 2)", () => {
  it("maps full-time work availability for the internship window", async () => {
    for (const question of [
      "Are you able to commit to a full-time internship (40 hours per week) from May 24, 2031 - August 13, 2031?",
      "Are you available to work full-time (40 hours per week) between June 7, 2031 - August 13, 2031?",
      "Are you available for a 12-week full-time (40 hours per week) internship during your select term(s)?",
      "Are you available to work full time?"
    ]) {
      expect(await keyOf(question), question).toBe("available_full_time");
    }
    expect(await mapper.map("Are you able to commit to a full-time internship (40 hours per week) from May 24, 2031 - August 13, 2031?", US))
      .toMatchObject({ status: "MAPPED", key: "available_full_time", broader: true });
    expect(await mapper.map("Are you available to work full time?", US)).not.toHaveProperty("broader");
  });

  it("never maps a later full-time role, a fall start, or a student status to it", async () => {
    for (const question of [
      "Are you a Senior? Will you be able to work full time starting in the fall?",
      "Are you open to starting full-time immediately after your internship? If so, when?",
      "If offered a full-time role upon completion of your degree, would you accept?",
      "If you were to receive a full-time offer, when would you be available to start?",
      "Would you consider full-time work after graduation?",
      "Are you able to work full-time on-site at our Fixture City office?",
      "Are you a full-time student?"
    ]) {
      expect(await keyOf(question), question).not.toBe("available_full_time");
    }
    expect(await keyOf("Are you a full-time student?")).toBe("enrolled_full_time");
  });

  it("maps a County label to the county fact, never a county of birth", async () => {
    for (const question of ["County", "County*", "What county do you live in?", "County:"]) {
      expect(await keyOf(question), question).toBe("county");
    }
    expect(await keyOf("County of birth")).not.toBe("county");
  });
});

describe("held-question corpus: clearance wordings (Track 83, round 2)", () => {
  it("maps a which-clearance list to holding a clearance, and holds the same wording as a text box", async () => {
    const question = "What type of Clearance do you Currently have?";
    expect(await keyOf(question, { ...US, fieldKind: "select" })).toBe("holds_security_clearance");
    expect(await keyOf(question, { ...US, fieldKind: "text" })).toBe("AMBIGUOUS");
  });

  it("reads a citizenship requirement note as part of an eligibility question", async () => {
    expect(await keyOf("Are you eligible to obtain and maintain a U.S. Government Clearance (Requires U.S Citizenship)?", { ...US, fieldKind: "select" }))
      .toBe("security_clearance_eligible");
    expect(await keyOf("If your position requires a security clearance, are you able to provide proof of U.S. Citizenship?", { ...US, fieldKind: "select" }))
      .toBe("AMBIGUOUS");
    expect(await keyOf("What is your current or most recent security clearance status?", { ...US, fieldKind: "select" }))
      .not.toBe("holds_security_clearance");
  });
});

type Resolution = { status: "RESOLVED"; key: string; scope: string; display: string; value: boolean | string };
const resolved = (key: string, value: boolean | string): Resolution => ({ status: "RESOLVED", key, scope: "global", display: typeof value === "boolean" ? (value ? "Yes" : "No") : value, value });

function planWith(controls: RawControl[], byLabel: Record<string, Resolution>, profile: Record<string, string> = PROFILE) {
  const form = recognizeForm("https://boards.greenhouse.io/fixture/jobs/8300000", "Apply", controls);
  const resolutions = new Map(form.fields.filter((field) => byLabel[field.label]).map((field) => [field.id, byLabel[field.label]!]));
  const result = planAutofill(form, { profile, resolutions, packageAnswers: [], variantId: null, standing: { acceptDataConsent: true, signAttestations: true, today: TODAY } });
  const decisions = new Map(form.fields.map((field, index) => [field.label, result.decisions[index]!]));
  return (label: string) => decisions.get(label) ?? null;
}
const text = (id: string, label: string): RawControl => ({ tag: "input", type: "text", id, label, required: true });
const group = (id: string, label: string, options: string[]): RawControl => ({ tag: "input", type: "checkbox", widget: "checkbox-group", id, label, required: true, options });

describe("held-question corpus: option rules in the planner (Track 83, round 2)", () => {
  it("chooses the did-not-take ACT option for a saved No, and pauses a score box", () => {
    const listed = planWith([list("act", "ACT Score", ["Select...", "Did not take/Do not recall", "36 out of 36", "35 out of 36"])], { "ACT Score": resolved("act_taken", false) });
    expect(listed("ACT Score")).toMatchObject({ action: "choose", value: "Did not take/Do not recall" });
    const typed = planWith([text("act", "ACT Score")], { "ACT Score": resolved("act_taken", false) });
    expect(typed("ACT Score")).toMatchObject({ action: "pause" });
  });

  it("chooses the did-not-take option of an ACT checkbox group for a saved No, never a literal No (round 3)", () => {
    const decision = planWith([group("act", "ACT Score", ["No", "Did not take", "36"])], { "ACT Score": resolved("act_taken", false) });
    expect(decision("ACT Score")).toMatchObject({ action: "choose", value: "Did not take" });
  });

  it("pauses a Yes/No ACT checkbox group for a saved No instead of choosing No (round 3)", () => {
    const decision = planWith([group("act", "ACT Score", ["Yes", "No"])], { "ACT Score": resolved("act_taken", false) });
    expect(decision("ACT Score")).toMatchObject({ action: "pause" });
    expect(decision("ACT Score")).not.toMatchObject({ value: "No" });
  });

  it("chooses the county option with the profile's state", () => {
    const decision = planWith([list("county", "County", ["Ada, ID", "Fixture, CA", "Fixture, WY"])], { County: resolved("county", "Fixture County") });
    expect(decision("County")).toMatchObject({ action: "choose", value: "Fixture, CA" });
  });

  it("chooses the plain none option of a clearance-level list for a saved No", () => {
    const decision = planWith([list("clearance", "Security Clearance - Active", ["Confidential", "Public Trust", "Secret", "Top Secret", "TS/SCI", "None of the Above"])],
      { "Security Clearance - Active": resolved("holds_security_clearance", false) });
    expect(decision("Security Clearance - Active")).toMatchObject({ action: "choose", value: "None of the Above" });
  });
});

const ADDRESS = { ...PROFILE, addressLine1: "100 Fixture Way", addressCity: "Fixture City", addressRegion: "CA", addressPostalCode: "90000", addressCountry: "United States" };

describe("held-question corpus: address labels (Track 83, round 2)", () => {
  it("types the street line into a bare Mailing Address box when the form asks city and ZIP", () => {
    const decision = planWith([text("address", "Mailing Address"), text("city", "City"), text("zip", "ZIP Code")], {}, ADDRESS);
    expect(decision("Mailing Address")).toMatchObject({ action: "fill", value: "100 Fixture Way", basis: { kind: "profile", field: "addressLine1" } });
    expect(planWith([text("address", "Mailing Address")], {}, ADDRESS)("Mailing Address")).toMatchObject({ action: "pause" });
  });

  it("types the whole address on one line where it is asked whole, only with every part on the profile", () => {
    const area = planWith([{ tag: "textarea", id: "home", label: "Home Address", required: true }], {}, ADDRESS);
    expect(area("Home Address")).toMatchObject({ action: "fill", value: "100 Fixture Way, Fixture City, CA 90000", basis: { kind: "profile", field: "address" } });
    const { addressPostalCode: _postal, ...noPostal } = ADDRESS;
    expect(planWith([text("full", "Full address")], {}, noPostal)("Full address")).toMatchObject({ action: "pause" });
  });

  it("keeps the street-address rule and leaves type-ahead address boxes alone", () => {
    expect(planWith([text("street", "Mailing Street Address")], {}, ADDRESS)("Mailing Street Address"))
      .toMatchObject({ action: "fill", value: "100 Fixture Way", reason: "Contact details from your profile." });
    const typeAhead = planWith([{ tag: "input", type: "text", widget: "autocomplete", id: "address", label: "Address", required: true }], {}, ADDRESS);
    expect(typeAhead("Address")).not.toMatchObject({ reason: "The address on your profile, on one line." });
  });
});

// Merge round (2026-11-28): Track 82's self-identification gate comes before every Track 83 option rule, so a
// protected self-identification checkbox group with no saved answer is never chosen. The options are fictional.
describe("held-question corpus: self-identification groups stay with the candidate (Track 83, merge round)", () => {
  it("never chooses an option of an ethnicity checkbox group without a saved answer", () => {
    const label = "Which ethnicity(ies) do you identify with?";
    const decision = planWith([group("ia-control-9", label, ["Fixture Option A", "Fixture Option B", "I prefer not to answer"])], {});
    expect(decision(label)).not.toBeNull();
    expect(decision(label)?.action).not.toBe("choose");
  });
});
