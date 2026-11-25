import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getFitInputVersion,
  getJobMatch,
  getJobPosting,
  getSemanticFit,
  holdRequirementLabels,
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
  saveCandidateFact,
  saveCandidatePreferences,
  saveDiscoverySkip,
  saveSemanticFit,
  seedDevelopmentData
} from "@internship-agent/db";
import type { BrowserField, BrowserRun, JobCompensation, JobRequirement, SemanticFitAssessment } from "@internship-agent/domain";
import { companyCapReason } from "@internship-agent/domain";
import type { BrowserPage, RawControl } from "@internship-agent/browser";
import { DOCTORAL_STUDY_REVIEW_REASON, MASTER_STUDY_REVIEW_REASON } from "@internship-agent/matching";
import {
  advancePipeline,
  evaluateAndPersistMatch,
  postingTargetDecision,
  prepareApplication,
  UnavailableModelProvider,
  unverifiedRequirements,
  type PageFactory,
  type PipelineSettings
} from "@internship-agent/agent";

/**
 * Needs-review postings pursued on their AI fit (candidate approval,
 * 2026-11-24): an eligible needs-review posting whose only open items are
 * unverified skill, experience, or degree-wording requirements is prepared
 * once its current AI fit meets the auto-submit bar and the target says
 * apply. Disposable SQLite and data directories; no browser, no network.
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-pursuit-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function disposableDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-pursuit-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** In-memory stand-in for a page: records nothing, never touches a browser. */
function fakePage(overrides: { controls?: RawControl[]; submitted?: { clicked: boolean } } = {}): BrowserPage {
  let submitted = false;
  return {
    url: () => "https://boards.greenhouse.io/example/jobs/2",
    title: async () => "Example",
    collectControls: async () => overrides.controls ?? [
      { tag: "input", type: "text", id: "q1", label: "What is your available start date?", required: true },
      { tag: "button", label: "Submit application" }
    ],
    bodyText: async () => (submitted ? "Thank you! Your application was received." : "Please fix the errors below."),
    fillField: async (_field: BrowserField, _value: string) => {},
    chooseOption: async (_field: BrowserField, _option: string) => {},
    setChecked: async (_field: BrowserField, _checked: boolean) => {},
    uploadFile: async (_field: BrowserField, _path: string) => {},
    clickSubmit: async () => {
      submitted = true;
      if (overrides.submitted) overrides.submitted.clicked = true;
    },
    screenshot: async () => {},
    close: async () => {}
  };
}

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

/** The seeded "Northstar Systems" posting, qualified on AI labels. */
function seededJob(database: DatabaseSync): string {
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
  return row.id;
}

function fit(database: DatabaseSync, jobId: string, score = 86, overrides: Partial<SemanticFitAssessment> = {}) {
  saveSemanticFit(database, jobId, getFitInputVersion(database, jobId), {
    score, rating: "STRONG", confidence: "MEDIUM", summary: "Fixture judgment.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
    decisions: [], unknownCount: 1, model: "fixture", evaluatedAt: new Date().toISOString(), version: 2, ...overrides
  });
}

type Extra = { text: string; subject: JobRequirement["subject"]; category?: JobRequirement["category"] };

let cloneCount = 0;

/**
 * A copy of the seeded posting with one more requirement line, at another
 * company and address, on AI labels and evaluated. The seeded posting is
 * withdrawn first so only the copy moves through the pipeline.
 */
function postingWith(database: DatabaseSync, seededId: string, input: {
  extra?: Extra; title?: string; companyName?: string; sourceUrl?: string; locations?: []; compensation?: JobCompensation | null;
}): string {
  const posting = getJobPosting(database, seededId)!;
  database.prepare("UPDATE jobs SET status = 'WITHDRAWN' WHERE id = ?").run(seededId);
  cloneCount += 1;
  const extra = input.extra;
  const normalizedText = extra ? `${posting.snapshot.normalizedText}\n- ${extra.text}` : posting.snapshot.normalizedText;
  const start = extra ? normalizedText.indexOf(extra.text) : 0;
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.companyName ?? "Southwind Labs", title: input.title ?? posting.title, employmentType: posting.employmentType,
    applicationType: posting.source.applicationType, sourceUrl: input.sourceUrl ?? `https://example.test/internships/southwind-${cloneCount}`,
    externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `${posting.snapshot.contentHash}-pursuit-${cloneCount}`, normalizedText,
    locations: input.locations ?? posting.locations.map(({ jobId: _jobId, ...location }) => location),
    compensation: input.compensation === undefined ? posting.compensation : input.compensation,
    requirements: [
      ...posting.requirements.map(({ id: _id, jobId: _jobId, ...requirement }) => requirement),
      ...(extra ? [{
        text: extra.text, category: extra.category ?? "HARD", subject: extra.subject, extraction: "MODEL" as const, assertion: "STATED" as const,
        confidence: 0.9, span: { start, end: start + extra.text.length, excerpt: extra.text }
      }] : [])
    ],
    technologies: posting.technologies.map(({ jobId: _jobId, ...technology }) => technology),
    constraints: posting.constraints,
    publication: posting.publication ?? null
  });
  database.prepare("UPDATE job_requirements SET extraction = 'MODEL' WHERE job_id = ?").run(jobId);
  evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
  return jobId;
}

