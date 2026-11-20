import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getBrowserRun,
  getJobPosting,
  listApplicationEvents,
  listBrowserRuns,
  LOCAL_CANDIDATE_ID,
  replaceCoursework,
  saveCandidateFact,
  saveQuestionAnswer
} from "@internship-agent/db";
import type { RawControl } from "@internship-agent/browser";
import { formatCourseworkAnswer, type CourseworkSet, type PauseRecord } from "@internship-agent/domain";
import {
  answerRunPause,
  cancelBrowserRun,
  continueBrowserRun,
  startBrowserRun
} from "@internship-agent/agent";

import { buildDigest, collectDigestSnapshot, digestStatePath } from "../../packages/agent/src/daily-digest";
import { passNoticeItems } from "../../packages/agent/src/pass-notice";
import { acquirePipelineLock, readPipelineLock } from "../../packages/agent/src/pipeline-lock";
import type { PipelineReport } from "../../packages/agent/src/pipeline-orchestrator";
import { planPauseMemory } from "../../packages/agent/src/question-answers";
import {
  runAnswerCommand,
  runProfileAnswersCommand,
  runQuestionsCommand,
  type RunCommandDeps
} from "../../packages/agent/src/run-answer";
import { approvedJobId, cleanupTemporaryDirectories, disposableWorkspace, fakePage } from "./application-record-fixture";

/**
 * Question memory against disposable workspaces: what is saved from a held
 * run, what is never saved (and why), reuse on a later run, and the
 * run:questions / run:answer / profile:answers commands. Fake pages only; no
 * browser, no network, no model.
 */

const HANDSHAKE_URL = "https://app.joinhandshake.com/apply/900001";
// Not "experience": the prepared package answers experience questions before question memory is asked.
const PYTHON_LABEL = "Do you use Python? *";
// The label as the form reader records it: the trailing required marker is stripped.
const PYTHON_QUESTION = "Do you use Python?";
const LANGS_LABEL = "Which programming languages do you use most?";

type Workspace = { database: DatabaseSync; dataDir: string; jobId: string; company: string };

const savedEnv = { manual: process.env.INTERNSHIP_AGENT_MANUAL_ONLY, key: process.env.MODEL_API_KEY };

beforeEach(() => {
  delete process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedEnv.manual === undefined) delete process.env.INTERNSHIP_AGENT_MANUAL_ONLY;
  else process.env.INTERNSHIP_AGENT_MANUAL_ONLY = savedEnv.manual;
  if (savedEnv.key === undefined) delete process.env.MODEL_API_KEY;
  else process.env.MODEL_API_KEY = savedEnv.key;
  cleanupTemporaryDirectories();
});

function workspace(): Workspace {
  const { database, dataDir } = disposableWorkspace();
  const jobId = approvedJobId(database);
  const company = getJobPosting(database, jobId)!.companyName;
  return { database, dataDir, jobId, company };
}

async function start(ws: Workspace, controls: RawControl[]) {
  const report = await startBrowserRun(ws.jobId, HANDSHAKE_URL, {
    database: ws.database,
    dataDir: ws.dataDir,
    openPage: async () => fakePage({ controls }),
    voiceDrafter: null
  });
  return report.run;
}

function pythonSelect(label = PYTHON_LABEL, options = ["Yes", "No"]): RawControl {
  return { tag: "select", id: "python", label, required: true, options };
}
const langsText: RawControl = { tag: "input", type: "text", id: "langs", label: LANGS_LABEL, required: true };
const submitButton: RawControl = { tag: "button", label: "Submit application" };

type AnswerRow = { id: string; question: string; answer_kind: string; answer: string; answer_key: string; source_run_id: string | null; superseded_at: string | null; superseded_by_id: string | null };

function answerRows(database: DatabaseSync): AnswerRow[] {
  return database.prepare("SELECT * FROM candidate_question_answers ORDER BY created_at, id").all() as AnswerRow[];
}

