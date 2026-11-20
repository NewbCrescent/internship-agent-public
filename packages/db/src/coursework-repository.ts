import type { DatabaseSync } from "node:sqlite";

import { courseworkSetSchema, type Course, type CourseworkSet } from "@internship-agent/domain";

/**
 * The candidate's saved courses (migration 0031), in their stored order. Every
 * write bumps the AI-fit context version through the table's triggers, so a
 * changed set re-scores every fit.
 */
export type StoredCoursework = { school: string; courses: Course[]; updatedAt: string };
type CourseRow = { school: string; code: string; title: string; term: string; status: Course["status"]; updated_at: string };

export function getCoursework(database: DatabaseSync, candidateId: string): StoredCoursework | null {
  const rows = database.prepare(`
    SELECT school, code, title, term, status, updated_at FROM candidate_coursework
    WHERE candidate_id = ? ORDER BY position
  `).all(candidateId) as CourseRow[];
  if (rows.length === 0) return null;
  return {
    school: rows[0]!.school,
    updatedAt: rows[0]!.updated_at,
    courses: rows.map((row) => ({ code: row.code, title: row.title, term: row.term, status: row.status }))
  };
}

/** True when saving `next` would change nothing (exact text, same order). The CLI uses the same rule. */
export function sameCoursework(current: StoredCoursework | null, next: CourseworkSet): boolean {
  if (next.courses.length === 0) return current === null;
  if (!current || current.school !== next.school || current.courses.length !== next.courses.length) return false;
  return current.courses.every((course, index) => {
    const other = next.courses[index]!;
    return course.code === other.code && course.title === other.title && course.term === other.term && course.status === other.status;
  });
}

/**
 * Replaces the whole set in one transaction; an identical set writes nothing
 * (so it does not re-score every AI fit). An empty course list clears the set.
 */
export function replaceCoursework(
  database: DatabaseSync,
  candidateId: string,
  input: CourseworkSet
): { changed: boolean; coursework: StoredCoursework | null } {
  const parsed = courseworkSetSchema.parse(input);
  const current = getCoursework(database, candidateId);
  if (sameCoursework(current, parsed)) return { changed: false, coursework: current };
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("DELETE FROM candidate_coursework WHERE candidate_id = ?").run(candidateId);
    const insert = database.prepare(`
      INSERT INTO candidate_coursework
        (candidate_id, position, school, code, title, term, status, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate_confirmed_transcript', ?)
    `);
    parsed.courses.forEach((course, position) => {
      insert.run(candidateId, position, parsed.school, course.code, course.title, course.term, course.status, now);
    });
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return { changed: true, coursework: getCoursework(database, candidateId) };
}
