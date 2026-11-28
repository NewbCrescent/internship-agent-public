import { describe, expect, it } from "vitest";

import { agreeOption, citizenAuthorizationOption, closestGraduationOption, exportControlCategory, factOption, graduationComparison, graduationRangeOption, graduationTermMonths, graduationTermOption, isStandardizedTestTypeQuestion, numericRangeOption, promotableFactValue, relocationOption, relocationQuestionParts, samePlace, savedYesNoOption, startBucketOption, startWindowDays, usPersonYesNoOption } from "@internship-agent/domain";

/** Deterministic option rules for saved facts (2026-11-24); fictional option lists and places. */
const BUCKETS = ["Immediately", "2 weeks", "2–4 weeks", "4–6 weeks", "6+ weeks"];
const TODAY = "2026-11-24";

describe("offer-relative start windows (startWindowDays)", () => {
  it.each<[string, { min: number; max: number } | null]>([
    ["Immediately", { min: 0, max: 0 }],
    ["ASAP", { min: 0, max: 0 }],
    ["2 weeks", { min: 1, max: 14 }],
    ["Within 2 weeks", { min: 1, max: 14 }],
    ["2–4 weeks", { min: 14, max: 28 }],
    ["4 - 6 weeks", { min: 28, max: 42 }],
    ["6+ weeks", { min: 42, max: Infinity }],
    ["More than 3 months", { min: 90, max: Infinity }],
    ["3 months or more", { min: 90, max: Infinity }],
    ["10 days", { min: 1, max: 10 }],
    ["Other", null],
    ["Summer 2027", null],
    // Offer-relative options that say so (micron.wd1, 2026-11-25; Track 32).
    ["Immediately after offer acceptance", { min: 0, max: 0 }],
    ["Within 1 month after offer acceptance", { min: 1, max: 30 }],
    ["Within 2 months after offer acceptance", { min: 1, max: 60 }],
    ["More than 2 months after offer acceptance", { min: 60, max: Infinity }],
    ["After Graduation (For current grads)", null]
  ])("reads %s", (option, window) => {
    expect(startWindowDays(option)).toEqual(window);
  });
});

describe("start bucket from today and the available start date (startBucketOption)", () => {
  it.each<[string, string]>([
    ["2027-05-15", "6+ weeks"],
    ["2026-11-24", "Immediately"],
    ["2026-11-20", "Immediately"],
    ["2026-11-30", "2 weeks"],
    ["2026-12-08", "2–4 weeks"],
    ["2026-12-10", "2–4 weeks"]
  ])("start %s picks %s", (start, option) => {
    expect(startBucketOption(BUCKETS, start, TODAY)?.option).toBe(option);
  });

  it("never picks Immediately before the start date, and returns null when nothing fits", () => {
    expect(startBucketOption(BUCKETS, "2026-11-25", TODAY)?.option).toBe("2 weeks");
    expect(startBucketOption(["Immediately", "2 weeks", "2–4 weeks"], "2027-05-15", TODAY)).toBeNull();
    expect(startBucketOption(["Immediately", "Other"], "2027-05-15", TODAY)).toBeNull();
    expect(startBucketOption(BUCKETS, "not-a-date", TODAY)).toBeNull();
    expect(startBucketOption(BUCKETS, "2027-02-30", TODAY)).toBeNull();
    expect(startBucketOption(["2 weeks", "Within 2 weeks"], "2026-11-30", TODAY)).toBeNull();
  });

  it("picks an \"after offer acceptance\" bucket, and keeps the tie rule between two \"Within\" buckets (Track 32)", () => {
    const offer = [
      "Select One",
      "Immediately after offer acceptance",
      "Within 1 month after offer acceptance",
      "Within 2 months after offer acceptance",
      "More than 2 months after offer acceptance",
      "After Graduation (For current grads)"
    ];
    const today = "2026-11-25";
    expect(startBucketOption(offer, "2027-05-15", today)?.option).toBe("More than 2 months after offer acceptance");
    expect(startBucketOption(offer, "2027-01-10", today)?.option).toBe("Within 2 months after offer acceptance");
    expect(startBucketOption(offer, "2026-12-10", today)).toBeNull();
    expect(startBucketOption(offer, "2026-11-25", today)?.option).toBe("Immediately after offer acceptance");
  });
});

