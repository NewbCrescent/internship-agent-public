import { describe, expect, it } from "vitest";

import { agreeOption, factOption, relocationOption, samePlace, startBucketOption, startWindowDays } from "@internship-agent/domain";

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
