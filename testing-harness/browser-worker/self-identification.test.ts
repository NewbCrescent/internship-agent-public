import { describe, expect, it } from "vitest";

import {
  classifyFieldRole,
  isIdentityQuestion,
  matchSelfIdentificationOption,
  planAutofill,
  RACE_ONLY_DECLINE_REASON,
  selfIdentificationCategory,
  VETERAN_CLASSIFICATION_EMPTY_REASON,
  veteranClassificationLeftEmpty,
  type FieldResolution
} from "@internship-agent/browser";
import { SITE_VALUE_KEPT_REASON, UNCONFIRMED_SITE_VALUE_REASON, type BrowserField, type PauseRecord, type SelfIdentificationAnswers } from "@internship-agent/domain";

import { pauseReviewEligible } from "../../packages/agent/src/pause-recheck";

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
    expect(plan([shown], [[shown.id, heard("Online job board")]]).decisions[0]).toMatchObject({ action: "keep", value: "Job Board", reason: SITE_VALUE_KEPT_REASON });
  });

  it("marks a value the site already shows as unconfirmed only when a recognized question has no saved answer that settles it", () => {
    const country: BrowserField = { ...field("Country Phone Code", undefined), currentValue: "Fixtureland (+1)" };
    expect(plan([country], []).decisions[0]).toMatchObject({ action: "keep", value: "Fixtureland (+1)", reason: SITE_VALUE_KEPT_REASON });
    expect(plan([country], [[country.id, { status: "UNAVAILABLE" }]]).decisions[0]).toMatchObject({ action: "keep", reason: SITE_VALUE_KEPT_REASON });
    expect(plan([country], [[country.id, { status: "UNAVAILABLE", held: true }]]).decisions[0]).toMatchObject({ action: "keep", reason: UNCONFIRMED_SITE_VALUE_REASON });
    const group: BrowserField = { ...field("Which shifts can you work?", ["Days", "Nights"], "checkbox"), currentValue: "Days" };
    expect(plan([group], [[group.id, { status: "NEEDS_INPUT", key: "x", scope: "global" }]]).decisions[0])
      .toMatchObject({ action: "keep", reason: UNCONFIRMED_SITE_VALUE_REASON });
    // A saved answer that matches none of the options never lets the shown one through as settled.
    expect(plan([group], [[group.id, { status: "RESOLVED", key: "x", scope: "global", display: "Weekends", value: "Weekends" }]]).decisions[0])
      .toMatchObject({ action: "keep", reason: UNCONFIRMED_SITE_VALUE_REASON });
  });

  it("matches saved pronouns to a longer option and fills free text", () => {
    const pronouns: FieldResolution = { status: "RESOLVED", key: "pronouns", scope: "global", display: "he/him", value: "he/him" };
    const select = field("Pronouns", ["She/Her", "He/Him/His", "They/Them"]);
    expect(plan([select], [[select.id, pronouns]]).decisions[0]).toMatchObject({ action: "choose", value: "He/Him/His", basis: { kind: "fact", key: "pronouns" } });
    const text = field("What are your pronouns?", undefined, "text");
    expect(plan([text], [[text.id, pronouns]]).decisions[0]).toMatchObject({ action: "fill", value: "he/him" });
  });
});

