import { describe, expect, it } from "vitest";

import {
  matchSelfIdentificationOption,
  planAutofill,
  selfIdentificationCategory,
  type FieldResolution
} from "@internship-agent/browser";
import type { BrowserField, SelfIdentificationAnswers } from "@internship-agent/domain";

// Each case saves one answer at a time: these are option-table checks, not a candidate.
function field(label: string, options: string[] | undefined, kind: BrowserField["kind"] = "select"): BrowserField {
  return { id: label.toLowerCase().replace(/\W+/g, "-"), label, kind, required: true, ...(options ? { options } : {}) };
}
const pick = (target: BrowserField, answers: SelfIdentificationAnswers) => matchSelfIdentificationOption(target, answers)?.option ?? null;

const greenhouseGender = field("Gender", ["Male", "Female", "Decline To Self Identify"]);
const ashbyGender = field("What is your gender?", ["Man", "Woman", "Non-binary", "I don't wish to answer"]);
const greenhouseHispanic = field("Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"]);
const greenhouseRace = field("Race", [
  "American Indian or Alaskan Native", "Asian", "Black or African American", "Hispanic or Latino", "White",
  "Native Hawaiian or Other Pacific Islander", "Two or More Races", "Decline To Self Identify"
]);
const leverRace = field("Race/Ethnicity", [
  "Hispanic or Latino", "White (Not Hispanic or Latino)", "Black or African American (Not Hispanic or Latino)",
  "Asian (Not Hispanic or Latino)", "Two or More Races (Not Hispanic or Latino)", "Decline to self-identify"
]);
const greenhouseVeteran = field("Veteran Status", [
  "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I don't wish to answer"
]);
const workdayVeteran = field("Please select the veteran status which most accurately describes your status", [
  "I am not a veteran", "I identify as a veteran, just not a protected veteran",
  "I identify as one or more of the classifications of protected veteran", "I do not wish to answer"
]);
const yesNoVeteran = field("Are you a protected veteran?", ["Yes", "No", "Decline to answer"]);
const disability = field("Disability Status", [
  "Yes, I have a disability (or previously had a disability)", "No, I do not have a disability", "I do not want to answer"
], "radio");

