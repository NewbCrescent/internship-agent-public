import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getBrowserRun,
  getJobPosting,
  listApplicationEvents,
  LOCAL_CANDIDATE_ID,
  recordQuestionAlias,
  saveBrowserRun,
  saveCandidateFact,
  saveQuestionAnswer,
  type SaveCandidateFactInput
} from "@internship-agent/db";
import type { RawControl } from "@internship-agent/browser";
import { matchOfferedOption, type BrowserField, type BrowserRun, type PauseRecord } from "@internship-agent/domain";
import {
  answerRunPause,
  continueBrowserRun,
  DeterministicQuestionMapper,
  recheckPausedRuns,
  recheckRunPauses,
  startBrowserRun
} from "@internship-agent/agent";

import { aliasResolutionFor } from "../../packages/agent/src/pause-recheck";
import { acquirePipelineLock } from "../../packages/agent/src/pipeline-lock";
import { runProfileAnswersCommand, runQuestionsRecheckCommand } from "../../packages/agent/src/run-answer";
import { approvedJobId, cleanupTemporaryDirectories, disposableWorkspace, fakePage } from "./application-record-fixture";

/**
 * Track 45 against disposable workspaces: every stop is re-checked against the
 * saved answers (saved facts, standard answers, question memory, recorded
 * wordings) and each exact question wording is recorded against the answer it
 * matched. Fake pages and synthetic held runs only; no browser, no network,
 * no model.
 */

const HANDSHAKE_URL = "https://app.joinhandshake.com/apply/900001";
const PYTHON_LABEL = "Do you use Python? *";
// The label as the form reader records it: the trailing required marker is stripped.
const PYTHON_QUESTION = "Do you use Python?";
const MOVE_LABEL = "Open to a change of city?";
const COMBINED_RELOCATION = "Are you located in or near to the city of the advertised role? If not, are you willing to relocate at your own expense?";

type Workspace = { database: DatabaseSync; dataDir: string; jobId: string; company: string };

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

async function start(ws: Workspace, controls: RawControl[]): Promise<BrowserRun> {
  const report = await startBrowserRun(ws.jobId, HANDSHAKE_URL, {
    database: ws.database,
    dataDir: ws.dataDir,
    openPage: async () => fakePage({ controls }),
    voiceDrafter: null,
    pauseReviewer: null
  });
  return report.run;
}

function pythonSelect(label = PYTHON_LABEL, id = "python"): RawControl {
  return { tag: "select", id, label, required: true, options: ["Yes", "No"] };
}
const submitButton: RawControl = { tag: "button", label: "Submit application" };

/** A held run on the same job with these pauses (a second paused application the sweep must reach). */
function heldRun(ws: Workspace, like: BrowserRun, pauses: PauseRecord[]): BrowserRun {
  const now = new Date().toISOString();
  return saveBrowserRun(ws.database, {
    ...like,
    id: randomUUID(),
    status: "paused-needs-input",
    decisions: pauses.map((pause) => ({
      fieldId: pause.fieldId, action: "pause" as const, value: null, basis: null, reason: "Needs the candidate.",
      pause: { question: pause.question, key: pause.suggestedKey, scope: pause.suggestedScope, safeguard: false }
    })),
    pauses,
    submissionApprovedAt: null,
    createdAt: now,
    updatedAt: now
  });
}

function questionPause(label: string, fieldId: string, overrides: Partial<PauseRecord> = {}): PauseRecord {
  return {
    fieldId, label, question: `How should "${label}" be answered?`, suggestedKey: null, suggestedScope: null,
    safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null,
    fieldKind: "select", options: ["Yes", "No"], ...overrides
  };
}

type AliasRow = { wording: string; wording_key: string; target_kind: string; fact_key: string | null; fact_scope_key: string | null; question_key: string | null; ats_kind: string; options_json: string; source: string; seen_count: number; source_run_id: string | null };

function aliasRows(database: DatabaseSync): AliasRow[] {
  return database.prepare("SELECT * FROM candidate_question_aliases ORDER BY created_at, id").all() as AliasRow[];
}

function eventDetails(ws: Workspace): string[] {
  return listApplicationEvents(ws.database, ws.jobId).map((event) => event.detail ?? "");
}

function saveFact(database: DatabaseSync, input: Pick<SaveCandidateFactInput, "key" | "scope" | "value">) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, source: "user", sourceDetail: { kind: "profile" }, confidence: 1, rememberedAt: "2026-11-25T00:00:00.000Z", ...input
  });
}

