import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { draftSourcesFor } from "@internship-agent/agent";

import {
  approveResumeEntryRevision,
  archiveResumeEntry,
  createDatabase,
  createResumeEntry,
  getBaseResume,
  getBrowserSession,
  getCandidate,
  getCandidateDocument,
  getCurrentCandidateDocument,
  getCurrentBaseResume,
  getCandidatePreferences,
  getCurrentFact,
  getCurrentFacts,
  getJobPosting,
  listJobSummaries,
  LOCAL_CANDIDATE_ID,
  listCurrentBaseResumes,
  listResumeEntries,
  moveResumeEntry,
  reviseResumeEntry,
  revokeCandidateFact,
  saveCandidate,
  setResumeEntryInWorkHistory,
  setResumeEntryOnResume,
  saveBaseResume,
  saveBrowserSession,
  saveCandidateDocument,
  saveCandidateFact,
  saveCandidatePreferences,
  seedDevelopmentData
} from "@internship-agent/db";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite persistence", () => {
  it("persists the graduate-internship exclusion in one workspace only", () => {
    const selected = temporaryDatabase();
    const other = temporaryDatabase();
    seedDevelopmentData(selected.database);
    seedDevelopmentData(other.database);
    saveCandidatePreferences(selected.database, LOCAL_CANDIDATE_ID, {
      roleTypes: ["Software Engineering"],
      locations: [],
      workModes: [],
      industries: [],
      excludeGraduateOnlyInternships: true
    });
    selected.database.close();

    const reopened = createDatabase(join(selected.directory, "test.sqlite"));
    expect(getCandidatePreferences(reopened, LOCAL_CANDIDATE_ID)?.excludeGraduateOnlyInternships).toBe(true);
    expect(getCandidatePreferences(other.database, LOCAL_CANDIDATE_ID)?.excludeGraduateOnlyInternships).toBe(false);
    reopened.close();
    other.database.close();
  });

  it("migrates and seeds a fictional candidate and normalized posting", () => {
    const { database } = temporaryDatabase();
    seedDevelopmentData(database);
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)?.fullName).toBe("Jordan Rivera");
    expect(getCandidatePreferences(database, LOCAL_CANDIDATE_ID)?.roleTypes).toContain("Software Engineering");

    const summaries = listJobSummaries(database);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ primaryLocation: "Seattle, WA", status: "DISCOVERED" });
    expect(summaries[0].hardRequirementCount).toBeGreaterThan(0);

    // The rebuilt table accepts the full application state machine, so later
    // milestones do not need a second migration to move a posting forward.
    database.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("READY_FOR_REVIEW", summaries[0].id);
    expect(listJobSummaries(database)[0].status).toBe("READY_FOR_REVIEW");

    // SQLite datetime formats (e.g. from datetime('now'), 'YYYY-MM-DD HH:MM:SS')
    // are normalized so Zod datetime validation succeeds on getJobPosting and listJobSummaries.
    database.prepare("UPDATE jobs SET created_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(summaries[0].id);
    const parsedPosting = getJobPosting(database, summaries[0].id);
    expect(parsedPosting).not.toBeNull();
    expect(parsedPosting?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    expect(parsedPosting?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    const parsedSummaries = listJobSummaries(database);
    expect(parsedSummaries[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

    database.close();
  });

  it("preserves fact revisions and supports revocation", () => {
    const { database } = temporaryDatabase();
    seedDevelopmentData(database);
    const base = {
      candidateId: LOCAL_CANDIDATE_ID,
      key: "willing_to_relocate" as const,
      scope: { kind: "location" as const, name: "Seattle" },
      source: "user" as const,
      sourceDetail: { kind: "remembered_answer" as const, question: "Relocate to Seattle?" },
      confidence: 1,
      rememberedAt: "2026-09-22T12:00:00.000Z"
    };
    const first = saveCandidateFact(database, { ...base, value: true });
    const second = saveCandidateFact(database, { ...base, value: false });

    expect(getCurrentFact(database, LOCAL_CANDIDATE_ID, base.key, base.scope)?.value).toBe(false);
    const history = database.prepare("SELECT * FROM candidate_facts ORDER BY created_at").all();
    expect(history).toHaveLength(2);
    expect(getCurrentFacts(database, LOCAL_CANDIDATE_ID)).toHaveLength(1);
    expect(revokeCandidateFact(database, LOCAL_CANDIDATE_ID, second.id)).toBe(true);
    expect(getCurrentFacts(database, LOCAL_CANDIDATE_ID)).toHaveLength(0);
    expect(first.id).not.toBe(second.id);
    database.close();
  });
});

describe("base resumes and browser sessions", () => {
  function resume(id: string, channel: "default" | "handshake_internal", createdAt: string) {
    return {
      id,
      candidateId: LOCAL_CANDIDATE_ID,
      channel,
      label: `${channel} resume`,
      fileName: `${id}.pdf`,
      originalName: "resume.pdf",
      sha256: "a".repeat(64),
      byteSize: 1024,
      createdAt,
      supersededAt: null
    };
  }

  it("keeps one current resume per channel and supersedes older ones", () => {
    const { database } = temporaryDatabase();
    seedDevelopmentData(database);
    saveBaseResume(database, resume("11111111-1111-4111-8111-111111111111", "handshake_internal", "2026-09-22T12:00:00.000Z"));
    saveBaseResume(database, resume("22222222-2222-4222-8222-222222222222", "default", "2026-09-22T12:01:00.000Z"));
    saveBaseResume(database, resume("33333333-3333-4333-8333-333333333333", "handshake_internal", "2026-09-22T12:02:00.000Z"));

    expect(getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "handshake_internal")?.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, "default")?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(listCurrentBaseResumes(database, LOCAL_CANDIDATE_ID)).toHaveLength(2);
    // Superseded rows stay for history.
    expect(getBaseResume(database, "11111111-1111-4111-8111-111111111111")?.supersededAt).toBe("2026-09-22T12:02:00.000Z");
    database.close();
  });

  it("keeps one current transcript and supersedes older ones", () => {
    const { database } = temporaryDatabase();
    seedDevelopmentData(database);
    const document = (id: string, createdAt: string) => ({
      id, candidateId: LOCAL_CANDIDATE_ID, kind: "transcript" as const, label: "Transcript", fileName: `${id}.pdf`,
      originalName: "transcript.pdf", sha256: "d".repeat(64), byteSize: 2048, createdAt, supersededAt: null
    });
    saveCandidateDocument(database, document("44444444-4444-4444-8444-444444444444", "2026-09-22T12:00:00.000Z"));
    saveCandidateDocument(database, document("55555555-5555-4555-8555-555555555555", "2026-09-22T12:01:00.000Z"));
    expect(getCurrentCandidateDocument(database, LOCAL_CANDIDATE_ID, "transcript")?.id).toBe("55555555-5555-4555-8555-555555555555");
    expect(getCandidateDocument(database, "44444444-4444-4444-8444-444444444444")?.supersededAt).toBe("2026-09-22T12:01:00.000Z");
    database.close();
  });

  it("upserts the last observed Handshake session", () => {
    const { database } = temporaryDatabase();
    expect(getBrowserSession(database, "handshake")).toBe(null);
    saveBrowserSession(database, { site: "handshake", status: "signed_out", detail: "Login page.", checkedAt: "2026-09-22T12:00:00.000Z" });
    saveBrowserSession(database, { site: "handshake", status: "connected", detail: "Signed in.", checkedAt: "2026-09-22T12:05:00.000Z" });
    expect(getBrowserSession(database, "handshake")).toMatchObject({ status: "connected", checkedAt: "2026-09-22T12:05:00.000Z" });
    database.close();
  });
});

