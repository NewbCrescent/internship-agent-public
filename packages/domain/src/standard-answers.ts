import { z } from "zod";

import type { BrowserFieldKind } from "./browser";
import type { CandidateFactKey } from "./candidate-facts";
import { exportControlCategory, matchExportControlOption, usCitizenOption, usPersonOption } from "./export-control";
import { compensationPeriodSchema } from "./job-posting";

/**
 * The candidate's standard legal and background answers (2026-11-20): the
 * fact keys, the file `pnpm profile:facts --set-file` accepts for them, how a
 * saved Yes/No or status picks an offered option, the non-solicitation end
 * date, and the salary rule (the posting's own stated pay, as an hourly
 * figure). Statements of fact come only from the candidate's saved answers;
 * nothing here infers one.
 */

/** Stored keys, then the six built at resolve time from them. */
export const STANDARD_ANSWER_KEYS: ReadonlySet<CandidateFactKey> = new Set<CandidateFactKey>([
  "us_citizen",
  "us_person_export_controls",
  "security_clearance_eligible",
  "holds_security_clearance",
  "criminal_conviction",
  "government_debarment_or_exclusion",
  "non_compete",
  "non_solicitation",
  "non_solicitation_ends",
  "non_solicitation_explanation",
  "non_compete_or_non_solicitation",
  "non_solicitation_restricts_this_job",
  "conflict_of_interest",
  "relative_government_official",
  "immediate_family_health_care_professional",
  "lives_within_50_miles",
  "salary_expectation_rule",
  "concerns_working_on_dod_projects",
  "us_person",
  "us_citizen_or_national",
  "us_citizen_or_permanent_resident",
  "f1_optional_practical_training",
  "unrestricted_us_work_authorization",
  "salary_expectation"
]);

/** Built from other saved answers at resolve time and never stored as facts. */
export const DERIVED_STANDARD_KEYS: ReadonlySet<CandidateFactKey> = new Set<CandidateFactKey>([
  "us_person",
  "us_citizen_or_national",
  "us_citizen_or_permanent_resident",
  "f1_optional_practical_training",
  "unrestricted_us_work_authorization",
  "salary_expectation"
]);

export function isStandardAnswerKey(key: string): boolean {
  return (STANDARD_ANSWER_KEYS as ReadonlySet<string>).has(key);
}

/** The one place the "lives within 50 miles" answer is saved for. */
export const SAN_FRANCISCO = "San Francisco";

/** A posting's stated pay, as the salary rule reads it (job_compensation). */
export const postingPaySchema = z.object({
  minimum: z.number().nonnegative().nullable(),
  maximum: z.number().nonnegative().nullable(),
  currency: z.string().length(3),
  period: compensationPeriodSchema
});

export type PostingPay = z.infer<typeof postingPaySchema>;

/**
 * The standard answers file. Unknown keys fail (key names only are printed);
 * `salary_expectation` only opts into the coded salary rule, and its contents
 * are never stored or printed.
 */
export const standardAnswersFileSchema = z.object({
  source: z.string().trim().max(500).optional(),
  us_citizen: z.boolean(),
  us_person_export_controls: z.string().trim().min(1).max(200)
    .refine((value) => exportControlCategory(value) !== null, "Not a recognized export-control status"),
  security_clearance_eligible: z.boolean(),
  holds_security_clearance: z.boolean(),
  criminal_conviction: z.boolean(),
  government_debarment_or_exclusion: z.boolean(),
  non_compete: z.boolean(),
  non_solicitation: z.object({
    answer: z.boolean(),
    explanation: z.string().trim().max(2_000),
    ends: z.iso.date(),
    name_former_employer: z.literal(false),
    combined_non_compete_or_non_solicit_question: z.boolean(),
    agreement_restricts_this_job: z.boolean(),
    confirmed: z.string().trim().min(1).max(500)
  }).strict().superRefine((value, context) => {
    if (value.answer && value.explanation.length === 0) {
      context.addIssue({ code: "custom", path: ["explanation"], message: "A Yes needs an explanation." });
    }
  }),
  conflict_of_interest: z.boolean(),
  relative_government_official: z.boolean(),
  immediate_family_health_care_professional: z.boolean(),
  lives_within_50_miles_of_san_francisco: z.boolean(),
  salary_expectation: z.union([z.string().trim().min(1).max(2_000), z.record(z.string(), z.unknown())]),
  preferred_first_name: z.string().trim().min(1).max(80),
  concerns_working_on_dod_projects: z.boolean()
}).strict();

