/** Location-text helpers shared by the GitHub list's board resolvers and the posting-page sources. */

/** Parts joined with ", ", each added only when the parts so far do not already name it. */
export function joinPlaceParts(parts: ReadonlyArray<string | null | undefined>): string {
  const kept: string[] = [];
  for (const part of parts) {
    const text = part?.trim();
    if (!text) continue;
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[^\\p{L}])${escaped}(?:$|[^\\p{L}])`, "iu").test(kept.join(", "))) continue;
    kept.push(text);
  }
  return kept.join(", ");
}

/** The English name of an ISO 3166 alpha-2 code, or null. */
export function countryName(code: string | null | undefined): string | null {
  const upper = code?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(upper);
    return name && name !== upper ? name : null;
  } catch {
    return null;
  }
}

/**
 * A structured country value as text: a two-letter ISO code is named in full
 * ("DE" becomes "Germany"), so the place reader never takes it for a US state;
 * a country name is kept as written. Empty or "UNAVAILABLE" gives null.
 */
export function countryText(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text || text.toUpperCase() === "UNAVAILABLE") return null;
  if (/^[A-Za-z]{2}$/.test(text)) return countryName(text) ?? text;
  return text;
}

/** Greenhouse's office line, when its offices say more than the location line. */
export function greenhouseOfficeLine(job: {
  location?: { name: string } | null;
  offices?: ReadonlyArray<{ name?: string | null; location?: string | null }> | null;
}): string | null {
  const offices = [...new Set((job.offices ?? []).map((office) => (office.location ?? office.name ?? "").trim()).filter(Boolean))];
  if (offices.length === 0) return null;
  const joined = offices.join("; ");
  return joined.toLocaleLowerCase("en-US") === (job.location?.name ?? "").trim().toLocaleLowerCase("en-US") ? null : joined;
}

/** The posting text headed by its "Location:" and "Office:" lines, when it has them. */
export function withLocation(location: string | null | undefined, text: string, office: string | null = null): string {
  return (location ? "Location: " + location + "\n" : "") + (office ? "Office: " + office + "\n" : "")
    + (location || office ? "\n" : "") + text.trim();
}

/** A location that is only a work mode ("Hybrid", "Remote") names no place. */
const WORK_MODE_ONLY = /^(?:hybrid|remote|on-?site|in[- ]office|in person|flexible)$/i;

type PostalAddress = {
  postalAddress?: { addressLocality?: string | null; addressRegion?: string | null; addressCountry?: string | null } | null;
} | null | undefined;

/**
 * Ashby's location string with its structured address: "Berlin" becomes
 * "Berlin, Germany", and a work-mode location ("Hybrid") gives way to the
 * office address ("Johnston, Iowa, United States"). Secondary locations
 * follow, "; "-separated.
 */
export function ashbyLocation(job: {
  location?: string | null;
  address?: PostalAddress;
  secondaryLocations?: ReadonlyArray<{ location?: string | null; address?: PostalAddress }> | null;
}): string | undefined {
  const group = (location: string | null | undefined, address: PostalAddress) => {
    const postal = address?.postalAddress;
    return joinPlaceParts([
      location && !WORK_MODE_ONLY.test(location.trim()) ? location : null,
      postal?.addressLocality, postal?.addressRegion, postal?.addressCountry
    ]);
  };
  const groups = [group(job.location, job.address), ...(job.secondaryLocations ?? []).map((entry) => group(entry.location, entry.address))]
    .filter(Boolean);
  return groups.length ? [...new Set(groups)].join("; ") : job.location ?? undefined;
}

/**
 * Lever's locations ("allLocations", else the category location), with the
 * posting's country named when there is one location: "Seoul" with country
 * KR becomes "Seoul, South Korea".
 */
export function leverLocation(job: {
  country?: string | null;
  categories?: { location?: string | null; allLocations?: ReadonlyArray<string> | null } | null;
}): string | undefined {
  const all = (job.categories?.allLocations ?? []).map((entry) => entry.trim()).filter(Boolean);
  const base = all.length ? all.join("; ") : job.categories?.location?.trim() ?? "";
  const country = countryName(job.country);
  if (country && all.length <= 1) return joinPlaceParts([base, country]) || undefined;
  return base || undefined;
}
