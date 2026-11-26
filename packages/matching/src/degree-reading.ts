/**
 * Word-level reading of degree requirements for a candidate whose profile
 * degree is a bachelor's. A line passes only when every word in it is
 * understood: a list of degree levels that includes a bachelor's, a field
 * list that names the candidate's field (or asks for a STEM, technical,
 * technology, or quantitative field), and ordinary enrollment wording. Any
 * other qualifier (full-time, class year, GPA, credit hours, a country, a
 * completed degree, a "related field" judgment) leaves the line for the
 * candidate's review.
 */

type Level = "BACHELOR" | "GRADUATE";

const LEVEL_WORDS: Record<string, Level> = {
  bachelor: "BACHELOR", bachelors: "BACHELOR", undergraduate: "BACHELOR", undergrad: "BACHELOR",
  bs: "BACHELOR", ba: "BACHELOR", bsc: "BACHELOR", bse: "BACHELOR", beng: "BACHELOR", bfa: "BACHELOR",
  master: "GRADUATE", masters: "GRADUATE", ms: "GRADUATE", ma: "GRADUATE", msc: "GRADUATE", meng: "GRADUATE",
  mba: "GRADUATE", mph: "GRADUATE", mpp: "GRADUATE", graduate: "GRADUATE", postgraduate: "GRADUATE",
  advanced: "GRADUATE", higher: "GRADUATE", above: "GRADUATE", phd: "GRADUATE", doctoral: "GRADUATE",
  doctorate: "GRADUATE", jd: "GRADUATE"
};

/** Words that may sit between levels of one list ("a Bachelor's, Master's, or PhD degree"). */
const LIST_CONNECTORS = new Set(["or", "and", "degree", "degrees", "program", "programs", "a", "an", "level"]);

/** Undergraduate class standing, a bachelor's level only where acceptsBachelorLevel reads a list of levels ("a rising junior, rising senior, or master's student"). */
const CLASS_STANDING = new Set(["freshman", "freshmen", "sophomore", "sophomores", "junior", "juniors", "senior", "seniors"]);
/** Words that may stand before a class standing inside such a list. */
const STANDING_CONNECTORS = new Set(["rising", "current", "incoming", "entering"]);

/** Enrollment wording that states nothing the profile degree does not already establish. */
const ENROLLMENT_WORDS = new Set([
  "currently", "current", "enrolled", "enrollment", "pursuing", "pursue", "pursuit", "working", "towards", "toward",
  "progress", "active", "student", "students", "candidate", "candidates", "a", "an", "the", "in", "of", "or", "and",
  "at", "from", "to", "degree", "degrees", "program", "programs", "major", "majors", "majoring", "field", "fields",
  "discipline", "disciplines", "area", "areas", "study", "studies", "studying", "accredited", "college", "university",
  "universities", "school", "institution", "4", "four", "year", "must", "be", "are", "is", "you", "youre", "seeking",
  "level", "scheduled", "obtain", "such", "as", "eg", "ie", "etc", "least", "equivalent", "required", "requirement"
]);

/** Graduation-window words, understood only when the posting's graduation window is checked separately. */
const GRADUATION_WORDS = new Set([
  "graduation", "graduating", "expected", "anticipated", "date", "dates", "between", "by", "with", "within", "late", "early",
  "mid", "spring", "summer", "fall", "winter", "autumn", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
  "sep", "sept", "oct", "nov", "dec", "semester", "quarter", "term"
]);

/** Field-family words; "information technology" is its own field and never a family. */
const FAMILY_WORDS = new Set(["stem", "technical", "technology", "quantitative", "scientific", "computing"]);
const FIELD_QUALIFIERS = new Set(["related", "relevant", "applicable", "other", "another", "similar"]);