describe("agreeing with an advertised range (agreeOption)", () => {
  it("picks the one agreeing option", () => {
    expect(agreeOption(["Agree", "Disagree"])).toBe("Agree");
    expect(agreeOption(["Yes", "No"])).toBe("Yes");
    expect(agreeOption(["Yes, I am comfortable", "No, I am not comfortable"])).toBe("Yes, I am comfortable");
    expect(agreeOption(["Uncomfortable", "Not comfortable"])).toBeNull();
    expect(agreeOption(["Yes", "Yes, with conditions"])).toBeNull();
  });
});

describe("own-expense relocation (relocationOption, samePlace)", () => {
  const COMBINED = ["Yes, I am located in or near the city", "Yes, I am willing to relocate at my own expense", "No"];

  it("picks the located option only when the profile's place is the posting's", () => {
    expect(relocationOption(true, COMBINED, true)).toEqual({ option: COMBINED[0], local: true });
    expect(relocationOption(false, COMBINED, true)).toEqual({ option: COMBINED[0], local: true });
  });

  it("picks the own-expense option for a saved yes, and nothing for a saved no", () => {
    expect(relocationOption(true, COMBINED, false)).toEqual({ option: COMBINED[1], local: false });
    expect(relocationOption(false, COMBINED, false)).toBeNull();
  });

  it("takes Yes on a plain Yes/No list only for a saved yes", () => {
    expect(relocationOption(true, ["Yes", "No"], false)).toEqual({ option: "Yes", local: false });
    expect(relocationOption(false, ["Yes", "No"], false)).toBeNull();
    expect(relocationOption(false, ["Yes", "No"], true)).toBeNull();
  });

  it("never reads a negated option as located or own-expense", () => {
    expect(relocationOption(true, ["I am not located near the city", "I will not relocate at my own expense", "No"], false)).toBeNull();
  });

  it("compares places exactly, and only for a posting in one place", () => {
    expect(samePlace("Fixture City, CA", ["fixture city,  ca"])).toBe(true);
    expect(samePlace("Fixture City, CA", ["Fixture City, California"])).toBe(false);
    expect(samePlace("Fixture City, CA", ["Fixture City, CA", "Testville, TX"])).toBe(false);
    expect(samePlace(undefined, ["Fixture City, CA"])).toBe(false);
    expect(samePlace("Fixture City, CA", [])).toBe(false);
  });
});

describe("factOption dispatch", () => {
  it("applies each key's rule", () => {
    expect(factOption("salary_expectation_rule", "posting_pay_hourly", ["Yes", "No"], { nearPosting: false })?.option).toBe("Yes");
    expect(factOption("salary_expectation_rule", "something_else", ["Yes", "No"], { nearPosting: false })).toBeNull();
    expect(factOption("available_start_date", "2027-05-15", BUCKETS, { today: TODAY, nearPosting: false })).toEqual({
      option: "6+ weeks", reason: 'Your available start date is 172 days from today, which falls in "6+ weeks".'
    });
    expect(factOption("available_start_date", "2027-05-15", BUCKETS, { nearPosting: false })).toBeNull();
    expect(factOption("willing_background_check", true, ["Yes, I am willing", "No"], { nearPosting: false })?.option).toBe("Yes, I am willing");
    expect(factOption("willing_background_check", false, ["Yes, I am willing", "No"], { nearPosting: false })?.option).toBe("No");
    expect(factOption("willing_to_relocate_at_own_expense", true, ["Yes, I am located in or near the city", "Yes, I will relocate at my own cost", "No"], { nearPosting: false })?.reason)
      .toBe("You are willing to relocate at your own expense (your saved answer).");
    expect(factOption("how_heard", "LinkedIn", ["LinkedIn"], { nearPosting: false })).toBeNull();
  });
});

