import { describe, expect, it } from "vitest";

import {
  booleanOption,
  candidateFactSchema,
  exportControlCategoriesOf,
  exportControlCategory,
  isStandardAnswerKey,
  matchExportControlOption,
  postingPayAnswer,
  restrictiveCovenantActive,
  standardAnswerOption,
  standardAnswersFileSchema,
  usCitizenOption,
  usPersonOption,
  type PostingPay
} from "@internship-agent/domain";

/** Fictional answers only; never anyone's real ones. */
const EXPORT_OPTIONS = [
  "U.S. citizen or national",
  "U.S. lawful permanent resident (green card holder)",
  "Refugee under 8 U.S.C. 1157",
  "Asylee under 8 U.S.C. 1158",
  "None of the above"
];
const CITIZEN_TEXT = "A United States citizen or national";

const file = {
  us_citizen: true,
  us_person_export_controls: CITIZEN_TEXT,
  security_clearance_eligible: true,
  holds_security_clearance: false,
  criminal_conviction: false,
  government_debarment_or_exclusion: false,
  non_compete: false,
  non_solicitation: {
    answer: true,
    explanation: "I agreed not to solicit my previous employer's clients for twelve months after leaving.",
    ends: "2027-03-31",
    name_former_employer: false,
    combined_non_compete_or_non_solicit_question: true,
    agreement_restricts_this_job: false,
    confirmed: "Confirmed by the fixture candidate in a test."
  },
  conflict_of_interest: false,
  relative_government_official: false,
  immediate_family_health_care_professional: false,
  lives_within_50_miles_of_san_francisco: true,
  salary_expectation: "Use the posting's pay as an hourly rate.",
  preferred_first_name: "Sam",
  concerns_working_on_dod_projects: false
};

const pay = (period: PostingPay["period"], minimum: number | null, maximum: number | null, currency = "USD"): PostingPay =>
  ({ minimum, maximum, currency, period });

describe("export-control status options", () => {
  it("chooses the one option naming the saved status's category", () => {
    expect(exportControlCategory(CITIZEN_TEXT)).toBe("citizen_or_national");
    expect(matchExportControlOption(CITIZEN_TEXT, EXPORT_OPTIONS)).toBe("U.S. citizen or national");
    expect(matchExportControlOption("Refugee", EXPORT_OPTIONS)).toBe("Refugee under 8 U.S.C. 1157");
    expect(matchExportControlOption("None of the above", EXPORT_OPTIONS)).toBe("None of the above");
    const protectedList = [...EXPORT_OPTIONS.slice(0, 4), "Protected individual as defined by 8 U.S.C. 1324b(a)(3)", "None of the above"];
    expect(matchExportControlOption("Protected individual", protectedList)).toBe("Protected individual as defined by 8 U.S.C. 1324b(a)(3)");
    expect(matchExportControlOption(CITIZEN_TEXT, protectedList)).toBe("U.S. citizen or national");
  });

  it("never picks a combined option, and gives null without a match", () => {
    expect([...exportControlCategoriesOf("Refugee or asylee")].sort()).toEqual(["asylee", "refugee"]);
    expect(matchExportControlOption("Refugee", ["U.S. citizen", "Refugee or asylee", "None of the above"])).toBeNull();
    expect(matchExportControlOption(CITIZEN_TEXT, ["Option A", "Option B"])).toBeNull();
    expect(matchExportControlOption("Something else entirely", EXPORT_OPTIONS)).toBeNull();
  });

  it("reads non-citizen options as none, never as the citizen option", () => {
    for (const option of ["Non-U.S. citizen", "Not a U.S. citizen or national"]) {
      expect([...exportControlCategoriesOf(option)], option).toEqual(["none"]);
      expect(matchExportControlOption(CITIZEN_TEXT, [option, "None of the above"]), option).toBeNull();
      expect(usCitizenOption([option, "Permanent Resident"]), option).toBeNull();
    }
    expect(matchExportControlOption(CITIZEN_TEXT, ["Non-U.S. citizen", "U.S. citizen", "Not a U.S. citizen or national"])).toBe("U.S. citizen");
  });

  it("finds the single U.S. citizen option of a citizenship list", () => {
    expect(usCitizenOption(["U.S. Citizen", "Permanent Resident", "Other"])).toBe("U.S. Citizen");
    expect(usCitizenOption(["U.S. Citizen", "U.S. Citizen (dual)"])).toBeNull();
    expect(usCitizenOption(["U.S. National", "Other"])).toBeNull();
  });
});