/** Words that name academic fields, so another field in the same list is understood as an alternative. */
const FIELD_WORDS = new Set([
  "engineering", "electrical", "electronics", "computer", "computers", "mechanical", "civil", "industrial", "chemical",
  "aerospace", "biomedical", "materials", "science", "sciences", "physics", "mathematics", "math", "maths", "applied",
  "statistics", "data", "machine", "learning", "artificial", "intelligence", "ai", "ml", "computational", "information",
  "systems", "business", "analytics", "supply", "chain", "management", "logistics", "operations", "economics",
  "finance", "accounting", "chemistry", "biology", "cognitive", "software", "cybersecurity", "security", "research",
  "robotics", "mechatronics", "networking", "informatics", "design", "human", "interaction", "hci", "cs", "ee", "ce",
  "ece", "eecs", "it", "technologies"
]);

type KnownField = { label: string; phrases: string[][]; families: string[] };

const KNOWN_FIELDS: KnownField[] = [
  { label: "computer science", phrases: [["computer", "science"], ["computer", "sciences"], ["cs"]],
    families: ["stem", "technical", "technology", "quantitative", "scientific", "computing"] },
  { label: "computer engineering", phrases: [["computer", "engineering"]],
    families: ["stem", "technical", "technology", "quantitative", "computing"] },
  { label: "software engineering", phrases: [["software", "engineering"]],
    families: ["stem", "technical", "technology", "computing"] },
  { label: "electrical engineering", phrases: [["electrical", "engineering"]],
    families: ["stem", "technical", "technology", "quantitative"] },
  { label: "data science", phrases: [["data", "science"]], families: ["stem", "technical", "quantitative", "scientific"] },
  { label: "mathematics", phrases: [["mathematics"], ["applied", "mathematics"], ["math"]],
    families: ["stem", "quantitative", "scientific"] },
  { label: "statistics", phrases: [["statistics"]], families: ["stem", "quantitative", "scientific"] },
  { label: "physics", phrases: [["physics"]], families: ["stem", "technical", "quantitative", "scientific"] }
];

