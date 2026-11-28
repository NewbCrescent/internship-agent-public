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

    // The posting's company named by its leading word (Track 32): the saved No answers it, but never alongside a saved-Yes company.
    const lead = { companyName: "Fixturelux Brands", employerSite: "fxbrands" };
    expect(await resolveCandidateQuestion("Have you worked for Fixturelux before?", lead, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "No" });
    expect(await resolveCandidateQuestion("Have you worked for Fixturelux or Vandelay before?", lead, { database })).toMatchObject({ status: "NEEDS_INPUT" });

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

  it("answers a relocation question naming a U.S. place from the saved U.S.-wide Yes, one way only (Track 62)", async () => {
    const database = workspace();
    save(database, "willing_to_relocate", { kind: "country", code: "US" }, true);
    const usPosting: QuestionContext = { postingCountryCode: "US", postingPlaces: [{ city: "Fixture Bay", countryCode: "US" }] };
    expect(await resolveCandidateQuestion("Are you willing to relocate to Fixture Bay?", usPosting, { database })).toMatchObject({
      status: "RESOLVED", displayAnswer: "Yes", fact: { scope: { kind: "country", code: "US" } }
    });
    // A well-known U.S. city counts when no posting place has its name.
    expect(await resolveCandidateQuestion("Would you relocate to Denver?", {}, { database })).toMatchObject({
      status: "RESOLVED", displayAnswer: "Yes", fact: { scope: { kind: "country", code: "US" } }
    });
    // Another or an unknown country gets nothing; a same-name city outside the U.S. refuses.
    expect(await resolveCandidateQuestion("Would you relocate to Fixture Harbour?", { postingPlaces: [{ city: "Fixture Harbour", countryCode: "CA" }] }, { database }))
      .toMatchObject({ status: "NEEDS_INPUT" });
    expect(await resolveCandidateQuestion("Would you relocate to Toronto?", {}, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    expect(await resolveCandidateQuestion("Would you relocate to Fixture Bay?", {
      postingPlaces: [{ city: "Fixture Bay", countryCode: "US" }, { city: "Fixture Bay", countryCode: "CA" }]
    }, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    // The city's own answer wins over the U.S.-wide one.
    save(database, "willing_to_relocate", { kind: "location", name: "Fixture Bay" }, false);
    expect(await resolveCandidateQuestion("Are you willing to relocate to Fixture Bay?", usPosting, { database })).toMatchObject({
      status: "RESOLVED", displayAnswer: "No", fact: { scope: { kind: "location", name: "Fixture Bay" } }
    });
    database.close();

    // A saved U.S.-wide No never widens to a city.
    const refused = workspace();
    save(refused, "willing_to_relocate", { kind: "country", code: "US" }, false);
    expect(await resolveCandidateQuestion("Are you willing to relocate to Fixture Bay?", usPosting, { database: refused })).toMatchObject({ status: "NEEDS_INPUT" });
    refused.close();
  });

  it("answers a compound relocation question only when its other parts are settled (Track 62)", async () => {
    const database = workspace();
    save(database, "willing_to_relocate", { kind: "country", code: "US" }, true);
    const usPosting: QuestionContext = { postingCountryCode: "US", postingPlaces: [{ city: "Fixture Bay", countryCode: "US" }] };
    const fiveDays = "This position requires you to work 5 days per week for the duration of the internship. Are you currently located in, or willing to relocate to Fixture Bay?";
    const inOffice = "This role is fully in-office, five days a week. Are you able to meet this requirement, and/or are you open to relocating to meet this requirement?";
    // Without a saved on-site Yes, the on-site part holds it.
    expect(await resolveCandidateQuestion(fiveDays, usPosting, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    save(database, "work_arrangement", { kind: "global" }, true);
    expect(await resolveCandidateQuestion(fiveDays, usPosting, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    expect(await resolveCandidateQuestion(inOffice, { postingCountryCode: "US" }, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    // Stated dates and a temporary move stay with the candidate.
    expect(await resolveCandidateQuestion("Can you relocate to Fixture Bay for the Summer internship (June-August)?", usPosting, { database })).toMatchObject({
      status: "NEEDS_INPUT", reason: "It also asks about your availability on stated dates or for a stated length."
    });
    expect(await resolveCandidateQuestion("Will you be willing to commute/drive or temporarily relocate to state/cities where there is a Fixture Dynamics office in your region during the program?NOTE: Fixture Dynamics does not provide relocation support or housing.", usPosting, { database }))
      .toMatchObject({ status: "NEEDS_INPUT" });
    expect(await resolveCandidateQuestion("Would you be willing to temporarily relocate?", usPosting, { database }))
      .toMatchObject({ status: "NEEDS_INPUT", reason: "It asks about a temporary move." });
    // An answer typed for a compound question is used once and never saved.
    const before = factCount(database);
    expect(await answerCandidateQuestion({ question: fiveDays, answer: "yes", remember: true, context: usPosting }, { database })).toMatchObject({ status: "ANSWERED_ONCE" });
    expect(factCount(database)).toBe(before);
    database.close();
  });

  it("answers conditional, own-expense, and on-site relocation questions from the saved U.S. answers (Track 83)", async () => {
    const database = workspace();
    save(database, "willing_to_relocate", { kind: "country", code: "US" }, true);
    save(database, "work_arrangement", { kind: "global" }, true);
    const us: QuestionContext = { postingCountryCode: "US" };
    const fixtureCity: QuestionContext = { postingCountryCode: "US", postingPlaces: [{ city: "Fixture City", countryCode: "US" }] };
    const onYourOwn = "At this time we do not offer relocation assistance to interns. If hired, are you able to relocate on your own if you are not based locally?";
    const noStipend = "Are you able to work onsite at the location specified during the role's duration? Please note that, while this role is paid, a separate relocation stipend will not be provided.";
    // Without a saved own-expense answer, the own-expense question waits.
    expect(await resolveCandidateQuestion(onYourOwn, us, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    save(database, "willing_to_relocate_at_own_expense", { kind: "country", code: "US" }, true);
    for (const [question, context] of [
      ["If you do not live in the Fixture Bay area, are you able to relocate?", us],
      ["If you do not currently live a commutable distance, are you able to relocate for the summer for this intern position?", us],
      ["If this position is located in Fixture City, CO as Hybrid, are you willing to relocate to Fixture City if you are not already local?", fixtureCity],
      [onYourOwn, us],
      [noStipend, us]
    ] as const) {
      expect(await resolveCandidateQuestion(question, context, { database }), question).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes" });
    }
    // A move after the internship stays with the candidate.
    expect(await resolveCandidateQuestion("Are you able to relocate to any of the locations below following the end of the internship, at Fixture's discretion?", us, { database }))
      .toMatchObject({ status: "NEEDS_INPUT", reason: "It asks about a permanent move or one after the internship." });
    database.close();
  });

  it("answers full-time availability inside the saved window, an ACT question from a saved did-not-take, and County (Track 83, round 2)", async () => {
    const database = workspace();
    const airbnbShape = "Are you able to commit to a full-time internship (40 hours per week) from May 24, 2031 - August 13, 2031?";
    save(database, "available_full_time", { kind: "global" }, true);
    // Without a saved end date, a dated question waits.
    save(database, "available_start_date", { kind: "global" }, "2031-05-15");
    expect(await resolveCandidateQuestion(airbnbShape, {}, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    save(database, "available_end_date", { kind: "global" }, "2031-08-15");
    for (const question of [
      airbnbShape,
      "Are you available to work full-time (40 hours per week) between June 7, 2031 - August 13, 2031?",
      "Are you available for a 12-week full-time (40 hours per week) internship during your select term(s)?",
      "Are you available to work full time?"
    ]) {
      expect(await resolveCandidateQuestion(question, {}, { database }), question).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { key: "available_full_time" } });
    }
    expect(await resolveCandidateQuestion("Are you able to commit to a full-time internship from May 24, 2031 - August 29, 2031?", {}, { database }))
      .toMatchObject({ status: "NEEDS_INPUT", reason: "It states dates outside your saved availability, or your availability dates are not saved." });

    // ACT: a saved did-not-take answers the score question; a saved score wins; a saved Yes to taking it answers nothing.
    expect(await resolveCandidateQuestion("ACT Score", {}, { database })).toMatchObject({ status: "NEEDS_INPUT" });
    save(database, "act_taken", { kind: "global" }, false);
    expect(await resolveCandidateQuestion("ACT Score", {}, { database })).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "act_taken" } });
    save(database, "act_score", { kind: "global" }, "30");
    expect(await resolveCandidateQuestion("ACT Score", {}, { database })).toMatchObject({ status: "RESOLVED", fact: { key: "act_score" } });
    database.close();
    const took = workspace();
    save(took, "act_taken", { kind: "global" }, true);
    expect(await resolveCandidateQuestion("ACT Score", {}, { database: took })).toMatchObject({ status: "NEEDS_INPUT" });
    save(took, "county", { kind: "global" }, "Fixture County");
    expect(await resolveCandidateQuestion("County", {}, { database: took })).toMatchObject({ status: "RESOLVED", displayAnswer: "Fixture County", fact: { key: "county" } });
    took.close();
  });

  it("answers age thresholds one way only: 18-or-older Yes answers 16-or-older, 16-or-older No answers 18-or-older, never the reverse (Track 57)", async () => {
    const sixteen = "Are you 16 years or older?";
    const eighteen = "Are you 18 or older?";
    const global: FactScope = { kind: "global" };

    const adult = workspace();
    save(adult, "age_18_or_older", global, true);
    expect(await resolveCandidateQuestion(sixteen, {}, { database: adult })).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { key: "age_18_or_older" } });
    adult.close();

    const young = workspace();
    save(young, "age_16_or_older", global, false);
    expect(await resolveCandidateQuestion(eighteen, {}, { database: young })).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "age_16_or_older" } });
    young.close();

    const minor = workspace();
    save(minor, "age_18_or_older", global, false);
    expect(await resolveCandidateQuestion(sixteen, {}, { database: minor })).toMatchObject({ status: "NEEDS_INPUT", mapping: { key: "age_16_or_older" } });
    minor.close();

    const teen = workspace();
    save(teen, "age_16_or_older", global, true);
    expect(await resolveCandidateQuestion(eighteen, {}, { database: teen })).toMatchObject({ status: "NEEDS_INPUT", mapping: { key: "age_18_or_older" } });
    teen.close();

    // The question's own saved answer comes first.
    const own = workspace();
    save(own, "age_16_or_older", global, false);
    save(own, "age_18_or_older", global, true);
    expect(await resolveCandidateQuestion(sixteen, {}, { database: own })).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "age_16_or_older" } });
    own.close();
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
    // F-1 OPT (Track 32): a saved U.S. citizenship Yes decides No; the answer is never stored.
    for (const question of [
      "Are you currently in a period of Optional Practical Training (OPT)?",
      "Are you eligible for a 24-month OPT extension based upon a US degree in STEM?"
    ]) {
      expect(await resolve(database, question), question).toMatchObject({
        status: "RESOLVED", displayAnswer: "No", fact: { key: "f1_optional_practical_training", id: "derived:f1_optional_practical_training" }
      });
    }
    expect(() => save(database, "f1_optional_practical_training", false)).toThrow(/never stored/);
    database.close();
  });

  it("answers F-1 OPT questions No only from a saved citizen or permanent-resident status, and never Yes (Track 32)", async () => {
    const question = "Are you currently in a period of Optional Practical Training (OPT)?";
    const resident = workspace();
    save(resident, "us_person_export_controls", "A lawful permanent resident of the United States");
    expect(await resolve(resident, question)).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "f1_optional_practical_training" } });
    resident.close();

    const foreign = workspace();
    save(foreign, "us_citizen", false);
    save(foreign, "us_person_export_controls", "None of the above");
    expect(await resolve(foreign, question)).toMatchObject({ status: "NEEDS_INPUT" });
    foreign.close();

    const empty = workspace();
    expect(await resolve(empty, question)).toMatchObject({ status: "NEEDS_INPUT" });
    empty.close();
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

  it("builds the unrestricted right to work in the United States from saved answers, never from work authorization alone (Track 43)", async () => {
    const question = "Do you have the unrestricted right to work in the United States?";
    const US: FactScope = { kind: "country", code: "US" };
    const citizen = workspace();
    save(citizen, "us_citizen", true);
    expect(await resolve(citizen, question)).toMatchObject({
      status: "RESOLVED", displayAnswer: "Yes", fact: { key: "unrestricted_us_work_authorization", id: "derived:unrestricted_us_work_authorization" }
    });
    expect(() => save(citizen, "unrestricted_us_work_authorization", true)).toThrow(/never stored/);
    citizen.close();

    const resident = workspace();
    save(resident, "us_person_export_controls", "A lawful permanent resident of the United States");
    expect(await resolve(resident, question)).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { key: "unrestricted_us_work_authorization" } });
    resident.close();

    const notAuthorized = workspace();
    save(notAuthorized, "us_citizen", false);
    save(notAuthorized, "us_person_export_controls", "None of the above");
    save(notAuthorized, "authorized_to_work", false, US);
    expect(await resolve(notAuthorized, question)).toMatchObject({ status: "RESOLVED", displayAnswer: "No", fact: { key: "unrestricted_us_work_authorization" } });
    notAuthorized.close();

    // Authorized but neither a citizen nor a permanent resident (a visa holder): the candidate answers.
    const authorizedOnly = workspace();
    save(authorizedOnly, "us_citizen", false);
    save(authorizedOnly, "us_person_export_controls", "None of the above");
    save(authorizedOnly, "authorized_to_work", true, US);
    expect(await resolve(authorizedOnly, question)).toMatchObject({ status: "NEEDS_INPUT" });
    authorizedOnly.close();

    const disagree = workspace();
    save(disagree, "us_citizen", true);
    save(disagree, "authorized_to_work", false, US);
    expect(await resolve(disagree, question)).toMatchObject({ status: "NEEDS_INPUT" });
    disagree.close();

    const empty = workspace();
    expect(await resolve(empty, question)).toMatchObject({ status: "NEEDS_INPUT" });
    empty.close();
  });

  it("answers a broader current-student question only with a saved Yes to full-time enrollment, and never saves an answer to it (Track 43)", async () => {
    const question = "Are you a current student enrolled in a college/university program or have graduated within the past 12 months? Undergraduate, postgraduate, or associate programs accepted.";
    const enrolled = workspace();
    save(enrolled, "enrolled_full_time", true);
    expect(await resolve(enrolled, question)).toMatchObject({ status: "RESOLVED", displayAnswer: "Yes", fact: { key: "enrolled_full_time" } });
    enrolled.close();

    const partTime = workspace();
    save(partTime, "enrolled_full_time", false);
    expect(await resolve(partTime, question)).toMatchObject({ status: "NEEDS_INPUT", mapping: { key: "enrolled_full_time", broader: true } });
    partTime.close();

    const empty = workspace();
    expect(await resolve(empty, question)).toMatchObject({ status: "NEEDS_INPUT" });
    const before = factCount(empty);
    expect(await answerCandidateQuestion({ question, answer: "Yes", remember: true, context: {} }, { database: empty })).toMatchObject({
      status: "ANSWERED_ONCE", displayAnswer: "Yes"
    });
    expect(factCount(empty)).toBe(before);
    expect(empty.prepare("SELECT COUNT(*) AS count FROM candidate_facts WHERE key = 'enrolled_full_time'").get()).toMatchObject({ count: 0 });
    empty.close();

    const pause: PauseRecord = {
      fieldId: "current-student",
      label: question,
      question: `How should "${question}" be answered?`,
      suggestedKey: null,
      suggestedScope: null,
      safeguard: false,
      sensitive: false,
      upload: false,
      status: "open",
      answer: null,
      draft: null,
      fieldKind: "select",
      options: ["Yes", "No"]
    };
    expect(await planPauseMemory(pause, { companyName: "Fixture Learning", context: {} })).toEqual({ path: "once", reason: "fact_rule" });
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
