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
  saveCandidate,
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

  it("never answers a sensitive stop from another run's answer, settles it only from the saved self-identification answer, and never shows a protected value", async () => {
    const ws = workspace();
    const gender: RawControl = { tag: "select", id: "gender", label: "Gender", required: true, options: ["Male", "Female", "Decline To Self Identify"] };
    const run = await start(ws, [gender, submitButton]);
    const pause = run.pauses.find((entry) => entry.fieldId === "gender")!;
    expect(pause.sensitive).toBe(true);
    const other = heldRun(ws, run, [{ ...pause }]);
    const answered = await answerRunPause(run.id, "gender", "female", true, { database: ws.database });
    expect(answered.outcome).toMatchObject({ saved: false, reason: "sensitive" });
    expect(answered.rechecked).toBe(0);
    expect(getBrowserRun(ws.database, other.id)?.pauses[0]?.status).toBe("open");
    // With the answer saved explicitly as a self-identification answer, the sweep settles the stop through the
    // self-identification path only (Track 91): no answer in the pause, no recorded wording.
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });
    const results = await recheckPausedRuns(ws.database, { apply: true });
    expect(results.flatMap((result) => result.matches)).toEqual([{ index: 0, fieldId: "gender", label: "Gender", kind: "self_identification" }]);
    expect(getBrowserRun(ws.database, other.id)?.pauses[0]).toMatchObject({ status: "answered", answer: null, sensitive: true });
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

  it("answers a held stop the profile answers (field of study, LinkedIn link), names the profile field without its value, and continue keeps the profile basis (Track 57)", async () => {
    const ws = workspace();
    const linkedin = "https://www.linkedin.com/in/jordan-fixture";
    const csLabel = "Are you a current college student majoring in computer science or related field?";
    const linkedinLabel = "Please provide a link to your LinkedIn profile.";
    const controls: RawControl[] = [
      { tag: "select", id: "cs-major", label: csLabel, required: true, options: ["Yes", "No"] },
      { tag: "input", type: "text", id: "linkedin", label: linkedinLabel, required: true },
      submitButton
    ];
    const run = await start(ws, controls);
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses.map((pause) => [pause.fieldId, pause.status])).toEqual([["cs-major", "open"], ["linkedin", "open"]]);

    // The candidate fills in the profile after the run paused.
    saveCandidate(ws.database, LOCAL_CANDIDATE_ID, {
      fullName: "Jordan Rivera", preferredName: "Jordan", email: "jordan@example.test", school: "Example State University",
      degree: "B.S. Computer Science", graduationDate: "2030-05-15", githubUrl: "https://github.com/example-candidate",
      fieldOfStudy: "Computer Science", linkedinUrl: linkedin
    });
    saveFact(ws.database, { key: "graduation_date", scope: { kind: "global" }, value: "2030-05-15" });

    const result = await recheckRunPauses(ws.database, run.id, { apply: true });
    expect(result.matches.map((match) => [match.fieldId, match.kind])).toEqual([["cs-major", "profile_field"], ["linkedin", "profile_field"]]);
    const held = getBrowserRun(ws.database, run.id)!;
    expect(held.status).toBe("paused-needs-input");
    expect(held.pauses.map((pause) => [pause.fieldId, pause.status, pause.answer, pause.suggestedKey])).toEqual([
      ["cs-major", "answered", "Yes", null],
      ["linkedin", "answered", linkedin, null]
    ]);
    const details = eventDetails(ws);
    expect(details).toContain(`Answer to "${linkedinLabel}" found in your saved answers (your profile): your profile's LinkedIn link; it no longer waits for you.`);
    expect(details).toContain(`Answer to "${csLabel}" found in your saved answers (your profile): your profile's field of study; it no longer waits for you.`);
    expect(details.some((detail) => detail.includes("linkedin.com/in/jordan-fixture"))).toBe(false);
    // A profile match records no wording: the planner reads the profile on every run.
    expect(aliasRows(ws.database)).toEqual([]);

    const page = fakePage({ controls });
    const continued = await continueBrowserRun(run.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page, pauseReviewer: null });
    expect(page.filled.get("linkedin")).toBe(linkedin);
    expect(page.filled.get("cs-major")).toBe("Yes");
    const decision = (fieldId: string) => continued.run.decisions.find((entry) => entry.fieldId === fieldId);
    expect(decision("linkedin")?.basis).toEqual({ kind: "profile", field: "linkedinUrl" });
    expect(decision("cs-major")?.basis).toEqual({ kind: "profile", field: "fieldOfStudy" });
    ws.database.close();
  });

  it("answers a held phone number box from the profile and a degree-program enrollment question from the saved enrollment, writing nothing on a dry run (Track 67)", async () => {
    const ws = workspace();
    const like = await start(ws, [pythonSelect(), submitButton]);
    const { options: _options, ...phone } = questionPause("Phone", "phone-number", { fieldKind: "number" });
    const held = heldRun(ws, like, [
      phone,
      questionPause("Are you currently enrolled in a degree program at a registered college or university?", "enrolled", { fieldKind: "radio" })
    ]);
    saveCandidate(ws.database, LOCAL_CANDIDATE_ID, {
      fullName: "Jordan Rivera", preferredName: "Jordan", email: "jordan@example.test", phone: "(555) 010-0199", school: "Example State University",
      degree: "B.S. Computer Science", graduationDate: "2030-05-15", githubUrl: "https://github.com/example-candidate"
    });
    saveFact(ws.database, { key: "enrolled_full_time", scope: { kind: "global" }, value: true });
    const before = ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all();
    const result = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(result.matches.map((match) => [match.fieldId, match.kind])).toEqual([["phone-number", "profile_field"], ["enrolled", "saved_fact"]]);
    expect(ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all()).toEqual(before);
    expect(aliasRows(ws.database)).toEqual([]);
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

describe("U.S. citizenship and U.S.-wide relocation answer held stops (Track 62)", () => {
  // Fictional wordings and options shaped like the held runs' (2026-11-26).
  const FIVE_DAYS = "This position requires you to work 5 days per week for the duration of the internship. Are you currently located in, or willing to relocate to Fixture Bay?";
  const SUMMER = "Can you relocate to Fixture Bay for the Summer internship (June-August)?";
  const AUTHORIZED = "Are you legally authorized to work in the United States?";
  const STATUSES = [
    "I am authorized to work in the United States for any employer",
    "I am authorized to work in the United States for my present employer",
    "I require sponsorship to work in the United States",
    "I am not authorized to work in the United States",
    "My status to work in the United States is unknown",
    "If Other, please explain:"
  ];

  // The job's-country wording a posting outside the United States stores with its own country scope.
  const JOB_COUNTRY = "Are you legally authorized to work in the country in which this job is located?";
  const JOB_COUNTRY_STATUSES = [
    "I am authorized to work in this country for any employer",
    "I am authorized to work in this country for my present employer",
    "I require sponsorship to work in this country"
  ];

  function citizenWorkspace(countryCode: "US" | "CA"): Workspace {
    const ws = workspace();
    ws.database.prepare("UPDATE job_locations SET city = 'Fixture Bay', country_code = ? WHERE job_id = ?").run(countryCode, ws.jobId);
    saveFact(ws.database, { key: "willing_to_relocate", scope: { kind: "country", code: "US" }, value: true });
    saveFact(ws.database, { key: "work_arrangement", scope: { kind: "global" }, value: true });
    saveFact(ws.database, { key: "us_citizen", scope: { kind: "global" }, value: true });
    return ws;
  }

  async function heldStops(ws: Workspace, authorization: PauseRecord): Promise<BrowserRun> {
    const run = await start(ws, [pythonSelect(), submitButton]);
    return heldRun(ws, run, [
      questionPause(FIVE_DAYS, "relocate", { fieldKind: "radio", suggestedKey: "willing_to_relocate", suggestedScope: "location:fixture bay" }),
      authorization,
      questionPause(SUMMER, "summer", { fieldKind: "radio", suggestedKey: "willing_to_relocate", suggestedScope: "location:fixture bay for the summer internship (june-august)" })
    ]);
  }

  it("matches the relocation and authorization stops on a U.S. posting and writes nothing on a dry run", async () => {
    const ws = citizenWorkspace("US");
    expect(getJobPosting(ws.database, ws.jobId)!.locations.some((location) => location.city === "Fixture Bay" && location.countryCode === "US")).toBe(true);
    const held = await heldStops(ws, questionPause(AUTHORIZED, "authorized", { fieldKind: "radio", suggestedKey: "authorized_to_work", suggestedScope: "country:US", options: STATUSES }));
    const before = ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all();
    const result = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(result.matches.map((match) => [match.fieldId, match.kind])).toEqual([["relocate", "saved_fact"], ["authorized", "standard_answer"]]);
    expect(result.left.map((entry) => entry.label)).toEqual([SUMMER]);
    expect(ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all()).toEqual(before);
    expect(aliasRows(ws.database)).toEqual([]);
    ws.database.close();
  });

  it("matches neither stop on a posting outside the United States", async () => {
    const ws = citizenWorkspace("CA");
    saveFact(ws.database, { key: "authorized_to_work", scope: { kind: "country", code: "CA" }, value: true });
    const held = await heldStops(ws, questionPause(JOB_COUNTRY, "authorized", {
      fieldKind: "radio", suggestedKey: "authorized_to_work", suggestedScope: "country:CA", options: JOB_COUNTRY_STATUSES
    }));
    const result = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(result.matches).toEqual([]);
    expect(result.left.map((entry) => entry.label)).toEqual([FIVE_DAYS, JOB_COUNTRY, SUMMER]);
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

describe("sensitive stops and the saved self-identification answers (Track 91, fictional answers)", () => {
  const GENDER_OPTIONS = ["Male", "Female", "Decline To Self Identify"];
  const genderControl = (options = GENDER_OPTIONS): RawControl => ({ tag: "select", id: "gender", label: "Gender", required: true, options });
  /** A sensitive pause recorded by a run that paused before the self-identification matcher settled it (before Track 82). */
  function sensitivePause(label: string, fieldId: string, overrides: Partial<PauseRecord> = {}): PauseRecord {
    return questionPause(label, fieldId, {
      question: `This looks like a demographic or equal-opportunity question ("${label}"). Please answer it yourself; it will not be stored.`,
      sensitive: true, ...overrides
    });
  }
  const protectedValues = /\bfemale\b|she\/her|not_veteran|no_disability|hispanic_or_latino/i;
  /** Every held run's pauses without their offered options (which name the options, not the answer). */
  function pausesText(ws: Workspace): string {
    const rows = ws.database.prepare("SELECT pauses_json FROM browser_runs").all() as Array<{ pauses_json: string }>;
    return JSON.stringify(rows.map((row) => (JSON.parse(row.pauses_json) as PauseRecord[]).map(({ options: _options, ...rest }) => rest)));
  }
  function rowsText(ws: Workspace): string {
    return JSON.stringify({
      runs: pausesText(ws),
      events: eventDetails(ws),
      aliases: aliasRows(ws.database),
      questions: ws.database.prepare("SELECT * FROM candidate_question_answers").all()
    });
  }

  it("settles an older held run's self-identification stop from the saved answer without storing or showing it, and continue fills it", async () => {
    const ws = workspace();
    const like = await start(ws, [pythonSelect(), submitButton]);
    const held = heldRun(ws, like, [sensitivePause("Gender", "gender", { options: GENDER_OPTIONS })]);
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });

    const before = ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all();
    const dry = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(dry.matches).toEqual([{ index: 0, fieldId: "gender", label: "Gender", kind: "self_identification" }]);
    expect(ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all()).toEqual(before);

    const output: string[] = [];
    const deps = {
      openReadOnly: () => ws.database, closeReadOnly: () => {}, open: () => ws.database, close: () => {},
      dataDir: () => ws.dataDir, acquireLock: (dataDir: string) => acquirePipelineLock(dataDir), log: (line: string) => output.push(line)
    };
    expect(await runQuestionsRecheckCommand(["--profile", "demo", "--apply"], deps)).toBe(0);
    expect(output).toContain(`Run ${held.id.slice(0, 8)}: ${ws.company} — Software Engineering Intern: Q1 self_identification`);
    expect(output.some((line) => line.includes("self_identification 1); skipped"))).toBe(true);
    expect(output.join("\n")).not.toMatch(protectedValues);

    const settled = getBrowserRun(ws.database, held.id)!;
    expect(settled.status).toBe("paused-needs-input");
    expect(settled.pauses[0]).toMatchObject({ status: "answered", answer: null, sensitive: true, suggestedKey: null, suggestedScope: null });
    expect(eventDetails(ws)).toContain('Answer to "Gender" settled by your saved voluntary self-identification answer; it no longer waits for you.');
    expect(aliasRows(ws.database)).toEqual([]);
    expect(ws.database.prepare("SELECT COUNT(*) AS n FROM candidate_question_answers").get()).toEqual({ n: 0 });
    expect(rowsText(ws)).not.toMatch(protectedValues);

    // Continue plans the field again from the saved answer and fills the one matching option.
    const page = fakePage({ controls: [genderControl(), submitButton] });
    const continued = await continueBrowserRun(held.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page, pauseReviewer: null });
    expect(page.filled.get("gender")).toBe("Female");
    expect(continued.run.status).toBe("awaiting-approval");
    const decision = continued.run.decisions.find((entry) => entry.fieldId === "gender")!;
    expect(decision).toMatchObject({ action: "choose", basis: { kind: "fact", key: "eeo_gender", scope: "global" } });
    expect(decision.reason).not.toMatch(protectedValues);
    expect(continued.run.pauses[0]).toMatchObject({ status: "answered", answer: null });
    expect(eventDetails(ws).join("\n")).not.toMatch(protectedValues);
    ws.database.close();
  });

  it("opens the stop again on continue when the page's options no longer match the saved answer", async () => {
    const ws = workspace();
    const like = await start(ws, [pythonSelect(), submitButton]);
    const held = heldRun(ws, like, [sensitivePause("Gender", "gender", { options: GENDER_OPTIONS })]);
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });
    expect((await recheckRunPauses(ws.database, held.id, { apply: true })).matches).toHaveLength(1);
    const page = fakePage({ controls: [genderControl(["Male", "Decline To Self Identify"]), submitButton] });
    const continued = await continueBrowserRun(held.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page, pauseReviewer: null });
    expect(page.filled.has("gender")).toBe(false);
    expect(continued.run.status).toBe("paused-needs-input");
    expect(continued.run.pauses.find((pause) => pause.fieldId === "gender")).toMatchObject({ status: "open", answer: null, sensitive: true });
    ws.database.close();
  });

  it("keeps non-identity sensitive wordings, page failures, and unsaved categories open, and writes nothing for them", async () => {
    const ws = workspace();
    const like = await start(ws, [pythonSelect(), submitButton]);
    const held = heldRun(ws, like, [
      sensitivePause("Veteran Self-Identification Status of your spouse", "spouse-veteran", { options: ["Declines to Self-Identify", "Not a Protected Veteran", "Protected Veteran"] }),
      sensitivePause("Do you have a disability or chronic condition that requires accommodation?", "accommodation", { options: ["Yes", "No", "I do not wish to answer"] }),
      sensitivePause("My manager is Hispanic or Latino", "manager", { fieldKind: "checkbox", options: undefined }),
      sensitivePause("I am Hispanic or Latino.", "hispanic-box", { fieldKind: "checkbox", options: undefined }),
      sensitivePause("Gender", "gender-failed", { options: GENDER_OPTIONS, question: 'The agent could not fill "Gender": the option was not found. Answer it here, or fill it in the browser.' }),
      sensitivePause("Sexual Orientation", "orientation", { options: ["Heterosexual", "Gay", "Decline to self-identify"] })
    ]);
    saveFact(ws.database, { key: "eeo_veteran_status", scope: { kind: "global" }, value: "not_veteran" });
    saveFact(ws.database, { key: "eeo_disability_status", scope: { kind: "global" }, value: "no_disability" });
    saveFact(ws.database, { key: "eeo_race_ethnicity", scope: { kind: "global" }, value: "white" });
    saveFact(ws.database, { key: "eeo_gender", scope: { kind: "global" }, value: "female" });
    const before = rowsText(ws);
    const result = await recheckRunPauses(ws.database, held.id, { apply: true });
    expect(result.matches).toEqual([]);
    expect(result.skipped).toBe(1);
    // A single sensitive box is never settled by the re-check (see the next test).
    expect(result.left.map((entry) => [entry.label, entry.aiEligible])).toEqual([
      ["Veteran Self-Identification Status of your spouse", false],
      ["Do you have a disability or chronic condition that requires accommodation?", false],
      ["My manager is Hispanic or Latino", false],
      ["I am Hispanic or Latino.", false],
      ["Sexual Orientation", false]
    ]);
    expect(getBrowserRun(ws.database, held.id)!.pauses.every((pause) => pause.status === "open")).toBe(true);
    expect(rowsText(ws)).toBe(before);
    ws.database.close();
  });

  it("never settles a single self-identification box in either direction, so the re-check's outcome never shows the saved answer", async () => {
    for (const value of ["hispanic_or_latino", "white"] as const) {
      const ws = workspace();
      const like = await start(ws, [pythonSelect(), submitButton]);
      const held = heldRun(ws, like, [
        sensitivePause("I am Hispanic or Latino.", "hispanic-box", { fieldKind: "checkbox", options: undefined }),
        sensitivePause("Disabled Veteran", "disabled-veteran", { fieldKind: "checkbox", options: undefined })
      ]);
      saveFact(ws.database, { key: "eeo_race_ethnicity", scope: { kind: "global" }, value });
      saveFact(ws.database, { key: "eeo_veteran_status", scope: { kind: "global" }, value: "not_veteran" });
      const before = rowsText(ws);
      const result = await recheckRunPauses(ws.database, held.id, { apply: true });
      expect(result.matches, value).toEqual([]);
      expect(result.left.map((entry) => [entry.label, entry.aiEligible]), value).toEqual([["I am Hispanic or Latino.", false], ["Disabled Veteran", false]]);
      expect(rowsText(ws), value).toBe(before);
      ws.database.close();
    }
  });

  it("settles a pronoun question an older run recorded as sensitive from the saved pronouns answer, never through a recorded wording", async () => {
    const ws = workspace();
    const like = await start(ws, [pythonSelect(), submitButton]);
    const options = ["He/him", "She/her", "They/them", "Prefer not to say"];
    const held = heldRun(ws, like, [sensitivePause("What are your pronouns?", "pronouns", { fieldKind: "radio", options })]);
    // Before a pronouns answer is saved, a question-memory answer with this exact wording recorded against it does not settle it.
    const stored = saveQuestionAnswer(ws.database, { candidateId: LOCAL_CANDIDATE_ID, question: "Favorite pronoun set", answerKind: "option", answer: "She/her", sourceRunId: null });
    recordQuestionAlias(ws.database, {
      candidateId: LOCAL_CANDIDATE_ID, wording: "What are your pronouns?", target: { kind: "question", questionKey: stored.answer.questionKey },
      atsKind: "greenhouse", options, source: "candidate_answer", sourceRunId: null
    });
    const unsaved = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(unsaved.matches).toEqual([]);
    expect(unsaved.left).toEqual([{ index: 0, label: "What are your pronouns?", aiEligible: false }]);
    saveFact(ws.database, { key: "pronouns", scope: { kind: "global" }, value: "she/her" });
    const result = await recheckRunPauses(ws.database, held.id, { apply: true });
    expect(result.matches).toEqual([{ index: 0, fieldId: "pronouns", label: "What are your pronouns?", kind: "self_identification" }]);
    expect(getBrowserRun(ws.database, held.id)!.pauses[0]).toMatchObject({ status: "answered", answer: null, sensitive: true });
    expect(eventDetails(ws)).toContain('Answer to "What are your pronouns?" settled by your saved pronouns answer; it no longer waits for you.');
    // No wording is recorded against the protected stop; the one recorded above is the only one.
    expect(aliasRows(ws.database).map((row) => row.source)).toEqual(["candidate_answer"]);
    expect(JSON.stringify({ events: eventDetails(ws), runs: pausesText(ws) })).not.toMatch(/she\/her/i);
    const page = fakePage({ controls: [{ tag: "input", type: "radio", id: "pronouns", label: "What are your pronouns?", required: true, options }, submitButton] });
    const continued = await continueBrowserRun(held.id, { database: ws.database, dataDir: ws.dataDir, openPage: async () => page, pauseReviewer: null });
    expect(page.filled.get("pronouns")).toBe("She/her");
    expect(continued.run.status).toBe("awaiting-approval");
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
      "open pauses: 2; would be answered by saved answers: 1 (saved_fact 0, standard_answer 0, question_memory_exact 1, question_memory_normalized 0, alias_exact 0, alias_normalized 0, profile_field 0, self_identification 0); skipped (safeguard, upload, sensitive, page failures, faults, older runs): 0; still open: 1, of which would reach AI review: 1"
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