/** Lowercase words, with abbreviations joined ("B.S." → bs, "Ph.D." → phd) and preferences dropped. */
export function degreeWords(text: string): string[] {
  const normalized = text
    .toLocaleLowerCase("en-US")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[’`]/g, "'")
    // A preference inside a hard line ("(pursuing M.S. or Ph.D. preferred)") is not the requirement.
    .replace(/\([^)]*\bprefer[^)]*\)/g, " ")
    .replace(/\bph\.?\s?d\b\.?/g, "phd")
    .replace(/\b([bm])\.?\s?(sc|eng)\b\.?/g, "$1$2")
    .replace(/\b([a-z])\.\s?(?=[a-z]\.)/g, "$1")
    // Keep the kind of degree: a Bachelor of Science is a B.S., not a B.A.
    .replace(/\bbachelor'?s? of science\b/g, "bs")
    .replace(/\bbachelor'?s? of arts\b/g, "ba")
    .replace(/\bbachelor'?s? of fine arts\b/g, "bfa")
    .replace(/\bbachelor'?s? of engineering\b/g, "beng")
    .replace(/\bmaster'?s? of science\b/g, "ms")
    .replace(/\bmaster'?s? of arts\b/g, "ma")
    .replace(/\bmaster'?s? of engineering\b/g, "meng")
    // "expected to graduate" is a date, not a graduate-level program.
    .replace(/\b(expected|scheduled|planning|plan|going) to graduate\b/g, "$1 to graduating")
    .replace(/\ball majors(?: and concentrations)?(?: are)? welcome\b/g, " ");
  return normalized.replace(/'s\b/g, "s").replace(/'/g, "").split(/[^a-z0-9+#]+/).filter(Boolean);
}

/** Where a posting is and what it says, read only to tell a place or team code in its title from a degree. */
export type TitleContext = {
  locations?: ReadonlyArray<{ raw: string; region: string | null }>;
  /** The posting's text, read only for a spelled-out code ("Mission Systems (MS)"). */
  text?: string;
};

type DegreeCode = "MA" | "MS";
const CODE_STATES: Record<DegreeCode, string> = { MA: "massachusetts", MS: "mississippi" };
/** Cities named before or after a state code in titles ("Boston, MA", "Jackson (MS)", "MA - Boston"). */
const CODE_CITIES: Record<DegreeCode, string[]> = {
  MA: ["boston", "cambridge", "waltham", "burlington", "lexington", "bedford", "woburn", "andover", "north andover", "marlborough", "framingham", "worcester", "lowell", "somerville", "newton", "needham", "natick", "quincy", "watertown", "westford", "chelmsford", "billerica", "wilmington", "springfield", "maynard", "canton", "norwood", "boxborough", "foxborough", "plymouth"],
  MS: ["jackson", "starkville", "oxford", "hattiesburg", "gulfport", "biloxi", "tupelo", "pascagoula", "ridgeland", "vicksburg", "meridian", "southaven", "flowood", "madison", "columbus", "olive branch", "stennis space center"]
};
/** A bare upper-case MA or MS: not inside a word, not dotted, not paired by a slash or a tight hyphen ("BS/MS", "MS/PhD", "MS-PhD"). */
const BARE_CODE = /(?<![A-Za-z0-9.&'’\/-])(MA|MS)(?![A-Za-z0-9&'’]|\.[A-Za-z]|\s*\/|-[A-Za-z0-9])/g;
/** Words after the code that make it the candidate's degree ("MS students only"). */
const DEGREE_FOLLOWER = /^\s+(?:students?|candidates?|degrees?|programs?|only|in|level|track)\b/i;
const PLACE_BEFORE = /(?:,|\(|[-–—|])\s*$/;
const PLACE_AFTER = /^\s*(?:$|[-–—|)])/;
const ZIP_AFTER = /^\s+\d{5}(?:-\d{4})?\b/;
const COUNTRY_JOINED = /\b(USA?)(\s*[-–—,]\s*)(MA|MS)\b/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a stored location of the posting is in the code's state. */
function locatedIn(code: DegreeCode, locations: NonNullable<TitleContext["locations"]>): boolean {
  const state = CODE_STATES[code];
  const raw = new RegExp(`(?:^|,\\s*)${code}\\b`);
  return locations.some((location) => {
    const region = location.region?.trim().toLocaleLowerCase("en-US");
    return region === code.toLocaleLowerCase("en-US") || region === state ||
      raw.test(location.raw) || location.raw.toLocaleLowerCase("en-US").includes(state);
  });
}

function cityPattern(code: DegreeCode): string {
  return CODE_CITIES[code].map(escapeRegExp).join("|");
}

/** Whether a city of the code's state stands right before it ("Boston, MA", "Jackson (MS)"). */
function cityBefore(code: DegreeCode, before: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z])(?:${cityPattern(code)})\\s*(?:,|\\()\\s*$`, "i").test(before);
}

/** Whether a city of the code's state stands right after it ("MA - Boston", "US-MA-Boston"). */
function cityAfter(code: DegreeCode, after: string): boolean {
  return new RegExp(`^\\s*[-–—,]\\s*(?:${cityPattern(code)})\\b`, "i").test(after);
}

/** Whether the text spells the code out as two capitalized words that are not "Master ..." ("Mission Systems (MS)"). */
function definedAsCode(code: DegreeCode, text: string): boolean {
  const [first, second] = code;
  const words = `(${first}[a-z]+)\\s+(?:(?:and|&)\\s+)?${second}[a-z]+`;
  const patterns = [
    new RegExp(`\\b${words}\\s*\\(\\s*${code}\\s*\\)`, "g"),
    new RegExp(`\\b${code}\\s*\\(\\s*${words}\\s*\\)`, "g")
  ];
  return patterns.some((pattern) => [...text.matchAll(pattern)].some((match) => !/^master/i.test(match[1] ?? "")));
}

