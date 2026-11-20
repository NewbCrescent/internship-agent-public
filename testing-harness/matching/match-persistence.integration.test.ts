import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  getJobMatch,
  getJobPosting,
  getCandidatePreferences,
  listJobMatches,
  LOCAL_CANDIDATE_ID,
  persistNormalizedPosting,
  saveCandidateFact,
  saveCandidate,
  saveCandidatePreferences,
  seedDevelopmentData,
  archiveResumeEntry,
  createResumeEntry,
  setResumeEntryOnResume
} from "@internship-agent/db";
import { evaluateAndPersistMatch, resumeSkillsFor } from "@internship-agent/agent";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function disposableDatabase(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-matching-"));
  temporaryDirectories.push(directory);
  return createDatabase(join(directory, "test.sqlite"));
}

describe("match persistence", () => {
  it("applies a saved graduate-only exclusion to one database's matches", () => {
    const selected = disposableDatabase();
    const other = disposableDatabase();
    seedDevelopmentData(selected);
    seedDevelopmentData(other);
    const selectedJobId = getSeededJobId(selected);
    const otherJobId = getSeededJobId(other);
    selected.prepare("UPDATE jobs SET title = ? WHERE id = ?").run("PhD Research Intern", selectedJobId);
    other.prepare("UPDATE jobs SET title = ? WHERE id = ?").run("PhD Research Intern", otherJobId);
    saveCandidatePreferences(selected, LOCAL_CANDIDATE_ID, {
      roleTypes: [], locations: [], workModes: [], industries: [], excludeGraduateOnlyInternships: true
    });

    expect(getCandidatePreferences(selected, LOCAL_CANDIDATE_ID)?.excludeGraduateOnlyInternships).toBe(true);
    expect(getCandidatePreferences(other, LOCAL_CANDIDATE_ID)?.excludeGraduateOnlyInternships).toBe(false);
    const filtered = evaluateAndPersistMatch(selectedJobId, { database: selected, candidateId: LOCAL_CANDIDATE_ID });
    const unfiltered = evaluateAndPersistMatch(otherJobId, { database: other, candidateId: LOCAL_CANDIDATE_ID });
    expect(filtered.report.verdict).toBe("NOT_QUALIFIED");
    expect(getJobPosting(selected, selectedJobId)?.status).toBe("NOT_QUALIFIED");
    expect(unfiltered.report.findings.some((finding) => finding.reason.includes("saved preference"))).toBe(false);
    selected.close();
    other.close();
  });

  it("reads skills from approved resume entries and lets them meet a hard skill requirement", () => {
    const database = disposableDatabase();
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", degree: "B.A. Computer Science" });
    const entry = (section: "skills" | "experience", title: string, bullets: string[], reviewStatus: "APPROVED" | "PENDING" = "APPROVED") =>
      createResumeEntry(database, {
        candidateId: LOCAL_CANDIDATE_ID, section, source: { kind: "user" }, reviewStatus,
        content: { title, role: section === "experience" ? "Intern" : null, linkLabel: null, linkUrl: null, location: null, dateText: null, bullets }
      });
    entry("skills", "Languages", ["Python", "TypeScript"]);
    entry("skills", "Infra", ["AWS (EC2, S3)", "Linux/Unix"]);
    const library = entry("experience", "Robot Co", ["Built navigation in Rust with Docker."]);
    setResumeEntryOnResume(database, library.id, LOCAL_CANDIDATE_ID, false);
    entry("skills", "Pending", ["Haskell"], "PENDING");
    const archived = entry("skills", "Old", ["Perl"]);
    archiveResumeEntry(database, archived.id, LOCAL_CANDIDATE_ID);

    const skills = resumeSkillsFor(database, LOCAL_CANDIDATE_ID);
    expect(skills).toEqual(expect.arrayContaining(["Python", "TypeScript", "AWS", "EC2", "S3", "Linux", "Unix", "Rust", "Docker"]));
    expect(skills).not.toEqual(expect.arrayContaining(["Haskell"]));
    expect(skills).not.toEqual(expect.arrayContaining(["Perl"]));

    const text = "Proficiency in Python is required.";
    const { jobId } = persistNormalizedPosting(database, {
      companyName: "Fixture Co", title: "Software Intern", employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: "https://example.test/resume-skills", externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: "resume-skills", normalizedText: text, locations: [], compensation: null, technologies: [],
      requirements: [{ text, category: "HARD", subject: "SKILL", extraction: "DETERMINISTIC", assertion: "STATED", confidence: 0.9, span: { start: 0, end: text.length, excerpt: text } }],
      constraints: { graduation: null, authorization: null, sponsorship: null, availability: null }
    });
    const { report, resumeSkills } = evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
    expect(resumeSkills).toContain("Python");
    expect(report.findings[0]).toMatchObject({ outcome: "PASS", reason: "Your resume lists Python, which this requirement names." });
    expect(report.verdict).toBe("QUALIFIED");
    database.close();
  });

  it("persists a report and moves the posting to QUALIFIED", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);

    const { report } = evaluateAndPersistMatch(
      getSeededJobId(database),
      { database, candidateId: LOCAL_CANDIDATE_ID }
    );
    expect(getJobMatch(database, report.jobId)?.verdict).toBe(report.verdict);
    expect(getJobPosting(database, report.jobId)?.status).toBe(
      report.verdict === "QUALIFIED" ? "QUALIFIED" : report.verdict === "NOT_QUALIFIED" ? "NOT_QUALIFIED" : "ANALYZING"
    );
    expect(listJobMatches(database)).toHaveLength(1);
    database.close();
  });

  it("replaces the report on re-evaluation and records sponsorship failure", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    const jobId = persistSponsoredPosting(database);
    saveCandidateFact(database, {
      candidateId: LOCAL_CANDIDATE_ID,
      key: "requires_sponsorship",
      scope: { kind: "country", code: "US" },
      value: true,
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Do you require sponsorship?" },
      confidence: 1,
      rememberedAt: "2026-09-22T12:00:00.000Z"
    });

    const first = evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
    expect(first.report.verdict).toBe("NOT_QUALIFIED");
    expect(getJobPosting(database, jobId)?.status).toBe("NOT_QUALIFIED");

    saveCandidatePreferences(database, LOCAL_CANDIDATE_ID, {
      roleTypes: ["Software Engineering"],
      locations: ["Seattle, WA"],
      workModes: ["onsite"],
      industries: []
    });
    const second = evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
    expect(second.report.verdict).toBe("NOT_QUALIFIED");
    expect(listJobMatches(database).filter((match) => match.jobId === jobId)).toHaveLength(1);
    database.close();
  });

  it("clips an over-long stored constraint text on read, so the analysis still runs", () => {
    const database = disposableDatabase();
    seedDevelopmentData(database);
    // A row stored before extraction kept a window: about 900 characters of authorization text (fictional).
    const sentence = Array.from({ length: 12 }, (_, index) => `you will pair with the fixture platform team on tooling project ${index + 1}`)
      .join(", ") + ", and every applicant must be legally authorized to work in the United States";
    expect(sentence.length).toBeGreaterThan(800);
    const text = `Software Engineering Intern\n${sentence}\n`;
    const start = text.indexOf(sentence);
    const { jobId } = persistNormalizedPosting(database, {
      companyName: "Fixture Co", title: "Software Engineering Intern", employmentType: "INTERNSHIP", applicationType: "UNKNOWN",
      sourceUrl: "https://example.test/long-authorization", externalApplicationUrl: null, companyCareersUrl: null,
      contentHash: "long-authorization", normalizedText: text, locations: [], compensation: null, technologies: [], requirements: [],
      constraints: {
        graduation: null,
        authorization: {
          requiresExistingAuthorization: true, countryCode: "US", raw: sentence, extraction: "DETERMINISTIC", assertion: "STATED",
          span: { start, end: start + sentence.length, excerpt: sentence }
        },
        sponsorship: null,
        availability: null
      }
    });
    const posting = getJobPosting(database, jobId);
    expect(posting?.constraints.authorization?.raw.length).toBeLessThanOrEqual(600);
    expect(posting?.constraints.authorization?.requiresExistingAuthorization).toBe(true);
    const { report } = evaluateAndPersistMatch(jobId, { database, candidateId: LOCAL_CANDIDATE_ID });
    expect(report.jobId).toBe(jobId);
    database.close();
  });
});

