import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getFitInputVersion,
  getJobPosting,
  listApplicationEvents,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  persistNormalizedPosting,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveBrowserRun,
  saveBrowserSession,
  saveCandidateFact,
  saveSemanticFit,
  seedDevelopmentData,
  updateBrowserRun
} from "@internship-agent/db";
import type { ApplicationProfile, BrowserField, BrowserRun, FillDecision } from "@internship-agent/domain";
import type { BrowserPage, RawControl } from "@internship-agent/browser";
import {
  advancePipeline,
  approveApplication,
  approveRunSubmission,
  companyStanding,
  confirmRunAts,
  evaluateAndPersistMatch,
  pipelineSettings,
  prepareApplication,
  startBrowserRun,
  storeCandidateDocument,
  submitBrowserRun,
  UnavailableModelProvider,
  type PageFactory,
  type PipelineSettings
} from "@internship-agent/agent";

/**
 * Per-company limits in the automatic pipeline: the company cap (the agent's
 * submitted and in-flight applications per target term) and one graduation
 * profile per company. Disposable SQLite and data directories; no browser, no network.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-company-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-company-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

type FakePage = BrowserPage & { filled: Map<string, string>; uploads: Map<string, string> };

/** In-memory stand-in for a page: records fills, never touches a browser. */
function fakePage(overrides: { controls?: RawControl[]; submitted?: { clicked: boolean }; url?: string } = {}): FakePage {
  const filled = new Map<string, string>();
  const uploads = new Map<string, string>();
  let submitted = false;
  return {
    filled,
    uploads,
    url: () => overrides.url ?? "https://boards.greenhouse.io/example/jobs/2",
    title: async () => "Example",
    collectControls: async () => overrides.controls ?? [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "button", label: "Submit application" }
    ],
    bodyText: async () => (submitted ? "Thank you! Your application was received." : "Please fix the errors below."),
    fillField: async (field: BrowserField, value: string) => { filled.set(field.id, value); },
    chooseOption: async (field: BrowserField, option: string) => { filled.set(field.id, option); },
    setChecked: async (field: BrowserField, checked: boolean) => { filled.set(field.id, String(checked)); },
    uploadFile: async (field: BrowserField, path: string) => { uploads.set(field.id, path); },
    clickSubmit: async () => {
      submitted = true;
      if (overrides.submitted) overrides.submitted.clicked = true;
    },
    screenshot: async () => {},
    close: async () => {}
  };
}

const TRANSCRIPT_CONTROLS: RawControl[] = [
  { tag: "input", type: "text", id: "grad", label: "What is your expected graduation date?", required: true },
  { tag: "input", type: "file", id: "resume", label: "Resume", required: true },
  { tag: "input", type: "file", id: "transcript", label: "Unofficial transcript", required: true },
  { tag: "button", label: "Submit application" }
];
const NO_TRANSCRIPT_CONTROLS = TRANSCRIPT_CONTROLS.filter((control) => control.id !== "transcript");
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% fixture document\n%%EOF\n");
const WORKDAY_URL = "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R1";
const CAP_REASON = "Company cap: already 2 applications to Northstar Systems.";

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

/** The default (2028) and alternate-profile (2029) graduation answers. */
function graduationFacts(database: DatabaseSync) {
  for (const [scope, value] of [
    [{ kind: "global" }, "2028-05-15"],
    [{ kind: "application_channel", channel: "handshake_internal" }, "2029-05-15"]
  ] as const) {
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID, key: "graduation_date", scope, value, source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1,
      rememberedAt: "2026-09-22T12:00:00.000Z"
    });
  }
}

