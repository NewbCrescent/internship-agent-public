import { describe, expect, it } from "vitest";

import { agreeOption, factOption, graduationRangeOption, graduationTermMonths, graduationTermOption, relocationOption, samePlace, savedYesNoOption, startBucketOption, startWindowDays } from "@internship-agent/domain";

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
    expect(savedYesNoOption("willing_to_relocate", true, ["Yes: I live nearby or the role is remote", "Yes: I am willing to relocate", "No"])).toBeNull();
    expect(savedYesNoOption("willing_to_relocate", true, ["Yes, at my own expense", "No"])).toBeNull();
  });

  it("decides no other key and no string value", () => {
    expect(savedYesNoOption("requires_sponsorship", true, AUTHORIZED)).toBeNull();
    expect(savedYesNoOption("authorized_to_work", "yes", AUTHORIZED)).toBeNull();
  });
});