describe("saved Yes/No options", () => {
  it("picks the one exact or prefixed Yes or No", () => {
    expect(booleanOption(true, ["Yes", "No"])).toBe("Yes");
    expect(booleanOption(false, ["Yes", "No"])).toBe("No");
    expect(booleanOption(true, ["Yes, I am a U.S. citizen", "No, I am not"])).toBe("Yes, I am a U.S. citizen");
    expect(booleanOption(false, ["Yes, I am a U.S. citizen", "No, I am not"])).toBe("No, I am not");
    expect(booleanOption(true, ["Yes", "Yes, but…", "No"])).toBe("Yes");
    expect(booleanOption(true, ["Yes – A", "Yes – B", "No"])).toBeNull();
    expect(booleanOption(false, ["Yes", "None of the above"])).toBeNull();
    expect(booleanOption(false, ["Yes", "Not sure"])).toBeNull();
  });

  it("answers only standard keys, with the export status and citizen fallbacks", () => {
    expect(standardAnswerOption("authorized_to_work", true, ["Yes, I am authorized", "No"])).toBeNull();
    expect(standardAnswerOption("us_citizen", true, ["U.S. Citizen", "Permanent Resident", "Other"])).toBe("U.S. Citizen");
    expect(standardAnswerOption("us_person_export_controls", CITIZEN_TEXT, EXPORT_OPTIONS)).toBe("U.S. citizen or national");
    expect(standardAnswerOption("criminal_conviction", false, ["Yes", "No"])).toBe("No");
  });
});

describe("U.S.-person options that name no category (Neros, 2026-11-25)", () => {
  const NEROS_OPTIONS = [
    "I am currently a \"U.S. Person\"",
    "I will soon become a \"U.S. Person\" (requires explanation if selected)",
    "I am not a \"U.S. Person,\" but I am eligible for licensing (requires explanation if selected)"
  ];

  it("picks the one \"currently a U.S. person\" option for a saved U.S.-person status", () => {
    expect(standardAnswerOption("us_person_export_controls", CITIZEN_TEXT, NEROS_OPTIONS)).toBe(NEROS_OPTIONS[0]);
    expect(standardAnswerOption("us_person_export_controls", "A lawful permanent resident of the United States", NEROS_OPTIONS)).toBe(NEROS_OPTIONS[0]);
  });

  it("never answers a saved \"none\" status, two such options, or the \"will become\" and \"not … but eligible\" options", () => {
    expect(standardAnswerOption("us_person_export_controls", "None of the above", NEROS_OPTIONS)).toBeNull();
    expect(usPersonOption(CITIZEN_TEXT, ["I am a U.S. person", "Yes, I am a U.S. Person", "No"])).toBeNull();
    expect(usPersonOption(CITIZEN_TEXT, NEROS_OPTIONS.slice(1))).toBeNull();
    expect(usPersonOption(CITIZEN_TEXT, ["I'm a U.S. person", "I am not a U.S. person"])).toBe("I'm a U.S. person");
  });
});

describe("the salary rule", () => {
  const text = (value: PostingPay | null) => postingPayAnswer(value, { fieldKind: "text", question: "What are your salary expectations?" });

  it("states the posting's pay as an hourly figure or range", () => {
    expect(text(pay("HOUR", 45, 45))).toEqual({ kind: "answer", text: "$45/hour" });
    expect(text(pay("HOUR", 40, 50))).toEqual({ kind: "answer", text: "$40–$50/hour" });
    expect(text(pay("YEAR", 104_000, null))).toEqual({ kind: "answer", text: "$50/hour" });
    expect(text(pay("YEAR", 100_000, 120_000))).toEqual({ kind: "answer", text: "$48.08–$57.69/hour" });
    expect(text(pay("MONTH", 8_000, 8_000))).toEqual({ kind: "answer", text: "$46.15/hour" });
  });

  it("holds for a stipend, another currency, or no amount; never invents a number", () => {
    expect(text(pay("STIPEND", 5_000, 5_000))).toMatchObject({ kind: "hold" });
    expect(text(pay("HOUR", 45, 45, "EUR"))).toMatchObject({ kind: "hold" });
    expect(text(pay("HOUR", null, null))).toMatchObject({ kind: "hold" });
    expect(text(null)).toEqual({ kind: "answer", text: "Open to discussion" });
    expect(postingPayAnswer(undefined, { question: "Desired salary" })).toEqual({ kind: "answer", text: "Open to discussion" });
    expect(postingPayAnswer(null, { fieldKind: "number", question: "Desired hourly rate" })).toMatchObject({ kind: "hold" });
  });

  it("puts a plain hourly number only into a number field that asks for one", () => {
    expect(postingPayAnswer(pay("HOUR", 45, 45), { fieldKind: "number", question: "Desired hourly rate" })).toEqual({ kind: "answer", text: "45" });
    expect(postingPayAnswer(pay("HOUR", 40, 50), { fieldKind: "number", question: "Desired hourly rate" })).toMatchObject({ kind: "hold" });
    expect(postingPayAnswer(pay("HOUR", 45, 45), { fieldKind: "number", question: "Desired annual salary" })).toMatchObject({ kind: "hold" });
    expect(postingPayAnswer(pay("HOUR", 45, 45), { fieldKind: "select", question: "Desired hourly rate" })).toMatchObject({ kind: "hold" });
  });
});

