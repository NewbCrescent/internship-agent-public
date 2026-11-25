import { describe, expect, it } from "vitest";

import { DeterministicQuestionMapper } from "@internship-agent/agent";

const mapper = new DeterministicQuestionMapper();

describe("deterministic semantic question mapping", () => {
  it("maps relocation paraphrases to the same scoped key", async () => {
    const first = await mapper.map("Would you consider relocating to Seattle?");
    const second = await mapper.map("Are you willing to move to Seattle for this role?");
    expect(first).toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "location", name: "Seattle" } });
    expect(second).toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "location", name: "Seattle" } });
  });

  it("requires country context for consequential authorization facts", async () => {
    expect(await mapper.map("Are you legally authorized to work?")).toMatchObject({ status: "AMBIGUOUS" });
    expect(await mapper.map("Are you legally authorized to work in the United States?")).toMatchObject({
      status: "MAPPED",
      key: "authorized_to_work",
      scope: { kind: "country", code: "US" }
    });
  });

  it("scopes generic sponsorship and authorization questions to the posting's one country", async () => {
    const sponsorship = [
      "Will you now or in the future require sponsorship for employment visa status (e.g. F-1 STEM OPT, H-1B, TN, E-3…)",
      "Will you require future sponsorship?",
      "We are unable to provide sponsorship for this position. Will you require sponsorship for this internship?"
    ];
    for (const question of sponsorship) {
      expect(await mapper.map(question, { postingCountryCode: "US" }), question).toMatchObject({
        status: "MAPPED", key: "requires_sponsorship", scope: { kind: "country", code: "US" }
      });
      expect(await mapper.map(question), question).toMatchObject({ status: "AMBIGUOUS" });
    }
    const authorization = "Are you legally authorized to work in the location of this job?";
    const mapped = await mapper.map(authorization, { postingCountryCode: "US" });
    expect(mapped).toMatchObject({ status: "MAPPED", key: "authorized_to_work", scope: { kind: "country", code: "US" } });
    expect(mapped.status === "MAPPED" && mapped.explanation).toContain("the posting's country");
    expect(await mapper.map(authorization)).toMatchObject({ status: "AMBIGUOUS" });
    // The question's own country wins over the posting's.
    expect(await mapper.map("Are you legally authorized to work in Canada?", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "authorized_to_work", scope: { kind: "country", code: "CA" }
    });
    // A lowercase posting country is read as its code.
    expect(await mapper.map("Will you require future sponsorship?", { postingCountryCode: "us" })).toMatchObject({
      status: "MAPPED", key: "requires_sponsorship", scope: { kind: "country", code: "US" }
    });
  });

  it("reads \"legally eligible to work\" as work authorization, never a government, export-control, or clearance question", async () => {
    expect(await mapper.map("Are you legally eligible to work in the country you are applying for?", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "authorized_to_work", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Are you legally eligible to work in Canada?")).toMatchObject({
      status: "MAPPED", key: "authorized_to_work", scope: { kind: "country", code: "CA" }
    });
    expect(await mapper.map("Are you legally eligible to work in the country you are applying for?")).toMatchObject({ status: "AMBIGUOUS" });
    for (const question of [
      "Are you eligible to work on export-controlled projects?",
      "Are you legally eligible to work on U.S. government contracts?"
    ]) {
      const mapped = await mapper.map(question, { postingCountryCode: "US" });
      expect(mapped.status === "MAPPED" ? mapped.key : null, question).not.toBe("authorized_to_work");
    }
  });

  it("blocks protected and attestation questions from memory", async () => {
    expect(await mapper.map("What is your veteran status?")).toMatchObject({ status: "BLOCKED", policy: "protected" });
    expect(await mapper.map("Do you certify that all information is true?")).toMatchObject({ status: "BLOCKED", policy: "attestation" });
  });

  it("surfaces unsupported questions instead of guessing", async () => {
    expect(await mapper.map("What is your favorite programming language?")).toMatchObject({ status: "UNMAPPED" });
  });

  it("scopes graduation to the Handshake channel only when the context says so", async () => {
    expect(await mapper.map("What is your expected graduation date?")).toMatchObject({
      status: "MAPPED",
      key: "graduation_date",
      scope: { kind: "global" }
    });
    expect(await mapper.map("What is your expected graduation date?", { applicationChannel: "handshake_internal" })).toMatchObject({
      status: "MAPPED",
      key: "graduation_date",
      scope: { kind: "application_channel", channel: "handshake_internal" }
    });
    // Other facts ignore the channel: one start date serves every application.
    expect(await mapper.map("What is your available start date?", { applicationChannel: "handshake_internal" })).toMatchObject({
      status: "MAPPED",
      key: "available_start_date",
      scope: { kind: "global" }
    });
  });

  it("keeps a date component on the form away from internship availability", async () => {
    for (const label of ["Start date year", "Start date month", "Start date - Year"]) {
      const result = await mapper.map(label);
      expect(result.status === "MAPPED" && result.key === "available_start_date", label).toBe(false);
    }
    expect(await mapper.map("Earliest start date")).toMatchObject({ status: "MAPPED", key: "available_start_date" });
    expect(await mapper.map("When is your available start date?")).toMatchObject({ status: "MAPPED", key: "available_start_date" });
  });

  it("maps full-time enrollment questions, not full-time work questions", async () => {
    for (const question of ["Are you a full-time student?", "Are you currently enrolled full time?",
      "Are you a full-time student graduating in 2028?", "Full-time enrollment status"]) {
      expect(await mapper.map(question), question).toMatchObject({ status: "MAPPED", key: "enrolled_full_time", scope: { kind: "global" } });
    }
    expect(await mapper.map("Are you seeking full-time employment?")).toMatchObject({ status: "UNMAPPED" });
    expect(await mapper.map("Are you available to work full-time this summer?")).not.toMatchObject({ key: "enrolled_full_time" });
  });
});