function count(database: DatabaseSync, table: "candidate_facts" | "model_invocations"): number {
  return (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function eventDetails(ws: Workspace): string[] {
  return listApplicationEvents(ws.database, ws.jobId).map((event) => event.detail ?? "");
}

function cliDeps(ws: Workspace, controls: RawControl[], output: string[], captured: Array<{ voiceDrafter: unknown; lockHeld: boolean }>): Partial<RunCommandDeps> {
  return {
    open: () => ws.database,
    close: () => {},
    dataDir: () => ws.dataDir,
    log: (line) => output.push(line),
    acquireLock: (dataDir) => acquirePipelineLock(dataDir),
    continueRun: async (runId, options) => {
      captured.push({ voiceDrafter: options.voiceDrafter, lockHeld: readPipelineLock(ws.dataDir) !== null });
      return continueBrowserRun(runId, { ...options, openPage: async () => fakePage({ controls }) });
    }
  };
}

/** Q<n> → label pairs from notice or run:questions lines. */
function numbered(lines: string[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of lines) {
    const match = /Q(\d+)[^"]*"([^"]*)"/.exec(line);
    if (match) map.set(Number(match[1]), match[2]!);
  }
  return map;
}

function noticeLines(ws: Workspace): string[] {
  const report: PipelineReport = {
    analyzed: [], prepared: [], started: [{ jobId: ws.jobId, runStatus: "paused-needs-input" }], stopped: [],
    waiting: [], held: [], skipped: [], submitted: [], errors: []
  };
  // The same lookup packages/agent/scripts/pipeline-pass.ts gives the notice.
  const items = passNoticeItems(report, {
    posting: (jobId) => getJobPosting(ws.database, jobId),
    latestRun: (jobId) => {
      const run = listBrowserRuns(ws.database, jobId)[0];
      return run ? {
        id: run.id, status: run.status,
        pauses: run.pauses.map(({ label, status, safeguard, sensitive, upload }) => ({ label, status, safeguard, sensitive, upload }))
      } : null;
    }
  });
  return items.flatMap((item) => item.lines);
}

describe("question memory schema", () => {
  it("creates the table with one current answer per question", () => {
    const ws = workspace();
    expect(ws.database.prepare("SELECT name FROM sqlite_master WHERE name = 'candidate_question_answers'").get()).toEqual({ name: "candidate_question_answers" });
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: PYTHON_LABEL, answerKind: "option", answer: "Yes", sourceRunId: null });
    expect(() => ws.database.prepare(`
      INSERT INTO candidate_question_answers (id, candidate_id, question_key, question, answer_kind, answer, answer_key, source_run_id, created_at)
      VALUES ('00000000-0000-4000-8000-000000000001', ?, 'do you use python', 'Python?', 'option', 'No', 'no', NULL, '2026-11-19T00:00:00.000Z')
    `).run(LOCAL_CANDIDATE_ID)).toThrow();
    ws.database.close();
  });
});

describe("saving answers from a held run", () => {
  it("saves a generic option by its offered text and free text verbatim, supersedes, and leaves an identical answer as is", async () => {
    const ws = workspace();
    const factsBefore = count(ws.database, "candidate_facts");
    const run = await start(ws, [pythonSelect(), langsText, submitButton]);
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses.find((pause) => pause.fieldId === "python")).toMatchObject({ fieldKind: "select", options: ["Yes", "No"] });

    const python = await answerRunPause(run.id, "python", "yes", true, { database: ws.database });
    expect(python.remembered).toBe(true);
    expect(python.outcome).toMatchObject({ saved: true, store: "question", status: "saved" });
    expect(python.run.pauses.find((pause) => pause.fieldId === "python")).toMatchObject({ status: "answered", answer: "Yes" });
    const langs = await answerRunPause(run.id, "langs", "  Python, TypeScript ", true, { database: ws.database });
    expect(langs.outcome).toMatchObject({ saved: true, store: "question" });

    const rows = answerRows(ws.database);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ question: PYTHON_QUESTION, answer_kind: "option", answer: "Yes", answer_key: "yes", source_run_id: run.id });
    expect(rows[1]).toMatchObject({ question: LANGS_LABEL, answer_kind: "text", answer: "Python, TypeScript" });
    expect(count(ws.database, "candidate_facts")).toBe(factsBefore);
    expect(eventDetails(ws)).toContain(`Answer to "${PYTHON_QUESTION}" saved for reuse.`);

    // The same answer on a later run is left as is; a different one replaces it.
    cancelBrowserRun(run.id, ws.database);
    const second = await start(ws, [pythonSelect(), langsText, submitButton]);
    expect(second.pauses.map((pause) => pause.fieldId)).toEqual([]);
    cancelBrowserRun(second.id, ws.database);
    const third = await start(ws, [pythonSelect("Do you use Python (required)", ["Yes", "No", "Somewhat"]), { ...langsText, label: "Which programming languages do you use most? (optional)" }, submitButton]);
    expect(third.status).not.toBe("paused-needs-input");
    expect(answerRows(ws.database)).toHaveLength(2);

    cancelBrowserRun(third.id, ws.database);
    const fourth = await start(ws, [{ tag: "input", type: "text", id: "editor", label: "Favorite code editor", required: true }, submitButton]);
    const first = await answerRunPause(fourth.id, "editor", "VS Code", true, { database: ws.database });
    expect(first.outcome).toMatchObject({ status: "saved" });
    cancelBrowserRun(fourth.id, ws.database);
    // Reused now, so it never pauses; save directly to prove unchanged and replaced.
    expect(saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "favorite code editor", answerKind: "text", answer: "VS Code", sourceRunId: null }).status).toBe("unchanged");
    const replaced = saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "Favorite code editor *", answerKind: "text", answer: "Neovim", sourceRunId: null });
    expect(replaced.status).toBe("replaced");
    const editorRows = answerRows(ws.database).filter((row) => row.question.startsWith("Favorite") || row.question.startsWith("favorite"));
    expect(editorRows).toHaveLength(2);
    expect(editorRows[0]).toMatchObject({ answer: "VS Code", superseded_by_id: replaced.answer.id });
    expect(editorRows[0]?.superseded_at).not.toBeNull();
    ws.database.close();
  });

  it("refuses an option the field does not offer and keeps the pause open", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    await expect(answerRunPause(run.id, "python", "Maybe", true, { database: ws.database })).rejects.toThrow(/not one of the offered options/);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    expect(answerRows(ws.database)).toHaveLength(0);
    ws.database.close();
  });

  it("uses company-named and why/interest answers once, records why, and never logs the answer", async () => {
    const ws = workspace();
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "named", label: `What excites you about ${ws.company}?`, required: true },
      { tag: "input", type: "text", id: "products", label: `Have you used ${ws.company} products before?`, required: true },
      { tag: "input", type: "text", id: "field", label: "What excites you about this field?", required: true },
      submitButton
    ];
    const run = await start(ws, controls);
    expect(run.pauses.map((pause) => pause.fieldId)).toEqual(["named", "products", "field"]);
    const named = await answerRunPause(run.id, "named", "SecretAnswerOne", true, { database: ws.database });
    expect(named.outcome).toMatchObject({ saved: false, reason: "company_named" });
    expect(named.remembered).toBe(false);
    const products = await answerRunPause(run.id, "products", "SecretAnswerTwo", true, { database: ws.database });
    expect(products.outcome).toMatchObject({ saved: false, reason: "company_named" });
    const field = await answerRunPause(run.id, "field", "SecretAnswerThree", true, { database: ws.database });
    expect(field.outcome).toMatchObject({ saved: false, reason: "why_interest" });
    expect(answerRows(ws.database)).toHaveLength(0);
    const details = eventDetails(ws);
    expect(details.filter((detail) => detail.includes("used for this run only"))).toHaveLength(3);
    expect(details.some((detail) => detail.includes("it names the company"))).toBe(true);
    expect(details.some((detail) => /SecretAnswer/.test(detail))).toBe(false);
    ws.database.close();
  });

  it("never saves or reuses a why-this-internship answer", async () => {
    const ws = workspace();
    const pause: PauseRecord = {
      fieldId: "why", label: "Why this internship?", question: 'How should "Why this internship?" be answered?',
      suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false, upload: false, status: "open", answer: null,
      draft: null, fieldKind: "text"
    };
    expect(await planPauseMemory(pause, { companyName: ws.company, context: {}, answer: "Because it fits." }))
      .toEqual({ path: "once", reason: "why_interest" });
    // Even a stored row (the repository does not judge) is never read for it: the prepared package answers it.
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "Why this internship?", answerKind: "text", answer: "MemoryAnswer", sourceRunId: null });
    const run = await start(ws, [{ tag: "input", type: "text", id: "why", label: "Why this internship?", required: true }, submitButton]);
    const decision = run.decisions.find((entry) => entry.fieldId === "why");
    expect(decision?.basis?.kind).toBe("package-answer");
    expect(decision?.value).not.toBe("MemoryAnswer");
    ws.database.close();
  });

  it("records attestation, protected, sensitive, and ambiguous answers once instead of refusing them", async () => {
    const ws = workspace();
    const factsBefore = count(ws.database, "candidate_facts");
    const controls: RawControl[] = [
      { tag: "input", type: "checkbox", id: "certify", label: "I certify that the information provided is true", required: true },
      { tag: "input", type: "text", id: "marital", label: "Marital status", required: true },
      { tag: "select", id: "gender", label: "Gender", required: true, options: ["Male", "Female", "Decline To Self Identify"] },
      { tag: "input", type: "text", id: "dates", label: "When can you begin, and what is your end date for the internship?", required: true },
      submitButton
    ];
    const run = await start(ws, controls);
    expect(run.pauses.map((pause) => pause.fieldId)).toEqual(["certify", "marital", "gender", "dates"]);
    expect(run.pauses.find((pause) => pause.fieldId === "gender")?.sensitive).toBe(true);

    const certify = await answerRunPause(run.id, "certify", "yes", true, { database: ws.database });
    expect(certify.outcome).toMatchObject({ saved: false, reason: "blocked_attestation" });
    const marital = await answerRunPause(run.id, "marital", "Single", true, { database: ws.database });
    expect(marital.outcome).toMatchObject({ saved: false, reason: "blocked_protected" });
    const gender = await answerRunPause(run.id, "gender", "female", true, { database: ws.database });
    expect(gender.outcome).toMatchObject({ saved: false, reason: "sensitive" });
    expect(gender.run.pauses.find((pause) => pause.fieldId === "gender")?.answer).toBe("Female");
    const dates = await answerRunPause(run.id, "dates", "June to August", true, { database: ws.database });
    expect(dates.outcome).toMatchObject({ saved: false, reason: "ambiguous" });

    expect(answerRows(ws.database)).toHaveLength(0);
    expect(count(ws.database, "candidate_facts")).toBe(factsBefore);
    expect(getBrowserRun(ws.database, run.id)?.pauses.every((pause) => pause.status === "answered")).toBe(true);
    const details = eventDetails(ws).join("\n");
    expect(details).not.toMatch(/Single|Female|June to August/);
    ws.database.close();
  });

  it("uses an answer once with --once (remember off)", async () => {
    const ws = workspace();
    const run = await start(ws, [langsText, submitButton]);
    const result = await answerRunPause(run.id, "langs", "Go", false, { database: ws.database });
    expect(result).toMatchObject({ remembered: false, outcome: { saved: false, reason: "not_requested" } });
    expect(answerRows(ws.database)).toHaveLength(0);
    ws.database.close();
  });
});

