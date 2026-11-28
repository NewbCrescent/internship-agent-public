import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyzeSemanticFit,
  approveApplication,
  cancelBrowserRun,
  confirmRunAts,
  continueBrowserRun,
  evaluateAndPersistMatch,
  getApplicationPackage,
  prepareApplication,
  startBrowserRun,
  type VoiceDrafter
} from "@internship-agent/agent";
import { RACE_ONLY_DECLINE_REASON, type BrowserPage, type RawControl } from "@internship-agent/browser";
import {
  createDatabase,
  getBrowserRun,
  getCurrentFact,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  revokeCandidateFact,
  saveCandidateFact,
  seedDevelopmentData,
  updateBrowserRun,
  type SaveCandidateFactInput
} from "@internship-agent/db";
import { autoSubmitBlockers, type BrowserField, type BrowserRun, type FactScope } from "@internship-agent/domain";

import type { ModelProvider, StructuredRequest } from "../../packages/agent/src/model/provider";

/**
 * Saved voluntary self-identification answers through real runs. The fixture
 * "candidate" uses neutral test values (female, asian, protected veteran, has
 * a disability); they are not anyone's real answers.
 */
const temporaryDirectories: string[] = [];
const GREENHOUSE_URL = "https://boards.greenhouse.io/example/jobs/1";

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-self-id-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-self-id-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** In-memory stand-in for a page: records fills, never touches a browser. */
function fakePage(controls: RawControl[], url = GREENHOUSE_URL): BrowserPage & { filled: Map<string, string> } {
  const filled = new Map<string, string>();
  return {
    filled,
    url: () => url,
    title: async () => "Example",
    collectControls: async () => controls,
    bodyText: async () => "Apply for this job",
    fillField: async (field: BrowserField, value: string) => { filled.set(field.id, value); },
    chooseOption: async (field: BrowserField, option: string) => { filled.set(field.id, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { filled.set(field.id, String(checked)); },
    uploadFile: async () => {},
    clickSubmit: async () => {},
    screenshot: async () => {},
    close: async () => {}
  };
}

function saveFact(database: DatabaseSync, key: SaveCandidateFactInput["key"], scope: FactScope, value: boolean | string) {
  return saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "profile", question: "Seeded for tests." },
    confidence: 1,
    rememberedAt: "2026-11-19T12:00:00.000Z"
  });
}

function saveFixtureSelfIdentification(database: DatabaseSync) {
  saveFact(database, "eeo_gender", { kind: "global" }, "female");
  saveFact(database, "eeo_race_ethnicity", { kind: "global" }, "asian");
  saveFact(database, "eeo_veteran_status", { kind: "global" }, "protected_veteran");
  saveFact(database, "eeo_disability_status", { kind: "global" }, "has_disability");
}

