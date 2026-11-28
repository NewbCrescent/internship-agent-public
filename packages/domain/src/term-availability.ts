import type { BrowserField } from "./browser";
import { booleanOption } from "./standard-answers";

/**
 * (Track 89) Internship term and availability questions answered from the saved availability window
 * (available_start_date..available_end_date, both user-saved): the one offered summer term the window falls in, a Yes
 * to a summer-internship availability confirmation the window covers, and the window typed as start and end dates. A
 * stated span or date outside the window, another season, another year, or an unread date pauses (like Track 83's
 * availabilityWindowHold). withoutCoveredTerm removes the summer term and spans the window covers, so relocation and
 * on-site rules do not hold on them.
 */

export type AvailabilityWindow = { start: string | null; end: string | null };
export type TermAnswer = { action: "choose" | "fill" | "check"; value: string; reason: string };

const key = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[‐-―−–—]/g, "-")
  .replace(/\s+/g, " ").trim();

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ALT = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec";
const monthOf = (word: string) => MONTHS.findIndex((month) => month.startsWith(word.toLocaleLowerCase("en-US").slice(0, 3))) + 1;

type SummerWindow = { y: number; sm: number; sd: number; em: number; ed: number; start: string; end: string };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoParts(date: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = ISO.exec(date ?? "");
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) return null;
  return { y, m, d };
}

function iso(y: number, m: number, d: number): string | null {
  const text = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isoParts(text) ? text : null;
}

/** The saved window when both dates are valid and it lies inside May–September of one year; null otherwise. */
function summerWindow(window: AvailabilityWindow | undefined): SummerWindow | null {
  const start = isoParts(window?.start);
  const end = isoParts(window?.end);
  if (!start || !end || start.y !== end.y || window!.start! > window!.end!) return null;
  if (start.m < 5 || end.m > 9) return null;
  return { y: start.y, sm: start.m, sd: start.d, em: end.m, ed: end.d, start: window!.start!, end: window!.end! };
}

// Spans stated in a key()ed text: "June 1st to August 31st, 2031", "May - August 2031", "May/June starts", "Summer 2031".
const DAY_SPAN = new RegExp(String.raw`\b(${MONTH_ALT})\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d\d))?\s*(?:-|to|through|until)\s*(${MONTH_ALT})\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d\d))?`, "g");
const MONTH_SPAN = new RegExp(String.raw`\b(${MONTH_ALT})\b\.?\s*(?:-|to|through|until)\s*(${MONTH_ALT})\b\.?(?!\s*\d{1,2}\b(?!\d))(?:,?\s*(20\d\d))?`, "g");
const MONTH_PAIR_STARTS = new RegExp(String.raw`\b(${MONTH_ALT})\b\s*\/\s*(${MONTH_ALT})\b\s+starts?\b`, "g");
const SUMMER_TERM = /\bsummer(?:\s+(?:of\s+)?(20\d\d))?\b/g;
const SPAN_FLAGS = "gi";

type Span = { pattern: RegExp; covered: (match: RegExpExecArray | string[], w: SummerWindow) => boolean };

const SPANS: Span[] = [
  {
    pattern: DAY_SPAN,
    covered: (m, w) => {
      const from = iso(Number(m[3] ?? m[6] ?? w.y), monthOf(m[1]!), Number(m[2]));
      const to = iso(Number(m[6] ?? w.y), monthOf(m[4]!), Number(m[5]));
      return from !== null && to !== null && w.start <= from && to <= w.end;
    }
  },
  {
    pattern: MONTH_SPAN,
    covered: (m, w) => {
      const [first, last] = [monthOf(m[1]!), monthOf(m[2]!)];
      return (m[3] === undefined || Number(m[3]) === w.y) && first >= w.sm && last <= w.em && first <= last;
    }
  },
  {
    pattern: MONTH_PAIR_STARTS,
    covered: (m, w) => w.sm === monthOf(m[1]!) || w.sm === monthOf(m[2]!)
  }
];
const SUMMER_SPAN: Span = { pattern: SUMMER_TERM, covered: (m, w) => m[1] === undefined || Number(m[1]) === w.y };