describe("resume entries", () => {
  const content = (title: string, bullets = ["A verbatim bullet."]) => ({
    title, role: null, linkLabel: null, linkUrl: null, location: null, dateText: null, bullets
  });

  it("seeds fictional entries once and keeps them approved", () => {
    const { database } = temporaryDatabase();
    seedDevelopmentData(database);
    seedDevelopmentData(database);
    const entries = listResumeEntries(database, LOCAL_CANDIDATE_ID);
    expect(entries.map((entry) => entry.section)).toEqual(["experience", "project", "skills"]);
    expect(entries.every((entry) => entry.current.reviewStatus === "APPROVED")).toBe(true);
    database.close();
  });

  it("chooses resume entries without new revisions, and keeps library entries as drafting material", () => {
    const { database } = temporaryDatabase();
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera" });
    const entry = createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "experience", source: { kind: "user" }, reviewStatus: "APPROVED",
      content: { ...content("Library Co"), role: "Tutor" }
    });
    expect(entry.onResume).toBe(true);
    expect(setResumeEntryOnResume(database, entry.id, LOCAL_CANDIDATE_ID, false)).toBe(true);
    const [stored] = listResumeEntries(database, LOCAL_CANDIDATE_ID);
    expect(stored).toMatchObject({ onResume: false, current: { id: entry.current.id } });
    expect(draftSourcesFor(database, LOCAL_CANDIDATE_ID).map((source) => source.id)).toContain(`resume:${entry.id}`);
    expect(setResumeEntryOnResume(database, entry.id, "someone-else", true)).toBe(false);
    database.close();
  });

  it("stores the high school and which experience entries join application work history", () => {
    const { database } = temporaryDatabase();
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", highSchoolName: "Northwind High School", highSchoolStartYear: "2021", highSchoolEndYear: "2025" });
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)).toMatchObject({ highSchoolName: "Northwind High School", highSchoolStartYear: "2021", highSchoolEndYear: "2025" });
    expect(() => saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", highSchoolStartYear: "21" })).toThrow(/year like 2021/);

    const job = createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "experience", source: { kind: "user" }, reviewStatus: "APPROVED", content: { ...content("History Co"), role: "Tutor" }
    });
    const project = createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "project", source: { kind: "user" }, reviewStatus: "APPROVED", content: content("Side Project")
    });
    // Off by default and independent of printing; only experience entries can join.
    expect(job.inWorkHistory).toBe(false);
    expect(setResumeEntryInWorkHistory(database, job.id, LOCAL_CANDIDATE_ID, true)).toBe(true);
    expect(setResumeEntryInWorkHistory(database, project.id, LOCAL_CANDIDATE_ID, true)).toBe(false);
    expect(setResumeEntryInWorkHistory(database, job.id, "someone-else", false)).toBe(false);
    const stored = listResumeEntries(database, LOCAL_CANDIDATE_ID).find((entry) => entry.id === job.id);
    expect(stored).toMatchObject({ inWorkHistory: true, onResume: true, current: { id: job.current.id } });
    database.close();
  });

  it("stores structured work dates per revision and rejects impossible ones", () => {
    const { database } = temporaryDatabase();
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera" });
    // Work dates are structured, stored per revision, and validated; the printed date text is untouched.
    const dated = createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "experience", source: { kind: "user" }, reviewStatus: "APPROVED",
      content: { ...content("Dated Co"), role: "Intern", dateText: "2025", startMonth: "2025-06", endMonth: "2025-08" }
    });
    expect(dated.current).toMatchObject({ dateText: "2025", startMonth: "2025-06", endMonth: "2025-08", isCurrent: false });
    expect(() => createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "experience", source: { kind: "user" }, reviewStatus: "APPROVED",
      content: { ...content("Backwards Co"), startMonth: "2025-08", endMonth: "2025-06" }
    })).toThrow();
    expect(() => createResumeEntry(database, {
      candidateId: LOCAL_CANDIDATE_ID, section: "experience", source: { kind: "user" }, reviewStatus: "APPROVED",
      content: { ...content("Current Co"), isCurrent: true, endMonth: "2025-06" }
    })).toThrow();
    database.close();
  });

  it("revises, approves only the current revision, reorders, and archives", () => {
    const { database } = temporaryDatabase();
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", gpa: "3.691" });
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)?.gpa).toBe("3.691");
    // Contact details round-trip exactly as entered, and stay absent until entered.
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)?.legalFirstName).toBeUndefined();
    const contact = {
      legalFirstName: "Jordan", legalLastName: "Rivera-Park", addressLine1: "100 Fixture Way", addressLine2: "Apt 2",
      addressCity: "Seattle", addressRegion: "Washington", addressPostalCode: "98101", addressCountry: "United States of America"
    };
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", gpa: "3.691", ...contact });
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)).toMatchObject(contact);
    saveCandidate(database, LOCAL_CANDIDATE_ID, { fullName: "Jordan Rivera", ...contact, phoneType: "Mobile", fieldOfStudy: "Computer Science", educationStartMonth: "2024-08" });
    expect(getCandidate(database, LOCAL_CANDIDATE_ID)).toMatchObject({ phoneType: "Mobile", fieldOfStudy: "Computer Science", educationStartMonth: "2024-08" });
    const source = { kind: "base_resume" as const, baseResumeId: "11111111-1111-4111-8111-111111111111", sha256: "b".repeat(64) };
    const first = createResumeEntry(database, { candidateId: LOCAL_CANDIDATE_ID, section: "project", content: content("First"), source, reviewStatus: "PENDING" });
    const second = createResumeEntry(database, { candidateId: LOCAL_CANDIDATE_ID, section: "project", content: content("Second"), source, reviewStatus: "PENDING" });
    expect([first.position, second.position]).toEqual([0, 1]);

    const revised = reviseResumeEntry(database, {
      entryId: first.id, candidateId: LOCAL_CANDIDATE_ID, content: content("First", ["Edited."]), source: { kind: "user" }, reviewStatus: "APPROVED"
    });
    expect(revised.current.id).not.toBe(first.current.id);
    expect(revised.current.reviewStatus).toBe("APPROVED");
    // A stale revision can no longer be approved.
    expect(approveResumeEntryRevision(database, { entryId: first.id, revisionId: first.current.id, candidateId: LOCAL_CANDIDATE_ID })).toBe(false);
    expect(approveResumeEntryRevision(database, { entryId: second.id, revisionId: second.current.id, candidateId: LOCAL_CANDIDATE_ID })).toBe(true);
    const superseded = database.prepare("SELECT COUNT(*) AS count FROM resume_entry_revisions WHERE entry_id = ? AND superseded_at IS NOT NULL").get(first.id) as { count: number };
    expect(superseded.count).toBe(1);

    expect(moveResumeEntry(database, second.id, LOCAL_CANDIDATE_ID, "up")).toBe(true);
    expect(listResumeEntries(database, LOCAL_CANDIDATE_ID).map((entry) => entry.current.title)).toEqual(["Second", "First"]);
    expect(moveResumeEntry(database, second.id, LOCAL_CANDIDATE_ID, "up")).toBe(false);

    expect(archiveResumeEntry(database, second.id, LOCAL_CANDIDATE_ID)).toBe(true);
    expect(listResumeEntries(database, LOCAL_CANDIDATE_ID).map((entry) => entry.current.title)).toEqual(["First"]);
    expect(() => reviseResumeEntry(database, {
      entryId: second.id, candidateId: LOCAL_CANDIDATE_ID, content: content("Second"), source: { kind: "user" }, reviewStatus: "APPROVED"
    })).toThrow(/archived/);
    database.close();
  });
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "internship-agent-db-"));
  temporaryDirectories.push(directory);
  return { directory, database: createDatabase(join(directory, "test.sqlite")) };
}