/** The seeded "Northstar Systems" posting, qualified on AI labels (or approved for a manual run). */
function seededJob(database: DatabaseSync, stopAt: "qualified" | "approved" = "qualified"): string {
  seedDevelopmentData(database);
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL'").run();
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  const repository = registerGitHubRepository(database, {
    candidateId: LOCAL_CANDIDATE_ID, owner: "example", name: "evidence-demo", url: "https://github.com/example/evidence-demo",
    defaultBranch: "main", description: "Fixture evidence.", observedHeadSha: "sha-fixture"
  });
  reconcileProjectEvidence(database, {
    candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id, name: "evidence-demo", summary: "Fixture project.",
    fullSnapshot: true, affectedPaths: ["README.md"],
    claims: [{
      kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.", evidenceFingerprint: "tech-v1",
      evidence: [{
        kind: "readme", commitSha: "sha-fixture", path: "README.md", startLine: 2, endLine: 2,
        sourceUrl: "https://github.com/example/evidence-demo/blob/sha-fixture/README.md#L2",
        excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1"
      }]
    }]
  });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0]!.claims[0]!;
  reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" });
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  if (stopAt === "approved") {
    prepareApplication(row.id, { database });
    approveApplication(row.id, { database });
  }
  return row.id;
}

function strongFit(database: DatabaseSync, jobId: string, score = 86) {
  saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
    score, rating: "STRONG", confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
    decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2
  });
}

/** An earlier posting with the given status (no match, so the pipeline never acts on it). */
function historyJob(database: DatabaseSync, input: {
  companyName: string; title?: string; status: string; sourceUrl: string;
  applicationType?: "HANDSHAKE_INTERNAL" | "EXTERNAL_ATS" | "UNKNOWN";
}): string {
  const title = input.title ?? "Software Engineering Intern";
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.companyName, title, employmentType: "INTERNSHIP", applicationType: input.applicationType ?? "UNKNOWN",
    sourceUrl: input.sourceUrl, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${input.sourceUrl}`, normalizedText: `${title}\nFixture posting for company history.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(input.status, jobId);
  return jobId;
}

function historyRun(database: DatabaseSync, jobId: string, input: {
  status: BrowserRun["status"]; applicationProfile?: ApplicationProfile; decisions?: FillDecision[];
  applicationUrl?: string; createdAt?: string;
}): BrowserRun {
  // One package per posting: a restarted run reuses it.
  const existing = database.prepare("SELECT id FROM application_packages WHERE job_id = ?").get(jobId) as { id: string } | undefined;
  const packageId = existing?.id ?? randomUUID();
  if (!existing) {
    database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
      .run(packageId, jobId, new Date().toISOString(), "{}");
  }
  const at = input.createdAt ?? "2026-11-01T00:00:00.000Z";
  return saveBrowserRun(database, {
    id: randomUUID(), jobId, applicationUrl: input.applicationUrl ?? "https://example.test/apply", status: input.status,
    packageId, variantId: null, baseResumeId: null, applicationProfile: input.applicationProfile, atsKind: "greenhouse",
    atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true, decisions: input.decisions ?? [], pauses: [],
    submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: at, updatedAt: at
  });
}

const AUTO_START = "Browser run started automatically from the verified package; your approval is required before submission.";
const CANDIDATE_START = "Browser run started from the approved package.";

/** A run started by the pipeline or the candidate: the start event browser-orchestrator logs, then the run. */
function startedRun(database: DatabaseSync, jobId: string, input: {
  by: "pipeline" | "candidate"; status: BrowserRun["status"]; applicationProfile?: ApplicationProfile; applicationUrl?: string;
}): BrowserRun {
  logApplicationEvent(database, {
    jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "APPLYING", detail: input.by === "pipeline" ? AUTO_START : CANDIDATE_START
  });
  return historyRun(database, jobId, {
    status: input.status, applicationProfile: input.applicationProfile, applicationUrl: input.applicationUrl,
    createdAt: new Date().toISOString()
  });
}

/** An earlier application the agent made: a pipeline-started run, submitted unless another status is given. */
function automaticApplication(database: DatabaseSync, input: {
  companyName: string; sourceUrl: string; title?: string; runStatus?: BrowserRun["status"];
}): { jobId: string; run: BrowserRun } {
  const status = input.runStatus ?? "submitted";
  const jobId = historyJob(database, {
    companyName: input.companyName, title: input.title, status: status === "submitted" ? "SUBMITTED" : "APPLYING", sourceUrl: input.sourceUrl
  });
  return { jobId, run: startedRun(database, jobId, { by: "pipeline", status, applicationUrl: input.sourceUrl }) };
}