describe("catalog questions keep the fact path", () => {
  it("reports remembered only when a fact was stored", async () => {
    const ws = workspace();
    const controls: RawControl[] = [{ tag: "input", type: "text", id: "hybrid", label: "Are you open to hybrid work?", required: true }, submitButton];
    const run = await start(ws, controls);
    expect(run.pauses[0]?.suggestedKey).toBe("work_arrangement");
    const result = await answerRunPause(run.id, "hybrid", "yes", true, { database: ws.database });
    expect(result.remembered).toBe(true);
    expect(result.outcome).toEqual({ saved: true, store: "fact", factKey: "work_arrangement" });
    expect(answerRows(ws.database)).toHaveLength(0);
    expect(eventDetails(ws)).toContain('Answer to "Are you open to hybrid work?" saved for reuse as open to on-site and hybrid work.');
    ws.database.close();

    const fresh = workspace();
    const once = await start(fresh, controls);
    const notKept = await answerRunPause(once.id, "hybrid", "yes", false, { database: fresh.database });
    expect(notKept.remembered).toBe(false);
    expect(notKept.outcome).toMatchObject({ saved: false, reason: "not_requested" });
    fresh.database.close();
  });
});

describe("coursework stays with the saved courses", () => {
  it("resolves relevant coursework from saved courses, never from question memory", async () => {
    const ws = workspace();
    // The repository does not judge, so a stored row proves resolution never reads it.
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "Relevant coursework", answerKind: "text", answer: "Generic memory text", sourceRunId: null });
    const rowsBefore = answerRows(ws.database).length;
    const courseworkField: RawControl = { tag: "input", type: "text", id: "coursework", label: "Relevant coursework", required: true };

    const run = await start(ws, [courseworkField, submitButton]);
    expect(run.pauses.find((pause) => pause.fieldId === "coursework")?.suggestedKey).toBe("relevant_coursework");
    expect(run.decisions.some((decision) => decision.basis?.kind === "question_answer")).toBe(false);

    const answered = await answerRunPause(run.id, "coursework", "CS 61B Data Structures", true, { database: ws.database });
    expect(answered.outcome).toMatchObject({ saved: false, reason: "coursework" });
    expect(answered.remembered).toBe(false);
    expect(answerRows(ws.database)).toHaveLength(rowsBefore);
    expect((ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_facts WHERE key = 'relevant_coursework'").get() as { n: number }).n).toBe(0);

    // Neutral fixture: a fictional school and generic course codes.
    const coursework: CourseworkSet = {
      school: "Example State University",
      courses: [
        { code: "CS 189", title: "Machine Learning", term: "Spring 2026", status: "in_progress" },
        { code: "CS 61B", title: "Data Structures", term: "Fall 2025", status: "completed" }
      ]
    };
    replaceCoursework(ws.database, LOCAL_CANDIDATE_ID, coursework);
    cancelBrowserRun(run.id, ws.database);
    const filled = await start(ws, [courseworkField, submitButton]);
    const decision = filled.decisions.find((entry) => entry.fieldId === "coursework");
    expect(decision).toMatchObject({ action: "fill", basis: { kind: "fact", key: "relevant_coursework" } });
    expect(decision?.value).toBe(formatCourseworkAnswer(coursework.courses));
    expect(decision?.value).not.toBe("Generic memory text");
    cancelBrowserRun(filled.id, ws.database);

    // A course question the catalog leaves unmapped is never answered from question memory either.
    const onlineLabel = "Which online courses have you completed?";
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: onlineLabel, answerKind: "text", answer: "Generic memory text", sourceRunId: null });
    const online = await start(ws, [{ tag: "input", type: "text", id: "online", label: onlineLabel, required: true }, submitButton]);
    expect(online.decisions.find((entry) => entry.fieldId === "online")?.action).toBe("pause");
    const onlinePause = online.pauses.find((pause) => pause.fieldId === "online")!;
    expect(await planPauseMemory(onlinePause, { companyName: ws.company, context: {} })).toEqual({ path: "once", reason: "coursework" });
    ws.database.close();
  });
});