/** Replaces each match of a span in `text`: covered ones with " ", uncovered ones too when `removeUncovered`; reports whether any was not covered. */
function replaceSpan(text: string, span: Span, w: SummerWindow, options: { removeUncovered: boolean; flags?: string; parentheses?: boolean }): { text: string; uncovered: boolean } {
  let uncovered = false;
  const source = options.parentheses ? String.raw`\(\s*(?:${span.pattern.source})\s*\)|${span.pattern.source}` : span.pattern.source;
  const pattern = new RegExp(source, options.flags ?? "g");
  const replaced = text.replace(pattern, (whole: string) => {
    // Re-read the match alone, so the groups belong to the span itself, not the parenthesized form.
    const inner = new RegExp(span.pattern.source, options.flags?.includes("i") ? "i" : "").exec(whole);
    if (inner && span.covered(inner, w)) return " ";
    uncovered = true;
    return options.removeUncovered ? " " : whole;
  });
  return { text: replaced, uncovered };
}

const LEFTOVER_DATE = /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\bmay\s+\d|\b20\d\d\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\b/;

/** Whether a key()ed text states only spans and summer terms the window covers, and no other date. */
function onlyCoveredDates(text: string, w: SummerWindow): boolean {
  let rest = text;
  for (const span of [...SPANS, SUMMER_SPAN]) {
    const read = replaceSpan(rest, span, w, { removeUncovered: true });
    if (read.uncovered) return false;
    rest = read.text;
  }
  rest = rest.replace(new RegExp(String.raw`\b${w.y}\b`, "g"), " ");
  return !LEFTOVER_DATE.test(rest);
}

const SEASON_WORDS = /\b(spring|summer|fall|autumn|winter)\b/g;
const YEARS = /\b20\d\d\b/g;

function onlySummer(text: string): boolean {
  const seasons = new Set([...text.matchAll(SEASON_WORDS)].map((match) => match[1]!));
  return seasons.size === 1 && seasons.has("summer");
}

function onlyYear(text: string, year: number): boolean {
  return [...text.matchAll(YEARS)].every((match) => Number(match[0]) === year);
}

const GRAD_EXCLUDE = /\bgraduat\w*|\bdegree\b|\bschool\b|\bclass of\b|\benroll\w*|\bacademic\b|\bstud(?:y|ying|ies|ent|ents)\b|\bfull[- ]?time (?:role|position|job|employment|offer|opportunit\w*)\b|\breturn\w*/;
const TERM_QUESTIONS = [
  /\bwhich (?:internship |work |co-?op )?(?:term|terms|term\(s\)|season|seasons|season\(s\)|session|sessions|cohort|cohorts)\b/,
  /\bare you (?:interested in|applying (?:to intern )?(?:for|in)|applying to intern in)\b[^?]{0,60}\b(?:spring|summer|fall|autumn|winter)\b/,
  /^(?:please )?confirm the (?:season|term) you are applying (?:for|to)\.?$/,
  /^(?:work|internship) terms?(?: availability)?$/
];

/** (Track 89) Whether a label asks which internship term or season the candidate applies for ("Which term(s) are you applying for?"). */
export function isInternshipTermQuestion(label: string): boolean {
  const k = key(label);
  if (GRAD_EXCLUDE.test(k)) return false;
  return TERM_QUESTIONS.some((pattern) => pattern.test(k));
}

