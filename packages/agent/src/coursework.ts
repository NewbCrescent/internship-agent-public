import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  getCandidate,
  getCoursework,
  getProfileDatabase,
  LOCAL_CANDIDATE_ID,
  replaceCoursework,
  resolveProfileDataDirectory,
  sameCoursework,
  type StoredCoursework
} from "@internship-agent/db";
import {
  candidateFactSchema,
  courseStatusLabel,
  courseworkSetSchema,
  COURSEWORK_FACT_KEY,
  COURSEWORK_PROVENANCE,
  factDefinitions,
  formatCourseworkAnswer,
  workspaceProfileSchema,
  type CandidateFact,
  type CourseworkSet,
  type WorkspaceProfile
} from "@internship-agent/domain";

import { acquirePipelineLock } from "./pipeline-lock";

/**
 * `pnpm profile:coursework`: the candidate's relevant courses, entered by the
 * candidate from their own transcript (the transcript file is never read).
 * The whole file is validated before the database is opened, and the set is
 * replaced in one transaction under the pipeline lock, since a changed set
 * bumps the AI-fit context version and would make in-flight fit saves fail.
 */

/**
 * The "Relevant coursework" answer as a schema-valid fact built from the saved
 * courses. It is never a candidate_facts row; null when no course is saved.
 */
export function courseworkAnswerFact(database: DatabaseSync, candidateId: string = LOCAL_CANDIDATE_ID): CandidateFact | null {
  const set = getCoursework(database, candidateId);
  if (!set) return null;
  const definition = factDefinitions[COURSEWORK_FACT_KEY];
  return candidateFactSchema.parse({
    id: `coursework:${candidateId}`,
    candidateId,
    key: COURSEWORK_FACT_KEY,
    scope: { kind: "global" },
    value: formatCourseworkAnswer(set.courses),
    valueType: "text",
    source: "user",
    sourceDetail: { kind: "profile", question: COURSEWORK_PROVENANCE },
    confidence: 1,
    sensitivity: definition.sensitivity,
    reusePolicy: definition.reusePolicy,
    rememberedAt: set.updatedAt,
    createdAt: set.updatedAt,
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  });
}

function courseLine(course: CourseworkSet["courses"][number]): string {
  return `${course.code}: ${course.title} (${course.term}, ${courseStatusLabel(course.status)})`;
}

/** What saving `next` over `current` changes, as unprefixed lines. */
export function describeCourseworkChange(current: StoredCoursework | null, next: CourseworkSet): string[] {
  const lines: string[] = [];
  if (next.school) {
    if (!current) lines.push(`school: ${next.school}`);
    else if (current.school !== next.school) lines.push(`school: ${current.school} -> ${next.school}`);
  }
  const currentCourses = current?.courses ?? [];
  const byCode = (code: string) => code.toLocaleLowerCase("en-US");
  const currentByCode = new Map(currentCourses.map((course) => [byCode(course.code), course]));
  const nextCodes = new Set(next.courses.map((course) => byCode(course.code)));
  for (const course of next.courses) {
    if (!currentByCode.has(byCode(course.code))) lines.push(`added ${courseLine(course)}`);
  }
  for (const course of next.courses) {
    const before = currentByCode.get(byCode(course.code));
    if (!before) continue;
    if (before.code !== course.code || before.title !== course.title || before.term !== course.term || before.status !== course.status) {
      lines.push(`changed ${courseLine(course)}`);
    }
  }
  for (const course of currentCourses) {
    if (!nextCodes.has(byCode(course.code))) lines.push(`removed ${course.code}: ${course.title}`);
  }
  if (lines.length === 0 && !sameCoursework(current, next)) lines.push("reordered courses");
  return lines;
}

function summary(set: CourseworkSet): string {
  const completed = set.courses.filter((course) => course.status === "completed").length;
  return `${set.courses.length} courses (${completed} completed, ${set.courses.length - completed} in progress)`;
}