describe("saved answer mappings", () => {
  const key = async (question: string, context = {}) => {
    const result = await mapper.map(question, context);
    return result.status === "MAPPED" ? result.key : result.status;
  };

  it("maps how-did-you-hear questions to one global answer", async () => {
    for (const question of ["How did you hear about us?", "Source"]) {
      expect(await mapper.map(question), question).toMatchObject({ status: "MAPPED", key: "how_heard", scope: { kind: "global" } });
    }
  });

  it("scopes previous employment to the posting's company, never another one", async () => {
    expect(await mapper.map("Have you previously worked here?", { companyName: "Vandelay, Inc." })).toMatchObject({
      status: "MAPPED",
      key: "previously_worked_here",
      scope: { kind: "company", name: "vandelay" }
    });
    expect(await mapper.map("Have you previously worked here?")).toMatchObject({
      status: "MAPPED",
      key: "previously_worked_here",
      scope: { kind: "global" }
    });
    expect(await mapper.map("Have you ever been employed by Vandelay or any of its subsidiaries?", { companyName: "Vandelay" })).toMatchObject({
      status: "MAPPED",
      key: "previously_worked_here",
      scope: { kind: "company", name: "vandelay" }
    });
    expect(await mapper.map("Have you previously worked at Plaid?", { companyName: "Vandelay" })).toMatchObject({ status: "UNMAPPED" });
    expect(await key("Do you have previous work experience?")).not.toBe("previously_worked_here");
  });

  it("maps age, pronouns, and relatives questions", async () => {
    expect(await key("Are you at least 18 years of age?")).toBe("age_18_or_older");
    expect(await key("Are you 18 or older?")).toBe("age_18_or_older");
    expect(await key("Are you under 18 years old?")).not.toBe("age_18_or_older");
    expect(await mapper.map("What are your pronouns?")).toMatchObject({ status: "MAPPED", key: "pronouns", scope: { kind: "global" } });
    expect(await mapper.map("Do you have any relatives currently employed by this company?", { companyName: "Acme Robotics" })).toMatchObject({
      status: "MAPPED",
      key: "relatives_at_company",
      scope: { kind: "company", name: "acme robotics" }
    });
    expect(await key("Do you have any relatives currently employed by this company?")).toBe("relatives_at_company");
    expect(await key("Do any of your family members work for a competitor?")).not.toBe("relatives_at_company");
  });

  it("maps the latest end date but not a date component or a combined start and end", async () => {
    expect(await key("What is the latest end date you are available until?")).toBe("available_end_date");
    expect(await key("Available until?")).toBe("available_end_date");
    expect(await mapper.map("Earliest start date and latest end date for the internship?")).toMatchObject({ status: "AMBIGUOUS" });
    expect(await key("End date year")).not.toBe("available_end_date");
    expect(await key("End Date")).not.toBe("available_end_date");
  });

  it("maps openness to on-site or hybrid work but not a preference", async () => {
    expect(await key("Are you open to working on-site or hybrid?")).toBe("work_arrangement");
    expect(await key("Are you comfortable working in-office 3 days a week?")).toBe("work_arrangement");
    expect(await key("Which work arrangement do you prefer: remote, hybrid, or on-site?")).not.toBe("work_arrangement");
    expect(await key("Are you unable to work on-site?")).not.toBe("work_arrangement");
  });

  it("records relocation per country, from the place, the question, or the posting", async () => {
    expect(await mapper.map("Are you willing to relocate?", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Are you willing to relocate?", { postingCountryCode: "CA" })).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "CA" }
    });
    expect(await mapper.map("Are you willing to relocate?")).toMatchObject({ status: "AMBIGUOUS" });
    expect(await mapper.map("Are you willing to relocate to Austin, TX?")).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Are you willing to relocate to London, UK?")).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "GB" }
    });
    expect(await mapper.map("Are you willing to relocate within the United States?", { postingCountryCode: "CA" })).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Would you consider relocating to Seattle?")).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "location", name: "Seattle" }
    });
  });

  it("still blocks protected demographic questions", async () => {
    expect(await mapper.map("What is your gender?")).toMatchObject({ status: "BLOCKED", policy: "protected" });
  });

  it("maps relevant-coursework questions, never GPA, grade, transcript, or credit questions", async () => {
    for (const question of [
      "Relevant coursework",
      "Please list any relevant coursework",
      "Coursework",
      "Which courses have you taken?",
      "What relevant classes have you completed?",
      "Relevant courses",
      "Courses taken",
      'How should "Relevant coursework" be answered?'
    ]) {
      expect(await mapper.map(question), question).toMatchObject({
        status: "MAPPED", key: "relevant_coursework", scope: { kind: "global" }, method: "deterministic"
      });
    }
    for (const question of [
      "What is your GPA?",
      "Cumulative GPA",
      "What grade did you receive in your relevant courses?",
      "Relevant coursework and grades",
      "Please upload your transcript",
      "List any online courses or certifications",
      "How many credits are you taking?",
      "Are you currently taking classes?"
    ]) {
      const mapping = await mapper.map(question);
      expect(mapping.status === "MAPPED" && mapping.key === "relevant_coursework", question).toBe(false);
    }
    expect(await mapper.map("What is your GPA?")).toMatchObject({ status: "UNMAPPED" });
  });

  describe("real-form phrasings (2026-11-20 runs; company and places fictional)", () => {
    const context = { companyName: "Fixture Robotics", postingCountryCode: "US" };
    const notMapped = async (question: string) => {
      const result = await mapper.map(question, context);
      expect(result.status, question).not.toBe("MAPPED");
    };

    it("maps immediate family at the company, but not family who buy its products", async () => {
      expect(await mapper.map("Do you have any immediate family that work at Fixture Robotics?", context)).toMatchObject({
        status: "MAPPED",
        key: "relatives_at_company",
        scope: { kind: "company", name: "fixture robotics" }
      });
      const health = await mapper.map("Are any of your immediate family members practicing health care professionals that may use or purchase Fixture Robotics products?", context);
      expect(health.status === "MAPPED" && health.key === "relatives_at_company").toBe(false);
    });

    it("maps an office requirement, but not working from this location", async () => {
      expect(await mapper.map("As part of this position, you will be required to be in the Fixture City office. Are you ok with this requirement?", context))
        .toMatchObject({ status: "MAPPED", key: "work_arrangement" });
      await notMapped("This role is based in our Fixture City office and involves working primarily in person. Are you willing and able to work from this location?");
    });

    // Salary, FDA/OIG debarment, DoD clearance eligibility, and the 50-mile question now map to the
    // standard legal and background answers (standard-question-mapper.ts; see the table below).
    it("leaves questions that need the candidate's own answer unmapped", async () => {
      for (const question of [
        "CONFLICT OF INTEREST: Do you currently, or have you in the last 5 years, worked for the US government (e.g., Congressional staffer, member of the military, state, or federal agencies) and had oversight or similar responsibility over Fixture Robotics’s business or other interests?",
        "EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.",
        "HISTORY WITH FIXTURE ROBOTICS: Have you previously applied to a position at Fixture Robotics?",
        "Preferred First Name"
      ]) await notMapped(question);
    });

    it("maps the earlier unmapped legal and background phrasings to the standard answers", async () => {
      expect(await mapper.map("What are your base salary expectations for this role?", context)).toMatchObject({ status: "MAPPED", key: "salary_expectation" });
      expect(await mapper.map("Have you ever been or currently debarred by the U.S. FDA or excluded by the OIG?", context)).toMatchObject({
        status: "MAPPED", key: "government_debarment_or_exclusion", narrower: true
      });
      expect(await mapper.map("Are you eligible for a U.S. Department of Defense security clearance?", context)).toMatchObject({
        status: "MAPPED", key: "security_clearance_eligible"
      });
      expect(await mapper.map("Do you currently reside within 50 miles from Fixture City, California?", context)).toMatchObject({
        status: "MAPPED", key: "lives_within_50_miles", scope: { kind: "location", name: "Fixture City, California" }
      });
    });

    it("maps worked-here history and the posting country's authorization and sponsorship", async () => {
      expect(await mapper.map("HISTORY WITH FIXTURE ROBOTICS: Have you previously worked at Fixture Robotics?", context)).toMatchObject({
        status: "MAPPED",
        key: "previously_worked_here",
        scope: { kind: "company", name: "fixture robotics" }
      });
      expect(await mapper.map("Are you legally authorized to work in the country this role is located in?", context)).toMatchObject({
        status: "MAPPED",
        key: "authorized_to_work",
        scope: { kind: "country", code: "US" }
      });
      expect(await mapper.map("Do you currently or will you in the future require visa sponsorship to continue working in the country in which this role is located?", context)).toMatchObject({
        status: "MAPPED",
        key: "requires_sponsorship",
        scope: { kind: "country", code: "US" }
      });
    });
  });
});

