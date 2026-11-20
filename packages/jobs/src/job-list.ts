import type { DatabaseSync } from "node:sqlite";

import { getJobListFingerprint, getJobListStats, listFitScores, listJobSummaries } from "@internship-agent/db";
import { NO_STATED_COUNTRY, parsePostingFilters, ROLE_TYPES, roleTypeForTitle, type RoleType, type PostingPublication } from "@internship-agent/domain";

export const JOB_SORTS = ["fit", "newest"] as const;
export type JobSort = (typeof JOB_SORTS)[number];
export const JOBS_PER_PAGE = 50;

export type JobListOptions = {
  sort: JobSort;
  category: RoleType | null;
  postedWithinDays?: number | null;
  /** A country code, NO_STATED_COUNTRY, or null for every posting. */
  country?: string | null;
  /** Minimum USD per hour; postings without a comparable USD figure never pass. */
  minHourlyPay?: number | null;
};
type Listed = { id: string; title: string; publication?: PostingPublication | null; countryCodes?: string[]; hourlyUsdPay?: number | null };
const DAY_MS = 86_400_000;

/** Validates untrusted query values; anything unknown falls back to fit, all categories, page 1. */
export function parseJobListOptions(query: {
  sort?: string | string[]; category?: string | string[]; page?: string | string[]; days?: string | string[];
  country?: string | string[]; minPay?: string | string[];
}): JobListOptions & { page: number } {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const sort = first(query.sort);
  const category = first(query.category);
  const page = first(query.page);
  const days = first(query.days);
  const filters = parsePostingFilters(query);
  return {
    sort: (JOB_SORTS as readonly string[]).includes(sort ?? "") ? (sort as JobSort) : "fit",
    category: (ROLE_TYPES as readonly string[]).includes(category ?? "") ? (category as RoleType) : null,
    postedWithinDays: days && /^\d{1,3}$/.test(days) && Number(days) >= 1 && Number(days) <= 365 ? Number(days) : null,
    page: page && /^\d{1,6}$/.test(page) ? Math.max(1, Number(page)) : 1,
    country: filters.country,
    minHourlyPay: filters.minHourlyPay
  };
}

/**
 * Filters by title category and sorts. Input arrives newest first; fit sorts
 * high to low, keeps newest first among ties, and lists unanalyzed postings last.
 */
export function arrangePostings<T extends Listed>(
  postings: T[],
  fitOf: (jobId: string) => number | null,
  options: JobListOptions,
  now = Date.now()
): T[] {
  const recent = filterByPostingAge(postings, options.postedWithinDays ?? null, now);
  const categorized = options.category
    ? recent.filter((posting) => roleTypeForTitle(posting.title) === options.category)
    : recent;
  const filtered = filterByPay(filterByCountry(categorized, options.country ?? null), options.minHourlyPay ?? null);
  if (options.sort === "newest") return filtered;
  return filtered
    .map((posting, index) => ({ posting, index, fit: fitOf(posting.id) }))
    .sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || a.index - b.index)
    .map(({ posting }) => posting);
}

/** A rolling age window; an import date never supplies a missing publication date. */
export function filterByPostingAge<T extends Listed>(postings: T[], days: number | null, now = Date.now()): T[] {
  if (days === null) return postings;
  const cutoff = now - days * DAY_MS;
  return postings.filter((posting) => {
    const published = posting.publication ? Date.parse(posting.publication.postedAt) : NaN;
    return Number.isFinite(published) && published >= cutoff && published <= now;
  });
}

/** A posting with places in several countries matches each of them. */
export function filterByCountry<T extends Listed>(postings: T[], country: string | null): T[] {
  if (country === null) return postings;
  return postings.filter((posting) => country === NO_STATED_COUNTRY
    ? (posting.countryCodes ?? []).length === 0
    : (posting.countryCodes ?? []).includes(country));
}

export function filterByPay<T extends Listed>(postings: T[], minHourlyPay: number | null): T[] {
  if (minHourlyPay === null) return postings;
  return postings.filter((posting) => posting.hourlyUsdPay != null && posting.hourlyUsdPay >= minHourlyPay);
}

