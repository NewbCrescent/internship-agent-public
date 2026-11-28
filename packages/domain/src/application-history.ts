import type { Candidate } from "./candidate";
import type { ResumeEntry } from "./resume-document";

/**
 * The work and education rows an application's history sections (Workday's
 * My Experience) receive. Every value is the candidate's own: experience
 * entries they include in work history, their high school from the profile,
 * and their college from the profile's school, degree, GPA, and graduation
 * date. Nothing here is inferred. The high school is listed in the
 * candidate's history, but a history section receives it only when the
 * section asks for high school or for every school attended
 * (educationRowsForSection; the candidate's rule, 2026-11-26).
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

/** The high school's place from the profile (migration 0035), when the candidate saved it. */
export type HighSchoolPlace = { city?: string; region?: string; postalCode?: string };

export function highSchoolPlaceOf(candidate: Candidate | null): HighSchoolPlace {
  return { city: candidate?.highSchoolCity, region: candidate?.highSchoolRegion, postalCode: candidate?.highSchoolPostalCode };
}

/**
 * Words that ask for the high school: "high school", "secondary school", or
 * "GED". The bare word "diploma" is not one, since Workday degree lists label
 * themselves "Degree / Diploma"; "High school diploma" still matches.
 */
const HIGH_SCHOOL_WORDS = /\b(?:high|secondary)[\s-]school\b|\bGED\b/i;

export function asksForHighSchool(label: string): boolean {
  return HIGH_SCHOOL_WORDS.test(label);
}

const ALL_SCHOOLS = /\b(?:all|every|each)\b(?:\s+\w+){0,4}?\s+(?:schools?|colleges?|universities|institutions)\b[^.?!]{0,40}\battended\b/i;

/** A label that asks for every school attended: "Please list all schools you have attended". */
export function asksForAllSchools(label: string): boolean {
  return ALL_SCHOOLS.test(label);
}

/**
 * The education rows a history section receives (the candidate's rule, 2026-11-26): every row when its label
 * asks for every school attended, only the high school when it names high school, secondary school, or GED,
 * and otherwise every row but the high school.
 */
export function educationRowsForSection(rows: EducationRow[], sectionLabel: string): EducationRow[] {
  if (asksForAllSchools(sectionLabel)) return rows;
  if (asksForHighSchool(sectionLabel)) return rows.filter((row) => row.key === "high_school");
  return rows.filter((row) => row.key !== "high_school");
}

function yearsText(row: EducationRow): string | null {
  if (row.startYear !== null && row.endYear !== null) return `${row.startYear}-${row.endYear}`;
  const one = row.startYear ?? row.endYear;
  return one === null ? null : String(one);
}

/**
 * One line per school for an "all schools attended" question, the college rows first, then the high school:
 * "<school>, <degree>, <start>-<end>" and "<high school>, <city>, <state>, <start>-<end>" (parts that are not
 * saved are left out; years: "start-end", else the one year saved). Null unless at least one college row and
 * the high-school row are present, so a partial list is never given.
 */
export function schoolsAttendedLines(rows: EducationRow[], place: HighSchoolPlace = {}): string[] | null {
  const colleges = rows.filter((row) => row.key === "college");
  const highSchool = rows.find((row) => row.key === "high_school");
  if (colleges.length === 0 || !highSchool) return null;
  const line = (parts: Array<string | null | undefined>) => parts.filter((part): part is string => Boolean(part && part.trim())).join(", ");
  return [
    ...colleges.map((row) => line([row.school, row.degree, yearsText(row)])),
    line([highSchool.school, place.city, place.region, yearsText(highSchool)])
  ];
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

/** A general "Bachelor's" that names no kind: "Bachelor's", "Bachelors Degree", "Bachelor's Level Degree" (micron.wd1). */
const GENERAL_BACHELOR = /^\s*bachelor'?s?(?:'s)?(?:\s+level)?(?:\s+degree)?\s*(?:\(.*\))?\s*$/i;

/**
 * The degree option for a row, or null when none fits (the run then asks).
 * A B.S. is never chosen for a B.A. or the reverse: the kind must match, or
 * the option must be a general "Bachelor's" that names no kind. Exactly one
 * option must fit: the one of the same kind, else the one general
 * "Bachelor's" ("Bachelor's Degree", or "Bachelor's Level Degree" on
 * micron.wd1, 2026-11-25); two options that fit equally return null so the
 * run asks, unless they are spellings of the same general answer ("Bachelors"
 * and "Bachelor's Degree", Track 87), when the first offered is chosen. A
 * list that names no bachelor's takes its one plain "Undergraduate" option
 * (Track 87). Curly
 * apostrophes count as plain ones ("Bachelor’s Degree"); the option is
 * returned as offered. A high-school row picks a high-school diploma option,
 * then a plain high-school option, then a combined "Diploma or GED" / "or
 * Equivalent" option; a GED or equivalency option alone ("GED", "GED (High
 * School Equivalent)", "High School Equivalency") is never picked for it.
 */
