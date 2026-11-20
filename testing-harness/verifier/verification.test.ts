import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveResumeEntryRevision,
  archiveResumeEntry,
  createDatabase,
  createResumeEntry,
  getJobPosting,
  listProjectEvidenceProfiles,
  LOCAL_CANDIDATE_ID,
  reconcileProjectEvidence,
  registerGitHubRepository,
  reviewEvidenceClaim,
  reviseResumeEntry,
  saveCandidateFact,
  seedDevelopmentData
} from "@internship-agent/db";
import type { ApplicationPackage } from "@internship-agent/domain";
import { claimNumbers, verifyApplicationPackage } from "@internship-agent/verifier";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-verifier-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function seedFacts(database: DatabaseSync) {
  seedDevelopmentData(database);
  for (const [key, scope, value] of [
    ["authorized_to_work", { kind: "country", code: "US" }, true],
    ["requires_sponsorship", { kind: "country", code: "US" }, false],
    ["available_start_date", { kind: "global" }, "2027-06-01"]
  ] as const) {
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
}

function seedEvidence(database: DatabaseSync): { metricClaimId: string; techClaimId: string } {
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
    claims: [
      {
        kind: "metric",
        normalizedKey: "throughput",
        text: "Improved throughput by ~10x.",
        evidenceFingerprint: "metric-v1",
        evidence: [{
          kind: "readme",
          commitSha: sha,
          path: "README.md",
          startLine: 5,
          endLine: 5,
          sourceUrl: `https://github.com/example/evidence-demo/blob/${sha}/README.md#L5`,
          excerpt: "Benchmark improved throughput by 10x.",
          excerptHash: "metric-excerpt-v1"
        }]
      },
      {
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
      }
    ]
  });
  const profiles = listProjectEvidenceProfiles(database, LOCAL_CANDIDATE_ID);
  const metric = profiles[0].claims.find((claim) => claim.kind === "metric");
  const tech = profiles[0].claims.find((claim) => claim.kind === "technology");
  if (!metric || !tech) throw new Error("Fixture evidence did not reconcile.");
  expect(reviewEvidenceClaim(database, { claimId: metric.id, decision: "ALLOWED" })).toBe(true);
  expect(reviewEvidenceClaim(database, { claimId: tech.id, decision: "ALLOWED" })).toBe(true);
  return { metricClaimId: metric.id, techClaimId: tech.id };
}

function packageWith(database: DatabaseSync, jobId: string, claims: ApplicationPackage["claims"]): ApplicationPackage {
  return {
    id: randomUUID(),
    jobId,
    createdAt: new Date().toISOString(),
    summary: "Fixture package.",
    answers: [],
    bullets: [],
    claims
  };
}

function seededJobId(database: DatabaseSync): string {
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  return row.id;
}

