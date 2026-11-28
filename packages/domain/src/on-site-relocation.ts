import { withoutCoveredTerm, type AvailabilityWindow } from "./term-availability";

const key = (text: string) => text.normalize("NFKC").toLocaleLowerCase("en-US")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[‐-―−–—]/g, "-")
  .replace(/\s+/g, " ").trim();

const RELOCATING = /\b(?:will|would|can|plan to|am (?:able|willing|available|open) to|i'?ll)\b[^.;]{0,40}\brelocat\w*|\b(?:relocate|move) to\b|\bwork in \/ relocate to\b/;
const CLAIMS_LOCAL = /\b(?:currently|already) (?:live|living|reside|residing|located|based)\b|\b(?:live|reside) (?:in|near|within)\b(?![^.;]{0,20}\brelocat)/;
const NEEDS_MORE = /\b(?:assist\w*|support\w*|reimburs\w*|stipends?|housing|packages?|if (?:i am |i'm )?offered|remote\w*|part[- ]?time|but|however|unless|until|except|temporar\w*|not)\b/;
const LEFTOVER_DATE = /\b(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b|\bmay\s+\d|\b20\d\d\b/;

/**
 * (Track 89) For a saved on-site Yes on a U.S. posting with a saved U.S.-wide relocation Yes: the one "Yes, I will
 * relocate …" option of an on-site question ("Yes, I currently live in <city>" / "Yes, I will relocate to <city> for
 * the internship" / "No …"). Never an option that claims living there, asks for relocation help, names remote work,
 * or is qualified; a covered summer term in the option is read away first. Null when none or several.
 */
export function onSiteRelocationOption(options: readonly string[], window: AvailabilityWindow | undefined): string | null {
  const hits = options.filter((option) => {
    const k = key(withoutCoveredTerm(option, window));
    return /^yes\b/.test(k) && RELOCATING.test(k) && !CLAIMS_LOCAL.test(k) && !NEEDS_MORE.test(k) && !LEFTOVER_DATE.test(k);
  });
  return hits.length === 1 ? hits[0]! : null;
}