const ELIXIR: Extra = { text: "Experience with Elixir", subject: "SKILL" };

/** A needs-review copy with one extra line; asserts the starting point every case relies on. */
function needsReviewJob(database: DatabaseSync, input: Parameters<typeof postingWith>[2] & { extra: Extra }): string {
  const seededId = seededJob(database);
  const jobId = postingWith(database, seededId, input);
  expect(getJobMatch(database, jobId)?.verdict).toBe("NEEDS_REVIEW");
  expect(statusOf(database, jobId)).toBe("ANALYZING");
  return jobId;
}

function historyJob(database: DatabaseSync, input: { companyName: string; status: string; sourceUrl: string }): string {
  const title = "Software Engineering Intern";
  const { jobId } = persistNormalizedPosting(database, {
    companyName: input.companyName, title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: input.sourceUrl, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${input.sourceUrl}`, normalizedText: `${title}\nFixture posting for company history.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  });
  database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(input.status, jobId);
  return jobId;
}

function historyRun(database: DatabaseSync, jobId: string, input: { status: BrowserRun["status"]; applicationUrl?: string; createdAt?: string }): BrowserRun {
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
    packageId, variantId: null, baseResumeId: null, atsKind: "greenhouse",
    atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true, decisions: [], pauses: [],
    submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: at, updatedAt: at
  });
}

const AUTO_START = "Browser run started automatically from the verified package; your approval is required before submission.";

/** An earlier application the agent made at a company: a submitted pipeline-started run. */
function automaticApplication(database: DatabaseSync, input: { companyName: string; sourceUrl: string }) {
  const jobId = historyJob(database, { companyName: input.companyName, status: "SUBMITTED", sourceUrl: input.sourceUrl });
  logApplicationEvent(database, { jobId, fromStatus: "READY_FOR_REVIEW", toStatus: "APPLYING", detail: AUTO_START });
  historyRun(database, jobId, { status: "submitted", applicationUrl: input.sourceUrl, createdAt: new Date().toISOString() });
}

const target = { season: "summer", year: 2027 } as const;
const policy: PipelineSettings = { minFit: 0, autoApply: false, target, autoSubmit: { minFit: 50, dailyCap: 10 } };
const neverOpen: PageFactory = async () => { throw new Error("must not open a browser"); };
const submitWait = { timeoutMs: 50, pollMs: 5 };

function pass(database: DatabaseSync, dataDir: string, settings: PipelineSettings, openPage: PageFactory = neverOpen) {
  return advancePipeline({
    database, dataDir, settings, openPage, voiceDrafter: null, renderPdf: async () => ({ pages: 1 }),
    fitProvider: new UnavailableModelProvider(), labelProvider: new UnavailableModelProvider(), submitWait,
    securityCodeMailbox: null, securityCodeWait: { pollMs: 1, timeoutMs: 20, sleep: async () => undefined }
  });
}

