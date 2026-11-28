import type { BrowserField, SelfIdentificationAnswers, SelfIdentificationKey } from "@internship-agent/domain";

/**
 * Voluntary self-identification (US EEO, the OFCCP veteran form, CC-305
 * disability) filled from the candidate's explicitly saved answers. Pure and
 * deterministic, with three gates, each failing safe (null → the field pauses):
 *
 * 1. The field is an EEO-shaped select or radio group that offers a decline
 *    option ("I don't wish to answer"), which is what makes it voluntary. A
 *    gender, race or ethnicity, or Hispanic/Latino list whose label is at most
 *    100 characters needs none (Track 82: Lever's U.S. EEO survey, INL's
 *    "Sex", Workday's "Please indicate if you are Hispanic or Latino"). A
 *    checkbox group counts only when its label says "mark all that apply"
 *    (Greenhouse's lists); free-text EEO fields and other checkbox groups
 *    (Workday's CC-305 checkboxes) are never filled.
 * 2. The label names exactly one category (gender; Hispanic/Latino yes/no;
 *    race or ethnicity; veteran; disability; sexual orientation; transgender
 *    identity, 2026-11-24; LGBTQ+ membership, Track 82) and is not a pronoun,
 *    sex-assigned-at-birth, accommodation or open prompt. The "How would you
 *    describe your …" lead-in of standard EEO lists ("mark all that apply")
 *    is not an open prompt. (Track 82, rounds 2–3) The label must also be an
 *    identity question (isIdentityQuestion): the question it asks, without its
 *    list hints, is in full one of the anchored IDENTITY_SHAPES (a bare
 *    category such as "Gender" or "Veteran Status", "What is your …", "Are you
 *    <a member of the category>", "Do you have a disability?", and a few
 *    standard EEO wordings). Any other wording (a group, an advocate, an
 *    affiliation, customers, skills, a noun after the category, a parenthetical
 *    that is not a list hint) is not, so the field pauses. Round 2's word list
 *    is gone. (Track 90) Oracle's "Veteran Self-Identification Status" is a bare
 *    category, and Greenhouse's long "Do you have a disability or chronic
 *    condition (…) that substantially limits …" question is a shape word for word.
 * 3. Exactly one offered option matches the saved answer; two matches are
 *    ambiguous and none is no answer.
 * 4. The candidate's race-only rule (2026-11-26): on a race-only question (the
 *    label names race or racial and no ethnicity, Hispanic, or Latino wording)
 *    where no offered option matches the saved race or ethnicity answer and the
 *    list offers exactly one decline option, that decline option is chosen.
 *
 * The saved values never leave this module except as the chosen option text.
 */
export type SelfIdentificationCategory = "gender" | "hispanic" | "race" | "veteran" | "disability" | "orientation" | "transgender" | "lgbtq";

const KEY: Record<SelfIdentificationCategory, SelfIdentificationKey> = {
  gender: "eeo_gender",
  hispanic: "eeo_race_ethnicity",
  race: "eeo_race_ethnicity",
  veteran: "eeo_veteran_status",
  disability: "eeo_disability_status",
  orientation: "eeo_sexual_orientation",
  transgender: "eeo_transgender",
  // An LGBTQ+ membership question is settled by the saved orientation and transgender answers together (lgbtqVerdict).
  lgbtq: "eeo_sexual_orientation"
};

