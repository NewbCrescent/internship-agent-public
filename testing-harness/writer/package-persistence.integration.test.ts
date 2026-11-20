import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getJobPosting,
  listApplicationEvents,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  listProjectEvidenceProfiles,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import {
  addResumeEntry,
  approveApplication,
  approveResumeEntry,
  editResumeEntry,
  evaluateAndPersistMatch,
  getApplicationPackage,
  getReviewQueue,
  listCandidateResumeEntries,
  listJobResumeVariants,
  prepareApplication,
  renderCandidateResumePreview,
  withdrawApplication
} from "@internship-agent/agent";
import { verifyApplicationPackage } from "@internship-agent/verifier";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-application-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function saveFact(
  database: DatabaseSync,
  key: "authorized_to_work" | "requires_sponsorship" | "available_start_date",
  scope: { kind: "country"; code: string } | { kind: "global" },
  value: boolean | string
) {
  saveCandidateFact(database, {
    candidateId: LOCAL_CANDIDATE_ID,
    key,
    scope,
    value,
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    rememberedAt: "2026-09-22T12:00:00.000Z"
  });
}

function allowPythonEvidence(database: DatabaseSync) {
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
}

function qualifiedJobId(database: DatabaseSync): string {
  seedDevelopmentData(database);
  saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
  saveFact(database, "requires_sponsorship", { kind: "country", code: "US" }, false);
  saveFact(database, "available_start_date", { kind: "global" }, "2027-06-01");
  allowPythonEvidence(database);
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  const { report } = evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
  expect(report.verdict).toBe("QUALIFIED");
  return row.id;
}

describe("application preparation gate", () => {
  it("prepares, verifies, and marks a clean package ready for review", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    const { current, verification, missingFacts } = prepareApplication(jobId, { database });

    expect(missingFacts).toEqual([]);
    expect(verification.blocked).toBe(false);
    expect(current.verification?.blocked).toBe(false);
    expect(current.package.jobId).toBe(jobId);
    expect(getJobPosting(database, jobId)?.status).toBe("READY_FOR_REVIEW");

    const events = listApplicationEvents(database, jobId);
    expect(events.map((event) => event.toStatus)).toContain("READY_FOR_REVIEW");
    expect(database.prepare("SELECT COUNT(*) AS count FROM resume_variants WHERE job_id = ?").get(jobId))
      .toEqual({ count: 1 });
    database.close();
  });

  it("parks the package in needs-input when facts are missing", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    saveFact(database, "authorized_to_work", { kind: "country", code: "US" }, true);
    allowPythonEvidence(database);
    const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
    // Sponsorship silence is fine for eligibility, but the package wants the
    // fact for its authorization answer.
    const { report } = evaluateAndPersistMatch(row.id, { database, candidateId: LOCAL_CANDIDATE_ID });
    expect(report.verdict).toBe("QUALIFIED");

    const prepared = prepareApplication(row.id, { database });
    expect(prepared.missingFacts).toEqual(
      expect.arrayContaining(["requires_sponsorship", "available_start_date"])
    );
    expect(prepared.verification.blocked).toBe(false);
    expect(getJobPosting(database, row.id)?.status).toBe("NEEDS_INPUT");
    database.close();
  });

  it("replaces the current package on re-preparation", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    const first = prepareApplication(jobId, { database });
    const second = prepareApplication(jobId, { database });
    expect(second.current.package.id).not.toBe(first.current.package.id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM application_packages WHERE job_id = ?").get(jobId))
      .toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM application_packages WHERE job_id = ? AND superseded_at IS NULL").get(jobId))
      .toEqual({ count: 1 });
    database.close();
  });

  it("refuses to prepare a posting that is not qualified", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
    expect(() => prepareApplication(row.id, { database })).toThrow("Analyze eligibility");
    database.close();
  });
});

