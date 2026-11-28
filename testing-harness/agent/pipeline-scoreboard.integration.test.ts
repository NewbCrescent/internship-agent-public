import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeProfileDatabase,
  createDatabase,
  LOCAL_CANDIDATE_ID,
  persistNormalizedPosting,
  recordApplicationReceipt,
  resolveProfileDatabasePath,
  resolveProfileDataDirectory,
  saveBrowserRun,
  saveCandidateFact,
  saveQuestionAnswer
} from "@internship-agent/db";
import { normalizeAnswerText, POSSIBLE_SUBMISSION_NOTE, type BrowserRun, type FillDecision, type PauseRecord } from "@internship-agent/domain";

import { runScoreboardCommand } from "../../packages/agent/scripts/pipeline-scoreboard";
import { ANSWERED_CONTINUE_FAILURE } from "../../packages/agent/src/continued-auto-submit";
import {
  AWAITING_RECEIPT_LABEL,
  blockerId,
  buildScoreboard,
  normalizeStopReason,
  passBoardLine,
  pruneScoreboardSnapshots,
  refreshScoreboardSnapshot,
  SNAPSHOT_RETENTION_COUNT,
  snapshotFileName,
  stopReasonCategory,
  type Scoreboard
} from "../../packages/agent/src/pipeline-scoreboard";

/**
 * The application scoreboard (pnpm pipeline:scoreboard) against a disposable workspace and a
 * fixed clock. The global fetch throws, so nothing reaches the network; the command opens the
 * database read-only and writes only its own snapshot and claims files.
 */
const NOW = new Date("2026-11-26T12:00:00.000Z");
const HOUR = 3_600_000;
const later = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

let directory = "";
let saved: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "internship-agent-scoreboard-"));
  saved = process.env.INTERNSHIP_AGENT_DATA_DIR;
  process.env.INTERNSHIP_AGENT_DATA_DIR = directory;
  vi.stubGlobal("fetch", () => { throw new Error("network is not allowed in this suite"); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeProfileDatabase("real");
  if (saved === undefined) delete process.env.INTERNSHIP_AGENT_DATA_DIR;
  else process.env.INTERNSHIP_AGENT_DATA_DIR = saved;
  rmSync(directory, { recursive: true, force: true });
});

const dataDir = () => resolveProfileDataDirectory("real");
const openSeed = () => createDatabase(resolveProfileDatabasePath("real"));