const statusOf = (database: DatabaseSync, jobId: string) =>
  (database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status;
const pursuedEvents = (database: DatabaseSync, jobId: string) =>
  listApplicationEvents(database, jobId).filter((event) => event.detail?.startsWith("Pursued on AI fit "));

/** Not prepared: still waiting in analysis, no pursuit event, nothing reported for it. */
function expectNotPursued(database: DatabaseSync, jobId: string, report: Awaited<ReturnType<typeof pass>>) {
  expect(report.prepared.find((entry) => entry.jobId === jobId)).toBeUndefined();
  expect(statusOf(database, jobId)).toBe("ANALYZING");
  expect(pursuedEvents(database, jobId)).toEqual([]);
  expect(report.skipped.find((entry) => entry.jobId === jobId)).toBeUndefined();
}

describe("needs-review postings pursued on AI fit", () => {
  it("prepares an eligible needs-review posting with a current AI fit at the bar and logs the unverified requirements", async () => {
    const database = disposableDatabase();
    const jobId = needsReviewJob(database, { extra: ELIXIR });
    fit(database, jobId, 86);

    const report = await pass(database, disposableDataDir(), policy);
    expect(report.prepared).toEqual([
      { jobId, status: "READY_FOR_REVIEW", pursuedOnFit: { score: 86, unverified: ["Experience with Elixir"] } }
    ]);
    const events = pursuedEvents(database, jobId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: "ANALYZING", toStatus: "PREPARING",
      detail: "Pursued on AI fit 86 despite unverified requirements: Experience with Elixir"
    });
    expect(unverifiedRequirements(database, jobId)).toEqual(["Experience with Elixir"]);

    // A re-prepare (a resume refresh, for example) of a posting already pursued is allowed.
    expect(() => prepareApplication(jobId, { database })).not.toThrow();
    database.close();
  });

  it("prepares at exactly the bar and not one point below it", async () => {
    const atBar = disposableDatabase();
    const atBarJob = needsReviewJob(atBar, { extra: ELIXIR });
    fit(atBar, atBarJob, 50);
    const prepared = await pass(atBar, disposableDataDir(), policy);
    expect(prepared.prepared.map((entry) => entry.jobId)).toEqual([atBarJob]);
    atBar.close();

    const below = disposableDatabase();
    const belowJob = needsReviewJob(below, { extra: ELIXIR });
    fit(below, belowJob, 49);
    expectNotPursued(below, belowJob, await pass(below, disposableDataDir(), policy));
    below.close();
  });

  it("waits without a current AI fit: none yet or stale", async () => {
    const none = disposableDatabase();
    const noneJob = needsReviewJob(none, { extra: ELIXIR });
    expectNotPursued(none, noneJob, await pass(none, disposableDataDir(), policy));
    none.close();

    const stale = disposableDatabase();
    const staleJob = needsReviewJob(stale, { extra: ELIXIR });
    fit(stale, staleJob, 86);
    stale.prepare("UPDATE semantic_fit_cache SET context_version = context_version + 100 WHERE job_id = ?").run(staleJob);
    expect(getSemanticFit(stale, staleJob)?.stale).toBe(true);
    expectNotPursued(stale, staleJob, await pass(stale, disposableDataDir(), policy));
    stale.close();
  });

  it("is not pursued when the target skips or reviews the posting, or no target is set", async () => {
    const skipped = disposableDatabase();
    const skippedJob = needsReviewJob(skipped, { extra: ELIXIR, title: "Software Engineering Intern (Fall 2027)" });
    fit(skipped, skippedJob, 86);
    expect(postingTargetDecision(skipped, skippedJob, target).outcome).toBe("skip");
    expectNotPursued(skipped, skippedJob, await pass(skipped, disposableDataDir(), policy));
    skipped.close();

    const review = disposableDatabase();
    const seededId = seededJob(review);
    const reviewJob = postingWith(review, seededId, { extra: ELIXIR, locations: [] });
    expect(getJobMatch(review, reviewJob)?.verdict).toBe("NEEDS_REVIEW");
    fit(review, reviewJob, 86);
    expect(postingTargetDecision(review, reviewJob, target).outcome).toBe("review");
    expectNotPursued(review, reviewJob, await pass(review, disposableDataDir(), policy));
    // Contrast: a qualified posting the target only reviews is still prepared, as before.
    const qualifiedJob = postingWith(review, seededId, { locations: [], companyName: "Eastgate Works" });
    expect(getJobMatch(review, qualifiedJob)?.verdict).toBe("QUALIFIED");
    fit(review, qualifiedJob, 86);
    const contrast = await pass(review, disposableDataDir(), policy);
    expect(contrast.prepared.map((entry) => entry.jobId)).toEqual([qualifiedJob]);
    expect(contrast.prepared[0]!.pursuedOnFit).toBeUndefined();
    review.close();

    const untargeted = disposableDatabase();
    const untargetedJob = needsReviewJob(untargeted, { extra: ELIXIR });
    fit(untargeted, untargetedJob, 86);
    expectNotPursued(untargeted, untargetedJob, await pass(untargeted, disposableDataDir(), { minFit: 0, autoApply: false }));
    untargeted.close();
  });

  it.each([
    ["doctoral", "Currently pursuing a PhD in Computer Science", DOCTORAL_STUDY_REVIEW_REASON],
    ["master's", "Currently pursuing a Master's degree in Computer Science", MASTER_STUDY_REVIEW_REASON]
  ])("is not pursued past a %s requirement", async (_level, text, reason) => {
    const database = disposableDatabase();
    const jobId = needsReviewJob(database, { extra: { text, subject: "DEGREE" } });
    const open = getJobMatch(database, jobId)!.findings.filter((finding) => finding.outcome === "UNKNOWN");
    expect(open.map((finding) => finding.reason)).toEqual([reason]);
    fit(database, jobId, 86);
    expectNotPursued(database, jobId, await pass(database, disposableDataDir(), policy));
    database.close();
  });

  it("never pursues a posting that is not qualified", async () => {
    const database = disposableDatabase();
    const seededId = seededJob(database);
    saveCandidatePreferences(database, LOCAL_CANDIDATE_ID, {
      roleTypes: [], locations: [], workModes: [], industries: [], excludeGraduateOnlyInternships: true
    });
    const jobId = postingWith(database, seededId, { extra: { text: "Currently pursuing a PhD in Computer Science", subject: "DEGREE" } });
    expect(getJobMatch(database, jobId)?.verdict).toBe("NOT_QUALIFIED");
    expect(statusOf(database, jobId)).toBe("NOT_QUALIFIED");
    fit(database, jobId, 86);
    const report = await pass(database, disposableDataDir(), policy);
    expect(report.prepared).toEqual([]);
    expect(statusOf(database, jobId)).toBe("NOT_QUALIFIED");
    expect(pursuedEvents(database, jobId)).toEqual([]);
    database.close();
  });

  it("keeps the minimum fit, discovery skips, and label holds", async () => {
    const minFit = disposableDatabase();
    const minFitJob = needsReviewJob(minFit, { extra: ELIXIR });
    fit(minFit, minFitJob, 86);
    expectNotPursued(minFit, minFitJob, await pass(minFit, disposableDataDir(), { ...policy, minFit: 90 }));
    minFit.close();

    const skipped = disposableDatabase();
    const skippedJob = needsReviewJob(skipped, { extra: ELIXIR });
    fit(skipped, skippedJob, 86);
    saveDiscoverySkip(skipped, { jobId: skippedJob, reason: "Not interested.", preferenceNote: null });
    expectNotPursued(skipped, skippedJob, await pass(skipped, disposableDataDir(), policy));
    skipped.close();

    const held = disposableDatabase();
    const heldJob = needsReviewJob(held, { extra: ELIXIR });
    fit(held, heldJob, 86);
    holdRequirementLabels(held, { jobId: heldJob, snapshotId: getJobPosting(held, heldJob)!.snapshot.id, reason: "Labels pending." });
    expectNotPursued(held, heldJob, await pass(held, disposableDataDir(), policy));
    held.close();
  });

  it("never moves a terminal posting or one that was prepared or run before", async () => {
    const database = disposableDatabase();
    const submitted = needsReviewJob(database, { extra: ELIXIR });
    fit(database, submitted, 86);
    database.prepare("UPDATE jobs SET status = 'SUBMITTED' WHERE id = ?").run(submitted);

    // A pursued posting that was prepared and run, then put back into analysis (a re-match).
    const ran = postingWith(database, submitted, { companyName: "Eastgate Works" });
    expect(getJobMatch(database, ran)?.verdict).toBe("NEEDS_REVIEW");
    database.prepare("UPDATE jobs SET status = 'SUBMITTED' WHERE id = ?").run(submitted);
    fit(database, ran, 86);
    const first = await pass(database, disposableDataDir(), policy);
    expect(first.prepared.map((entry) => entry.jobId)).toEqual([ran]);
    historyRun(database, ran, { status: "awaiting-approval", createdAt: new Date().toISOString() });
    database.prepare("UPDATE jobs SET status = 'ANALYZING' WHERE id = ?").run(ran);
    expect(listBrowserRuns(database, ran)).toHaveLength(1);

    const before = { submitted: listApplicationEvents(database, submitted).length, ran: listApplicationEvents(database, ran).length };
    const report = await pass(database, disposableDataDir(), policy);
    expect(report.prepared).toEqual([]);
    expect(statusOf(database, submitted)).toBe("SUBMITTED");
    expect(statusOf(database, ran)).toBe("ANALYZING");
    expect(listApplicationEvents(database, submitted)).toHaveLength(before.submitted);
    expect(listApplicationEvents(database, ran)).toHaveLength(before.ran);
    database.close();
  });

  it("keeps the company cap for a pursued posting", async () => {
    const database = disposableDatabase();
    const jobId = needsReviewJob(database, { extra: ELIXIR });
    fit(database, jobId, 86);
    for (const index of [1, 2]) automaticApplication(database, { companyName: "Southwind Labs", sourceUrl: `https://example.test/history/${index}` });

    const report = await pass(database, disposableDataDir(), { ...policy, autoApply: true }, neverOpen);
    expect(report.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
    expect(report.started).toEqual([]);
    expect(report.skipped).toEqual([{ jobId, reasons: [companyCapReason("Southwind Labs", 2)] }]);
    expect(listBrowserRuns(database, jobId)).toEqual([]);
    database.close();
  });

  it("runs a pursued posting only while its decision is still apply", async () => {
    const database = disposableDatabase();
    const jobId = needsReviewJob(database, { extra: ELIXIR });
    fit(database, jobId, 86);
    const prepared = await pass(database, disposableDataDir(), policy);
    expect(prepared.prepared.map((entry) => entry.jobId)).toEqual([jobId]);
    expect(statusOf(database, jobId)).toBe("READY_FOR_REVIEW");

    // The AI fit now asks for review (low confidence), so no automatic run starts.
    fit(database, jobId, 86, { confidence: "LOW" });
    const report = await pass(database, disposableDataDir(), { ...policy, autoApply: true }, async () => fakePage());
    expect(report.started).toEqual([]);
    expect(listBrowserRuns(database, jobId)).toEqual([]);
    database.close();
  });

  it("auto-submits a pursued posting under the unchanged blockers and names the unverified requirements in the approval", async () => {
    const database = disposableDatabase();
    const jobId = needsReviewJob(database, { extra: ELIXIR });
    fit(database, jobId, 86);
    const flag = { clicked: false };

    const report = await pass(database, disposableDataDir(), { ...policy, autoApply: true }, async () => fakePage({ submitted: flag }));
    expect(report.held).toEqual([]);
    expect(report.submitted).toEqual([{ jobId, confirmation: expect.stringContaining("application was received") }]);
    expect(flag.clicked).toBe(true);
    const approval = listApplicationEvents(database, jobId)
      .find((event) => event.detail?.startsWith("Submission approved automatically by your auto-submit policy"));
    expect(approval?.detail).toContain("Experience with Elixir");
    expect(approval?.detail).toContain("2026-11-24");
    database.close();
  });
});

describe("unpaid postings under a target", () => {
  // The candidate's rule (2026-11-24): "unpaid inter ships should be ruled out". Fictional postings.
  it("rules out an unpaid title and a zero pay once, before preparing them, and still prepares a paid posting", async () => {
    const database = disposableDatabase();
    const seededId = seededJob(database);
    const seededPay = getJobPosting(database, seededId)!.compensation!;
    const unpaidJob = postingWith(database, seededId, { title: "Software Engineering Intern (UNPAID)", companyName: "Lakeshore Rides" });
    const zeroJob = postingWith(database, seededId, { companyName: "Harbor Point", compensation: { ...seededPay, minimum: 0, maximum: 0 } });
    const paidJob = postingWith(database, seededId, { companyName: "Eastgate Works" });
    for (const jobId of [unpaidJob, zeroJob, paidJob]) {
      expect(getJobMatch(database, jobId)?.verdict).toBe("QUALIFIED");
      fit(database, jobId, 86);
    }
    expect(postingTargetDecision(database, unpaidJob, target))
      .toEqual({ outcome: "skip", reasons: ["Pay: the posting says the internship is unpaid."] });
    expect(postingTargetDecision(database, zeroJob, target)).toEqual({ outcome: "skip", reasons: ["Pay: the posting states zero pay."] });
    expect(postingTargetDecision(database, paidJob, target)).toEqual({ outcome: "apply", reasons: [] });

    const first = await pass(database, disposableDataDir(), policy);
    expect(first.prepared.map((entry) => entry.jobId)).toEqual([paidJob]);
    expect(first.skipped).toEqual(expect.arrayContaining([
      { jobId: unpaidJob, reasons: ["Pay: the posting says the internship is unpaid."] },
      { jobId: zeroJob, reasons: ["Pay: the posting states zero pay."] }
    ]));
    await pass(database, disposableDataDir(), policy);
    const skips = (jobId: string) => listApplicationEvents(database, jobId)
      .map((event) => event.detail).filter((detail) => detail?.startsWith("Not pursued for your target: "));
    expect(skips(unpaidJob)).toEqual(["Not pursued for your target: Pay: the posting says the internship is unpaid."]);
    expect(skips(zeroJob)).toEqual(["Not pursued for your target: Pay: the posting states zero pay."]);
    expect(skips(paidJob)).toEqual([]);
    expect(statusOf(database, unpaidJob)).toBe("QUALIFIED");
    database.close();
  });
});