describe("restrictive covenant end dates", () => {
  it("applies through the end date inclusive, not the day after", () => {
    expect(restrictiveCovenantActive("2027-03-31", "2027-03-30")).toBe(true);
    expect(restrictiveCovenantActive("2027-03-31", "2027-03-31")).toBe(true);
    expect(restrictiveCovenantActive("2027-03-31", "2027-04-01")).toBe(false);
  });
});

describe("the standard answers file", () => {
  it("accepts a full fictional file", () => {
    expect(standardAnswersFileSchema.safeParse(file).success).toBe(true);
    expect(standardAnswersFileSchema.safeParse({ ...file, salary_expectation: { rule: "posting pay, hourly" } }).success).toBe(true);
    expect(standardAnswersFileSchema.safeParse({ ...file, source: "Candidate's answers in chat, 2026-11-20" }).success).toBe(true);
  });

  it("fails closed on unknown keys, a named employer, a bad date, an unknown status, or a Yes with no explanation", () => {
    const unknown = standardAnswersFileSchema.safeParse({ ...file, favorite_color: "blue" });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]?.code).toBe("unrecognized_keys");
    expect(standardAnswersFileSchema.safeParse({ ...file, non_solicitation: { ...file.non_solicitation, name_former_employer: true } }).success).toBe(false);
    expect(standardAnswersFileSchema.safeParse({ ...file, non_solicitation: { ...file.non_solicitation, ends: "March 2027" } }).success).toBe(false);
    expect(standardAnswersFileSchema.safeParse({ ...file, us_person_export_controls: "Something else" }).success).toBe(false);
    expect(standardAnswersFileSchema.safeParse({ ...file, non_solicitation: { ...file.non_solicitation, explanation: "" } }).success).toBe(false);
    expect(standardAnswersFileSchema.safeParse({ ...file, non_solicitation: { ...file.non_solicitation, answer: false, explanation: "" } }).success).toBe(true);
  });
});

describe("standard fact scopes", () => {
  const now = new Date().toISOString();
  const fact = (key: string, scope: unknown, value: boolean | string, valueType = "boolean") => candidateFactSchema.safeParse({
    id: "fixture",
    candidateId: "local",
    key,
    scope,
    value,
    valueType,
    source: "user",
    sourceDetail: { kind: "profile" },
    confidence: 1,
    sensitivity: key === "salary_expectation" ? "standard" : "sensitive",
    reusePolicy: "auto",
    rememberedAt: now,
    createdAt: now,
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  });

  it("keeps the 50-mile answer to a named place only", () => {
    expect(fact("lives_within_50_miles", { kind: "global" }, true).success).toBe(false);
    expect(fact("lives_within_50_miles", { kind: "location", name: "San Francisco" }, true).success).toBe(true);
  });

  it("parses the resolve-time keys", () => {
    expect(fact("us_person", { kind: "global" }, true).success).toBe(true);
    expect(fact("us_citizen_or_national", { kind: "global" }, true).success).toBe(true);
    expect(fact("us_citizen_or_permanent_resident", { kind: "global" }, false).success).toBe(true);
    expect(fact("f1_optional_practical_training", { kind: "global" }, false).success).toBe(true);
    expect(fact("salary_expectation", { kind: "global" }, "$45/hour", "text").success).toBe(true);
    expect(fact("us_person_export_controls", { kind: "global" }, "Something else", "text").success).toBe(false);
  });

  it("parses the unrestricted right to work as a global resolve-time key only (Track 43)", () => {
    expect(fact("unrestricted_us_work_authorization", { kind: "global" }, true).success).toBe(true);
    expect(fact("unrestricted_us_work_authorization", { kind: "country", code: "US" }, true).success).toBe(false);
    expect(isStandardAnswerKey("unrestricted_us_work_authorization")).toBe(true);
  });
});