describe("graduation term options (Track 43)", () => {
  // Veeva's Lever list (2026-11-26); the dates are fictional.
  const TERMS = ["December 2028 or later", "Spring 2028", "December 2027", "Spring 2027", "December 2026", "Spring 2026 or earlier"];

  it("picks the one term holding the date's month", () => {
    expect(graduationTermOption(TERMS, "2027-05-15")).toBe("Spring 2027");
    expect(graduationTermOption(TERMS, "2029-05-15")).toBe("December 2028 or later");
    expect(graduationTermOption(TERMS, "2026-05-10")).toBe("Spring 2026 or earlier");
    expect(graduationTermOption(TERMS, "2027-12-15")).toBe("December 2027");
  });

  it("pauses when no term, several terms, or fewer than two readable terms hold it", () => {
    expect(graduationTermOption(TERMS, "2027-08-10")).toBeNull();
    expect(graduationTermOption(["Fall 2027", "December 2027", "Spring 2028"], "2027-12-15")).toBeNull();
    expect(graduationTermOption(["Winter 2027", "Spring 2027"], "2027-01-15")).toBeNull();
    expect(graduationTermOption(["Spring 2027", "Not sure"], "2027-05-15")).toBeNull();
    expect(graduationTermOption(TERMS, "2027-13-01")).toBeNull();
  });

  it("reads month abbreviations and open ends", () => {
    expect(graduationTermMonths("Dec 2027")).toEqual({ from: 2027 * 12 + 11, to: 2027 * 12 + 11 });
    expect(graduationTermMonths("May 2027")).toEqual({ from: 2027 * 12 + 4, to: 2027 * 12 + 4 });
    expect(graduationTermMonths("Spring 2026 or earlier")).toEqual({ from: -Infinity, to: 2026 * 12 + 5 });
    expect(graduationTermMonths("December 2028 or later")).toEqual({ from: 2028 * 12 + 11, to: Infinity });
    expect(graduationTermMonths("Winter 2027")).toBeNull();
    expect(graduationTermOption(["Dec 2027", "May 2027"], "2027-05-01")).toBe("May 2027");
  });

  it("answers a saved graduation date through factOption with a reason naming the option, not the date", () => {
    const picked = factOption("graduation_date", "2027-05-15", TERMS, { nearPosting: false });
    expect(picked?.option).toBe("Spring 2027");
    expect(picked?.reason).toContain("Spring 2027");
    expect(picked?.reason).not.toContain("2027-05-15");
  });

  it("reads season pairs, where winter as the second season adds no months (Track 57)", () => {
    // A fictional Ashby radio list shaped like the held runs' (2026-11-26).
    const PAIRS = ["Spring/Summer 2027", "Fall/Winter 2027", "Spring/Summer 2028", "Fall/Winter 2028", "Spring/Summer 2029", "Winter 2029 or later"];
    expect(graduationTermOption(PAIRS, "2028-05-15")).toBe("Spring/Summer 2028");
    expect(graduationTermOption(PAIRS, "2027-12-15")).toBe("Fall/Winter 2027");
    expect(graduationTermOption(PAIRS, "2028-02-15")).toBeNull();
    expect(graduationTermMonths("Spring/Summer 2028")).toEqual({ from: 2028 * 12 + 3, to: 2028 * 12 + 7 });
    expect(graduationTermMonths("Summer / Fall 2028")).toEqual({ from: 2028 * 12 + 6, to: 2028 * 12 + 11 });
    expect(graduationTermMonths("Fall/Winter 2027")).toEqual({ from: 2027 * 12 + 8, to: 2027 * 12 + 11 });
    expect(graduationTermMonths("Winter 2029 or later")).toBeNull();
    expect(graduationTermMonths("Fall/Spring 2028")).toBeNull();
  });

  it("takes the one degree-and-range option of the profile degree's level holding the date (graduationRangeOption, Track 57)", () => {
    const RANGES = [
      "Bachelors - Senior (December 2026 - June 2027)",
      "Bachelors - Junior (December 2027 - June 2028)",
      "Bachelors - Sophomore (December 2028 - June 2029)",
      "Masters - 1st Year (December 2027 - June 2028)",
      "Masters - 2nd Year (December 2026 - June 2026)",
      "Doctorate Student",
      "I am not currently enrolled as a university or college student."
    ];
    expect(graduationRangeOption(RANGES, "2028-05-15", "bachelor")).toBe("Bachelors - Junior (December 2027 - June 2028)");
    expect(graduationRangeOption(RANGES, "2028-05-15", null)).toBeNull();
    expect(graduationRangeOption(RANGES, "2030-09-01", "bachelor")).toBeNull();
    const picked = factOption("graduation_date", "2028-05-15", RANGES, { nearPosting: false, degreeLevel: "bachelor" });
    expect(picked?.option).toBe("Bachelors - Junior (December 2027 - June 2028)");
    expect(picked?.reason).toContain("Bachelors - Junior (December 2027 - June 2028)");
    expect(picked?.reason).not.toContain("2028-05-15");
  });
});