describe("sexual orientation and transgender identity (2026-11-24)", () => {
  const decline = ["I prefer to self-describe", "I don't wish to answer"];
  const orientation = field("How would you describe your sexual orientation? (mark all that apply)", [
    "Asexual", "Bisexual and/or pansexual", "Gay", "Heterosexual", "Lesbian", "Queer", ...decline
  ]);
  const transgender = field("Do you identify as transgender?", ["Yes", "No", "I don't wish to answer"]);

  it("picks the one matching orientation option of a voluntary list", () => {
    expect(selfIdentificationCategory(orientation)).toBe("orientation");
    expect(pick(orientation, { eeo_sexual_orientation: "queer" })).toBe("Queer");
    expect(pick(orientation, { eeo_sexual_orientation: "pansexual" })).toBe("Bisexual and/or pansexual");
    expect(pick(orientation, { eeo_sexual_orientation: "heterosexual" })).toBe("Heterosexual");
    expect(pick(field("Sexual orientation", ["Straight", "Gay", "Decline to answer"]), { eeo_sexual_orientation: "heterosexual" })).toBe("Straight");
    expect(pick(orientation, { eeo_sexual_orientation: "unlisted_value" })).toBeNull();
  });

  it("never reads asexual as bisexual or pansexual", () => {
    expect(pick(field("Sexual orientation", ["Bisexual", "Pansexual", "Decline to answer"]), { eeo_sexual_orientation: "asexual" })).toBeNull();
    expect(pick(field("Sexual orientation", ["Bisexual", "Asexual", "Decline to answer"]), { eeo_sexual_orientation: "asexual" })).toBe("Asexual");
  });

  it("holds without a decline option or with two matches; an LGBTQ+ question takes both saved answers (Track 82)", () => {
    expect(pick(field("Sexual orientation", ["Gay", "Queer", "Heterosexual"]), { eeo_sexual_orientation: "queer" })).toBeNull();
    expect(pick(field("Sexual orientation", ["Gay man", "Gay woman", "Decline to answer"]), { eeo_sexual_orientation: "gay" })).toBeNull();
    expect(pick(field("Do you identify as LGBTQ+?", ["Yes", "No", "Decline to answer"]), { eeo_sexual_orientation: "queer", eeo_transgender: "transgender" })).toBe("Yes");
    expect(pick(field("What is your sexual orientation and gender?", ["Queer", "Woman", "Decline to answer"]), { eeo_sexual_orientation: "queer", eeo_gender: "female" })).toBeNull();
  });

  it("answers the transgender question from its own saved answer", () => {
    expect(selfIdentificationCategory(transgender)).toBe("transgender");
    expect(pick(transgender, { eeo_transgender: "not_transgender" })).toBe("No");
    expect(pick(transgender, { eeo_transgender: "transgender" })).toBe("Yes");
    expect(pick(field("Transgender identity", ["I am transgender", "I am not transgender", "Decline to answer"]), { eeo_transgender: "transgender" })).toBe("I am transgender");
    expect(pick(field("Transgender identity", ["I am transgender", "I am not transgender", "Decline to answer"]), { eeo_transgender: "not_transgender" })).toBe("I am not transgender");
    expect(pick(transgender, { eeo_gender: "non_binary" })).toBeNull();
  });

  it("accepts a \"mark all that apply\" checkbox group, never another checkbox group", () => {
    const boxes = field("How would you describe your sexual orientation? (mark all that apply)", ["Gay", "Queer", "Heterosexual", ...decline], "checkbox");
    expect(selfIdentificationCategory(boxes)).toBe("orientation");
    expect(pick(boxes, { eeo_sexual_orientation: "queer" })).toBe("Queer");
    const plain = field("Sexual orientation", ["Gay", "Queer", "Heterosexual", ...decline], "checkbox");
    expect(pick(plain, { eeo_sexual_orientation: "queer" })).toBeNull();
    const result = plan([boxes], [[boxes.id, { status: "SELF_IDENTIFIED", key: "eeo_sexual_orientation", option: "Queer" }]]);
    expect(result.pauses).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ action: "choose", value: "Queer", basis: { kind: "fact", key: "eeo_sexual_orientation", scope: "global" } });
    expect(result.decisions[0]!.reason).not.toMatch(/queer/i);
  });
});

