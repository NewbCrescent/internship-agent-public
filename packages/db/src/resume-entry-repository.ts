import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  resumeEntryContentSchema,
  resumeEntrySchema,
  resumeEntrySourceSchema,
  type ResumeEntry,
  type ResumeEntryContentInput,
  type ResumeEntrySource,
  type ResumeReviewStatus,
  type ResumeSection
} from "@internship-agent/domain";

type EntryRow = {
  id: string;
  candidate_id: string;
  section: ResumeSection;
  position: number;
  archived_at: string | null;
  on_resume: number;
  in_work_history: number;
  created_at: string;
  revision_id: string;
  title: string;
  role: string | null;
  link_label: string | null;
  link_url: string | null;
  location: string | null;
  date_text: string | null;
  start_month: string | null;
  end_month: string | null;
  is_current: number;
  bullets_json: string;
  source_json: string;
  review_status: ResumeReviewStatus;
  approved_at: string | null;
  revision_created_at: string;
};

const ENTRY_SELECT = `
  SELECT e.id, e.candidate_id, e.section, e.position, e.archived_at, e.on_resume, e.in_work_history, e.created_at,
    r.id AS revision_id, r.title, r.role, r.link_label, r.link_url, r.location, r.date_text,
    r.start_month, r.end_month, r.is_current,
    r.bullets_json, r.source_json, r.review_status, r.approved_at, r.created_at AS revision_created_at
  FROM resume_entries e
  JOIN resume_entry_revisions r ON r.entry_id = e.id AND r.superseded_at IS NULL
`;

function parseEntry(row: EntryRow): ResumeEntry {
  return resumeEntrySchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    section: row.section,
    position: row.position,
    archivedAt: row.archived_at,
    onResume: row.on_resume === 1,
    inWorkHistory: row.in_work_history === 1,
    createdAt: row.created_at,
    current: {
      id: row.revision_id,
      entryId: row.id,
      title: row.title,
      role: row.role,
      linkLabel: row.link_label,
      linkUrl: row.link_url,
      location: row.location,
      dateText: row.date_text,
      startMonth: row.start_month,
      endMonth: row.end_month,
      isCurrent: row.is_current === 1,
      bullets: JSON.parse(row.bullets_json),
      source: JSON.parse(row.source_json),
      reviewStatus: row.review_status,
      approvedAt: row.approved_at,
      createdAt: row.revision_created_at,
      supersededAt: null
    }
  });
}

function insertRevision(
  database: DatabaseSync,
  entryId: string,
  content: ResumeEntryContentInput,
  source: ResumeEntrySource,
  reviewStatus: ResumeReviewStatus,
  now: string
): void {
  const parsed = resumeEntryContentSchema.parse(content);
  const parsedSource = resumeEntrySourceSchema.parse(source);
  database.prepare(`
    INSERT INTO resume_entry_revisions (
      id, entry_id, title, role, link_label, link_url, location, date_text,
      start_month, end_month, is_current,
      bullets_json, source_json, review_status, approved_at, created_at, superseded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    randomUUID(), entryId, parsed.title, parsed.role, parsed.linkLabel, parsed.linkUrl,
    parsed.location, parsed.dateText, parsed.startMonth, parsed.endMonth, parsed.isCurrent ? 1 : 0,
    JSON.stringify(parsed.bullets), JSON.stringify(parsedSource),
    reviewStatus, reviewStatus === "APPROVED" ? now : null, now
  );
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = work();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function createResumeEntry(
  database: DatabaseSync,
  input: {
    candidateId: string;
    section: ResumeSection;
    content: ResumeEntryContentInput;
    source: ResumeEntrySource;
    reviewStatus: ResumeReviewStatus;
  }
): ResumeEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  transaction(database, () => {
    const { next } = database.prepare(`
      SELECT COALESCE(MAX(position) + 1, 0) AS next FROM resume_entries
      WHERE candidate_id = ? AND section = ?
    `).get(input.candidateId, input.section) as { next: number };
    database.prepare(`
      INSERT INTO resume_entries (id, candidate_id, section, position, archived_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(id, input.candidateId, input.section, next, now);
    insertRevision(database, id, input.content, input.source, input.reviewStatus, now);
  });
  const saved = getResumeEntry(database, id);
  if (!saved) throw new Error("Resume entry was not persisted.");
  return saved;
}