describe("saved Yes/No options (savedYesNoOption, Track 57)", () => {
  // Fictional sentence lists shaped like the held runs' Greenhouse and Workday options (2026-11-26).
  const AUTHORIZED = [
    "Yes, I am currently legally authorized to work in the country where the job is located.",
    "No, I am not currently legally authorized to work in the country where the job is located."
  ];

  it("picks the one work-authorization option that starts with the saved Yes or No and says nothing more", () => {
    expect(savedYesNoOption("authorized_to_work", true, AUTHORIZED)).toBe(AUTHORIZED[0]);
    expect(savedYesNoOption("authorized_to_work", false, AUTHORIZED)).toBe(AUTHORIZED[1]);
  });

  it("returns null for two Yes options, an option naming sponsorship, or options without a Yes/No lead", () => {
    expect(savedYesNoOption("authorized_to_work", true, ["Yes, on an unrestricted and indefinite basis", "Yes, with restrictions", "No"])).toBeNull();
    expect(savedYesNoOption("authorized_to_work", true, ["Yes, I am authorized and will not require sponsorship", "No"])).toBeNull();
    expect(savedYesNoOption("authorized_to_work", true, ["I am authorized to work for any employer", "I am not authorized"])).toBeNull();
  });

  it("picks the one plain relocation option, never one naming who pays, commuting, or living nearby", () => {
    expect(savedYesNoOption("willing_to_relocate", true, ["Select One", "Yes, I am willing to relocate.", "No, I am not willing to relocate.", "I am open to relocation."]))
      .toBe("Yes, I am willing to relocate.");
    expect(savedYesNoOption("willing_to_relocate", true, ["Yes, at my own expense", "No"])).toBeNull();
  });

  it("picks the one Yes option naming relocating when several start with Yes (Track 62)", () => {
    const NEARBY = ["Yes: I live nearby or the role is remote", "Yes: I am willing to relocate", "No"];
    expect(savedYesNoOption("willing_to_relocate", true, NEARBY)).toBe("Yes: I am willing to relocate");
    expect(savedYesNoOption("willing_to_relocate", false, NEARBY)).toBe("No");
    expect(savedYesNoOption("willing_to_relocate", true, ["Yes, I am willing to relocate", "Yes, I would relocate", "No"])).toBeNull();
    expect(savedYesNoOption("authorized_to_work", true, ["Yes, on an unrestricted and indefinite basis", "Yes, with restrictions", "No"])).toBeNull();
  });

  it("decides no other key and no string value", () => {
    expect(savedYesNoOption("requires_sponsorship", true, AUTHORIZED)).toBeNull();
    expect(savedYesNoOption("authorized_to_work", "yes", AUTHORIZED)).toBeNull();
  });
});

