import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getJobPosting, LOCAL_CANDIDATE_ID, saveBrowserRun, saveCandidate, saveCandidateFact, type SaveCandidateFactInput } from "@internship-agent/db";
import type { BrowserRun, PauseRecord, QuestionContext } from "@internship-agent/domain";
import { recheckRunPauses, resolveCandidateQuestion, startBrowserRun } from "@internship-agent/agent";

import { approvedJobId, cleanupTemporaryDirectories, disposableWorkspace, fakePage } from "./application-record-fixture";

/**
 * Track 89 against disposable workspaces (2026-11-28): relocation questions whose summer term the saved availability
 * window covers, and held stops (a term list, an employment-based immigration sponsorship question, a GPA scale list)
 * that the saved answers or the profile now settle on a dry-run recheck. Fictional facts, places, and values only; no
 * browser, no network, no model.
 */

type Workspace = { database: DatabaseSync; dataDir: string; jobId: string };

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

function saveFact(database: DatabaseSync, input: Pick<SaveCandidateFactInput, "key" | "scope" | "value">) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, source: "user", sourceDetail: { kind: "profile" }, confidence: 1, rememberedAt: "2026-11-28T00:00:00.000Z", ...input
  });
}

/** A workspace whose posting is in Fixture City, U.S., with a fictional summer window and on-site and U.S.-wide relocation Yes answers. */
function workspace(): Workspace {
  const { database, dataDir } = disposableWorkspace();
  const jobId = approvedJobId(database);
  database.prepare("UPDATE job_locations SET city = 'Fixture City', country_code = 'US' WHERE job_id = ?").run(jobId);
  saveFact(database, { key: "available_start_date", scope: { kind: "global" }, value: "2031-05-20" });
  saveFact(database, { key: "available_end_date", scope: { kind: "global" }, value: "2031-08-20" });
  saveFact(database, { key: "work_arrangement", scope: { kind: "global" }, value: true });
  saveFact(database, { key: "willing_to_relocate", scope: { kind: "country", code: "US" }, value: true });
  saveFact(database, { key: "willing_to_relocate_at_own_expense", scope: { kind: "country", code: "US" }, value: true });
  return { database, dataDir, jobId };
}

const US: QuestionContext = { postingCountryCode: "US", companyName: "Fixture Co", postingPlaces: [{ city: "Fixture City", countryCode: "US" }], fieldKind: "radio" };
const SUMMER = "Can you relocate to Fixture City for the Summer internship (June-August)?";
const LONGER = "Can you relocate to Fixture City for the Summer internship (May-September)?";
const OWN_EXPENSE = "This program is based in Fixture City and relocation assistance will not be offered. Are you able to work on-site in Fixture City for the full duration of the internship program (Summer 2031)?";

describe("relocation questions whose term the saved window covers (Track 89)", () => {
  it("answers a covered summer relocation question and the own-expense question with its covered term", async () => {
    const ws = workspace();
    expect((await resolveCandidateQuestion(SUMMER, US, { database: ws.database })).status).toBe("RESOLVED");
    expect(await resolveCandidateQuestion(OWN_EXPENSE, { ...US, fieldKind: "select" }, { database: ws.database })).toMatchObject({ status: "RESOLVED", mapping: { key: "willing_to_relocate_at_own_expense" } });
    ws.database.close();
  });

  it("keeps a stated span outside the window open", async () => {
    const ws = workspace();
    expect((await resolveCandidateQuestion(LONGER, US, { database: ws.database })).status).toBe("NEEDS_INPUT");
    ws.database.close();
  });

  it("answers nothing from a window whose dates are not saved for automatic reuse", async () => {
    const ws = workspace();
    ws.database.prepare("UPDATE candidate_facts SET reuse_policy = 'confirm' WHERE key IN ('available_start_date', 'available_end_date')").run();
    expect((await resolveCandidateQuestion(SUMMER, US, { database: ws.database })).status).not.toBe("RESOLVED");
    ws.database.close();
  });
});

function questionPause(label: string, fieldId: string, overrides: Partial<PauseRecord> = {}): PauseRecord {
  return {
    fieldId, label, question: `How should "${label}" be answered?`, suggestedKey: null, suggestedScope: null,
    safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null,
    fieldKind: "select", options: ["Yes", "No"], ...overrides
  };
}

async function heldRun(ws: Workspace, pauses: PauseRecord[]): Promise<BrowserRun> {
  const report = await startBrowserRun(ws.jobId, "https://app.joinhandshake.com/apply/900001", {
    database: ws.database,
    dataDir: ws.dataDir,
    openPage: async () => fakePage({ controls: [{ tag: "select", id: "python", label: "Do you use Python? *", required: true, options: ["Yes", "No"] }, { tag: "button", label: "Submit application" }] }),
    voiceDrafter: null,
    pauseReviewer: null
  });
  const now = new Date().toISOString();
  return saveBrowserRun(ws.database, {
    ...report.run,
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

describe("a dry-run recheck of held Track 89 stops", () => {
  it("matches a term list, an immigration sponsorship question, and a GPA scale list, and leaves a term span outside the window", async () => {
    const ws = workspace();
    expect(getJobPosting(ws.database, ws.jobId)!.locations.some((location) => location.countryCode === "US")).toBe(true);
    saveCandidate(ws.database, LOCAL_CANDIDATE_ID, {
      fullName: "Jordan Rivera", preferredName: "Jordan", email: "jordan@example.test", school: "Example State University",
      degree: "B.S. Fixture Engineering", graduationDate: "2032-05-15", githubUrl: "https://github.com/example-candidate", gpa: "3.47"
    });
    const outside = "Which internship term are you applying for?";
    const held = await heldRun(ws, [
      questionPause("Which internship term are you interested in?", "term", { options: ["Spring 2031", "Summer 2031", "Both"] }),
      questionPause("Do you currently require, or will you in the future require, employment-based immigration sponsorship?", "sponsorship", { fieldKind: "radio" }),
      questionPause("Please select the corresponding GPA scale:", "scale", { options: ["0.0 - 4.0", "0.0 - 5.0", "UK Grading Scale"] }),
      questionPause(outside, "outside", { options: ["Winter/Spring (January - May 2031)", "Summer (May - September 2031)"] })
    ]);
    const before = ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all();
    const result = await recheckRunPauses(ws.database, held.id, { apply: false });
    expect(result.matches.map((match) => [match.fieldId, match.kind])).toEqual([["term", "saved_fact"], ["sponsorship", "saved_fact"], ["scale", "profile_field"]]);
    expect(result.left.map((entry) => entry.label)).toEqual([outside]);
    expect(ws.database.prepare("SELECT id, updated_at, pauses_json FROM browser_runs ORDER BY id").all()).toEqual(before);
    ws.database.close();
  });
});
