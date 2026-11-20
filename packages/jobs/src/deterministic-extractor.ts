import {
  normalizeTechnologyKey,
  STATED_CONSTRAINT_MAX_LENGTH,
  type JobCompensation,
  type JobConstraints,
  type JobLocation,
  type JobTechnology,
  type RequirementCategory,
  type RequirementSubject,
  type TextSpan,
  type JobWorkMode
} from "@internship-agent/domain";

import { readPlace, readWellKnownCity, US_STATE_CODES } from "./place-names";
import { bulletBody, isBullet, isHeading, toLines, type PostingLine } from "./text-normalizer";

export type RequirementCandidate = {
  text: string;
  category: RequirementCategory;
  subject: RequirementSubject;
  confidence: number;
  span: TextSpan;
  /** The section heading this bullet sat under, for the model classifier. */
  heading: string | null;
};

export type DeterministicExtraction = {
  locations: Array<Omit<JobLocation, "jobId">>;
  compensation: JobCompensation | null;
  technologies: Array<Omit<JobTechnology, "jobId">>;
  constraints: JobConstraints;
  requirements: RequirementCandidate[];
};

// Real postings rarely write "Requirements:". The phrasings below were taken
// from the acceptance corpus; soft invitations such as "we'd love to hear from
// you if you have" are deliberately absent, because they do not assert that a
// candidate is ineligible and must not become a hard requirement.
const PREFERRED_HEADING =
  /\b(preferred|nice[- ]to[- ]have|bonus|desired|pluses?|good to have|added plus|not required)\b/i;
const HARD_HEADING =
  /\b(requirement|qualification|minimum|basic|must[- ]have|eligibility|what you.?ll need|who you are|what we.?re looking for)\b/i;
const PREFERRED_CUE = /\b(preferred|nice to have|bonus|a plus|ideally|desirable|familiarity is a plus)\b/i;
const HARD_CUE = /\b(must|required|require|requires|mandatory)\b/i;
const INLINE_REQUIREMENT_START = /^(?:proficiency (?:with|in)|experience (?:with|in)|knowledge of|familiarity with|ability to|(?:you|candidates?|applicants?) must\b|must\b)/i;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