describe("voluntary self-identification option matching", () => {
  it("names one category per EEO question", () => {
    expect(selfIdentificationCategory(greenhouseGender)).toBe("gender");
    expect(selfIdentificationCategory(greenhouseHispanic)).toBe("hispanic");
    expect(selfIdentificationCategory(greenhouseRace)).toBe("race");
    expect(selfIdentificationCategory(leverRace)).toBe("race");
    expect(selfIdentificationCategory(workdayVeteran)).toBe("veteran");
    expect(selfIdentificationCategory(disability)).toBe("disability");
  });

  it("matches gender options", () => {
    expect(pick(greenhouseGender, { eeo_gender: "male" })).toBe("Male");
    expect(pick(greenhouseGender, { eeo_gender: "female" })).toBe("Female");
    expect(pick(greenhouseGender, { eeo_gender: "non_binary" })).toBeNull();
    expect(pick(ashbyGender, { eeo_gender: "male" })).toBe("Man");
    expect(pick(ashbyGender, { eeo_gender: "female" })).toBe("Woman");
    expect(pick(ashbyGender, { eeo_gender: "non_binary" })).toBe("Non-binary");
  });

  it("answers the Hispanic/Latino yes-no question from the saved race or ethnicity", () => {
    expect(pick(greenhouseHispanic, { eeo_race_ethnicity: "hispanic_or_latino" })).toBe("Yes");
    expect(pick(greenhouseHispanic, { eeo_race_ethnicity: "asian" })).toBe("No");
    expect(pick(greenhouseHispanic, { eeo_race_ethnicity: "white" })).toBe("No");
  });

  it("matches every race category on a Greenhouse list", () => {
    const expected: Record<string, string> = {
      hispanic_or_latino: "Hispanic or Latino",
      white: "White",
      black_or_african_american: "Black or African American",
      asian: "Asian",
      american_indian_or_alaska_native: "American Indian or Alaskan Native",
      native_hawaiian_or_pacific_islander: "Native Hawaiian or Other Pacific Islander",
      two_or_more_races: "Two or More Races"
    };
    for (const [value, option] of Object.entries(expected)) {
      expect(pick(greenhouseRace, { eeo_race_ethnicity: value }), value).toBe(option);
    }
  });

  it("never reads a Lever “(Not Hispanic or Latino)” option as Hispanic or Latino", () => {
    expect(pick(leverRace, { eeo_race_ethnicity: "hispanic_or_latino" })).toBe("Hispanic or Latino");
    expect(pick(leverRace, { eeo_race_ethnicity: "white" })).toBe("White (Not Hispanic or Latino)");
    expect(pick(leverRace, { eeo_race_ethnicity: "asian" })).toBe("Asian (Not Hispanic or Latino)");
    expect(pick(leverRace, { eeo_race_ethnicity: "two_or_more_races" })).toBe("Two or More Races (Not Hispanic or Latino)");
  });

  it("matches veteran status on Greenhouse, Workday, and yes-no forms", () => {
    expect(pick(greenhouseVeteran, { eeo_veteran_status: "not_veteran" })).toBe("I am not a protected veteran");
    expect(pick(greenhouseVeteran, { eeo_veteran_status: "veteran_not_protected" })).toBe("I am not a protected veteran");
    expect(pick(greenhouseVeteran, { eeo_veteran_status: "protected_veteran" })).toBe("I identify as one or more of the classifications of protected veteran");
    expect(pick(workdayVeteran, { eeo_veteran_status: "not_veteran" })).toBe("I am not a veteran");
    expect(pick(workdayVeteran, { eeo_veteran_status: "veteran_not_protected" })).toBe("I identify as a veteran, just not a protected veteran");
    expect(pick(workdayVeteran, { eeo_veteran_status: "protected_veteran" })).toBe("I identify as one or more of the classifications of protected veteran");
    expect(pick(yesNoVeteran, { eeo_veteran_status: "not_veteran" })).toBe("No");
    expect(pick(yesNoVeteran, { eeo_veteran_status: "veteran_not_protected" })).toBe("No");
    expect(pick(yesNoVeteran, { eeo_veteran_status: "protected_veteran" })).toBe("Yes");
  });

  it("matches the CC-305 disability answers", () => {
    expect(pick(disability, { eeo_disability_status: "has_disability" })).toBe("Yes, I have a disability (or previously had a disability)");
    expect(pick(disability, { eeo_disability_status: "no_disability" })).toBe("No, I do not have a disability");
  });

  it("holds when the question is not a voluntary single-category select or radio", () => {
    expect(pick(field("Gender", ["Male", "Female"]), { eeo_gender: "female" })).toBeNull();
    expect(pick(field("Gender", undefined, "text"), { eeo_gender: "female" })).toBeNull();
    expect(pick(field("Gender", undefined, "textarea"), { eeo_gender: "female" })).toBeNull();
    expect(pick(field("Disability", ["Yes", "No", "I do not want to answer"], "checkbox"), { eeo_disability_status: "has_disability" })).toBeNull();
    expect(pick(field("Gender and veteran status", ["Female", "Male", "Decline to answer"]), { eeo_gender: "female" })).toBeNull();
    expect(pick(field("Gender", ["Female", "F", "Decline to answer"]), { eeo_gender: "female" })).toBeNull();
    for (const label of ["Gender pronouns", "Sexual orientation", "Do you identify as transgender?", "Do you need a disability accommodation?", "Sex assigned at birth"]) {
      const target = field(label, ["Yes", "No", "Female", "Decline to answer"]);
      expect(pick(target, { eeo_gender: "female", eeo_disability_status: "has_disability" }), label).toBeNull();
    }
    expect(pick(greenhouseGender, {})).toBeNull();
    expect(pick(greenhouseGender, { eeo_race_ethnicity: "asian" })).toBeNull();
    expect(pick(greenhouseGender, { eeo_gender: "unknown_value" })).toBeNull();
  });

  it("answers Greenhouse's \"How would you describe your …? (mark all that apply)\" lists with the one matching option", () => {
    const decline = ["I prefer to self-describe", "I don't wish to answer"];
    const gender = field("How would you describe your gender identity? (mark all that apply)", ["Man", "Non-binary", "Woman", ...decline]);
    const race = field("How would you describe your racial/ethnic background? (mark all that apply)", [
      "Black or of African descent", "East Asian", "Hispanic, Latinx or of Spanish Origin", "Indigenous, American Indian or Alaska Native",
      "Middle Eastern or North African", "Native Hawaiian or Pacific Islander", "South Asian", "Southeast Asian", "White or European", ...decline
    ]);
    expect(selfIdentificationCategory(gender)).toBe("gender");
    expect(selfIdentificationCategory(race)).toBe("race");
    expect(pick(gender, { eeo_gender: "male" })).toBe("Man");
    expect(pick(race, { eeo_race_ethnicity: "white" })).toBe("White or European");
    expect(pick(race, { eeo_race_ethnicity: "hispanic_or_latino" })).toBe("Hispanic, Latinx or of Spanish Origin");
    // "East Asian", "South Asian", and "Southeast Asian" are several or none: no single match.
    expect(pick(race, { eeo_race_ethnicity: "asian" })).toBeNull();
    const orientation = field("How would you describe your sexual orientation? (mark all that apply)", ["Heterosexual", "Gay", ...decline]);
    const transgender = field("Do you identify as transgender?", ["Yes", "No", ...decline]);
    expect(pick(orientation, { eeo_gender: "male" })).toBeNull();
    expect(pick(transgender, { eeo_gender: "male" })).toBeNull();
    // An open "Describe your …" prompt is still not the self-identification itself.
    expect(pick(field("Describe your gender identity", ["Man", "Woman", "I don't wish to answer"]), { eeo_gender: "male" })).toBeNull();
  });
});