describe("standard legal and background phrasings (fictional companies and places)", () => {
  type Expected = { key: string; scope?: object; narrower?: boolean } | "AMBIGUOUS" | "UNMAPPED";
  type Row = [question: string, expected: Expected, context?: Record<string, unknown>];
  const global = { kind: "global" };
  const rows: Row[] = [
    // Citizenship and export control.
    ["Are you a U.S. citizen?", { key: "us_citizen", scope: global }],
    ["Are you a citizen of the United States?", { key: "us_citizen" }],
    ["U.S. Citizen", { key: "us_citizen" }],
    ["What is your U.S. citizenship status?", { key: "us_citizen" }, { fieldKind: "select" }],
    ["What is your U.S. citizenship status?", "AMBIGUOUS", { fieldKind: "text" }],
    ["Are you a U.S. person as defined by ITAR/EAR?", { key: "us_person" }],
    ["Are you a 'U.S. Person' under the International Traffic in Arms Regulations (ITAR) and Export Administration Regulations (EAR)?", { key: "us_person" }],
    ["Which of the following describes your U.S. person status for export-control purposes?", { key: "us_person_export_controls" }],
    ["EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.", { key: "us_person_export_controls" }, { fieldKind: "radio" }],
    ["EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.", "AMBIGUOUS"],
    ["Are you a U.S. citizen or lawful permanent resident?", { key: "us_citizen_or_permanent_resident" }],
    ["Are you a U.S. citizen or national?", { key: "us_citizen_or_national" }],
    ["Are you a U.S. citizen, permanent resident, refugee, or asylee?", { key: "us_person" }],
    ["Do you hold dual citizenship?", "AMBIGUOUS"],
    // Clearance.
    ["Do you currently hold an active security clearance?", { key: "holds_security_clearance" }],
    ["Do you have an active Secret or Top Secret clearance?", { key: "holds_security_clearance" }],
    ["Are you eligible to obtain a security clearance?", { key: "security_clearance_eligible" }],
    ["Are you eligible for a U.S. Department of Defense security clearance?", { key: "security_clearance_eligible" }],
    ["Do you currently hold an active security clearance, or are you eligible to obtain one?", "AMBIGUOUS"],
    ["Have you ever held a security clearance?", "AMBIGUOUS"],
    // Criminal history.
    ["Have you ever been convicted of a crime?", { key: "criminal_conviction" }],
    ["Have you been convicted of a felony?", { key: "criminal_conviction", narrower: true }],
    ["Have you ever been convicted of a felony or misdemeanor (excluding minor traffic violations)?", { key: "criminal_conviction", narrower: true }],
    ["Have you ever been arrested or convicted of a crime?", "AMBIGUOUS"],
    // Debarment.
    ["Have you ever been debarred, suspended, or excluded from participation in any federal government program?", { key: "government_debarment_or_exclusion" }],
    ["Have you ever been or currently debarred by the U.S. FDA or excluded by the OIG?", { key: "government_debarment_or_exclusion", narrower: true }],
    // Restrictive covenants.
    ["Are you subject to a non-compete agreement?", { key: "non_compete" }],
    ["Are you subject to a non-solicitation agreement?", { key: "non_solicitation" }],
    ["Are you subject to a non-compete or non-solicitation agreement?", { key: "non_compete_or_non_solicitation" }],
    ["Are you bound by any restrictive covenants, such as a non-compete or non-solicitation agreement?", { key: "non_compete_or_non_solicitation" }],
    ["Are you bound by any restrictive covenants?", "AMBIGUOUS"],
    ["Are you subject to a non-disclosure or non-compete agreement?", "AMBIGUOUS"],
    ["When does your non-solicitation agreement end?", "AMBIGUOUS"],
    ["Please describe your non-solicitation agreement.", { key: "non_solicitation_explanation" }, { fieldKind: "textarea" }],
    ["Are you subject to a non-solicitation agreement? If yes, please explain.", { key: "non_solicitation" }, { fieldKind: "radio" }],
    ["Are you subject to a non-solicitation agreement? If yes, please explain.", { key: "non_solicitation_explanation" }, { fieldKind: "textarea" }],
    ["Would your non-solicitation agreement restrict you from performing the duties of this role?", { key: "non_solicitation_restricts_this_job" }],
    // Conflicts, relatives in government or health care.
    ["Do you have any potential conflicts of interest?", { key: "conflict_of_interest" }],
    ["Do you have any relatives employed by a government agency or who are public officials?", { key: "relative_government_official" }],
    ["Is any member of your immediate family a government official?", { key: "relative_government_official", narrower: true }],
    ["Are any of your immediate family members health care professionals?", { key: "immediate_family_health_care_professional" }],
    ["Are any of your immediate family members practicing health care professionals that may use or purchase Fixture Robotics products?",
      { key: "immediate_family_health_care_professional", narrower: true }, { companyName: "Fixture Robotics", postingCountryCode: "US" }],
    ["Are any of your relatives health care professionals?", "AMBIGUOUS"],
    // Living within 50 miles: scoped to the named place, never another.
    ["Do you live within 50 miles of San Francisco?", { key: "lives_within_50_miles", scope: { kind: "location", name: "San Francisco" } }],
    ["Do you currently reside within 50 miles of San Francisco, CA?", { key: "lives_within_50_miles", scope: { kind: "location", name: "San Francisco" } }],
    ["Are you located within 50 miles of our San Francisco office?", { key: "lives_within_50_miles", scope: { kind: "location", name: "San Francisco" } }],
    ["Do you currently reside within 50 miles from Fixture City, California?", { key: "lives_within_50_miles", scope: { kind: "location", name: "Fixture City, California" } }],
    ["Do you live within 50 miles of Austin, TX?", { key: "lives_within_50_miles", scope: { kind: "location", name: "Austin, TX" } }],
    ["Do you live within 50 miles of South San Francisco?", { key: "lives_within_50_miles", scope: { kind: "location", name: "South San Francisco" } }],
    ["Do you live within 30 miles of San Francisco?", "AMBIGUOUS"],
    // Department of Defense work.
    ["Do you have concerns working on Department of Defense projects?", { key: "concerns_working_on_dod_projects" }],
    ["Do you have any concerns about working on DoD-funded programs?", { key: "concerns_working_on_dod_projects" }],
    ["Are you comfortable working on Department of Defense projects?", "AMBIGUOUS"],
    // Salary.
    ["What are your salary expectations?", { key: "salary_expectation" }],
    ["Desired hourly rate", { key: "salary_expectation" }],
    ["What are your base salary expectations for this role?", { key: "salary_expectation" }],
    ["What is your current salary?", "AMBIGUOUS"],
    ["Are you comfortable with the pay range for this role?", "AMBIGUOUS"],
    // Combined, negated, and statement forms.
    ["Are you a U.S. citizen and do you hold an active security clearance?", "AMBIGUOUS"],
    ["I have never been convicted of a felony", "AMBIGUOUS"],
    ["I am a U.S. citizen", { key: "us_citizen" }],
    // Left to the other rules.
    ["Preferred first name", "UNMAPPED"]
  ];

  it.each(rows)("maps %s", async (question, expected, context = {}) => {
    const result = await mapper.map(question, context);
    if (typeof expected === "string") {
      expect(result.status, JSON.stringify(result)).toBe(expected);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: "MAPPED", key: expected.key, method: "deterministic", ...(expected.scope ? { scope: expected.scope } : {}) });
    if (result.status === "MAPPED") expect(result.narrower === true, question).toBe(expected.narrower === true);
  });

  it("keeps relatives at the company on its own key", async () => {
    expect(await mapper.map("Do you have any relatives working at Fixture Robotics?", { companyName: "Fixture Robotics" })).toMatchObject({
      status: "MAPPED", key: "relatives_at_company", scope: { kind: "company", name: "fixture robotics" }
    });
  });

  it("scopes Starwood-style \"Work Authorization\" and \"Visa Sponsorship\" labels to the posting's one country only", async () => {
    expect(await mapper.map("Work Authorization", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "authorized_to_work", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Visa Sponsorship", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "requires_sponsorship", scope: { kind: "country", code: "US" }
    });
    expect(await mapper.map("Work Authorization")).toMatchObject({ status: "AMBIGUOUS" });
    expect(await mapper.map("Visa Sponsorship")).toMatchObject({ status: "AMBIGUOUS" });
  });
});