describe("re-checking held stops after a saved answer", () => {
  it("answers another held run's question that differs only in capitalization and punctuation", async () => {
    const ws = workspace();
    const runA = await start(ws, [pythonSelect(), submitButton]);
    expect(runA.status).toBe("paused-needs-input");
    expect(runA.pauses[0]).toMatchObject({ label: PYTHON_QUESTION, status: "open" });
    // The candidate answers the same question, worded differently, on another held run.
    const runB = heldRun(ws, runA, [questionPause("DO YOU USE PYTHON", "python-b")]);
    const answered = await answerRunPause(runB.id, "python-b", "yes", true, { database: ws.database });
    expect(answered.outcome).toMatchObject({ saved: true, store: "question" });
    expect(answered.rechecked).toBe(1);

    const heldA = getBrowserRun(ws.database, runA.id)!;
    expect(heldA.status).toBe("paused-needs-input");
    expect(heldA.pauses[0]).toMatchObject({ status: "answered", answer: "Yes" });
    const details = eventDetails(ws);
    const found = details.filter((detail) => detail.includes("found in your saved answers (same wording after normalization)"));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`Answer to "${PYTHON_QUESTION}"`);
    expect(found[0]).toContain('"DO YOU USE PYTHON"');
    expect(details.some((detail) => /\bYes\b/.test(detail))).toBe(false);

    // Both exact wordings are recorded against the one saved answer.
    expect(aliasRows(ws.database).map((row) => [row.wording, row.question_key, row.source])).toEqual([
      ["DO YOU USE PYTHON", "do you use python", "candidate_answer"],
      [PYTHON_QUESTION, "do you use python", "saved_answer_match"]
    ]);

    // Continue fills the answered question.
    const page = fakePage({ controls: [pythonSelect(), submitButton] });
    const continued = await continueBrowserRun(runA.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page, pauseReviewer: null });
    expect(page.filled.get("python")).toBe("Yes");
    expect(continued.run.status).toBe("awaiting-approval");
    ws.database.close();
  });

  it("records the exact wording, ATS kind, and options of a saved answer, and counts it when seen again", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    await answerRunPause(run.id, "python", "Yes", true, { database: ws.database });
    expect(aliasRows(ws.database)).toEqual([expect.objectContaining({
      wording: PYTHON_QUESTION, wording_key: "do you use python", target_kind: "question", question_key: "do you use python",
      ats_kind: run.atsKind, options_json: JSON.stringify(["Yes", "No"]), source: "candidate_answer", seen_count: 1, source_run_id: run.id
    })]);
    const again = heldRun(ws, run, [questionPause(PYTHON_QUESTION, "python")]);
    const second = await answerRunPause(again.id, "python", "Yes", true, { database: ws.database });
    expect(second.outcome).toMatchObject({ saved: true, store: "question", status: "unchanged" });
    expect(aliasRows(ws.database)).toEqual([expect.objectContaining({ wording: PYTHON_QUESTION, seen_count: 2 })]);
    ws.database.close();
  });

  it("stores nothing and answers no other run with --once", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    const other = heldRun(ws, run, [questionPause(PYTHON_QUESTION, "python")]);
    const once = await answerRunPause(run.id, "python", "Yes", false, { database: ws.database });
    expect(once).toMatchObject({ remembered: false, rechecked: 0, outcome: { saved: false, reason: "not_requested" } });
    expect(aliasRows(ws.database)).toEqual([]);
    expect(getBrowserRun(ws.database, other.id)?.pauses[0]?.status).toBe("open");
    ws.database.close();
  });

  it("never answers a sensitive stop from another run's answer and never shows a protected value", async () => {
    const ws = workspace();
    const gender: RawControl = { tag: "select", id: "gender", label: "Gender", required: true, options: ["Male", "Female", "Decline To Self Identify"] };
    const run = await start(ws, [gender, submitButton]);
    const pause = run.pauses.find((entry) => entry.fieldId === "gender")!;
    expect(pause.sensitive).toBe(true);
    const other = heldRun(ws, run, [{ ...pause }]);
    const answered = await answerRunPause(run.id, "gender", "female", true, { database: ws.database });
    expect(answered.outcome).toMatchObject({ saved: false, reason: "sensitive" });
    // Even with the answer saved explicitly, the sweep never answers a sensitive stop.
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });
    const results = await recheckPausedRuns(ws.database, { apply: true });
    expect(results.flatMap((result) => result.matches)).toEqual([]);
    expect(getBrowserRun(ws.database, other.id)?.pauses[0]?.status).toBe("open");
    expect(aliasRows(ws.database)).toEqual([]);

    // A protected fact with a recorded wording is listed as "saved", never by value.
    recordQuestionAlias(ws.database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "Gender", target: { kind: "fact", factKey: "eeo_gender", scopeKey: "global" },
      atsKind: "greenhouse", options: ["Male", "Female"], source: "candidate_answer", sourceRunId: null
    });
    const output: string[] = [];
    expect(await runProfileAnswersCommand(["--profile", "demo"], { open: () => ws.database, close: () => {}, log: (line) => output.push(line) })).toBe(0);
    expect(output).toContain("Saved facts with recorded wordings:");
    expect(output).toContain("fact eeo_gender [global]: saved");
    expect(output.some((line) => /^ {4}wording "Gender" \(greenhouse, 2 options, your answer, seen 1x, /.test(line))).toBe(true);
    expect(output.join("\n")).not.toMatch(/female/i);
    ws.database.close();
  });

  it("leaves a stop open when the planner itself would hold it", async () => {
    const ws = workspace();
    const run = await start(ws, [{ tag: "select", id: "move", label: COMBINED_RELOCATION, required: true, options: ["Yes", "No"] }, submitButton]);
    expect(run.pauses.find((pause) => pause.fieldId === "move")?.status).toBe("open");
    saveFact(ws.database, { key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" }, value: false });
    // A naive option match would choose "No"; the planner's rule holds a saved no on the combined list.
    expect(matchOfferedOption(["Yes", "No"], "No")).toBe("No");
    const result = await recheckRunPauses(ws.database, run.id, { apply: true });
    expect(result.matches).toEqual([]);
    expect(result.left).toEqual([{ index: 0, label: COMBINED_RELOCATION, aiEligible: true }]);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    ws.database.close();
  });

  it("skips page failures and answers a saved fact the mapper now finds", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    const failed = heldRun(ws, run, [
      questionPause(PYTHON_QUESTION, "python", { question: `The agent could not fill "${PYTHON_QUESTION}": the list did not open. Answer it here, or fill it in the browser.` }),
      questionPause("Are you open to hybrid work?", "hybrid")
    ]);
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: PYTHON_QUESTION, answerKind: "option", answer: "Yes", sourceRunId: null });
    saveFact(ws.database, { key: "work_arrangement", scope: { kind: "global" }, value: true });
    const result = await recheckRunPauses(ws.database, failed.id, { apply: true });
    expect(result.skipped).toBe(1);
    expect(result.matches).toEqual([{ index: 1, fieldId: "hybrid", label: "Are you open to hybrid work?", kind: "saved_fact" }]);
    const held = getBrowserRun(ws.database, failed.id)!;
    expect(held.pauses[0]?.status).toBe("open");
    expect(held.pauses[1]).toMatchObject({ status: "answered", answer: "Yes", suggestedKey: "work_arrangement", suggestedScope: "global" });
    expect(eventDetails(ws)).toContain('Answer to "Are you open to hybrid work?" found in your saved answers (the question mapper\'s key): your saved open to on-site and hybrid work (global); it no longer waits for you.');
    expect(aliasRows(ws.database).find((row) => row.wording === "Are you open to hybrid work?")).toMatchObject({
      target_kind: "fact", fact_key: "work_arrangement", fact_scope_key: "global", source: "saved_answer_match"
    });
    ws.database.close();
  });

  it("writes nothing on a dry run", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: PYTHON_QUESTION, answerKind: "option", answer: "Yes", sourceRunId: null });
    const counts = () => ({
      events: (ws.database.prepare("SELECT COUNT(*) AS n FROM application_events").get() as { n: number }).n,
      aliases: aliasRows(ws.database).length,
      runs: ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all()
    });
    const before = counts();
    const results = await recheckPausedRuns(ws.database, { apply: false });
    expect(results.flatMap((result) => result.matches.map((match) => match.kind))).toEqual(["question_memory_exact"]);
    expect(counts()).toEqual(before);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    ws.database.close();
  });
});

