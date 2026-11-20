import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getJobPosting, getRequirementLabelHold, listJobSummaries, ProtectedJobError, replaceCurrentJobRequirements, setJobStatus, summarizeModelInvocations } from "@internship-agent/db";
import { getPipelineCounts } from "@internship-agent/agent";
import { verifyTextSpan } from "@internship-agent/domain";
import {
  getJobWorkspace,
  getJobs,
  ingestJobPosting,
  extractDeterministically,
  type ClassifiedRequirement,
  type RequirementCandidate,
  type RequirementClassifier
} from "@internship-agent/jobs";

import { HEADED_BULLETS, MIXED_CUES, PROSE_STYLE, SPARSE } from "./fixtures/postings";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-jobs-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

const SOURCE = "https://app.joinhandshake.com/jobs/900001";

function input(content: string, overrides: Record<string, unknown> = {}) {
  return {
    companyName: "Aurora Labs",
    title: "Software Engineering Intern",
    content,
    sourceUrl: SOURCE,
    ...overrides
  };
}

describe("job posting ingestion", () => {
  it("ignores pre-normalization placeholder jobs that have no captured snapshot", async () => {
    const database = disposableDatabase();
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO jobs (id, company_name, title, employment_type, application_type,
        source_url, external_application_url, company_careers_url, status, created_at, updated_at)
      VALUES ('seed-internship', 'Legacy Fixture', 'Legacy Intern', 'INTERNSHIP', 'UNKNOWN',
        'https://example.test/legacy-placeholder', NULL, NULL, 'DISCOVERED', ?, ?)
    `).run(now, now);
    const current = await ingestJobPosting(input(HEADED_BULLETS), { database });

    expect(getJobs(database).map((job) => job.id)).toEqual([current.jobId]);
    expect(getJobWorkspace(database).postings.map((job) => job.id)).toEqual([current.jobId]);
    expect(getPipelineCounts(database).DISCOVERED).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count).toBe(2);
    database.close();
  });

  it("persists a normalized posting whose every span resolves against the stored snapshot", async () => {
    const database = disposableDatabase();
    const report = await ingestJobPosting(input(HEADED_BULLETS), { database });

    expect(report.status).toBe("CREATED");
    expect(report.rejectedSpans).toBe(0);
    expect(report.hardRequirements).toBeGreaterThan(0);
    expect(report.statedConstraints).toContain("authorization");
    expect(report.statedConstraints).toContain("sponsorship");

    const [posting] = getJobWorkspace(database).postings;
    expect(posting.source.applicationType).toBe("HANDSHAKE_INTERNAL");
    expect(posting.employmentType).toBe("INTERNSHIP");
    expect(posting.constraints.sponsorship?.sponsorshipAvailable).toBe(false);

    const text = posting.snapshot.normalizedText;
    for (const requirement of posting.requirements) {
      expect(verifyTextSpan(text, requirement.span), requirement.text).toBe(true);
    }
    for (const technology of posting.technologies) {
      expect(verifyTextSpan(text, technology.span), technology.label).toBe(true);
    }
    expect(verifyTextSpan(text, posting.constraints.authorization!.span)).toBe(true);
  });

  it("treats a re-paste of identical content as unchanged", async () => {
    const database = disposableDatabase();
    const first = await ingestJobPosting(input(HEADED_BULLETS), { database });
    const second = await ingestJobPosting(input(HEADED_BULLETS), { database });

    expect(second.status).toBe("UNCHANGED");
    expect(second.jobId).toBe(first.jobId);
    expect(getJobWorkspace(database).postings).toHaveLength(1);
  });

  it("repairs only grounded requirements on the expected non-live snapshot", async () => {
    const database = disposableDatabase();
    const paragraph = "Our interns build trading tools. Proficiency with C or C++ and Linux is preferred. Proficiency with Python is required.";
    const { jobId } = await ingestJobPosting(input(`Location: New York, NY\n${paragraph}`), { database });
    const original = getJobPosting(database, jobId)!;
    const requirements = extractDeterministically(original.snapshot.normalizedText).requirements.map((candidate) => ({
      text: candidate.text,
      category: candidate.category,
      subject: candidate.subject,
      extraction: "DETERMINISTIC" as const,
      assertion: "STATED" as const,
      confidence: candidate.confidence,
      span: candidate.span
    }));
    expect(requirements).toHaveLength(2);
    database.prepare("DELETE FROM job_requirements WHERE job_id = ?").run(jobId);

    replaceCurrentJobRequirements(database, jobId, original.snapshot.id, requirements);
    const repaired = getJobPosting(database, jobId)!;
    expect(repaired.requirements.map((requirement) => requirement.text).sort()).toEqual(requirements.map((requirement) => requirement.text).sort());
    expect(repaired.snapshot).toEqual(original.snapshot);
    expect(repaired.locations).toEqual(original.locations);
    expect(repaired.technologies).toEqual(original.technologies);
    expect(repaired.status).toBe(original.status);
    expect((database.prepare("SELECT COUNT(*) AS count FROM job_snapshots WHERE job_id = ?").get(jobId) as { count: number }).count).toBe(1);

    expect(() => replaceCurrentJobRequirements(database, jobId, "stale-snapshot", [])).toThrow(/snapshot changed/);
    expect(() => replaceCurrentJobRequirements(database, jobId, original.snapshot.id, [
      { ...requirements[0], span: { ...requirements[0].span, excerpt: "X".repeat(requirements[0].span.excerpt.length) } }
    ])).toThrow(/not grounded/);
    expect(getJobPosting(database, jobId)?.requirements).toEqual(repaired.requirements);

    setJobStatus(database, jobId, null, "SUBMITTED", "Fixture application submitted.");
    expect(() => replaceCurrentJobRequirements(database, jobId, original.snapshot.id, [])).toThrow(ProtectedJobError);
    expect(getJobPosting(database, jobId)?.requirements).toEqual(repaired.requirements);
    database.close();
  });

  it("supersedes the snapshot and re-derives dependents when the posting changes", async () => {
    const database = disposableDatabase();
    const first = await ingestJobPosting(input(HEADED_BULLETS), { database });
    const firstPosting = getJobWorkspace(database).postings[0];

    const revised = HEADED_BULLETS.replace(
      "We will not sponsor employment visas for this role.",
      "Visa sponsorship is available for this role."
    );
    const second = await ingestJobPosting(input(revised), { database });

    expect(second.status).toBe("REVISED");
    expect(second.jobId).toBe(first.jobId);

    const posting = getJobWorkspace(database).postings[0];
    expect(posting.snapshot.id).not.toBe(firstPosting.snapshot.id);
    expect(posting.snapshot.contentHash).not.toBe(firstPosting.snapshot.contentHash);
    expect(posting.constraints.sponsorship?.sponsorshipAvailable).toBe(true);

    // Exactly one current snapshot survives the revision.
    const current = database
      .prepare("SELECT COUNT(*) AS count FROM job_snapshots WHERE job_id = ? AND superseded_at IS NULL")
      .get(posting.id) as { count: number };
    expect(current.count).toBe(1);
  });

  it("protects a posting that becomes live while classification is pending", async () => {
    const database = disposableDatabase();
    const first = await ingestJobPosting(input(HEADED_BULLETS), { database });
    const original = getJobPosting(database, first.jobId)?.snapshot;
    let releaseClassification: (() => void) | undefined;
    let signalClassification: (() => void) | undefined;
    const classificationStarted = new Promise<void>((resolve) => { signalClassification = resolve; });
    const classificationGate = new Promise<void>((resolve) => { releaseClassification = resolve; });
    const delayedClassifier: RequirementClassifier = {
      method: "DETERMINISTIC",
      async classify(candidates: RequirementCandidate[]): Promise<ClassifiedRequirement[]> {
        signalClassification?.();
        await classificationGate;
        return candidates.map((candidate, index) => ({
          index,
          category: candidate.category,
          subject: candidate.subject,
          assertion: "STATED",
          confidence: candidate.confidence
        }));
      }
    };
    const revised = HEADED_BULLETS.replace("Aurora", "Nova");
    const pending = ingestJobPosting(input(revised), {
      database,
      classifier: delayedClassifier,
      protectedStatuses: new Set(["SUBMITTED"])
    });
    await classificationStarted;
    setJobStatus(database, first.jobId, null, "SUBMITTED", "Fixture approval and submission.");
    releaseClassification?.();

    await expect(pending).rejects.toThrow(ProtectedJobError);
    expect(getJobPosting(database, first.jobId)?.snapshot).toEqual(original);
    database.close();
  });

  it("stores structurally different postings against the same schema", async () => {
    const database = disposableDatabase();
    const fixtures = [
      ["https://app.joinhandshake.com/jobs/1", HEADED_BULLETS, null],
      ["https://jobs.lever.co/vesper/2", PROSE_STYLE, null],
      ["https://boards.greenhouse.io/tidepool/3", SPARSE, null],
      // Handshake "Apply Externally" pointing at a non-ATS employer page.
      ["https://app.joinhandshake.com/jobs/4", MIXED_CUES, "https://northwind.example/careers/4"]
    ] as const;

    for (const [sourceUrl, content, externalApplicationUrl] of fixtures) {
      await ingestJobPosting(input(content, { sourceUrl, externalApplicationUrl }), { database });
    }

    const summaries = listJobSummaries(database);
    expect(summaries).toHaveLength(4);
    for (const summary of summaries) {
      expect(summary.primaryLocation.length).toBeGreaterThan(0);
      expect(summary.status).toBe("DISCOVERED");
    }

    const postings = getJobWorkspace(database).postings;
    expect(postings.map((posting) => posting.source.applicationType).sort()).toEqual([
      "EMPLOYER_SITE", "EXTERNAL_ATS", "EXTERNAL_ATS", "HANDSHAKE_INTERNAL"
    ]);
    // The sparse posting states nothing about eligibility, and stays that way.
    const sparse = postings.find((posting) => posting.source.sourceUrl.includes("tidepool"))!;
    expect(Object.values(sparse.constraints).every((constraint) => constraint === null)).toBe(true);
  });
});

describe("classifier safety boundary", () => {
  it("forces an inferred classification down to preferred", async () => {
    const database = disposableDatabase();
    const overreaching: RequirementClassifier = {
      method: "MODEL",
      async classify(candidates: RequirementCandidate[]): Promise<ClassifiedRequirement[]> {
        return candidates.map((candidate, index) => ({
          index,
          category: "HARD" as const,
          subject: candidate.subject,
          assertion: "INFERRED" as const,
          confidence: 1
        }));
      }
    };

    const report = await ingestJobPosting(input(HEADED_BULLETS), { database, classifier: overreaching });
    expect(report.hardRequirements).toBe(0);

    const posting = getJobWorkspace(database).postings[0];
    expect(posting.requirements.length).toBeGreaterThan(0);
    expect(posting.requirements.every((requirement) => requirement.category === "PREFERRED")).toBe(true);
    expect(posting.requirements.every((requirement) => requirement.assertion === "INFERRED")).toBe(true);
  });

  it("holds the posting instead of keeping rule labels when a model classifier invents indices", async () => {
    const database = disposableDatabase();
    const fabricating: RequirementClassifier = {
      method: "MODEL",
      async classify(): Promise<ClassifiedRequirement[]> {
        return [
          { index: 999, category: "HARD", subject: "SKILL", assertion: "STATED", confidence: 1 },
          { index: -1, category: "HARD", subject: "SKILL", assertion: "STATED", confidence: 1 }
        ];
      }
    };

    const report = await ingestJobPosting(input(HEADED_BULLETS), { database, classifier: fabricating });
    const posting = getJobWorkspace(database).postings[0];

    expect(report.rejectedSpans).toBe(0);
    expect(report.requirementLabelsPending).toMatch(/AI requirement labels unavailable; will retry/);
    // No rule label stands in for the missing model labels.
    expect(posting.requirements).toHaveLength(0);
    expect(getRequirementLabelHold(database, report.jobId)?.reason).toBe(report.requirementLabelsPending);
  });

  it("records cost attribution only when a model actually runs", async () => {
    const database = disposableDatabase();
    await ingestJobPosting(input(HEADED_BULLETS), { database });
    expect(summarizeModelInvocations(database).invocations).toBe(0);
  });
});

it("preserves employer dates through ingestion and metadata-only unchanged content", async () => {
  const database = disposableDatabase();
  const first = await ingestJobPosting(input(HEADED_BULLETS), { database });
  const before = getJobPosting(database, first.jobId)!;
  const publication = { postedAt: "2026-09-01T12:00:00.000Z", sourceUrl: SOURCE, field: "first_published", precision: "timestamp" };
  const result = await ingestJobPosting(input(HEADED_BULLETS, { publication }), { database });
  expect(result.status).toBe("UNCHANGED");
  expect(getJobPosting(database, first.jobId)!.publication).toEqual(publication);
  expect(getJobPosting(database, first.jobId)!.snapshot).toEqual(before.snapshot);
  expect(listJobSummaries(database)[0].publication).toEqual(publication);
  await ingestJobPosting(input(HEADED_BULLETS), { database });
  expect(getJobPosting(database, first.jobId)!.publication).toEqual(publication);
  database.close();
});
