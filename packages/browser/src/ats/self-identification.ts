import type { BrowserField, SelfIdentificationAnswers, SelfIdentificationKey } from "@internship-agent/domain";

/**
 * Voluntary self-identification (US EEO, the OFCCP veteran form, CC-305
 * disability) filled from the candidate's explicitly saved answers. Pure and
 * deterministic, with three gates, each failing safe (null → the field pauses):
 *
 * 1. The field is an EEO-shaped select or radio group that offers a decline
 *    option ("I don't wish to answer"), which is what makes it voluntary.
 *    Free-text EEO fields and checkbox groups (Workday's CC-305 checkboxes)
 *    are never filled.
 * 2. The label names exactly one category (gender; Hispanic/Latino yes/no;
 *    race or ethnicity; veteran; disability) and is not a pronoun,
 *    orientation, transgender, sex-assigned-at-birth, accommodation or open
 *    prompt.
 * 3. Exactly one offered option matches the saved answer; two matches are
 *    ambiguous and none is no answer.
 *
 * The saved values never leave this module except as the chosen option text.
 */
export type SelfIdentificationCategory = "gender" | "hispanic" | "race" | "veteran" | "disability";

const KEY: Record<SelfIdentificationCategory, SelfIdentificationKey> = {
  gender: "eeo_gender",
  hispanic: "eeo_race_ethnicity",
  race: "eeo_race_ethnicity",
  veteran: "eeo_veteran_status",
  disability: "eeo_disability_status"
};