describe("recorded wordings never widen a saved answer's scope", () => {
  it("answers an unmapped wording through a country-scoped fact only on a posting in that country", async () => {
    const ws = workspace();
    const mapper = new DeterministicQuestionMapper();
    expect((await mapper.map(MOVE_LABEL, { postingCountryCode: "US", companyName: ws.company, fieldKind: "select" })).status).toBe("UNMAPPED");
    saveFact(ws.database, { key: "willing_to_relocate", scope: { kind: "country", code: "US" }, value: true });
    recordQuestionAlias(ws.database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: MOVE_LABEL, target: { kind: "fact", factKey: "willing_to_relocate", scopeKey: "country:US" },
      atsKind: "greenhouse", options: ["Yes", "No"], source: "candidate_answer", sourceRunId: null
    });
    const field: BrowserField = { id: "move", label: MOVE_LABEL, kind: "select", required: true, options: ["Yes", "No"] };
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, { postingCountryCode: "US" })?.resolution)
      .toMatchObject({ status: "RESOLVED", key: "willing_to_relocate", scope: "country:US", display: "Yes" });
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, { postingCountryCode: "CA" })).toBeNull();
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, {})).toBeNull();

    // The seeded posting is in Seattle, so a new run answers it and says so, without the value.
    const run = await start(ws, [{ tag: "select", id: "move", label: MOVE_LABEL, required: true, options: ["Yes", "No"] }, submitButton]);
    expect(run.decisions.find((decision) => decision.fieldId === "move")).toMatchObject({
      action: "choose", value: "Yes", basis: { kind: "fact", key: "willing_to_relocate", scope: "country:US" }
    });
    expect(eventDetails(ws)).toContain(`Used a recorded wording of your saved answer for "${MOVE_LABEL}".`);
    ws.database.close();
  });

  it("answers a company-scoped fact only for that company", () => {
    const ws = workspace();
    saveFact(ws.database, { key: "previously_worked_here", scope: { kind: "company", name: ws.company }, value: false });
    const label = "Ever on the payroll before?";
    recordQuestionAlias(ws.database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: label, target: { kind: "fact", factKey: "previously_worked_here", scopeKey: `company:${ws.company.toLocaleLowerCase("en-US")}` },
      atsKind: "lever", source: "candidate_answer", sourceRunId: null
    });
    const field: BrowserField = { id: "before", label, kind: "select", required: true, options: ["Yes", "No"] };
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, { companyName: ws.company })?.resolution)
      .toMatchObject({ status: "RESOLVED", key: "previously_worked_here", display: "No" });
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, { companyName: "Another Employer" })).toBeNull();
    expect(aliasResolutionFor(ws.database, LOCAL_CANDIDATE_ID, field, {})).toBeNull();
    ws.database.close();
  });
});