export type StandardAnswersFile = z.infer<typeof standardAnswersFileSchema>;

const optionKey = (option: string) => option.normalize("NFKD").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();

/**
 * The option a saved Yes or No picks: the one option that is exactly "Yes"
 * (or "No"), else the one that starts with the word ("Yes, I am …").
 * "None of the above" and "Not …" are never a No. Null when none or several.
 */
export function booleanOption(value: boolean, options: readonly string[]): string | null {
  const word = value ? "yes" : "no";
  const exact = options.filter((option) => new RegExp(`^${word}[.!]?$`).test(optionKey(option)));
  if (exact.length === 1) return exact[0]!;
  const prefixed = options.filter((option) => new RegExp(`^${word}\\b`).test(optionKey(option)));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/** The option a saved standard answer picks, or null (the field then pauses without echoing the value). */
export function standardAnswerOption(key: string, value: boolean | string, options: readonly string[]): string | null {
  if (!isStandardAnswerKey(key)) return null;
  if (key === "us_person_export_controls" && typeof value === "string") return matchExportControlOption(value, options) ?? usPersonOption(value, options);
  if (typeof value === "boolean") {
    const option = booleanOption(value, options);
    if (option) return option;
    if (key === "us_citizen" && value) return usCitizenOption(options);
  }
  return null;
}

/** Whether a dated agreement still applies on `today`; the end date itself counts (inclusive). */
export function restrictiveCovenantActive(ends: string, today: string): boolean {
  return today <= ends;
}

/** The local calendar date as YYYY-MM-DD. */
export function localCalendarDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

const HOURS_PER_YEAR = 2_080;
const cents = (value: number) => Math.round(value * 100) / 100;

/** A USD hourly, monthly, or yearly pay as an hourly range (40 h/week); null for anything else. */
export function hourlyPayRange(pay: PostingPay): { low: number; high: number } | null {
  if (pay.currency !== "USD") return null;
  const factor = pay.period === "HOUR" ? 1 : pay.period === "YEAR" ? 1 / HOURS_PER_YEAR : pay.period === "MONTH" ? 12 / HOURS_PER_YEAR : null;
  if (factor === null) return null;
  const low = pay.minimum ?? pay.maximum;
  const high = pay.maximum ?? pay.minimum;
  if (low === null || high === null) return null;
  const range = { low: cents(low * factor), high: cents(high * factor) };
  return range.high <= 0 ? null : range;
}

const amount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));

/** "$45/hour" or "$40–$50/hour". */
export function formatHourlyPay(range: { low: number; high: number }): string {
  return range.low === range.high ? `$${amount(range.low)}/hour` : `$${amount(range.low)}–$${amount(range.high)}/hour`;
}

const HOURLY = /\bhour(?:ly)?\b|\bper hour\b|\/\s?h(?:ou)?r\b|\bhr\b/i;
const NOT_HOURLY = /\bannual\w*|\byearly\b|\bper year\b|\bmonthly\b|\bper month\b|\bweekly\b|\bper week\b/i;

/**
 * The salary rule: the posting's stated pay as an hourly figure or range;
 * "Open to discussion" in a text box when the posting states none; a hold
 * when a number is needed and none can be given exactly. Never invents a
 * number. Hold reasons never contain the candidate's values.
 */
export function postingPayAnswer(
  pay: PostingPay | null | undefined,
  input: { fieldKind?: BrowserFieldKind; question: string }
): { kind: "answer"; text: string } | { kind: "hold"; reason: string } {
  const kind = input.fieldKind;
  if (kind !== undefined && kind !== "text" && kind !== "textarea" && kind !== "number") {
    return { kind: "hold", reason: "The salary rule answers only text and number fields." };
  }
  if (!pay) {
    if (kind === "number") return { kind: "hold", reason: "The posting states no pay, and this field needs a number." };
    return { kind: "answer", text: "Open to discussion" };
  }
  const range = hourlyPayRange(pay);
  if (!range) return { kind: "hold", reason: "The posting's pay is not an hourly, monthly, or yearly USD figure." };
  if (kind === "number") {
    if (!HOURLY.test(input.question) || NOT_HOURLY.test(input.question)) {
      return { kind: "hold", reason: "This number field does not ask for an hourly rate." };
    }
    if (range.low !== range.high) return { kind: "hold", reason: "The posting states a pay range, and this field takes one number." };
    return { kind: "answer", text: amount(range.low) };
  }
  return { kind: "answer", text: formatHourlyPay(range) };
}