function posting(database: DatabaseSync, companyName: string, status: string, createdAt = "2026-11-25T10:00:00.000Z"): string {
  const sourceUrl = `https://example.test/${companyName.toLowerCase().replace(/\W+/g, "-")}/${randomUUID()}`;
  const { jobId } = persistNormalizedPosting(database, {
    companyName, title: "Software Engineering Intern", employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${sourceUrl}`, normalizedText: "Software Engineering Intern\nFixture posting for the scoreboard.",
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  database.prepare("UPDATE jobs SET status = ?, created_at = ? WHERE id = ?").run(status, createdAt, jobId);
  return jobId;
}

function pause(label: string, extra: Partial<PauseRecord> = {}): PauseRecord {
  return {
    fieldId: randomUUID(), label, question: label, suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false,
    upload: false, status: "open", answer: null, draft: null, ...extra
  };
}

function run(database: DatabaseSync, jobId: string, status: BrowserRun["status"], pauses: PauseRecord[] = [], extra: Partial<BrowserRun> = {}): string {
  const existing = database.prepare("SELECT id FROM application_packages WHERE job_id = ?").get(jobId) as { id: string } | undefined;
  const packageId = existing?.id ?? randomUUID();
  if (!existing) {
    database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
      .run(packageId, jobId, "2026-11-25T09:00:00.000Z", "{}");
  }
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: "https://example.test/apply", status, packageId, variantId: null, baseResumeId: null,
    atsKind: "greenhouse", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true, decisions: [], pauses,
    submittedAnswers: null, confirmationText: null, submissionApprovedAt: null,
    createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:30:00.000Z", ...extra
  }).id;
}

function event(database: DatabaseSync, jobId: string, fromStatus: string | null, toStatus: string, detail: string | null, createdAt: string): void {
  database.prepare("INSERT INTO application_events (id, job_id, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), jobId, fromStatus, toStatus, detail, createdAt);
}

function match(database: DatabaseSync, jobId: string, verdict: string, eligible: boolean, evaluatedAt: string, findings: unknown[] = []): void {
  database.prepare(`INSERT INTO job_matches (job_id, verdict, eligible, fit_score, findings_json, reasons_json, evaluated_at)
    VALUES (?, ?, ?, 50, ?, '[]', ?)`).run(jobId, verdict, eligible ? 1 : 0, JSON.stringify(findings), evaluatedAt);
}

function candidate(database: DatabaseSync): void {
  database.prepare("INSERT OR IGNORE INTO candidates (id, full_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(LOCAL_CANDIDATE_ID, "Fixture Person", NOW.toISOString(), NOW.toISOString());
}

function fact(database: DatabaseSync, key: string, scope: { kind: "global" } | { kind: "country"; code: string }, value: string | boolean): void {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key: key as never, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1, rememberedAt: NOW.toISOString()
  });
}

/** A job waiting on its paused run's open questions (a run-level candidate hold). */
function pausedJob(database: DatabaseSync, companyName: string, pauses: PauseRecord[], extra: Partial<BrowserRun> = {}): string {
  const jobId = posting(database, companyName, "APPLYING");
  run(database, jobId, "paused-needs-input", pauses, extra);
  return jobId;
}

async function command(args: string[], now = NOW): Promise<{ code: number; text: string; lines: string[] }> {
  const lines: string[] = [];
  const code = await runScoreboardCommand(args, { log: (line) => lines.push(line), now: () => now });
  return { code, text: lines.join("\n"), lines };
}

async function board(args: string[] = [], now = NOW): Promise<Scoreboard> {
  const result = await command(["--json", "--no-save", ...args], now);
  expect(result.code).toBe(0);
  return JSON.parse(result.text) as Scoreboard;
}

function seed(work: (database: DatabaseSync) => void): void {
  const database = openSeed();
  try { work(database); } finally { database.close(); }
}

describe("funnel", () => {
  it("counts each job once per stage on its first UTC day in the window, and per-day counts sum to the totals", async () => {
    const traces = join(dataDir(), "discovery-traces");
    mkdirSync(traces, { recursive: true });
    const row = (url: string) => JSON.stringify({ type: "row", list: "https://list.test", pass: "p1", at: NOW.toISOString(), url, decision: "resolved" });
    writeFileSync(join(traces, "2026-11-25.jsonl"), [
      JSON.stringify({ type: "pass", list: "https://list.test", pass: "p1", at: NOW.toISOString(), source: "List", full: true }),
      row("https://a.test/A"), row("https://a.test/B"), "{not json", row("https://a.test/C"), ""
    ].join("\n"));
    writeFileSync(join(traces, "2026-11-26.jsonl"), [row("https://a.test/B"), row("https://a.test/D")].join("\n") + "\n");
    writeFileSync(join(traces, "2026-11-10.jsonl"), row("https://a.test/OLD") + "\n");

    seed((database) => {
      const qualifiedByMatch = posting(database, "Alpha", "QUALIFIED", "2026-11-25T10:00:00.000Z");
      match(database, qualifiedByMatch, "QUALIFIED", true, "2026-11-25T11:00:00.000Z");
      const pursued = posting(database, "Beta", "READY_FOR_REVIEW", "2026-11-26T08:00:00.000Z");
      event(database, pursued, "QUALIFIED", "PREPARING", null, "2026-11-26T09:00:00.000Z");
      event(database, pursued, "PREPARING", "READY_FOR_REVIEW", null, "2026-11-26T09:30:00.000Z");
      const degree = posting(database, "Gamma", "NOT_QUALIFIED", "2026-11-24T10:00:00.000Z");
      match(database, degree, "NOT_QUALIFIED", false, "2026-11-24T11:00:00.000Z",
        [{ outcome: "FAIL", subject: "DEGREE", reason: "Quotes resume text SECRET-RESUME-LINE" }, { outcome: "PASS", subject: "LOCATION" }]);
      const target = posting(database, "Delta", "QUALIFIED", "2026-11-24T10:00:00.000Z");
      event(database, target, "QUALIFIED", "QUALIFIED", "Not pursued for your target: Role: the title names no software or adjacent engineering work.", "2026-11-25T12:00:00.000Z");
      const capped = posting(database, "Epsilon", "READY_FOR_REVIEW", "2026-11-24T10:00:00.000Z");
      event(database, capped, "READY_FOR_REVIEW", "READY_FOR_REVIEW", "Company cap: already 2 applications to Epsilon.", "2026-11-25T13:00:00.000Z");
      const closed = posting(database, "Zeta", "NOT_QUALIFIED", "2026-11-23T10:00:00.000Z");
      database.prepare("INSERT INTO discovery_feedback (job_id, decision, reason, preference_note, created_at) VALUES (?, 'SKIP', ?, ?, ?)")
        .run(closed, "Posting closed", "SECRET-PREFERENCE-NOTE", "2026-11-23T15:00:00.000Z");
      const twice = posting(database, "Eta", "APPLYING", "2026-11-23T09:00:00.000Z");
      run(database, twice, "cancelled", [], { createdAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T11:00:00.000Z" });
      run(database, twice, "failed", [], {
        createdAt: "2026-11-25T10:00:00.000Z", submissionApprovedAt: "2026-11-25T10:30:00.000Z", updatedAt: "2026-11-25T10:40:00.000Z"
      });
      const old = posting(database, "Theta", "QUALIFIED", "2026-11-10T10:00:00.000Z");
      match(database, old, "QUALIFIED", true, "2026-11-10T11:00:00.000Z");
      event(database, old, "QUALIFIED", "PREPARING", null, "2026-11-10T12:00:00.000Z");
    });

    const result = await board();
    expect(result.days).toBe(7);
    expect(result.since).toBe("2026-11-20T00:00:00.000Z");
    const day = (date: string) => result.funnel.days.find((entry) => entry.date === date)!;
    expect(result.funnel.days.map((entry) => entry.date)).toEqual(["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
    expect(day("2026-11-23")).toEqual({ date: "2026-11-23", seen: null, stored: 2, qualified: 0, ruledOut: 1, started: 1, reachedSubmit: 0, confirmed: 0, failedOrHeld: 1 });
    expect(day("2026-11-24")).toEqual({ date: "2026-11-24", seen: null, stored: 3, qualified: 0, ruledOut: 1, started: 0, reachedSubmit: 0, confirmed: 0, failedOrHeld: 0 });
    expect(day("2026-11-25")).toEqual({ date: "2026-11-25", seen: 3, stored: 1, qualified: 1, ruledOut: 2, started: 0, reachedSubmit: 1, confirmed: 0, failedOrHeld: 0 });
    expect(day("2026-11-26")).toEqual({ date: "2026-11-26", seen: 1, stored: 1, qualified: 1, ruledOut: 0, started: 0, reachedSubmit: 0, confirmed: 0, failedOrHeld: 0 });
    expect(day("2026-11-20").seen).toBeNull();
    expect(result.funnel.totals).toEqual({ seen: 4, stored: 7, qualified: 2, ruledOut: 4, started: 1, reachedSubmit: 1, confirmed: 0, failedOrHeld: 1 });
    for (const stage of ["stored", "qualified", "ruledOut", "started", "reachedSubmit", "confirmed", "failedOrHeld"] as const) {
      expect(result.funnel.days.reduce((sum, entry) => sum + entry[stage], 0)).toBe(result.funnel.totals[stage]);
    }
    expect(result.funnel.ruledOutByReason).toEqual([
      { reason: "company cap", count: 1 },
      { reason: "not pursued for your target: role", count: 1 },
      { reason: "not qualified: degree", count: 1 },
      { reason: "Posting closed", count: 1 }
    ]);
    expect(result.funnel.failedOrHeldByHold).toEqual([{ reason: "possible-submission", count: 1 }]);
    expect(result.funnel.requeuedOrInProgress).toBe(0);
    expect(result.stock).toContainEqual({ status: "QUALIFIED", count: 3 });
    const text = (await command(["--no-save"])).text;
    expect(text).toContain("Application scoreboard — last 7 days (2026-11-20 to 2026-11-26 UTC)");
    expect(text).toContain("Ruled out by reason: company cap 1, not pursued for your target: role 1, not qualified: degree 1, Posting closed 1");
    for (const secret of ["SECRET-RESUME-LINE", "SECRET-PREFERENCE-NOTE"]) expect(text + JSON.stringify(result)).not.toContain(secret);
  });

  it("counts only confirmed submissions: never a status flip or the closed-dialog relabel", async () => {
    seed((database) => {
      const relabeled = posting(database, "Dover Co", "SUBMITTED");
      event(database, relabeled, "APPLYING", "SUBMITTED", "Submitted on Dover: modal dialog closed after submit without errors.", "2026-11-25T14:00:00.000Z");
      run(database, relabeled, "submitted", [], { confirmationText: "Submitted with confirmation: Modal dialog closed after submit without errors." });
      const manual = posting(database, "Manual Co", "SUBMITTED");
      event(database, manual, "READY_FOR_REVIEW", "SUBMITTED", "Candidate applied manually.", "2026-11-25T15:00:00.000Z");
      const thanked = posting(database, "Thanks Co", "SUBMITTED");
      run(database, thanked, "submitted", [], { confirmationText: "Thank you for applying.", updatedAt: "2026-11-25T16:30:00.000Z" });
      event(database, thanked, "APPLYING", "SUBMITTED", "Submitted automatically.", "2026-11-25T16:00:00.000Z");
      const receipted = posting(database, "Receipt Co", "APPLYING");
      const runId = run(database, receipted, "failed", [], { submissionApprovedAt: "2026-11-25T10:20:00.000Z" });
      recordApplicationReceipt(database, { jobId: receipted, runId }, "confirmed", "proof-ref", "2026-11-25T10:20:00.000Z", "2026-11-26T08:00:00.000Z");
    });
    const result = await board();
    expect(result.funnel.totals.confirmed).toBe(2);
    expect(result.funnel.days.find((day) => day.date === "2026-11-25")!.confirmed).toBe(1);
    expect(result.funnel.days.find((day) => day.date === "2026-11-26")!.confirmed).toBe(1);
    expect(result.funnel.markedSubmittedUnconfirmed).toBe(2);
    expect(result.heldApplications).toBe(0);
    const text = (await command(["--no-save"])).text;
    expect(text).toContain("Marked submitted without confirmation (not counted): 2");
    expect(text).not.toContain("Thank you for applying");
  });
});

describe("blocker board", () => {
  it("groups one question across wordings and company names, with one stable id", async () => {
    seed((database) => {
      pausedJob(database, "Acme", [pause("Are you authorized to work in the US?*"), pause("Have you worked at Acme before?")]);
      pausedJob(database, "Globex Inc.", [pause("are you authorized to work in the US (required)"), pause("Have you worked at Globex before?")]);
      pausedJob(database, "Initech", [pause("ARE YOU AUTHORIZED TO WORK IN THE US?")]);
    });
    const result = await board();
    expect(result.heldApplications).toBe(3);
    expect(result.blockers.map(({ label, applications, unblocks, companies, category }) => ({ label, applications, unblocks, companies, category }))).toEqual([
      { label: 'question: "are you authorized to work in the us"', applications: 3, unblocks: 1, companies: ["Acme", "Globex Inc.", "Initech"], category: "needs-candidate" },
      { label: 'question: "have you worked at the company before"', applications: 2, unblocks: 0, companies: ["Acme", "Globex Inc."], category: "needs-candidate" }
    ]);
    expect(result.blockers[0]!.id).toBe(blockerId("question|are you authorized to work in the us"));
    expect(result.blockers[0]!.owner).toEqual(["candidate"]);
    expect(result.blockers[0]!.holdReasons).toEqual(["candidate-question"]);

    const first = normalizeStopReason("Automatic browser run waiting: Workday acme.wd5.myworkdayjobs.com: the account step stopped (Workday did not answer the sign-in submit within 30 seconds). Retry in 15 minutes.", "Acme");
    const second = normalizeStopReason("Automatic browser run waiting: Workday globex.wd1.myworkdayjobs.com: the account step stopped (Workday did not answer the sign-in submit within 45 seconds). Retry in 40 minutes.", "Globex");
    expect(first.key).toBe(second.key);
    expect(first.label).toBe("Workday <site>: the account step stopped (Workday did not answer the sign-in submit within N seconds)");
    expect(blockerId(`stop|${first.key}`)).toBe(blockerId(`stop|${second.key}`));
  });

  it("marks each blocker needs the candidate, needs a fix, or site safeguard, and ranks by applications, then sole blockers", async () => {
    seed((database) => {
      candidate(database);
      fact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
      saveQuestionAnswer(database, { candidateId: LOCAL_CANDIDATE_ID, question: "Do you have a driver's license?", answerKind: "option", answer: "Yes", sourceRunId: null });
      pausedJob(database, "Question Co", [pause("What is your favorite color?")]);
      pausedJob(database, "Answer Co", [pause("What is your favorite color?"), pause("Do you have a driver's license? *")]);
      pausedJob(database, "Missing Co", [pause("When can you start?", { suggestedKey: "available_start_date" })]);
      pausedJob(database, "Saved Co", [pause("Are you authorized to work in the United States?", { suggestedKey: "authorized_to_work", suggestedScope: "country:US" })]);
      pausedJob(database, "Fault Co", [pause("Unlabeled select control 3")]);
      pausedJob(database, "Challenge Co", [pause("Verify you are human", { safeguard: true })]);
    });
    const result = await board();
    expect(result.blockers.map(({ label, category, applications, unblocks }) => [label, category, applications, unblocks])).toEqual([
      ['question: "what is your favorite color"', "needs-candidate", 2, 1],
      ["greenhouse: unlabeled select control", "needs-fix", 1, 1],
      ["saved fact not used: authorized_to_work", "needs-fix", 1, 1],
      ["missing fact: available_start_date", "needs-candidate", 1, 1],
      ['safeguard challenge: "verify you are human"', "site-safeguard", 1, 1],
      ['saved answer not used: "do you have a driver s license"', "needs-fix", 1, 0]
    ]);
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(["question", "fault", "saved-fact-unused", "missing-fact", "challenge", "saved-answer-unused"]);
    expect(result.byCategory).toEqual({ "needs-fix": 3, "needs-candidate": 3, "site-safeguard": 1, "awaiting-receipt": 0 });
    expect(result.blockers.find((blocker) => blocker.kind === "fault")!.owner).toEqual(["manager"]);
    expect(stopReasonCategory(normalizeStopReason("Automatic browser run stopped: iCIMS careers-acme.icims.com: the site showed a CAPTCHA before the form.").label)).toBe("site-safeguard");
    expect(stopReasonCategory(normalizeStopReason("Automatic browser run failed: locator.click: Timeout 30000ms exceeded.").label)).toBe("needs-fix");

    const text = (await command(["--no-save"])).text;
    expect(text).toContain(`Biggest blocker: [${result.blockers[0]!.id}] question: "what is your favorite color" — 2 applications (needs the candidate)`);
    expect(text).toContain(`1. [${result.blockers[0]!.id}] [needs the candidate] question: "what is your favorite color" — 2 applications, 1 held only by this (Answer Co, Question Co)`);
    expect(text).toContain("By category: needs a fix 3, needs the candidate 3, site safeguard 1");
  });

  it("lists a policy submit held as a possible submission as waiting for a receipt, apart from other possible submissions (Track 85)", async () => {
    const approved = { submissionApprovedAt: "2026-11-25T10:30:00.000Z", updatedAt: "2026-11-25T10:40:00.000Z" };
    seed((database) => {
      const policy = posting(database, "Policy Co", "APPLYING");
      run(database, policy, "failed", [], approved);
      event(database, policy, "APPLYING", "APPLYING",
        `${POSSIBLE_SUBMISSION_NOTE}The auto-submit policy clicked the final submit of the application at policy.example and the page read as a confirmation.`, "2026-11-25T10:35:00.000Z");
      const plain = posting(database, "Plain Co", "APPLYING");
      run(database, plain, "failed", [], approved);
    });
    const result = await board();
    expect(result.blockers.map(({ label, category, kind, applications, companies }) => ({ label, category, kind, applications, companies }))).toEqual([
      { label: "a submit may have gone through: check for a receipt before any retry", category: "needs-fix", kind: "unconfirmed-submit", applications: 1, companies: ["Plain Co"] },
      { label: AWAITING_RECEIPT_LABEL, category: "awaiting-receipt", kind: "unconfirmed-submit", applications: 1, companies: ["Policy Co"] }
    ]);
    expect(result.byCategory["awaiting-receipt"]).toBe(1);
    expect(result.funnel.totals.reachedSubmit).toBeGreaterThanOrEqual(1);
    const text = (await command(["--no-save"])).text;
    expect(text).toContain(`[waiting for a receipt] ${AWAITING_RECEIPT_LABEL}`);
    expect(text).toContain("waiting for a receipt 1");
  });

  it("never prints answers, options, drafts, decision values, confirmations, saved fact values, or self-identification values", async () => {
    const secrets = ["non_binary", "non binary", "HOWHEARD-PELICAN", "SAVED-ANSWER-ZEBRA", "PAUSE-ANSWER-OTTER", "OPTION-GIRAFFE",
      "DRAFT-WALRUS", "DECISION-LYNX", "CONFIRM-HERON", "OPTION-TRIED-MARTEN", "person.secret@example.com", "QUERY-OSPREY"];
    seed((database) => {
      candidate(database);
      fact(database, "eeo_gender", { kind: "global" }, "non_binary");
      fact(database, "how_heard", { kind: "global" }, "HOWHEARD-PELICAN");
      saveQuestionAnswer(database, { candidateId: LOCAL_CANDIDATE_ID, question: "Which team interests you?", answerKind: "text", answer: "SAVED-ANSWER-ZEBRA", sourceRunId: null });
      const decision: FillDecision = { fieldId: "f1", action: "fill", value: "DECISION-LYNX", basis: null, reason: "Seeded decision.", pause: null };
      pausedJob(database, "Private Co", [
        pause("Gender", { sensitive: true, suggestedKey: "eeo_gender", options: ["Male", "Female", "Non-binary", "OPTION-GIRAFFE"] }),
        pause("Which team interests you?"),
        pause("Why this company?", { answer: "PAUSE-ANSWER-OTTER", draft: { text: "DRAFT-WALRUS", gate: null, reason: "Gate failed." } }),
        pause("Enter a valid email like person.secret@example.com", { safeguard: true, fieldId: "site-error-1" })
      ], { decisions: [decision] });
      const stopped = posting(database, "Stop Co", "APPLYING");
      run(database, stopped, "paused-needs-input", [pause("Earlier question", { status: "answered", answer: "PAUSE-ANSWER-OTTER" })]);
      event(database, stopped, "READY_FOR_REVIEW", "APPLYING",
        "Automatic browser run needs you: locator.fill: Timeout 5000ms exceeded waiting for getByLabel('OPTION-TRIED-MARTEN') at https://boards.example.test/x?ref=QUERY-OSPREY Call log: - waiting for getByLabel('OPTION-TRIED-MARTEN')",
        "2026-11-25T11:00:00.000Z");
      const sent = posting(database, "Sent Co", "SUBMITTED");
      run(database, sent, "submitted", [], { confirmationText: "CONFIRM-HERON: thank you" });
    });
    const json = JSON.stringify(await board());
    const text = (await command(["--no-save"])).text;
    for (const secret of secrets) {
      expect(json.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(text).toContain("saved fact not used: eeo_gender");
    expect(text).toContain('saved answer not used: "which team interests you"');
    expect(text).toContain('fix in the browser: "enter a valid email like email"');
    expect(text).toContain("greenhouse: <site>: Timeout Nms exceeded waiting for getByLabel(<text>) at <site>");
  });
  it("names a held run's stop only from a stop or hold event, never its start note (Track 78)", async () => {
    const AUTO_START = "Browser run started automatically from the verified package; your approval is required before submission.";
    seed((database) => {
      const answered = posting(database, "Answered Co", "APPLYING");
      run(database, answered, "paused-needs-input", [pause("Export control status", { status: "answered", answer: "US Citizen" })]);
      event(database, answered, "READY_FOR_REVIEW", "APPLYING", AUTO_START, "2026-11-25T10:00:00.000Z");
      event(database, answered, "APPLYING", "APPLYING", "Run trace saved: traces/answered.zip", "2026-11-25T10:05:00.000Z");
      const empty = posting(database, "Empty Co", "APPLYING");
      run(database, empty, "paused-needs-input", []);
      event(database, empty, "READY_FOR_REVIEW", "APPLYING", AUTO_START, "2026-11-25T10:00:00.000Z");
      const failed = posting(database, "Continue Co", "APPLYING");
      run(database, failed, "paused-needs-input", [pause("Export control status", { status: "answered", answer: "US Citizen" })]);
      event(database, failed, "READY_FOR_REVIEW", "APPLYING", AUTO_START, "2026-11-25T10:00:00.000Z");
      event(database, failed, "APPLYING", "APPLYING", "Run trace saved: traces/continue.zip", "2026-11-25T10:05:00.000Z");
      event(database, failed, "APPLYING", "APPLYING",
        ANSWERED_CONTINUE_FAILURE + "No application form was reached at https://job-boards.greenhouse.io/x. The page shows nothing.", "2026-11-25T11:00:00.000Z");
    });
    const result = await board();
    const byCompany = (company: string) => result.blockers.filter((blocker) => blocker.companies.includes(company))
      .map(({ label, category }) => ({ label, category }));
    expect(byCompany("Answered Co")).toEqual([{ label: "greenhouse: all questions answered; the run waits to be continued", category: "needs-fix" }]);
    expect(byCompany("Empty Co")).toEqual([{ label: "greenhouse: paused with no open question", category: "needs-fix" }]);
    expect(byCompany("Continue Co")).toEqual([{ label: "greenhouse: the answered run could not be continued: No application form was reached at <site>", category: "needs-fix" }]);
    expect(result.blockers.some((blocker) => blocker.label.includes("started automatically"))).toBe(false);
  });
});

describe("command", () => {
  it("leaves the database unchanged, and --no-save writes no file", async () => {
    seed((database) => {
      pausedJob(database, "Acme", [pause("Are you over 18?")]);
      const held = posting(database, "Globex", "APPLYING");
      run(database, held, "failed", [], { submissionApprovedAt: "2026-11-25T10:20:00.000Z" });
    });
    const path = resolveProfileDatabasePath("real");
    const snapshot = () => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const counts = Object.fromEntries(["application_holds", "application_hold_events", "application_events", "jobs", "browser_runs"].map((table) =>
          [table, (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
        return { counts, hash: createHash("sha256").update(readFileSync(path)).digest("hex") };
      } finally {
        database.close();
      }
    };
    const before = snapshot();
    expect((await command(["--no-save"])).code).toBe(0);
    expect((await command(["--json", "--no-save"])).code).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(dataDir(), "scoreboard"))).toBe(false);
    expect((await command([])).code).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("refuses to create a missing database", async () => {
    const result = await command(["--profile", "demo"]);
    expect(result.code).toBe(1);
    expect(result.text).toBe("No database for profile demo.");
    expect(existsSync(resolveProfileDatabasePath("demo"))).toBe(false);
  });

  it("saves owner-only snapshots, reports what grew and shrank since the last one, and prunes snapshots older than 30 days", async () => {
    let answeredRun = "";
    seed((database) => {
      const first = posting(database, "Acme", "APPLYING");
      answeredRun = run(database, first, "paused-needs-input", [pause("Are you over 18?")]);
      pausedJob(database, "Globex", [pause("What is your expected graduation term?")]);
    });
    const first = await command([]);
    expect(first.code).toBe(0);
    expect(first.text).toContain("No earlier scoreboard snapshot to compare with.");
    const folder = join(dataDir(), "scoreboard");
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const files = readdirSync(folder);
    expect(files).toEqual([snapshotFileName(NOW)]);
    expect(statSync(join(folder, files[0]!)).mode & 0o777).toBe(0o600);

    seed((database) => {
      database.prepare("UPDATE browser_runs SET pauses_json = ? WHERE id = ?").run(JSON.stringify([pause("Are you over 18?", { status: "answered", answer: "Yes" })]), answeredRun);
      pausedJob(database, "Initech", [pause("What is your expected graduation term?")]);
    });
    const second = await command([], later(1));
    expect(second.code).toBe(0);
    const over18 = blockerId("question|are you over 18");
    const term = blockerId("question|what is your expected graduation term");
    const noQuestion = blockerId(`stop|${normalizeAnswerText("greenhouse: all questions answered; the run waits to be continued")}`);
    expect(second.text).toContain(`Since the last scoreboard (${NOW.toISOString()}): held 2 → 3; confirmed submissions (7 days) 0 → 0; `
      + `grew: [${noQuestion}] greenhouse: all questions answered; the run waits to be continued 0 → 1, [${term}] question: "what is your expected graduation term" 1 → 2; `
      + `shrank: [${over18}] question: "are you over 18" 1 → 0`);

    const oldSnapshot = (at: Date) => writeFileSync(join(folder, snapshotFileName(at)),
      JSON.stringify({ version: 1, at: at.toISOString(), days: 7, heldApplications: 0, confirmed: 0, blockers: [] }), { mode: 0o600 });
    const expired = new Date(later(2).getTime() - 31 * 24 * HOUR);
    const kept = new Date(later(2).getTime() - 29 * 24 * HOUR);
    oldSnapshot(expired);
    oldSnapshot(kept);
    writeFileSync(join(folder, snapshotFileName(later(1.5))), "{damaged", { mode: 0o600 });
    const third = await command([], later(2));
    expect(third.code).toBe(0);
    expect(third.text).toContain(`Since the last scoreboard (${later(1).toISOString()}): held 3 → 3`);
    const names = readdirSync(folder);
    expect(names).not.toContain(snapshotFileName(expired));
    expect(names).toContain(snapshotFileName(kept));
    expect(names).toContain(snapshotFileName(later(2)));
  });

  it("keeps at most the newest 200 snapshots as well as the 30-day window, since every pass saves one", () => {
    const folder = join(dataDir(), "scoreboard");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const minutes = (count: number) => new Date(NOW.getTime() - count * 60_000);
    // 250 snapshots five minutes apart (under a day), one 31 days old, and files that are not snapshots.
    for (let index = 0; index < 250; index += 1) writeFileSync(join(folder, snapshotFileName(minutes(index * 5 + 1))), "{}", { mode: 0o600 });
    const expired = new Date(NOW.getTime() - 31 * 24 * HOUR);
    writeFileSync(join(folder, snapshotFileName(expired)), "{}", { mode: 0o600 });
    writeFileSync(join(folder, "claims.json"), JSON.stringify({ version: 1, claims: [], history: [] }), { mode: 0o600 });
    writeFileSync(join(folder, "notes.txt"), "kept", { mode: 0o600 });

    const removed = pruneScoreboardSnapshots(dataDir(), NOW);
    expect(SNAPSHOT_RETENTION_COUNT).toBe(200);
    expect(removed).toHaveLength(51);
    expect(removed).toContain(snapshotFileName(expired));
    const names = readdirSync(folder);
    const kept = names.filter((name) => name.startsWith("snapshot-"));
    expect(kept).toHaveLength(200);
    expect(kept).toContain(snapshotFileName(minutes(1)));
    expect(kept).toContain(snapshotFileName(minutes(199 * 5 + 1)));
    expect(kept).not.toContain(snapshotFileName(minutes(200 * 5 + 1)));
    expect(names).toContain("claims.json");
    expect(names).toContain("notes.txt");

    // The pass's refresh writes one more and keeps the bound.
    const database = openSeed();
    try {
      const { board, saveError } = refreshScoreboardSnapshot({ database, dataDir: dataDir(), now: NOW });
      expect(saveError).toBeNull();
      expect(passBoardLine(board, saveError)).toBe("Board: 0 applications held; no blockers (snapshot saved)");
    } finally {
      database.close();
    }
    const after = readdirSync(folder).filter((name) => name.startsWith("snapshot-"));
    expect(after).toHaveLength(200);
    expect(after).toContain(snapshotFileName(NOW));
    expect(after).not.toContain(snapshotFileName(minutes(199 * 5 + 1)));
  });

  it("claims, renews, refuses, releases with a reason, finishes, and takes over stale claims", async () => {
    seed((database) => {
      pausedJob(database, "Acme", [pause("Are you over 18?")]);
      pausedJob(database, "Globex", [pause("Unlabeled input control 2")]);
    });
    const initial = await board();
    const question = initial.blockers.find((blocker) => blocker.kind === "question")!.id;
    const fault = initial.blockers.find((blocker) => blocker.kind === "fault")!.id;
    const claimsPath = join(dataDir(), "scoreboard", "claims.json");

    const claimed = await command(["--claim", question, "--track", "Track 47"]);
    expect(claimed).toMatchObject({ code: 0, text: `Claimed ${question} for Track 47: question: "are you over 18"` });
    expect(statSync(claimsPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir(), "scoreboard"))).toBe(true);
    expect(readdirSync(join(dataDir(), "scoreboard")).filter((name) => name.startsWith("snapshot-"))).toEqual([]);
    const shown = await board([], later(3));
    expect(shown.blockers.find((blocker) => blocker.id === question)!.claim).toMatchObject({ track: "Track 47", ageHours: 3, stale: false });
    expect((await command(["--no-save"], later(3))).text).toContain(`"are you over 18" — 1 application, 1 held only by this (Acme); claimed by Track 47, 3h ago`);

    const file = readFileSync(claimsPath, "utf8");
    expect(await command(["--claim", "b0000000000", "--track", "Track 47"])).toMatchObject({ code: 1, text: "No blocker b0000000000 on the current board." });
    expect((await command(["--claim", question, "--track", "Track 48"], later(1))).code).toBe(1);
    expect(readFileSync(claimsPath, "utf8")).toBe(file);
    expect(await command(["--claim", question, "--track", "Track 47"], later(4))).toMatchObject({ code: 0, text: `Renewed ${question} for Track 47: question: "are you over 18"` });
    expect((await board([], later(4))).blockers.find((blocker) => blocker.id === question)!.claim!.ageHours).toBe(0);
    const second = await command(["--claim", fault, "--track", "Track 47"], later(4));
    expect(second.code).toBe(1);
    expect(second.text).toContain(`Track 47 already holds ${question}`);

    expect((await command(["--release", question])).code).toBe(2);
    expect((await command(["--release", question, "--reason", "Fixed by the Track 47 merge."], later(5))).code).toBe(0);
    const released = await board([], later(5));
    expect(released.blockers.every((blocker) => blocker.claim === null)).toBe(true);
    expect(released.claims.recent).toEqual([expect.objectContaining({ id: question, track: "Track 47", event: "released", reason: "Fixed by the Track 47 merge." })]);
    expect((await command(["--no-save"], later(5))).text).toContain(`${question} Track 47 released: Fixed by the Track 47 merge.`);
    expect((await command(["--release", question, "--reason", "again"], later(5))).code).toBe(1);

    expect((await command(["--claim", fault, "--track", "Track 47"], later(6))).code).toBe(0);
    expect((await command(["--done", fault], later(7))).code).toBe(0);
    expect((await board([], later(7))).claims.recent[0]).toMatchObject({ id: fault, event: "done", track: "Track 47" });

    expect((await command(["--claim", question, "--track", "Track 49"], later(8))).code).toBe(0);
    const stale = await board([], later(33));
    expect(stale.blockers.find((blocker) => blocker.id === question)!.claim).toMatchObject({ track: "Track 49", stale: true, ageHours: 25 });
    expect((await command(["--no-save"], later(33))).text).toContain("claimed by Track 49, 25h ago (stale)");
    const takeover = await command(["--claim", question, "--track", "Track 50"], later(33));
    expect(takeover).toMatchObject({ code: 0, text: `Took over stale claim from Track 49: claimed ${question} for Track 50: question: "are you over 18"` });
    const after = await board([], later(33));
    expect(after.blockers.find((blocker) => blocker.id === question)!.claim).toMatchObject({ track: "Track 50", stale: false });
    expect(after.claims.recent[0]).toMatchObject({ id: question, track: "Track 49", event: "expired" });
  });

  it("keeps blocker ids stable across input order and unrelated blockers, and distinct for different causes", () => {
    const build = (name: string, labels: string[]) => {
      const database = createDatabase(join(directory, `${name}.sqlite`));
      try {
        for (const label of labels) pausedJob(database, `${label.slice(0, 5)} Co`, [pause(label)]);
        return buildScoreboard({ database, dataDir: join(directory, name), now: NOW, days: 7 });
      } finally {
        database.close();
      }
    };
    const one = build("one", ["Are you over 18?", "Will you relocate?"]);
    const two = build("two", ["Will you relocate?", "Do you need sponsorship?", "Are you over 18?"]);
    const ids = (result: Scoreboard) => new Map(result.blockers.map((blocker) => [blocker.label, blocker.id]));
    for (const [label, id] of ids(one)) {
      expect(id).toMatch(/^b[0-9a-f]{10}$/);
      expect(ids(two).get(label)).toBe(id);
    }
    expect(new Set(two.blockers.map((blocker) => blocker.id)).size).toBe(3);
    expect(blockerId("question|will you relocate")).not.toBe(blockerId("question|are you over 18"));
    expect(blockerId("question|will you relocate")).not.toBe(blockerId("fault|will you relocate"));
  });

  it("rejects bad arguments with the usage and exit code 2", async () => {
    seed(() => undefined);
    for (const args of [["--days", "0"], ["--days", "91"], ["--days", "7.5"], ["--bogus"], ["--claim", "b0123456789", "--track", "T", "--done", "b0123456789"],
      ["--track", "Track 1"], ["--reason", "x"], ["--claim", "b0123456789"], ["--profile"], ["--profile", "staging"]]) {
      const result = await command(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.lines.at(-1)).toMatch(/^Usage: pnpm pipeline:scoreboard/);
    }
    expect((await command(["--", "--days", "3", "--no-save"])).code).toBe(0);
  });
});

describe("candidate-entered values", () => {
  const VALUES = ["Zephyrine", "Quillfeather", "Ottoline", "Vantablack", "Brightwater", "Lumen Labs", "Marigold Telescope", "non_binary", "non binary"];
  const WITHHELD = "(label withheld: it contains a saved candidate value)";

  function seedValues(database: DatabaseSync): void {
    candidate(database);
    database.prepare("UPDATE candidates SET full_name = ?, school = ?, high_school_name = ? WHERE id = ?")
      .run("Ottoline Vantablack", "Quillfeather Institute", "Zephyrine Ridge High School", LOCAL_CANDIDATE_ID);
    const entryId = randomUUID();
    database.prepare("INSERT INTO resume_entries (id, candidate_id, section, position, created_at) VALUES (?, ?, 'experience', 0, ?)")
      .run(entryId, LOCAL_CANDIDATE_ID, NOW.toISOString());
    database.prepare(`INSERT INTO resume_entry_revisions (id, entry_id, title, role, location, bullets_json, source_json, review_status, approved_at, created_at)
      VALUES (?, ?, ?, 'Software Intern', 'Remote', '[]', '{}', 'APPROVED', ?, ?)`)
      .run(randomUUID(), entryId, "Brightwater Lumen Labs", NOW.toISOString(), NOW.toISOString());
    fact(database, "how_heard", { kind: "global" }, "Marigold Telescope Society");
    fact(database, "eeo_gender", { kind: "global" }, "non_binary");
  }

  const expectAbsent = (text: string, where: string) => {
    for (const value of VALUES) expect(text.toLowerCase(), `${value} in ${where}`).not.toContain(value.toLowerCase());
  };

  it("never prints Workday history entries, profile, resume, fact, or sensitive values, and groups history pauses by section and field", async () => {
    seed((database) => {
      seedValues(database);
      const workday = { atsKind: "workday" as const };
      pausedJob(database, "Acme", [
        pause("history:education:Zephyrine Ridge High School:degree", { fieldId: "My Experience::history:education:Zephyrine Ridge High School:degree" }),
        pause("history:work:Brightwater Lumen Labs:title", { fieldId: "history:work:Brightwater Lumen Labs:title" })
      ], workday);
      pausedJob(database, "Globex", [
        pause("history:education:Quillfeather Institute:degree", { fieldId: "history:education:Quillfeather Institute:degree" })
      ], workday);
      pausedJob(database, "Initech", [pause("Did you attend Quillfeather Institute?"), pause("Were you referred by the Marigold Telescope Society?")]);
      pausedJob(database, "Umbrella", [pause("Female", { sensitive: true })]);
      const stopped = posting(database, "Stop Co", "APPLYING");
      run(database, stopped, "paused-needs-input", [pause("Earlier question", { status: "answered", answer: "Yes" })]);
      event(database, stopped, "READY_FOR_REVIEW", "APPLYING",
        "Automatic browser run needs you: the form rejected the name Ottoline Vantablack as too long.", "2026-11-25T11:00:00.000Z");
    });
    const first = await board();
    const second = await board();
    const json = JSON.stringify(first);
    const text = (await command(["--no-save"])).text;
    expectAbsent(json, "JSON");
    expectAbsent(text, "text");

    const degree = first.blockers.find((blocker) => blocker.label === 'question: "education history entry: degree"')!;
    expect(degree).toMatchObject({ applications: 2, companies: ["Acme", "Globex"], category: "needs-candidate" });
    expect(first.blockers.some((blocker) => blocker.label === 'question: "work history entry: title"')).toBe(true);
    expect(first.blockers.some((blocker) => blocker.label === 'question: "a sensitive or self-identification question"')).toBe(true);
    const withheld = first.blockers.filter((blocker) => blocker.label === `question: ${WITHHELD}`);
    expect(withheld).toHaveLength(2);
    expect(withheld.map((blocker) => blocker.id).sort()).toEqual(second.blockers.filter((blocker) => blocker.label === `question: ${WITHHELD}`)
      .map((blocker) => blocker.id).sort());
    expect(first.blockers.find((blocker) => blocker.kind === "stop")!.label).toBe(`greenhouse: ${WITHHELD}`);

    const saved = await command([]);
    expect(saved.code).toBe(0);
    expectAbsent(readFileSync(join(dataDir(), "scoreboard", snapshotFileName(NOW)), "utf8"), "snapshot");
    const claim = await command(["--claim", degree.id, "--track", "Track 60"], later(1));
    expect(claim.code).toBe(0);
    expectAbsent(claim.text, "claim message");
    expectAbsent(readFileSync(join(dataDir(), "scoreboard", "claims.json"), "utf8"), "claims.json");
  });

  it("withholds a value held in an older snapshot's label from the changes", async () => {
    seed((database) => {
      seedValues(database);
      pausedJob(database, "Acme", [pause("Will you relocate?")]);
    });
    const folder = join(dataDir(), "scoreboard");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const previousAt = later(-1);
    writeFileSync(join(folder, snapshotFileName(previousAt)), JSON.stringify({
      version: 1, at: previousAt.toISOString(), days: 7, heldApplications: 1, confirmed: 0,
      blockers: [{ id: "b0123456789", label: 'question: "history:education:Zephyrine Ridge High School:degree"', category: "needs-candidate", applications: 1 }]
    }), { mode: 0o600 });
    const text = (await command(["--no-save"])).text;
    expectAbsent(text, "text");
    expect(text).toContain(`shrank: [b0123456789] ${WITHHELD} 1 → 0`);
    const json = await board();
    expect(json.changes!.shrank).toEqual([{ id: "b0123456789", label: WITHHELD, before: 1, after: 0 }]);
    expectAbsent(JSON.stringify(json.changes), "changes");
  });

  it("keeps digits in question labels and the period after a link", async () => {
    seed((database) => {
      pausedJob(database, "Acme", [pause("Are you 18 or older?")]);
      pausedJob(database, "Globex", [pause("Are you 21 or older?")]);
    });
    const result = await board();
    expect(result.blockers.map((blocker) => blocker.label).sort()).toEqual(['question: "are you 18 or older"', 'question: "are you 21 or older"']);
    expect(new Set(result.blockers.map((blocker) => blocker.id)).size).toBe(2);
    expect(normalizeStopReason("Automatic browser run needs you: No application form was found at https://jobs.example.test/job/1. It may sit behind an Apply button").label)
      .toBe("No application form was found at <site>");
  });
});