describe("pnpm profile:answers and pnpm questions:recheck", () => {
  it("lists recorded wordings under each answer and revokes one", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    await answerRunPause(run.id, "python", "Yes", true, { database: ws.database });
    const output: string[] = [];
    const deps = { open: () => ws.database, close: () => {}, log: (line: string) => output.push(line) };
    expect(await runProfileAnswersCommand(["--profile", "demo"], deps)).toBe(0);
    expect(output).toHaveLength(2);
    const aliasId = /\[alias ([0-9a-f]{8})\]$/.exec(output[1]!)?.[1];
    expect(aliasId).toBeTruthy();
    expect(output[1]).toContain(`wording "${PYTHON_QUESTION}" (${run.atsKind}, 2 options, your answer, seen 1x`);
    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo", "--revoke", "x", "--revoke-alias", "y"], deps)).toBe(2);
    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo", "--revoke-alias", aliasId!], deps)).toBe(0);
    expect(output).toEqual([`revoked alias ${aliasId} "${PYTHON_QUESTION}"`]);
    expect(aliasRows(ws.database).length).toBe(1);
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_aliases WHERE revoked_at IS NULL").get() as { n: number }).n).toBe(0);
    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo", "--revoke-alias", aliasId!], deps)).toBe(1);
    expect(output).toEqual([`Not found: ${aliasId}`]);
    ws.database.close();
  });

  it("summarizes the stops saved answers would answer, then answers them with --apply", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), { tag: "input", type: "text", id: "editor", label: "Favorite code editor", required: true }, submitButton]);
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: PYTHON_QUESTION, answerKind: "option", answer: "Yes", sourceRunId: null });
    const output: string[] = [];
    const deps = {
      openReadOnly: () => ws.database, closeReadOnly: () => {}, open: () => ws.database, close: () => {},
      dataDir: () => ws.dataDir, acquireLock: (dataDir: string) => acquirePipelineLock(dataDir), log: (line: string) => output.push(line)
    };
    expect(await runQuestionsRecheckCommand(["--profile", "demo"], deps)).toBe(0);
    const runLine = `Run ${run.id.slice(0, 8)}: ${ws.company} — Software Engineering Intern: Q1 question_memory_exact`;
    expect(output).toEqual([
      runLine,
      "open pauses: 2; would be answered by saved answers: 1 (saved_fact 0, standard_answer 0, question_memory_exact 1, question_memory_normalized 0, alias_exact 0, alias_normalized 0); skipped (safeguard, upload, sensitive, page failures, faults, older runs): 0; still open: 1, of which would reach AI review: 1"
    ]);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    expect(output.join("\n")).not.toContain("Yes");

    output.length = 0;
    expect(await runQuestionsRecheckCommand(["--profile", "demo", "--apply"], deps)).toBe(0);
    expect(output[0]).toBe(runLine);
    expect(output[1]).toMatch(/^open pauses: 2; answered by saved answers: 1 \(/);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]).toMatchObject({ status: "answered", answer: "Yes" });
    expect(await runQuestionsRecheckCommand(["--bogus"], deps)).toBe(2);
    process.env.INTERNSHIP_AGENT_MANUAL_ONLY = "1";
    output.length = 0;
    expect(await runQuestionsRecheckCommand(["--profile", "demo", "--apply"], deps)).toBe(1);
    expect(output[0]).toMatch(/^Not run: manual checklist mode/);
    ws.database.close();
  });
});