describe("race-only lists take their decline option (the candidate's rule, 2026-11-26)", () => {
  // A synthetic copy of a race-only list seen on a Rippling form; the saved values are test values.
  const RACE_ONLY_OPTIONS = ["American Indian or Alaskan Native", "Asian", "Black or African American", "Middle Eastern or North African", "White",
    "Native Hawaiian or other Pacific Islander", "Two or more races", "Choose not to disclose"];
  const raceOnly = field("Please identify your race", RACE_ONLY_OPTIONS);
  const hispanic: SelfIdentificationAnswers = { eeo_race_ethnicity: "hispanic_or_latino" };
  const resolve = (target: BrowserField, answers: SelfIdentificationAnswers): FieldResolution => {
    const saved = matchSelfIdentificationOption(target, answers);
    return saved ? { status: "SELF_IDENTIFIED", ...saved } : { status: "UNAVAILABLE" };
  };
  const expectSensitivePause = (target: BrowserField, answers: SelfIdentificationAnswers) => {
    const result = plan([target], [[target.id, resolve(target, answers)]]);
    expect(result.decisions[0], target.label).toMatchObject({ action: "pause" });
    expect(result.pauses[0], target.label).toMatchObject({ sensitive: true });
  };

  it("chooses the decline option for a saved answer the race-only list does not offer", () => {
    expect(selfIdentificationCategory(raceOnly)).toBe("race");
    expect(matchSelfIdentificationOption(raceOnly, hispanic)).toEqual({ key: "eeo_race_ethnicity", option: "Choose not to disclose", rule: "race_only_decline" });
    for (const decline of ["I don't wish to answer", "Decline to self-identify", "Prefer not to say"]) {
      const target = field("Please identify your race", [...RACE_ONLY_OPTIONS.slice(0, -1), decline]);
      expect(pick(target, hispanic), decline).toBe(decline);
    }
    expect(pick(field("Please identify your race", RACE_ONLY_OPTIONS, "radio"), hispanic)).toBe("Choose not to disclose");
    expect(pick(field("What is your racial category?", RACE_ONLY_OPTIONS), hispanic)).toBe("Choose not to disclose");
  });

  it("chooses the saved answer's own option when the race-only list offers it", () => {
    expect(matchSelfIdentificationOption(raceOnly, { eeo_race_ethnicity: "white" })).toEqual({ key: "eeo_race_ethnicity", option: "White" });
    expect(pick(raceOnly, { eeo_race_ethnicity: "two_or_more_races" })).toBe("Two or more races");
  });

  it("keeps the existing match on combined race and ethnicity lists", () => {
    expect(pick(leverRace, hispanic)).toBe("Hispanic or Latino");
    expect(pick(greenhouseRace, hispanic)).toBe("Hispanic or Latino");
    for (const label of ["Race/Ethnicity", "What is your race or ethnicity?", "Ethnicity", "Race (Hispanic or Latino origin)"]) {
      expect(pick(field(label, RACE_ONLY_OPTIONS), hispanic), label).toBeNull();
    }
    expect(pick(greenhouseHispanic, hispanic)).toBe("Yes");
  });

  it("pauses a race-only list without exactly one decline option", () => {
    const noDecline = field("Please identify your race", RACE_ONLY_OPTIONS.slice(0, -1));
    expect(matchSelfIdentificationOption(noDecline, hispanic)).toBeNull();
    expectSensitivePause(noDecline, hispanic);
    const twoDeclines = field("Please identify your race", [...RACE_ONLY_OPTIONS, "I don't wish to answer"]);
    expect(matchSelfIdentificationOption(twoDeclines, hispanic)).toBeNull();
    expectSensitivePause(twoDeclines, hispanic);
  });

  it("pauses with nothing saved, an unknown saved value, or several matching options", () => {
    const ambiguous = field("Please identify your race", ["Asian Indian", "Asian American", "White", "Choose not to disclose"]);
    const cases: Array<[BrowserField, SelfIdentificationAnswers]> = [
      [raceOnly, {}],
      [raceOnly, { eeo_gender: "female" }],
      [raceOnly, { eeo_race_ethnicity: "unknown_value" }],
      [ambiguous, { eeo_race_ethnicity: "asian" }]
    ];
    for (const [target, answers] of cases) {
      expect(matchSelfIdentificationOption(target, answers), JSON.stringify(answers)).toBeNull();
      expectSensitivePause(target, answers);
    }
  });

  it("never names the saved answer in the decision reason or the plan", () => {
    const result = plan([raceOnly], [[raceOnly.id, resolve(raceOnly, hispanic)]]);
    expect(result.pauses).toEqual([]);
    expect(result.decisions[0]).toMatchObject({
      action: "choose", value: "Choose not to disclose", basis: { kind: "fact", key: "eeo_race_ethnicity", scope: "global" }, reason: RACE_ONLY_DECLINE_REASON
    });
    expect(JSON.stringify(result)).not.toMatch(/hispanic|latin/i);
    const matched = plan([raceOnly], [[raceOnly.id, resolve(raceOnly, { eeo_race_ethnicity: "white" })]]);
    expect(matched.decisions[0]).toMatchObject({
      action: "choose", value: "White", reason: "Your saved voluntary self-identification answer matches one of the offered options."
    });
  });
});