export function chooseDegreeOption(row: EducationRow, options: string[]): string | null {
  if (row.level === "high_school") {
    const named = options.filter((option) => /high school|secondary/i.test(option) &&
      !/college|university|bachelor|associate|\bsome\b|incomplete|in progress|not (?:yet )?complete|no diploma/i.test(option));
    const equivalency = (option: string) => /\bGED\b|HiSET|\bTASC\b|equivalen/i.test(option);
    return named.find((option) => !equivalency(option) && /diploma|graduate|complete/i.test(option)) ??
      named.find((option) => !equivalency(option)) ??
      named.find((option) => equivalency(option) && !/^\s*(?:GED|HiSET|TASC|(?:high|secondary) school equivalen)/i.test(option) && /diploma|graduate|\bor\b|\//i.test(option)) ??
      null;
  }
  if (row.level !== "bachelor" || !row.degree) return null;
  const held = bachelorKind(row.degree);
  const bachelors = [...new Set(options.filter((option) => bachelorKind(option) !== null && !/master|doctor|mba|ph\.?d/i.test(option)))];
  // Exactly one option may fit: the same kind first, else a general "Bachelor's"; two that fit equally ask.
  const sameKind = held === "other" ? [] : bachelors.filter((option) => bachelorKind(option) === held);
  if (sameKind.length) return sameKind.length === 1 ? sameKind[0]! : null;
  const general = bachelors.filter((option) => GENERAL_BACHELOR.test(plainApostrophes(option)) && !/\b(?:arts|science|engineering|fine)\b/i.test(option));
  if (general.length === 1) return general[0]!;
  // (Track 87) Spellings of the one general answer ("Bachelors" and "Bachelor's Degree" on Greenhouse's Degree list) are one
  // answer, and the first offered is chosen; options that differ in any other word ("Level", a parenthetical) still ask.
  if (general.length > 1) return new Set(general.map(generalBachelorKey)).size === 1 ? general[0]! : null;
  // (Track 87) A list naming no bachelor's at all takes its one undergraduate option when it is plain "Undergraduate";
  // two undergraduate options ("Undergraduate", "Undergraduate (4-year)") ask.
  if (bachelors.length > 0) return null;
  const undergraduate = options.filter((option) => /\bundergrad/i.test(option));
  return undergraduate.length === 1 && UNDERGRADUATE_OPTION.test(plainApostrophes(undergraduate[0]!)) ? undergraduate[0]! : null;
}

/** (Track 87) "Undergraduate", "Undergrad", "Undergraduate Degree" or "Undergraduate Student", and nothing more. */
const UNDERGRADUATE_OPTION = /^\s*undergrad(?:uate)?(?:'s)?(?:\s+(?:degree|student|program|studies|level))?\s*$/i;

/** (Track 87) A general "Bachelor's" option's words, ignoring case, apostrophes, a plural "s", and the word "Degree": "Bachelors" and "Bachelor's Degree" are both "bachelor". */
function generalBachelorKey(option: string): string {
  return plainApostrophes(option).toLocaleLowerCase("en-US").replace(/'/g, "").replace(/\bbachelors?s?\b/g, "bachelor")
    .replace(/\bdegree\b/g, " ").replace(/\s+/g, " ").trim();
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

export type SchoolRelation = "same" | "different" | "ambiguous";

const INSTITUTION_WORD = /\b(?:university|college|institute|polytechnic)\b/i;
const GENERIC_SCHOOL_WORDS = new Set(["university", "college", "institute"]);

/** "UC Springfield" read as "University of California, Springfield", as sameNameKey reads it; accents dropped. */
function expandedSchoolName(value: string): string {
  const text = plainApostrophes(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  return /^uc\s+/i.test(text) ? `University of California, ${text.replace(/^uc\s+/i, "")}` : text;
}

/** Whether a token is the initials of consecutive words of the other name ("nit" for "northwind institute technology"). */
function initialsOf(token: string, words: string[]): boolean {
  if (token.length < 2 || token.length > 8) return false;
  for (let start = 0; start + token.length <= words.length; start += 1) {
    if (words.slice(start, start + token.length).map((word) => word.charAt(0)).join("") === token) return true;
  }
  return false;
}

/**
 * How a school a question names relates to the profile's school (Track 57): "same" when both have the same words
 * (sameNameKey); "different" only when both are full institution names (University, College, Institute, or Polytechnic),
 * neither is or contains an abbreviation (an all-capital word, or a word that is the other's initials), and they share no
 * word besides university/college/institute; anything else ("Example University" and "Example State University", a
 * campus and its system, "NIT" and "Northwind Institute of Technology") is "ambiguous".
 */
export function namedSchoolRelation(named: string, profileSchool: string): SchoolRelation {
  const a = expandedSchoolName(named);
  const b = expandedSchoolName(profileSchool);
  const keyA = sameNameKey(a);
  const keyB = sameNameKey(b);
  if (!keyA || !keyB) return "ambiguous";
  if (keyA === keyB) return "same";
  if (!INSTITUTION_WORD.test(a) || !INSTITUTION_WORD.test(b)) return "ambiguous";
  if (/\b[A-Z]{2,}\b/.test(a) || /\b[A-Z]{2,}\b/.test(b)) return "ambiguous";
  const wordsA = keyA.split(" ");
  const wordsB = keyB.split(" ");
  if (wordsA.some((word) => initialsOf(word, wordsB)) || wordsB.some((word) => initialsOf(word, wordsA))) return "ambiguous";
  const distinctA = wordsA.filter((word) => !GENERIC_SCHOOL_WORDS.has(word));
  const distinctB = wordsB.filter((word) => !GENERIC_SCHOOL_WORDS.has(word));
  if (distinctA.length === 0 || distinctB.length === 0) return "ambiguous";
  return distinctA.some((word) => distinctB.includes(word)) ? "ambiguous" : "different";
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

/** A word without a plural ending, for field-of-study names: "sciences" is "science", "studies" is "study"; "business", "analysis", "status" keep their form. */
function singular(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * The field-of-study option for `value`: an option with the same words
 * (matchPromptOption's same-words rule), else the one option whose words
 * differ only by plural endings ("Computer sciences" for "Computer
 * Science", micron.wd1 2026-11-25; two such options return null so the
 * run asks), else matchPromptOption's containing match.
 */
export function matchFieldOfStudyOption(value: string, options: string[]): string | null {
  const wanted = tokens(value);
  if (wanted.length === 0) return null;
  const same = options.find((option) => tokens(option).join(" ") === wanted.join(" "));
  if (same) return same;
  const key = wanted.map(singular).join(" ");
  const folded = [...new Set(options.filter((option) => tokens(option).map(singular).join(" ") === key))];
  if (folded.length === 1) return folded[0]!;
  if (folded.length > 1) return null;
  return matchPromptOption(value, options);
}

const FIELD_NEGATORS = new Set(["non", "not", "no", "except", "excluding", "without"]);

/**
 * The option of a broad field-of-study list ("Engineering – Computer Science
 * & Technology") for the saved field: an option with the same words or the
 * one differing only by plural endings (matchFieldOfStudyOption's first two
 * rules), else the one option naming the saved field as a whole phrase.
 * Never an option that negates it ("Engineering (Non-Computer Science)"),
 * never "Other", and never matchPromptOption's containing match, which could
 * pick the negated option. Null when none or several (Veeva on Lever,
 * 2026-11-26).
 */
export function fieldOfStudyCategoryOption(value: string, options: string[]): string | null {
  const words = tokens(value);
  if (words.length === 0) return null;
  const same = options.find((option) => tokens(option).join(" ") === words.join(" "));
  if (same) return same;
  const wanted = words.map(singular);
  const key = wanted.join(" ");
  const folded = [...new Set(options.filter((option) => tokens(option).map(singular).join(" ") === key))];
  if (folded.length === 1) return folded[0]!;
  if (folded.length > 1) return null;
  const naming = [...new Set(options.filter((option) => {
    if (/^\s*other\b/i.test(option) || /\bother than\b/i.test(option)) return false;
    const have = tokens(option).map(singular);
    for (let index = 0; index + wanted.length <= have.length; index += 1) {
      if (have.slice(index, index + wanted.length).join(" ") !== key) continue;
      return !have.slice(0, index).some((token) => FIELD_NEGATORS.has(token));
    }
    return false;
  }))];
  return naming.length === 1 ? naming[0]! : null;
}
