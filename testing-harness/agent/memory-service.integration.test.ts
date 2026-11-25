import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { answerCandidateQuestion, resolveCandidateQuestion } from "@internship-agent/agent";
import { planAutofill, type FieldResolution } from "@internship-agent/browser";
import { createDatabase, LOCAL_CANDIDATE_ID, replaceCoursework, saveCandidateFact, seedDevelopmentData } from "@internship-agent/db";
import {
  formatCourseworkAnswer,
  scopeKey,
  type BrowserField,
  type CourseworkSet,
  type FactScope,
  type JobLocation,
  type PauseRecord,
  type PostingPay,
  type QuestionContext
} from "@internship-agent/domain";

import { planPauseMemory } from "../../packages/agent/src/question-answers";
import { postingQuestionContext } from "../../packages/agent/src/saved-answers";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("remembered answer resolution", () => {
  it("reuses a paraphrase with provenance but not a different location scope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-memory-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);

    const unknown = await resolveCandidateQuestion("Would you consider relocating to Seattle?", {}, { database });
    expect(unknown.status).toBe("NEEDS_INPUT");

    const remembered = await answerCandidateQuestion({
      question: "Would you consider relocating to Seattle?",
      answer: "yes",
      remember: true,
      context: {}
    }, { database });
    expect(remembered).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { source: "user" } });

    const paraphrase = await resolveCandidateQuestion("Are you willing to move to Seattle for this role?", {}, { database });
    expect(paraphrase).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { scope: { kind: "location", name: "Seattle" } } });

    const otherCity = await resolveCandidateQuestion("Would you relocate to Austin?", {}, { database });
    expect(otherCity).toMatchObject({ status: "NEEDS_INPUT", mapping: { scope: { kind: "location", name: "Austin" } } });

    const protectedQuestion = await resolveCandidateQuestion("What is your disability status?", {}, { database });
    expect(protectedQuestion).toMatchObject({ status: "REQUIRES_CONFIRMATION", policy: "protected" });
    database.close();
  });

  it("uses a Handshake-only graduation date on Handshake applications and never elsewhere", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-memory-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);
    const question = "What is your expected graduation date?";
    const handshake = { applicationChannel: "handshake_internal" as const };

    // A Handshake-only answer alone never answers a general question.
    await answerCandidateQuestion({ question, answer: "2029-05-15", remember: true, context: handshake }, { database });
    expect(await resolveCandidateQuestion(question, {}, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    expect(await resolveCandidateQuestion(question, handshake, { database })).toMatchObject({
      status: "RESOLVED",
      displayAnswer: "2029-05-15",
      fact: { scope: { kind: "application_channel", channel: "handshake_internal" } }
    });

    // With both answers, each application type gets its own.
    await answerCandidateQuestion({ question, answer: "2028-05-15", remember: true, context: {} }, { database });
    expect(await resolveCandidateQuestion(question, {}, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "2028-05-15" });
    expect(await resolveCandidateQuestion(question, handshake, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "2029-05-15" });
    database.close();
  });

  it("falls back to the general graduation date on Handshake when no Handshake answer exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-memory-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);
    const question = "When is your expected graduation?";
    await answerCandidateQuestion({ question, answer: "2028-05-15", remember: true, context: {} }, { database });
    expect(await resolveCandidateQuestion(question, { applicationChannel: "handshake_internal" }, { database })).toMatchObject({
      status: "RESOLVED",
      displayAnswer: "2028-05-15",
      mapping: { scope: { kind: "application_channel" } },
      fact: { scope: { kind: "global" } }
    });
    database.close();
  });
});

