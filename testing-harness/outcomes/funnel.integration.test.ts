import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { getJobOutcomeEvents, getOutcomeRecommendations, getOutcomeStats, recordOutcome } from "@internship-agent/agent";
import { createDatabase, recordModelInvocation, setJobStatus } from "@internship-agent/db";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-outcomes-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

function trackJob(database: DatabaseSync, applicationType: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO jobs (id, company_name, title, employment_type, application_type,
      source_url, external_application_url, company_careers_url,
      status, created_at, updated_at)
    VALUES (?, 'Fixture Co', 'Software Engineering Intern', 'INTERNSHIP', ?,
      ?, NULL, NULL, 'DISCOVERED', ?, ?)
  `).run(id, applicationType, `https://example.test/jobs/${id}`, now, now);
  return id;
}

function backdate(database: DatabaseSync, jobId: string, toStatus: string, daysAgo: number) {
  const stamp = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  database.prepare(
    "UPDATE application_events SET created_at = ? WHERE job_id = ? AND to_status = ?"
  ).run(stamp, jobId, toStatus);
}

describe("outcome funnel", () => {
  it("records guarded outcomes and reports funnel, rates, and response time", () => {
    const database = disposableDatabase();
    const handshake = trackJob(database, "HANDSHAKE_INTERNAL");
    const ats = trackJob(database, "EXTERNAL_ATS");
    const site = trackJob(database, "EMPLOYER_SITE");
    const idle = trackJob(database, "UNKNOWN");

    for (const jobId of [handshake, ats, site]) {
      setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
    }
    recordOutcome(handshake, "INTERVIEW", { database, note: "Recruiter screen booked." });
    recordOutcome(handshake, "OFFER", { database });
    recordOutcome(ats, "REJECTED", { database });
    setJobStatus(database, idle, null, "QUALIFIED", "Fixture analysis.");

    backdate(database, handshake, "SUBMITTED", 10);
    backdate(database, handshake, "INTERVIEW", 7);
    backdate(database, handshake, "OFFER", 3);
    backdate(database, ats, "SUBMITTED", 5);
    backdate(database, ats, "REJECTED", 4);

    const stats = getOutcomeStats(database);
    expect(stats.funnel).toEqual({ submitted: 3, interview: 1, offer: 1, rejected: 1, withdrawn: 0 });
    expect(stats.responseRate).toBe(2 / 3);
    expect(stats.interviewRate).toBe(1 / 3);
    expect(stats.offerRate).toBe(1 / 3);
    // ((10 - 7) + (5 - 4)) / 2 responses = 2 days, up to clock skew.
    expect(stats.avgDaysToResponse !== null && Math.abs(stats.avgDaysToResponse - 2) < 0.001).toBe(true);
    expect(stats.snapshot["SUBMITTED"]).toBe(1);
    expect(stats.snapshot["OFFER"]).toBe(1);

    const handshakeRow = stats.bySource.find((row) => row.applicationType === "HANDSHAKE_INTERNAL");
    expect(handshakeRow).toMatchObject({ submitted: 1, interviews: 1, offers: 1, rejections: 0 });
    const atsRow = stats.bySource.find((row) => row.applicationType === "EXTERNAL_ATS");
    expect(atsRow).toMatchObject({ submitted: 1, interviews: 0, offers: 0, rejections: 1 });
    database.close();
  });

  it("reports null rates on an empty tracker instead of dividing by zero", () => {
    const database = disposableDatabase();
    const stats = getOutcomeStats(database);
    expect(stats.funnel).toEqual({ submitted: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 });
    expect(stats.responseRate).toBeNull();
    expect(stats.interviewRate).toBeNull();
    expect(stats.offerRate).toBeNull();
    expect(stats.avgDaysToResponse).toBeNull();
    database.close();
  });

  it("refuses outcomes off the submission path and overlong notes", () => {
    const database = disposableDatabase();
    const jobId = trackJob(database, "UNKNOWN");
    let refused = 0;
    try {
      recordOutcome(jobId, "INTERVIEW", { database });
    } catch {
      refused += 1;
    }
    setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
    try {
      recordOutcome(jobId, "OFFER", { database, note: "x".repeat(501) });
    } catch {
      refused += 1;
    }
    recordOutcome(jobId, "OFFER", { database });
    try {
      recordOutcome(jobId, "REJECTED", { database });
    } catch {
      refused += 1;
    }
    expect(refused).toBe(3);
    database.close();
  });

  it("tracks detailed employer stages without changing broad status and attributes known costs", () => {
    const database = disposableDatabase();
    const jobId = trackJob(database, "EXTERNAL_ATS");
    const sourceUrl = (database.prepare("SELECT source_url AS url FROM jobs WHERE id = ?").get(jobId) as { url: string }).url;
    setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
    recordOutcome(jobId, "OA", { database, note: "Assessment link received." });
    recordOutcome(jobId, "SCREEN", { database });
    expect((database.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("SUBMITTED");
    recordOutcome(jobId, "INTERVIEW", { database });
    recordOutcome(jobId, "FINAL", { database });
    expect(getJobOutcomeEvents(jobId, database).map((event) => event.stage)).toEqual(["OA", "SCREEN", "INTERVIEW", "FINAL"]);
    recordModelInvocation(database, {
      task: "job.requirement_classification", tier: "cheap", model: "fixture", jobId: null,
      sourceUrl, estimatedCostMicrousd: 2_000, inputTokens: 100, outputTokens: 50,
      durationMs: 1, outcome: "succeeded"
    });
    const stats = getOutcomeStats(database);
    expect(stats.detailedStages.OA).toBe(1);
    expect(stats.detailedStages.FINAL).toBe(1);
    expect(stats.byRole).toMatchObject([{ roleType: "Software engineering", submitted: 1, responses: 1, interviews: 1 }]);
    expect(stats.byVariant[0]).toMatchObject({ variant: "Unknown or manual", submitted: 1, interviews: 1 });
    expect(stats.cost.perApplicationUsd).toBe(0.002);
    expect(stats.cost.perInterviewUsd).toBe(0.002);
    const unsubmitted = trackJob(database, "UNKNOWN");
    recordModelInvocation(database, {
      task: "job.requirement_classification", tier: "cheap", model: "fixture", jobId: unsubmitted,
      estimatedCostMicrousd: 1_000, inputTokens: 100, outputTokens: 50,
      durationMs: 1, outcome: "succeeded"
    });
    expect(getOutcomeStats(database).cost.perApplicationUsd).toBe(0.003);
    recordModelInvocation(database, {
      task: "job.requirement_classification", tier: "cheap", model: "fixture", jobId,
      estimatedCostMicrousd: null, inputTokens: 10, outputTokens: 0, durationMs: 1, outcome: "failed"
    });
    expect(getOutcomeStats(database).cost.perApplicationUsd).toBeNull();
    database.close();
  });

  it("groups conversion by the submitted resume variant", () => {
    const database = disposableDatabase();
    const jobId = trackJob(database, "HANDSHAKE_INTERNAL");
    const candidateId = "fixture-candidate";
    const variantId = randomUUID();
    const packageId = randomUUID();
    const now = new Date().toISOString();
    database.prepare("INSERT INTO candidates (id, full_name, created_at, updated_at) VALUES (?, 'Fixture Candidate', ?, ?)").run(candidateId, now, now);
    database.prepare("INSERT INTO resume_variants (id, candidate_id, job_id, label, bullets_json, rendered_markdown, created_at) VALUES (?, ?, ?, 'Backend variant', '[]', '# Fixture', ?)").run(variantId, candidateId, jobId, now);
    database.prepare("INSERT INTO application_packages (id, job_id, created_at, package_json) VALUES (?, ?, ?, '{}')").run(packageId, jobId, now);
    database.prepare(`INSERT INTO browser_runs
      (id, job_id, application_url, status, package_id, variant_id, decisions_json, pauses_json, created_at, updated_at)
      VALUES (?, ?, 'https://example.test/apply', 'submitted', ?, ?, '[]', '[]', ?, ?)`)
      .run(randomUUID(), jobId, packageId, variantId, now, now);
    setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
    recordOutcome(jobId, "INTERVIEW", { database });
    expect(getOutcomeStats(database).byVariant).toMatchObject([{ variant: "Backend variant", submitted: 1, interviews: 1 }]);
    database.close();
  });

  it("suggests a role focus only with enough observed submissions and leaves preferences untouched", () => {
    const database = disposableDatabase();
    for (let index = 0; index < 10; index += 1) {
      const jobId = trackJob(database, "UNKNOWN");
      database.prepare("UPDATE jobs SET title = ? WHERE id = ?").run(index < 5 ? "Software Engineering Intern" : "Marketing Intern", jobId);
      setJobStatus(database, jobId, null, "SUBMITTED", "Fixture submission.");
      if (index < 5) recordOutcome(jobId, "RESPONSE", { database });
    }
    const suggestions = getOutcomeRecommendations(database);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].includes("5 responses from 5 submissions")).toBe(true);
    expect((database.prepare("SELECT COUNT(*) AS count FROM candidate_preferences").get() as { count: number }).count).toBe(0);
    database.close();
  });
});
