/**
 * Exact company identity shared by the company fact scope and the automatic
 * pipeline's per-company limits. Never fuzzy: two names are the same company
 * only when they normalize to the same words.
 */

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "gmbh", "ag", "sa", "llp", "lp", "pbc"
]);

/** Lower-case ASCII words: accents removed, punctuation and symbols dropped. */
function nameWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** A company name without case, accents, punctuation, a leading "the", or trailing legal suffixes. Exact identity, never fuzzy; idempotent. */
export function normalizeCompanyName(name: string): string {
  const words = nameWords(name);
  if (words.length > 1 && words[0] === "the") words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

/** True when the text names this company as whole words ("vandelay" in "worked for Vandelay?"), never a partial word. */
export function mentionsCompany(text: string, companyName: string): boolean {
  const company = normalizeCompanyName(companyName);
  return company.length > 0 && ` ${nameWords(text).join(" ")} `.includes(` ${company} `);
}

/**
 * True when consecutive whole words of the text, joined without spaces, spell
 * the site's tenant name ("Highmark Health" for highmarkhealth, "Micron" for
 * micron); tenants shorter than 3 letters never match. Exact, never fuzzy.
 */
export function mentionsSiteTenant(text: string, tenant: string): boolean {
  const target = tenant.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  if (target.length < 3) return false;
  const words = nameWords(text);
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let index = start; index < words.length && joined.length < target.length; index += 1) {
      joined += words[index]!;
      if (joined === target) return true;
    }
  }
  return false;
}
