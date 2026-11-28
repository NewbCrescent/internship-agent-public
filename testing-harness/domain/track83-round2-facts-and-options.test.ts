import { describe, expect, it } from "vitest";

import { availabilityWindowHold, factOption, standardAnswerOption, statedDateRange, statedLengthDays } from "@internship-agent/domain";

/**
 * Track 83, round 2 (2026-11-28): full-time availability windows, the "did not take the ACT" option, county options,
 * and the plain none option of a clearance-level list. Option lists are the captured shapes of real held questions;
 * every date and place here is fictional.
 */
const WINDOW = { start: "2031-05-15", end: "2031-08-15" };
const OUTSIDE = "It states dates outside your saved availability, or your availability dates are not saved.";
const LENGTH = "It states a length your saved availability does not cover.";
const UNREAD = "It states dates the agent cannot compare with your saved availability.";

describe("statedDateRange (Track 83)", () => {
  it("reads two full dates with years as an ISO range", () => {
    expect(statedDateRange("Are you able to commit to a full-time internship (40 hours per week) from May 24, 2031 - August 13, 2031?"))
      .toEqual({ from: "2031-05-24", to: "2031-08-13" });
    expect(statedDateRange("Are you available to work full-time (40 hours per week) between June 7, 2031 - August 13, 2031?"))
      .toEqual({ from: "2031-06-07", to: "2031-08-13" });
    expect(statedDateRange("Can you work full time from 5/24/2031 to 8/13/2031?")).toEqual({ from: "2031-05-24", to: "2031-08-13" });
    expect(statedDateRange("Available from Sept 2nd, 2031 to Dec. 1st 2031?")).toEqual({ from: "2031-09-02", to: "2031-12-01" });
  });

  it("is null for one date, a date without a year, or a reversed range", () => {
    expect(statedDateRange("Can you start on May 24, 2031?")).toBeNull();
    expect(statedDateRange("Can you work from May 24 - August 13, 2031?")).toBeNull();
    expect(statedDateRange("Can you work from August 13, 2031 - May 24, 2031?")).toBeNull();
    expect(statedDateRange("Can you work from February 30, 2031 - May 24, 2031?")).toBeNull();
  });
});

describe("statedLengthDays (Track 83)", () => {
  it("reads one stated length in days", () => {
    expect(statedLengthDays("Are you available for a 12-week full-time (40 hours per week) internship during your select term(s)?")).toBe(84);
    expect(statedLengthDays("Can you work full time for 10 weeks?")).toBe(70);
    expect(statedLengthDays("Can you work full time for three months?")).toBe(90);
  });

  it("is null without a length; hours per week are not a length", () => {
    expect(statedLengthDays("Are you available to work full-time (40 hours per week)?")).toBeNull();
    expect(statedLengthDays("Can you work 10 weeks or 12 weeks?")).toBeNull();
  });
});

describe("availabilityWindowHold (Track 83)", () => {
  it("answers a range inside the saved window and holds one outside it or without saved dates", () => {
    expect(availabilityWindowHold("Can you work full time from May 24, 2031 - August 13, 2031?", WINDOW, true)).toBeNull();
    expect(availabilityWindowHold("Can you work full time from May 24, 2031 - August 29, 2031?", WINDOW, true)).toBe(OUTSIDE);
    expect(availabilityWindowHold("Can you work full time from May 24, 2031 - August 13, 2031?", { start: WINDOW.start, end: null }, true)).toBe(OUTSIDE);
  });

  it("answers a length that fits the window and holds a longer one", () => {
    expect(availabilityWindowHold("Are you available for a 12-week full-time internship?", WINDOW, true)).toBeNull();
    expect(availabilityWindowHold("Are you available for a 16-week full-time internship?", WINDOW, true)).toBe(LENGTH);
  });

  it("holds date words it cannot read as a range", () => {
    expect(availabilityWindowHold("Can you work full time starting in June 2031?", WINDOW, true)).toBe(UNREAD);
  });

  it("lets a saved No answer only a question without dates", () => {
    expect(availabilityWindowHold("Can you work full time from May 24, 2031 - August 13, 2031?", WINDOW, false)).toBe(OUTSIDE);
    expect(availabilityWindowHold("Are you available to work full time?", WINDOW, false)).toBeNull();
    expect(availabilityWindowHold("Are you available to work full time? You may be asked to travel.", WINDOW, true)).toBeNull();
  });
});

const CONTEXT = { nearPosting: false };

describe("act_taken options (Track 83)", () => {
  it("picks the one did-not-take option of both captured shapes", () => {
    expect(factOption("act_taken", false, ["Select...", "Did not take/Do not recall", "36 out of 36", "35 out of 36"], CONTEXT))
      .toEqual({ option: "Did not take/Do not recall", reason: "You have not taken the ACT (your saved answer)." });
    expect(factOption("act_taken", false, ["I don’t have ACT score", "<30", "31", "32"], CONTEXT)?.option).toBe("I don’t have ACT score");
  });

  it("is null for two not-taken options, or a saved Yes", () => {
    expect(factOption("act_taken", false, ["N/A", "Did not take", "31"], CONTEXT)).toBeNull();
    expect(factOption("act_taken", true, ["Did not take", "31"], CONTEXT)).toBeNull();
  });
});

describe("county options (Track 83)", () => {
  it("matches a state-suffixed option only with the profile's state", () => {
    const options = ["Ada, ID", "Fixture, CA", "Fixture, WY"];
    expect(factOption("county", "Fixture County", options, { ...CONTEXT, regionCode: "CA" }))
      .toEqual({ option: "Fixture, CA", reason: "The county of your saved address." });
    expect(factOption("county", "Fixture County", options, CONTEXT)).toBeNull();
  });

  it("matches a plain list by name", () => {
    expect(factOption("county", "Fixture County", ["Fixture", "Alpine"], CONTEXT)?.option).toBe("Fixture");
    expect(factOption("county", "Fixture", ["Fixture County", "Alpine County"], CONTEXT)?.option).toBe("Fixture County");
  });
});

describe("clearance none option (Track 83)", () => {
  it("picks the one plain none option of a clearance-level list for a saved No", () => {
    const levels = ["Confidential", "DOE \"L\"", "DOE \"Q\"", "Public Trust", "Secret", "Top Secret", "TS/SCI", "TS/SCI w/Poly SP", "Yankee White", "None of the Above"];
    expect(standardAnswerOption("holds_security_clearance", false, levels)).toBe("None of the Above");
    expect(standardAnswerOption("holds_security_clearance", false, ["Select One", "None/Not Required", "Public Trust", "Secret", "Top Secret", "TS/SCI"]))
      .toBe("None/Not Required");
  });

  it("is null when the none options say more, or the list names no level", () => {
    expect(standardAnswerOption("holds_security_clearance", false, ["Secret", "Top Secret", "Expired Clearance", "Never held a clearance", "Do not wish to disclose"])).toBeNull();
    expect(standardAnswerOption("holds_security_clearance", false, ["None", "Other"])).toBeNull();
    expect(standardAnswerOption("holds_security_clearance", true, ["Secret", "Top Secret", "None of the Above"])).toBeNull();
  });
});
