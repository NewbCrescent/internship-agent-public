import { z } from "zod";

/** Monthly and yearly pay compare as hourly pay at 40 hours a week, 52 weeks a year. */
export const WORK_HOURS_PER_YEAR = 2_080;

/** The country filter value for postings that state no country. */
export const NO_STATED_COUNTRY = "none";

/**
 * Country and minimum-pay filters shared by the Jobs list and the Review
 * Queue. Minimum pay is USD per hour against the top of a posting's stated
 * range; a posting without a comparable USD figure never passes it.
 */
export type PostingFilters = { country: string | null; minHourlyPay: number | null };
export type PostingFilterQuery = { country?: unknown; minPay?: unknown };

const countrySchema = z.string().trim().regex(/^(?:[A-Za-z]{2}|none)$/)
  .transform((value) => (value === NO_STATED_COUNTRY ? value : value.toUpperCase()));
const minPaySchema = z.union([
  z.number(), z.string().trim().regex(/^\d{1,4}(?:\.\d{1,2})?$/).transform(Number)
]).pipe(z.number().gt(0).max(1_000));

/** Untrusted URL values; anything invalid means no filter. URL arrays use their first value. */
export function parsePostingFilters(query: PostingFilterQuery): PostingFilters {
  const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const country = countrySchema.safeParse(first(query.country));
  const minPay = minPaySchema.safeParse(first(query.minPay));
  return { country: country.success ? country.data : null, minHourlyPay: minPay.success ? minPay.data : null };
}

/** The URL parameters for the filters that are set, so links can keep them. */
export function postingFilterParams(filters: PostingFilters): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  if (filters.country) params.push(["country", filters.country]);
  if (filters.minHourlyPay !== null) params.push(["minPay", String(filters.minHourlyPay)]);
  return params;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** A country's English name for filter labels, computed once on the server. */
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