// A voluntary self-identification question always lets the candidate decline.
const DECLINE = /\bdecline[sd]?\b|\b(?:do not|don't|does not) (?:wish|want|care) to\b|\bprefer not\b|\bchoose not\b|\brather not\b|\bnot to (?:answer|disclose|say|self[- ]?identify)\b|\bno answer\b|\bundisclosed\b/;
// Questions that mention a category but are not the self-identification itself.
const NOT_SELF_ID = /\b(?:pronouns?|orientation|lgbt\w*|transgender|assigned at birth|accommodat\w*|why|describe|explain|tell us)\b/;

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‘’`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/\*+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,!?]+$/, "");
}

const yes = (option: string) => /^yes\b/.test(option);
const no = (option: string) => /^no\b/.test(option);
const isYesNo = (options: string[]) => options.some(yes) && options.some(no);

type Tier = (option: string) => boolean;

/** The one self-identification category a field asks about, or null when it is not a voluntary EEO select/radio. */
export function selfIdentificationCategory(field: BrowserField): SelfIdentificationCategory | null {
  if (field.kind !== "select" && field.kind !== "radio") return null;
  const options = (field.options ?? []).map(normalize).filter(Boolean);
  if (options.length < 2 || !options.some((option) => DECLINE.test(option))) return null;
  const label = normalize(field.label);
  if (NOT_SELF_ID.test(label)) return null;
  const answerable = options.filter((option) => !DECLINE.test(option));
  const categories: SelfIdentificationCategory[] = [];
  if (/\b(?:gender|sex)\b/.test(label)) categories.push("gender");
  if (/\b(?:race|racial|ethnicity|ethnic|hispanic|latin[oaxe]|latino\/a)\b/.test(label)) {
    categories.push(/\b(?:hispanic|latin)/.test(label) && isYesNo(answerable) ? "hispanic" : "race");
  }
  if (/\bveterans?\b/.test(label)) categories.push("veteran");
  if (/\bdisabilit(?:y|ies)\b|\bdisabled\b/.test(label)) categories.push("disability");
  return categories.length === 1 ? categories[0]! : null;
}

function tiersFor(category: SelfIdentificationCategory, value: string, label: string): Tier[] | null {
  switch (category) {
    case "gender":
      if (value === "male") return [(o) => ["male", "man", "m"].includes(o)];
      if (value === "female") return [(o) => ["female", "woman", "f"].includes(o)];
      if (value === "non_binary") return [(o) => /^non[- ]?binary\b/.test(o) && !/\bnot\b/.test(o)];
      return null;
    case "hispanic":
      // EEO-1 records Hispanic or Latino ahead of race, so any other saved category answers No.
      if (value === "hispanic_or_latino") return [yes];
      return RACE_VALUES.has(value) ? [no] : null;
    case "race":
      switch (value) {
        case "hispanic_or_latino":
          return [(o) => /\b(?:hispanic|latin[oaxe]|latino\/a)\b/.test(o) && !/\bnot\b|\bnon[- ]?hispanic\b/.test(o)];
        case "white":
          return [(o) => /^white\b/.test(o)];
        case "black_or_african_american":
          return [(o) => /^(?:black|african american)\b/.test(o)];
        case "asian":
          return [(o) => /^asian\b/.test(o)];
        case "american_indian_or_alaska_native":
          return [(o) => /^(?:american indian|alaskan? native|native american)\b/.test(o)];
        case "native_hawaiian_or_pacific_islander":
          return [(o) => /^(?:native hawaiian|pacific islander|hawaiian)\b/.test(o)];
        case "two_or_more_races":
          return [(o) => /^(?:two or more|2 or more|multiracial|multi-racial|multiple races)\b/.test(o)];
        default:
          return null;
      }
    case "veteran": {
      const protectedLabel = /\bprotected veteran\b/.test(label);
      if (value === "not_veteran") {
        return [
          (o) => /^(?:i am |i'm )?not a veteran$/.test(o),
          (o) => /^(?:i am |i'm )?not a protected veteran$/.test(o),
          (o) => /^no,? (?:i am |i'm )?not a (?:protected )?veteran$/.test(o),
          no
        ];
      }
      if (value === "veteran_not_protected") {
        return [
          (o) => /\bveteran\b.*\b(?:just|but) not a protected veteran\b/.test(o),
          (o) => /^(?:i am |i'm )?not a protected veteran$/.test(o),
          protectedLabel ? no : yes
        ];
      }
      if (value === "protected_veteran") {
        return [
          (o) => /^i identify as (?:one or more of the classifications of )?(?:a )?protected veteran/.test(o) && !/\bnot\b/.test(o),
          (o) => /^(?:i am |i'm )?a protected veteran$/.test(o),
          yes
        ];
      }
      return null;
    }
    case "disability":
      if (value === "no_disability") {
        return [
          (o) => /^no,? i (?:do not|don't) have a disability\b/.test(o),
          (o) => /^i (?:do not|don't) have a disability\b/.test(o),
          no
        ];
      }
      if (value === "has_disability") {
        return [
          (o) => /^yes,? i have (?:a disability|had a disability)\b/.test(o),
          (o) => /^i have a disability\b/.test(o),
          yes
        ];
      }
      return null;
  }
}

const RACE_VALUES = new Set([
  "hispanic_or_latino",
  "white",
  "black_or_african_american",
  "asian",
  "american_indian_or_alaska_native",
  "native_hawaiian_or_pacific_islander",
  "two_or_more_races"
]);

/**
 * The offered option that the candidate's saved answer selects, or null when
 * the field is not a voluntary EEO question, no answer is saved, or not
 * exactly one option matches.
 */
export function matchSelfIdentificationOption(
  field: BrowserField,
  answers: SelfIdentificationAnswers
): { key: SelfIdentificationKey; option: string } | null {
  const category = selfIdentificationCategory(field);
  if (!category) return null;
  const key = KEY[category];
  const value = answers[key];
  if (!value) return null;
  const tiers = tiersFor(category, value, normalize(field.label));
  if (!tiers) return null;
  const candidates = (field.options ?? [])
    .map((option) => ({ option, normalized: normalize(option) }))
    .filter(({ normalized }) => normalized && !DECLINE.test(normalized));
  for (const tier of tiers) {
    const hits = candidates.filter(({ normalized }) => tier(normalized));
    if (hits.length === 1) return { key, option: hits[0]!.option };
    if (hits.length > 1) return null;
  }
  return null;
}