/** The title with each MA or MS that is a state or a team code blanked, so only degree mentions remain (Track 56). */
export function withoutPlaceAndTeamCodes(title: string, context: TitleContext = {}): string {
  const joined = title.replace(COUNTRY_JOINED, (_all, country: string, separator: string) => `${country}${separator}  `);
  const teamText = `${joined}\n${context.text ?? ""}`;
  return joined.replace(BARE_CODE, (code: string, _group: string, offset: number) => {
    const key = code as DegreeCode;
    const before = joined.slice(0, offset);
    const after = joined.slice(offset + code.length);
    if (DEGREE_FOLLOWER.test(after)) return code;
    if (definedAsCode(key, teamText)) return "  ";
    const placePosition = PLACE_BEFORE.test(before) || PLACE_AFTER.test(after);
    if (placePosition && locatedIn(key, context.locations ?? [])) return "  ";
    if (cityBefore(key, before) || cityAfter(key, after) || ZIP_AFTER.test(after)) return "  ";
    return code;
  });
}

/** Bachelor's degrees of a named kind; "bachelor's" and "undergraduate" name no kind. */
const BACHELOR_KINDS: Record<string, string> = { bs: "B.S.", bsc: "B.S.", bse: "B.S.", ba: "B.A.", bfa: "B.F.A.", beng: "B.Eng." };
const ANY_BACHELOR = new Set(["bachelor", "bachelors", "undergraduate", "undergrad"]);

/**
 * Why the line's bachelor's degree is a different kind from the candidate's
 * ("B.S." against a B.A.), or null when it names no kind, allows any
 * bachelor's, or includes the candidate's kind.
 */
export function bachelorKindMismatch(text: string, candidateDegree: string): string | null {
  const held = degreeWords(candidateDegree).map((word) => BACHELOR_KINDS[word]).find(Boolean);
  if (!held) return null;
  const words = degreeWords(text);
  if (words.some((word) => ANY_BACHELOR.has(word))) return null;
  const named = [...new Set(words.map((word) => BACHELOR_KINDS[word]).filter((kind): kind is string => Boolean(kind)))];
  if (named.length === 0 || named.includes(held)) return null;
  return `The posting names a ${named.join(" or ")}, and your degree is a ${held}; they are different degrees, so this needs your review.`;
}

/** Whether a stored finding reason is bachelorKindMismatch's own sentence (a B.S. line against a B.A., or the reverse). */
export function isBachelorKindMismatchReason(reason: string): boolean {
  return /^The posting names a .+, and your degree is a [^;]+; they are different degrees, so this needs your review\.$/.test(reason);
}

/**
 * Runs of degree levels joined only by list words; each run is one set of
 * alternatives. With classStanding, undergraduate class standing ("rising
 * junior") counts as a bachelor's level.
 */
function levelLists(words: string[], classStanding = false): Level[][] {
  const lists: Level[][] = [];
  let current: Level[] | null = null;
  for (const word of words) {
    const level = LEVEL_WORDS[word] ?? (classStanding && CLASS_STANDING.has(word) ? "BACHELOR" : undefined);
    if (level) {
      if (current) current.push(level);
      else lists.push(current = [level]);
    } else if (!current || !(LIST_CONNECTORS.has(word) || (classStanding && STANDING_CONNECTORS.has(word)))) {
      current = null;
    }
  }
  return lists;
}

/**
 * Whether the line accepts bachelor's-level study: it names a bachelor's, and
 * every graduate level it names sits in a list with a bachelor's alternative
 * ("BS, MS, or PhD", "Bachelor's or Advanced degree", "B.S. or higher").
 * Undergraduate class standing inside such a list is a bachelor's level ("a
 * rising junior, rising senior, or master's student"; Track 56).
 */
export function acceptsBachelorLevel(text: string): boolean {
  const lists = levelLists(degreeWords(text), true);
  return lists.some((list) => list.includes("BACHELOR")) &&
    lists.every((list) => !list.includes("GRADUATE") || list.includes("BACHELOR"));
}

