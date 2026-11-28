import { describe, expect, it } from "vitest";

import { relocationOption, relocationQuestionParts, usPersonOption, usPersonYesNoOption } from "@internship-agent/domain";

/**
 * Track 83 (2026-11-28): held relocation and U.S.-person questions that the saved answers settle. The wordings are
 * the captured shapes of real held questions with fictional companies and places.
 */
const WHO_PAYS = "It also says who pays for the move or what support comes with it.";
const TEMPORARY = "It asks about a temporary move.";
const LATER = "It asks about a permanent move or one after the internship.";
const NEARBY = "It also asks whether you already live nearby or can commute.";
const FIXTURE_DYNAMICS = "Will you be willing to commute/drive or temporarily relocate to state/cities where there is a Fixture Dynamics office in your region during the program?NOTE: Fixture Dynamics does not provide relocation support or housing.";
const ON_YOUR_OWN = "At this time we do not offer relocation assistance to interns. If hired, are you able to relocate on your own if you are not based locally?";

describe("relocation question parts (Track 83)", () => {
  it("reads a conditional nearby part like the \"or\" form", () => {
    expect(relocationQuestionParts("If you do not live in the Fixture Bay area, are you able to relocate?"))
      .toEqual({ onSite: false, local: true, held: null });
    expect(relocationQuestionParts("If you do not currently live a commutable distance, are you able to relocate for the summer for this intern position?").held).toBeNull();
  });

  it("does not hold who pays for the own-expense question, and still does for the plain one", () => {
    expect(relocationQuestionParts(ON_YOUR_OWN, { ownExpense: true })).toEqual({ onSite: false, local: true, held: null });
    expect(relocationQuestionParts(ON_YOUR_OWN).held).toBe(WHO_PAYS);
  });

  it("answers a temporary move for the program, never one after the internship or an untied temporary move", () => {
    expect(relocationQuestionParts(FIXTURE_DYNAMICS, { ownExpense: true }).held).toBeNull();
    expect(relocationQuestionParts("Would you be willing to temporarily relocate?").held).toBe(TEMPORARY);
    expect(relocationQuestionParts("Are you able to relocate to any of the locations below following the end of the internship, at Fixture's discretion?").held).toBe(LATER);
    expect(relocationQuestionParts("Would you relocate after the internship to join full time?").held).toBe(LATER);
  });

  it("still holds living nearby asked alongside relocating without a condition", () => {
    expect(relocationQuestionParts("Do you live within 50 miles of Fixture Bay and are you willing to relocate?").held).toBe(NEARBY);
  });
});

describe("relocation willingness options (Track 83)", () => {
  const OPTIONS = ["Select One", "I can commute/drive", "I am willing to temporarily relocate", "I cannot commute/drive nor willing to relocate"];

  it("takes the one stated-willingness option for a saved Yes", () => {
    expect(relocationOption(true, OPTIONS, false)).toEqual({ option: "I am willing to temporarily relocate", local: false });
  });

  it("returns null for two willingness options or a saved No", () => {
    expect(relocationOption(true, [...OPTIONS, "I'm open to relocating"], false)).toBeNull();
    expect(relocationOption(false, OPTIONS, false)).toBeNull();
  });
});

describe("U.S.-person options defined in the option text (Track 83)", () => {
  // Captured shape: plural category words only.
  const US_PERSON = "U.S. person. This status includes U.S. citizens, U.S. nationals, lawful permanent residents (green card holders), and asylums and refugees with such status granted, not pending.";
  const FOREIGN_PERSON = "Foreign person. This status includes everyone who is not a U.S. person, including foreign nationals with pending applications.";
  const OPTIONS = ["Select...", US_PERSON, FOREIGN_PERSON];

  it("picks the defined U.S.-person option for a saved citizen or permanent-resident status", () => {
    expect(usPersonOption("A United States citizen or national", OPTIONS)).toBe(US_PERSON);
    expect(usPersonOption("Permanent resident", OPTIONS)).toBe(US_PERSON);
  });

  it("never answers a saved none status or two defined U.S.-person options", () => {
    expect(usPersonOption("None of the above", OPTIONS)).toBeNull();
    expect(usPersonOption("A United States citizen or national", [US_PERSON, "U.S. person, which includes U.S. citizens and U.S. nationals.", FOREIGN_PERSON])).toBeNull();
  });

  it("answers a Yes/No question about U.S.-person status \"including\" its categories", () => {
    const options = ["Yes, I comply with ITAR requirement.", "No, I do not comply with ITAR requirement."];
    const asked = "Fixture Co works under U.S. export regulations (ITAR). As such, US person status (including US citizens, U.S. permanent residents, individuals granted U.S. asylum status) is required for this role.";
    expect(usPersonYesNoOption(asked, "us_person_export_controls", "A United States citizen or national", options)).toBe("Yes, I comply with ITAR requirement.");
    expect(usPersonYesNoOption(`${asked} A foreign person needs an export license.`, "us_person_export_controls", "A United States citizen or national", options)).toBeNull();
  });
});
