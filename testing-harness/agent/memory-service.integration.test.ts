import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { answerCandidateQuestion, resolveCandidateQuestion } from "@internship-agent/agent";
import { createDatabase, LOCAL_CANDIDATE_ID, replaceCoursework, saveCandidateFact, seedDevelopmentData } from "@internship-agent/db";
import { formatCourseworkAnswer, type CourseworkSet, type FactScope } from "@internship-agent/domain";

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
