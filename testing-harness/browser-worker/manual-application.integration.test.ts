import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  listApplicationEvents,
  listBrowserRuns,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  persistNormalizedPosting,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  saveBrowserRun,
  saveCandidateFact,
  seedDevelopmentData,
  setJobStatus,
  updateBrowserRun
} from "@internship-agent/db";
import type { BrowserRun } from "@internship-agent/domain";
import {
  evaluateAndPersistMatch,
  getReviewQueue,
  prepareApplication,
  recordManualApplication,
  recordManualApplicationBatch
} from "@internship-agent/agent";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-manual-apply-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(join(directory, "test.sqlite"));
  seedDevelopmentData(database);
  return database;
}

function addPosting(database: DatabaseSync, title: string): string {
  return persistNormalizedPosting(database, {
    companyName: "Fixture Company", title, employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
    sourceUrl: `https://example.test/manual/${encodeURIComponent(title)}`, externalApplicationUrl: null, companyCareersUrl: null,
    contentHash: `hash-${title}`, normalizedText: `${title}\nFixture posting for manual check-off.`,
    locations: [], compensation: null, requirements: [], technologies: [],
    constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
  }).jobId;
}

function saveFact(database: DatabaseSync, key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" }, value: boolean | string) {
  saveCandidateFact(database, { candidateId: LOCAL_CANDIDATE_ID, key, scope, value, source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." }, confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z" });
}

function qualifySeededJob(database: DatabaseSync): string {
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  const repository = registerGitHubRepository(database, { candidateId: LOCAL_CANDIDATE_ID, owner: "example",
    name: "evidence-demo", url: "https://github.com/example/evidence-demo", defaultBranch: "main",
    description: "Fixture evidence.", observedHeadSha: "sha-fixture" });
  reconcileProjectEvidence(database, { candidateId: LOCAL_CANDIDATE_ID, repositoryId: repository.id,
    name: "evidence-demo", summary: "Fixture project.", fullSnapshot: true, affectedPaths: ["README.md"],
    claims: [{ kind: "technology", normalizedKey: "python", text: "Shipped Python services in production.",
      evidenceFingerprint: "tech-v1", evidence: [{ kind: "readme", commitSha: "sha-fixture", path: "README.md",
        startLine: 2, endLine: 2, sourceUrl: "https://github.com/example/evidence-demo/blob/sha-fixture/README.md#L2",
        excerpt: "Python services in production.", excerptHash: "tech-excerpt-v1" }] }] });
  const tech = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID)[0].claims[0];
  reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" });
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  return row.id;
}

function liveRun(database: DatabaseSync, jobId: string): BrowserRun {
  const packageId = crypto.randomUUID();
  database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, ?)")
    .run(packageId, jobId, new Date().toISOString(), "{}");
  return saveBrowserRun(database, {
    id: crypto.randomUUID(), jobId, applicationUrl: "https://example.test/apply", status: "awaiting-approval",
    packageId, variantId: null, baseResumeId: null, atsKind: "greenhouse", atsConfidence: 1,
    suggestedAtsKind: null, atsConfirmed: true, decisions: [], pauses: [], submittedAnswers: null,
    confirmationText: null, submissionApprovedAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
}

describe("manual checklist check-off", () => {
  it("records a prepared application as terminally submitted with an event", () => {
    const database = disposableDatabase();
    try {
      const jobId = qualifySeededJob(database);
      prepareApplication(jobId, { database });
      expect(recordManualApplication(jobId, { database })).toEqual({ jobId, status: "SUBMITTED" });
      expect(getReviewQueue(database).some((entry) => entry.jobId === jobId)).toBe(false);
      const events = listApplicationEvents(database, jobId);
      expect(events.at(-1)).toMatchObject({ toStatus: "SUBMITTED", detail: "Candidate applied manually." });
      expect(() => recordManualApplication(jobId, { database })).toThrowError(/Only applications waiting/);
    } finally { database.close(); }
  });

  it("checks off needs-input entries but refuses live runs and unknown postings", () => {
    const database = disposableDatabase();
    try {
      const needsInput = addPosting(database, "Manual Needs Input");
      setJobStatus(database, needsInput, null, "NEEDS_INPUT", "Fixture blocked package.");
      expect(recordManualApplication(needsInput, { database }).status).toBe("SUBMITTED");

      const running = addPosting(database, "Manual Live Run");
      setJobStatus(database, running, null, "READY_FOR_REVIEW", "Fixture prepared package.");
      const run = liveRun(database, running);
      expect(() => recordManualApplication(running, { database })).toThrowError(/still in progress/);
      updateBrowserRun(database, run.id, { status: "cancelled" });
      expect(listBrowserRuns(database, running)[0].status).toBe("cancelled");
      expect(recordManualApplication(running, { database }).status).toBe("SUBMITTED");

      expect(() => recordManualApplication(crypto.randomUUID(), { database })).toThrowError(/unknown/);
    } finally { database.close(); }
  });

  it("checks off batches per posting instead of failing the batch", () => {
    const database = disposableDatabase();
    try {
      const first = addPosting(database, "Manual Batch One");
      setJobStatus(database, first, null, "READY_FOR_REVIEW", "Fixture prepared package.");
      const second = addPosting(database, "Manual Batch Two");
      setJobStatus(database, second, null, "READY_FOR_REVIEW", "Fixture prepared package.");
      liveRun(database, second);
      const unknown = crypto.randomUUID();
      const result = recordManualApplicationBatch([first, second, unknown], { database });
      expect(result.applied).toEqual([first]);
      expect(result.skipped.map((entry) => entry.jobId).sort()).toEqual([second, unknown].sort());
      expect(result.skipped.find((entry) => entry.jobId === second)?.reason).toMatch(/still in progress/);
    } finally { database.close(); }
  });
});
