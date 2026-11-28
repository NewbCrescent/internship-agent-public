import { describe, expect, it } from "vitest";

import {
  factOption,
  internshipTermAnswer,
  isInternshipTermQuestion,
  onSiteRelocationOption,
  questionSaveBlocker,
  relocationOption,
  relocationQuestionParts,
  savedYesNoOption,
  usPersonOption,
  usPersonYesNoOption,
  withoutCoveredTerm,
  type BrowserField
} from "@internship-agent/domain";

/**
 * Track 89 (2026-11-28): term and availability questions, on-site relocation options, sponsorship, graduation,
 * U.S.-person and score-scale options the saved answers settle. The shapes follow held questions; the companies,
 * places, dates, and scores are fictional.
 */
const WINDOW = { start: "2031-05-20", end: "2031-08-20" };
const field = (label: string, kind: BrowserField["kind"], options?: string[]): Pick<BrowserField, "label" | "kind" | "options" | "widget"> =>
  ({ label, kind, ...(options ? { options } : {}) });
const choose = (value: string) => ({ action: "choose", value });

describe("internship term questions (Track 89)", () => {
  it("recognizes term and season wordings, not graduation, semester, or why-interest questions", () => {
    for (const label of [
      "Which internship term are you interested in?",
      "Which term(s) are you applying for?",
      "Are you interested in Spring Co-Op, Summer Internship, or Both?",
      "Are you applying for Winter 2031 or Summer 2031?",
      "Please confirm the season you are applying for.",
      "Work term availability"
    ]) {
      expect(isInternshipTermQuestion(label), label).toBe(true);
    }
    for (const label of ["What is your expected graduation term?", "Which semester are you currently in?", "Why are you interested in this internship?"]) {
      expect(isInternshipTermQuestion(label), label).toBe(false);
    }
  });

  it("picks the one summer term the saved window falls in", () => {
    const term = "Which internship term are you interested in?";
    expect(internshipTermAnswer(field(term, "select", ["Spring 2031", "Summer 2031", "Both"]), WINDOW)).toMatchObject(choose("Summer 2031"));
    expect(internshipTermAnswer(field("Are you interested in Spring Co-Op, Summer Internship, or Both?", "radio", ["Spring 2031 Co-Op", "Summer 2031 Internship", "Both"]), WINDOW))
      .toMatchObject(choose("Summer 2031 Internship"));
    expect(internshipTermAnswer(field("Which term(s) are you applying for?", "checkbox", ["Fall 2030", "Spring 2031", "Summer 2031"]), WINDOW)).toMatchObject(choose("Summer 2031"));
    expect(internshipTermAnswer(field("Are you applying for Winter 2031 or Summer 2031?", "radio", ["Summer 2031", "Winter 2031"]), WINDOW)).toMatchObject(choose("Summer 2031"));
    expect(internshipTermAnswer(field(term, "select", ["Winter (January - May)", "Summer (May - August)"]), WINDOW)).toMatchObject(choose("Summer (May - August)"));
    expect(internshipTermAnswer(field("Please confirm the season you are applying for.", "select", ["Summer 2031"]), WINDOW)).toMatchObject(choose("Summer 2031"));
    expect(internshipTermAnswer(field(term, "select", ["Summer 2030", "Summer 2031"]), WINDOW)).toMatchObject(choose("Summer 2031"));
  });

  it("pauses on stated spans or dates outside the window and on windows that are not one summer", () => {
    const term = "Which internship term are you interested in?";
    expect(internshipTermAnswer(field(term, "select", ["Winter/Spring (January - May 2031)", "Summer (May - September 2031)"]), WINDOW)).toBeNull();
    expect(internshipTermAnswer(field(term, "select", ["Spring 2031 (January 11th - April 30th, 2031)", "Summer 2031 (May 10th - August 20th, 2031)"]), WINDOW)).toBeNull();
    expect(internshipTermAnswer(field(term, "select", ["Spring 2031", "Summer 2031"]), { start: "2031-01-10", end: "2031-04-30" })).toBeNull();
    expect(internshipTermAnswer(field(term, "select", ["Spring 2031", "Summer 2031"]), { start: "2031-05-20", end: null })).toBeNull();
    expect(internshipTermAnswer(field(term, "select", ["Spring 2031", "Summer 2031"]), undefined)).toBeNull();
  });

  it("answers Yes to a summer availability confirmation the window covers", () => {
    expect(internshipTermAnswer(field("I confirm my availability for a Summer 2031 (May/June starts) internship", "select", ["Yes", "No"]), WINDOW)).toMatchObject(choose("Yes"));
    expect(internshipTermAnswer(field("I confirm my availability for a Summer 2031 (May/June starts) internship", "checkbox"), WINDOW)).toMatchObject({ action: "check", value: "true" });
    expect(internshipTermAnswer(field("Are you available to commit to a Summer internship from May - August 2031?", "radio", ["Yes", "No"]), WINDOW)).toMatchObject(choose("Yes"));
    for (const label of [
      "Are you available for the entire duration of the internship? (June 1st to August 31st)",
      "Are you available to commit to a Summer internship from May - September 2031?",
      "Are you available to commit to a Summer internship and relocate to Fixture City?"
    ]) {
      expect(internshipTermAnswer(field(label, "radio", ["Yes", "No"]), WINDOW), label).toBeNull();
    }
  });

  it("types the window into an internship availability dates box", () => {
    expect(internshipTermAnswer(field("Please list specific dates of internship availability- Include start date and end date.", "text"), WINDOW))
      .toMatchObject({ action: "fill", value: "05/20/2031 - 08/20/2031" });
  });

  it("removes only the covered term and spans", () => {
    expect(withoutCoveredTerm("Can you relocate to Fixture City for the internship (June-August)?", WINDOW)).toBe("Can you relocate to Fixture City for the internship?");
    expect(withoutCoveredTerm("Are you willing to relocate to Fixture City at your own expense (Summer 2031)?", WINDOW)).toBe("Are you willing to relocate to Fixture City at your own expense?");
    expect(withoutCoveredTerm("Can you relocate to Fixture City (May - September)?", WINDOW)).toContain("(May - September)");
    expect(withoutCoveredTerm("Can you relocate (June-August)?", undefined)).toBe("Can you relocate (June-August)?");
  });

  it("remembers a term question's answer (not a why-interest question)", () => {
    expect(questionSaveBlocker({ label: "Which internship term are you interested in?", fieldKind: "select" })).not.toBe("why_interest");
    expect(questionSaveBlocker({ label: "Why are you interested in Fixture Co?", fieldKind: "textarea" })).toBe("why_interest");
  });
});