/** Countries among the postings, most postings first, and how many state none. */
export function countryCounts(postings: Listed[]): { countries: Array<{ code: string; count: number }>; unstated: number } {
  const counts = new Map<string, number>();
  let unstated = 0;
  for (const posting of postings) {
    const codes = posting.countryCodes ?? [];
    if (codes.length === 0) unstated++;
    for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return {
    countries: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    unstated
  };
}

/** Postings per category, in display order, omitting empty categories. */
export function categoryCounts(postings: Listed[]): Array<{ category: RoleType; count: number }> {
  const counts = new Map<RoleType, number>();
  for (const posting of postings) {
    const category = roleTypeForTitle(posting.title);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return ROLE_TYPES.filter((category) => counts.has(category)).map((category) => ({ category, count: counts.get(category)! }));
}

export type JobListPage = {
  /** Job ids on the requested page, in display order. */
  ids: string[];
  page: number;
  pageCount: number;
  /** Postings matching the category filter. */
  filtered: number;
  total: number;
  unknownDates: number;
  categories: Array<{ category: RoleType; count: number }>;
  /** Countries within the age and category filters, and postings there that state none. */
  countries: ReturnType<typeof countryCounts>;
  /** Postings hidden only because they state no country, or no comparable USD pay. */
  unstated: { country: number; pay: number };
  /** Workspace-wide header counts (always fresh; they are cheap). */
  stats: { hardRequirements: number; constrained: number; qualified: number };
  /** True when the order came from the cache rather than a fresh sort. */
  cached: boolean;
};

type Arranged = {
  fingerprint: string; ids: string[]; total: number; unknownDates: number; categories: JobListPage["categories"];
  countries: JobListPage["countries"]; unstated: JobListPage["unstated"]; asOf: number; validUntil: number;
};
const MAX_CACHED_LISTS = 20;
const arrangedLists = new WeakMap<DatabaseSync, Map<string, Arranged>>();

/**
 * One page of the Jobs list. The sorted order is cached per workspace, sort,
 * and category until a posting is added, revised, or analyzed again.
 */
export function getJobListPage(database: DatabaseSync, options: JobListOptions & { page: number }, now = Date.now()): JobListPage {
  const fingerprint = getJobListFingerprint(database);
  const key = `${options.sort}|${options.category ?? ""}|${options.postedWithinDays ?? ""}|${options.country ?? ""}|${options.minHourlyPay ?? ""}`;
  let lists = arrangedLists.get(database);
  if (!lists) arrangedLists.set(database, lists = new Map());
  let arranged = lists.get(key);
  const cached = arranged?.fingerprint === fingerprint && now >= arranged.asOf && now <= arranged.validUntil;
  if (!arranged || !cached) {
    const summaries = listJobSummaries(database);
    const fits = listFitScores(database);
    const recent = filterByPostingAge(summaries, options.postedWithinDays ?? null, now);
    const expirations = options.postedWithinDays ? recent.map((posting) => Date.parse(posting.publication!.postedAt) + options.postedWithinDays! * DAY_MS) : [];
    const categorized = options.category ? recent.filter((posting) => roleTypeForTitle(posting.title) === options.category) : recent;
    const country = options.country ?? null;
    arranged = {
      fingerprint,
      ids: arrangePostings(summaries, (jobId) => fits.get(jobId) ?? null, options, now).map((summary) => summary.id),
      total: summaries.length,
      unknownDates: summaries.filter((posting) => !posting.publication && (!options.category || roleTypeForTitle(posting.title) === options.category)).length,
      categories: categoryCounts(recent),
      countries: countryCounts(categorized),
      unstated: {
        country: country && country !== NO_STATED_COUNTRY ? filterByCountry(categorized, NO_STATED_COUNTRY).length : 0,
        pay: options.minHourlyPay != null ? filterByCountry(categorized, country).filter((posting) => posting.hourlyUsdPay == null).length : 0
      },
      asOf: now,
      validUntil: expirations.length ? Math.min(...expirations) : Number.POSITIVE_INFINITY
    };
    lists.delete(key);
    lists.set(key, arranged);
    while (lists.size > MAX_CACHED_LISTS) lists.delete(lists.keys().next().value!);
  }
  const pageCount = Math.max(1, Math.ceil(arranged.ids.length / JOBS_PER_PAGE));
  const page = Math.min(Math.max(1, options.page), pageCount);
  return {
    ids: arranged.ids.slice((page - 1) * JOBS_PER_PAGE, page * JOBS_PER_PAGE),
    page,
    pageCount,
    filtered: arranged.ids.length,
    total: arranged.total,
    unknownDates: arranged.unknownDates,
    categories: arranged.categories,
    countries: arranged.countries,
    unstated: arranged.unstated,
    stats: getJobListStats(database),
    cached
  };
}