function getSeededJobId(database: DatabaseSync): string {
  const row = database.prepare("SELECT id FROM jobs LIMIT 1").get() as { id: string };
  return row.id;
}

function persistSponsoredPosting(database: DatabaseSync): string {
  const text = "Software Engineering Intern. We do not sponsor visas. This is a long enough posting body to ingest.";
  const excerpt = "We do not sponsor visas.";
  const { jobId } = persistNormalizedPosting(database, {
    companyName: "Beacon Systems",
    title: "Software Engineering Intern",
    employmentType: "INTERNSHIP",
    applicationType: "HANDSHAKE_INTERNAL",
    sourceUrl: "https://app.joinhandshake.com/jobs/900002",
    externalApplicationUrl: null,
    companyCareersUrl: null,
    contentHash: "sponsored-posting",
    normalizedText: text,
    locations: [],
    compensation: null,
    requirements: [],
    technologies: [],
    constraints: {
      graduation: null,
      authorization: null,
      sponsorship: {
        sponsorshipAvailable: false,
        countryCode: "US",
        raw: excerpt,
        extraction: "DETERMINISTIC",
        assertion: "STATED",
        span: {
          start: text.indexOf(excerpt),
          end: text.indexOf(excerpt) + excerpt.length,
          excerpt
        }
      },
      availability: null
    }
  });
  return jobId;
}
