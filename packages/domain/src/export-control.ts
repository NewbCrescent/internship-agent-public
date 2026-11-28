/**
 * Export-control status ("U.S. person" under ITAR/EAR) as categories, so a
 * saved status text can pick the one matching option of a "which describes
 * you" list. Deterministic: an option with no recognized category, or one
 * naming several ("Refugee or asylee"), is never chosen. A list whose options
 * name no category ("I am currently a "U.S. Person"", "I will soon become …")
 * picks the one option saying the candidate is a U.S. person now, for a saved
 * status naming a U.S.-person category (usPersonOption).
 */
export const exportControlCategories = [
  "citizen_or_national",
  "permanent_resident",
  "refugee",
  "asylee",
  "protected_individual",
  "none"
] as const;

export type ExportControlCategory = (typeof exportControlCategories)[number];

const US = /\b(?:us|usa|united states|american)\b/;
const NONE = /\bnone of the (?:above|following)\b|\bnot (?:a |an )?(?:us|united states) (?:person|citizen)\b|\bnon[- ]?us person\b|\bforeign (?:person|national)\b|^none\b|^other\b|\bnon[- ]?(?:us|united states)\s+(?:person|citizen|national)s?\b|\bnot (?:a |an )?(?:us|united states)\b/;
const CITIZEN_OR_NATIONAL = /\bcitizen\b|\bnational\b/;
const NOT_CITIZEN = /\bnon[- ]?(?:(?:us|united states)\s+)?citizen\b|\bnot (?:a |an )?(?:us|united states)\b|\bnot a\b|\bforeign\b/;
const PERMANENT_RESIDENT = /\bpermanent resident\b|\bgreen card\b/;
const REFUGEE = /\brefugee\b/;
const ASYLEE = /\basyl(?:ee|um)\b/;
const PROTECTED_INDIVIDUAL = /\bprotected individual\b|\b1324b\b/;

/** NFKD, lowercase, no "." ("U.S." is "us", "8 U.S.C." is "8 usc"), single spaces. */
function normalize(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("en-US")
    .replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/** Every export-control category a status text or option names. */
export function exportControlCategoriesOf(text: string): Set<ExportControlCategory> {
  const normalized = normalize(text);
  const categories = new Set<ExportControlCategory>();
  if (NONE.test(normalized)) categories.add("none");
  if (CITIZEN_OR_NATIONAL.test(normalized) && US.test(normalized) && !NOT_CITIZEN.test(normalized)) categories.add("citizen_or_national");
  if (PERMANENT_RESIDENT.test(normalized)) categories.add("permanent_resident");
  if (REFUGEE.test(normalized)) categories.add("refugee");
  if (ASYLEE.test(normalized)) categories.add("asylee");
  if (PROTECTED_INDIVIDUAL.test(normalized)) categories.add("protected_individual");
  return categories;
}

/** The one category a text names; null when it names none or several. */
export function exportControlCategory(text: string): ExportControlCategory | null {
  const categories = exportControlCategoriesOf(text);
  return categories.size === 1 ? [...categories][0]! : null;
}

function only(categories: Set<ExportControlCategory>, wanted: ExportControlCategory): boolean {
  return categories.size === 1 && categories.has(wanted);
}

/** The single option naming exactly the saved status's category; null when none or several do. */
export function matchExportControlOption(saved: string, options: readonly string[]): string | null {
  const wanted = exportControlCategory(saved);
  if (!wanted) return null;
  const matches = options.filter((option) => only(exportControlCategoriesOf(option), wanted));
  return matches.length === 1 ? matches[0]! : null;
}

/** The single U.S. citizen option of a citizenship list ("U.S. Citizen"); null when none or several. */
export function usCitizenOption(options: readonly string[]): string | null {
  const matches = options.filter((option) =>
    only(exportControlCategoriesOf(option), "citizen_or_national") && /\bcitizen\b/.test(normalize(option))
  );
  return matches.length === 1 ? matches[0]! : null;
}

// Quotes, apostrophes and parentheses are removed before these run, so "I'm" reads "im".
const US_PERSON_NOW = /^(?:yes,? )?(?:i am|i'?m) (?:currently )?(?:a )?us person$|^(?:yes,? )?(?:currently )?(?:a )?us person$/;
const NOT_NOW = /\bnot\b|\bnon[- ]?us\b|\bwill\b|\bsoon\b|\bbecom\w*|\bfuture\b|\bpending\b|\bprocess\b|\bexpect\w*|\beligib\w*|\blicens\w*|\bexplanation\b/;

/**
 * The one option saying the candidate is a U.S. person now ("I am currently a "U.S. Person""), for a saved status
 * that names a U.S.-person category (citizen or national, permanent resident, refugee, asylee, protected individual).
 * Null for a saved "none" status, or when no option or several say so; "will soon become" and "not … but eligible" never count.
 * An option that names "U.S. person" first and then defines it ("U.S. person. This status includes U.S. citizens, …")
 * counts when its definition names the saved category and no foreign or non-U.S. status (Track 83).
 */
export function usPersonOption(saved: string, options: readonly string[]): string | null {
  const category = exportControlCategory(saved);
  if (!category || category === "none") return null;
  const matches = options.filter((option) => {
    const key = normalize(option).replace(/["'“”‘’()]/g, "").replace(/[,;]$/, "").replace(/\s+/g, " ").trim();
    if (US_PERSON_NOW.test(key) && !NOT_NOW.test(key)) return true;
    return definesUsPerson(key, category);
  });
  return matches.length === 1 ? matches[0]! : null;
}

const US_PERSON_DEFINED = /^(?:yes,? )?(?:i am (?:a )?)?us person\b\s*[.:;,-]?\s*(?:this status |which |status )?(?:includes?|including|means|covers|is defined as)\b(.*)$/;
const DEFINITION_EXCLUDES = /\bforeign\b|\bnon[- ]?us\b|\bnot (?:a |an )?us\b/;

/**
 * (Track 83) Whether a normalized option names "U.S. person" and then defines it with a list naming the saved
 * category. Plural category words ("U.S. citizens", "refugees") are read as singular.
 */
function definesUsPerson(key: string, category: ExportControlCategory): boolean {
  const defined = US_PERSON_DEFINED.exec(key);
  if (!defined) return false;
  const rest = defined[1]!.replace(/\b(citizen|national|resident|refugee|asylee|asylum|individual)s\b/g, "$1");
  if (DEFINITION_EXCLUDES.test(rest)) return false;
  return exportControlCategoriesOf(rest).has(category);
}