/** The candidate's own applications at Northstar Systems: none of them uses a cap slot. */
function candidateApplications(database: DatabaseSync) {
  // A manual-checklist submission, recorded without a run.
  historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/checklist" });
  // A run the candidate started and submitted.
  const submitted = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/manual" });
  startedRun(database, submitted, { by: "candidate", status: "submitted" });
  // A run the candidate started that is still in flight.
  const open = historyJob(database, { companyName: "Northstar Systems", status: "APPLYING", sourceUrl: "https://example.test/history/manual-open" });
  startedRun(database, open, { by: "candidate", status: "awaiting-approval" });
  // A cancelled automatic run the candidate restarted.
  const restarted = historyJob(database, { companyName: "Northstar Systems", status: "APPLYING", sourceUrl: "https://example.test/history/restarted" });
  startedRun(database, restarted, { by: "pipeline", status: "cancelled" });
  logApplicationEvent(database, {
    jobId: restarted, fromStatus: "APPLYING", toStatus: "APPLYING", detail: "Browser run restarted after the previous run failed or was cancelled."
  });
  historyRun(database, restarted, { status: "awaiting-approval", createdAt: new Date().toISOString() });
}

/** Another posting with the seeded posting's content at a different address. */
function cloneJob(database: DatabaseSync, fromJobId: string, input: { companyName: string; sourceUrl: string }): string {
  const posting = getJobPosting(database, fromJobId)!;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.companyName, title: posting.title, employmentType: posting.employmentType,
    applicationType: posting.source.applicationType, sourceUrl: input.sourceUrl, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `${posting.snapshot.contentHash}-clone`, normalizedText: posting.snapshot.normalizedText,
    locations: posting.locations.map(({ jobId: _jobId, ...location }) => location),
    compensation: posting.compensation,
    requirements: posting.requirements.map(({ id: _id, jobId: _jobId, ...requirement }) => requirement),
    technologies: posting.technologies.map(({ jobId: _jobId, ...technology }) => technology),
    constraints: posting.constraints,
    publication: posting.publication ?? null
  });
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL' WHERE job_id = ?").run(jobId);
  evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
  return jobId;
}

const on: PipelineSettings = { minFit: 0, autoApply: true };
const policy: PipelineSettings = {
  minFit: 0, autoApply: true, target: { season: "summer", year: 2027 }, autoSubmit: { minFit: 80, dailyCap: 10 }
};
const neverOpen: PageFactory = async () => { throw new Error("must not open a browser"); };

function pass(database: DatabaseSync, dataDir: string, settings: PipelineSettings, openPage: PageFactory) {
  return advancePipeline({
    database, dataDir, settings, openPage, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
    fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider()
  });
}