describe("reusing saved answers", () => {
  it("reuses an exact question on a later run, pauses when no option matches, and lets catalog facts win", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    const saved = await answerRunPause(run.id, "python", "Yes", true, { database: ws.database });
    const answerId = saved.outcome.saved && saved.outcome.store === "question" ? saved.outcome.answerId : "";
    cancelBrowserRun(run.id, ws.database);

    const again = await start(ws, [pythonSelect("do you use python"), submitButton]);
    expect(again.pauses).toHaveLength(0);
    expect(again.decisions.find((decision) => decision.fieldId === "python")).toMatchObject({
      action: "choose", value: "Yes", basis: { kind: "question_answer", answerId }
    });
    cancelBrowserRun(again.id, ws.database);

    const unmatched = await start(ws, [pythonSelect(PYTHON_LABEL, ["Yes, 2+ years", "No"]), submitButton]);
    expect(unmatched.decisions.find((decision) => decision.fieldId === "python")?.action).toBe("pause");
    cancelBrowserRun(unmatched.id, ws.database);

    // Catalog first: a saved fact beats a question-memory answer for the same label.
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "Are you open to hybrid work?", answerKind: "option", answer: "No", sourceRunId: null });
    saveCandidateFact(ws.database, {
      candidateId: LOCAL_CANDIDATE_ID, key: "work_arrangement", scope: { kind: "global" }, value: true, source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: "2026-11-19T00:00:00.000Z"
    });
    const catalog = await start(ws, [{ tag: "select", id: "hybrid", label: "Are you open to hybrid work?", required: true, options: ["Yes", "No"] }, submitButton]);
    expect(catalog.decisions.find((decision) => decision.fieldId === "hybrid")).toMatchObject({ action: "choose", value: "Yes", basis: { kind: "fact" } });
    ws.database.close();
  });

  it("never reuses a saved answer for a question naming the posting's company", async () => {
    const ws = workspace();
    const label = `Have you used ${ws.company} products before?`;
    saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: label, answerKind: "option", answer: "Yes", sourceRunId: null });
    const run = await start(ws, [{ tag: "select", id: "products", label, required: true, options: ["Yes", "No"] }, submitButton]);
    expect(run.decisions.find((decision) => decision.fieldId === "products")?.action).toBe("pause");
    ws.database.close();
  });

  it("chooses an answered select and leaves an answered-no checkbox on continue", async () => {
    const ws = workspace();
    const controls: RawControl[] = [
      pythonSelect(),
      { tag: "input", type: "checkbox", id: "weekends", label: "I am comfortable working weekends", required: true },
      submitButton
    ];
    const run = await start(ws, controls);
    await answerRunPause(run.id, "python", "yes", true, { database: ws.database });
    await answerRunPause(run.id, "weekends", "no", true, { database: ws.database });
    const page = fakePage({ controls });
    const continued = await continueBrowserRun(run.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page });
    expect(continued.run.decisions.find((decision) => decision.fieldId === "python")).toMatchObject({ action: "choose", value: "Yes" });
    expect(continued.run.decisions.find((decision) => decision.fieldId === "weekends")?.action).toBe("skip");
    expect(page.filled.get("python")).toBe("Yes");
    expect(page.filled.has("weekends")).toBe(false);
    ws.database.close();
  });
});

