import { describe, expect, it } from "vitest";

import {
  candidateFactSchema,
  chooseDegreeOption,
  factOption,
  internshipCountOption,
  isPriorInternshipCountQuestion,
  parseFactAnswer,
  priorInternshipThreshold,
  savedYesNoOption,
  type EducationRow
} from "@internship-agent/domain";

/**
 * Track 87 (2026-11-28): the number of previous internships, outstanding offers, and the Greenhouse "Degree" list that
 * offers "Bachelors" beside "Bachelor's Degree". Option lists are the captured shapes of real held questions; every
 * value here is fictional.
 */

const NOW = "2026-11-28T00:00:00.000Z";
const fact = (key: string, value: boolean | string, valueType: "boolean" | "text") => ({
  id: "fact-1", candidateId: "local", key, scope: { kind: "global" }, value, valueType, source: "user",
  sourceDetail: { kind: "profile" }, confidence: 1, sensitivity: "standard", reusePolicy: "auto",
  rememberedAt: NOW, createdAt: NOW, supersededAt: null, supersededById: null, revokedAt: null
});

describe("prior_internships_count and has_outstanding_offers facts (Track 87)", () => {
  it("saves a one- or two-digit count as text and a Yes/No for outstanding offers, both global", () => {
    expect(candidateFactSchema.safeParse(fact("prior_internships_count", "4", "text")).success).toBe(true);
    expect(candidateFactSchema.safeParse(fact("prior_internships_count", "four", "text")).success).toBe(false);
    expect(candidateFactSchema.safeParse(fact("prior_internships_count", "100", "text")).success).toBe(false);
    expect(candidateFactSchema.safeParse({ ...fact("prior_internships_count", "4", "text"), scope: { kind: "country", code: "US" } }).success).toBe(false);
    expect(candidateFactSchema.safeParse(fact("has_outstanding_offers", true, "boolean")).success).toBe(true);
    expect(candidateFactSchema.safeParse({ ...fact("has_outstanding_offers", true, "boolean"), source: "verified_evidence" }).success).toBe(false);
    expect(parseFactAnswer("prior_internships_count", " 4 ")).toBe("4");
    expect(parseFactAnswer("has_outstanding_offers", "yes")).toBe(true);
  });
});

describe("internship-count wordings (Track 87)", () => {
  it("reads how-many and number-of wordings with no other qualifier", () => {
    for (const question of [
      "How many internships have you completed before this summer?",
      "How many internships have you completed?",
      "How many previous internships have you had?",
      "Number of prior internships",
      "Number of internships completed*"
    ]) {
      expect(isPriorInternshipCountQuestion(question), question).toBe(true);
    }
    for (const question of [
      "How many software engineering internships have you completed?",
      "How many internships or co-ops have you completed?",
      "How many internships have you completed at Fixture Co?",
      "How many hours per week can you work?"
    ]) {
      expect(isPriorInternshipCountQuestion(question), question).toBe(false);
    }
  });

  it("reads the number an at-least Yes/No asks for", () => {
    expect(priorInternshipThreshold("Have you completed at least one previous internship?")).toBe(1);
    expect(priorInternshipThreshold("Have you completed at least two internships?")).toBe(2);
    expect(priorInternshipThreshold("Have you ever completed an internship before?")).toBe(1);
    expect(priorInternshipThreshold("Have you ever interned before?")).toBe(1);
    expect(priorInternshipThreshold("Do you have any prior internship experience?")).toBe(1);
    expect(priorInternshipThreshold("Have you completed an internship at Fixture Co?")).toBeNull();
    expect(priorInternshipThreshold("Have you completed a software engineering internship?")).toBeNull();
    expect(priorInternshipThreshold("How many internships have you completed?")).toBeNull();
  });
});