function plan(fields: BrowserField[], resolutions: Array<[string, FieldResolution]>) {
  return planAutofill({ url: "https://example.test/apply", title: "Apply", fields }, {
    profile: {},
    resolutions: new Map(resolutions),
    packageAnswers: [],
    variantId: null
  });
}

describe("planning saved self-identification and saved answers", () => {
  it("chooses a matched EEO option with a fact basis and a reason that never names the answer", () => {
    const result = plan([greenhouseGender], [[greenhouseGender.id, { status: "SELF_IDENTIFIED", key: "eeo_gender", option: "Female" }]]);
    expect(result.pauses).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ action: "choose", value: "Female", basis: { kind: "fact", key: "eeo_gender", scope: "global" } });
    expect(result.decisions[0]!.reason).not.toMatch(/female/i);
  });

  it("pauses an EEO question whose saved option is not offered, or with no saved answer", () => {
    const stale = plan([greenhouseGender], [[greenhouseGender.id, { status: "SELF_IDENTIFIED", key: "eeo_gender", option: "Woman" }]]);
    expect(stale.decisions[0]).toMatchObject({ action: "pause" });
    expect(stale.pauses[0]).toMatchObject({ sensitive: true });
    const none = plan([greenhouseGender], [[greenhouseGender.id, { status: "UNAVAILABLE" }]]);
    expect(none.decisions[0]).toMatchObject({ action: "pause" });
    expect(none.pauses[0]).toMatchObject({ sensitive: true });
  });

  const heard = (display: string): FieldResolution => ({ status: "RESOLVED", key: "how_heard", scope: "global", display, value: display });

  it("chooses the saved how-heard answer verbatim when offered, else LinkedIn", () => {
    const offered = field("How did you hear about us?", ["Employee Referral", "Job Board", "Online Job Board", "LinkedIn"]);
    expect(plan([offered], [[offered.id, heard("Online job board")]]).decisions[0]).toMatchObject({
      action: "choose", value: "Online Job Board", basis: { kind: "fact", key: "how_heard" }
    });
    const linkedin = field("How did you hear about us?", ["Employee Referral", "LinkedIn", "Indeed"]);
    expect(plan([linkedin], [[linkedin.id, heard("Online job board")]]).decisions[0]).toMatchObject({
      action: "choose", value: "LinkedIn", basis: { kind: "fact", key: "how_heard" }
    });
  });

  it("writes the saved how-heard text into a free-text field and keeps a Workday pick", () => {
    const text = field("How did you hear about this job?", undefined, "text");
    expect(plan([text], [[text.id, heard("Online job board")]]).decisions[0]).toMatchObject({ action: "fill", value: "Online job board" });
    const shown: BrowserField = { ...field("How Did You Hear About Us?", undefined), currentValue: "Job Board" };
    expect(plan([shown], [[shown.id, heard("Online job board")]]).decisions[0]).toMatchObject({ action: "keep", value: "Job Board" });
  });

  it("matches saved pronouns to a longer option and fills free text", () => {
    const pronouns: FieldResolution = { status: "RESOLVED", key: "pronouns", scope: "global", display: "he/him", value: "he/him" };
    const select = field("Pronouns", ["She/Her", "He/Him/His", "They/Them"]);
    expect(plan([select], [[select.id, pronouns]]).decisions[0]).toMatchObject({ action: "choose", value: "He/Him/His", basis: { kind: "fact", key: "pronouns" } });
    const text = field("What are your pronouns?", undefined, "text");
    expect(plan([text], [[text.id, pronouns]]).decisions[0]).toMatchObject({ action: "fill", value: "he/him" });
  });
});
