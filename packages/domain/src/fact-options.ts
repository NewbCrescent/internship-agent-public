import { booleanOption } from "./standard-answers";

/**
 * Deterministic rules by which a saved fact picks one offered option when no
 * option repeats its value (2026-11-24): the salary rule agrees with a
 * posting's advertised range, own-expense relocation picks its option (or
 * "already located near the city" when the profile's place is the posting's
 * one place), the available start date picks an offer-relative bucket
 * ("2–4 weeks", "6+ weeks") counted from today, and background-check
 * willingness picks Yes or No. Each rule returns null rather than guess, so
 * the field pauses.
 */

/** Keys whose saved value picks an offered option by a rule (planner: factOptionDecision). */
export const FACT_OPTION_KEYS: ReadonlySet<string> = new Set([
  "salary_expectation_rule",
  "willing_to_relocate_at_own_expense",
  "available_start_date",
  "willing_background_check"
]);

export type FactOptionContext = { today?: string; nearPosting: boolean };

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

/** The days from an offer an option allows ("2-4 weeks" is 14 to 28; "6+ weeks" is 42 or more); null when it names none. */
export function startWindowDays(option: string): { min: number; max: number } | null {
  const key = optionKey(option);
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
  return null;
}