/** Saves the file's set (unless dry run) and returns the lines to print. */
export function applyCourseworkFile(
  database: DatabaseSync,
  file: CourseworkSet,
  options: { dryRun: boolean; candidateId?: string }
): string[] {
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const current = getCoursework(database, candidateId);
  const answerLine = `answer: ${formatCourseworkAnswer(file.courses) ?? "none"}`;
  if (sameCoursework(current, file)) return [`unchanged: ${summary(file)}`, answerLine];
  const changes = describeCourseworkChange(current, file);
  const prefix = options.dryRun ? "would " : "";
  if (!options.dryRun) replaceCoursework(database, candidateId, file);
  return [
    ...changes.map((line) => `${prefix}${line}`),
    file.courses.length === 0 ? `${prefix}cleared all courses` : `${prefix}saved ${summary(file)}`,
    answerLine
  ];
}

export function listCourseworkLines(database: DatabaseSync, candidateId: string = LOCAL_CANDIDATE_ID): string[] {
  const set = getCoursework(database, candidateId);
  if (!set) return ["No coursework is saved for this workspace."];
  return [
    `school: ${set.school}`,
    ...set.courses.map((course) => `${course.code} | ${course.title} | ${course.term} | ${courseStatusLabel(course.status)}`),
    `answer: ${formatCourseworkAnswer(set.courses) ?? "none"}`
  ];
}

export type ProfileCourseworkDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  readFile(path: string): string;
  log(line: string): void;
  /** Takes the workspace's pipeline lock; returns its release function. */
  lock(profile: WorkspaceProfile): () => void;
};

const USAGE = "Usage: pnpm profile:coursework --profile real|demo [--list | --set-file <coursework.json> [--dry-run]]";

type ParsedArgs = { profile: WorkspaceProfile; setFile: string | null; dryRun: boolean };

function parseArgs(argv: string[]): ParsedArgs | null {
  let profile: string | null = null;
  let setFile: string | null = null;
  let list = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = argv[++index] ?? null;
      if (!profile) return null;
    } else if (arg === "--set-file") {
      setFile = argv[++index] ?? null;
      if (!setFile) return null;
    } else if (arg === "--list") list = true;
    else if (arg === "--dry-run") dryRun = true;
    else return null;
  }
  if (list && setFile) return null;
  if (dryRun && !setFile) return null;
  const parsed = workspaceProfileSchema.safeParse(profile);
  return parsed.success ? { profile: parsed.data, setFile, dryRun } : null;
}

export async function runProfileCoursework(argv: string[], deps: Partial<ProfileCourseworkDeps> = {}): Promise<number> {
  const io: ProfileCourseworkDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    readFile: deps.readFile ?? ((path) => readFileSync(path, "utf8")),
    log: deps.log ?? ((line) => console.log(line)),
    lock: deps.lock ?? ((profile) => acquirePipelineLock(resolveProfileDataDirectory(profile)))
  };
  const args = parseArgs(argv);
  if (!args) {
    io.log(USAGE);
    return 2;
  }

  // The whole file is validated before the database is opened.
  let file: CourseworkSet | null = null;
  if (args.setFile) {
    let text: string;
    try {
      text = io.readFile(args.setFile);
    } catch {
      io.log("The coursework file could not be read.");
      return 1;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      io.log("The coursework file is not valid JSON.");
      return 1;
    }
    const parsed = courseworkSetSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        io.log(`Invalid coursework file at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      return 1;
    }
    file = parsed.data;
  }

  const database = io.open(args.profile);
  try {
    if (!file) {
      for (const line of listCourseworkLines(database)) io.log(line);
      return 0;
    }
    if (!getCandidate(database, LOCAL_CANDIDATE_ID)) {
      io.log("Save the candidate profile first.");
      return 1;
    }
    let release: (() => void) | null = null;
    if (!args.dryRun) {
      try {
        release = io.lock(args.profile);
      } catch (error) {
        io.log(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    try {
      for (const line of applyCourseworkFile(database, file, { dryRun: args.dryRun })) io.log(line);
      return 0;
    } finally {
      release?.();
    }
  } finally {
    io.close(args.profile);
  }
}
