import { describe, expect, it } from "vitest";

import { DeterministicQuestionMapper } from "@internship-agent/agent";
import { planAutofill, type FieldResolution, type PlannerInputs } from "@internship-agent/browser";
import type { BrowserField, FillDecision, QuestionContext } from "@internship-agent/domain";

/**
 * Track 89 regression corpus (2026-11-28): held term, on-site relocation, sponsorship, graduation, U.S.-person, and
 * education questions the saved answers or the profile settle. Wordings and option lists follow the held questions,
 * with company names and places replaced by fictional ones; every candidate value here is fictional.
 */

const mapper = new DeterministicQuestionMapper();
const US: QuestionContext = { postingCountryCode: "US", companyName: "Fixture Co" };
const keyOf = async (question: string, context: QuestionContext = US) => {
  const mapped = await mapper.map(question, context);
  return mapped.status === "MAPPED" ? mapped.key : mapped.status;
};

const PTC = "Do you currently require, or will you in the future require, employment-based immigration sponsorship?";

describe("held-question corpus: sponsorship and visa wordings (Track 89)", () => {
  it("maps the employment-based immigration sponsorship wording to the posting's country", async () => {
    expect(await mapper.map(PTC, US)).toMatchObject({ status: "MAPPED", key: "requires_sponsorship", scope: { kind: "country", code: "US" } });
    expect(await keyOf(PTC, { companyName: "Fixture Co" })).toBe("AMBIGUOUS");
    expect(await keyOf("Will you now or in the future require sponsorship to change your visa status?")).toBe("requires_sponsorship");
  });

  it("maps a current visa-class question to F-1 OPT, and keeps a negated one open", async () => {
    expect(await keyOf("Are you on EAD, OPT or CPT? Or need a H-1B visas transfer?", { ...US, fieldKind: "select" })).toBe("f1_optional_practical_training");
    expect(await keyOf("Are you currently on OPT?", { ...US, fieldKind: "select" })).toBe("f1_optional_practical_training");
    expect(await keyOf("Are you on EAD, OPT or CPT, but not on a visa transfer?", { ...US, fieldKind: "select" })).toBe("AMBIGUOUS");
  });
});

describe("held-question corpus: graduation wordings (Track 89)", () => {
  it("maps more graduation-date wordings", async () => {
    for (const question of [
      "When do you graduate?",
      "What year are you expected to graduate from University?",
      "Please select the year you anticipate graduating from your academic program.",
      "When do you expect to complete your current degree program? Please answer in MM/YYYY format (e.g. 08/2022)"
    ]) {
      expect(await keyOf(question), question).toBe("graduation_date");
    }
    expect(await keyOf("When did you begin your current degree program?")).not.toBe("graduation_date");
  });
});

describe("held-question corpus: U.S.-person and visa-status lists (Track 89)", () => {
  it("maps export-control and visa-status lists to the saved export-control status", async () => {
    const select = { ...US, fieldKind: "select" as const };
    expect(await keyOf("Are you a US Person under ITAR (22 CFR 120.62)? Please select appropriate response:", select)).toBe("us_person_export_controls");
    expect(await keyOf("Fixture Co must comply with U.S. export regulations, therefore will you state which of the following applies to you:", select)).toBe("us_person_export_controls");
    expect(await keyOf("If yes, please indicate Visa status", select)).toBe("us_person_export_controls");
    expect(await keyOf("What is your current visa status?", { ...US, fieldKind: "text" })).not.toBe("us_person_export_controls");
  });

  it("maps an excited-to-work-in-office question to the saved on-site answer", async () => {
    expect(await keyOf("Are you excited to work in-office in Fixture City five days a week?")).toBe("work_arrangement");
  });
});

const WINDOW = { start: "2031-05-20", end: "2031-08-20" };
const inputs = (resolutions: Map<string, FieldResolution> = new Map(), extra: Partial<PlannerInputs> = {}): PlannerInputs => ({
  profile: { fieldOfStudy: "Fixture Studies", gpa: "3.47" },
  resolutions,
  packageAnswers: [],
  variantId: null,
  education: { school: "Fixture State University", degree: "B.S. Fixture Engineering" },
  availability: WINDOW,
  ...extra
});
const decide = (field: BrowserField, planned: PlannerInputs = inputs()): FillDecision => {
  const plan = planAutofill({ url: "https://jobs.example.test/apply", title: "Apply", fields: [field] }, planned);
  return plan.decisions.find((decision) => decision.fieldId === field.id)!;
};
const select = (label: string, options: string[], kind: BrowserField["kind"] = "select"): BrowserField => ({ id: "q", label, kind, required: true, options });
const text = (label: string): BrowserField => ({ id: "q", label, kind: "text", required: true });

describe("planner: terms and availability (Track 89)", () => {
  it("answers term lists, a summer confirmation, and the dates box from the saved window", () => {
    expect(decide(select("Which internship term are you interested in?", ["Spring 2031", "Summer 2031", "Both"]))).toMatchObject({ action: "choose", value: "Summer 2031", basis: { kind: "fact", key: "available_start_date" } });
    expect(decide(select("I confirm my availability for a Summer 2031 (May/June starts) internship", ["Yes", "No"], "radio"))).toMatchObject({ action: "choose", value: "Yes" });
    expect(decide(text("Please list specific dates of internship availability- Include start date and end date."))).toMatchObject({ action: "fill", value: "05/20/2031 - 08/20/2031" });
  });

  it("pauses a term list with a span outside the window, and answers nothing without a window", () => {
    expect(decide(select("Which internship term are you interested in?", ["Winter/Spring (January - May 2031)", "Summer (May - September 2031)"])).action).toBe("pause");
    expect(decide(select("Which internship term are you interested in?", ["Spring 2031", "Summer 2031"]), inputs(new Map(), { availability: undefined })).action).toBe("pause");
  });
});