describe("new candidate facts and option questions (2026-11-24)", () => {
  it.each([
    "Are you willing to undergo a background check?",
    "Would you be willing to submit to a background screening?"
  ])("maps %s to background-check willingness", async (question) => {
    expect(await mapper.map(question)).toMatchObject({ status: "MAPPED", key: "willing_background_check", scope: { kind: "global" } });
  });

  it.each([
    "Can you pass a background check?",
    "Do you consent to a background check?",
    "I authorize Fixture Robotics to conduct a background check",
    "Have you ever been convicted of a felony?"
  ])("never maps %s to background-check willingness", async (question) => {
    const result = await mapper.map(question);
    expect(result.status === "MAPPED" ? result.key : null).not.toBe("willing_background_check");
  });

  it("maps the advertised-range comfort question on a list to the salary rule, and a text box to the expectation", async () => {
    const question = "If posted, are you comfortable with the advertised salary range?";
    expect(await mapper.map(question, { fieldKind: "select" })).toMatchObject({ status: "MAPPED", key: "salary_expectation_rule" });
    expect(await mapper.map(question, { fieldKind: "radio" })).toMatchObject({ status: "MAPPED", key: "salary_expectation_rule" });
    expect(await mapper.map("Are you comfortable with the posted pay range?", { fieldKind: "select" })).toMatchObject({
      status: "MAPPED", key: "salary_expectation_rule"
    });
    const text = await mapper.map(question, { fieldKind: "text" });
    expect(text.status === "MAPPED" ? text.key : text.status).not.toBe("salary_expectation_rule");
    expect(await mapper.map("What are your salary expectations?", { fieldKind: "text" })).toMatchObject({ status: "MAPPED", key: "salary_expectation" });
  });

  it("keeps own-expense relocation apart from plain relocation", async () => {
    expect(await mapper.map(
      "Are you located in or near to the city of the advertised role? If not, are you willing to relocate at your own expense?",
      { postingCountryCode: "US" }
    )).toMatchObject({ status: "MAPPED", key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" } });
    expect(await mapper.map("Are you willing to relocate?", { postingCountryCode: "US" })).toMatchObject({
      status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" }
    });
  });

  it("maps the offer-relative start question to the available start date", async () => {
    expect(await mapper.map("If offered a position, how soon would you be available to start?")).toMatchObject({
      status: "MAPPED", key: "available_start_date"
    });
  });

  it("blocks transgender and sexual orientation questions as protected", async () => {
    expect(await mapper.map("Do you identify as transgender?")).toMatchObject({ status: "BLOCKED", policy: "protected" });
    expect(await mapper.map("How would you describe your sexual orientation?")).toMatchObject({ status: "BLOCKED", policy: "protected" });
  });
});