describe("work-authorization option U.S. citizenship makes true (citizenAuthorizationOption, Track 62)", () => {
  // Fictional lists shaped like the held runs' Workday and Greenhouse options (2026-11-26).
  const ELIGIBLE = [
    "Select One",
    "Yes, I am eligible for employment in the US (includes US Citizenship & Permanent Residency).",
    "Yes, I am legally eligible to work in the US but I require Fixture Dynamics to sponsor or support a work visa now OR in the future.",
    "No, I am not eligible for US employment."
  ];
  const UNRESTRICTED = [
    "Select One",
    "Yes, on an unrestricted and indefinite basis (regardless of extensions/renewals)",
    "Yes, with restrictions and/or for a fixed time period (requiring extensions/renewals for right-to-work maintenance)",
    "No"
  ];
  const STATUSES = [
    "I am authorized to work in the United States for any employer",
    "I am authorized to work in the United States for my present employer",
    "I require sponsorship to work in the United States",
    "I am not authorized to work in the United States",
    "My status to work in the United States is unknown",
    "If Other, please explain:"
  ];

  it("picks the one option citizenship makes true", () => {
    expect(citizenAuthorizationOption(ELIGIBLE)).toBe(ELIGIBLE[1]);
    expect(citizenAuthorizationOption(UNRESTRICTED)).toBe(UNRESTRICTED[1]);
    expect(citizenAuthorizationOption(STATUSES)).toBe(STATUSES[0]);
    expect(citizenAuthorizationOption(["Yes, I am authorized and will not require sponsorship", "No"])).toBe("Yes, I am authorized and will not require sponsorship");
  });

  it("returns null when several qualify or none citizenship settles", () => {
    expect(citizenAuthorizationOption(["Yes, I am a U.S. citizen", "I am authorized to work for any employer", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I am a permanent resident", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I hold an active security clearance", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["I am authorized to work in Canada for any employer", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Select One", "Please select", "No"])).toBeNull();
  });

  it("returns null for a qualified or changing claim or a need stated for later (Track 62 round 2)", () => {
    expect(citizenAuthorizationOption(["Yes, I do not require sponsorship now but will in the future", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I do not currently require sponsorship but may in the future", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I do not require sponsorship today; I will need it later", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I am authorized to work until my status expires", "No"])).toBeNull();
    expect(citizenAuthorizationOption(["Yes, I will not require sponsorship now or in the future", "No"])).toBe("Yes, I will not require sponsorship now or in the future");
    expect(citizenAuthorizationOption(["Yes, I am authorized to work in the US and do not require sponsorship", "No"])).toBe("Yes, I am authorized to work in the US and do not require sponsorship");
  });
});

describe("what else a relocation question asks (relocationQuestionParts, Track 62)", () => {
  it("reads on-site and nearby-or-relocate parts without holding them", () => {
    expect(relocationQuestionParts("This position requires you to work 5 days per week for the duration of the internship. Are you currently located in, or willing to relocate to Fixture Bay?"))
      .toEqual({ onSite: true, local: true, held: null });
    expect(relocationQuestionParts("This role is fully in-office, five days a week. Are you able to meet this requirement, and/or are you open to relocating to meet this requirement?"))
      .toEqual({ onSite: true, local: false, held: null });
    expect(relocationQuestionParts("If this position requires being in the office, are you within a 60-minute commute or willing to relocate?"))
      .toEqual({ onSite: true, local: true, held: null });
  });

  it("holds parts the saved relocation answer cannot settle", () => {
    const AVAILABILITY = "It also asks about your availability on stated dates or for a stated length.";
    expect(relocationQuestionParts("Can you relocate to Fixture Bay for the Summer internship (June-August)?").held).toBe(AVAILABILITY);
    expect(relocationQuestionParts("Are you available and willing to relocate to the site location for the full duration of a 12-consecutive-week, in-person internship starting between May and July?").held).toBe(AVAILABILITY);
    expect(relocationQuestionParts("Will you be willing to commute/drive or temporarily relocate to state/cities where there is a Fixture Dynamics office in your region during the program?NOTE: Fixture Dynamics does not provide relocation support or housing.").held)
      .toBe("It asks about a temporary move.");
    expect(relocationQuestionParts("If offered a full-time role upon completion of your degree, would you be willing to relocate permanently?").held)
      .toBe("It asks about a permanent move or one after the internship.");
    expect(relocationQuestionParts("Do you live within 50 miles of Fixture Bay and are you willing to relocate?").held)
      .toBe("It also asks whether you already live nearby or can commute.");
    expect(relocationQuestionParts("Are you willing to relocate? Relocation assistance is not provided.").held)
      .toBe("It also says who pays for the move or what support comes with it.");
  });

  it("reads nothing more in a plain relocation question", () => {
    expect(relocationQuestionParts("Are you willing to relocate?")).toEqual({ onSite: false, local: false, held: null });
  });
});

describe("held-question option shapes (Track 79, fictional dates and scores)", () => {
  const DATE = "2030-05-15";
  const month = (year: number, m: number) => year * 12 + m - 1;

  it.each<[string, { from: number; to: number } | null]>([
    ["May/June 2030", { from: month(2030, 5), to: month(2030, 6) }],
    ["January – June 2030", { from: month(2030, 1), to: month(2030, 6) }],
    ["Jan. - Jun. 2030", { from: month(2030, 1), to: month(2030, 6) }],
    ["Spring 2030 (January - May)", { from: month(2030, 1), to: month(2030, 5) }],
    ["Summer 2030 (June or later)", { from: month(2030, 6), to: month(2030, 8) }],
    ["2031 or later", { from: month(2031, 1), to: Infinity }],
    ["2029 or earlier", { from: -Infinity, to: month(2029, 12) }],
    ["2028 or earlier (already graduated or graduating this year)", { from: -Infinity, to: month(2028, 12) }],
    ["After Spring 2030", { from: month(2030, 7), to: Infinity }],
    ["Later than Summer 2030", { from: month(2030, 9), to: Infinity }],
    ["Before 2028", { from: -Infinity, to: month(2027, 12) }],
    ["After 2032", { from: month(2033, 1), to: Infinity }],
    ["Prior to Fall 2030", { from: -Infinity, to: month(2030, 8) }],
    // Existing shapes keep their results; winter alone and plain years stay unread.
    ["Spring 2030", { from: month(2030, 4), to: month(2030, 6) }],
    ["December 2030 or later", { from: month(2030, 12), to: Infinity }],
    ["Winter 2030", null],
    ["2030", null],
    ["June/May 2030", null]
  ])("reads %s", (option, months) => {
    expect(graduationTermMonths(option)).toEqual(months);
  });

  it("picks the one new-shape term holding the date", () => {
    expect(graduationTermOption(["January – June 2030", "July – December 2030", "January – June 2031"], DATE)).toBe("January – June 2030");
    expect(graduationTermOption(["Spring 2030 (January - May)", "Summer 2030 (June or later)", "Later than Summer 2030"], DATE)).toBe("Spring 2030 (January - May)");
    expect(graduationTermOption(["2028 or earlier (already graduated or graduating this year)", "2029", "2030", "2031 or later"], "2032-05-15")).toBe("2031 or later");
    expect(graduationTermOption(["Before 2029", "2029", "2030", "After 2030"], "2028-05-15")).toBe("Before 2029");
    expect(graduationTermOption(["Spring 2030", "After Spring 2030"], "2030-07-01")).toBe("After Spring 2030");
  });

  it.each<[string, string, boolean | null]>([
    ["Will you be graduating before September 2030?", DATE, true],
    ["Will you be graduating before May 2030?", DATE, false],
    ["Will you graduate by Spring 2030?", DATE, true],
    ["Will you be graduating after December 2029?", DATE, true],
    ["Is your expected graduation date in 2031 or later?", DATE, false],
    ["Is your expected graduation date in 2030 or later?", DATE, true],
    ["Will you graduate no later than 2029?", DATE, false],
    // Not the graduation date: another degree, a full-time start, two comparisons, or none.
    ["Will you be graduating with a Master's before September 2030?", DATE, null],
    ["Will you graduate before 2031 and start full-time after?", DATE, null],
    ["Will you graduate after 2029 but before 2031?", DATE, null],
    ["When do you expect to graduate?", DATE, null]
  ])("compares %s", (question, date, answer) => {
    expect(graduationComparison(question, date)?.answer ?? null).toBe(answer);
  });

  it("answers a graduation comparison's Yes/No list from the date", () => {
    const yesNo = ["Yes", "No"];
    expect(factOption("graduation_date", DATE, yesNo, { nearPosting: false, question: "Will you be graduating before September 2030?" })?.option).toBe("Yes");
    expect(factOption("graduation_date", DATE, yesNo, { nearPosting: false, question: "Is your expected graduation date in 2031 or later?" })?.option).toBe("No");
    expect(factOption("graduation_date", DATE, yesNo, { nearPosting: false, question: "Will you graduate after 2029 but before 2031?" })).toBeNull();
  });

  it("picks the closest single-month option only when the label asks for the closest date", () => {
    const months = ["December 2029", "June 2030", "December 2030"];
    expect(closestGraduationOption(months, DATE)).toBe("June 2030");
    expect(factOption("graduation_date", DATE, months, { nearPosting: false, closest: true })?.option).toBe("June 2030");
    expect(factOption("graduation_date", DATE, months, { nearPosting: false })).toBeNull();
    expect(closestGraduationOption(["April 2030", "June 2030"], DATE)).toBeNull();
    expect(closestGraduationOption(["December 2029", "December 2030"], DATE)).toBeNull();
  });

  it.each<[number, string[], string | null]>([
    [1350, ["<1200", "1200 - 1290", "1300 - 1390", "1400 - 1490", "1500+"], "1300 - 1390"],
    [1300, ["I don't have SAT score", "<1200", "1201 - 1300", "1301 - 1400", "1401 - 1500", "1501 - 1600"], "1201 - 1300"],
    [1301, ["<1200", "1201 - 1300", "1301 - 1400"], "1301 - 1400"],
    [1550, ["Under 1400", "1400 to 1500", "1500 or more"], "1500 or more"],
    [1200, ["<1200", "1200–1400", "1400–1600"], "1200–1400"],
    [1400, ["1200-1400", "1400-1600"], null],
    [1350, ["1350"], null],
    [29, ["<30", "31", "32", "33"], "<30"],
    [30, ["<30", "31", "32"], null],
    // A held run's list (2026-11-27): each bucket names the scale.
    [1520, ["Did not take/Do not recall", "1600 out of 1600", "1550-1599 out of 1600", "1500-1549 out of 1600", "1450-1499 out of 1600"], "1500-1549 out of 1600"],
    [34, ["Did not take/Do not recall", "36 out of 36", "35 out of 36", "34 out of 36"], "34 out of 36"]
  ])("puts %s in its bucket", (value, options, expected) => {
    expect(numericRangeOption(value, options)).toBe(expected);
  });

  it("picks the SAT or ACT option of a test-type list for a saved score, never a combined option", () => {
    expect(isStandardizedTestTypeQuestion("Test Type")).toBe(true);
    expect(isStandardizedTestTypeQuestion("Which standardized test did you take?")).toBe(true);
    expect(isStandardizedTestTypeQuestion("Which test automation tools have you used?")).toBe(false);
    expect(factOption("sat_score", "1350", ["SAT", "ACT"], { nearPosting: false, question: "Test Type" })?.option).toBe("SAT");
    expect(factOption("act_score", "31", ["SAT", "ACT"], { nearPosting: false, question: "Score type" })?.option).toBe("ACT");
    expect(factOption("sat_score", "1350", ["SAT", "ACT", "Both"], { nearPosting: false, question: "Test Type" })).toBeNull();
    expect(factOption("sat_score", "1350", ["SAT", "SAT and ACT"], { nearPosting: false, question: "Test Type" })).toBeNull();
    expect(factOption("sat_score", "1350", ["<1200", "1200 - 1390", "1400+"], { nearPosting: false, question: "SAT Score" })?.option).toBe("1200 - 1390");
  });

  it.each<[string, boolean, string[], string | null]>([
    ["age_18_or_older", true, ["Yes, I am at least 18 years of age.", "No, I am not at least 18 years of age."], "Yes, I am at least 18 years of age."],
    ["age_16_or_older", true, ["Yes, I am 16 or older", "No"], "Yes, I am 16 or older"],
    ["requires_sponsorship", false, ["Yes, I will require sponsorship for an employment-based visa status.", "No, I will not require sponsorship for an employment-based visa status."], "No, I will not require sponsorship for an employment-based visa status."],
    ["requires_sponsorship", false, ["Yes", "No, but I will need an OPT extension"], null],
    ["requires_sponsorship", false, ["Yes", "No, I am a U.S. citizen"], null],
    ["requires_sponsorship", false, ["OPT", "H1B", "TN", "None", "Other"], "None"],
    ["requires_sponsorship", false, ["J1", "F1", "None", "Other"], "None"],
    ["requires_sponsorship", false, ["None", "Other"], null],
    ["requires_sponsorship", true, ["OPT", "H1B", "None"], null],
    ["previously_worked_here", false, ["Yes, I have worked at Fixture Co", "No, I have never worked at Fixture Co"], "No, I have never worked at Fixture Co"],
    ["previously_worked_here", false, ["I have previously been employed at Fixture Co", "I have not previously been employed at Fixture Co"], "I have not previously been employed at Fixture Co"],
    ["previously_worked_here", false, ["I have not worked here", "I have not applied here"], null],
    ["previously_worked_here", false, ["No, but I interviewed here before", "Yes"], null],
    ["relatives_at_company", false, ["No, I have no relatives at Fixture Co", "Yes"], "No, I have no relatives at Fixture Co"],
    ["enrolled_full_time", true, ["Yes, I am a full-time undergraduate student", "No"], "Yes, I am a full-time undergraduate student"],
    ["enrolled_full_time", true, ["Yes, I am a full-time graduate student", "No"], null],
    ["work_arrangement", true, ["Yes, I can work on-site", "No"], "Yes, I can work on-site"],
    ["work_arrangement", true, ["Yes, but require relocation", "No"], null],
    ["work_arrangement", true, ["Yes, I live nearby", "No"], null],
    ["work_arrangement", true, ["Yes, I am fully remote-ready", "No"], null]
  ])("a saved %s %s picks its sentence option", (key, value, options, expected) => {
    expect(savedYesNoOption(key, value, options)).toBe(expected);
  });

  it("answers a U.S.-person Yes/No question only from a saved U.S.-person status and a question that requires it", () => {
    const required = "To comply with U.S. Government space technology export regulations, applicant must be a U.S. citizen, lawful permanent resident, or protected individual.";
    expect(usPersonYesNoOption(required, "us_person_export_controls", "U.S. citizen", ["Select One", "Yes", "No"])).toBe("Yes");
    expect(usPersonYesNoOption("Fixture Co must comply with ITAR. Are you a U.S. person?", "us_person_export_controls", "U.S. citizen", ["Yes, I comply with ITAR requirement.", "No, I do not comply with ITAR requirement."]))
      .toBe("Yes, I comply with ITAR requirement.");
    expect(usPersonYesNoOption(required, "us_person_export_controls", "None of the above", ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption(required, "us_citizen", "U.S. citizen", ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption("Have you lived in Iran? Applicant must be a U.S. citizen.", "us_person_export_controls", "U.S. citizen", ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption("Do you need an export license? Applicant must be a U.S. citizen or require an export license.", "us_person_export_controls", "U.S. citizen", ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption("Are you able to work on-site?", "us_person_export_controls", "U.S. citizen", ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption(required, "us_person_export_controls", "U.S. citizen", ["Yes, but I hold dual citizenship", "No"])).toBeNull();
  });

  it("answers a U.S.-citizen requirement only from a saved citizen status or a saved category the question itself names", () => {
    const required = "To comply with U.S. Government space technology export regulations, applicant must be a U.S. citizen, lawful permanent resident, or protected individual.";
    const citizenOnly = "Applicant must be a U.S. citizen. Do you meet this requirement?";
    const excluded = "Applicant must be a U.S. citizen; permanent residents are not eligible.";
    const itar = "Fixture Co must comply with ITAR. Are you a U.S. person?";
    const resident = "I am a lawful permanent resident of the United States";
    const asylee = "I am an asylee under 8 U.S.C. 1158";
    expect(exportControlCategory(resident)).toBe("permanent_resident");
    expect(exportControlCategory(asylee)).toBe("asylee");
    expect(usPersonYesNoOption(citizenOnly, "us_person_export_controls", resident, ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption("This role requires that you must be a U.S. citizen.", "us_person_export_controls", resident, ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption(required, "us_person_export_controls", resident, ["Yes", "No"])).toBe("Yes");
    expect(usPersonYesNoOption(excluded, "us_person_export_controls", resident, ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption(itar, "us_person_export_controls", resident, ["Yes", "No"])).toBe("Yes");
    expect(usPersonYesNoOption(required, "us_person_export_controls", asylee, ["Yes", "No"])).toBeNull();
    expect(usPersonYesNoOption(itar, "us_person_export_controls", asylee, ["Yes", "No"])).toBe("Yes");
    expect(usPersonYesNoOption(citizenOnly, "us_person_export_controls", "U.S. citizen", ["Yes", "No"])).toBe("Yes");
    expect(usPersonYesNoOption(excluded, "us_person_export_controls", "U.S. citizen", ["Yes", "No"])).toBe("Yes");
  });

  it("promotes a saved score answer only to its own test's key, with a valid value, never echoing it", () => {
    expect(promotableFactValue("sat_score", "SAT or ACT Score", "1350 (SAT)")).toEqual({ value: "1350" });
    expect(promotableFactValue("sat_score", "SAT Score", "1350")).toEqual({ value: "1350" });
    expect(promotableFactValue("act_score", "SAT or ACT Score", "1350 (SAT)")).toMatchObject({ reason: expect.any(String) });
    expect(promotableFactValue("sat_score", "SAT or ACT Score", "1350")).toMatchObject({ reason: expect.any(String) });
    expect(promotableFactValue("sat_score", "SAT Score", "1700")).toMatchObject({ reason: expect.any(String) });
    expect(promotableFactValue("act_score", "ACT Score", "31")).toEqual({ value: "31" });
    expect(promotableFactValue("act_score", "ACT Score", "40")).toMatchObject({ reason: expect.any(String) });
    expect(promotableFactValue("how_heard", "How did you hear?", "LinkedIn")).toMatchObject({ reason: expect.any(String) });
    const refused = promotableFactValue("sat_score", "SAT Score", "1700");
    expect("reason" in refused && refused.reason.includes("1700")).toBe(false);
  });
});