// A voluntary self-identification question always lets the candidate decline.
const DECLINE = /\bdecline[sd]?\b|\b(?:do not|don't|does not) (?:wish|want|care) to\b|\bprefer not\b|\bchoose not\b|\brather not\b|\bnot to (?:answer|disclose|say|self[- ]?identify)\b|\bno answer\b|\bundisclosed\b/;
// Questions that mention a category but are not the self-identification itself.
const NOT_SELF_ID = /\b(?:pronouns?|assigned at birth|accommodat\w*|why|describe|explain|tell us)\b/;
// A checkbox group is a self-identification list only when it says so (Greenhouse's "mark all that apply"). No leading
// word boundary: Lever concatenates its hint onto the question ("I identify my ethnicity asSelect all that apply", Track 82).
const ALL_THAT_APPLY = /(?:mark|select|check|choose) all that apply\b/;
// Lists that are voluntary without a decline option (Track 82): Lever's U.S. EEO survey (Hermeus), INL's "Sex", Schonfeld's
// "Please identify your race", Workday's "Please indicate if you are Hispanic or Latino". The answer to these is never
// conditional; veteran, disability, orientation, transgender, and LGBTQ+ lists still need a decline option.
const NO_DECLINE_CATEGORIES: ReadonlySet<SelfIdentificationCategory> = new Set(["gender", "race", "hispanic"]);
// An LGBTQ+ membership question (CarGurus' "LGBTQIA+ identity", Toyota Research's "Lesbian, Gay, Bisexual and/or Transgender ...").
const LGBTQ = /\blgbt\w*|\blesbian,? gay,? (?:and\/or |and |or )?bisexual\b/;
// A race question on its own (2026-11-26): it names race and no ethnicity; Hispanic or Latino is an ethnicity.
const RACE_ONLY = /\b(?:race|racial)\b/;
const ETHNICITY_WORDING = /\b(?:ethnic\w*|hispanic|latin\w*)/;

/**
 * Why an option other than the saved answer's own was chosen: the candidate's race-only rule (2026-11-26), a veteran
 * classification left empty (Track 82), or Oracle's single "I am Hispanic or Latino." box checked or left empty (Track 90).
 */
export type SelfIdentificationRule = "race_only_decline" | "veteran_classification_empty" | "hispanic_checkbox_checked" | "hispanic_checkbox_empty";

/** The decision reason for the race-only rule; it never names the saved answer. */
export const RACE_ONLY_DECLINE_REASON = "Answered a race-only self-identification question with its decline option (the candidate's rule, 2026-11-26).";

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

// A list hint a form puts in parentheses at the end of a label; any other parenthetical stays part of the question.
const HINT_PARENTHETICAL = /\s*\((?:(?:please )?(?:mark|select|check|choose) (?:all|one) that appl(?:y|ies)|optional|voluntary|required|a definition of each group is provided above\.?)\)\s*$/;

/**
 * (Track 82, round 3) The question a label asks, without its list hints: a trailing hint parenthetical
 * (HINT_PARENTHETICAL: "(mark all that apply)", "(A definition of each group is provided above.)", "(optional)"), a
 * trailing "please select all that apply" hint (Lever glues it on: "asSelect all that apply"), and trailing punctuation.
 * Any other parenthetical ("(veteran-owned business)") stays, so the label is not an identity shape.
 */
function identityQuestionText(label: string): string {
  let text = normalize(label);
  for (let i = 0; i < 4; i += 1) {
    const before = text;
    text = text
      .replace(HINT_PARENTHETICAL, "")
      .replace(/[.?!:;,\s]*(?:please )?(?:mark|select|check|choose) all that apply$/, "")
      .replace(/[.?!:;,\s]+$/, "")
      .trim();
    if (text === before) break;
  }
  return text;
}

// A category as an EEO question names it.
const CAT = String.raw`(?:gender(?: identity)?|sex|race|racial (?:background|category|identity)|race(?: or |\/)ethnicity|racial\/ethnic (?:background|identity|category)|ethnicity(?:\(ies\))?|ethnic (?:background|identity|origin)|hispanic(?:\/latino| or latino(?:\/a)?| or latinx)?|latino\/a|(?:protected )?veteran status|veteran self-identification(?: status)?|veteran|disability(?: status)?|sexual orientation|sexuality|transgender(?: identity| status)?|lgbt[a-z]*\+?(?: identity| status)?)`;
// A member of a category, as "are you …", "do you identify as …", "please indicate if you are …" name it.
const MEMBER = String.raw`(?:(?:a |an )?(?:protected )?veteran|transgender|lgbt[a-z]*\+?|hispanic(?:\/latino| or latino(?:\/a)?| or latinx)?|latino|latina|latinx|latine|non-?binary|(?:a )?person with a disability|disabled|of hispanic(?:,| or)? (?:latino|latinx|latine)(?:,? or spanish)? origin|of hispanic(?: or latino)? origin)`;
const IDENTITY_SHAPES: readonly RegExp[] = [
  new RegExp(`^(?:your )?${CAT}$`), // "Gender", "Veteran Status", "LGBTQIA+ identity"
  new RegExp(`^(?:what is|what's) your ${CAT}$`), // "What is your gender?"
  new RegExp(`^(?:please )?(?:select|indicate|identify|choose|specify|enter) your ${CAT}$`), // "Please identify your race", "Please select your Protected Veteran Status."
  new RegExp(`^how (?:would|do) you (?:best )?(?:describe|identify) your ${CAT}$`), // "How would you describe your gender identity?", "How do you identify your sexual orientation?"
  new RegExp(`^what ${CAT} do you identify (?:as|with)$`), // "What gender do you identify as?"
  new RegExp(`^which ${CAT} (?:do you identify (?:as|with)|best describes you)$`), // "Which ethnicity(ies) do you identify with?"
  new RegExp(`^i identify my ${CAT} as$`), // "I identify my ethnicity as" (Lever, Ashby)
  new RegExp(`^(?:are you|do you identify as|do you consider yourself(?: to be)?) ${MEMBER}$`), // "Are you Hispanic/Latino?", "Are you a protected veteran?", "Do you identify as transgender?"
  new RegExp(`^please indicate (?:if|whether) you are ${MEMBER}$`), // "Please indicate if you are Hispanic or Latino"
  /^do you have a disability(?: \(or (?:have )?(?:previously )?had one\))?$/, // "Do you have a disability?"
  // (Track 90) Greenhouse's long disability question (EQT, ParetoHealth, SharkNinja, Veeam), word for word
  /^do you have a disability or chronic condition \(physical, visual, auditory, cognitive, mental, emotional, or other\) that substantially limits one or more of your major life activities, including mobility, communication \(seeing, hearing, speaking\), and learning$/,
  // Workday veteran and ethnicity lists
  new RegExp(`^(?:please )?(?:select|choose) the ${CAT} (?:which|that) (?:most accurately |best )?describes? (?:your status|you|yourself|how you identify(?: yourself)?)$`),
  // Toyota Research
  /^do you consider yourself (?:to be )?(?:a member of|part of) the (?:lesbian, gay, bisexual,? (?:and\/or |and |or )?transgender,? queer,? and questioning \(lgbtq\+?\)|lgbt[a-z]*\+?) community$/
];

/**
 * (Track 82, round 3) Whether a label is an identity question a protected answer may answer: the question it asks
 * (identityQuestionText) is, in full, one of IDENTITY_SHAPES — a bare category, "what is your …", "please select/identify
 * your …", "how would you describe/identify your …", "what/which … do you identify as/with", "I identify my … as",
 * "are you / do you identify as / do you consider yourself <a member of the category>", "please indicate if you are …",
 * "do you have a disability", Workday's "select the … which most accurately describes …", and the LGBTQ community
 * consider-yourself question. Any other wording — a group, advocate, affiliation, customers, skills, a noun after the
 * category, a non-hint parenthetical — is not, so the field pauses. Exported for tests.
 */
export function isIdentityQuestion(label: string): boolean {
  const text = identityQuestionText(label);
  return IDENTITY_SHAPES.some((shape) => shape.test(text));
}

// A combined option ("I am not a protected Veteran / I prefer not to answer") is answered by its first part.
const answerPart = (normalized: string) => normalized.split(" / ")[0]!.trim();

const yes = (option: string) => /^yes\b/.test(option);
const no = (option: string) => /^no\b/.test(option);
const isYesNo = (options: string[]) => options.some(yes) && options.some(no);

type Tier = (option: string) => boolean;

/** The one self-identification category a field asks about, or null when it is not a voluntary EEO select, radio, or "mark all that apply" group. */
export function selfIdentificationCategory(field: BrowserField): SelfIdentificationCategory | null {
  const allThatApply = field.kind === "checkbox" && (field.options?.length ?? 0) >= 2 && ALL_THAT_APPLY.test(normalize(field.label));
  if (field.kind !== "select" && field.kind !== "radio" && !allThatApply) return null;
  const options = (field.options ?? []).map(normalize).filter(Boolean);
  if (options.length < 2) return null;
  const declines = options.some((option) => DECLINE.test(option));
  // "How would you describe your gender identity?" is the standard EEO lead-in, not an open prompt.
  const label = normalize(field.label).replace(/^how (?:would|do) you (?:best )?describe (?:your(?:self)?|you)\b\s*/, "");
  if (NOT_SELF_ID.test(label)) return null;
  if (!isIdentityQuestion(field.label)) return null;
  const answerable = options.filter((option) => !DECLINE.test(option));
  const categories: SelfIdentificationCategory[] = [];
  const lgbtq = LGBTQ.test(label);
  if (lgbtq) categories.push("lgbtq");
  if (/\b(?:gender|sex)\b/.test(label)) categories.push("gender");
  if (/\b(?:race|racial|ethnicity|ethnic|hispanic|latin[oaxe]|latino\/a)\b/.test(label)) {
    categories.push(/\b(?:hispanic|latin)/.test(label) && isYesNo(answerable) ? "hispanic" : "race");
  }
  if (/\bveterans?\b/.test(label)) categories.push("veteran");
  if (/\bdisabilit(?:y|ies)\b|\bdisabled\b/.test(label)) categories.push("disability");
  // An LGBTQ+ label names orientation and transgender identity as part of the one membership question.
  if (!lgbtq && /\bsexual orientation\b|\bsexuality\b/.test(label)) categories.push("orientation");
  if (!lgbtq && /\btransgender\b/.test(label)) categories.push("transgender");
  if (categories.length !== 1) return null;
  const category = categories[0]!;
  if (!declines && !(NO_DECLINE_CATEGORIES.has(category) && label.length <= 100)) return null;
  return category;
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
          return [(o) => /^(?:two or more|2 or more|multiracial|multi-racial|multiple races|bi-?racial|mixed race)\b/.test(o)];
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
          (o) => /^(?:i am |i'm )?a veteran\b/.test(o) && !/\bnot\b/.test(o),
          protectedLabel ? no : yes
        ];
      }
      if (value === "protected_veteran") {
        return [
          (o) => /^i identify as (?:one or more of the classifications of )?(?:a )?protected veteran/.test(o) && !/\bnot\b/.test(o),
          (o) => /^(?:i am |i'm )?a protected veteran$/.test(o),
          (o) => /^(?:i am |i'm )?a veteran\b/.test(o) && !/\bnot\b/.test(o),
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
    case "orientation": {
      const word = ORIENTATION_WORDS[value];
      if (!word) return null;
      return [(o) => o === value || (value === "heterosexual" && o === "straight"), (o) => word.test(o) && !/\bnot\b/.test(o)];
    }
    case "transgender":
      if (value === "transgender") return [yes, (o) => /^(?:i am |i'm |i identify as )?(?:a )?transgender\b/.test(o) && !/\bnot\b/.test(o)];
      if (value === "not_transgender") {
        return [no, (o) => /^(?:i am |i'm )?not transgender\b|^(?:i am |i'm )?cisgender\b|^i (?:do not|don't) identify as (?:a )?transgender\b/.test(o)];
      }
      return null;
    case "lgbtq":
      // Answered from lgbtqVerdict in matchSelfIdentificationOption, never from one saved value.
      return null;
  }
}

const LGBTQ_ORIENTATIONS = new Set(["gay", "lesbian", "bisexual", "pansexual", "queer"]);

/**
 * (Track 82) Whether the saved orientation and transgender answers settle an LGBTQ+ membership question: Yes when either
 * names an LGBTQ+ identity, No only when the orientation is heterosexual and the candidate is not transgender; otherwise
 * (asexual, one answer missing) null.
 */
function lgbtqVerdict(answers: SelfIdentificationAnswers): { member: boolean; key: SelfIdentificationKey } | null {
  const orientation = answers.eeo_sexual_orientation;
  const transgender = answers.eeo_transgender;
  if (orientation && LGBTQ_ORIENTATIONS.has(orientation)) return { member: true, key: "eeo_sexual_orientation" };
  if (transgender === "transgender") return { member: true, key: "eeo_transgender" };
  if (orientation === "heterosexual" && transgender === "not_transgender") return { member: false, key: "eeo_sexual_orientation" };
  return null;
}

function lgbtqTiers(member: boolean): Tier[] {
  return member
    ? [yes, (o) => /^(?:i am |i'm |i identify as |i consider myself )(?:a member of |part of )?(?:the )?(?:lgbt|lesbian,? gay)/.test(o) && !/\bnot\b/.test(o)]
    : [no, (o) => /^(?:i (?:do not|don't) (?:identify as|consider myself)|i am not|i'm not)\b.*\blgbt/.test(o)];
}

const ORIENTATION_WORDS: Record<string, RegExp> = {
  heterosexual: /\b(?:heterosexual|straight)\b/,
  gay: /\bgay\b/,
  lesbian: /\blesbian\b/,
  bisexual: /\bbi-?sexual\b/,
  pansexual: /\bpan-?sexual\b/,
  asexual: /\ba-?sexual\b/,
  queer: /\bqueer\b/
};

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
 * exactly one option matches. On a race-only question with no matching option
 * and exactly one decline option, that option is chosen with
 * `rule: "race_only_decline"` (the candidate's rule, 2026-11-26).
 */
export function matchSelfIdentificationOption(
  field: BrowserField,
  answers: SelfIdentificationAnswers
): { key: SelfIdentificationKey; option: string; rule?: SelfIdentificationRule } | null {
  const category = selfIdentificationCategory(field);
  if (!category) return null;
  let key = KEY[category];
  let tiers: Tier[] | null;
  if (category === "lgbtq") {
    const verdict = lgbtqVerdict(answers);
    if (!verdict) return null;
    key = verdict.key;
    tiers = lgbtqTiers(verdict.member);
  } else {
    const value = answers[key];
    if (!value) return null;
    tiers = tiersFor(category, value, normalize(field.label));
  }
  if (!tiers) return null;
  const candidates = (field.options ?? [])
    .map((option) => ({ option, normalized: answerPart(normalize(option)) }))
    .filter(({ normalized }) => normalized && !DECLINE.test(normalized));
  for (const tier of tiers) {
    const hits = candidates.filter(({ normalized }) => tier(normalized));
    if (hits.length === 1) return { key, option: hits[0]!.option };
    if (hits.length > 1) return null;
  }
  // No offered option matches (one match returned above, several are ambiguous). The candidate's
  // rule (2026-11-26): a race-only list (not a combined race-or-ethnicity or Hispanic/Latino
  // question) takes its one decline option.
  const label = normalize(field.label);
  if (category === "race" && RACE_ONLY.test(label) && !ETHNICITY_WORDING.test(label)) {
    const declines = (field.options ?? []).filter((option) => DECLINE.test(normalize(option)));
    if (declines.length === 1) return { key, option: declines[0]!, rule: "race_only_decline" };
  }
  return null;
}

// (Track 82, round 3) The exact labels of the OFCCP veteran classifications and the newly separated veteran's discharge date.
// (Track 90) INL's and Corvane's Oracle forms say "Active Duty Wartime or Campaign Badge Veterans", plural.
const VETERAN_CLASSIFICATION_LABEL = /^(?:disabled|recently separated|newly separated|armed forces service medal|active duty wartime(?: or campaign badge)?|campaign badge|protected) veterans?$/;
const DISCHARGE_DATE_LABEL = /^(?:newly|recently) separated veteran discharge date(?: (?:month|day|year))?$/;

/** The decision reason for a veteran classification left empty; it never names the saved answer. */
export const VETERAN_CLASSIFICATION_EMPTY_REASON = "Your saved voluntary self-identification answer leaves this veteran classification empty.";

/**
 * (Track 82) An optional single veteran-classification checkbox ("Disabled Veteran", "Recently Separated Veteran") or a
 * newly separated veteran's discharge date (month, day, year) that a saved "not a veteran" or "veteran, not protected"
 * answer leaves empty. The label must be exactly a classification (VETERAN_CLASSIFICATION_LABEL) or a discharge date
 * (DISCHARGE_DATE_LABEL), round 3. A required field, any other label, any other saved value, or no saved answer: false
 * (it pauses).
 */
export function veteranClassificationLeftEmpty(field: BrowserField, answers: SelfIdentificationAnswers): boolean {
  if (field.required) return false;
  const label = identityQuestionText(field.label);
  const value = answers.eeo_veteran_status;
  if (value !== "not_veteran" && value !== "veteran_not_protected") return false;
  if (field.kind === "checkbox" && (field.options?.length ?? 0) < 2) return VETERAN_CLASSIFICATION_LABEL.test(label);
  return DISCHARGE_DATE_LABEL.test(label) && (field.kind === "text" || field.kind === "select" || field.kind === "date");
}

// (Track 90) Oracle's Ethnicity box under its "Diversity Information" heading (INL, Corvane), exactly.
const HISPANIC_CHECKBOX_LABEL = /^i am hispanic or latino$/;

/** The decision reason for Oracle's Hispanic or Latino box, checked or left empty; it never names the saved answer. */
export const HISPANIC_CHECKBOX_REASON = "Your saved voluntary self-identification answer settles this checkbox.";

/**
 * (Track 90) Oracle's single "I am Hispanic or Latino." checkbox: checked for a saved Hispanic or Latino answer, and,
 * when optional, left empty for any other saved race or ethnicity answer (EEO-1 records Hispanic or Latino ahead of race,
 * as the Hispanic yes-no list does). The label must be exactly that sentence; a checkbox group, any other label, no
 * saved answer, or a required box the answer leaves empty: null (it pauses).
 */
export function hispanicCheckboxChoice(field: BrowserField, answers: SelfIdentificationAnswers): "check" | "empty" | null {
  if (field.kind !== "checkbox" || (field.options?.length ?? 0) >= 2) return null;
  if (!HISPANIC_CHECKBOX_LABEL.test(identityQuestionText(field.label))) return null;
  const value = answers.eeo_race_ethnicity;
  if (value === "hispanic_or_latino") return "check";
  if (value && RACE_VALUES.has(value) && !field.required) return "empty";
  return null;
}
