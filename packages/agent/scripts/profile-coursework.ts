/**
 * Saves the candidate's relevant courses, entered by the candidate from their
 * own transcript (the transcript file is never read): code, title, term, and
 * completed or in_progress. No grades, no student ID. The whole file is
 * validated before anything is written, and the set is replaced in one
 * transaction. A changed set marks every AI fit out of date.
 *
 * Usage: pnpm profile:coursework --profile real|demo [--list | --set-file <coursework.json> [--dry-run]]
 * Without --set-file (or with --list) it lists the saved courses.
 *
 * File shape (placeholders, not real values):
 * { "school": "<school>", "courses": [{ "code": "<DEPT 101>", "title": "<course title>", "term": "<Fall 2025>", "status": "completed | in_progress" }] }
 */
import { runProfileCoursework } from "../src/coursework";

process.exitCode = await runProfileCoursework(process.argv.slice(2));