describe("held self-identification questions (Track 82, fictional answers)", () => {
  const optional = (label: string, kind: BrowserField["kind"], options?: string[]): BrowserField =>
    ({ ...field(label, options, kind), required: false });
  const resolve = (target: BrowserField, answers: SelfIdentificationAnswers): FieldResolution => {
    const saved = matchSelfIdentificationOption(target, answers);
    if (saved) return { status: "SELF_IDENTIFIED", ...saved };
    if (veteranClassificationLeftEmpty(target, answers)) return { status: "SELF_IDENTIFIED", key: "eeo_veteran_status", option: "", rule: "veteran_classification_empty" };
    return { status: "UNAVAILABLE" };
  };
  const FICTIONAL_VALUES = /female|male|asian|white|hispanic|latin|queer|gay|heterosexual|transgender|veteran_not_protected|not_veteran|protected_veteran|non_binary|they\/them/i;

  it("answers a transgender list worded \"I do not identify as transgender\"", () => {
    const target = field("Transgender identity", ["I identify as transgender", "I do not identify as transgender", "I don't wish to answer"]);
    expect(pick(target, { eeo_transgender: "not_transgender" })).toBe("I do not identify as transgender");
    expect(pick(target, { eeo_transgender: "transgender" })).toBe("I identify as transgender");
  });

  it("answers \"I am a veteran or active military\" for any saved veteran, never \"not a veteran or active military\"", () => {
    const target = field("Veteran status", ["I am a veteran or active military", "I am not a veteran or active military", "I don't wish to answer"]);
    expect(pick(target, { eeo_veteran_status: "veteran_not_protected" })).toBe("I am a veteran or active military");
    expect(pick(target, { eeo_veteran_status: "protected_veteran" })).toBe("I am a veteran or active military");
    // Not serving now is not saved: the not-a-veteran answer does not settle "active military".
    expect(pick(target, { eeo_veteran_status: "not_veteran" })).toBeNull();
  });

  it("answers a combined \"not a protected veteran / prefer not to answer\" option by its first part", () => {
    const protectedOption = "I identify as one or more of the Classifications of Protected Veteran Listed above";
    const target = field("Please select your Protected Veteran Status. (A definition of each group is provided above.)", [
      protectedOption, "I am not a protected Veteran / I prefer not to answer"
    ]);
    expect(pick(target, { eeo_veteran_status: "not_veteran" })).toBe("I am not a protected Veteran / I prefer not to answer");
    expect(pick(target, { eeo_veteran_status: "veteran_not_protected" })).toBe("I am not a protected Veteran / I prefer not to answer");
    expect(pick(target, { eeo_veteran_status: "protected_veteran" })).toBe(protectedOption);
  });

  it("answers an LGBTQ+ membership question from the saved orientation and transgender answers", () => {
    const cargurus = field("LGBTQIA+ identity", ["I identify as LGBTQIA+", "I do not identify as LGBTQIA+", "I don't wish to answer"]);
    const community = field(
      "Do you consider yourself a member of the Lesbian, Gay, Bisexual and/or Transgender, Queer and Questioning (LGBTQ) community?",
      ["Yes", "No", "Prefer not to say"],
      "radio"
    );
    expect(selfIdentificationCategory(cargurus)).toBe("lgbtq");
    expect(selfIdentificationCategory(community)).toBe("lgbtq");
    expect(classifyFieldRole(cargurus)).toBe("eeo");
    expect(matchSelfIdentificationOption(cargurus, { eeo_sexual_orientation: "gay" })).toEqual({ key: "eeo_sexual_orientation", option: "I identify as LGBTQIA+" });
    expect(matchSelfIdentificationOption(community, { eeo_sexual_orientation: "gay" })).toEqual({ key: "eeo_sexual_orientation", option: "Yes" });
    expect(matchSelfIdentificationOption(community, { eeo_sexual_orientation: "heterosexual", eeo_transgender: "transgender" }))
      .toEqual({ key: "eeo_transgender", option: "Yes" });
    const straightCis: SelfIdentificationAnswers = { eeo_sexual_orientation: "heterosexual", eeo_transgender: "not_transgender" };
    expect(pick(cargurus, straightCis)).toBe("I do not identify as LGBTQIA+");
    expect(pick(community, straightCis)).toBe("No");
    for (const answers of [{ eeo_sexual_orientation: "heterosexual" }, { eeo_sexual_orientation: "asexual", eeo_transgender: "not_transgender" }, {}] as SelfIdentificationAnswers[]) {
      expect(pick(cargurus, answers), JSON.stringify(answers)).toBeNull();
      expect(pick(community, answers), JSON.stringify(answers)).toBeNull();
    }
    expect(pick(field("LGBTQIA+ identity", ["I identify as LGBTQIA+", "I do not identify as LGBTQIA+"]), { eeo_sexual_orientation: "gay" })).toBeNull();
    expect(pick(field("LGBTQ+ and gender identity", ["Yes", "No", "I don't wish to answer"]), { eeo_sexual_orientation: "gay", eeo_gender: "female" })).toBeNull();
  });

  it("classifies Hispanic, Latinx, or Spanish origin questions as EEO and answers them from the saved race or ethnicity", () => {
    const origin = field("Are you of Hispanic, Latinx or Spanish origin?", ["Yes", "No", "I don't wish to answer"]);
    const workday = field("Please indicate if you are Hispanic or Latino", ["Select One", "Yes", "No"]);
    for (const target of [origin, workday]) {
      expect(classifyFieldRole(target), target.label).toBe("eeo");
      expect(selfIdentificationCategory(target), target.label).toBe("hispanic");
      expect(pick(target, { eeo_race_ethnicity: "hispanic_or_latino" }), target.label).toBe("Yes");
      expect(pick(target, { eeo_race_ethnicity: "white" }), target.label).toBe("No");
    }
    expect(classifyFieldRole(field("Have you lived in Latin America?", ["Yes", "No"]))).not.toBe("eeo");
  });

  it("fills gender, race, and Hispanic lists without a decline option, never the other categories", () => {
    expect(pick(field("Gender", ["Male", "Female"]), { eeo_gender: "female" })).toBe("Female");
    expect(pick(field("Sex", ["Female", "Male"]), { eeo_gender: "female" })).toBe("Female");
    expect(pick(field("What gender do you identify as?", ["Female", "Male", "Non-binary"], "radio"), { eeo_gender: "non_binary" })).toBe("Non-binary");
    const race = field("Please identify your race", [
      "American Indian or Alaskan Native", "Asian", "Black or African American", "White", "Native Hawaiian or Other Pacific Islander", "Two or More Races"
    ]);
    expect(pick(race, { eeo_race_ethnicity: "asian" })).toBe("Asian");
    // No decline option to take: the race-only rule does not apply.
    expect(pick(race, { eeo_race_ethnicity: "hispanic_or_latino" })).toBeNull();
    expect(pick(field("Do you have a disability?", ["Yes", "No"]), { eeo_disability_status: "has_disability" })).toBeNull();
    expect(pick(field("Are you a veteran?", ["Yes", "No"]), { eeo_veteran_status: "protected_veteran" })).toBeNull();
    expect(pick(field("Sexual orientation", ["Gay", "Queer", "Heterosexual"]), { eeo_sexual_orientation: "queer" })).toBeNull();
    expect(pick(field("Do you identify as transgender?", ["Yes", "No"]), { eeo_transgender: "transgender" })).toBeNull();
    const long = `Gender (this voluntary question helps us meet our reporting obligations; ${"it is optional and kept apart from your application ".repeat(2)})`;
    expect(long.length).toBeGreaterThan(100);
    expect(pick(field(long, ["Female", "Male"]), { eeo_gender: "female" })).toBeNull();
  });

  it("reads Lever's concatenated \"asSelect all that apply\" ethnicity list", () => {
    const tinder = field("I identify my ethnicity asSelect all that apply", [
      "African American/Black", "East Asian (Chinese, Japanese, Korean, Mongolian, Tibetan, Taiwanese, etc.)", "Hispanic, Latinx, or Spanish origin",
      "Middle Eastern or North African", "Native American/Alaska Native/First Nations", "Pacific Islander or Native Hawaiian",
      "South Asian (Bangladeshi, Bhutanese, Indian, Nepali, Pakistani, Sri Lankan)", "Southeast Asian (Burmese, Cambodian, Filipino, Hmong)",
      "White/Caucasian", "Bi-Racial/Mixed Race - Having 2 or more racial/ethnic groups", "Another race, ethnicity, or origin", "I prefer not to disclose"
    ], "checkbox");
    expect(selfIdentificationCategory(tinder)).toBe("race");
    expect(pick(tinder, { eeo_race_ethnicity: "white" })).toBe("White/Caucasian");
    expect(pick(tinder, { eeo_race_ethnicity: "hispanic_or_latino" })).toBe("Hispanic, Latinx, or Spanish origin");
    expect(pick(tinder, { eeo_race_ethnicity: "two_or_more_races" })).toBe("Bi-Racial/Mixed Race - Having 2 or more racial/ethnic groups");
    expect(pick(tinder, { eeo_race_ethnicity: "asian" })).toBeNull();
    const hermeus = field("I identify my ethnicity asSelect all that apply", [
      "Black / African American", "East Asian", "Hispanic / Latinx", "South Asian", "White / Caucasian", "Two or more races"
    ], "checkbox");
    expect(pick(hermeus, { eeo_race_ethnicity: "white" })).toBe("White / Caucasian");
  });

  it("sends pronoun questions to the saved pronouns, even worded \"gender pronouns\"", () => {
    const radio = field("What are your personal gender pronouns?", ["They/Them/Theirs", "She/Her/Hers", "He/Him/His", "I don't wish to answer", "I prefer to self-describe"], "radio");
    const text = field("We are dedicated to fostering the same safe and inclusive environment for our candidates as our employees. What are your personal gender pronouns?", undefined, "text");
    const boxes = field("What pronouns do you use?", ["She/her/hers", "He/him/his", "They/them/theirs", "Prefer not to answer"], "checkbox");
    expect(classifyFieldRole(radio)).toBe("custom");
    expect(classifyFieldRole(text)).toBe("custom");
    expect(classifyFieldRole(field("Gender identity and pronouns", ["Man", "Woman", "I don't wish to answer"]))).toBe("eeo");
    const pronouns: FieldResolution = { status: "RESOLVED", key: "pronouns", scope: "global", display: "he/him", value: "he/him" };
    const result = plan([radio, text, boxes], [[radio.id, pronouns], [text.id, pronouns], [boxes.id, pronouns]]);
    expect(result.pauses).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ action: "choose", value: "He/Him/His", basis: { kind: "fact", key: "pronouns" } });
    expect(result.decisions[1]).toMatchObject({ action: "fill", value: "he/him" });
    expect(result.decisions[2]).toMatchObject({ action: "choose", value: "He/him/his", basis: { kind: "fact", key: "pronouns" } });
  });

  it("leaves optional veteran classifications empty for a saved not-a-veteran or not-protected answer", () => {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const fields = [
      optional("Disabled Veteran", "checkbox"),
      optional("Armed Forces Service Medal Veteran", "checkbox"),
      optional("Recently Separated Veteran", "checkbox"),
      optional("Newly Separated Veteran Discharge Date Month", "select", months),
      optional("Newly Separated Veteran Discharge Date Year", "text")
    ];
    for (const value of ["not_veteran", "veteran_not_protected"]) {
      const answers: SelfIdentificationAnswers = { eeo_veteran_status: value };
      for (const target of fields) expect(veteranClassificationLeftEmpty(target, answers), `${target.label} ${value}`).toBe(true);
      const result = plan(fields, fields.map((target) => [target.id, resolve(target, answers)]));
      expect(result.pauses).toEqual([]);
      for (const entry of result.decisions) {
        expect(entry).toMatchObject({ action: "skip", value: null, reason: VETERAN_CLASSIFICATION_EMPTY_REASON });
        expect(entry.reason).not.toMatch(FICTIONAL_VALUES);
      }
    }
  });

  it("pauses a veteran classification any other saved answer, a required field, or a different label leaves open", () => {
    const box = optional("Disabled Veteran", "checkbox");
    const notVeteran: SelfIdentificationAnswers = { eeo_veteran_status: "not_veteran" };
    const cases: Array<[BrowserField, SelfIdentificationAnswers]> = [
      [box, { eeo_veteran_status: "protected_veteran" }],
      [box, {}],
      [{ ...box, required: true }, notVeteran],
      [optional("I am not a protected veteran", "checkbox"), notVeteran],
      [optional("Veteran", "checkbox"), notVeteran]
    ];
    for (const [target, answers] of cases) {
      expect(veteranClassificationLeftEmpty(target, answers), `${target.label} ${JSON.stringify(answers)}`).toBe(false);
      const result = plan([target], [[target.id, resolve(target, answers)]]);
      expect(result.decisions[0], target.label).toMatchObject({ action: "pause" });
      expect(result.pauses[0], target.label).toMatchObject({ sensitive: true });
    }
  });

  it("keeps the newly classified EEO wordings out of the AI pause review", () => {
    const pauseOf = (target: BrowserField): PauseRecord => ({
      fieldId: target.id, label: target.label, question: `How should "${target.label}" be answered?`, suggestedKey: null, suggestedScope: null,
      safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null, fieldKind: target.kind, options: target.options
    });
    for (const target of [
      field("Are you of Hispanic, Latinx or Spanish origin?", ["Yes", "No", "I don't wish to answer"]),
      field("LGBTQIA+ identity", ["I identify as LGBTQIA+", "I do not identify as LGBTQIA+", "I don't wish to answer"])
    ]) {
      expect(pauseReviewEligible(pauseOf(target), target), target.label).toBe(false);
    }
    const ordinary = field("Which office would you prefer?", ["Austin", "Remote"]);
    expect(pauseReviewEligible(pauseOf(ordinary), ordinary)).toBe(true);
  });

  it("never names a saved value in a self-identification decision reason", () => {
    const targets: Array<[BrowserField, SelfIdentificationAnswers]> = [
      [field("LGBTQIA+ identity", ["I identify as LGBTQIA+", "I do not identify as LGBTQIA+", "I don't wish to answer"]), { eeo_sexual_orientation: "queer" }],
      [field("Sex", ["Female", "Male"]), { eeo_gender: "female" }],
      [field("Are you of Hispanic, Latinx or Spanish origin?", ["Yes", "No", "I don't wish to answer"]), { eeo_race_ethnicity: "hispanic_or_latino" }],
      [field("Veteran status", ["I am a veteran or active military", "I am not a veteran or active military", "I don't wish to answer"]), { eeo_veteran_status: "protected_veteran" }]
    ];
    for (const [target, answers] of targets) {
      const result = plan([target], [[target.id, resolve(target, answers)]]);
      expect(result.pauses, target.label).toEqual([]);
      expect(result.decisions[0]!.reason, target.label).not.toMatch(FICTIONAL_VALUES);
    }
  });
});