const TECHNOLOGY_SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Python", pattern: /\bpython\b/i },
  { label: "Java", pattern: /\bjava\b(?!script)/i },
  { label: "JavaScript", pattern: /\bjavascript\b/i },
  { label: "TypeScript", pattern: /\btypescript\b/i },
  { label: "C", pattern: /\bc\b(?!\+|#|ss)/ },
  { label: "C++", pattern: /\bc\+\+\b/i },
  { label: "C#", pattern: /\bc#/i },
  { label: "Go", pattern: /\b(golang|go programming)\b/i },
  { label: "Rust", pattern: /\brust\b/i },
  { label: "Swift", pattern: /\bswift\b/i },
  { label: "Kotlin", pattern: /\bkotlin\b/i },
  { label: "Scala", pattern: /\bscala\b/i },
  { label: "Ruby", pattern: /\bruby\b/i },
  { label: "SQL", pattern: /\bsql\b/i },
  { label: "React", pattern: /\breact(?:\.js)?\b/i },
  { label: "Next.js", pattern: /\bnext\.js\b/i },
  { label: "Node.js", pattern: /\bnode(?:\.js)?\b/i },
  { label: "Django", pattern: /\bdjango\b/i },
  { label: "Spring", pattern: /\bspring boot\b/i },
  { label: "Docker", pattern: /\bdocker\b/i },
  { label: "Kubernetes", pattern: /\b(kubernetes|k8s)\b/i },
  { label: "AWS", pattern: /\baws\b/i },
  { label: "GCP", pattern: /\b(gcp|google cloud)\b/i },
  { label: "Azure", pattern: /\bazure\b/i },
  { label: "Terraform", pattern: /\bterraform\b/i },
  { label: "PyTorch", pattern: /\bpytorch\b/i },
  { label: "TensorFlow", pattern: /\btensorflow\b/i },
  { label: "CUDA", pattern: /\bcuda\b/i },
  { label: "Spark", pattern: /\bapache spark\b|\bspark\b/i },
  { label: "Kafka", pattern: /\bkafka\b/i },
  { label: "PostgreSQL", pattern: /\b(postgres(?:ql)?)\b/i },
  { label: "Redis", pattern: /\bredis\b/i },
  { label: "GraphQL", pattern: /\bgraphql\b/i },
  { label: "Git", pattern: /\bgit\b(?!hub)/i },
  { label: "Linux", pattern: /\blinux\b/i },
  { label: "Machine learning", pattern: /\bmachine learning\b/i },
  { label: "Distributed systems", pattern: /\bdistributed systems\b/i }
];

export function extractDeterministically(normalizedText: string): DeterministicExtraction {
  const lines = toLines(normalizedText);
  return {
    locations: extractLocations(normalizedText, lines),
    compensation: extractCompensation(normalizedText),
    technologies: extractTechnologies(normalizedText),
    constraints: extractConstraints(normalizedText),
    requirements: extractRequirementCandidates(normalizedText, lines)
  };
}

function span(normalizedText: string, start: number, end: number): TextSpan {
  const clampedEnd = Math.min(end, normalizedText.length);
  return { start, end: clampedEnd, excerpt: normalizedText.slice(start, clampedEnd) };
}

/* ------------------------------------------------------------------ */
/* Requirements                                                        */
/* ------------------------------------------------------------------ */

function extractRequirementCandidates(normalizedText: string, lines: PostingLine[]): RequirementCandidate[] {
  const candidates: RequirementCandidate[] = [];
  let heading: string | null = null;
  let headingCategory: RequirementCategory | null = null;

  for (const line of lines) {
    if (isHeading(line.text)) {
      heading = line.text.trim().replace(/:$/, "");
      headingCategory = PREFERRED_HEADING.test(heading) ? "PREFERRED"
        : HARD_HEADING.test(heading) ? "HARD"
        : null;
      continue;
    }
    if (!isBullet(line.text)) {
      // Some boards put explicit requirements in a prose paragraph. Only
      // applicant-directed sentences with their own hard/preferred cue qualify;
      // a section heading alone never turns general prose into a requirement.
      let offset = 0;
      for (const part of line.text.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
        const partStart = line.text.indexOf(part, offset);
        offset = partStart + part.length;
        const body = part.trim();
        if (body.length < 8 || body.length > 240 || !INLINE_REQUIREMENT_START.test(body) ||
            (!HARD_CUE.test(body) && !PREFERRED_CUE.test(body))) continue;
        const start = line.start + partStart + part.indexOf(body);
        candidates.push({
          text: body,
          category: categorize(body, null),
          subject: subjectOf(body),
          confidence: categoryConfidence(body, null),
          span: span(normalizedText, start, start + body.length),
          heading
        });
      }
      continue;
    }

    const body = bulletBody(line.text);
    if (body.length < 8) continue;

    const bulletStart = line.start + line.text.indexOf(body);
    candidates.push({
      text: body,
      category: categorize(body, headingCategory),
      subject: subjectOf(body),
      confidence: categoryConfidence(body, headingCategory),
      span: span(normalizedText, bulletStart, bulletStart + body.length),
      heading
    });
  }
  return candidates;
}

/**
 * A bullet's own cue wins over its section heading, because postings routinely
 * list "X preferred" inside a Requirements block. With neither signal the
 * bullet is PREFERRED: over-calling a requirement hard would wrongly rule the
 * candidate out in Milestone 4, which is the more costly error.
 */
function categorize(body: string, headingCategory: RequirementCategory | null): RequirementCategory {
  if (PREFERRED_CUE.test(body)) return "PREFERRED";
  if (HARD_CUE.test(body)) return "HARD";
  return headingCategory ?? "PREFERRED";
}

function categoryConfidence(body: string, headingCategory: RequirementCategory | null): number {
  if (PREFERRED_CUE.test(body) || HARD_CUE.test(body)) return 0.9;
  if (headingCategory) return 0.7;
  return 0.4;
}

function subjectOf(body: string): RequirementSubject {
  if (/\b(graduat|class of|conferred)\w*\b/i.test(body)) return "GRADUATION";
  if (/\b(authoriz|work permit|visa|sponsor|citizen|security clearance)\w*\b/i.test(body)) return "AUTHORIZATION";
  if (/\b(bachelor|master|phd|doctorate|b\.?s\.?|m\.?s\.?|degree|enrolled|pursuing|undergraduate)\b/i.test(body)) return "DEGREE";
  if (/\b(onsite|on-site|in-office|hybrid|remote|relocat|based in|located in)\w*\b/i.test(body)) return "LOCATION";
  if (/\b(available|start date|hours per week|full[- ]time during|commit)\w*\b/i.test(body)) return "AVAILABILITY";
  if (/\b\d+\+?\s*(years?|yrs?)\b/i.test(body) || /\bprior experience\b/i.test(body)) return "EXPERIENCE";
  if (/\b(proficien|experience with|familiar|knowledge of|skills?|programming)\w*\b/i.test(body)) return "SKILL";
  return "OTHER";
}

/* ------------------------------------------------------------------ */
/* Technologies                                                        */
/* ------------------------------------------------------------------ */

function extractTechnologies(normalizedText: string): Array<Omit<JobTechnology, "jobId">> {
  const found = new Map<string, Omit<JobTechnology, "jobId">>();
  for (const signal of TECHNOLOGY_SIGNALS) {
    const match = new RegExp(signal.pattern.source, `${signal.pattern.flags.replace("g", "")}g`)
      .exec(normalizedText);
    if (!match) continue;
    const key = normalizeTechnologyKey(signal.label);
    if (found.has(key)) continue;
    found.set(key, {
      label: signal.label,
      normalizedKey: key,
      extraction: "DETERMINISTIC",
      span: span(normalizedText, match.index, match.index + match[0].length)
    });
  }
  return [...found.values()].sort((left, right) => left.normalizedKey.localeCompare(right.normalizedKey));
}

/* ------------------------------------------------------------------ */
/* Compensation                                                        */
/* ------------------------------------------------------------------ */

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(k\b)?`;
const RANGE = String.raw`(?:\s*(?:-|–|—|&[mn]dash;|to|and)\s*(?:USD|CAD)?\s?\$?\s?` + AMOUNT + ")?";
const CURRENCY_BEFORE = String.raw`(?:\b(USD|CAD|AUD|SGD|US|CA|C)\s?)?\$\s?`;
const CURRENCY_AFTER = String.raw`(?:\s*\b(USD|CAD|AUD|SGD)\b)?`;

// "$45 - $55/hour", "$45.00 - $55.00 hourly", "USD $58.37 hourly", "$120,000 – $150,000 USD per year".
const COMPENSATION_PATTERN = new RegExp(
  CURRENCY_BEFORE + AMOUNT + RANGE + CURRENCY_AFTER +
  String.raw`\s*(?:(?:per|\/|a|an)\s*)?(hourly|hour|hr|annually|annual|annum|yearly|year|yr|monthly|month|mo)\b`,
  "i"
);

// "Hourly Rate Band $35 — $55 CAD", "hourly compensation range for this internship is $20 to $33".
// The pay noun keeps "annual revenue of $5 billion" out, and the lookahead keeps out scale words.
const LABELLED_COMPENSATION_PATTERN = new RegExp(
  String.raw`\b(hourly|annual|yearly|monthly)\s+(?:base\s+)?(?:pay|rate|salary|compensation|wage)s?(?:\s+(?:range|band))?\b[^$\n]{0,60}?` +
  CURRENCY_BEFORE + AMOUNT + RANGE + String.raw`(?!\s*(?:billion|million|bn|mm?\b|b\b))` + CURRENCY_AFTER,
  "i"
);

function extractCompensation(normalizedText: string): JobCompensation | null {
  const trailing = COMPENSATION_PATTERN.exec(normalizedText);
  const leading = LABELLED_COMPENSATION_PATTERN.exec(normalizedText);
  // The earlier statement wins, whichever form it takes; when both read the
  // same figure, the form with its own unit after the amount wins.
  const sameFigure = trailing && leading && trailing.index >= leading.index && trailing.index < leading.index + leading[0].length;
  if (trailing && (!leading || sameFigure || trailing.index <= leading.index)) {
    const [, before, low, lowK, high, highK, after, unit] = trailing;
    return compensation(normalizedText, trailing, low, lowK, high, highK, before ?? after, periodOf(unit));
  }
  if (leading) {
    const [, unit, before, low, lowK, high, highK, after] = leading;
    return compensation(normalizedText, leading, low, lowK, high, highK, before ?? after, periodOf(unit));
  }

  // A stipend with no figure is still worth recording as stated, without a number.
  const stipend = /\b(?:a\s+)?(?:competitive\s+)?stipend\b/i.exec(normalizedText);
  if (!stipend) return null;
  return {
    raw: stipend[0].trim(),
    minimum: null,
    maximum: null,
    currency: "USD",
    period: "STIPEND",
    span: span(normalizedText, stipend.index, stipend.index + stipend[0].length)
  };
}

function compensation(
  normalizedText: string,
  match: RegExpExecArray,
  low: string,
  lowK: string | undefined,
  high: string | undefined,
  highK: string | undefined,
  currency: string | undefined,
  period: JobCompensation["period"]
): JobCompensation {
  const minimum = parseAmount(low, Boolean(lowK));
  const maximum = high ? parseAmount(high, Boolean(highK)) : null;
  return {
    raw: match[0].trim(),
    minimum,
    maximum: maximum !== null && maximum < minimum ? null : maximum,
    currency: currencyOf(currency),
    period,
    span: span(normalizedText, match.index, match.index + match[0].length)
  };
}

/** A bare "$" stays USD, as before; only a stated code changes it. */
function currencyOf(code: string | undefined): string {
  const normalized = code?.toUpperCase();
  if (normalized === "CAD" || normalized === "CA" || normalized === "C") return "CAD";
  if (normalized === "AUD" || normalized === "SGD") return normalized;
  return "USD";
}

function parseAmount(value: string, thousands: boolean): number {
  const amount = Number.parseFloat(value.replace(/,/g, ""));
  return thousands ? amount * 1_000 : amount;
}

function periodOf(unit: string): JobCompensation["period"] {
  const normalized = unit.toLocaleLowerCase("en-US");
  if (normalized.startsWith("hour") || normalized === "hr") return "HOUR";
  if (normalized.startsWith("mo")) return "MONTH";
  return "YEAR";
}

/* ------------------------------------------------------------------ */
/* Locations                                                           */
/* ------------------------------------------------------------------ */

// Several places on one labelled line: "Austin, TX; Toronto, ON".
const PLACE_GROUP_SEPARATOR = /\s*(?:;|\||•|\s\/\s|\s+or\s+)\s*/g;
const PLACE_SEGMENT_SEPARATOR = /\s*,\s*|\s*[-–]\s*/;
const PLACE_NAME = /^\p{Lu}[\p{L}.']*(?: (?:\p{Lu}[\p{L}.']*|de|da|del|la|le|of|upon|am|on))*$/u;
const WORK_MODE_WORDS = /\b(remote|hybrid|home|working|anywhere|virtual|on-?site|office)\b/i;
// A title or heading line that happens to name a country is not a location.
const NOT_A_PLACE_LINE = /\b(intern(?:ship)?s?|engineer(?:ing)?|developer|analyst|scientist|manager|software|program|team|role|position|summer|fall|spring|winter|20\d\d)\b/i;

function extractLocations(normalizedText: string, lines: PostingLine[]): Array<Omit<JobLocation, "jobId">> {
  const found = new Map<string, Omit<JobLocation, "jobId">>();

  for (const line of lines) {
    // "Job list location:" is the GitHub list's location column, used when the board gives none.
    const labelled = /^(?:location|locations|office|work location|job list location)s?\s*:\s*(.+)$/i.exec(line.text);
    const haystack = labelled ? labelled[1] : line.text;
    const offset = labelled ? line.start + line.text.length - labelled[1].length : line.start;

    // Word-by-word rather than a loose character class: "Aurora Labs - Austin, TX"
    // must yield "Austin", not the company name that precedes it.
    for (const match of haystack.matchAll(/\b([A-Z][a-zA-Z.']*(?:[ -][A-Z][a-zA-Z.']*){0,3}),\s*([A-Z]{2})\b/g)) {
      // "ON, CA" is a province and a country code, not a city named ON.
      if (!US_STATE_CODES.has(match[2]) || /^[A-Z]{2,3}$/.test(match[1])) continue;
      const key = `${match[1].trim()}|${match[2]}|us`.toLocaleLowerCase("en-US");
      if (found.has(key)) continue;
      const start = offset + (match.index ?? 0);
      found.set(key, {
        raw: match[0].trim(),
        city: match[1].trim(),
        region: match[2],
        countryCode: "US",
        workMode: workModeNear(haystack) ?? workModeNear(normalizedText) ?? "UNSPECIFIED",
        span: span(normalizedText, start, start + match[0].length)
      });
    }

    // Other forms are read only on a labelled line or a line that is nothing
    // but a place, so a country mentioned in the prose never becomes a location.
    const groups = labelled ? placeGroups(haystack) : isPlaceLine(line.text) ? placeGroups(line.text) : [];
    for (const group of groups) {
      const start = offset + group.start;
      const end = start + group.text.length;
      if (group.text.length > 200 || [...found.values()].some((location) => location.span.start < end && start < location.span.end)) continue;
      const place = readPlaceGroup(group.text);
      if (!place) continue;
      const key = `${place.city ?? ""}|${place.region ?? ""}|${place.countryCode}`.toLocaleLowerCase("en-US");
      if (found.has(key)) continue;
      found.set(key, {
        raw: group.text,
        ...place,
        workMode: workModeNear(group.text) ?? workModeNear(haystack) ?? workModeNear(normalizedText) ?? "UNSPECIFIED",
        span: span(normalizedText, start, end)
      });
    }

    if (labelled && found.size === 0) {
      const remote = /\bfully remote\b|\bremote\b/i.exec(haystack);
      if (remote) {
        const start = offset + remote.index;
        found.set("remote", {
          raw: remote[0].trim(),
          city: null,
          region: null,
          countryCode: null,
          workMode: "REMOTE",
          span: span(normalizedText, start, start + remote[0].length)
        });
      }
    }
  }

  if (found.size === 0) {
    const remote = /\b(fully remote|remote[- ]first|100% remote)\b/i.exec(normalizedText);
    if (remote) {
      found.set("remote", {
        raw: remote[0].trim(),
        city: null,
        region: null,
        countryCode: null,
        workMode: "REMOTE",
        span: span(normalizedText, remote.index, remote.index + remote[0].length)
      });
    }
  }

  return [...found.values()].sort((left, right) => left.span.start - right.span.start);
}

function placeGroups(text: string): Array<{ text: string; start: number }> {
  const groups: Array<{ text: string; start: number }> = [];
  let cursor = 0;
  const take = (end: number) => {
    const piece = text.slice(cursor, end);
    const trimmed = piece.trim();
    if (trimmed) groups.push({ text: trimmed, start: cursor + piece.indexOf(trimmed) });
  };
  for (const match of text.matchAll(PLACE_GROUP_SEPARATOR)) {
    take(match.index);
    cursor = match.index + match[0].length;
  }
  take(text.length);
  return groups;
}

function isPlaceLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 80 || NOT_A_PLACE_LINE.test(trimmed)) return false;
  const segments = trimmed.split(PLACE_SEGMENT_SEPARATOR);
  return segments.length >= 2 && segments.every((segment) => readPlace(segment) !== null || PLACE_NAME.test(segment));
}

/**
 * An explicit country wins; otherwise a full US state name, then a Canadian
 * province, then a two-letter state code decides the country, so "Toronto,
 * ON, CA" is Canada and "Ontario, California" is the US. The city is the
 * first remaining piece that looks like a place name. Only when none of
 * those is stated does a well-known city decide ("Berlin" is Germany, "South
 * San Francisco" the US); an unknown bare city stays unread.
 */
function readPlaceGroup(text: string): Pick<JobLocation, "city" | "region" | "countryCode"> | null {
  const segments = text.split(PLACE_SEGMENT_SEPARATOR).map((segment) => segment.trim());
  const readings = segments.map((segment) => readPlace(segment));
  const last = (kind: "country" | "us-state" | "ca-province", fullName = false) => {
    for (let index = readings.length - 1; index >= 0; index--) {
      const reading = readings[index];
      if (reading?.kind === kind && (!fullName || segments[index].length > 2)) return { index, code: reading.code };
    }
    return null;
  };
  const country = last("country");
  const state = last("us-state");
  const province = last("ca-province");
  const countryCode = country?.code
    ?? (last("us-state", true) ? "US" : province ? "CA" : state ? "US" : null);
  if (!countryCode) {
    for (const segment of segments) {
      const known = readWellKnownCity(segment);
      if (known) return { city: segment.replace(/\s*\([^)]*\)\s*/g, " ").trim() || segment, region: null, countryCode: known.code };
    }
    return null;
  }
  const region = countryCode === "US" ? state : countryCode === "CA" ? province : null;
  const city = segments.find((segment, index) => index !== country?.index && index !== region?.index
    && readings[index]?.kind !== "country" && PLACE_NAME.test(segment) && !WORK_MODE_WORDS.test(segment)) ?? null;
  return { city, region: region?.code ?? null, countryCode };
}

/**
 * The countries one location string names (an ATS location field, a list
 * column), read as a labelled location line is: "Seattle, WA" is US, "Berlin"
 * DE, "Hybrid" nothing.
 */
export function locationCountryCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const group of placeGroups(text)) {
    if (group.text.length > 200) continue;
    const place = readPlaceGroup(group.text);
    if (place?.countryCode) codes.add(place.countryCode);
  }
  return [...codes];
}

function workModeNear(text: string): JobWorkMode | null {
  if (/\bhybrid\b/i.test(text)) return "HYBRID";
  if (/\b(fully remote|remote[- ]first|100% remote|\bremote\b|home[- ]?(?:working|based)|work from home)\b/i.test(text)) return "REMOTE";
  if (/\b(on-?site|in-?office|in person)\b/i.test(text)) return "ONSITE";
  return null;
}

/* ------------------------------------------------------------------ */
/* Constraints                                                         */
/* ------------------------------------------------------------------ */

function extractConstraints(normalizedText: string): JobConstraints {
  return {
    graduation: extractGraduation(normalizedText),
    authorization: extractAuthorization(normalizedText),
    sponsorship: extractSponsorship(normalizedText),
    availability: extractAvailability(normalizedText)
  };
}

/**
 * The stretch of a constraint match kept as its `raw` text and span. A match
 * whose trimmed text fits STATED_CONSTRAINT_MAX_LENGTH is kept whole, so every
 * posting that fits today is unchanged. A longer one (a "sentence" with no
 * period or newline, such as a comma-joined list of clauses) keeps a window of
 * at most that length around its keyword: from 200 characters before the
 * keyword (never before the match) onward. Decisions (dates, country,
 * requires/offers) still read the whole match, so no eligibility reading
 * changes; only the stored text is shorter.
 */
function statedWindow(normalizedText: string, match: RegExpExecArray, keyword: RegExp): { start: number; end: number } {
  const start = match.index;
  const end = start + match[0].length;
  if (match[0].trim().length <= STATED_CONSTRAINT_MAX_LENGTH) return { start, end };
  const found = keyword.exec(match[0]);
  const at = start + (found?.index ?? 0);
  const windowStart = Math.max(start, at - 200);
  const windowEnd = Math.min(end, windowStart + STATED_CONSTRAINT_MAX_LENGTH, normalizedText.length);
  return { start: windowStart, end: windowEnd };
}

const GRADUATION_KEYWORD = /\b(?:graduat\w*|class of|degree conferred)\b/i;
const AUTHORIZATION_KEYWORD = /\b(?:legally\s+)?authoriz\w*\s+to\s+work\b|\bwork authorization\b/i;
const NEGATIVE_SPONSORSHIP_KEYWORD = /\b(?:not|unable to|does not|will not|cannot|no)\b[^\n.]{0,60}\bsponsor\w*\b/i;
const POSITIVE_SPONSORSHIP_KEYWORD = /\bsponsor\w*\b/i;
const AVAILABILITY_KEYWORD = /\b(?:start date|available to start|internship (?:runs|begins)|program (?:runs|begins))\b/i;

function extractGraduation(normalizedText: string): JobConstraints["graduation"] {
  const match = /[^\n.]*\b(?:graduat\w*|class of|degree conferred)\b[^\n.]*/i.exec(normalizedText);
  if (!match) return null;
  const window = monthYearWindow(match[0]);
  const kept = statedWindow(normalizedText, match, GRADUATION_KEYWORD);
  return {
    earliest: window.earliest,
    latest: window.latest,
    raw: normalizedText.slice(kept.start, kept.end).trim(),
    extraction: "DETERMINISTIC",
    assertion: "STATED",
    span: span(normalizedText, kept.start, kept.end)
  };
}

function extractAuthorization(normalizedText: string): JobConstraints["authorization"] {
  const match = /[^\n.]*\b(?:legally\s+)?authoriz\w*\s+to\s+work\b[^\n.]*/i.exec(normalizedText)
    ?? /[^\n.]*\bwork authorization\b[^\n.]*/i.exec(normalizedText);
  if (!match) return null;
  const kept = statedWindow(normalizedText, match, AUTHORIZATION_KEYWORD);
  return {
    requiresExistingAuthorization: !/\bnot\s+(?:be\s+)?required\b/i.test(match[0]),
    countryCode: countryCodeIn(match[0]),
    raw: normalizedText.slice(kept.start, kept.end).trim(),
    extraction: "DETERMINISTIC",
    assertion: "STATED",
    span: span(normalizedText, kept.start, kept.end)
  };
}

/**
 * Only sentences that actually commit to a sponsorship position count. A bare
 * mention of the word leaves the field null, which Milestone 4 must read as
 * "the posting is silent", never as "sponsorship is offered".
 */
function extractSponsorship(normalizedText: string): JobConstraints["sponsorship"] {
  const negative = /[^\n.]*\b(?:not|unable to|does not|will not|cannot|no)\b[^\n.]{0,60}\bsponsor\w*\b[^\n.]*/i
    .exec(normalizedText);
  if (negative) {
    return sponsorshipConstraint(normalizedText, negative, false, NEGATIVE_SPONSORSHIP_KEYWORD);
  }
  const positive = /[^\n.]*\bsponsor\w*\b[^\n.]{0,60}\b(?:is\s+)?(?:available|offered|provided)\b[^\n.]*/i
    .exec(normalizedText)
    ?? /[^\n.]*\b(?:we|company)\s+(?:do|does|will)\s+sponsor\b[^\n.]*/i.exec(normalizedText);
  return positive ? sponsorshipConstraint(normalizedText, positive, true, POSITIVE_SPONSORSHIP_KEYWORD) : null;
}

function sponsorshipConstraint(
  normalizedText: string,
  match: RegExpExecArray,
  available: boolean,
  keyword: RegExp
): JobConstraints["sponsorship"] {
  const kept = statedWindow(normalizedText, match, keyword);
  return {
    sponsorshipAvailable: available,
    countryCode: countryCodeIn(match[0]),
    raw: normalizedText.slice(kept.start, kept.end).trim(),
    extraction: "DETERMINISTIC",
    assertion: "STATED",
    span: span(normalizedText, kept.start, kept.end)
  };
}

function extractAvailability(normalizedText: string): JobConstraints["availability"] {
  const match = /[^\n.]*\b(?:start date|available to start|internship (?:runs|begins)|program (?:runs|begins))\b[^\n.]*/i
    .exec(normalizedText);
  if (!match) return null;
  const window = monthYearWindow(match[0]);
  const kept = statedWindow(normalizedText, match, AVAILABILITY_KEYWORD);
  return {
    earliestStart: window.earliest,
    latestStart: window.latest,
    raw: normalizedText.slice(kept.start, kept.end).trim(),
    extraction: "DETERMINISTIC",
    assertion: "STATED",
    span: span(normalizedText, kept.start, kept.end)
  };
}

/**
 * Only an explicit month and year become dates. A season or a bare year leaves
 * both bounds null: the constraint is still recorded as stated, with its raw
 * text, rather than inventing a precision the posting does not carry.
 */
function monthYearWindow(text: string): { earliest: string | null; latest: string | null } {
  const matches = [...text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{4})\b/g)]
    .flatMap((match) => {
      const month = MONTHS[match[1].toLocaleLowerCase("en-US")];
      const year = Number.parseInt(match[2], 10);
      return month && year >= 2000 && year <= 2100 ? [{ month, year }] : [];
    })
    .sort((left, right) => left.year - right.year || left.month - right.month);

  if (matches.length === 0) return { earliest: null, latest: null };
  const first = matches[0];
  const last = matches.at(-1)!;
  return {
    earliest: `${first.year}-${pad(first.month)}-01`,
    latest: `${last.year}-${pad(last.month)}-${pad(daysInMonth(last.year, last.month))}`
  };
}

function countryCodeIn(text: string): string | null {
  if (/\b(united states|u\.?s\.?a?\.?|america)\b/i.test(text)) return "US";
  if (/\b(canada|canadian)\b/i.test(text)) return "CA";
  if (/\b(united kingdom|u\.?k\.?)\b/i.test(text)) return "GB";
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