describe("internship-count options (Track 87)", () => {
  it("takes the one count option holding the saved number", () => {
    expect(internshipCountOption(4, ["0", "1", "2", "3+"])).toBe("3+");
    expect(internshipCountOption(0, ["None", "1", "2", "3 or more"])).toBe("None");
    expect(internshipCountOption(1, ["0", "1-2", "3-4", "5+"])).toBe("1-2");
    expect(internshipCountOption(4, ["One internship", "Two internships", "More than 3"])).toBe("More than 3");
  });

  it("is null for one count option, or several holding the number", () => {
    expect(internshipCountOption(4, ["4"])).toBeNull();
    expect(internshipCountOption(2, ["1-2", "2-3"])).toBeNull();
    expect(internshipCountOption(4, ["0", "1", "2"])).toBeNull();
  });

  it("answers an at-least Yes/No from the saved number, and a count list by its bucket", () => {
    const context = (question: string) => ({ nearPosting: false, question });
    expect(factOption("prior_internships_count", "4", ["Yes", "No"], context("Have you completed at least one previous internship?")))
      .toMatchObject({ option: "Yes" });
    expect(factOption("prior_internships_count", "0", ["Yes", "No"], context("Have you completed at least one previous internship?")))
      .toMatchObject({ option: "No" });
    expect(factOption("prior_internships_count", "1", ["Yes", "No"], context("Have you completed at least two internships?")))
      .toMatchObject({ option: "No" });
    expect(factOption("prior_internships_count", "4", ["0", "1", "2", "3+"], context("How many internships have you completed?")))
      .toMatchObject({ option: "3+" });
    expect(factOption("prior_internships_count", "4", ["Yes, one", "Yes, more than one", "No"], context("Have you completed at least one previous internship?")))
      .toBeNull();
  });
});

describe("outstanding-offers sentence options (Track 87)", () => {
  it("takes the one plain No sentence for a saved No, never a qualified one", () => {
    expect(savedYesNoOption("has_outstanding_offers", false, ["Yes, I have outstanding offers", "No, I do not have any outstanding offers"]))
      .toBe("No, I do not have any outstanding offers");
    expect(savedYesNoOption("has_outstanding_offers", false, ["Yes", "No, but I expect one soon"])).toBeNull();
  });
});

describe("degree lists (Track 87)", () => {
  const college: EducationRow = { key: "college", school: "Example State University", level: "bachelor", degree: "B.A. Computer Science", fieldOfStudy: null, gpa: null, startYear: null, endYear: null };
  // Greenhouse's education Degree list, as stored on the held runs.
  const GREENHOUSE = ["Accelerated Master's", "Advanced Certificate", "Associates", "Associate's Degree", "Bachelors", "Bachelor's Degree", "Certificate",
    "Community / Technical College", "Doctorate", "Doctor of Medicine (M.D.)", "Doctor of Philosophy (Ph.D.)", "Engineer's Degree", "High School",
    "Juris Doctor (J.D.)", "Master of Business Administration (M.B.A.)", "Masters", "Master's Degree", "Master's of Business Administration",
    "Non-Degree Seeking", "Other", "Postdoctoral Studies", "Technical Diploma"];

  it("takes the first spelling of the one general bachelor's answer on Greenhouse's list", () => {
    expect(chooseDegreeOption(college, GREENHOUSE)).toBe("Bachelors");
    expect(chooseDegreeOption({ ...college, degree: "B.S. Computer Science" }, GREENHOUSE)).toBe("Bachelors");
    expect(chooseDegreeOption(college, ["Bachelor’s Degree", "Bachelors", "Masters"])).toBe("Bachelor’s Degree");
  });

  it("still asks when general options differ in another word, and never takes a B.S. for a B.A.", () => {
    expect(chooseDegreeOption(college, ["Bachelor's Degree", "Bachelor's Level Degree"])).toBeNull();
    expect(chooseDegreeOption(college, ["Bachelors", "Bachelor's Degree (completed)"])).toBeNull();
    expect(chooseDegreeOption(college, ["High School", "BS", "B.S.", "Bachelor of Science", "MS"])).toBeNull();
    expect(chooseDegreeOption(college, ["High School", "Bachelor's", "Master's"])).toBe("Bachelor's");
    expect(chooseDegreeOption(college, ["Associate's", "Bachelor of Arts", "Bachelor of Science"])).toBe("Bachelor of Arts");
    expect(chooseDegreeOption({ ...college, degree: "B.S. Computer Science" }, ["High School", "B.S.", "M.S."])).toBe("B.S.");
  });

  it("takes the one plain Undergraduate option of a list naming no bachelor's", () => {
    expect(chooseDegreeOption(college, ["High School", "Undergraduate", "Graduate", "PhD"])).toBe("Undergraduate");
    expect(chooseDegreeOption(college, ["Undergraduate Degree", "Graduate Degree"])).toBe("Undergraduate Degree");
    expect(chooseDegreeOption(college, ["Undergraduate", "Undergraduate Student", "Graduate"])).toBeNull();
    expect(chooseDegreeOption(college, ["Undergraduate", "BS", "Graduate"])).toBeNull();
    expect(chooseDegreeOption(college, ["Undergraduate (Associate's)", "Graduate"])).toBeNull();
    expect(chooseDegreeOption(college, ["Undergraduate", "Undergraduate (4-year)", "Master's Degree"])).toBeNull();
  });
});