describe("protected answers answer only identity questions (Track 82, rounds 2–3, fictional answers)", () => {
  const YES_NO = ["Yes", "No", "Prefer not to say"];
  const TOYOTA = "Do you consider yourself a member of the Lesbian, Gay, Bisexual and/or Transgender, Queer and Questioning (LGBTQ) community?";
  const optional = (label: string, kind: BrowserField["kind"], options?: string[]): BrowserField =>
    ({ ...field(label, options, kind), required: false });
  // Built exactly as resolveFields in packages/agent/src/browser-orchestrator.ts builds it.
  const resolve = (target: BrowserField, answers: SelfIdentificationAnswers): FieldResolution => {
    const saved = matchSelfIdentificationOption(target, answers);
    return saved ? { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option } : { status: "UNAVAILABLE" };
  };
  const hispanic: SelfIdentificationAnswers = { eeo_race_ethnicity: "hispanic_or_latino" };
  const veteran: SelfIdentificationAnswers = { eeo_veteran_status: "protected_veteran" };
  const disabled: SelfIdentificationAnswers = { eeo_disability_status: "has_disability" };
  const lgbtq: SelfIdentificationAnswers = { eeo_sexual_orientation: "gay" };
  const gender: SelfIdentificationAnswers = { eeo_gender: "female" };
  const negatives: Array<[string, SelfIdentificationAnswers, string[]?]> = [
    // Round 2 (N1–N11, N13, N14)
    ["Are you interested in joining our LGBTQ+ employee resource group?", lgbtq],
    ["Do you have experience working with LGBTQ+ communities?", lgbtq],
    ["Are you a member of the Latinx Professionals Association?", hispanic],
    ["Do you speak Spanish? (Hispanic markets role)", hispanic],
    ["Are you interested in our disability ERG?", disabled],
    ["Do you identify as an LGBTQ+ ally?", { eeo_sexual_orientation: "heterosexual", eeo_transgender: "not_transgender" }],
    ["Did you attend a Hispanic-Serving Institution?", hispanic],
    ["Are you a member of a veterans' association?", veteran],
    ["Would you like to join our Women in Engineering network? (gender)", gender, ["Yes", "No", "I don't wish to answer"]],
    ["Do you have experience supporting employees with disabilities?", disabled],
    ["Are you interested in Hispanic/Latino outreach programs?", hispanic],
    ["Do you consider yourself part of the Hispanic business community?", hispanic],
    ["Do you consider yourself a member of the LGBTQ+ ally community?", lgbtq],
    // The round-2 recheck's probes
    ["Are you part of a Hispanic student group?", hispanic],
    ["Are you affiliated with a veterans group?", veteran],
    ["Do you identify with any disability advocacy groups?", disabled],
    ["Are you an LGBTQ+ advocate?", lgbtq],
    ["Are you passionate about LGBTQ+ equity?", lgbtq],
    ["Are you comfortable with Hispanic customers?", hispanic],
    ["Are you familiar with disability accessibility standards (WCAG)?", disabled],
    ["Are you a veteran-owned business?", veteran],
    ["Are you a veteran of the software industry?", veteran],
    ["Are you applying through a veterans hiring initiative?", veteran],
    ["Which LGBTQ+ community events would you attend?", lgbtq],
    ["Do you identify as an LGBTQ+ ally?", lgbtq],
    // A parenthetical that is not a list hint stays part of the question (round 3)
    ["Are you a veteran? (veteran-owned business)", veteran],
    ["Gender (Women in Engineering network)", gender],
    ["Are you LGBTQ+ (ally)?", lgbtq],
    ["Disability (accessibility standards WCAG)", disabled],
    ["Veteran (of the software industry)", veteran],
    ["Are you Hispanic (customers)?", hispanic]
  ];
  const FICTIONAL_VALUE_TOKENS = /gay|hispanic_or_latino|female|has_disability|protected_veteran/i;

  it("never answers a wording that is not, in full, an identity shape", () => {
    for (const [label, answers, options] of negatives) {
      const target = field(label, options ?? YES_NO);
      expect(isIdentityQuestion(label), label).toBe(false);
      expect(matchSelfIdentificationOption(target, answers), label).toBeNull();
      expect(classifyFieldRole(target), label).toBe("eeo");
      const result = plan([target], [[target.id, resolve(target, answers)]]);
      expect(result.decisions[0], label).toMatchObject({ action: "pause" });
      expect(result.pauses[0], label).toMatchObject({ sensitive: true });
      for (const entry of result.decisions) expect(entry.reason, label).not.toMatch(FICTIONAL_VALUE_TOKENS);
    }
  });

  it("leaves a veteran classification empty only on its exact label", () => {
    const notVeteran: SelfIdentificationAnswers = { eeo_veteran_status: "not_veteran" };
    const months = ["January", "February", "March"];
    for (const target of [
      { ...field("Disabled Veteran Outreach Program", ["Disabled Veteran Outreach Program"], "checkbox"), required: false },
      optional("Disabled Veteran Outreach Program", "checkbox"),
      optional("Disabled veterans group member", "checkbox"),
      optional("Veteran discharge date of your spouse", "select", months)
    ]) {
      expect(veteranClassificationLeftEmpty(target, notVeteran), target.label).toBe(false);
    }
    for (const target of [
      optional("Disabled Veteran", "checkbox"),
      optional("Armed Forces Service Medal Veteran", "checkbox"),
      optional("Recently Separated Veteran", "checkbox"),
      optional("Newly Separated Veteran Discharge Date Month", "select", months)
    ]) {
      expect(veteranClassificationLeftEmpty(target, notVeteran), target.label).toBe(true);
    }
  });

  it("still answers real self-identification wordings", () => {
    const orientation = field("How would you describe your sexual orientation? (mark all that apply)", [
      "Asexual", "Bisexual and/or pansexual", "Gay", "Heterosexual", "Lesbian", "Queer", "I prefer to self-describe", "I don't wish to answer"
    ], "checkbox");
    expect(pick(field("Gender", ["Male", "Female", "Decline To Self Identify"]), gender)).toBe("Female");
    expect(pick(field("Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"]), hispanic)).toBe("Yes");
    expect(pick(greenhouseVeteran, { eeo_veteran_status: "not_veteran" })).toBe("I am not a protected veteran");
    expect(pick(workdayVeteran, { eeo_veteran_status: "not_veteran" })).toBe("I am not a veteran");
    expect(pick(yesNoVeteran, veteran)).toBe("Yes");
    expect(pick(field("Are you a veteran?", YES_NO), veteran)).toBe("Yes");
    expect(pick(disability, { eeo_disability_status: "no_disability" })).toBe("No, I do not have a disability");
    expect(pick(field("Do you have a disability?", YES_NO), disabled)).toBe("Yes");
    expect(pick(field("LGBTQIA+ identity", ["I identify as LGBTQIA+", "I do not identify as LGBTQIA+", "I don't wish to answer"]), lgbtq))
      .toBe("I identify as LGBTQIA+");
    expect(pick(field("Do you identify as LGBTQ+?", YES_NO), lgbtq)).toBe("Yes");
    expect(pick(field("Do you identify as transgender?", ["Yes", "No", "I don't wish to answer"]), { eeo_transgender: "transgender" })).toBe("Yes");
    expect(pick(orientation, { eeo_sexual_orientation: "queer" })).toBe("Queer");
    expect(pick(field(TOYOTA, YES_NO, "radio"), lgbtq)).toBe("Yes");
    expect(pick(field("Sex", ["Female", "Male"]), gender)).toBe("Female");
    expect(pick(field("Are you of Hispanic, Latinx or Spanish origin?", ["Yes", "No", "I don't wish to answer"]), hispanic)).toBe("Yes");
    expect(pick(field("Please indicate if you are Hispanic or Latino", ["Select One", "Yes", "No"]), hispanic)).toBe("Yes");
  });

  it("counts real self-identification labels, with or without list hints, as identity questions", () => {
    for (const label of [
      "Gender", "Sex", "Race", "Race/Ethnicity", "Ethnicity", "What is your race or ethnicity?", "Disability", "Disability Status",
      "Veteran Status", "Veteran status", "Sexual orientation", "Transgender identity", "LGBTQIA+ identity",
      "What is your gender?", "What is your racial category?", "Are you Hispanic/Latino?", "Are you a protected veteran?", "Are you a veteran?",
      "Do you have a disability?", "Do you identify as transgender?", "Do you identify as LGBTQ+?",
      "How would you describe your gender identity? (mark all that apply)",
      "How would you describe your racial/ethnic background? (mark all that apply)",
      "How would you describe your sexual orientation? (mark all that apply)",
      "Please identify your race",
      "Please indicate if you are Hispanic or Latino",
      "Please select the veteran status which most accurately describes your status",
      "Please select your Protected Veteran Status. (A definition of each group is provided above.)",
      "What gender do you identify as?",
      "I identify my ethnicity asSelect all that apply",
      "I identify my ethnicity as (mark all that apply):",
      "Are you of Hispanic, Latinx or Spanish origin?",
      "Which ethnicity(ies) do you identify with? Please select all that apply.",
      "How do you identify your sexual orientation? Please select all that apply.",
      "Please select the ethnicity(ies) which most accurately describes how you identify yourself.",
      TOYOTA
    ]) {
      expect(isIdentityQuestion(label), label).toBe(true);
    }
  });
});
