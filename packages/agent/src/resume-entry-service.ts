import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  approveResumeEntryRevision,
  archiveResumeEntry,
  createResumeEntry,
  getCandidate,
  getDatabase,
  getResumeEntry,
  listResumeEntries,
  LOCAL_CANDIDATE_ID,
  moveResumeEntry,
  setResumeEntryInWorkHistory,
  setResumeEntryOnResume,
  reviseResumeEntry
} from "@internship-agent/db";
import {
  RESUME_SKILLS_LINE_MAX,
  resumeEntryContentSchema,
  resumeSectionSchema,
  resumeSkillsLine,
  type ResumeDocument,
  type ResumeEntry,
  type ResumeEntryContentInput,
  type ResumeEntrySource,
  type ResumeSection
} from "@internship-agent/domain";
import { renderHtmlToPdf, resolveDataDir } from "@internship-agent/browser";
import { buildResumeDocument, renderResumeDocumentHtml } from "@internship-agent/resume";

/**
 * Resume entries are the candidate's own words. Entries the candidate types
 * are approved on save. Entries transcribed from a base resume stay PENDING
 * until the candidate approves them, and only approved entries reach a
 * generated resume.
 */
export function listCandidateResumeEntries(
  database: DatabaseSync = getDatabase(),
  candidateId = LOCAL_CANDIDATE_ID
): ResumeEntry[] {
  return listResumeEntries(database, candidateId);
}

export function addResumeEntry(
  section: ResumeSection,
  content: ResumeEntryContentInput,
  options: { database?: DatabaseSync; candidateId?: string; source?: ResumeEntrySource } = {}
): ResumeEntry {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const parsedSection = resumeSectionSchema.parse(section);
  const source = options.source ?? { kind: "user" };
  requireCandidate(database, candidateId);
  return createResumeEntry(database, {
    candidateId,
    section: parsedSection,
    content: validated(parsedSection, content),
    source,
    reviewStatus: source.kind === "user" ? "APPROVED" : "PENDING"
  });
}

/** Saves the candidate's edit as a new, approved revision. */
export function editResumeEntry(
  entryId: string,
  content: ResumeEntryContentInput,
  options: { database?: DatabaseSync; candidateId?: string } = {}
): ResumeEntry {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const entry = getResumeEntry(database, entryId);
  if (!entry || entry.candidateId !== candidateId) throw new Error("The resume entry is unknown.");
  return reviseResumeEntry(database, {
    entryId,
    candidateId,
    content: validated(entry.section, content),
    source: { kind: "user" },
    reviewStatus: "APPROVED"
  });
}

export function approveResumeEntry(
  entryId: string,
  revisionId: string,
  options: { database?: DatabaseSync; candidateId?: string } = {}
): boolean {
  return approveResumeEntryRevision(options.database ?? getDatabase(), {
    entryId,
    revisionId,
    candidateId: options.candidateId ?? LOCAL_CANDIDATE_ID
  });
}

export function archiveCandidateResumeEntry(entryId: string, database: DatabaseSync = getDatabase()): boolean {
  return archiveResumeEntry(database, entryId, LOCAL_CANDIDATE_ID);
}

/** Chooses whether an entry prints on the resume; it stays library content either way. */
export function setCandidateResumeEntryOnResume(
  entryId: string,
  onResume: boolean,
  database: DatabaseSync = getDatabase()
): boolean {
  return setResumeEntryOnResume(database, entryId, LOCAL_CANDIDATE_ID, onResume);
}

/** Chooses whether an experience entry is listed in application work history (Workday's My Experience). */
export function setCandidateResumeEntryInWorkHistory(
  entryId: string,
  include: boolean,
  database: DatabaseSync = getDatabase()
): boolean {
  return setResumeEntryInWorkHistory(database, entryId, LOCAL_CANDIDATE_ID, include);
}

export function moveCandidateResumeEntry(
  entryId: string,
  direction: "up" | "down",
  database: DatabaseSync = getDatabase()
): boolean {
  return moveResumeEntry(database, entryId, LOCAL_CANDIDATE_ID, direction);
}

/** The structured resume the candidate's approved entries produce right now. */
export function getCandidateResumeDocument(
  database: DatabaseSync = getDatabase(),
  candidateId = LOCAL_CANDIDATE_ID
): ResumeDocument | null {
  const profile = getCandidate(database, candidateId);
  return profile ? buildResumeDocument(profile, listResumeEntries(database, candidateId)) : null;
}

/**
 * Prints the current structured resume to the profile's data directory for
 * the candidate to inspect. Returns the PDF bytes and page count.
 */
export async function renderCandidateResumePreview(options: {
  database?: DatabaseSync;
  dataDir?: string;
  renderPdf?: (html: string, outputPath: string) => Promise<{ pages: number }>;
} = {}): Promise<{ bytes: Uint8Array; pages: number } | null> {
  const document = getCandidateResumeDocument(options.database ?? getDatabase());
  if (!document) return null;
  const path = join(resolveDataDir(options.dataDir), "resume-preview.pdf");
  const { pages } = await (options.renderPdf ?? renderHtmlToPdf)(renderResumeDocumentHtml(document), path);
  return { bytes: new Uint8Array(readFileSync(path)), pages };
}

function validated(section: ResumeSection, content: ResumeEntryContentInput): ResumeEntryContentInput {
  const parsed = resumeEntryContentSchema.parse(content);
  if (section === "skills") {
    if (parsed.bullets.length === 0) throw new Error("A skills group needs at least one item.");
    if (parsed.role || parsed.linkUrl || parsed.location || parsed.dateText) {
      throw new Error("Skills groups carry only a label and items.");
    }
    if (resumeSkillsLine(parsed).length > RESUME_SKILLS_LINE_MAX) {
      throw new Error(`A skills line is limited to ${RESUME_SKILLS_LINE_MAX} characters; split the group.`);
    }
  }
  if (section === "project" && parsed.role) throw new Error("Projects do not carry a role.");
  return parsed;
}

function requireCandidate(database: DatabaseSync, candidateId: string): void {
  if (!getCandidate(database, candidateId)) throw new Error("Create the profile before adding resume entries.");
}
