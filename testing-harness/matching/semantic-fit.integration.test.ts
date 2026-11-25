import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase, seedDevelopmentData, listJobSummaries, getJobPosting, getSemanticFit, getJobStatus, setJobStatus, listFitScores, getSemanticFitFailure,
  clearApplicationIntent, LOCAL_CANDIDATE_ID, replaceCoursework, saveApplicationIntent, saveCandidateFact, type SaveCandidateFactInput } from "@internship-agent/db";
import { APPLICATION_INTENT_EXAMPLE, candidateFactKeySchema, FIT_CONTEXT_FACT_KEYS, type CourseworkSet } from "@internship-agent/domain";
import { advancePipeline, analyzeSemanticFit, automaticallyAnalyzeFit, evaluateAndPersistMatch, getMatchReport, redactFitText, SEMANTIC_FIT_MAX_ATTEMPTS } from "@internship-agent/agent";
import type { ModelProvider, StructuredRequest } from "../../packages/agent/src/model/provider";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "internship-semantic-fit-"));
  const path = join(directory, "test.sqlite");
  const database = createDatabase(path); seedDevelopmentData(database);
  const jobId = listJobSummaries(database)[0].id;
  evaluateAndPersistMatch(jobId, { database });
  return { database, jobId, path, close: () => { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function provider(onInput?: (input: string) => void): ModelProvider & { calls: number } {
  return { available: true, calls: 0, async complete<T>(request: StructuredRequest<T>) {
    this.calls += 1; onInput?.(request.input);
    const input = JSON.parse(request.input) as { postingText: string };
    return { value: request.schema.parse({ score: 23, rating: "WEAK", confidence: "LOW", summary: "Candidate alignment is limited in this synthetic fixture.",
      strengths: [], gaps: [{text: "Depth is not demonstrated.", postingQuote: input.postingText.slice(0, 60), citations: []}], unknowns: ["Applicant pool is unknown."] }), model: "fixture", inputTokens: 10, outputTokens: 10, reasoningTokens: 0, durationMs: 1 };
  } };
}
function saveFixtureFact(database: DatabaseSync, key: SaveCandidateFactInput["key"], scope: SaveCandidateFactInput["scope"], value: SaveCandidateFactInput["value"]) {
  return saveCandidateFact(database, { candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user", sourceDetail: { kind: "profile" },
    confidence: 1, rememberedAt: "2026-11-25T00:00:00.000Z" });
}
type ParsedFitInput = { postingText: string; evidence: Array<{ id: string; text: string }> };
function scripted(responses: Array<(input: ParsedFitInput) => unknown>): ModelProvider & { calls: number; inputs: string[] } {
  return { available: true, calls: 0, inputs: [], async complete<T>(request: StructuredRequest<T>) {
    this.calls += 1; this.inputs.push(request.input);
    const input = JSON.parse(request.input) as ParsedFitInput;
    const make = responses[Math.min(this.calls - 1, responses.length - 1)];
    return { value: request.schema.parse(make(input)), model: "fixture", inputTokens: 10, outputTokens: 10, reasoningTokens: 0, durationMs: 1 };
  } };
}
const invalidResponse = (input: ParsedFitInput) => ({ score: 81, rating: "STRONG", confidence: "MEDIUM", summary: "Relevant transferable experience.",
  strengths: [{ text: "Relevant project", postingQuote: input.postingText.slice(0, 60),
    citations: [{ evidenceId: "resume:hallucinated", quote: input.evidence[0].text.slice(0, 500) }] }],
  gaps: [], unknowns: ["Applicant pool is unknown."] });
const validResponse = (input: ParsedFitInput) => ({ score: 81, rating: "STRONG", confidence: "MEDIUM", summary: "Relevant transferable experience.",
  strengths: [{ text: "Relevant project", postingQuote: input.postingText.slice(0, 60),
    citations: [{ evidenceId: input.evidence[0].id, quote: input.evidence[0].text.slice(0, 500) }] }],
  gaps: [], unknowns: ["Applicant pool is unknown."] });
describe("semantic fit cache and safety", () => {
  it("automatically analyzes once, caches without changing approval, and invalidates on profile or requirement changes", async () => {
    const { database, jobId, close } = fixture();
    try {
      setJobStatus(database, jobId, null, "APPROVED", "Fixture approval");
      const model = provider((input) => { expect(input).not.toContain("jordan.rivera@example.com"); expect(input).not.toContain("candidate_facts"); });
      const first = await automaticallyAnalyzeFit(jobId, database, model);
      expect(first?.unknownCount).toBeGreaterThan(0); expect(first?.score).toBe(23);
      await automaticallyAnalyzeFit(jobId, database, model);
      expect(model.calls).toBe(1); expect(getJobStatus(database, jobId)).toBe("APPROVED");
      expect(listFitScores(database).get(jobId)).toBe(23);
      database.prepare("UPDATE candidates SET field_of_study = 'Fixture changed field'").run();
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
      await analyzeSemanticFit(jobId, { database, provider: model });
      expect(model.calls).toBe(2);
      const requirement = getJobPosting(database, jobId)!.requirements[0];
      database.prepare("UPDATE job_requirements SET confidence = 0.9 WHERE id = ?").run(requirement.id);
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
      database.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
      expect(getSemanticFit(database, jobId)).toBeNull();
    } finally { close(); }
  });
  it("assesses the full description without extracted requirements, including non-bulleted qualifications", async () => {
    const { database, jobId, close } = fixture();
    try {
      database.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(jobId);
      const text = "Minimum Education:\nHigh School or GED\nMinimum Years Experience:\n0\nSpecial Skills:\nNeeds to be officially enrolled in an undergraduate bachelor program.\nReceive training in tools such as Microsoft SharePoint, Power Bi, and SQL.";
      database.prepare("UPDATE job_snapshots SET normalized_text = ? WHERE job_id = ? AND superseded_at IS NULL").run(text, jobId);
      const model = provider((input) => {
        const parsed = JSON.parse(input);
        expect(parsed.postingText).toBe(text);
        expect(parsed.requirements).toBeUndefined();
        expect(parsed.evidence.some((e: { id: string }) => e.id === "profile:education")).toBe(true);
      });
      const result = await automaticallyAnalyzeFit(jobId, database, model);
      expect(result?.version).toBe(2);
      expect(result?.score).toBe(23);
      expect(model.calls).toBe(1);
      expect(getSemanticFitFailure(database, jobId)).toBeNull();
      expect(getMatchReport(jobId, database)?.fitScore).toBe(23);
    } finally { close(); }
  });
  it("excludes old coverage assessments and old extraction failures from current competitiveness", async () => {
    const { database, jobId, close } = fixture();
    try {
      const model = provider();
      await automaticallyAnalyzeFit(jobId, database, model);
      const old = { version: 1, score: 100, unknownCount: 0, decisions: [], model: "legacy", evaluatedAt: new Date().toISOString() };
      database.prepare("UPDATE semantic_fit_cache SET assessment_json = ?,score = 100 WHERE job_id = ?").run(JSON.stringify(old),jobId);
      expect(getSemanticFit(database,jobId)?.stale).toBe(true);
      expect(listFitScores(database).get(jobId)).toBeUndefined();
      database.prepare("INSERT INTO semantic_fit_failures(job_id,failed_at,context_version,requirement_version,snapshot_id) SELECT job_id,?,context_version,requirement_version,snapshot_id FROM semantic_fit_cache WHERE job_id = ?").run(new Date().toISOString(),jobId);
      expect(getSemanticFitFailure(database,jobId)).toBeNull();
      await automaticallyAnalyzeFit(jobId,database,model);
      expect(model.calls).toBe(2);
      expect(getSemanticFit(database,jobId)?.stale).toBe(false);
    } finally { close(); }
  });
  it("pipeline automatically fills the cache while preserving an approved application", async () => {
    const { database, jobId, close } = fixture();
    try {
      setJobStatus(database, jobId, null, "APPROVED", "Fixture approval");
      const model = provider();
      await advancePipeline({ database, fitProvider: model,
        settings: { autoApply: false, minFit: 60 } });
      expect(model.calls).toBe(1);
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      expect(getJobStatus(database, jobId)).toBe("APPROVED");
    } finally { close(); }
  });
  it("repairs a rejected citation response once the validator names the defect", async () => {
    const { database, jobId, close } = fixture();
    try {
      const script = [invalidResponse, validResponse];
      const model = scripted(script);
      const result = await automaticallyAnalyzeFit(jobId, database, model);
      expect(result?.score).toBe(81);
      expect(model.calls).toBe(2);
      const repair = JSON.parse(model.inputs[1]) as { validEvidenceIds: string[]; previousResponse: { strengths: Array<{ citations: Array<{ evidenceId: string }> }> }; issues: string[] };
      expect(repair.validEvidenceIds.length).toBeGreaterThan(0);
      expect(repair.previousResponse.strengths[0].citations[0].evidenceId).toBe("resume:hallucinated");
      expect(repair.issues.join(" ")).toMatch(/not one of the supplied evidence IDs/);
      expect(getSemanticFitFailure(database, jobId)).toBeNull();
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      const outcomes = (database.prepare("SELECT outcome FROM model_invocations WHERE job_id = ? ORDER BY created_at").all(jobId) as Array<{ outcome: string }>).map((row) => row.outcome);
      expect(outcomes).toEqual(["failed", "succeeded"]);
    } finally { close(); }
  });
  it("exhausts repairs on persistently invalid responses, then records one failure", async () => {
    const { database, jobId, close } = fixture();
    try {
      const model = scripted([invalidResponse]);
      expect(await automaticallyAnalyzeFit(jobId, database, model)).toBeNull();
      expect(model.calls).toBe(SEMANTIC_FIT_MAX_ATTEMPTS);
      expect(getSemanticFit(database, jobId)).toBeNull();
      expect(getSemanticFitFailure(database, jobId)).not.toBeNull();
      const outcomes = (database.prepare("SELECT outcome FROM model_invocations WHERE job_id = ?").all(jobId) as Array<{ outcome: string }>).map((row) => row.outcome);
      expect(outcomes).toEqual(Array(SEMANTIC_FIT_MAX_ATTEMPTS).fill("failed"));
    } finally { close(); }
  });
  it("refuses responses if source inputs changed in flight, and records failure without changing state", async () => {
    const { database, jobId, close } = fixture();
    try {
      const status = getJobStatus(database, jobId);
      const model = provider(() => { database.prepare("UPDATE candidates SET field_of_study = 'Changed during model call'").run(); });
      await expect(analyzeSemanticFit(jobId, { database, provider: model })).rejects.toThrow("AI fit failed");
      expect(getSemanticFit(database, jobId)).toBeNull(); expect(getJobStatus(database, jobId)).toBe(status);
      expect(database.prepare("SELECT outcome FROM model_invocations WHERE task = 'job.semantic_fit'").get()).toMatchObject({ outcome: "failed" });
      expect(redactFitText("Student ID: 123456789 api_key=secretvalue sk-abcdefghijklmnopqrstuvwxyz person@example.com"))
        .not.toMatch(/123456789|secretvalue|sk-abc|person@/);
    } finally { close(); }
  });
  it("sends the intent, the candidate's level, and the selectivity instruction, never the student ID", async () => {
    const { database, jobId, close } = fixture();
    try {
      database.prepare("UPDATE candidates SET graduation_date = '2028-05-15'").run();
      saveApplicationIntent(database, LOCAL_CANDIDATE_ID, `${APPLICATION_INTENT_EXAMPLE} Student ID: 3039123456`);
      const sent: Array<{ input: string; instructions: string }> = [];
      const model = provider();
      const capture: ModelProvider = { available: true, complete<T>(request: StructuredRequest<T>) {
        sent.push({ input: request.input, instructions: request.instructions }); return model.complete(request);
      } };
      await analyzeSemanticFit(jobId, { database, provider: capture, term: { season: "summer", year: 2027 } });
      expect(sent).toHaveLength(1);
      const { input, instructions } = sent[0]!;
      expect(input).not.toContain("3039123456");
      expect(input).not.toContain("jordan@example.test");
      const parsed = JSON.parse(input) as { candidateContext: { intent: string | null; level: Record<string, string | null> }; evidence: Array<{ id: string }> };
      expect(parsed.candidateContext.intent).toContain("realistic candidate");
      expect(parsed.candidateContext.level.school).toBe("Example State University");
      expect(parsed.candidateContext.level.degree).toBe("B.S. Computer Science");
      expect(parsed.candidateContext.level.expectedGraduation).toBe("2028-05-15");
      expect(parsed.candidateContext.level.internshipTerm).toBe("summer 2027");
      expect(parsed.candidateContext.level.standingDuringTerm).toContain("rising senior");
      expect(parsed.evidence.map((entry) => entry.id)).toContain("profile:education");
      expect(parsed.evidence.map((entry) => entry.id)).not.toContain("candidateContext");
      expect(instructions).toContain("how selective this employer or program usually is");
      expect(instructions).toContain("never state odds");
      expect(instructions).toContain("candidateContext.intent");

      clearApplicationIntent(database, LOCAL_CANDIDATE_ID);
      await analyzeSemanticFit(jobId, { database, provider: capture, term: null });
      const bare = JSON.parse(sent[1]!.input) as { candidateContext: { intent: string | null; level: Record<string, string | null> } };
      expect(bare.candidateContext.intent).toBeNull();
      expect(bare.candidateContext.level.internshipTerm).toBeNull();
      expect(bare.candidateContext.level.standingDuringTerm).toBeNull();
    } finally { close(); }
  });
  it("a fit scored before the prompt revision is stale and leaves the current scores", async () => {
    const { database, jobId, path, close } = fixture();
    try {
      await analyzeSemanticFit(jobId, { database, provider: provider() });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      expect(listFitScores(database).get(jobId)).toBe(23);
      const row = database.prepare("SELECT version FROM schema_migrations WHERE version LIKE '%_application_intent.sql'").get() as { version: string } | undefined;
      expect(row).toBeDefined();
      database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(row!.version);
      // Reopening re-runs the idempotent migration, as an upgrade from before the revision would.
      const upgraded = createDatabase(path);
      try {
        expect(getSemanticFit(upgraded, jobId)?.stale).toBe(true);
        expect(listFitScores(upgraded).get(jobId)).toBeUndefined();
      } finally { upgraded.close(); }
    } finally { close(); }
  });
  it("a changed intent marks the fit stale", async () => {
    const { database, jobId, close } = fixture();
    try {
      const model = provider();
      await analyzeSemanticFit(jobId, { database, provider: model });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      saveApplicationIntent(database, LOCAL_CANDIDATE_ID, "Summer 2027 data engineering internships only.");
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
      await analyzeSemanticFit(jobId, { database, provider: model });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      clearApplicationIntent(database, LOCAL_CANDIDATE_ID);
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
    } finally { close(); }
  });
  // Neutral coursework fixture: a fictional school and generic course codes.
  const coursework: CourseworkSet = { school: "Example State University", courses: [
    { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" },
    { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "in_progress" }
  ] };
  it("cites coursework: each saved course is an evidence item after the existing ones, labelled in progress, with no grades", async () => {
    const { database, jobId, close } = fixture();
    try {
      replaceCoursework(database, LOCAL_CANDIDATE_ID, coursework);
      const courseResponse = (input: ParsedFitInput) => ({ score: 81, rating: "STRONG", confidence: "MEDIUM", summary: "Relevant coursework.",
        strengths: [{ text: "Data structures coursework", postingQuote: input.postingText.slice(0, 60),
          citations: [{ evidenceId: "course:CS-61B", quote: "CS 61B Data Structures" }] }],
        gaps: [], unknowns: ["Applicant pool is unknown."] });
      const model = scripted([courseResponse]);
      const instructions: string[] = [];
      const capture: ModelProvider = { available: true, complete<T>(request: StructuredRequest<T>) {
        instructions.push(request.instructions); return model.complete(request);
      } };
      const result = await analyzeSemanticFit(jobId, { database, provider: capture });
      expect(result?.score).toBe(81);
      expect(model.calls).toBe(1);
      const evidence = (JSON.parse(model.inputs[0]!) as ParsedFitInput).evidence;
      const ids = evidence.map((entry) => entry.id);
      expect(ids).toContain("course:CS-61B");
      expect(ids).toContain("course:CS-189");
      const firstCourse = ids.findIndex((id) => id.startsWith("course:"));
      expect(ids.slice(firstCourse).every((id) => id.startsWith("course:"))).toBe(true);
      expect(ids.slice(0, firstCourse).length).toBeGreaterThan(0);
      const courses = evidence.filter((entry) => entry.id.startsWith("course:"));
      expect(courses.find((entry) => entry.id === "course:CS-189")?.text).toContain("in progress (not yet completed)");
      expect(courses.find((entry) => entry.id === "course:CS-61B")?.text).toContain("Status: completed");
      for (const entry of courses) expect(entry.text).not.toMatch(/grade/i);
      expect(instructions[0]).toContain("course:");
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
    } finally { close(); }
  });
  it("changed coursework marks the fit stale", async () => {
    const { database, jobId, close } = fixture();
    try {
      const model = provider();
      await analyzeSemanticFit(jobId, { database, provider: model });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      replaceCoursework(database, LOCAL_CANDIDATE_ID, coursework);
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
      await analyzeSemanticFit(jobId, { database, provider: model });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      replaceCoursework(database, LOCAL_CANDIDATE_ID, structuredClone(coursework));
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      replaceCoursework(database, LOCAL_CANDIDATE_ID, { school: coursework.school, courses: [] });
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
    } finally { close(); }
  });
  it("a fit scored before the coursework prompt revision is stale", async () => {
    const { database, jobId, path, close } = fixture();
    try {
      await analyzeSemanticFit(jobId, { database, provider: provider() });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      expect(listFitScores(database).get(jobId)).toBe(23);
      const row = database.prepare("SELECT version FROM schema_migrations WHERE version LIKE '%_candidate_coursework.sql'").get() as { version: string } | undefined;
      expect(row).toBeDefined();
      database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(row!.version);
      // Reopening re-runs the idempotent migration, as an upgrade from before the revision would.
      const upgraded = createDatabase(path);
      try {
        expect(getSemanticFit(upgraded, jobId)?.stale).toBe(true);
        expect(listFitScores(upgraded).get(jobId)).toBeUndefined();
      } finally { upgraded.close(); }
    } finally { close(); }
  });
  it("the fit prompt reads only FIT_CONTEXT_FACT_KEYS from candidate facts", async () => {
    const { database, jobId, close } = fixture();
    const reads: Array<{ sql: string; args: unknown[] }> = [];
    try {
      saveFixtureFact(database, "graduation_date", { kind: "global" }, "2029-05-15");
      saveFixtureFact(database, "how_heard", { kind: "global" }, "Company website");
      saveFixtureFact(database, "willing_background_check", { kind: "global" }, true);
      saveFixtureFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
      const prepare = database.prepare.bind(database);
      Object.defineProperty(database, "prepare", { configurable: true, value: (sql: string) => {
        const statement = prepare(sql);
        if (!sql.includes("candidate_facts")) return statement;
        return new Proxy(statement, { get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || !["get", "all", "iterate"].includes(String(property))) return value;
          return (...args: unknown[]) => { reads.push({ sql, args }); return Reflect.apply(value, target, args); };
        } });
      } });
      const inputs: string[] = [];
      await analyzeSemanticFit(jobId, { database, provider: provider((input) => inputs.push(input)), term: { season: "summer", year: 2027 } });
      Reflect.deleteProperty(database, "prepare");
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) expect(read.sql).toMatch(/\bkey\s*=\s*\?/);
      const factKeys: readonly string[] = candidateFactKeySchema.options;
      const keysRead = [...new Set(reads.flatMap((read) => read.args).filter((arg): arg is string => typeof arg === "string" && factKeys.includes(arg)))].sort();
      expect(keysRead).toEqual([...FIT_CONTEXT_FACT_KEYS].sort());
      const parsed = JSON.parse(inputs[0]!) as { candidateContext: { level: { expectedGraduation: string | null } } };
      expect(parsed.candidateContext.level.expectedGraduation).toBe("2029-05-15");
    } finally { Reflect.deleteProperty(database, "prepare"); close(); }
  });
  it("saving facts the fit does not read leaves the AI fit current", async () => {
    const { database, jobId, close } = fixture();
    try {
      await analyzeSemanticFit(jobId, { database, provider: provider() });
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      saveFixtureFact(database, "willing_background_check", { kind: "global" }, true);
      saveFixtureFact(database, "eeo_gender", { kind: "global" }, "non_binary");
      saveFixtureFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
      saveFixtureFact(database, "how_heard", { kind: "global" }, "Company website");
      expect(getSemanticFit(database, jobId)?.stale).toBe(false);
      expect(listFitScores(database).get(jobId)).toBe(23);
      saveFixtureFact(database, "graduation_date", { kind: "global" }, "2029-05-15");
      expect(getSemanticFit(database, jobId)?.stale).toBe(true);
    } finally { close(); }
  });
});