function phraseIndices(words: string[], phrases: string[][]): number[] {
  const covered: number[] = [];
  for (const phrase of phrases) {
    for (let index = 0; index + phrase.length <= words.length; index += 1) {
      if (phrase.every((word, offset) => words[index + offset] === word)) {
        covered.push(...phrase.map((_, offset) => index + offset));
      }
    }
  }
  return covered;
}

function fullTime(words: string[]): boolean {
  return words.includes("fulltime") || words.some((word, index) => word === "full" && words[index + 1] === "time");
}

function candidateFieldOf(value: string): KnownField | null {
  const words = degreeWords(value);
  return KNOWN_FIELDS.find((field) => phraseIndices(words, field.phrases).length > 0) ?? null;
}

export type DegreeContext = {
  /** Profile field of study; absent means the field is read from the degree text. */
  candidateField: string | null;
  /** Whether the posting's graduation window is checked by its own finding. */
  graduationChecked: boolean;
  /** The candidate's recorded full-time enrollment answer; null when not recorded. */
  fullTimeStudent: boolean | null;
};

/**
 * The reason a bachelor's candidate meets this degree line, or null when any
 * part of it is not understood (the caller then falls back to review).
 */
export function readBachelorDegreeRequirement(
  text: string,
  candidateDegree: string,
  { candidateField, graduationChecked, fullTimeStudent }: DegreeContext
): string | null {
  const held = levelLists(degreeWords(candidateDegree)).flat();
  if (!held.includes("BACHELOR") || held.includes("GRADUATE")) return null;

  const words = degreeWords(text);
  const lists = levelLists(words);
  if (lists.some((list) => list.includes("GRADUATE") && !list.includes("BACHELOR"))) return null;

  const field = candidateFieldOf(candidateField ?? "") ?? candidateFieldOf(candidateDegree);
  const named = field ? new Set(phraseIndices(words, field.phrases)) : new Set<number>();
  const informationTechnology = new Set(phraseIndices(words, [["information", "technology"]]));
  const otherFields = words.some((word, index) => FIELD_WORDS.has(word) && !named.has(index) && !FAMILY_WORDS.has(word) &&
    !informationTechnology.has(index));
  // "a related technical degree" asks for a technical field; "EE, ME, or a
  // related technical field" asks for one related to those, which is a judgment.
  const family = words.findIndex((word, index) => field?.families.includes(word) && !informationTechnology.has(index) &&
    (!FIELD_QUALIFIERS.has(words[index - 1] ?? "") || !otherFields));
  const fieldMet = named.size > 0 || family >= 0;

  const understood = (word: string) =>
    word in LEVEL_WORDS || ENROLLMENT_WORDS.has(word) ||
    (graduationChecked && (GRADUATION_WORDS.has(word) || /^20\d\d$/.test(word))) ||
    // "full-time" is understood only once the candidate has said they are enrolled full-time.
    (fullTimeStudent === true && (word === "full" || word === "time" || word === "fulltime")) ||
    (fieldMet && (FIELD_WORDS.has(word) || FAMILY_WORDS.has(word) || FIELD_QUALIFIERS.has(word)));
  if (!words.every(understood)) return null;

  const parts: string[] = [];
  if (lists.some((list) => list.includes("BACHELOR"))) parts.push("it accepts a bachelor's degree");
  if (named.size > 0 && field) parts.push(`it names ${field.label}`);
  else if (family >= 0) parts.push(`it asks for a ${words[family] === "stem" ? "STEM" : words[family]} field`);
  if (fullTime(words) && fullTimeStudent === true) parts.push("you are enrolled full-time");
  if (parts.length === 0) parts.push("it asks only for current enrollment in a degree program");
  return `Your degree (${candidateDegree}) meets this requirement: ${parts.join(", and ")}.`;
}