const statusOf = (database: DatabaseSync, jobId: string) =>
  (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;
const eventsStarting = (database: DatabaseSync, jobId: string, prefix: string) =>
  listApplicationEvents(database, jobId).filter((event) => event.detail?.startsWith(prefix));

describe("company cap", () => {
  it("skips a third application to the same company, matching names after normalization, and logs it once", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    strongFit(database, jobId);
    automaticApplication(database, { companyName: "Northstar Systems, Inc.", sourceUrl: "https://example.test/history/1" });
    automaticApplication(database, { companyName: "NORTHSTAR SYSTEMS", sourceUrl: "https://example.test/history/2" });

    const first = await pass(database, dataDir, policy, neverOpen);
    expect(first.started).toEqual([]);
    expect(first.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");

    const second = await pass(database, dataDir, policy, neverOpen);
    expect(second.skipped).toEqual([]);
    expect(second.started).toEqual([]);
    expect(eventsStarting(database, jobId, "Company cap: ")).toHaveLength(1);
    database.close();
  });

  it("counts the agent's submitted and in-flight applications, and frees the slot when a run is cancelled", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    const { run } = automaticApplication(database, {
      companyName: "Northstar Systems", sourceUrl: "https://example.test/history/2", runStatus: "awaiting-approval"
    });

    const capped = await pass(database, dataDir, on, neverOpen);
    expect(capped.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);

    updateBrowserRun(database, run.id, { status: "cancelled" });
    const freed = await pass(database, dataDir, on, async () => fakePage());
    expect(freed.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    database.close();
  });

  it("starts while the company has fewer applications than the cap", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    const report = await pass(database, dataDir, on, async () => fakePage());
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(report.skipped).toEqual([]);
    database.close();
  });

  it("does not count applications for another term when a target is set", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    strongFit(database, jobId);
    for (const index of [1, 2]) {
      automaticApplication(database, {
        companyName: "Northstar Systems", title: "Software Engineer Intern (Fall 2026)", sourceUrl: `https://example.test/history/${index}`
      });
    }
    const report = await pass(database, dataDir, policy, async () => fakePage());
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(report.skipped.some((entry) => entry.reasons.some((reason) => reason.startsWith("Company cap: ")))).toBe(false);
    database.close();
  });

  it("keeps different companies independent", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    graduationFacts(database);
    for (const index of [1, 2]) {
      const other = historyJob(database, { companyName: "Southwind Labs", status: "SUBMITTED", sourceUrl: `https://example.test/history/${index}` });
      historyRun(database, other, { status: "submitted", applicationProfile: "transcript" });
    }
    const report = await pass(database, dataDir, on, async () => fakePage());
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(report.skipped).toEqual([]);
    expect(listBrowserRuns(database, jobId)[0]!.applicationProfile).toBe("default");
    database.close();
  });

  it("treats postings on the same Workday tenant as one company", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    automaticApplication(database, { companyName: "NGC", sourceUrl: "https://ngc.wd1.myworkdayjobs.com/External/job/US-VA/Intern_R2" });
    automaticApplication(database, {
      companyName: "Northrop Grumman Corporation", sourceUrl: "https://ngc.wd1.myworkdayjobs.com/External/job/US-CA/Intern_R3"
    });
    database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?").run(WORKDAY_URL, jobId);
    const report = await pass(database, dataDir, on, neverOpen);
    expect(report.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);
    expect(report.waiting).toEqual([]);
    expect(report.started).toEqual([]);
    database.close();
  });

  it("gives the company's last slot to the posting with the higher AI fit", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    strongFit(database, jobId, 82);
    const better = cloneJob(database, jobId, { companyName: "Northstar Systems", sourceUrl: "https://example.test/internships/northstar-clone" });
    strongFit(database, better, 90);
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    const report = await pass(database, dataDir, on, async () => fakePage());
    expect(report.prepared.map((entry) => entry.jobId).sort()).toEqual([jobId, better].sort());
    expect(report.started).toEqual([{ jobId: better, runStatus: "awaiting-approval" }]);
    expect(report.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);
    database.close();
  });

  it("checks the cap again before an automatic submission", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    strongFit(database, jobId, 86);
    const flag = { clicked: false };
    let calls = 0;
    const openPage: PageFactory = async () => {
      calls += 1;
      if (calls === 1) {
        automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
        automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/2" });
      }
      return fakePage({ submitted: flag });
    };
    const report = await pass(database, dataDir, policy, openPage);
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(report.submitted).toEqual([]);
    expect(report.held[0]!.reasons).toContain(CAP_REASON);
    expect(flag.clicked).toBe(false);
    database.close();
  });

  it("reads the cap from INTERNSHIP_AGENT_COMPANY_CAP", async () => {
    expect(pipelineSettings({ INTERNSHIP_AGENT_COMPANY_CAP: "3" })).toEqual({ minFit: 0, autoApply: false, companyCap: 3 });
    expect(pipelineSettings({ INTERNSHIP_AGENT_COMPANY_CAP: "abc" })).toEqual({ minFit: 0, autoApply: false });
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/2" });
    const report = await pass(database, dataDir, { ...on, companyCap: 3 }, async () => fakePage());
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    database.close();
  });

  it("does not count the candidate's own applications", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    candidateApplications(database);
    expect(companyStanding(database, jobId)?.applications).toBe(0);
    const report = await pass(database, dataDir, on, async () => fakePage());
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    expect(report.skipped).toEqual([]);
    database.close();
  });

  it("counts two automatic applications even beside the candidate's own", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    candidateApplications(database);
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/2" });
    expect(companyStanding(database, jobId)?.applications).toBe(2);
    const report = await pass(database, dataDir, on, neverOpen);
    expect(report.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);
    expect(report.started).toEqual([]);
    database.close();
  });

  it("counts a run with no recorded start conservatively", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    for (const index of [1, 2]) {
      const earlier = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: `https://example.test/history/${index}` });
      historyRun(database, earlier, { status: "submitted" });
    }
    const report = await pass(database, dataDir, on, neverOpen);
    expect(report.skipped).toEqual([{ jobId, reasons: [CAP_REASON] }]);
    database.close();
  });

  it("does not count a run the candidate started through the orchestrator", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const seeded = seededJob(database, "approved");
    await startBrowserRun(seeded, "https://boards.greenhouse.io/example/jobs/2", {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), voiceDrafter: null, openPage: async () => fakePage()
    });
    expect(eventsStarting(database, seeded, CANDIDATE_START)).toHaveLength(1);
    const clone = cloneJob(database, seeded, { companyName: "Northstar Systems", sourceUrl: "https://example.test/internships/northstar-clone" });
    automaticApplication(database, { companyName: "Northstar Systems", sourceUrl: "https://example.test/history/1" });
    expect(companyStanding(database, clone)?.applications).toBe(1);
    const report = await pass(database, dataDir, on, async () => fakePage());
    expect(report.started).toEqual([{ jobId: clone, runStatus: "awaiting-approval" }]);
    expect(report.skipped).toEqual([]);
    database.close();
  });
});

