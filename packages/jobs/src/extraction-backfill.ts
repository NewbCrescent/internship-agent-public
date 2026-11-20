import type { DatabaseSync } from "node:sqlite";

import { getPlaceAndPay, listCurrentPostingTexts, replacePlaceAndPay, type PlaceAndPay } from "@internship-agent/db";

import { extractPlaceAndPay } from "./ingestion-service";

type Coverage = { withCountry: number; withUsdPay: number; countries: Record<string, number> };
type Sample = { jobId: string; companyName: string; title: string; before: string; after: string };

export type ExtractionBackfillReport = {
  applied: boolean;
  /** Only postings the employer published within this many days, or null for every posting. */
  postedWithinDays: number | null;
  scanned: number;
  changed: number;
  /** Postings that state a country or USD pay now but would not after re-reading. */
  lostCountry: number;
  lostPay: number;
  before: Coverage;
  after: Coverage;
  /** Changed postings for a person to check before applying: losses first, then gains. */
  samples: Sample[];
};

/**
 * Re-reads location and pay from every posting's stored snapshot with the
 * current extractor. Nothing is fetched and no model is called. A dry run
 * (the default) only reports; `apply` replaces the changed rows in one
 * transaction and leaves snapshots, requirements, matches, packages, and
 * statuses alone.
 */
export function backfillPlaceAndPay(database: DatabaseSync, options: {
  apply?: boolean; sampleSize?: number; postedWithinDays?: number | null; now?: number;
} = {}): ExtractionBackfillReport {
  const before: Coverage = { withCountry: 0, withUsdPay: 0, countries: {} };
  const after: Coverage = { withCountry: 0, withUsdPay: 0, countries: {} };
  const changes: Array<{ jobId: string; next: PlaceAndPay }> = [];
  const losses: Sample[] = [];
  const gains: Sample[] = [];
  let lostCountry = 0;
  let lostPay = 0;
  const postedWithinDays = options.postedWithinDays ?? null;
  const now = options.now ?? Date.now();
  // The Jobs age filter's rule: an employer date inside the window, both ends
  // included; an unknown date is never in it.
  const postings = listCurrentPostingTexts(database).filter((posting) => {
    if (postedWithinDays === null) return true;
    const published = posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN;
    return Number.isFinite(published) && published >= now - postedWithinDays * 86_400_000 && published <= now;
  });

  for (const posting of postings) {
    const current = getPlaceAndPay(database, posting.jobId);
    const next = extractPlaceAndPay(posting.normalizedText);
    count(before, current);
    count(after, next);
    if (comparable(current) === comparable(next)) continue;
    changes.push({ jobId: posting.jobId, next });
    const lost = (countries(current).length > 0 && countries(next).length === 0) || (hasUsdPay(current) && !hasUsdPay(next));
    if (countries(current).length > 0 && countries(next).length === 0) lostCountry++;
    if (hasUsdPay(current) && !hasUsdPay(next)) lostPay++;
    const sample = { jobId: posting.jobId, companyName: posting.companyName, title: posting.title, before: describe(current), after: describe(next) };
    (lost ? losses : gains).push(sample);
  }

  if (options.apply && changes.length > 0) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const change of changes) replacePlaceAndPay(database, change.jobId, change.next);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  const sampleSize = options.sampleSize ?? 12;
  return {
    applied: Boolean(options.apply),
    postedWithinDays,
    scanned: postings.length,
    changed: changes.length,
    lostCountry,
    lostPay,
    before,
    after,
    samples: [...losses.slice(0, Math.ceil(sampleSize / 2)), ...gains].slice(0, sampleSize)
  };
}

function countries(value: PlaceAndPay): string[] {
  return [...new Set(value.locations.flatMap((location) => (location.countryCode ? [location.countryCode] : [])))];
}

/** Mirrors hourlyUsdPaySql: a USD figure in a period that converts to hourly. */
function hasUsdPay(value: PlaceAndPay): boolean {
  const pay = value.compensation;
  return pay !== null && pay.currency === "USD" && pay.period !== "STIPEND" && (pay.maximum ?? pay.minimum) !== null;
}

function count(coverage: Coverage, value: PlaceAndPay): void {
  const codes = countries(value);
  if (codes.length > 0) coverage.withCountry++;
  for (const code of codes) coverage.countries[code] = (coverage.countries[code] ?? 0) + 1;
  if (hasUsdPay(value)) coverage.withUsdPay++;
}

function comparable(value: PlaceAndPay): string {
  return JSON.stringify({
    locations: value.locations.map(({ raw, city, region, countryCode, workMode, span }) => [raw, city, region, countryCode, workMode, span.start, span.end]),
    compensation: value.compensation && [value.compensation.raw, value.compensation.minimum, value.compensation.maximum,
      value.compensation.currency, value.compensation.period, value.compensation.span.start, value.compensation.span.end]
  });
}

function describe(value: PlaceAndPay): string {
  const places = value.locations.map((location) => `${location.raw}${location.countryCode ? ` [${location.countryCode}]` : ""}`).join("; ") || "no location";
  const pay = value.compensation ? `${value.compensation.raw} [${value.compensation.currency}/${value.compensation.period}]` : "no pay";
  return `${places} · ${pay}`;
}