describe("pnpm run:questions and pnpm run:answer", () => {
  it("numbers questions like the Discord notice, saves without echoing, and continues under the lock with no model", async () => {
    const ws = workspace();
    const fetchSpy = vi.fn(async () => {
      throw new Error("No network in this suite.");
    });
    vi.stubGlobal("fetch", fetchSpy);
    process.env.MODEL_API_KEY = "test-not-used";
    const modelsBefore = count(ws.database, "model_invocations");
    const controls: RawControl[] = [
      pythonSelect(),
      langsText,
      { tag: "input", type: "text", id: "products", label: `Have you used ${ws.company} products before?`, required: true },
      { tag: "input", type: "file", id: "cover", label: "Cover letter", required: true },
      submitButton
    ];
    const run = await start(ws, controls);
    const prefix = run.id.slice(0, 8);
    const output: string[] = [];
    const captured: Array<{ voiceDrafter: unknown; lockHeld: boolean }> = [];
    const deps = cliDeps(ws, controls, output, captured);

    const notice = numbered(noticeLines(ws));
    expect(await runQuestionsCommand(["--run", prefix, "--profile", "demo"], deps)).toBe(0);
    const listed = numbered(output);
    expect(listed).toEqual(notice);
    expect(listed.size).toBe(4);
    expect(output.some((line) => line.includes("Yes | No"))).toBe(true);
    expect(output.some((line) => line.includes("would be saved for reuse"))).toBe(true);
    expect(output.some((line) => line.includes("this run only (it names the company)"))).toBe(true);

    const langsQ = [...notice].find(([, label]) => label === LANGS_LABEL)![0];
    output.length = 0;
    expect(await runAnswerCommand(["--run", prefix, "--q", String(langsQ), "--answer", "ZebraQuokka42 and Python", "--profile", "demo"], deps)).toBe(0);
    expect(output.join("\n")).toContain(`Q${langsQ} saved for reuse: "${LANGS_LABEL}"`);
    expect(output.join("\n")).not.toContain("ZebraQuokka42");
    expect(getBrowserRun(ws.database, run.id)?.pauses[langsQ - 1]).toMatchObject({ fieldId: "langs", status: "answered" });
    expect(output.some((line) => line.startsWith("Still open:"))).toBe(true);
    expect(output.some((line) => line.startsWith("Not continued"))).toBe(true);
    expect(captured).toHaveLength(0);
    expect(readPipelineLock(ws.dataDir)).toBeNull();

    const pythonQ = [...notice].find(([, label]) => label === PYTHON_QUESTION)![0];
    const productsQ = [...notice].find(([, label]) => label.startsWith("Have you used"))![0];
    const coverQ = [...notice].find(([, label]) => label === "Cover letter")![0];
    output.length = 0;
    expect(await runAnswerCommand(["--run", prefix, "--q", String(pythonQ), "--answer", "yes", "--profile", "demo"], deps)).toBe(0);
    expect(await runAnswerCommand(["--run", prefix, "--q", String(productsQ), "--answer", "No", "--profile", "demo"], deps)).toBe(0);
    expect(output.join("\n")).toContain(`Q${productsQ} used once (it names the company)`);
    expect(output.at(-2)).toBe(`Still open: Q${coverQ}`);
    expect(captured).toHaveLength(0);

    output.length = 0;
    expect(await runAnswerCommand(["--run", prefix, "--continue", "--profile", "demo"], deps)).toBe(0);
    expect(captured).toEqual([{ voiceDrafter: null, lockHeld: true }]);
    expect(output).toContain(`Run ${prefix} continued: paused-needs-input.`);
    expect(output).toContain(`Still open: Q${coverQ}`);
    expect(readPipelineLock(ws.dataDir)).toBeNull();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(count(ws.database, "model_invocations")).toBe(modelsBefore);
    ws.database.close();
  });

  it("continues by itself once the last question is answered, and never submits", async () => {
    const ws = workspace();
    const controls: RawControl[] = [pythonSelect(), langsText, submitButton];
    const run = await start(ws, controls);
    const prefix = run.id.slice(0, 8);
    const output: string[] = [];
    const captured: Array<{ voiceDrafter: unknown; lockHeld: boolean }> = [];
    const deps = cliDeps(ws, controls, output, captured);
    expect(await runAnswerCommand(["--run", prefix, "--q", "1", "--answer", "Yes", "--profile", "demo"], deps)).toBe(0);
    expect(captured).toHaveLength(0);
    expect(await runAnswerCommand(["--run", run.id, "--q", "2", "--answer", "Rust", "--once", "--profile", "demo"], deps)).toBe(0);
    expect(output).toContain(`Q2 used once (you asked to use it for this run only): "${LANGS_LABEL}"`);
    expect(output).toContain("No open questions remain.");
    expect(captured).toEqual([{ voiceDrafter: null, lockHeld: true }]);
    expect(output).toContain(`Run ${prefix} continued: awaiting-approval.`);
    expect(output.some((line) => line.includes("waits for your submit approval"))).toBe(true);
    const settled = getBrowserRun(ws.database, run.id);
    expect(settled?.status).toBe("awaiting-approval");
    expect(settled?.decisions.find((decision) => decision.fieldId === "python")?.action).toBe("choose");
    expect(answerRows(ws.database).map((row) => row.question)).toEqual([PYTHON_QUESTION]);

    // A run that is not paused takes no answers.
    output.length = 0;
    expect(await runAnswerCommand(["--run", prefix, "--q", "1", "--answer", "No", "--profile", "demo"], deps)).toBe(1);
    expect(output[0]).toContain("only paused runs take answers");
    ws.database.close();
  });

  it("refuses while a pass holds the pipeline lock, and releases the lock after a failed continue", async () => {
    const ws = workspace();
    const controls: RawControl[] = [langsText, submitButton];
    const run = await start(ws, controls);
    const output: string[] = [];
    const captured: Array<{ voiceDrafter: unknown; lockHeld: boolean }> = [];
    const deps = cliDeps(ws, controls, output, captured);

    const release = acquirePipelineLock(ws.dataDir);
    expect(await runAnswerCommand(["--run", run.id, "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(1);
    expect(output[0]).toMatch(/^Not run: A pipeline run is already in progress/);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    expect(answerRows(ws.database)).toHaveLength(0);
    release();

    output.length = 0;
    const failing: Partial<RunCommandDeps> = {
      ...deps,
      continueRun: async () => {
        captured.push({ voiceDrafter: null, lockHeld: readPipelineLock(ws.dataDir) !== null });
        throw new Error("The page could not open.");
      }
    };
    expect(await runAnswerCommand(["--run", run.id, "--q", "1", "--answer", "Go", "--profile", "demo"], failing)).toBe(1);
    expect(output.at(-1)).toBe("The run did not continue: The page could not open.");
    expect(captured).toEqual([{ voiceDrafter: null, lockHeld: true }]);
    expect(readPipelineLock(ws.dataDir)).toBeNull();
    ws.database.close();
  });

  it("names a run by its daily-digest item, lists the digest's asks in order, and answers by --digest", async () => {
    const ws = workspace();
    // An unlabeled control pauses but the digest does not ask it, so digest ask k is not Q k.
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "mystery", required: true },
      pythonSelect(),
      langsText,
      submitButton
    ];
    const run = await start(ws, controls);
    const prefix = run.id.slice(0, 8);
    const digest = buildDigest(collectDigestSnapshot(ws.database, "2000-01-01T00:00:00.000Z"), new Date())!;
    const item = digest.items.find((entry) => entry.runId === run.id)!;
    expect(item.number).toBe(1);
    mkdirSync(dirname(digestStatePath(ws.dataDir)), { recursive: true });
    writeFileSync(digestStatePath(ws.dataDir), JSON.stringify({
      version: 1, lastSentDate: null, lastSentAt: null, lastFailedAt: null,
      items: [{ number: 1, runId: run.id, jobId: ws.jobId, company: item.company }]
    }));
    const output: string[] = [];
    const captured: Array<{ voiceDrafter: unknown; lockHeld: boolean }> = [];
    const deps = cliDeps(ws, controls, output, captured);

    expect(await runQuestionsCommand(["--run", prefix, "--profile", "demo"], deps)).toBe(0);
    const byRun = numbered(output);
    output.length = 0;
    expect(await runQuestionsCommand(["--digest", "1", "--profile", "demo"], deps)).toBe(0);
    expect(numbered(output)).toEqual(byRun);
    expect(byRun.size).toBe(3);
    const askLine = output.find((line) => line.startsWith("Digest item 1 (asks in this order: "))!;
    const asked = [...askLine.matchAll(/Q(\d+)/g)].map((match) => Number(match[1]));
    expect(askLine).toBe("Digest item 1 (asks in this order: Q2, Q3)");
    // The digest's item line shows the same questions in the same order.
    const itemLine = digest.text.split("\n").find((line) => line.startsWith("1. "))!;
    const shown = [...itemLine.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    expect(shown).toEqual(asked.map((n) => byRun.get(n)!.replace(/"/g, "'")));
    expect(output.at(-1)).toBe('Answer with: pnpm run:answer --digest 1 --q <n> --answer "<text or option>"');

    output.length = 0;
    expect(await runAnswerCommand(["--digest", "1", "--q", String(asked[1]), "--answer", "Go", "--profile", "demo"], deps)).toBe(0);
    expect(output.join("\n")).toContain(`Q${asked[1]} saved for reuse: "${LANGS_LABEL}"`);
    expect(getBrowserRun(ws.database, run.id)?.pauses[asked[1]! - 1]).toMatchObject({ fieldId: "langs", status: "answered" });
    expect(captured).toHaveLength(0);

    output.length = 0;
    expect(await runAnswerCommand(["--digest", "2", "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(1);
    expect(output.at(-1)).toBe("Digest item 2 is not in the last digest.");
    expect(await runQuestionsCommand(["--digest", "2", "--profile", "demo"], deps)).toBe(1);
    expect(output.at(-1)).toBe("Digest item 2 is not in the last digest.");
    expect(await runAnswerCommand(["--run", prefix, "--digest", "1", "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(2);
    expect(await runAnswerCommand(["--digest", "0", "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(2);
    expect(await runAnswerCommand(["--digest", "x", "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(2);
    expect(await runQuestionsCommand(["--run", prefix, "--digest", "1", "--profile", "demo"], deps)).toBe(2);
    expect(await runQuestionsCommand(["--digest", "0", "--profile", "demo"], deps)).toBe(2);
    expect(await runQuestionsCommand(["--digest", "x", "--profile", "demo"], deps)).toBe(2);
    expect(output.at(-1)).toMatch(/^Usage: pnpm run:questions \(--run <id or 8-character prefix> \| --digest <n>\)/);
    expect(getBrowserRun(ws.database, run.id)?.pauses[asked[0]! - 1]?.status).toBe("open");
    ws.database.close();
  });

  it("refuses unknown runs, missing questions, bad arguments, and manual checklist mode", async () => {
    const ws = workspace();
    const controls: RawControl[] = [langsText, submitButton];
    const run = await start(ws, controls);
    const output: string[] = [];
    const deps = cliDeps(ws, controls, output, []);
    expect(await runAnswerCommand(["--run", "00000000", "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(1);
    expect(output.at(-1)).toBe('No browser run matches "00000000".');
    expect(await runAnswerCommand(["--run", run.id, "--q", "9", "--answer", "Go", "--profile", "demo"], deps)).toBe(1);
    expect(output.at(-1)).toBe(`Q9 does not exist; run ${run.id.slice(0, 8)} has 1 question(s).`);
    expect(await runAnswerCommand(["--run", run.id, "--q", "1", "--profile", "demo"], deps)).toBe(2);
    expect(await runAnswerCommand(["--run", run.id, "--q", "0", "--answer", "Go"], deps)).toBe(2);
    expect(await runAnswerCommand(["--run", run.id, "--once", "--continue"], deps)).toBe(2);
    expect(await runAnswerCommand(["--run", run.id, "--q", "1", "--answer", "Go", "--profile", "staging"], deps)).toBe(2);
    expect(await runAnswerCommand(["--run", run.id, "--bogus"], deps)).toBe(2);
    expect(await runQuestionsCommand([], deps)).toBe(2);
    expect(await runQuestionsCommand(["--run", "00000000", "--profile", "demo"], deps)).toBe(1);
    process.env.INTERNSHIP_AGENT_MANUAL_ONLY = "1";
    output.length = 0;
    expect(await runAnswerCommand(["--run", run.id, "--q", "1", "--answer", "Go", "--profile", "demo"], deps)).toBe(1);
    expect(output[0]).toMatch(/^Not run: manual checklist mode/);
    expect(getBrowserRun(ws.database, run.id)?.pauses[0]?.status).toBe("open");
    ws.database.close();
  });
});

describe("pnpm profile:answers", () => {
  it("lists and revokes saved answers, after which a run asks again", async () => {
    const ws = workspace();
    const run = await start(ws, [pythonSelect(), submitButton]);
    await answerRunPause(run.id, "python", "Yes", true, { database: ws.database });
    cancelBrowserRun(run.id, ws.database);
    const output: string[] = [];
    const deps = { open: () => ws.database, close: () => {}, log: (line: string) => output.push(line) };

    expect(await runProfileAnswersCommand(["--profile", "demo"], deps)).toBe(0);
    const id = answerRows(ws.database)[0]!.id;
    expect(output).toEqual([`${id.slice(0, 8)} "${PYTHON_QUESTION}" -> Yes [option, saved ${new Date().toISOString().slice(0, 10)}]`]);

    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo", "--revoke", "ffffffff"], deps)).toBe(1);
    expect(output).toEqual(["Not found: ffffffff"]);
    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo", "--revoke", id.slice(0, 8)], deps)).toBe(0);
    expect(output).toEqual([`revoked ${id.slice(0, 8)} "${PYTHON_QUESTION}"`]);
    output.length = 0;
    expect(await runProfileAnswersCommand(["--profile", "demo"], deps)).toBe(0);
    expect(output).toEqual(["No saved question answers."]);
    expect(await runProfileAnswersCommand(["--revoke"], deps)).toBe(2);

    const again = await start(ws, [pythonSelect(), submitButton]);
    expect(again.decisions.find((decision) => decision.fieldId === "python")?.action).toBe("pause");
    ws.database.close();
  });
});
