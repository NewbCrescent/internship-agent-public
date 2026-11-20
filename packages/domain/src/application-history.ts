import type { Candidate } from "./candidate";
import type { ResumeEntry } from "./resume-document";

/**
 * The work and education rows an application's history sections (Workday's
 * My Experience) receive. Every value is the candidate's own: experience
 * entries they include in work history, their high school from the profile,
 * and their college from the profile's school, degree, GPA, and graduation
 * date. Nothing here is inferred.
 */
export type MonthYear = { year: number; month: number };

export type WorkHistoryRow = {
  entryId: string;
  company: string;
  title: string;
  location: string | null;
  start: MonthYear | null;
  end: MonthYear | null;
  current: boolean;
  /** The entry's approved bullets, verbatim, one per line. */
  description: string;
};

export type EducationRow = {
  key: "college" | "high_school";
  school: string;
  level: "bachelor" | "high_school" | "other";
  /** The profile degree text ("B.A. Computer Science"), or null for high school. */
  degree: string | null;
  fieldOfStudy: string | null;
  gpa: string | null;
  startYear: number | null;
  endYear: number | null;
};

export type ApplicationHistory = { work: WorkHistoryRow[]; education: EducationRow[] };

function monthYear(value: string | null | undefined): MonthYear | null {
  const match = /^(\d{4})-(\d{2})/.exec(value ?? "");
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function year(value: string | null | undefined): number | null {
  const match = /^(\d{4})/.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Rows for one application. `graduationDate` is the answer that application
 * uses (2028 by default, 2029 on the alternate profile), so the college end
 * year always agrees with the graduation questions.
 */
export function planApplicationHistory(input: {
  entries: ResumeEntry[];
  candidate: Candidate | null;
  graduationDate: string | null;
}): ApplicationHistory {
  const work = input.entries
    .filter((entry) => entry.section === "experience" && entry.inWorkHistory && !entry.archivedAt && entry.current.reviewStatus === "APPROVED")
    .map((entry): WorkHistoryRow => ({
      entryId: entry.id,
      company: entry.current.title,
      title: entry.current.role ?? entry.current.title,
      location: entry.current.location,
      start: monthYear(entry.current.startMonth),
      end: entry.current.isCurrent ? null : monthYear(entry.current.endMonth),
      current: entry.current.isCurrent,
      description: entry.current.bullets.join("\n")
    }));

  const candidate = input.candidate;
  const education: EducationRow[] = [];
  if (candidate?.school) {
    education.push({
      key: "college",
      school: candidate.school,
      level: bachelorKind(candidate.degree ?? "") ? "bachelor" : "other",
      degree: candidate.degree ?? null,
      fieldOfStudy: candidate.fieldOfStudy ?? null,
      gpa: candidate.gpa ?? null,
      startYear: year(candidate.educationStartMonth),
      endYear: year(input.graduationDate ?? candidate.graduationDate)
    });
  }
  if (candidate?.highSchoolName) {
    education.push({
      key: "high_school",
      school: candidate.highSchoolName,
      level: "high_school",
      degree: null,
      fieldOfStudy: null,
      gpa: null,
      startYear: year(candidate.highSchoolStartYear),
      endYear: year(candidate.highSchoolEndYear)
    });
  }
  return { work, education };
}

/** Curly and modifier apostrophes (‘ ’ ʼ) as a plain "'", so "Bachelor’s" reads as "Bachelor's". */
function plainApostrophes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'");
}

/** "arts" for a B.A., "science" for a B.S., "other" for another bachelor's, null for no bachelor's. */
export function bachelorKind(value: string): "arts" | "science" | "other" | null {
  const text = plainApostrophes(value);
  if (/\bbachelor'?s?\s+of\s+arts\b|\bB\.?\s?A\b\.?(?![\w.])/i.test(text)) return "arts";
  if (/\bbachelor'?s?\s+of\s+science\b|\bB\.?\s?S\b\.?(?![\w.])|\bBSc\b/i.test(text)) return "science";
  if (/\bbachelor/i.test(text) || /\bB\.?\s?(?:Eng|FA|BA|SE)\b/i.test(text)) return "other";
  return null;
}

/**
 * The degree option for a row, or null when none fits (the run then asks).
 * A B.S. is never chosen for a B.A. or the reverse: the kind must match, or
 * the option must be a general "Bachelor's" that names no kind. Curly
 * apostrophes count as plain ones ("Bachelor’s Degree"); the option is
 * returned as offered.
 */
export function chooseDegreeOption(row: EducationRow, options: string[]): string | null {
  if (row.level === "high_school") {
    return options.find((option) => /high school|secondary|\bGED\b/i.test(option) && !/college|university|bachelor|associate|some/i.test(option)) ?? null;
  }
  if (row.level !== "bachelor" || !row.degree) return null;
  const held = bachelorKind(row.degree);
  const bachelors = options.filter((option) => bachelorKind(option) !== null && !/master|doctor|mba|ph\.?d/i.test(option));
  return bachelors.find((option) => bachelorKind(option) === held && held !== "other") ??
    bachelors.find((option) => /^\s*bachelor'?s?(?:'s)?(?:\s+degree)?\s*(?:\(.*\))?\s*$/i.test(plainApostrophes(option)) && !/\b(?:arts|science|engineering|fine)\b/i.test(option)) ??
    null;
}

const STOPWORDS = new Set(["of", "the", "at", "and", "in"]);

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/^uc\s+/, "university of california ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token));
}

/** Search words to type into a school or field prompt, most specific first. */
export function promptSearchTerms(value: string): string[] {
  const words = tokens(value);
  const expanded = /^uc\s+/i.test(value.trim()) ? `University of California, ${value.trim().replace(/^uc\s+/i, "")}` : null;
  // The full name first: search lists rarely index an abbreviation like "UC".
  return [...new Set([...(expanded ? [expanded] : []), value.trim(), words.at(-1) ?? ""])].filter(Boolean);
}

/**
 * The option with exactly the same words as `value` ("UC Berkeley" is
 * "University of California, Berkeley"), or null. Unlike matchPromptOption
 * there is no "containing" fallback, so "… Berkeley Extension" is never
 * taken for "… Berkeley".
 */
export function sameNamedOption(value: string, options: string[]): string | null {
  const wanted = sameNameKey(value);
  if (!wanted) return null;
  return options.find((option) => sameNameKey(option) === wanted) ?? null;
}

/**
 * The words a school or place name is compared by: "University of
 * California, Davis", "University of California - Davis", and "UC Davis"
 * share one key. Case, punctuation, accents, and the words of/the/at/and/in
 * are ignored.
 */
export function sameNameKey(value: string): string {
  return tokens(value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")).join(" ");
}

/**
 * A deterministic alias for lists that name only the campus: "Berkeley" for
 * "University of California, Berkeley" or "UC Berkeley". The school name is
 * split at its last ", " or " - "; the one option with the campus part's
 * words is returned, or null when none or several have them. Never "Other",
 * never a containing match.
 */
export function campusOption(school: string, options: string[]): string | null {
  const trimmed = school.trim();
  const expanded = /^uc\s+/i.test(trimmed) ? `University of California, ${trimmed.replace(/^uc\s+/i, "")}` : trimmed;
  const split = /^(.+)(?:,\s*|\s+-\s+)(.+)$/.exec(expanded);
  if (!split) return null;
  const campus = sameNameKey(split[2]!);
  if (!campus) return null;
  const matches = options.filter((option) => sameNameKey(option) === campus);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * The option naming `value`: the same words ("UC Berkeley" is "University of
 * California, Berkeley"), or else the shortest option containing all of them.
 */
export function matchPromptOption(value: string, options: string[]): string | null {
  const wanted = tokens(value);
  if (wanted.length === 0) return null;
  const same = options.find((option) => tokens(option).join(" ") === wanted.join(" "));
  if (same) return same;
  const containing = options
    .filter((option) => {
      const have = new Set(tokens(option));
      return wanted.every((token) => have.has(token)) && have.size <= wanted.length + 2;
    })
    .sort((a, b) => a.length - b.length);
  return containing[0] ?? null;
}
