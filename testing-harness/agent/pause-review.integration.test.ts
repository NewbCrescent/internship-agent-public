import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getBrowserRun,
  getCandidate,
  getJobPosting,
  listApplicationEvents,
  LOCAL_CANDIDATE_ID,
  saveCandidateFact,
  type SaveCandidateFactInput
} from "@internship-agent/db";
import type { RawControl } from "@internship-agent/browser";
import {
  aiReviewMatchReason,
  autoSubmitBlockers,
  factDefinitions,
  factGroupsOf,
  isAiReviewMatchReason,
  questionSaveBlocker
} from "@internship-agent/domain";
import {
  approveRunSubmissionAutomatically,
  continueBrowserRun,
  createPauseReviewer,
  DeterministicQuestionMapper,
  ModelInvalidOutputError,
  startBrowserRun,
  submitBrowserRun,
  type ModelProvider,
  type PauseReviewer,
  type StructuredRequest,
  type StructuredResult
} from "@internship-agent/agent";

import { acquirePipelineLock } from "../../packages/agent/src/pipeline-lock";
import { runAnswerCommand, runQuestionsCommand, type RunCommandDeps } from "../../packages/agent/src/run-answer";
import { approvedJobId, cleanupTemporaryDirectories, disposableWorkspace, fakePage, POLICY_BASIS } from "./application-record-fixture";

/**
 * The AI review of a pause batch (Track 45) with a fake model provider: the
 * deterministic guardrails decide what the model's reviews may change. The
 * global fetch throws, so nothing reaches the network.
 */

const HANDSHAKE_URL = "https://app.joinhandshake.com/apply/900001";
const FULL_TIME_LABEL = "Studying on a full schedule?";
const submitButton: RawControl = { tag: "button", label: "Submit application" };
const AI_DRAFT_BLOCKER = "AI review suggested a draft; you review those.";

type Workspace = { database: DatabaseSync; dataDir: string; jobId: string; company: string };
type Review = { id: string; verdict: "saved_answer" | "needs_candidate" | "draft"; key: string | null; option: string | null; reason: string; draft: string | null };

const savedManual = process.env.INTERNSHIP_AGENT_MANUAL_ONLY;

beforeEach(() => {
  delete process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("No network in this suite.");
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedManual === undefined) delete process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
  else process.env.INTERNSHIP_AGENT_MANUAL_ONLY = savedManual;
  cleanupTemporaryDirectories();
});

function workspace(): Workspace {
  const { database, dataDir } = disposableWorkspace();
  const jobId = approvedJobId(database);
  const company = getJobPosting(database, jobId)!.companyName;
  return { database, dataDir, jobId, company };
}

function saveFact(database: DatabaseSync, input: Pick<SaveCandidateFactInput, "key" | "scope" | "value">) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, source: "user", sourceDetail: { kind: "profile" }, confidence: 1, rememberedAt: "2026-11-25T00:00:00.000Z", ...input
  });
}

/** A model stand-in: records each request and answers with the reviews given, or throws. */
function fakeModel(respond: (input: { questions: Array<{ id: string; label: string }> }) => Review[] | Error) {
  const requests: Array<StructuredRequest<unknown>> = [];
  const provider: ModelProvider = {
    available: true,
    async complete<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
      requests.push(request as StructuredRequest<unknown>);
      const answer = respond(JSON.parse(request.input) as { questions: Array<{ id: string; label: string }> });
      if (answer instanceof Error) throw answer;
      return { value: request.schema.parse({ reviews: answer }), model: "fake-model", inputTokens: 120, outputTokens: 40, reasoningTokens: 0, durationMs: 7 };
    }
  };
  return { provider, requests };
}

function reviewFor(input: { questions: Array<{ id: string; label: string }> }, label: string, review: Omit<Review, "id">): Review[] {
  const question = input.questions.find((entry) => entry.label === label);
  return question ? [{ id: question.id, ...review }] : [];
}

async function start(ws: Workspace, controls: RawControl[], pauseReviewer: PauseReviewer | null) {
  const page = fakePage({ controls });
  const report = await startBrowserRun(ws.jobId, HANDSHAKE_URL, {
    database: ws.database, dataDir: ws.dataDir, openPage: async () => page, voiceDrafter: null, pauseReviewer
  });
  return { run: report.run, page };
}