const PLACEHOLDER = /^(?:select|choose|please select)\b|^-+$|^\.\.\.$/;
const NOT_ONE_TERM = /\b(?:both|either|all|any|co-?op)\b/;
const CONFIRM = /\b(?:i )?confirm (?:my )?availability for (?:a |an |the )?summer\b|\bare you available (?:to commit )?(?:to|for) (?:a |an |the )?summer\b/;
const ASKS_MORE = /\b(?:relocat\w*|on[- ]?site|in[- ]office|in[- ]person|office|commut\w*|remote|hybrid|full[- ]?time|part[- ]?time|hours?|weekends?|graduat\w*|return\w*|offer\w*|weeks?|months?)\b/;
const DATES_TEXT = /\b(?:list|provide|enter|state|give|share)\b[^?]{0,40}\bdates? of (?:your )?(?:internship )?availability\b|\binternship availability dates?\b/;
const NOT_DATES_TEXT = /\binterview\w*|\bweekly\b|\bhours?\b/;

const TERM_REASON = "Your saved availability falls in this summer term.";
const CONFIRM_REASON = "Your saved availability window covers the summer internship this asks about.";
const DATES_REASON = "Your saved availability window, start and end dates.";

const usDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

/**
 * (Track 89) The answer the saved availability window gives a term or availability question: the one summer term
 * option it falls in, a Yes to a summer availability confirmation it covers, or its dates typed into a dates box.
 * Null for any other question, a window not inside one summer, or when none or several options qualify.
 */
export function internshipTermAnswer(
  field: Pick<BrowserField, "label" | "kind" | "options" | "widget">,
  window: AvailabilityWindow | undefined
): TermAnswer | null {
  const w = summerWindow(window);
  if (!w || field.widget === "autocomplete") return null;
  const label = key(field.label);
  const options = (field.options ?? []).filter((option) => !PLACEHOLDER.test(key(option)));
  const choice = field.kind === "select" || field.kind === "radio" || field.kind === "checkbox";
  if (choice && options.length >= 1 && isInternshipTermQuestion(field.label)) {
    const hits = options.filter((option) => {
      const k = key(option);
      return onlySummer(k) && !NOT_ONE_TERM.test(k) && onlyYear(k, w.y) && onlyCoveredDates(k, w);
    });
    return hits.length === 1 ? { action: "choose", value: hits[0]!, reason: TERM_REASON } : null;
  }
  if (CONFIRM.test(label) && !ASKS_MORE.test(label) && !GRAD_EXCLUDE.test(label) && onlySummer(label) && onlyYear(label, w.y) && onlyCoveredDates(label, w)) {
    if ((field.kind === "select" || field.kind === "radio") && options.length) {
      const yes = booleanOption(true, options);
      return yes ? { action: "choose", value: yes, reason: CONFIRM_REASON } : null;
    }
    if (field.kind === "checkbox" && options.length === 0) return { action: "check", value: "true", reason: CONFIRM_REASON };
    return null;
  }
  if ((field.kind === "text" || field.kind === "textarea") && DATES_TEXT.test(label) && !NOT_DATES_TEXT.test(label)) {
    return { action: "fill", value: `${usDate(w.start)} - ${usDate(w.end)}`, reason: DATES_REASON };
  }
  return null;
}

/**
 * (Track 89) The text with the summer term and the spans the saved window covers removed ("(June-August)",
 * "(Summer 2031)", with their parentheses when they hold only that span). Uncovered spans stay, so their holds still
 * apply. The text unchanged when the window is not one summer.
 */
export function withoutCoveredTerm(text: string, window: AvailabilityWindow | undefined): string {
  const w = summerWindow(window);
  if (!w) return text;
  // The original text is kept apart from the spans, with dashes read as "-" so the spans match.
  let rest = text.normalize("NFKC").replace(/[‐-―−–—]/g, "-");
  for (const span of [...SPANS, SUMMER_SPAN]) {
    rest = replaceSpan(rest, span, w, { removeUncovered: false, flags: SPAN_FLAGS, parentheses: true }).text;
  }
  return rest.replace(/\s+/g, " ").replace(/\s+([?.!,:;])/g, "$1").trim();
}