describe("company-, country-, and protected-scoped answers", () => {
  function workspace() {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-memory-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);
    return database;
  }
  const save = (database: ReturnType<typeof createDatabase>, key: Parameters<typeof saveCandidateFact>[1]["key"], scope: FactScope, value: boolean | string) =>
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key,
      scope,
      value,
      source: "user",
      sourceDetail: { kind: "profile" },
      confidence: 1,
      rememberedAt: new Date().toISOString()
    });
  const factCount = (database: ReturnType<typeof createDatabase>) =>
    (database.prepare("SELECT COUNT(*) AS count FROM candidate_facts").get() as { count: number }).count;

  it("answers Yes for previous employment only at the saved company and No everywhere else", async () => {
    const database = workspace();
    save(database, "previously_worked_here", { kind: "global" }, false);
    save(database, "previously_worked_here", { kind: "company", name: "Vandelay" }, true);
    const question = "Have you previously worked here?";
    expect(await resolveCandidateQuestion(question, { companyName: "Vandelay Inc." }, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    for (const context of [{ companyName: "Plaid" }, { companyName: "Vandelay Labs" }, {}]) {
      expect(await resolveCandidateQuestion(question, context, { database }), JSON.stringify(context)).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    }
    expect(() => save(database, "previously_worked_here", { kind: "global" }, true)).toThrow();

    // The employer that runs the Workday site, named as a group, is this employer: the saved No answers it.
    const site = { companyName: "fixGen", employerSite: "fixturehealth" };
    const group = "Have you ever been employed by Fixture Health, Example Health Network, or by one of its subsidiaries or affiliates?";
    expect(await resolveCandidateQuestion(group, site, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    // A No never answers a question that also names the company the candidate has a saved Yes for.
    expect(await resolveCandidateQuestion("Have you ever been employed by Fixture Health or Vandelay?", site, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    expect(await resolveCandidateQuestion("Did you work here before?", { companyName: "Vandelay Inc." }, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });

    // A remembered Yes with no company named is used once, never saved globally.
    const before = factCount(database);
    expect(await answerCandidateQuestion({ question, answer: "yes", remember: true, context: {} }, { database })).toMatchObject({ status: "ANSWERED_ONCE" });
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("answers relocation per country and never from the legacy global answer", async () => {
    const database = workspace();
    save(database, "willing_to_relocate", { kind: "global" }, true);
    save(database, "willing_to_relocate", { kind: "country", code: "US" }, true);
    const question = "Are you willing to relocate?";
    expect(await resolveCandidateQuestion(question, { postingCountryCode: "US" }, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolveCandidateQuestion(question, { postingCountryCode: "CA" }, { database })).toMatchObject({
      status: "NEEDS_INPUT",
      mapping: { scope: { kind: "country", code: "CA" } }
    });
    expect(await resolveCandidateQuestion(question, {}, { database })).toMatchObject({ status: "AMBIGUOUS" });
    database.close();
  });

  it("never resolves or stores a protected self-identification answer from a question", async () => {
    const database = workspace();
    save(database, "eeo_gender", { kind: "global" }, "female");
    save(database, "eeo_race_ethnicity", { kind: "global" }, "asian");
    const resolution = await resolveCandidateQuestion("What is your gender?", {}, { database });
    expect(resolution).toMatchObject({ status: "REQUIRES_CONFIRMATION", policy: "protected" });
    expect("fact" in resolution && resolution.fact).toBeFalsy();
    const before = factCount(database);
    expect(await answerCandidateQuestion({ question: "What is your race or ethnicity?", answer: "white", remember: true, context: {} }, { database }))
      .toMatchObject({ status: "REQUIRES_CONFIRMATION", policy: "protected" });
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("resolves the advertised-range comfort list from the salary rule and own-expense relocation per country (2026-11-24)", async () => {
    const database = workspace();
    save(database, "salary_expectation_rule", { kind: "global" }, "posting_pay_hourly");
    save(database, "willing_to_relocate_at_own_expense", { kind: "country", code: "US" }, true);
    expect(await resolveCandidateQuestion("If posted, are you comfortable with the advertised salary range?", { fieldKind: "select" }, { database }))
      .toMatchObject({ status: "RESOLVED", fact: { key: "salary_expectation_rule", value: "posting_pay_hourly" } });
    const combined = "Are you located in or near to the city of the advertised role? If not, are you willing to relocate at your own expense?";
    expect(await resolveCandidateQuestion(combined, { postingCountryCode: "US", fieldKind: "select" }, { database })).toMatchObject({
      status: "RESOLVED", displayAnswer: "Yes", fact: { key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" } }
    });
    expect(await resolveCandidateQuestion(combined, { postingCountryCode: "CA", fieldKind: "select" }, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    // Plain relocation is not answered by the own-expense answer.
    expect(await resolveCandidateQuestion("Are you willing to relocate?", { postingCountryCode: "US" }, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    database.close();
  });

  it("never resolves or stores a saved sexual orientation or transgender answer from a question (2026-11-24)", async () => {
    const database = workspace();
    save(database, "eeo_sexual_orientation", { kind: "global" }, "queer");
    save(database, "eeo_transgender", { kind: "global" }, "not_transgender");
    for (const question of ["What is your sexual orientation?", "Do you identify as transgender?"]) {
      const resolution = await resolveCandidateQuestion(question, {}, { database });
      expect(resolution, question).toMatchObject({ status: "REQUIRES_CONFIRMATION", policy: "protected" });
      expect("fact" in resolution && resolution.fact).toBeFalsy();
    }
    const before = factCount(database);
    expect(await answerCandidateQuestion({ question: "Do you identify as transgender?", answer: "no", remember: true, context: {} }, { database }))
      .toMatchObject({ status: "REQUIRES_CONFIRMATION", policy: "protected" });
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("answers relevant coursework from the saved courses and never stores a typed coursework answer", async () => {
    const database = workspace();
    // Neutral fixture: a fictional school and generic course codes.
    const coursework: CourseworkSet = {
      school: "Example State University",
      courses: [
        { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "in_progress" },
        { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" }
      ]
    };
    expect(await resolveCandidateQuestion("Relevant coursework", {}, { database })).toMatchObject({
      status: "NEEDS_INPUT", mapping: { key: "relevant_coursework" }
    });

    replaceCoursework(database, LOCAL_CANDIDATE_ID, coursework);
    const resolved = await resolveCandidateQuestion("Relevant coursework", {}, { database });
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      displayAnswer: formatCourseworkAnswer(coursework.courses),
      fact: { key: "relevant_coursework", source: "user", scope: { kind: "global" } }
    });
    expect(resolved.status === "RESOLVED" && resolved.fact.sourceDetail.question).toContain("Candidate-confirmed from transcript");
    expect(await resolveCandidateQuestion("What is your GPA?", {}, { database })).toMatchObject({ status: "UNMAPPED" });

    expect(await answerCandidateQuestion({ question: "Relevant coursework", answer: "Something typed", remember: true, context: {} }, { database }))
      .toMatchObject({ status: "ANSWERED_ONCE", displayAnswer: "Something typed" });
    expect((database.prepare("SELECT COUNT(*) AS count FROM candidate_facts WHERE key = 'relevant_coursework'").get() as { count: number }).count).toBe(0);
    expect(await resolveCandidateQuestion("Relevant coursework", {}, { database })).toMatchObject({
      status: "RESOLVED", displayAnswer: formatCourseworkAnswer(coursework.courses)
    });
    database.close();
  });
});

describe("standard legal and background answers (fictional answers)", () => {
  function workspace() {
    const directory = mkdtempSync(join(tmpdir(), "internship-agent-memory-"));
    temporaryDirectories.push(directory);
    const database = createDatabase(join(directory, "test.sqlite"));
    seedDevelopmentData(database);
    return database;
  }
  type Database = ReturnType<typeof createDatabase>;
  const GLOBAL: FactScope = { kind: "global" };
  const save = (database: Database, key: Parameters<typeof saveCandidateFact>[1]["key"], value: boolean | string, scope: FactScope = GLOBAL) =>
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key,
      scope,
      value,
      source: "user",
      sourceDetail: { kind: "profile", question: "Fixture standard answers." },
      confidence: 1,
      rememberedAt: new Date().toISOString()
    });
  const factCount = (database: Database) =>
    (database.prepare("SELECT COUNT(*) AS count FROM candidate_facts").get() as { count: number }).count;
  const EXPLANATION = "I agreed not to solicit my previous employer's clients for twelve months after leaving.";

  function standardWorkspace() {
    const database = workspace();
    save(database, "us_citizen", true);
    save(database, "us_person_export_controls", "A United States citizen or national");
    save(database, "holds_security_clearance", false);
    save(database, "security_clearance_eligible", true);
    save(database, "criminal_conviction", false);
    save(database, "government_debarment_or_exclusion", false);
    save(database, "non_compete", false);
    save(database, "non_solicitation", true);
    save(database, "non_solicitation_ends", "2027-03-31");
    save(database, "non_solicitation_explanation", EXPLANATION);
    save(database, "non_compete_or_non_solicitation", true);
    save(database, "non_solicitation_restricts_this_job", false);
    save(database, "conflict_of_interest", false);
    save(database, "relative_government_official", false);
    save(database, "immediate_family_health_care_professional", false);
    save(database, "lives_within_50_miles", true, { kind: "location", name: "San Francisco" });
    save(database, "salary_expectation_rule", "posting_pay_hourly");
    save(database, "concerns_working_on_dod_projects", false);
    return database;
  }
  const resolve = (database: Database, question: string, context: QuestionContext = {}, today?: string) =>
    resolveCandidateQuestion(question, context, { database, ...(today ? { today } : {}) });

  it("answers the non-solicitation agreement through its end date, then No without the explanation", async () => {
    const database = standardWorkspace();
    const subject = "Are you subject to a non-solicitation agreement?";
    const explain = "Please describe your non-solicitation agreement.";
    const combined = "Are you subject to a non-compete or non-solicitation agreement?";
    const restricts = "Would your non-solicitation agreement restrict you from performing the duties of this role?";
    expect(await resolve(database, subject, {}, "2027-03-31")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolve(database, explain, { fieldKind: "textarea" }, "2027-03-31")).toMatchObject({ status: "RESOLVED", displayAnswer: EXPLANATION });
    expect(await resolve(database, combined, {}, "2027-03-31")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolve(database, restricts, {}, "2027-03-31")).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });

    expect(await resolve(database, subject, {}, "2027-04-01")).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    const expired = await resolve(database, explain, { fieldKind: "textarea" }, "2027-04-01");
    expect(expired).toMatchObject({ status: "NEEDS_INPUT" });
    expect(JSON.stringify(expired)).not.toContain("twelve months");
    expect(await resolve(database, combined, {}, "2027-04-01")).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "non_compete" } });
    expect(await resolve(database, restricts, {}, "2027-04-01")).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    database.close();
  });

  it("answers the 50-mile question for San Francisco only, never for Austin", async () => {
    const database = standardWorkspace();
    expect(await resolve(database, "Do you live within 50 miles of San Francisco?")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolve(database, "Are you located within 50 miles of our San Francisco office?")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolve(database, "Do you live within 50 miles of Austin, TX?")).toMatchObject({
      status: "NEEDS_INPUT",
      mapping: { key: "lives_within_50_miles", scope: { kind: "location", name: "Austin, TX" } }
    });
    database.close();
  });

  it("builds U.S. person and citizen-or-resident answers from the saved answers", async () => {
    const database = standardWorkspace();
    expect(await resolve(database, "Are you a U.S. person as defined by ITAR/EAR?")).toMatchObject({
      status: "RESOLVED", displayAnswer: "Yes", fact: { key: "us_person", id: "derived:us_person" }
    });
    expect(await resolve(database, "Are you a U.S. citizen or lawful permanent resident?")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolve(database, "Are you a U.S. citizen or national?")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(() => save(database, "us_person", true)).toThrow(/never stored/);
    database.close();
  });

  it("answers a narrower question only with a saved No", async () => {
    const database = standardWorkspace();
    const felony = "Have you been convicted of a felony?";
    expect(await resolve(database, felony)).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    save(database, "criminal_conviction", true);
    expect(await resolve(database, felony)).toMatchObject({ status: "NEEDS_INPUT", mapping: { key: "criminal_conviction", narrower: true } });
    expect(await resolve(database, "Have you ever been convicted of a crime?")).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    database.close();
  });

  it("states the posting's pay as an hourly figure, and holds without a number or a saved rule", async () => {
    const database = standardWorkspace();
    const question = "What are your salary expectations?";
    const pay = (period: PostingPay["period"], minimum: number, maximum: number): PostingPay => ({ minimum, maximum, currency: "USD", period });
    expect(await resolve(database, question, { postingPay: pay("HOUR", 45, 45), fieldKind: "text" })).toMatchObject({ status: "RESOLVED", displayAnswer: "$45/hour" });
    expect(await resolve(database, question, { postingPay: pay("YEAR", 100_000, 120_000) })).toMatchObject({ status: "RESOLVED", displayAnswer: "$48.08–$57.69/hour" });
    expect(await resolve(database, question, { postingPay: pay("MONTH", 8_000, 8_000) })).toMatchObject({ status: "RESOLVED", displayAnswer: "$46.15/hour" });
    expect(await resolve(database, question)).toMatchObject({ status: "RESOLVED", displayAnswer: "Open to discussion" });
    expect(await resolve(database, "Desired hourly rate", { fieldKind: "number" })).toMatchObject({ status: "NEEDS_INPUT" });
    database.close();

    const bare = workspace();
    expect(await resolve(bare, question, { postingPay: pay("HOUR", 45, 45) })).toMatchObject({ status: "NEEDS_INPUT", reason: "No salary rule is saved." });
    bare.close();
  });

  it("never saves a legal or background answer from a question", async () => {
    const database = standardWorkspace();
    const before = factCount(database);
    expect(await answerCandidateQuestion({ question: "Are you a U.S. citizen?", answer: "yes", remember: true, context: {} }, { database }))
      .toMatchObject({ status: "ANSWERED_ONCE" });
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("never uses an explanation that names a former employer", async () => {
    const database = standardWorkspace();
    save(database, "previously_worked_here", true, { kind: "company", name: "Example Corp" });
    save(database, "non_solicitation_explanation", "I agreed not to solicit Example Corp clients for a year.");
    const resolution = await resolve(database, "Please describe your non-solicitation agreement.", { fieldKind: "textarea" }, "2027-01-15");
    expect(resolution).toMatchObject({ status: "NEEDS_INPUT" });
    expect(JSON.stringify(resolution)).not.toContain("Example Corp");
    database.close();
  });

  describe("work authorization and sponsorship with no country (Starwood-style labels)", () => {
    const location = (raw: string, countryCode: string | null, region: string | null = null): JobLocation => ({
      jobId: "00000000-0000-4000-8000-000000000001",
      raw,
      city: null,
      region,
      countryCode,
      workMode: "ONSITE",
      span: { start: 0, end: raw.length, excerpt: raw }
    });
    const posting = (locations: JobLocation[]) => ({ companyName: "Fixture Robotics", locations, compensation: null });
    const usPosting = posting([location("Fixture City, NY", "US")]);

    function authorizationWorkspace() {
      const database = workspace();
      save(database, "authorized_to_work", true, { kind: "country", code: "US" });
      save(database, "requires_sponsorship", false, { kind: "country", code: "US" });
      return database;
    }

    it("takes the country from a one-country posting, and pauses for several or none", async () => {
      const database = authorizationWorkspace();
      expect(await resolve(database, "Work Authorization", postingQuestionContext(usPosting))).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
      expect(await resolve(database, "Visa Sponsorship", postingQuestionContext(usPosting))).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
      const twoCountries = posting([location("Fixture City, NY", "US"), location("Fixture Town, ON", "CA")]);
      expect(await resolve(database, "Work Authorization", postingQuestionContext(twoCountries))).toMatchObject({ status: "AMBIGUOUS" });
      expect(await resolve(database, "Visa Sponsorship", postingQuestionContext(posting([])))).toMatchObject({ status: "AMBIGUOUS" });
      // A location stored without a country still names one in its text.
      const textOnly = postingQuestionContext(posting([location("Fixture City, FL", null)]));
      expect(textOnly.postingCountryCode).toBe("US");
      expect(await resolve(database, "Work Authorization", textOnly)).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
      database.close();
    });

    it("gives a pause answer and its hint the posting's country", async () => {
      const pause: PauseRecord = {
        fieldId: "work-authorization",
        label: "Work Authorization",
        question: 'How should "Work Authorization" be answered?',
        suggestedKey: null,
        suggestedScope: null,
        safeguard: false,
        sensitive: false,
        upload: false,
        status: "open",
        answer: null,
        draft: null,
        fieldKind: "radio",
        options: ["Yes", "No"]
      };
      expect(await planPauseMemory(pause, { companyName: "Fixture Robotics", context: postingQuestionContext(usPosting) }))
        .toMatchObject({ path: "fact", key: "authorized_to_work" });
      expect(await planPauseMemory(pause, { companyName: "Fixture Robotics", context: {} })).toMatchObject({ path: "once", reason: "ambiguous" });
    });
  });

  it("fills browser fields from the standard answers end to end", async () => {
    const database = standardWorkspace();
    const fields: BrowserField[] = [
      { id: "citizen", label: "Are you a U.S. citizen?", kind: "radio", required: true, options: ["Yes", "No"] },
      {
        id: "export",
        label: "Which of the following describes your U.S. person status for export-control purposes?",
        kind: "select",
        required: true,
        options: ["U.S. citizen or national", "U.S. lawful permanent resident (green card holder)", "Refugee under 8 U.S.C. 1157", "Asylee under 8 U.S.C. 1158", "None of the above"]
      },
      { id: "rate", label: "Desired hourly rate", kind: "text", required: true },
      { id: "box", label: "I am a U.S. citizen", kind: "checkbox", required: false }
    ];
    const context: QuestionContext = { ...postingQuestionContext({ companyName: "Fixture Robotics", locations: [], compensation: null }), postingPay: { minimum: 45, maximum: 45, currency: "USD", period: "HOUR" } };
    const resolutions = new Map<string, FieldResolution>();
    for (const field of fields) {
      const resolution = await resolveCandidateQuestion(field.label, { ...context, fieldKind: field.kind }, { database });
      if (resolution.status !== "RESOLVED") throw new Error(`${field.label}: ${resolution.status}`);
      resolutions.set(field.id, {
        status: "RESOLVED",
        key: resolution.fact.key,
        scope: scopeKey(resolution.fact.scope),
        display: resolution.displayAnswer,
        value: resolution.fact.value
      });
    }
    const plan = planAutofill({ url: "https://boards.greenhouse.io/example/jobs/1", title: "Apply", fields }, {
      profile: {}, resolutions, packageAnswers: [], variantId: null
    });
    const decision = (id: string) => plan.decisions.find((entry) => entry.fieldId === id);
    expect(decision("citizen")).toMatchObject({ action: "choose", value: "Yes" });
    expect(decision("export")).toMatchObject({ action: "choose", value: "U.S. citizen or national" });
    expect(decision("rate")).toMatchObject({ action: "fill", value: "$45/hour" });
    expect(decision("box")).toMatchObject({ action: "check" });
    database.close();
  });
});