function select(id: string, label: string, options = ["Yes", "No"]): RawControl {
  return { tag: "select", id, label, required: true, options };
}

function eventDetails(ws: Workspace): string[] {
  return listApplicationEvents(ws.database, ws.jobId).map((event) => event.detail ?? "");
}

function invocations(database: DatabaseSync) {
  return database.prepare("SELECT task, tier, model, outcome FROM model_invocations WHERE task = 'application.pause_review'").all();
}

async function unmapped(label: string, ws: Workspace) {
  const mapping = await new DeterministicQuestionMapper().map(label, { companyName: ws.company, postingCountryCode: "US", fieldKind: "select" });
  expect(mapping.status, label).toBe("UNMAPPED");
  expect(factGroupsOf(label), label).toEqual([]);
}

describe("AI review of a pause batch", () => {
  it("applies a saved-answer match only after every check, records the wording, and lets the run auto-submit naming the question", async () => {
    const ws = workspace();
    await unmapped(FULL_TIME_LABEL, ws);
    expect(questionSaveBlocker({ label: FULL_TIME_LABEL, fieldId: "fulltime", fieldKind: "select", companyName: ws.company })).toBeNull();
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    const model = fakeModel((input) => reviewFor(input, FULL_TIME_LABEL, { verdict: "saved_answer", key: "enrolled_full_time", option: "Yes", reason: "Saved.", draft: null }));
    const reviewer = createPauseReviewer({ provider: model.provider, database: ws.database });
    const { run, page } = await start(ws, [select("fulltime", FULL_TIME_LABEL), submitButton], reviewer);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ task: "application.pause_review", tier: "cheap", jobId: ws.jobId, reasoningEffort: "low" });
    expect(run.decisions.find((decision) => decision.fieldId === "fulltime")).toMatchObject({
      action: "choose", value: "Yes", basis: { kind: "fact", key: "enrolled_full_time", scope: "global" }, reason: aiReviewMatchReason(FULL_TIME_LABEL)
    });
    expect(run.pauses).toEqual([]);
    expect(run.status).toBe("awaiting-approval");
    expect(page.filled.get("fulltime")).toBe("Yes");
    // The candidate's decision (2026-11-26): a guard-checked AI match does not hold the run from auto-submit.
    expect(autoSubmitBlockers(run)).toEqual([]);
    const details = eventDetails(ws);
    expect(details).toContain(`AI review matched '${FULL_TIME_LABEL}' to saved answer enrolled_full_time (global).`);
    expect(details).toContain("AI review looked at 1 open question(s): 1 matched saved answers, 0 wait for you, 0 suggested drafts (7 ms, 120 input and 40 output tokens).");
    expect(details).toContain(`AI review of "${FULL_TIME_LABEL}" (q1): verdict saved_answer, key enrolled_full_time; matched.`);
    expect(ws.database.prepare("SELECT wording, target_kind, fact_key, fact_scope_key, source FROM candidate_question_aliases").all()).toEqual([
      { wording: FULL_TIME_LABEL, target_kind: "fact", fact_key: "enrolled_full_time", fact_scope_key: "global", source: "ai_review" }
    ]);
    expect(invocations(ws.database)).toEqual([{ task: "application.pause_review", tier: "cheap", model: "fake-model", outcome: "succeeded" }]);

    // The auto-submit policy approves it, naming the matched question by label only, and the run is submitted.
    approveRunSubmissionAutomatically(run.id, POLICY_BASIS, { database: ws.database });
    const approval = eventDetails(ws).find((detail) => detail.startsWith("Submission approved automatically by your auto-submit policy"));
    expect(approval).toContain(`AI review matched your saved answers for: "${FULL_TIME_LABEL}".`);
    expect(approval).not.toContain("enrolled_full_time");
    expect(approval).not.toMatch(/\bYes\b/);
    const submitted = await submitBrowserRun(run.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => fakePage({ controls: [select("fulltime", FULL_TIME_LABEL), submitButton] }) });
    expect(submitted.status).toBe("submitted");
    ws.database.close();
  });

  it("applies a match on continue, keeps the pause answered, and does not hold the run", async () => {
    const ws = workspace();
    const controls = [select("fulltime", FULL_TIME_LABEL), submitButton];
    const { run } = await start(ws, controls, null);
    expect(run.pauses[0]).toMatchObject({ fieldId: "fulltime", status: "open" });
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    const model = fakeModel((input) => reviewFor(input, FULL_TIME_LABEL, { verdict: "saved_answer", key: "enrolled_full_time", option: null, reason: "Saved.", draft: null }));
    const page = fakePage({ controls });
    const continued = await continueBrowserRun(run.id, {
      database: ws.database, dataDir: ws.dataDir, openPage: async () => page,
      pauseReviewer: createPauseReviewer({ provider: model.provider, database: ws.database })
    });
    expect(continued.run.pauses[0]).toMatchObject({ status: "answered", answer: "Yes", suggestedKey: "enrolled_full_time", suggestedScope: "global" });
    expect(continued.run.decisions.find((decision) => decision.fieldId === "fulltime")?.reason).toBe(aiReviewMatchReason(FULL_TIME_LABEL));
    expect(continued.run.status).toBe("awaiting-approval");
    expect(page.filled.get("fulltime")).toBe("Yes");
    expect(autoSubmitBlockers(continued.run)).toEqual([]);
    ws.database.close();
  });

  it("rejects a match whose option disagrees, a sensitive answer, and a statement of fact, and says why", async () => {
    const ws = workspace();
    const ties = "Any ties to a federal employee in your circle?";
    const movesLabel = "Okay with frequent moves between offices?";
    expect((await new DeterministicQuestionMapper().map(ties, { companyName: ws.company, postingCountryCode: "US", fieldKind: "select" })).status).toBe("UNMAPPED");
    expect(factGroupsOf(ties)).not.toEqual([]);
    await unmapped(movesLabel, ws);
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    const model = fakeModel((input) => [
      ...reviewFor(input, FULL_TIME_LABEL, { verdict: "saved_answer", key: "enrolled_full_time", option: "No", reason: "Saved.", draft: null }),
      ...reviewFor(input, movesLabel, { verdict: "saved_answer", key: "authorized_to_work", option: "Yes", reason: "Saved.", draft: null }),
      ...reviewFor(input, ties, { verdict: "saved_answer", key: "enrolled_full_time", option: "Yes", reason: "Saved.", draft: null })
    ]);
    const { run, page } = await start(ws, [select("fulltime", FULL_TIME_LABEL), select("moves", movesLabel), select("ties", ties), submitButton],
      createPauseReviewer({ provider: model.provider, database: ws.database }));
    expect(run.status).toBe("paused-needs-input");
    const question = (fieldId: string) => run.pauses.find((pause) => pause.fieldId === fieldId)?.question ?? "";
    expect(run.pauses.every((pause) => pause.status === "open")).toBe(true);
    expect(question("fulltime")).toContain("AI review: AI review suggested a saved answer, but it did not pass the checks (option disagrees); answer it yourself.");
    expect(question("moves")).toContain("did not pass the checks (sensitive answer)");
    expect(question("ties")).toContain("did not pass the checks (statement of fact)");
    expect(page.filled.size).toBe(0);
    for (const fieldId of ["fulltime", "moves", "ties"]) {
      expect(page.filled.has(fieldId), fieldId).toBe(false);
      expect(run.decisions.find((decision) => decision.fieldId === fieldId)?.action, fieldId).toBe("pause");
    }
    expect(run.decisions.some((decision) => isAiReviewMatchReason(decision.reason))).toBe(false);
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_aliases").get() as { n: number }).n).toBe(0);
    ws.database.close();
  });

  it("logs one verdict line per reviewed question with labels, keys, and checks only, and keeps a mapped question refused (Track 54)", async () => {
    const ws = workspace();
    const movesLabel = "Okay with frequent moves between offices?";
    const relocateLabel = "Are you willing to relocate?";
    const officeLabel = "Which office do you prefer?";
    const teamLabel = "Preferred team size?";
    const paceLabel = "Preferred project pace?";
    for (const label of [FULL_TIME_LABEL, movesLabel, officeLabel, teamLabel, paceLabel]) await unmapped(label, ws);
    expect(await new DeterministicQuestionMapper().map(relocateLabel, { companyName: ws.company, postingCountryCode: "US", fieldKind: "select" }))
      .toMatchObject({ status: "MAPPED", key: "willing_to_relocate", scope: { kind: "country", code: "US" } });
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    saveFact(ws.database, { key: "willing_to_relocate", scope: { kind: "global" }, value: true });
    const model = fakeModel((input) => [
      ...reviewFor(input, FULL_TIME_LABEL, { verdict: "saved_answer", key: "enrolled_full_time", option: "No", reason: "Saved.", draft: null }),
      ...reviewFor(input, movesLabel, { verdict: "saved_answer", key: "authorized_to_work", option: "Yes", reason: "Saved.", draft: null }),
      ...reviewFor(input, relocateLabel, { verdict: "saved_answer", key: "willing_to_relocate", option: "Yes", reason: "Saved.", draft: null }),
      ...reviewFor(input, officeLabel, { verdict: "saved_answer", key: "made_up_key_do_not_echo", option: "North", reason: "Saved.", draft: null }),
      ...reviewFor(input, teamLabel, { verdict: "needs_candidate", key: null, option: null, reason: "REASON-TEXT-NOT-LOGGED", draft: null })
    ]);
    const controls = [
      select("fulltime", FULL_TIME_LABEL), select("moves", movesLabel), select("relocate", relocateLabel),
      select("office", officeLabel, ["North", "South"]), select("team", teamLabel, ["Small", "Large"]), select("pace", paceLabel, ["Steady", "Fast"]),
      submitButton
    ];
    const { run, page } = await start(ws, controls, createPauseReviewer({ provider: model.provider, database: ws.database }));

    expect(model.requests).toHaveLength(1);
    const ids = new Map((JSON.parse(model.requests[0]!.input) as { questions: Array<{ id: string; label: string }> }).questions.map((entry) => [entry.label, entry.id]));
    expect(ids.size).toBe(6);
    const details = eventDetails(ws);
    const lines = details.filter((detail) => detail.startsWith("AI review of "));
    expect(lines).toEqual([
      `AI review of "${FULL_TIME_LABEL}" (${ids.get(FULL_TIME_LABEL)}): verdict saved_answer, key enrolled_full_time; refused by the "option disagrees" check.`,
      `AI review of "${movesLabel}" (${ids.get(movesLabel)}): verdict saved_answer, key authorized_to_work; refused by the "sensitive answer" check.`,
      `AI review of "${relocateLabel}" (${ids.get(relocateLabel)}): verdict saved_answer, key willing_to_relocate; refused by the "mapped question" check (mapper: MAPPED willing_to_relocate).`,
      `AI review of "${officeLabel}" (${ids.get(officeLabel)}): verdict saved_answer, no usable key; refused by the "unknown key" check.`,
      `AI review of "${teamLabel}" (${ids.get(teamLabel)}): verdict needs_candidate; waits for you.`,
      `AI review of "${paceLabel}" (${ids.get(paceLabel)}): no review returned; waits for you.`
    ]);
    // No values: no answer, saved value, offered option, model key the review did not send, or model reason.
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/\bYes\b/);
    expect(joined).not.toMatch(/\bNo\b/);
    expect(joined).not.toMatch(/\b(North|South|Small|Large|Steady|Fast|true|false)\b/);
    expect(joined).not.toContain("made_up_key_do_not_echo");
    expect(joined).not.toContain("REASON-TEXT-NOT-LOGGED");
    expect(details).toContain("AI review looked at 6 open question(s): 0 matched saved answers, 6 wait for you, 0 suggested drafts (7 ms, 120 input and 40 output tokens).");

    // Every guardrail still holds: nothing is filled, every pause stays open, and no wording is recorded.
    expect(run.status).toBe("paused-needs-input");
    for (const fieldId of ["fulltime", "moves", "relocate", "office", "team", "pace"]) {
      expect(run.pauses.find((pause) => pause.fieldId === fieldId)?.status, fieldId).toBe("open");
      expect(page.filled.has(fieldId), fieldId).toBe(false);
      expect(run.decisions.find((decision) => decision.fieldId === fieldId)?.action, fieldId).toBe("pause");
    }
    expect(run.pauses.find((pause) => pause.fieldId === "relocate")?.question).toContain("did not pass the checks (mapped question)");
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_aliases").get() as { n: number }).n).toBe(0);
    ws.database.close();
  });

  it("adds the model's reason to a question that waits for the candidate", async () => {
    const ws = workspace();
    const model = fakeModel((input) => reviewFor(input, FULL_TIME_LABEL, { verdict: "needs_candidate", key: null, option: null, reason: "Nothing saved says\nwhether you study full time.", draft: null }));
    const { run } = await start(ws, [select("fulltime", FULL_TIME_LABEL), submitButton], createPauseReviewer({ provider: model.provider, database: ws.database }));
    expect(run.pauses[0]).toMatchObject({ status: "open" });
    expect(run.pauses[0]?.question).toMatch(/ AI review: Nothing saved says whether you study full time\.$/);
    ws.database.close();
  });

  it("sends sensitive values only as saved and nothing about protected self-identification categories or the candidate's identity", async () => {
    const ws = workspace();
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    const model = fakeModel(() => []);
    await start(ws, [select("fulltime", FULL_TIME_LABEL), submitButton], createPauseReviewer({ provider: model.provider, database: ws.database }));
    expect(model.requests).toHaveLength(1);
    const input = model.requests[0]!.input;
    const parsed = JSON.parse(input) as { savedAnswers: Array<{ key: string; value: string }> };
    expect(parsed.savedAnswers).toContainEqual(expect.objectContaining({ key: "authorized_to_work", value: "saved" }));
    expect(parsed.savedAnswers).toContainEqual(expect.objectContaining({ key: "enrolled_full_time", value: "Yes" }));
    // Protected self-identification categories: no key, label, value, or saved/not-saved marker, saved or not.
    const protectedKeys = (Object.keys(factDefinitions) as Array<keyof typeof factDefinitions>)
      .filter((key) => factDefinitions[key].sensitivity === "protected");
    expect(protectedKeys.length).toBeGreaterThanOrEqual(6);
    for (const key of protectedKeys) {
      expect(input).not.toContain(key);
      expect(input).not.toContain(factDefinitions[key].label);
    }
    expect(parsed.savedAnswers.some((answer) => (protectedKeys as string[]).includes(answer.key))).toBe(false);
    expect(input).not.toMatch(/not saved/i);
    expect(model.requests[0]!.instructions).not.toMatch(/not saved/i);
    expect(input).not.toMatch(/female/i);
    const candidate = getCandidate(ws.database, LOCAL_CANDIDATE_ID);
    for (const value of [candidate?.email, candidate?.phone, candidate?.fullName].filter((entry): entry is string => Boolean(entry))) {
      expect(input).not.toContain(value);
    }
    ws.database.close();
  });

  it("falls back to today's pause when the model output is invalid", async () => {
    const ws = workspace();
    const model = fakeModel(() => new ModelInvalidOutputError("Not JSON."));
    const { run } = await start(ws, [select("fulltime", FULL_TIME_LABEL), submitButton], createPauseReviewer({ provider: model.provider, database: ws.database }));
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses[0]).toMatchObject({ fieldId: "fulltime", status: "open", question: expect.not.stringContaining("AI review") });
    expect(invocations(ws.database)).toEqual([{ task: "application.pause_review", tier: "cheap", model: "unavailable", outcome: "failed" }]);
    expect(eventDetails(ws)).toContain("AI review could not run (ModelInvalidOutputError); the questions wait for you as before.");
    ws.database.close();
  });

  it("shows a suggested draft without filling or storing it, and holds the run", async () => {
    const ws = workspace();
    const prompt = "Describe a project you are proud of";
    const model = fakeModel((input) => reviewFor(input, prompt, { verdict: "draft", key: null, option: null, reason: "Open-ended.", draft: "A suggested answer about a project." }));
    const { run, page } = await start(ws, [{ tag: "textarea", id: "proud", label: prompt, required: true }, submitButton],
      createPauseReviewer({ provider: model.provider, database: ws.database }));
    const pause = run.pauses.find((entry) => entry.fieldId === "proud");
    expect(pause).toMatchObject({ status: "open", draft: { text: "A suggested answer about a project.", gate: null, source: "pause_review" } });
    expect(run.decisions.find((decision) => decision.fieldId === "proud")?.action).toBe("pause");
    expect(page.filled.has("proud")).toBe(false);
    expect(autoSubmitBlockers(run)).toContain(AI_DRAFT_BLOCKER);
    expect(() => approveRunSubmissionAutomatically(run.id, POLICY_BASIS, { database: ws.database })).toThrow(AI_DRAFT_BLOCKER);
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_answers").get() as { n: number }).n).toBe(0);
    expect(eventDetails(ws).join("\n")).not.toContain("A suggested answer about a project.");

    // pnpm run:questions shows the suggestion; pnpm run:answer --use-draft answers with it (never saved for reuse) and continues with no model.
    const output: string[] = [];
    const continued: Array<{ voiceDrafter: unknown; pauseReviewer: unknown }> = [];
    const controls: RawControl[] = [{ tag: "textarea", id: "proud", label: prompt, required: true }, submitButton];
    const deps: Partial<RunCommandDeps> = {
      open: () => ws.database, close: () => {}, dataDir: () => ws.dataDir, log: (line) => output.push(line),
      acquireLock: (dataDir) => acquirePipelineLock(dataDir),
      continueRun: async (runId, options) => {
        continued.push({ voiceDrafter: options.voiceDrafter, pauseReviewer: options.pauseReviewer });
        return continueBrowserRun(runId, { ...options, openPage: async () => fakePage({ controls }) });
      }
    };
    expect(await runQuestionsCommand(["--run", run.id.slice(0, 8), "--profile", "demo"], deps)).toBe(0);
    expect(output).toContain('   AI suggestion, not sent: "A suggested answer about a project."');
    output.length = 0;
    expect(await runAnswerCommand(["--run", run.id.slice(0, 8), "--q", "1", "--use-draft", "--answer", "x", "--profile", "demo"], deps)).toBe(2);
    expect(await runAnswerCommand(["--run", run.id.slice(0, 8), "--q", "1", "--use-draft", "--profile", "demo"], deps)).toBe(0);
    expect(continued).toEqual([{ voiceDrafter: null, pauseReviewer: null }]);
    const after = getBrowserRun(ws.database, run.id)!;
    expect(after.pauses[0]).toMatchObject({ status: "answered", answer: "A suggested answer about a project." });
    // Accepted through run:answer, the draft is the candidate's answer and no longer holds the run (as with voice drafts).
    expect(after.status).toBe("awaiting-approval");
    expect(autoSubmitBlockers(after)).not.toContain(AI_DRAFT_BLOCKER);
    expect(autoSubmitBlockers(after)).toEqual([]);
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_answers").get() as { n: number }).n).toBe(0);
    expect(model.requests).toHaveLength(1);
    ws.database.close();
  });

  it("calls the model once per batch, and not at all without a reviewer", async () => {
    const ws = workspace();
    const model = fakeModel(() => []);
    const reviewer = createPauseReviewer({ provider: model.provider, database: ws.database });
    const other = "Okay with frequent moves between offices?";
    const { run } = await start(ws, [select("fulltime", FULL_TIME_LABEL), select("moves", other), submitButton], reviewer);
    expect(model.requests).toHaveLength(1);
    expect((JSON.parse(model.requests[0]!.input) as { questions: unknown[] }).questions).toHaveLength(2);
    // The same instance given the same batch again calls nothing.
    const fields = [
      { id: "fulltime", label: FULL_TIME_LABEL, kind: "select" as const, required: true, options: ["Yes", "No"] },
      { id: "moves", label: other, kind: "select" as const, required: true, options: ["Yes", "No"] }
    ];
    const again = await reviewer({
      jobId: ws.jobId, atsKind: run.atsKind, posting: { companyName: ws.company, title: "Software Engineering Intern", locations: [] }, context: {},
      form: { url: HANDSHAKE_URL, title: "", fields }, decisions: run.decisions, pauses: run.pauses, sourceRunId: run.id
    });
    expect(model.requests).toHaveLength(1);
    expect(again.pauses).toEqual(run.pauses);

    const fresh = workspace();
    const before = (fresh.database.prepare("SELECT COUNT(*) AS n FROM model_invocations").get() as { n: number }).n;
    const none = await start(fresh, [select("fulltime", FULL_TIME_LABEL), submitButton], null);
    expect(none.run.pauses[0]?.question).not.toContain("AI review");
    expect((fresh.database.prepare("SELECT COUNT(*) AS n FROM model_invocations").get() as { n: number }).n).toBe(before);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    ws.database.close();
    fresh.database.close();
  });
});