describe("one graduation profile per company", () => {
  it("reuses the 2029 profile after an earlier transcript application, even without a transcript field", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    database.prepare("UPDATE jobs SET application_type = 'EXTERNAL_ATS' WHERE id = ?").run(jobId);
    graduationFacts(database);
    const earlier = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/1" });
    // A run recorded before migration 0029: its profile comes from the transcript it uploaded.
    historyRun(database, earlier, {
      status: "submitted",
      decisions: [{
        fieldId: "transcript", action: "upload", value: null, basis: { kind: "candidate_document", documentId: randomUUID() },
        reason: "Uploads your transcript (PDF, checksum-verified).", pause: null
      }]
    });
    const page = fakePage({ controls: NO_TRANSCRIPT_CONTROLS });
    const report = await pass(database, dataDir, on, async () => page);
    expect(report.started).toEqual([{ jobId, runStatus: "awaiting-approval" }]);
    const run = listBrowserRuns(database, jobId)[0]!;
    expect(run.applicationProfile).toBe("transcript");
    expect(page.filled.get("grad")).toBe("2029-05-15");
    expect(page.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);

    confirmRunAts(run.id, "greenhouse", { database });
    approveRunSubmission(run.id, undefined, { database });
    const submitPage = fakePage({ controls: NO_TRANSCRIPT_CONTROLS });
    const submitted = await submitBrowserRun(run.id, {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), openPage: async () => submitPage
    });
    expect(submitted.status).toBe("submitted");
    expect(submitted.applicationProfile).toBe("transcript");
    expect(submitPage.uploads.get("resume")).toMatch(/-graduating-2029-05-15\.pdf$/);
    database.close();
  });

  it("holds a transcript form at a company that already received the 2028 profile, before filling anything", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    database.prepare("UPDATE jobs SET application_type = 'EXTERNAL_ATS' WHERE id = ?").run(jobId);
    graduationFacts(database);
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const earlier = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/1" });
    historyRun(database, earlier, { status: "submitted", applicationProfile: "default" });

    const page = fakePage({ controls: TRANSCRIPT_CONTROLS });
    const report = await pass(database, dataDir, on, async () => page);
    expect(report.started).toEqual([]);
    expect(report.stopped).toHaveLength(1);
    expect(report.stopped[0]!.jobId).toBe(jobId);
    expect(report.stopped[0]!.reason).toContain("already received your 2028 profile");
    expect(report.stopped[0]!.reason).toContain("2029 profile");
    expect(page.filled.size).toBe(0);
    expect(page.uploads.size).toBe(0);
    expect(listBrowserRuns(database, jobId)).toEqual([]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    expect(eventsStarting(database, jobId, "Automatic browser run needs you: ")).toHaveLength(1);

    const again = await pass(database, dataDir, on, neverOpen);
    expect(again.stopped).toEqual([]);
    expect(again.started).toEqual([]);
    database.close();
  });

  it("holds a Workday walk at the transcript step when the company already received the 2028 profile", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database);
    prepareApplication(jobId, { database });
    database.prepare("UPDATE jobs SET source_url = ? WHERE id = ?").run(WORKDAY_URL, jobId);
    saveBrowserSession(database, { site: "workday:ngc.wd1.myworkdayjobs.com/External", status: "connected", detail: "Signed in.", checkedAt: new Date().toISOString() });
    graduationFacts(database);
    storeCandidateDocument({ kind: "transcript", label: "Transcript", originalName: "t.pdf", bytes: PDF_BYTES }, { database, dataDir });
    const earlier = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/1" });
    historyRun(database, earlier, { status: "submitted", applicationProfile: "default" });

    const flow: Array<{ name: string; controls: RawControl[] }> = [
      { name: "My Information", controls: [{ tag: "input", type: "email", id: "formField-emailAddress", label: "Email", required: true }] },
      { name: "Application Questions", controls: [{ tag: "input", type: "file", id: "formField-transcript", label: "Unofficial transcript", required: true }] },
      { name: "Review", controls: [] }
    ];
    let index = 0;
    const steps: string[] = [];
    const base = fakePage();
    const filled = new Map<string, string>();
    const workday = {
      ...base,
      filled,
      url: () => WORKDAY_URL,
      title: async () => "Workday",
      collectControls: async () => flow[index]!.controls,
      fillField: async (field: BrowserField, value: string) => { filled.set(`${flow[index]!.name}::${field.id}`, value); },
      uploadFile: async (field: BrowserField, path: string) => { base.uploads.set(`${flow[index]!.name}::${field.id}`, path); },
      bodyText: async () => "Review your application",
      enterApplication: async () => "flow" as const,
      signInRequired: async () => false,
      activeStep: async () => { steps.push(flow[index]!.name); return { index: index + 1, total: flow.length, name: flow[index]!.name }; },
      footerAction: async () => (flow[index]!.name === "Review" ? "Submit" : "Save and Continue"),
      fillHistory: async () => null,
      backTo: async () => false,
      nextStep: async () => { index += 1; return { moved: true, errors: [] }; },
      clickSubmit: async () => { throw new Error("must not submit"); }
    };

    const report = await pass(database, dataDir, on, async () => workday as unknown as BrowserPage);
    expect(report.started).toEqual([]);
    expect(report.stopped).toHaveLength(1);
    expect(report.stopped[0]!.reason).toContain("already received your 2028 profile");
    expect(steps).toEqual(["My Information", "Application Questions"]);
    expect(filled.get("My Information::formField-emailAddress")).toBe("jordan@example.test");
    expect([...filled.keys()].some((key) => key.startsWith("Application Questions::"))).toBe(false);
    expect(base.uploads.size).toBe(0);
    expect(listBrowserRuns(database, jobId)).toEqual([]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");
    database.close();
  });

  it("warns, but does not block, a candidate-started run that uses a different profile", async () => {
    const database = disposableDatabase();
    const dataDir = disposableDataDir();
    const jobId = seededJob(database, "approved");
    graduationFacts(database);
    const earlier = historyJob(database, { companyName: "Northstar Systems", status: "SUBMITTED", sourceUrl: "https://example.test/history/1" });
    historyRun(database, earlier, { status: "submitted", applicationProfile: "transcript" });

    const page = fakePage({ controls: NO_TRANSCRIPT_CONTROLS });
    const started = await startBrowserRun(jobId, "https://boards.greenhouse.io/example/jobs/2", {
      database, dataDir, renderPdf: async () => ({ pages: 1 }), voiceDrafter: null, openPage: async () => page
    });
    expect(started.run.applicationProfile).toBe("default");
    expect(page.filled.get("grad")).toBe("2028-05-15");
    const warnings = eventsStarting(database, jobId, "Heads-up: ");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.detail).toMatch(/^Heads-up: Northstar Systems already received your 2029 profile; this run uses your 2028 profile\./);
    database.close();
  });
});
