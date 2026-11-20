/**
 * Reads one comma- or hyphen-separated piece of a location line as a known
 * place. Country names come from the runtime's own ISO 3166 region names, so
 * no country list is maintained here; the aliases cover spellings postings use
 * that those names do not. A bare city is unreadable to `readPlace`:
 * "London" never becomes a country on its own there; `readWellKnownCity`
 * reads a short table of unambiguous well-known cities, and only where no
 * country, state, or province is stated.
 */
export type PlaceReading =
  | { kind: "country"; code: string }
  | { kind: "us-state"; code: string }
  | { kind: "ca-province"; code: string };

const US_STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
  "washington dc": "DC", "washington d.c": "DC"
};

export const US_STATE_CODES = new Set(Object.values(US_STATE_NAMES));

const CA_PROVINCE_NAMES: Record<string, string> = {
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", newfoundland: "NL", "nova scotia": "NS",
  "northwest territories": "NT", nunavut: "NU", ontario: "ON", "prince edward island": "PE",
  quebec: "QC", québec: "QC", saskatchewan: "SK", yukon: "YT"
};

const CA_PROVINCE_CODES = new Set(Object.values(CA_PROVINCE_NAMES));

const COUNTRY_ALIASES: Record<string, string> = {
  us: "US", usa: "US", "u.s": "US", "u.s.a": "US", "united states of america": "US",
  uk: "GB", "u.k": "GB", britain: "GB", "great britain": "GB", england: "GB", scotland: "GB",
  wales: "GB", "northern ireland": "GB", korea: "KR", "republic of korea": "KR",
  "czech republic": "CZ", holland: "NL", uae: "AE", "hong kong": "HK", macau: "MO", macao: "MO",
  turkey: "TR", "mainland china": "CN", "republic of ireland": "IE", "ivory coast": "CI",
  "viet nam": "VN", burma: "MM"
};

// Region codes that name groupings or test data rather than countries.
const NOT_COUNTRIES = new Set(["EU", "EZ", "QO", "UN", "XA", "XB", "ZZ"]);

const COUNTRY_CODES = buildCountryCodes();

function buildCountryCodes(): Map<string, string> {
  const names = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  const codes = new Map<string, string>();
  for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
      const code = String.fromCharCode(first, second);
      if (NOT_COUNTRIES.has(code)) continue;
      const name = names.of(code);
      // Deprecated codes such as SU still have names; only current codes count.
      if (!name || name === code || Intl.getCanonicalLocales(`und-${code}`)[0] !== `und-${code}`) continue;
      codes.set(key(name), code);
      const bare = name.replace(/\s*\(.*\)$/, "");
      if (bare !== name) codes.set(key(bare), code);
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) codes.set(alias, code);
  return codes;
}

function key(text: string): string {
  return text.toLocaleLowerCase("en-US").replace(/\s+/g, " ").replace(/^the /, "").replace(/\.$/, "").trim();
}

/**
 * A full state name reads as a US state before a country, so "Atlanta,
 * Georgia" stays in the US. Two-letter codes are read only where they are
 * unambiguous: Canadian provinces and US states; "CA" is California, as the
 * City, ST form already assumes.
 */
export function readPlace(segment: string): PlaceReading | null {
  const text = segment.trim();
  if (/^[A-Z]{2}$/.test(text)) {
    if (CA_PROVINCE_CODES.has(text)) return { kind: "ca-province", code: text };
    if (US_STATE_CODES.has(text)) return { kind: "us-state", code: text };
  }
  const normalized = key(text);
  if (US_STATE_NAMES[normalized]) return { kind: "us-state", code: US_STATE_NAMES[normalized] };
  if (CA_PROVINCE_NAMES[normalized]) return { kind: "ca-province", code: CA_PROVINCE_NAMES[normalized] };
  const country = COUNTRY_CODES.get(normalized);
  return country ? { kind: "country", code: country } : null;
}

/**
 * Well-known cities with no common namesake in another country, by ISO
 * 3166 alpha-2 code. "City, ST" and an explicit country always win over this
 * table (the extractor consults it only when a location names neither), and
 * it is read only on labelled location lines and place lines, never in prose.
 * Ambiguous names (Cambridge, Waterloo, Johnston, Durham, Vancouver, …) are
 * left out on purpose.
 */
const WELL_KNOWN_CITIES: Record<string, string> = {
  // United States
  "new york": "US", "new york city": "US", nyc: "US", manhattan: "US", brooklyn: "US",
  "san francisco": "US", "south san francisco": "US", sf: "US", "bay area": "US", "san francisco bay area": "US",
  "silicon valley": "US", seattle: "US", bellevue: "US", redmond: "US", austin: "US", boston: "US", chicago: "US",
  "los angeles": "US", "san jose": "US", "palo alto": "US", "mountain view": "US", "menlo park": "US", sunnyvale: "US",
  "redwood city": "US", "san mateo": "US", cupertino: "US", "santa clara": "US", berkeley: "US", oakland: "US",
  "san diego": "US", irvine: "US", denver: "US", boulder: "US", atlanta: "US", miami: "US", dallas: "US", houston: "US",
  pittsburgh: "US", philadelphia: "US", "ann arbor": "US", minneapolis: "US", "salt lake city": "US", phoenix: "US",
  nashville: "US", raleigh: "US", "kansas city": "US", "st. louis": "US", "st louis": "US", "saint louis": "US",
  "des moines": "US", columbus: "US", indianapolis: "US", baltimore: "US", charlotte: "US", portland: "US",
  // Elsewhere
  london: "GB", paris: "FR", berlin: "DE", munich: "DE", münchen: "DE", hamburg: "DE", frankfurt: "DE",
  milan: "IT", milano: "IT", rome: "IT", madrid: "ES", barcelona: "ES", lisbon: "PT", amsterdam: "NL", dublin: "IE",
  zurich: "CH", zürich: "CH", geneva: "CH", vienna: "AT", stockholm: "SE", copenhagen: "DK", oslo: "NO", helsinki: "FI",
  warsaw: "PL", prague: "CZ", brussels: "BE", toronto: "CA", montreal: "CA", ottawa: "CA",
  tokyo: "JP", seoul: "KR", singapore: "SG", shanghai: "CN", beijing: "CN", shenzhen: "CN", bangalore: "IN",
  bengaluru: "IN", hyderabad: "IN", mumbai: "IN", pune: "IN", sydney: "AU", melbourne: "AU", "tel aviv": "IL",
  dubai: "AE", "mexico city": "MX", "sao paulo": "BR", "são paulo": "BR"
};

/** Words around a city that do not change where it is: "Berlin (Hybrid)", "Greater Seattle Area", "NYC HQ". */
const CITY_NOISE = /\b(?:hybrid|remote|on-?site|office|hq|area|metro|greater)\b/gi;

/** One location piece read through the well-known city table, or null. */
export function readWellKnownCity(segment: string): { code: string } | null {
  const bare = key(segment.replace(/\([^)]*\)/g, " "));
  const direct = WELL_KNOWN_CITIES[bare];
  if (direct) return { code: direct };
  const cleaned = key(bare.replace(CITY_NOISE, " "));
  const code = cleaned ? WELL_KNOWN_CITIES[cleaned] : undefined;
  return code ? { code } : null;
}