describe("on-site relocation options (Track 89)", () => {
  const relocate = "Yes, I will relocate to the Fixture City area for the internship.";
  it("picks the one relocating Yes option", () => {
    expect(onSiteRelocationOption(["Yes, I currently live in the Fixture City area.", relocate, "No, I am unable to work onsite in Fixture City for the full internship."], WINDOW)).toBe(relocate);
    const either = "Yes, I am available to work in / relocate to Fixture City, CA or Sample Town, NY for Summer 2031";
    expect(onSiteRelocationOption([either, "No"], WINDOW)).toBe(either);
  });

  it("returns null for relocation help, several relocating options, or another year", () => {
    expect(onSiteRelocationOption(["Yes, I will relocate to Fixture City with relocation assistance", "No"], WINDOW)).toBeNull();
    expect(onSiteRelocationOption([relocate, "Yes, I can relocate to Sample Town.", "No"], WINDOW)).toBeNull();
    expect(onSiteRelocationOption(["Yes, I will relocate to Fixture City for Summer 2030", "No"], WINDOW)).toBeNull();
  });

  it("reads the role's own location apart from where the candidate lives", () => {
    expect(relocationQuestionParts("This role is located in Fixture City and we require you to be in the office at least 50% of the work week. Are you willing to relocate to Fixture City?"))
      .toMatchObject({ held: null, onSite: true });
  });

  it("reads an arrange-my-own-relocation option as the own-expense option", () => {
    const arrange = "Yes, I will arrange my own relocation to Fixture City for the full internship";
    expect(relocationOption(true, ["Yes, I already live in or near Fixture City", arrange, "No, I am unable to work on-site in Fixture City"], false))
      .toEqual({ option: arrange, local: false });
  });
});

describe("graduation, score, sponsorship, and U.S.-person options (Track 89)", () => {
  it("picks a bare graduation year and a month-span term", () => {
    expect(factOption("graduation_date", "2032-05-15", ["2030", "2031", "2032", "2033"], { nearPosting: false })?.option).toBe("2032");
    expect(factOption("graduation_date", "2032-05-15", ["Sept - Dec 2031", "Jan - April 2032", "May - Aug 2032", "Sept - Dec 2032", "Other"], { nearPosting: false })?.option)
      .toBe("May - Aug 2032");
  });

  it("reads a SAT list on the saved test's own scale", () => {
    const options = [
      "Did not take/Do not recall", "1300-1349 out of 1600", "1250-1299 out of 1600", "1200-1249 out of 1600", "Below 1200 out of 1600", "------",
      "1600-1649 out of 2400", "1550-1599 out of 2400", "Below 1500 out of 2400"
    ];
    expect(factOption("sat_score", "1250", options, { nearPosting: false })?.option).toBe("1250-1299 out of 1600");
  });

  it("reads Not applicable on a visa-kind list as no sponsorship", () => {
    expect(savedYesNoOption("requires_sponsorship", false, ["CPT", "OPT", "TN (Fixture visa)", "J-1", "Other", "I don't know", "Not applicable"])).toBe("Not applicable");
  });

  it("answers a one-of-the-following U.S.-person Yes/No and a defined U.S.-person option", () => {
    const question = "Fixture Co works on export-controlled technology. Are you one of the following: a U.S. citizen, a U.S. national, a lawful permanent resident, a refugee, or an asylee?";
    expect(usPersonYesNoOption(question, "us_person_export_controls", "U.S. citizen or national", ["Yes", "No"])).toBe("Yes");
    const usPerson = "U.S. person. This ITAR/EAR status includes U.S. citizens, lawful permanent residents, refugees, and asylees.";
    expect(usPersonOption("U.S. citizen or national", [usPerson, "Foreign person. This ITAR/EAR status includes anyone who is not a U.S. person."])).toBe(usPerson);
  });
});
