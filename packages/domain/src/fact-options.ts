import { booleanOption } from "./standard-answers";

/**
 * Deterministic rules by which a saved fact picks one offered option when no
 * option repeats its value (2026-11-24): the salary rule agrees with a
 * posting's advertised range, own-expense relocation picks its option (or
 * "already located near the city" when the profile's place is the posting's
 * one place), the available start date picks an offer-relative bucket
 * ("2–4 weeks", "6+ weeks", "Within 1 month after offer acceptance") counted
 * from today, background-check willingness picks Yes or No, and the
 * graduation date picks the term option holding it ("Spring 2027",
 * "December 2027", "December 2028 or later"; Track 43), a season pair
 * ("Spring/Summer 2028") or a degree level with a date range ("Bachelors -
 * Junior (December 2027 - June 2028)"; Track 57). A saved Yes/No work
 * authorization or relocation willingness picks the one option that starts
 * with its Yes or No and says nothing more (Track 57). When several options
 * start with Yes, a saved relocation Yes picks the one Yes option that names
 * relocating and says nothing more, a saved U.S. citizenship picks the one
 * work-authorization option citizenship makes true (citizenAuthorizationOption),
 * and `relocationQuestionParts` reads what else a relocation question asks
 * (Track 62). Each rule returns null rather than guess, so the field pauses.
 */

/** Keys whose saved value picks an offered option by a rule (planner: factOptionDecision). */
export const FACT_OPTION_KEYS: ReadonlySet<string> = new Set([
  "salary_expectation_rule",
  "willing_to_relocate_at_own_expense",
  "available_start_date",
  "willing_background_check",
  "graduation_date"
]);

export type FactOptionContext = { today?: string; nearPosting: boolean; degreeLevel?: "bachelor" | null };

/** Option text compared: NFKC, lower case, straight quotes, "-" for dashes, whitespace collapsed. */
function optionKey(option: string): string {
  return option
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };
const UNIT = "(day|week|month)s?";
const IMMEDIATE = /^(?:immediately|immediate|right away|asap|as soon as possible)\b/;
const RANGE = new RegExp(`^(\\d+)\\s*-\\s*(\\d+)\\s*${UNIT}$`);
const PLUS = new RegExp(`^(\\d+)\\s*\\+\\s*${UNIT}$`);
const MORE_THAN = new RegExp(`^(?:more than|over|at least|longer than) (\\d+)\\s*${UNIT}$`);
const OR_MORE = new RegExp(`^(\\d+)\\s*${UNIT} or (?:more|longer)$`);
const UP_TO = new RegExp(`^(?:(?:within|less than|under|up to|in) )?(\\d+)\\s*${UNIT}$`);
// "Within 1 month after offer acceptance" (micron.wd1, 2026-11-25): the window counts from the offer, as every bucket does.
const OFFER_SUFFIX = /\s*\b(?:after|from|following|of)\s+(?:(?:the|an|my)\s+)?(?:offer(?:\s+acceptance)?|acceptance(?:\s+of\s+(?:(?:the|an)\s+)?offer)?|accepting\s+(?:(?:the|an)\s+)?offer)$/;

/** The days from an offer an option allows ("2-4 weeks" is 14 to 28; "6+ weeks" is 42 or more); null when it names none. */
export function startWindowDays(option: string): { min: number; max: number } | null {
  const key = optionKey(option).replace(OFFER_SUFFIX, "");
  if (IMMEDIATE.test(key)) return { min: 0, max: 0 };
  let match = RANGE.exec(key);
  if (match) {
    const unit = UNIT_DAYS[match[3]!]!;
    const low = Number(match[1]) * unit;
    const high = Number(match[2]) * unit;
    return low <= high ? { min: low, max: high } : null;
  }
  match = PLUS.exec(key) ?? MORE_THAN.exec(key) ?? OR_MORE.exec(key);
  if (match) return { min: Number(match[1]) * UNIT_DAYS[match[2]!]!, max: Infinity };
  match = UP_TO.exec(key);
  if (match) return { min: 1, max: Number(match[1]) * UNIT_DAYS[match[2]!]! };
  return null;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDay(date: string): number | null {
  const match = ISO.exec(date);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) return null;
  return time / 86_400_000;
}