describe("independent claim verification", () => {
  it("supports a fully grounded package", () => {
    const database = disposableDatabase();
    seedFacts(database);
    const { metricClaimId, techClaimId } = seedEvidence(database);
    const jobId = seededJobId(database);
    const posting = getJobPosting(database, jobId);
    if (!posting) throw new Error("Seed posting is missing.");

    const report = verifyApplicationPackage(packageWith(database, jobId, [
      { id: randomUUID(), text: "Improved throughput by ~10x.", basis: { kind: "evidence", claimId: metricClaimId }, sourceField: "bullet:x" },
      { id: randomUUID(), text: "Shipped Python services in production.", basis: { kind: "evidence", claimId: techClaimId }, sourceField: "bullet:y" },
      { id: randomUUID(), text: "Available start date: 2027-06-01.", basis: { kind: "fact", key: "available_start_date", scope: "global" }, sourceField: "answer:z" },
      { id: randomUUID(), text: `The posting title is ${posting.title}.`, basis: { kind: "posting", excerpt: posting.title }, sourceField: "answer:w" },
      { id: randomUUID(), text: "I am excited to apply.", basis: { kind: "presentation" }, sourceField: "answer:v" }
    ]), { database });
    expect(report.checks.map((check) => check.verdict)).toEqual(
      ["SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED", "SUPPORTED"]
    );
    expect(report.blocked).toBe(false);
    database.close();
  });

  it("contests a generated metric that outruns its evidence", () => {
    const database = disposableDatabase();
    seedFacts(database);
    const { metricClaimId } = seedEvidence(database);
    const report = verifyApplicationPackage(packageWith(database, seededJobId(database), [
      { id: randomUUID(), text: "Improved throughput by 15x.", basis: { kind: "evidence", claimId: metricClaimId }, sourceField: "bullet:x" }
    ]), { database });
    expect(report.checks[0].verdict).toBe("CONTESTED");
    expect(report.checks[0].reason).toContain("15");
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("rejects evidence that is no longer allowed", () => {
    const database = disposableDatabase();
    seedFacts(database);
    const { techClaimId } = seedEvidence(database);
    expect(reviewEvidenceClaim(database, { claimId: techClaimId, decision: "QUESTIONED" })).toBe(true);
    const report = verifyApplicationPackage(packageWith(database, seededJobId(database), [
      { id: randomUUID(), text: "Shipped Python services in production.", basis: { kind: "evidence", claimId: techClaimId }, sourceField: "bullet:x" }
    ]), { database });
    expect(report.checks[0].verdict).toBe("UNSUPPORTED");
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("rejects presentation sentences that smuggle numbers", () => {
    const database = disposableDatabase();
    seedFacts(database);
    seedEvidence(database);
    const report = verifyApplicationPackage(packageWith(database, seededJobId(database), [
      { id: randomUUID(), text: "I bring 5 years of excitement.", basis: { kind: "presentation" }, sourceField: "answer:x" }
    ]), { database });
    expect(report.checks[0].verdict).toBe("UNSUPPORTED");
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("fails posting quotations after the posting is revised", () => {
    const database = disposableDatabase();
    seedFacts(database);
    seedEvidence(database);
    const jobId = seededJobId(database);
    const posting = getJobPosting(database, jobId);
    if (!posting) throw new Error("Seed posting is missing.");
    database.prepare("UPDATE job_snapshots SET normalized_text = ? WHERE job_id = ? AND superseded_at IS NULL")
      .run("Rewritten posting with none of the old words.", jobId);
    const report = verifyApplicationPackage(packageWith(database, jobId, [
      { id: randomUUID(), text: "The posting location is Seattle, WA.", basis: { kind: "posting", excerpt: "Seattle, WA" }, sourceField: "answer:x" }
    ]), { database });
    expect(report.checks[0].verdict).toBe("UNSUPPORTED");
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("contests assertions built on facts updated after the package", () => {
    const database = disposableDatabase();
    seedFacts(database);
    seedEvidence(database);
    const stale = packageWith(database, seededJobId(database), [
      { id: randomUUID(), text: "Available start date: 2027-06-01.", basis: { kind: "fact", key: "available_start_date", scope: "global" }, sourceField: "answer:x" }
    ]);
    stale.createdAt = "2020-01-01T00:00:00.000Z";
    const report = verifyApplicationPackage(stale, { database });
    expect(report.checks[0].verdict).toBe("CONTESTED");
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("normalizes numeric tokens before comparing", () => {
    expect(claimNumbers("Improved throughput by ~10x (10,000 requests).")).toEqual(["10", "10000"]);
    expect(claimNumbers("No numbers here.")).toEqual([]);
  });
});

describe("resume entry verification", () => {
  const CONTENT = {
    title: "Aurora Labs",
    role: "Software Engineering Intern",
    linkLabel: null,
    linkUrl: null,
    location: "Berkeley, CA",
    dateText: "2026",
    bullets: ["Built ingestion pipelines, increasing reliability by 40%."]
  };

  function setup(reviewStatus: "PENDING" | "APPROVED" = "APPROVED") {
    const database = disposableDatabase();
    seedFacts(database);
    const entry = createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      section: "experience",
      content: CONTENT,
      source: { kind: "user" },
      reviewStatus
    });
    const basis = { kind: "resume_entry" as const, entryId: entry.id, revisionId: entry.current.id };
    const claims = [
      { id: randomUUID(), text: "Aurora Labs | Software Engineering Intern — Berkeley, CA 2026", basis, sourceField: `resume:${entry.id}` },
      { id: randomUUID(), text: CONTENT.bullets[0]!, basis, sourceField: "bullet:x" }
    ];
    return { database, entry, claims, jobId: seededJobId(database) };
  }

  it("supports verbatim lines, including candidate-supplied numbers", () => {
    const { database, claims, jobId } = setup();
    const report = verifyApplicationPackage(packageWith(database, jobId, claims), { database });
    expect(report.checks.map((check) => check.verdict)).toEqual(["SUPPORTED", "SUPPORTED"]);
    database.close();
  });

  it("contests lines whose entry was edited after the package was built", () => {
    const { database, entry, claims, jobId } = setup();
    reviseResumeEntry(database, {
      entryId: entry.id,
      candidateId: LOCAL_CANDIDATE_ID,
      content: { ...CONTENT, bullets: ["Rewrote the pipeline."] },
      source: { kind: "user" },
      reviewStatus: "APPROVED"
    });
    const report = verifyApplicationPackage(packageWith(database, jobId, claims), { database });
    expect(report.checks.every((check) => check.verdict === "CONTESTED")).toBe(true);
    expect(report.blocked).toBe(true);
    database.close();
  });

  it("contests altered text and rejects pending or archived entries", () => {
    const altered = setup();
    const reworded = [{ ...altered.claims[1]!, text: "Built ingestion pipelines, increasing reliability by 45%." }];
    expect(verifyApplicationPackage(packageWith(altered.database, altered.jobId, reworded), { database: altered.database }).checks[0]?.verdict).toBe("CONTESTED");
    altered.database.close();

    const pending = setup("PENDING");
    expect(verifyApplicationPackage(packageWith(pending.database, pending.jobId, pending.claims), { database: pending.database }).checks[0]?.verdict).toBe("UNSUPPORTED");
    expect(approveResumeEntryRevision(pending.database, { entryId: pending.entry.id, revisionId: pending.entry.current.id, candidateId: LOCAL_CANDIDATE_ID })).toBe(true);
    expect(verifyApplicationPackage(packageWith(pending.database, pending.jobId, pending.claims), { database: pending.database }).blocked).toBe(false);
    expect(archiveResumeEntry(pending.database, pending.entry.id, LOCAL_CANDIDATE_ID)).toBe(true);
    expect(verifyApplicationPackage(packageWith(pending.database, pending.jobId, pending.claims), { database: pending.database }).checks[0]?.verdict).toBe("UNSUPPORTED");
    pending.database.close();
  });
});