describe("planner: on-site questions answered with the relocating option (Track 89)", () => {
  const options = ["Yes, I currently live in the Fixture City area.", "Yes, I will relocate to the Fixture City area for the internship.", "No, I am unable to work onsite in Fixture City."];
  const label = "This internship is on-site in Fixture City 5 days a week. Are you able to work on-site?";
  const resolved = (usRelocation: boolean): Map<string, FieldResolution> => new Map([["q", {
    status: "RESOLVED", key: "work_arrangement", scope: "global", display: "Yes", value: true, ...(usRelocation ? { usRelocation: true as const } : {})
  }]]);

  it("picks the relocate option for a saved on-site Yes with a U.S.-wide relocation Yes", () => {
    expect(decide(select(label, options), inputs(resolved(true)))).toMatchObject({ action: "choose", value: options[1], basis: { kind: "fact", key: "work_arrangement" } });
  });

  it("still pauses without the U.S.-wide relocation Yes", () => {
    expect(decide(select(label, options), inputs(resolved(false))).action).toBe("pause");
  });
});

describe("planner: education fields (Track 89)", () => {
  it("fills school text boxes with the profile's school", () => {
    for (const label of ["Current school or university:", "Current university", "What college/university do you attend?", "What is the name of your university?"]) {
      expect(decide(text(label)), label).toMatchObject({ action: "fill", value: "Fixture State University", basis: { kind: "profile", field: "school" } });
    }
  });

  it("chooses Other on a short list that asks for it when the school is not listed", () => {
    const short = ["Sample Tech", "Example College", "Placeholder University", "North Campus", "Model Institute", "Test Polytechnic", "Mock University", "Demo College",
      "Sample State", "Trial University", "Pilot College", "Proto Institute", "Draft University", "Beta College", "Other"];
    const label = "Which university are you currently attending? Select \"Other\" if not listed";
    expect(decide(select(label, short))).toMatchObject({ action: "choose", value: "Other", basis: { kind: "profile", field: "school" } });
    const long = [...Array.from({ length: 499 }, (_, index) => `Sample School ${index + 1}`), "Other"];
    expect(decide(select(label, long)).action).toBe("pause");
    const sharing = short.map((option) => (option === "Mock University" ? "Fixture Univ. Main Campus" : option));
    expect(decide(select(label, sharing)).action).toBe("pause");
  });

  it("fills the field of study and the degree level being pursued", () => {
    expect(decide(text("What is your field of study/degree program?"))).toMatchObject({ action: "fill", value: "Fixture Studies", basis: { kind: "profile", field: "fieldOfStudy" } });
    expect(decide(select("What degree are you currently pursuing or have recently completed?", ["Bachelor's", "Master's", "PhD"]))).toMatchObject({ action: "choose", value: "Bachelor's" });
  });

  it("answers more GPA wordings from the profile GPA", () => {
    const cases: Array<[string, string[], string, BrowserField["kind"]]> = [
      ["Please indicate your overall GPA.", ["< 3.0", "3.0 - 3.4", "3.5 - 3.9", "4.0 - 4.4", "First-Class Honours", "Other / Not Applicable"], "3.0 - 3.4", "select"],
      ["What is your overall college/university GPA?", ["< 3.0", "3.01 - 3.25", "3.26 - 3.50", "3.51 - 3.75", "3.76 - 4.0"], "3.26 - 3.50", "select"],
      ["For your most recent degree, what is/was your GPA (normalized to a 4.0 scale)?", ["NA", "< 3.0", "3.0 -3.5", "3.6-4.0"], "3.0 -3.5", "select"],
      ["If you are currently enrolled in or have graduated from a university within the past 24 months, what is your current or final GPA?", ["4.0", "3.5 - 3.9", "3.0 - 3.4", "2.5 - 2.9", "Below 2.5"], "3.0 - 3.4", "radio"]
    ];
    for (const [label, options, expected, kind] of cases) {
      expect(decide(select(label, options, kind)), label).toMatchObject({ action: "choose", value: expected, basis: { kind: "profile", field: "gpa" } });
    }
  });

  it("chooses the 4.0 scale for a profile GPA of at most 4.0", () => {
    expect(decide(select("Please specify the grading scale used by your current school.", ["4.0 Scale", "5.0 Scale", "UK Grading System", "Other / Not Applicable"])))
      .toMatchObject({ action: "choose", value: "4.0 Scale", basis: { kind: "profile", field: "gpa" } });
    expect(decide(select("Please select the corresponding GPA scale:", ["0.0 - 4.0", "0.0 - 5.0", "UK Grading Scale"]))).toMatchObject({ action: "choose", value: "0.0 - 4.0" });
    const high = inputs(new Map(), { profile: { gpa: "4.20" } });
    expect(decide(select("Please select the corresponding GPA scale:", ["0.0 - 4.0", "0.0 - 5.0", "UK Grading Scale"]), high).action).toBe("pause");
  });
});

describe("planner: a bare-year graduation list (Track 89)", () => {
  it("picks the graduation year", () => {
    const resolved = new Map<string, FieldResolution>([["q", { status: "RESOLVED", key: "graduation_date", scope: "global", display: "2032-05-15", value: "2032-05-15" }]]);
    expect(decide(select("When will you be graduating?", ["2030", "2031", "2032", "2033"]), inputs(resolved))).toMatchObject({ action: "choose", value: "2032" });
  });
});