/** Supersedes the current revision with new content. */
export function reviseResumeEntry(
  database: DatabaseSync,
  input: {
    entryId: string;
    candidateId: string;
    content: ResumeEntryContentInput;
    source: ResumeEntrySource;
    reviewStatus: ResumeReviewStatus;
  }
): ResumeEntry {
  const now = new Date().toISOString();
  transaction(database, () => {
    const entry = database.prepare("SELECT id FROM resume_entries WHERE id = ? AND candidate_id = ? AND archived_at IS NULL")
      .get(input.entryId, input.candidateId);
    if (!entry) throw new Error("The resume entry is unknown or archived.");
    database.prepare("UPDATE resume_entry_revisions SET superseded_at = ? WHERE entry_id = ? AND superseded_at IS NULL")
      .run(now, input.entryId);
    insertRevision(database, input.entryId, input.content, input.source, input.reviewStatus, now);
  });
  const saved = getResumeEntry(database, input.entryId);
  if (!saved) throw new Error("Resume entry was not persisted.");
  return saved;
}

/** Approves the named revision only if it is still the current one. */
export function approveResumeEntryRevision(
  database: DatabaseSync,
  input: { entryId: string; revisionId: string; candidateId: string }
): boolean {
  const result = database.prepare(`
    UPDATE resume_entry_revisions SET review_status = 'APPROVED', approved_at = ?
    WHERE id = ? AND entry_id = ? AND superseded_at IS NULL AND review_status = 'PENDING'
      AND entry_id IN (SELECT id FROM resume_entries WHERE candidate_id = ? AND archived_at IS NULL)
  `).run(new Date().toISOString(), input.revisionId, input.entryId, input.candidateId);
  return Number(result.changes) === 1;
}

/** Puts an entry on the printed resume or leaves it as library content. */
export function setResumeEntryOnResume(database: DatabaseSync, entryId: string, candidateId: string, onResume: boolean): boolean {
  const result = database.prepare(`
    UPDATE resume_entries SET on_resume = ? WHERE id = ? AND candidate_id = ? AND archived_at IS NULL
  `).run(onResume ? 1 : 0, entryId, candidateId);
  return Number(result.changes) === 1;
}

/** Lists an experience entry in application work-history sections (Workday's My Experience) or not. */
export function setResumeEntryInWorkHistory(database: DatabaseSync, entryId: string, candidateId: string, include: boolean): boolean {
  const result = database.prepare(`
    UPDATE resume_entries SET in_work_history = ?
    WHERE id = ? AND candidate_id = ? AND archived_at IS NULL AND section = 'experience'
  `).run(include ? 1 : 0, entryId, candidateId);
  return Number(result.changes) === 1;
}

export function archiveResumeEntry(database: DatabaseSync, entryId: string, candidateId: string): boolean {
  const result = database.prepare(`
    UPDATE resume_entries SET archived_at = ? WHERE id = ? AND candidate_id = ? AND archived_at IS NULL
  `).run(new Date().toISOString(), entryId, candidateId);
  return Number(result.changes) === 1;
}

/** Swaps an entry with its neighbor in the same section. */
export function moveResumeEntry(
  database: DatabaseSync,
  entryId: string,
  candidateId: string,
  direction: "up" | "down"
): boolean {
  return transaction(database, () => {
    const entry = database.prepare(`
      SELECT id, section, position FROM resume_entries WHERE id = ? AND candidate_id = ? AND archived_at IS NULL
    `).get(entryId, candidateId) as { id: string; section: string; position: number } | undefined;
    if (!entry) return false;
    const neighbor = database.prepare(`
      SELECT id, position FROM resume_entries
      WHERE candidate_id = ? AND section = ? AND archived_at IS NULL
        AND position ${direction === "up" ? "<" : ">"} ?
      ORDER BY position ${direction === "up" ? "DESC" : "ASC"} LIMIT 1
    `).get(candidateId, entry.section, entry.position) as { id: string; position: number } | undefined;
    if (!neighbor) return false;
    const update = database.prepare("UPDATE resume_entries SET position = ? WHERE id = ?");
    update.run(neighbor.position, entry.id);
    update.run(entry.position, neighbor.id);
    return true;
  });
}

export function getResumeEntry(database: DatabaseSync, entryId: string): ResumeEntry | null {
  const row = database.prepare(`${ENTRY_SELECT} WHERE e.id = ?`).get(entryId) as EntryRow | undefined;
  return row ? parseEntry(row) : null;
}

/** Active entries in display order: section, then position. */
export function listResumeEntries(database: DatabaseSync, candidateId: string): ResumeEntry[] {
  const rows = database.prepare(`
    ${ENTRY_SELECT}
    WHERE e.candidate_id = ? AND e.archived_at IS NULL
    ORDER BY CASE e.section WHEN 'experience' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, e.position
  `).all(candidateId) as EntryRow[];
  return rows.map(parseEntry);
}
