import { z } from "zod";

import type { CandidateFactKey } from "./candidate-facts";

/**
 * The candidate's relevant courses, entered by the candidate from their own
 * transcript with `pnpm profile:coursework` (the transcript file is never
 * read). Each course is a code, title, term, and completed or in progress;
 * no grades and no student ID.
 */

/** The derived fact key whose answer is built from candidate_coursework; never stored in candidate_facts. */
export const COURSEWORK_FACT_KEY = "relevant_coursework" as const satisfies CandidateFactKey;
/** Provenance of every stored course. */
export const COURSEWORK_PROVENANCE = "Candidate-confirmed from transcript: entered by the candidate with pnpm profile:coursework (the transcript file is never read).";
export const MAX_COURSES = 40;

const NO_ID = (value: string) => !/\d{8,}/.test(value);
const field = (max: number) => z.string().trim().min(1).max(max)
  .refine(NO_ID, "Looks like an ID number; coursework never carries IDs.")
  .transform((value) => value.replace(/\s+/g, " "));

export const courseStatusSchema = z.enum(["completed", "in_progress"]);

/** Strict: a "grade" (or any other) key is rejected. */
export const courseSchema = z.object({
  code: field(40),
  title: field(160),
  term: field(40),
  status: courseStatusSchema
}).strict();

export const courseworkSetSchema = z.object({
  school: field(160),
  courses: z.array(courseSchema).max(MAX_COURSES)
}).strict().superRefine((set, context) => {
  const seen = new Set<string>();
  set.courses.forEach((course, index) => {
    // The same key as the evidence ID, so every course cites uniquely.
    const key = courseEvidenceId(course.code);
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["courses", index, "code"], message: `Duplicate course code ${course.code}.` });
    seen.add(key);
  });
});

export type CourseStatus = z.infer<typeof courseStatusSchema>;
export type Course = z.infer<typeof courseSchema>;
export type CourseworkSet = z.infer<typeof courseworkSetSchema>;

export function courseStatusLabel(status: CourseStatus): string {
  return status === "completed" ? "completed" : "in progress";
}

/** "CS 61B" -> "course:CS-61B". */
export function courseEvidenceId(code: string): string {
  return `course:${code.trim().toLocaleUpperCase("en-US").replace(/\s+/g, "-")}`;
}

/** Citable AI-fit evidence text for one course; no grades exist to include. */
export function courseEvidenceText(course: Course, school: string): string {
  return [
    `Course: ${course.code} ${course.title}`,
    `School: ${school}`,
    `Term: ${course.term}`,
    `Status: ${course.status === "completed" ? "completed" : "in progress (not yet completed)"}`
  ].join("\n");
}

/**
 * The free-text "Relevant coursework" answer: completed courses first, then
 * in-progress ones, each group in the candidate's stored order, joined by "; ".
 * "Data Structures (CS 61B); Machine Learning (CS 189, in progress)". Null when empty.
 */
export function formatCourseworkAnswer(courses: readonly Course[]): string | null {
  const ordered = [
    ...courses.filter((course) => course.status === "completed"),
    ...courses.filter((course) => course.status === "in_progress")
  ];
  if (ordered.length === 0) return null;
  return ordered
    .map((course) => course.status === "completed" ? `${course.title} (${course.code})` : `${course.title} (${course.code}, in progress)`)
    .join("; ");
}
