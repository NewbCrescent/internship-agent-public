/**
 * The 50 US states and DC by USPS code. Used to match a "City, ST" value
 * against suggestions that spell the state out ("Springfield, IL" against
 * "Springfield, Illinois, United States"), and the reverse. It repeats
 * packages/jobs' place-name table on purpose: the browser package does not
 * depend on jobs.
 */
export const US_STATE_NAMES_BY_CODE: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia"
};

const NAME_TO_CODE = new Map(Object.entries(US_STATE_NAMES_BY_CODE).map(([code, name]) => [name.toLowerCase(), code.toLowerCase()]));

/** The other form of a lowercase US state: "ca" -> "california", "california" -> "ca"; null when it is neither. */
export function usStateAlternate(region: string): string | null {
  const text = region.trim().toLowerCase();
  const name = US_STATE_NAMES_BY_CODE[text.toUpperCase()];
  if (name && text.length === 2) return name.toLowerCase();
  return NAME_TO_CODE.get(text) ?? null;
}