describe("application lifecycle", () => {
  it("approves a verified package and lists it out of the queue", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    prepareApplication(jobId, { database });
    expect(getReviewQueue(database).map((entry) => entry.jobId)).toContain(jobId);

    approveApplication(jobId, { database });
    expect(getJobPosting(database, jobId)?.status).toBe("APPROVED");
    expect(getReviewQueue(database).map((entry) => entry.jobId)).not.toContain(jobId);
    database.close();
  });

  it("refuses to approve an unverified package", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    expect(() => approveApplication(jobId, { database })).toThrow("no application package");
    database.close();
  });

  it("withdraws from any active state", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    prepareApplication(jobId, { database });
    approveApplication(jobId, { database });
    withdrawApplication(jobId, { database });
    expect(getJobPosting(database, jobId)?.status).toBe("WITHDRAWN");
    expect(() => withdrawApplication(jobId, { database })).toThrow("already withdrawn");
    database.close();
  });
});

describe("resume entries in preparation", () => {
  const content = (title: string, bullets: string[], extra: Record<string, string | null> = {}) => ({
    title, role: null, linkLabel: null, linkUrl: null, location: null, dateText: null, bullets, ...extra
  });

  it("approves typed entries, holds transcribed ones, and validates section shape", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    const typed = addResumeEntry("project", content("Typed project", ["Typed bullet."]), { database });
    expect(typed.current.reviewStatus).toBe("APPROVED");
    const transcribed = addResumeEntry("project", content("Transcribed project", ["Copied bullet."]), {
      database,
      source: { kind: "base_resume", baseResumeId: "11111111-1111-4111-8111-111111111111", sha256: "c".repeat(64) }
    });
    expect(transcribed.current.reviewStatus).toBe("PENDING");
    expect(() => addResumeEntry("skills", content("Languages", ["Python"], { role: "Lead" }), { database })).toThrow(/label and items/);
    expect(() => addResumeEntry("project", content("P", ["x"], { role: "Lead" }), { database })).toThrow(/role/);
    expect(() => addResumeEntry("project", content("P", ["x"], { linkUrl: "javascript:alert(1)" }), { database })).toThrow();
    database.close();
  });

  it("freezes only approved entries and blocks a package whose entry changed", () => {
    const database = disposableDatabase();
    const jobId = qualifiedJobId(database);
    const pending = addResumeEntry("project", content("Pending project", ["Not approved yet."]), {
      database,
      source: { kind: "base_resume", baseResumeId: "11111111-1111-4111-8111-111111111111", sha256: "c".repeat(64) }
    });
    const { verification } = prepareApplication(jobId, { database });
    expect(verification.blocked).toBe(false);
    const document = listJobResumeVariants(jobId, database)[0]?.document;
    expect(document?.experience.map((entry) => entry.title)).toEqual(["Example Robotics Lab"]);
    expect(document?.projects.map((entry) => entry.title)).toEqual(["Local Evidence Demo"]);

    expect(approveResumeEntry(pending.id, pending.current.id, { database })).toBe(true);
    const experience = listCandidateResumeEntries(database).find((entry) => entry.section === "experience");
    if (!experience) throw new Error("Seeded experience entry is missing.");
    editResumeEntry(experience.id, { ...experience.current, bullets: ["Edited after preparation."] }, { database });
    const current = getApplicationPackage(jobId, database);
    if (!current) throw new Error("Package is missing.");
    expect(verifyApplicationPackage(current.package, { database }).blocked).toBe(true);

    prepareApplication(jobId, { database });
    const refreshed = listJobResumeVariants(jobId, database)[0]?.document;
    expect(refreshed?.projects.map((entry) => entry.title)).toEqual(["Local Evidence Demo", "Pending project"]);
    expect(refreshed?.experience[0]?.bullets).toEqual(["Edited after preparation."]);
    database.close();
  });

  it("previews the current resume through the renderer", async () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    const dataDir = mkdtempSync(join(tmpdir(), "internship-agent-preview-"));
    temporaryDirectories.push(dataDir);
    let printed = "";
    const preview = await renderCandidateResumePreview({
      database,
      dataDir,
      renderPdf: async (html, path) => {
        printed = html;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "%PDF-1.7 stub");
        return { pages: 1 };
      }
    });
    expect(preview?.pages).toBe(1);
    expect(Buffer.from(preview?.bytes ?? []).toString("latin1").startsWith("%PDF-")).toBe(true);
    expect(printed).toContain("<h2>Technical Skills</h2>");
    database.close();
  });
});