/** An approved package for the seeded posting; `beforePrepare` saves facts before the package is written. */
function approvedJobId(database: DatabaseSync, beforePrepare: (database: DatabaseSync) => void = () => {}): string {
  seedDevelopmentData(database);
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2030-01-15");
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    owner: "example",
    name: "evidence-demo",
    url: "https://github.com/example/evidence-demo",
    defaultBranch: "main",
    description: "Fixture evidence.",
    observedHeadSha: "sha-fixture"
  });
  const sha = "sha-fixture";
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    repositoryId: repository.id,
    name: "evidence-demo",
    summary: "Fixture project.",
    fullSnapshot: true,
    affectedPaths: ["README.md"],
    claims: [{
      kind: "technology",
      normalizedKey: "python",
      text: "Shipped Python services in production.",
      evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme",
        commitSha: sha,
        path: "README.md",
        startLine: 2,
        endLine: 2,
        sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L2`,
        excerpt: "Python services in production.",
        excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0].claims[0];
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);
  beforePrepare(database);
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  prepareApplication(row.id, { database });
  approveApplication(row.id, { database });
  return row.id;
}

const GENDER: RawControl = { tag: "select", id: "gender", label: "Gender", required: false, options: ["Male", "Female", "Decline To Self Identify"] };
const HISPANIC: RawControl = { tag: "select", id: "hispanic", label: "Are you Hispanic/Latino?", required: false, options: ["Yes", "No", "Decline To Self Identify"] };
const RACE: RawControl = {
  tag: "select", id: "race", label: "Race", required: false,
  options: ["American Indian or Alaskan Native", "Asian", "Black or African American", "White", "Two or More Races", "Decline To Self Identify"]
};
const PROTECTED_OPTION = "I identify as one or more of the classifications of protected veteran";
const VETERAN: RawControl = {
  tag: "select", id: "veteran", label: "Veteran Status", required: false,
  options: ["I am not a protected veteran", PROTECTED_OPTION, "I don't wish to answer"]
};
const HAS_DISABILITY_OPTION = "Yes, I have a disability (or previously had a disability)";
const DISABILITY: RawControl = {
  tag: "select", id: "disability", label: "Disability Status", required: false,
  options: [HAS_DISABILITY_OPTION, "No, I do not have a disability", "I do not want to answer"]
};
const START: RawControl = { tag: "input", type: "text", id: "start", label: "What is your available start date?", required: true };
const SUBMIT: RawControl = { tag: "button", label: "Submit application" };
const EEO_CONTROLS: RawControl[] = [GENDER, HISPANIC, RACE, VETERAN, DISABILITY, START, SUBMIT];

async function runWith(database: DatabaseSync, jobId: string, controls: RawControl[], voiceDrafter?: VoiceDrafter) {
  const dataDir = disposableDataDir();
  const page = fakePage(controls);
  const started = await startBrowserRun(jobId, GREENHOUSE_URL, {
    database, dataDir, openPage: async () => page, ...(voiceDrafter ? { voiceDrafter } : {})
  });
  let run: BrowserRun = started.run;
  if (!run.atsConfirmed) {
    confirmRunAts(run.id, "greenhouse", { database });
    run = getBrowserRun(database, run.id)!;
  }
  return { run, page };
}

const decision = (run: BrowserRun, fieldId: string) => run.decisions.find((entry) => entry.fieldId === fieldId);

describe("saved voluntary self-identification answers in browser runs", () => {
  it("fills EEO questions from the saved answers, and the filled run is clean for auto-submit", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, saveFixtureSelfIdentification);
    const { run, page } = await runWith(database, jobId, EEO_CONTROLS);

    expect(run.status).toBe("awaiting-approval");
    expect(run.pauses).toEqual([]);
    expect(page.filled.get("gender")).toBe("Female");
    expect(page.filled.get("hispanic")).toBe("No");
    expect(page.filled.get("race")).toBe("Asian");
    expect(page.filled.get("veteran")).toBe(PROTECTED_OPTION);
    expect(page.filled.get("disability")).toBe(HAS_DISABILITY_OPTION);
    expect(page.filled.get("start")).toBe("01/15/2030");
    expect(decision(run, "gender")).toMatchObject({ action: "choose", basis: { kind: "fact", key: "eeo_gender" } });
    for (const entry of run.decisions) {
      for (const option of ["Female", "Asian", PROTECTED_OPTION, HAS_DISABILITY_OPTION]) expect(entry.reason).not.toContain(option);
    }
    expect(autoSubmitBlockers(run)).toEqual([]);
    database.close();
  });

  it("fills Greenhouse's \"How would you describe your …? (mark all that apply)\" lists from the saved answers, recording none of them", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => {
      saveFact(db, "eeo_gender", { kind: "global" }, "female");
      saveFact(db, "eeo_race_ethnicity", { kind: "global" }, "white");
    });
    const decline = ["I prefer to self-describe", "I don't wish to answer"];
    const controls: RawControl[] = [
      { tag: "select", id: "gender-identity", label: "How would you describe your gender identity? (mark all that apply)", required: false, options: ["Man", "Non-binary", "Woman", ...decline] },
      {
        tag: "select", id: "racial-background", label: "How would you describe your racial/ethnic background? (mark all that apply)", required: false,
        options: ["Black or of African descent", "East Asian", "Hispanic, Latinx or of Spanish Origin", "South Asian", "White or European", ...decline]
      },
      START,
      SUBMIT
    ];
    const { run, page } = await runWith(database, jobId, controls);

    expect(run.status).toBe("awaiting-approval");
    expect(run.pauses).toEqual([]);
    expect(page.filled.get("gender-identity")).toBe("Woman");
    expect(page.filled.get("racial-background")).toBe("White or European");
    expect(decision(run, "gender-identity")).toMatchObject({ action: "choose", basis: { kind: "fact", key: "eeo_gender" } });
    expect(decision(run, "racial-background")).toMatchObject({ action: "choose", basis: { kind: "fact", key: "eeo_race_ethnicity" } });
    for (const entry of run.decisions) {
      for (const option of ["Woman", "White or European"]) expect(entry.reason).not.toContain(option);
    }
    const events = (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>)
      .map((row) => row.detail ?? "");
    for (const text of events) {
      expect(text).not.toContain("eeo_");
      expect(text.toLowerCase()).not.toContain("female");
      expect(text).not.toContain("White or European");
    }
    database.close();
  });

  it("pauses an EEO question whose saved answer was revoked", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, saveFixtureSelfIdentification);
    const saved = getCurrentFact(database, LOCAL_CANDIDATE_ID, "eeo_disability_status", { kind: "global" })!;
    expect(revokeCandidateFact(database, LOCAL_CANDIDATE_ID, saved.id)).toBe(true);
    const { run, page } = await runWith(database, jobId, EEO_CONTROLS);

    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses).toEqual([expect.objectContaining({ fieldId: "disability", sensitive: true })]);
    expect(page.filled.has("disability")).toBe(false);
    expect(page.filled.get("gender")).toBe("Female");
    expect(autoSubmitBlockers(run)).not.toEqual([]);
    database.close();
  });

  it("never uses the saved answers for gender questions that are not voluntary self-identification", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, saveFixtureSelfIdentification);
    const controls: RawControl[] = [
      { tag: "select", id: "pronouns", label: "Gender pronouns", required: false, options: ["He/him", "She/her", "Decline to answer"] },
      { tag: "textarea", id: "identity", label: "Describe your gender identity", required: false },
      { tag: "select", id: "plain", label: "Gender", required: false, options: ["Male", "Female"] },
      START,
      SUBMIT
    ];
    const { run, page } = await runWith(database, jobId, controls);

    for (const fieldId of ["pronouns", "identity", "plain"]) {
      expect(decision(run, fieldId), fieldId).toMatchObject({ action: "pause" });
      expect(run.pauses.find((pause) => pause.fieldId === fieldId), fieldId).toMatchObject({ sensitive: true });
      expect(page.filled.has(fieldId), fieldId).toBe(false);
    }
    database.close();
  });

  it("never sends the saved answers to the voice drafter, the AI fit model, logs, events, or the package", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    const database = disposableDatabase();
    const jobId = approvedJobId(database, saveFixtureSelfIdentification);
    const drafts: string[] = [];
    const draftContext: string[] = [];
    const drafter: VoiceDrafter = async (request) => {
      drafts.push(JSON.stringify(request));
      const { postingText: _postingText, ...rest } = request;
      draftContext.push(JSON.stringify(rest));
      return { status: "filled", text: "A drafted answer.", gate: { passed: true, averagePercentile: 40, targetAverage: 65, detectors: {}, revisions: 0 } };
    };
    const { run } = await runWith(database, jobId, [...EEO_CONTROLS.slice(0, -1),
      { tag: "textarea", id: "why", label: "Why do you want to work here?", required: true }, SUBMIT], drafter);
    expect(decision(run, "why")).toMatchObject({ action: "fill", basis: { kind: "voice_draft" } });
    expect(drafts.length).toBeGreaterThan(0);

    const modelInputs: string[] = [];
    const modelContext: string[] = [];
    const provider: ModelProvider = {
      available: true,
      async complete<T>(request: StructuredRequest<T>): Promise<never> {
        modelInputs.push(request.input);
        const parsed = JSON.parse(request.input) as Record<string, unknown>;
        delete parsed.postingText;
        delete parsed.posting;
        modelContext.push(JSON.stringify(parsed));
        throw new Error("fixture provider records its input only");
      }
    } as ModelProvider;
    try {
      await analyzeSemanticFit(jobId, { database, provider, force: true });
    } catch {
      // The test needs only the recorded input.
    }
    expect(modelInputs.length).toBeGreaterThan(0);

    const events = (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>)
      .map((row) => row.detail ?? "");
    const pkg = JSON.stringify(getApplicationPackage(jobId, database));
    for (const text of [...drafts, ...modelInputs, ...logged, ...events, pkg]) {
      for (const marker of ["protected_veteran", "has_disability", "eeo_"]) expect(text).not.toContain(marker);
    }
    for (const text of [...draftContext, ...modelContext]) {
      expect(text.toLowerCase()).not.toContain("female");
      expect(text.toLowerCase()).not.toContain("asian");
    }
    database.close();
  });

  it("answers Yes for previous employment only at Vandelay and No at another company", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => {
      saveFact(db, "previously_worked_here", { kind: "global" }, false);
      saveFact(db, "previously_worked_here", { kind: "company", name: "Vandelay" }, true);
    });
    database.prepare("UPDATE jobs SET company_name = 'Vandelay' WHERE id = ?").run(jobId);
    const vandelay = await runWith(database, jobId, [
      { tag: "input", type: "radio", id: "prev", label: "Have you previously worked for Vandelay?", required: true, options: ["Yes", "No"] }, START, SUBMIT
    ]);
    expect(decision(vandelay.run, "prev")).toMatchObject({ action: "choose", value: "Yes", basis: { kind: "fact", scope: "company:vandelay" } });

    cancelBrowserRun(vandelay.run.id, database);
    database.prepare("UPDATE jobs SET company_name = 'Acme Robotics' WHERE id = ?").run(jobId);
    const acme = await runWith(database, jobId, [
      { tag: "input", type: "radio", id: "prev", label: "Have you previously worked here?", required: true, options: ["Yes", "No"] }, START, SUBMIT
    ]);
    expect(decision(acme.run, "prev")).toMatchObject({ action: "choose", value: "No", basis: { kind: "fact", scope: "global" } });
    database.close();
  });

  it("holds relocation for a posting outside the US and answers it inside the US", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => saveFact(db, "willing_to_relocate", { kind: "country", code: "US" }, true));
    const relocate: RawControl = { tag: "input", type: "radio", id: "relocate", label: "Are you willing to relocate?", required: true, options: ["Yes", "No"] };
    const locations = (database.prepare("SELECT COUNT(*) AS count FROM job_locations WHERE job_id = ?").get(jobId) as { count: number }).count;
    expect(locations).toBeGreaterThan(0);

    database.prepare("UPDATE job_locations SET country_code = 'CA' WHERE job_id = ?").run(jobId);
    const abroad = await runWith(database, jobId, [relocate, START, SUBMIT]);
    expect(abroad.run.status).toBe("paused-needs-input");
    expect(abroad.run.pauses).toEqual([expect.objectContaining({ fieldId: "relocate", suggestedKey: "willing_to_relocate", suggestedScope: "country:CA" })]);

    cancelBrowserRun(abroad.run.id, database);
    database.prepare("UPDATE job_locations SET country_code = 'US' WHERE job_id = ?").run(jobId);
    const home = await runWith(database, jobId, [relocate, START, SUBMIT]);
    expect(decision(home.run, "relocate")).toMatchObject({ action: "choose", value: "Yes", basis: { kind: "fact", scope: "country:US" } });
    database.close();
  });

  it("writes the saved how-heard answer as text and picks LinkedIn when it is not offered", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => saveFact(db, "how_heard", { kind: "global" }, "Online job board"));
    const { run } = await runWith(database, jobId, [
      { tag: "input", type: "text", id: "heard-text", label: "How did you hear about this job?", required: true },
      { tag: "select", id: "heard-select", label: "How did you hear about us?", required: true, options: ["Employee Referral", "LinkedIn", "Indeed"] },
      START,
      SUBMIT
    ]);
    expect(decision(run, "heard-text")).toMatchObject({ action: "fill", value: "Online job board", basis: { kind: "fact", key: "how_heard" } });
    expect(decision(run, "heard-select")).toMatchObject({ action: "choose", value: "LinkedIn", basis: { kind: "fact", key: "how_heard" } });
    database.close();
  });

  it("an unrecognized site's lists take saved and standard answers and are no longer held for their site (Track 80)", async () => {
    // Synthetic Eightfold-shaped form (Track 35): its ARIA lists read as plain lists by the collector. Fictional answers.
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => {
      saveFact(db, "eeo_gender", { kind: "global" }, "female");
      saveFact(db, "pronouns", { kind: "global" }, "they/them");
      saveFact(db, "previously_worked_here", { kind: "global" }, false);
      saveFact(db, "how_heard", { kind: "global" }, "Job Board");
    });
    database.prepare("UPDATE jobs SET company_name = 'Fixture Aero' WHERE id = ?").run(jobId);
    database.prepare("UPDATE candidates SET legal_first_name = 'Avery', legal_last_name = 'Fixture' WHERE id = ?").run(LOCAL_CANDIDATE_ID);
    const url = "https://careers.fixtureaero.example/careers/apply?pid=1001";
    const yesNo = ["Yes", "No"];
    const controls: RawControl[] = [
      { tag: "input", type: "text", id: "first", label: "First name", required: true },
      { tag: "input", type: "text", id: "last", label: "Last name", required: true },
      { tag: "input", type: "email", id: "email", label: "Email", required: true },
      { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
      { tag: "select", id: "input-7", label: "Are you legally authorized to work in the country of the job for which you are applying?", required: true, options: yesNo },
      { tag: "select", id: "input-11", label: "Will you require sponsorship for an employment Visa?", required: true, options: yesNo },
      { tag: "select", id: "input-15", label: "Have you ever worked for Fixture Aero - either as a direct employee or as a contractor?", required: true, options: yesNo },
      { tag: "select", id: "input-19", label: "Preferred Pronoun", options: ["He/Him/His", "She/Her/Hers", "They/Them/Theirs", "Prefer not to say"] },
      { tag: "select", id: "input-23", label: "Sex", options: ["Male", "Female", "I do not wish to self-identify"] },
      { tag: "select", id: "input-27", label: "How did you hear about this position?", options: ["Job Board", "LinkedIn", "Employee Referral", "Company Website"] },
      { tag: "select", id: "input-31", label: "Are you 16 years or older?", required: true, options: yesNo },
      { tag: "input", type: "text", id: "notifiedEmail", placeholder: "Please enter your email address" },
      SUBMIT
    ];
    const page = fakePage(controls, url);
    const started = await startBrowserRun(jobId, url, {
      database, dataDir: disposableDataDir(), openPage: async () => page, voiceDrafter: null, renderPdf: async () => ({ pages: 1 })
    });
    const run = getBrowserRun(database, started.run.id)!;
    expect(page.filled.get("input-7")).toBe("Yes");
    expect(page.filled.get("input-11")).toBe("No");
    expect(page.filled.get("input-15")).toBe("No");
    expect(page.filled.get("input-19")).toBe("They/Them/Theirs");
    expect(page.filled.get("input-23")).toBe("Female");
    expect(page.filled.get("input-27")).toBe("Job Board");
    expect(page.filled.has("notifiedEmail")).toBe(false);
    expect(decision(run, "notifiedEmail")).toMatchObject({ action: "skip", value: null });
    expect(run.pauses.filter((pause) => pause.status === "open")).toEqual([
      expect.objectContaining({ fieldId: "input-31", fieldKind: "select", options: yesNo })
    ]);
    expect(run.atsKind).toBe("unknown");
    expect(run.atsConfirmed).toBe(false);
    expect(autoSubmitBlockers(run).some((blocker) => /site type|recognized/i.test(blocker))).toBe(false);
    for (const entry of run.decisions) {
      expect(entry.reason).not.toContain("Female");
      expect(entry.reason).not.toContain("They/Them/Theirs");
    }
    database.close();
  });
});

describe("race-only self-identification lists in browser runs (the candidate's rule, 2026-11-26)", () => {
  // A synthetic copy of a Rippling race-only list; the saved answers are test values.
  const RACE_ONLY: RawControl = {
    tag: "select", id: "race-only", label: "Please identify your race", required: false,
    options: ["American Indian or Alaskan Native", "Asian", "Black or African American", "Middle Eastern or North African", "White",
      "Native Hawaiian or other Pacific Islander", "Two or more races", "Choose not to disclose"]
  };

  it("chooses the decline option for an answer the list does not offer, and nothing names the saved answer", async () => {
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => saveFact(db, "eeo_race_ethnicity", { kind: "global" }, "hispanic_or_latino"));
    const { run, page } = await runWith(database, jobId, [RACE_ONLY, START, SUBMIT]);

    expect(run.status).toBe("awaiting-approval");
    expect(run.pauses).toEqual([]);
    expect(page.filled.get("race-only")).toBe("Choose not to disclose");
    expect(decision(run, "race-only")).toMatchObject({
      action: "choose", value: "Choose not to disclose", reason: RACE_ONLY_DECLINE_REASON,
      basis: { kind: "fact", key: "eeo_race_ethnicity", scope: "global" }
    });
    expect(autoSubmitBlockers(run)).toEqual([]);
    const events = (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>)
      .map((row) => row.detail ?? "");
    for (const text of [...events, ...logged, JSON.stringify(run.decisions), JSON.stringify(run.pauses)]) {
      expect(text).not.toMatch(/hispanic|latin/i);
    }
    for (const text of events) expect(text).not.toContain("eeo_");
    database.close();
  });

  it("chooses the saved answer's own option when the list offers it", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => saveFact(db, "eeo_race_ethnicity", { kind: "global" }, "white"));
    const { run, page } = await runWith(database, jobId, [RACE_ONLY, START, SUBMIT]);

    expect(run.pauses).toEqual([]);
    expect(page.filled.get("race-only")).toBe("White");
    expect(decision(run, "race-only")).toMatchObject({ action: "choose", value: "White", basis: { kind: "fact", key: "eeo_race_ethnicity" } });
    expect(decision(run, "race-only")!.reason).not.toBe(RACE_ONLY_DECLINE_REASON);
    database.close();
  });
});

describe("continuing a held run plans its open pauses again (2026-11-24)", () => {
  const OFF = { acceptDataConsent: false, signAttestations: false };
  const DATA_ON = { acceptDataConsent: true, signAttestations: false };
  const BOTH_ON = { acceptDataConsent: true, signAttestations: true };
  const decline = ["I prefer to self-describe", "I don't wish to answer"];
  // Fictional option list in Greenhouse's "mark all that apply" shape.
  const RACIAL: RawControl = {
    tag: "select", id: "racial-background", label: "How would you describe your racial/ethnic background? (mark all that apply)", required: false,
    options: ["Black or of African descent", "East Asian", "Hispanic, Latinx or of Spanish Origin", "South Asian", "White or European", ...decline]
  };
  const TERMS_LABEL = "Terms of Use and Privacy Notice: I agree and consent";
  const TERMS_BOX: RawControl = { tag: "input", type: "checkbox", id: "terms", label: TERMS_LABEL, required: true };
  const AGE: RawControl = { tag: "select", id: "age", label: "Are you 18 years of age or older?", required: true, options: ["Yes", "No"] };

  async function startHeld(database: DatabaseSync, jobId: string, controls: RawControl[], standingConsent = OFF) {
    const page = fakePage(controls);
    const dataDir = disposableDataDir();
    const started = await startBrowserRun(jobId, GREENHOUSE_URL, { database, dataDir, openPage: async () => page, standingConsent, voiceDrafter: null });
    if (!started.run.atsConfirmed) confirmRunAts(started.run.id, "greenhouse", { database });
    return { run: getBrowserRun(database, started.run.id)!, dataDir };
  }
  const continueWith = (database: DatabaseSync, runId: string, dataDir: string, controls: RawControl[], standingConsent = OFF) => {
    const page = fakePage(controls);
    return continueBrowserRun(runId, { database, dataDir, openPage: async () => page, standingConsent }).then((report) => ({ ...report, page }));
  };
  const eventTexts = (database: DatabaseSync, jobId: string) =>
    (database.prepare("SELECT detail FROM application_events WHERE job_id = ?").all(jobId) as Array<{ detail: string | null }>).map((row) => row.detail ?? "");

  it("answers an EEO pause from a self-identification answer saved after the run paused, copying no option into the pause", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const controls = [RACIAL, START, SUBMIT];
    const { run, dataDir } = await startHeld(database, jobId, controls);
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses).toEqual([expect.objectContaining({ fieldId: "racial-background", sensitive: true, status: "open" })]);

    saveFact(database, "eeo_race_ethnicity", { kind: "global" }, "white");
    const continued = await continueWith(database, run.id, dataDir, controls);
    expect(continued.page.filled.get("racial-background")).toBe("White or European");
    expect(decision(continued.run, "racial-background")).toMatchObject({ action: "choose", value: "White or European", basis: { kind: "fact", key: "eeo_race_ethnicity" } });
    expect(continued.run.pauses).toEqual([expect.objectContaining({ fieldId: "racial-background", status: "answered", answer: null, sensitive: true })]);
    expect(continued.run.status).toBe("awaiting-approval");
    for (const text of eventTexts(database, jobId)) expect(text).not.toContain("White or European");
    database.close();
  });

  it("replaces a pause older code built (package prose, not sensitive) with today's sensitive pause", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const controls = [RACIAL, START, SUBMIT];
    const { run, dataDir } = await startHeld(database, jobId, controls);
    // The record a run started before the eeo role named "racial|ethnic" kept: package prose as the question, not sensitive.
    const stale = 'The verified package answers "How would you describe your racial/ethnic background? (mark all that apply)" with prose, which is a choice; the known answer "Relevant experience: fixture prose" is not one of its options.';
    updateBrowserRun(database, run.id, {
      decisions: run.decisions.map((entry) => entry.fieldId === "racial-background" ? { ...entry, reason: stale, pause: { question: stale, key: null, scope: null, safeguard: false } } : entry),
      pauses: run.pauses.map((entry) => entry.fieldId === "racial-background" ? { ...entry, question: stale, sensitive: false } : entry)
    });
    const continued = await continueWith(database, run.id, dataDir, controls);
    expect(continued.run.status).toBe("paused-needs-input");
    const pause = continued.run.pauses.find((entry) => entry.fieldId === "racial-background")!;
    expect(pause).toMatchObject({ status: "open", sensitive: true });
    expect(pause.question).not.toContain("Relevant experience");
    expect(decision(continued.run, "racial-background")!.reason).not.toContain("Relevant experience");
    database.close();
  });

  it("accepts a terms box under the standing setting turned on since the run paused, logging the exact statement once", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const controls = [TERMS_BOX, START, SUBMIT];
    const { run, dataDir } = await startHeld(database, jobId, controls, OFF);
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses.map((entry) => entry.fieldId)).toEqual(["terms"]);

    const continued = await continueWith(database, run.id, dataDir, controls, DATA_ON);
    expect(continued.page.filled.get("terms")).toBe("true");
    expect(decision(continued.run, "terms")).toMatchObject({
      action: "check", basis: { kind: "standing_consent", setting: "accept_data_consent", group: "terms-of-use", statement: TERMS_LABEL }
    });
    expect(continued.run.pauses).toEqual([expect.objectContaining({ fieldId: "terms", status: "answered", answer: "yes" })]);
    expect(continued.run.status).toBe("awaiting-approval");
    expect(eventTexts(database, jobId).filter((text) => text === `Accepted data consent: '${TERMS_LABEL}'`)).toHaveLength(1);
    database.close();
  });

  it("chooses a one-option arbitration acknowledgment under the standing settings turned on since the run paused, logging label and option once", async () => {
    const ACKNOWLEDGE = "I Acknowledge/Accept this Statement";
    const STATEMENT = `Arbitration Acknowledgment: ${ACKNOWLEDGE}`;
    const ARBITRATION: RawControl = { tag: "select", id: "arbitration", label: "Arbitration Acknowledgment:", required: true, options: [ACKNOWLEDGE] };
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const controls = [ARBITRATION, START, SUBMIT];
    const { run, dataDir } = await startHeld(database, jobId, controls, OFF);
    expect(run.status).toBe("paused-needs-input");
    expect(run.pauses.map((entry) => entry.fieldId)).toEqual(["arbitration"]);

    const continued = await continueWith(database, run.id, dataDir, controls, BOTH_ON);
    expect(continued.page.filled.get("arbitration")).toBe(ACKNOWLEDGE);
    expect(decision(continued.run, "arbitration")).toMatchObject({
      action: "choose", value: ACKNOWLEDGE, basis: { kind: "standing_consent", setting: "sign_attestations", group: "authorization", statement: STATEMENT }
    });
    expect(continued.run.pauses).toEqual([expect.objectContaining({ fieldId: "arbitration", status: "answered" })]);
    expect(continued.run.status).toBe("awaiting-approval");
    expect(eventTexts(database, jobId).filter((text) => text === `Accepted attestation: '${STATEMENT}'`)).toHaveLength(1);
    database.close();
  });

  it("marks a pause candidate memory now answers as answered, so it no longer holds the run", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database);
    const controls = [AGE, START, SUBMIT];
    const { run, dataDir } = await startHeld(database, jobId, controls);
    expect(run.pauses).toEqual([expect.objectContaining({ fieldId: "age", status: "open" })]);

    saveFact(database, "age_18_or_older", { kind: "global" }, true);
    const continued = await continueWith(database, run.id, dataDir, controls);
    expect(decision(continued.run, "age")).toMatchObject({ action: "choose", value: "Yes", reason: "Candidate memory now answers this pause." });
    expect(continued.run.pauses).toEqual([expect.objectContaining({ fieldId: "age", status: "answered", answer: "Yes" })]);
    expect(continued.run.status).toBe("awaiting-approval");
    database.close();
  });

  it("keeps a demographic field sensitive when the page will not take its saved option", async () => {
    const database = disposableDatabase();
    const jobId = approvedJobId(database, (db) => saveFact(db, "eeo_race_ethnicity", { kind: "global" }, "white"));
    const page = fakePage([RACIAL, START, SUBMIT]);
    page.chooseOption = async (field: BrowserField, option: string) => {
      if (field.id === "racial-background") throw new Error("fixture: the list did not accept the option");
      page.filled.set(field.id, option);
    };
    const started = await startBrowserRun(jobId, GREENHOUSE_URL, { database, dataDir: disposableDataDir(), openPage: async () => page, standingConsent: OFF, voiceDrafter: null });
    const pause = started.run.pauses.find((entry) => entry.fieldId === "racial-background")!;
    expect(pause).toMatchObject({ sensitive: true, status: "open" });
    expect(pause.question).toContain(RACIAL.label);
    expect(pause.question).not.toContain("White or European");
    database.close();
  });
});