/**
 * The "how soon after an offer could you start" bucket for a start date:
 * whole days from today (a past date counts as 0), then the matching bucket
 * with the latest start, so a boundary day never promises an earlier start.
 * Null when fewer than two options name a window, none matches, or two tie.
 */
export function startBucketOption(options: readonly string[], startDate: string, today: string): { option: string; days: number } | null {
  const start = utcDay(startDate);
  const now = utcDay(today);
  if (start === null || now === null) return null;
  const days = Math.max(0, start - now);
  const parsed = options.map((option) => ({ option, window: startWindowDays(option) }))
    .filter((entry): entry is { option: string; window: { min: number; max: number } } => entry.window !== null);
  if (parsed.length < 2) return null;
  const hits = parsed.filter(({ window }) => window.min <= days && days <= window.max);
  if (hits.length === 0) return null;
  const latest = Math.max(...hits.map(({ window }) => window.min));
  const best = hits.filter(({ window }) => window.min === latest);
  return best.length === 1 ? { option: best[0]!.option, days } : null;
}

const AGREE = /^(?:yes|agree|i agree|i am comfortable|i'm comfortable|comfortable|i accept|accept|acceptable)\b/;
const DISAGREE = /\b(?:not|no|disagree|don't|do not|uncomfortable|unable)\b/;

/** The one agreeing option ("Yes", "Agree", "I am comfortable"); null when none or several. */
export function agreeOption(options: readonly string[]): string | null {
  const matches = options.filter((option) => {
    const key = optionKey(option);
    return AGREE.test(key) && !DISAGREE.test(key);
  });
  return matches.length === 1 ? matches[0]! : null;
}

// Option words that say more than a Yes/No work authorization: sponsorship, visas, citizenship or residence, permanence or restrictions, an employer, a time limit.
const BEYOND_AUTHORIZATION = /\b(?:sponsor\w*|visas?|citizen\w*|nationals?|permanent\w*|green card|residen\w*|unrestricted|restrict\w*|indefinite\w*|employers?|export\w*|clearances?|h-?1b|opt|cpt|f-?1|j-?1|temporar\w*|fixed|renew\w*|extensions?|pending)\b/;
// Option words that say more than a Yes/No willingness to relocate: who pays, housing, commuting, already living nearby, remote or office terms, a temporary move.
const BEYOND_RELOCATION = /\b(?:own|expenses?|costs?|assist\w*|support\w*|reimburs\w*|packages?|stipends?|housing|commut\w*|located|live|living|nearby|near|resid\w*|remote|hybrid|office|temporar\w*)\b/;

/**
 * The option a saved Yes/No work authorization or relocation willingness picks when no option is exactly "Yes"/"No"
 * (Track 57): the one option that starts with the saved Yes or No (booleanOption) and says nothing beyond it; null
 * when none start so, or the option names more (sponsorship, citizenship, restrictions, an employer; who pays,
 * commuting, living nearby). When several options start with Yes, a saved relocation Yes picks the one that names
 * relocating and says nothing more ("Yes: I am willing to relocate" beside "Yes: I live nearby or the role is
 * remote"; Track 62); otherwise null. Other keys return null.
 */
export function savedYesNoOption(key: string, value: boolean | string, options: readonly string[]): string | null {
  if (typeof value !== "boolean") return null;
  const beyond = key === "authorized_to_work" ? BEYOND_AUTHORIZATION : key === "willing_to_relocate" ? BEYOND_RELOCATION : null;
  if (!beyond) return null;
  const option = booleanOption(value, options);
  if (option) return !beyond.test(optionKey(option)) ? option : null;
  if (key !== "willing_to_relocate" || value !== true) return null;
  const plain = options.filter((candidate) => {
    const text = optionKey(candidate);
    return /^yes\b/.test(text) && /\brelocat\w*/.test(text) && !BEYOND_RELOCATION.test(text);
  });
  return plain.length === 1 ? plain[0]! : null;
}

// An option that affirms work authorization: it starts with a Yes, "Authorized", "Eligible", "Unrestricted" or "U.S. citizen", or says "I am authorized / eligible / permitted / a citizen".
const CITIZEN_AFFIRMS = [
  /^(?:yes|authori[sz]ed|eligible|unrestricted|(?:u\.?s\.? )?citizen)\b/,
  /\b(?:i am|i'm|i have)\b.{0,30}\b(?:authori[sz]ed|eligible|permitted|the (?:legal )?right|a (?:u\.?s\.? )?citizen)\b/
];
// Words citizenship does not settle: a No or a negation, restrictions or a time limit, one employer, a visa or permit class, an unknown status, a clearance or export-control status, another country.
const CITIZEN_DENIES = [
  /^no\b/,
  /\bnot\b.{0,25}\b(?:authori[sz]ed|eligible|permitted|legally|able|a citizen)\b/,
  /\b(?:restrict(?:ed|ion|ions|s)?|limited|fixed|temporar\w*|conditional|time[- ]limited|expir\w*)\b/,
  /\brequir\w*\b.{0,30}\b(?:extensions?|renewals?)\b/,
  /\b(?:present|current|my|one|a single|specific|this)\s+employer\b/,
  /\b(?:opt|cpt|h-?1b|f-?1|j-?1|tn visa|e-?3|ead|daca|tps|asylum|asylee|refugee|work permit)\b/,
  /\b(?:pending|unknown|unsure|not sure|other|explain|prefer not)\b/,
  /\b(?:clearances?|export\w*|itar|u\.?s\.? persons?)\b/,
  /\b(?:canada|united kingdom|uk|britain|european union|eu|mexico|india|australia|germany|ireland|china|japan)\b/
];
const SPONSORSHIP = /\bsponsor\w*|\bvisas?\b/;
const NO_SPONSORSHIP = /\b(?:will not|won't|do not|don't|does not|doesn't|never|without)\b.{0,30}\b(?:sponsor\w*|visas?)\b/;
const PERMANENT_RESIDENCE = /\b(?:permanent resident\w*|lawful permanent|green card)\b/;
const NATIONAL = /\bnationals?\b/;
const CITIZEN_WORD = /\bcitizen\w*/;
// A qualified or changing claim ("… now but will in the future", "until …"): citizenship does not make the whole option true.
const CITIZEN_CHANGING_CLAIM = /\b(?:but|however|although|though|until|except|unless)\b/;
// A need for sponsorship, a visa or another status later ("I will need it later", "may require sponsorship in the future").
const CITIZEN_FUTURE_NEED = /\b(?:will|may|might|could|would|expect to|going to|plan to)\s+(?:(?:eventually|later|soon|also)\s+)?(?:need|require)\b/;

function citizenSettles(key: string): boolean {
  if (!CITIZEN_AFFIRMS.some((pattern) => pattern.test(key))) return false;
  if (CITIZEN_DENIES.some((pattern) => pattern.test(key))) return false;
  if (CITIZEN_CHANGING_CLAIM.test(key) || CITIZEN_FUTURE_NEED.test(key)) return false;
  if (SPONSORSHIP.test(key) && !NO_SPONSORSHIP.test(key)) return false;
  if (PERMANENT_RESIDENCE.test(key) && !CITIZEN_WORD.test(key)) return false;
  if (NATIONAL.test(key) && !CITIZEN_WORD.test(key)) return false;
  return true;
}

/**
 * The one U.S. work-authorization option that U.S. citizenship makes true (Track 62; the candidate's statement,
 * 2026-11-27: "I am a citizen"): an option that affirms authorization and names nothing citizenship does not settle
 * (restrictions or a time limit, one employer, a visa or permit class, needed sponsorship, permanent residence or
 * nationality alone, a clearance or export-control status, another country, an unknown status, a qualified or changing
 * claim (but, until, unless …) or a need stated for later). Never an option
 * citizenship does not settle; null when none or several qualify. Placeholders ("Select One") never qualify.
 */
export function citizenAuthorizationOption(options: readonly string[]): string | null {
  const hits = options.filter((option) => citizenSettles(optionKey(option)));
  return hits.length === 1 ? hits[0]! : null;
}

const RELOCATION_ON_SITE = /\b(?:in[- ]office|on[- ]?site|in[- ]person|office|hybrid)\b|\b(?:\d+|one|two|three|four|five)\s+days?\s+(?:a|per|each|every)\s+week\b/;
const RELOCATION_LOCAL_WORDS = /\b(?:commut\w*|located|live|living|lives|reside|residing|resident|based|nearby|near|local(?:ly)?)\b/;
const RELOCATION_DISJUNCTION = [
  /\b(?:commut\w*|located|live|living|reside|residing|based|nearby|near|local)\b.{0,80}?\b(?:or|if not)\b.{0,40}?\brelocat/,
  /\brelocat\w*.{0,40}?\bor\b.{0,80}?\b(?:commut\w*|located|live|living|reside|residing|based|nearby|near|local)\b/
];
const RELOCATION_TEMPORARY = /\btemporar\w*/;
const RELOCATION_LATER = /\bpermanent\w*|\bfull[- ]?time (?:role|position|job|offer|employment|opportunit\w*)\b|\bupon (?:completion|graduation)\b|\bafter (?:you )?graduat\w*|\bpost[- ]?graduat\w*/;
const RELOCATION_SUPPORT = /\b(?:support|assistance|assist|reimburs\w*|packages?|stipends?|housing|expenses?|costs?|pay for|own expense)\b/;
const RELOCATION_DATES = [
  /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sept?|oct|nov|dec)\b/,
  /\bmay\b(?=\s*(?:-|to\b|through\b|and\b|or\b|\d))|\b(?:between|from|in|starting|until|through|by|of)\s+may\b/,
  /\b(?:\d+|one|two|three|four|five|six|eight|ten|twelve)[- ](?:consecutive[- ])?(?:weeks?|months?)\b/,
  /\b20\d\d\b/,
  /\b\d{1,2}\/\d{1,2}\b/
];
const RELOCATION_REMOTE = /\bremote(?:ly)?\b/;

/**
 * What else a relocation question asks besides relocating (Track 62): `onSite` when it names office or on-site work
 * or a number of days a week, `local` when it offers living nearby or commuting joined to relocating by "or", and
 * `held` the reason a part the saved relocation answer cannot settle stays open (a temporary or permanent move, who
 * pays, stated dates or lengths, remote work, or living nearby asked alongside relocating). Only the relocation part
 * is answered from the saved relocation answer.
 */
export function relocationQuestionParts(question: string): { onSite: boolean; local: boolean; held: string | null } {
  const text = optionKey(question);
  const onSite = RELOCATION_ON_SITE.test(text);
  const localWords = RELOCATION_LOCAL_WORDS.test(text);
  const disjunction = RELOCATION_DISJUNCTION.some((pattern) => pattern.test(text));
  const local = localWords && disjunction;
  let held: string | null = null;
  if (RELOCATION_TEMPORARY.test(text)) held = "It asks about a temporary move.";
  else if (RELOCATION_LATER.test(text)) held = "It asks about a permanent move or one after the internship.";
  else if (RELOCATION_SUPPORT.test(text)) held = "It also says who pays for the move or what support comes with it.";
  else if (RELOCATION_DATES.some((pattern) => pattern.test(text))) held = "It also asks about your availability on stated dates or for a stated length.";
  else if (RELOCATION_REMOTE.test(text)) held = "It also asks about remote work.";
  else if (localWords && !disjunction) held = "It also asks whether you already live nearby or can commute.";
  return { onSite, local, held };
}

const LOCAL = /\b(?:located|live|living|reside|residing|based)\b.{0,40}\b(?:in|near|within|close to|around)\b/;
const OWN = /\brelocat\w*\b.{0,60}\b(?:(?:my |your )?own (?:expense|cost)s?|without (?:relocation )?(?:assistance|support|reimbursement)|self[- ]funded)\b/;
const NEGATED = /\b(?:not|unwilling|unable|cannot|can't|won't|will not)\b/;

const isLocal = (key: string) => LOCAL.test(key) && !key.includes("relocat") && !/^no\b/.test(key) && !NEGATED.test(key);
const isOwn = (key: string) => OWN.test(key) && !NEGATED.test(key);

/**
 * The option of a combined "Are you located in or near the city? If not, are
 * you willing to relocate at your own expense?" question: "already located"
 * only when the profile's place is the posting's, else the own-expense option
 * when the saved answer is yes. A plain Yes/No list takes Yes only for a
 * saved yes. Null otherwise (a saved no pauses; nothing is guessed).
 */
export function relocationOption(value: boolean, options: readonly string[], nearPosting: boolean): { option: string; local: boolean } | null {
  const keys = options.map(optionKey);
  const local = options.filter((_, index) => isLocal(keys[index]!));
  const own = options.filter((_, index) => isOwn(keys[index]!));
  const plain = local.length === 0 && own.length === 0;
  if (nearPosting) {
    if (local.length === 1) return { option: local[0]!, local: true };
    if (plain && value) {
      const yes = booleanOption(true, options);
      return yes ? { option: yes, local: false } : null;
    }
    return null;
  }
  if (!value) return null;
  if (own.length === 1) return { option: own[0]!, local: false };
  if (plain) {
    const yes = booleanOption(true, options);
    return yes ? { option: yes, local: false } : null;
  }
  return null;
}

const placeKey = (place: string) => place.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");

/** Whether the profile's "City, Region" is the posting's one place, exactly ("Berkeley, CA" is not "Berkeley, California"). */
export function samePlace(current: string | undefined, postingLocations: readonly string[] | undefined): boolean {
  if (!current || !postingLocations || postingLocations.length !== 1) return false;
  const key = placeKey(current);
  return key.length > 0 && key === placeKey(postingLocations[0]!);
}

const MONTH_WORDS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Graduation seasons as months: Spring April–June (semester and quarter ends), Summer July–August, Fall or Autumn September–December. Winter spans two years and is never read alone or first; as the second season of a pair ("Fall/Winter 2027") it adds no months.
const SEASONS: Record<string, [number, number]> = { spring: [4, 6], summer: [7, 8], fall: [9, 12], autumn: [9, 12] };
const TERM = /^(?:(spring|summer|fall|autumn)(?:\s*[\/-]\s*(spring|summer|fall|autumn|winter))?|(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?)\s+(20\d\d)(?:\s+(or later|or after|and later|and after|or earlier|or before|and earlier|and before))?$/;

/** The months (year * 12 + month - 1) a graduation term option covers: "Spring 2027", "Spring/Summer 2028", "Fall/Winter 2027", "December 2027", "Dec 2027", "December 2028 or later", "Spring 2026 or earlier"; null when it names none. */
export function graduationTermMonths(option: string): { from: number; to: number } | null {
  const match = TERM.exec(optionKey(option));
  if (!match) return null;
  const year = Number(match[4]);
  let first: number;
  let last: number;
  if (match[1]) {
    first = SEASONS[match[1]]![0];
    const second = match[2];
    if (second && second !== "winter") {
      const secondLast = SEASONS[second]![1];
      if (secondLast < first) return null;
      last = secondLast;
    } else {
      last = SEASONS[match[1]]![1];
    }
  } else {
    const word = match[3]!;
    const index = MONTH_WORDS.findIndex((name) => name.startsWith(word));
    if (index < 0) return null;
    first = last = index + 1;
  }
  const end = match[5] ?? "";
  const from = /earlier|before/.test(end) ? -Infinity : year * 12 + first - 1;
  const to = /later|after/.test(end) ? Infinity : year * 12 + last - 1;
  return { from, to };
}

/** The one term option holding a YYYY-MM-DD graduation date; null when fewer than two options name a term, or none or several hold it. */
export function graduationTermOption(options: readonly string[], date: string): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const value = Number(match[1]) * 12 + month - 1;
  const parsed = options.map((option) => ({ option, months: graduationTermMonths(option) }))
    .filter((entry): entry is { option: string; months: { from: number; to: number } } => entry.months !== null);
  if (parsed.length < 2) return null;
  const hits = parsed.filter(({ months }) => months.from <= value && value <= months.to);
  return hits.length === 1 ? hits[0]!.option : null;
}

const MONTH = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";
const DATE_RANGE = new RegExp(`\\b${MONTH}\\.?\\s+(20\\d\\d)\\s*(?:-|to|through)\\s*${MONTH}\\.?\\s+(20\\d\\d)\\b`);

function monthIndex(word: string): number {
  return MONTH_WORDS.findIndex((name) => name.startsWith(word));
}

/** The degree level an option names ("Bachelors - Junior", "Masters - 1st Year", "Doctorate Student"); null when it names none. */
function optionDegreeLevel(key: string): "bachelor" | "master" | "doctorate" | null {
  if (/\b(?:bachelor'?s?|undergrad\w*)\b/.test(key)) return "bachelor";
  if (/\b(?:master'?s?|mba)\b/.test(key)) return "master";
  if (/\b(?:doctor\w*|ph\.?\s?d)\b/.test(key)) return "doctorate";
  return null;
}

/**
 * The one degree-and-range option ("Bachelors - Junior (December 2027 - June 2028)") of the profile degree's level
 * whose month range holds a YYYY-MM-DD graduation date (Track 57); null when fewer than two options name a range,
 * the options name levels and the profile's level is unknown, or none or several hold it.
 */
export function graduationRangeOption(options: readonly string[], date: string, level: "bachelor" | null): string | null {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const value = Number(match[1]) * 12 + month - 1;
  const parsed: { option: string; from: number; to: number; level: "bachelor" | "master" | "doctorate" | null }[] = [];
  for (const option of options) {
    const key = optionKey(option);
    const range = DATE_RANGE.exec(key);
    if (!range) continue;
    const m1 = monthIndex(range[1]!);
    const m2 = monthIndex(range[3]!);
    if (m1 < 0 || m2 < 0) continue;
    const from = Number(range[2]) * 12 + m1;
    const to = Number(range[4]) * 12 + m2;
    if (to < from) continue;
    parsed.push({ option, from, to, level: optionDegreeLevel(key) });
  }
  if (parsed.length < 2) return null;
  const kept = parsed.some((entry) => entry.level !== null) ? parsed.filter((entry) => level !== null && entry.level === level) : parsed;
  const hits = kept.filter(({ from, to }) => from <= value && value <= to);
  return hits.length === 1 ? hits[0]!.option : null;
}

/** The option a saved fact picks by its rule, with the reason shown; null when the rule does not decide. */
export function factOption(key: string, value: boolean | string, options: readonly string[], context: FactOptionContext): { option: string; reason: string } | null {
  if (key === "salary_expectation_rule" && value === "posting_pay_hourly") {
    const option = agreeOption(options);
    return option ? { option, reason: "Your salary rule is the posting's stated pay, so you agree with its advertised range." } : null;
  }
  if (key === "willing_to_relocate_at_own_expense" && typeof value === "boolean") {
    const picked = relocationOption(value, options, context.nearPosting);
    if (!picked) return null;
    return {
      option: picked.option,
      reason: picked.local ? "Your saved current location is the posting's location." : "You are willing to relocate at your own expense (your saved answer)."
    };
  }
  if (key === "available_start_date" && typeof value === "string" && context.today) {
    const picked = startBucketOption(options, value, context.today);
    return picked ? { option: picked.option, reason: `Your available start date is ${picked.days} days from today, which falls in "${picked.option}".` } : null;
  }
  if (key === "willing_background_check" && typeof value === "boolean") {
    const option = booleanOption(value, options);
    return option ? { option, reason: "A remembered fact matches one of the offered options." } : null;
  }
  if (key === "graduation_date" && typeof value === "string") {
    const option = graduationTermOption(options, value) ?? graduationRangeOption(options, value, context.degreeLevel ?? null);
    return option ? { option, reason: `Your graduation date falls in "${option}".` } : null;
  }
  return null;
}
