import { z } from "zod";

import { ROLE_TYPES, roleTypeForTitle, type RoleType } from "./role-type";

/** The focus always keeps software engineering; the candidate adds adjacent categories. */
export const FOCUS_REQUIRED_CATEGORY: RoleType = "Software engineering";

/**
 * What the Review Queue's focus view shows. Stored apart from candidate
 * preferences: any preference change bumps the AI-fit context version, and
 * narrowing the review list must not mark every AI score out of date.
 */
export const reviewFocusSchema = z.object({
  categories: z.array(z.enum(ROLE_TYPES)).max(ROLE_TYPES.length)
    .transform((categories) => ROLE_TYPES.filter((category) => category === FOCUS_REQUIRED_CATEGORY || categories.includes(category))),
  countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/).transform((code) => code.toUpperCase())).max(30)
    .transform((codes) => [...new Set(codes)]),
  /** Most postings never name a country; hiding them by default would hide most of the queue. */
  includeUnstatedCountry: z.boolean(),
  postedWithinDays: z.number().int().min(1).max(365),
  /** USD per hour against the top of a stated range; postings that state no pay stay in. */
  minHourlyPay: z.number().gt(0).max(1_000).nullable()
});

export type ReviewFocus = z.infer<typeof reviewFocusSchema>;

export const DEFAULT_REVIEW_FOCUS: ReviewFocus = {
  categories: ["Software engineering", "Data and AI", "Cloud and infrastructure"],
  countries: ["US"],
  includeUnstatedCountry: true,
  postedWithinDays: 14,
  minHourlyPay: null
};

export const reviewViewSchema = z.enum(["focus", "all"]);
export type ReviewView = z.infer<typeof reviewViewSchema>;

export type FocusCandidate = {
  jobId: string;
  title: string;
  countryCodes: string[];
  postedAt: string | null;
  hourlyUsdPay: number | null;
  fitScore: number | null;
};

/**
 * Silence never hides a posting: an unknown date, unstated pay, or (when
 * allowed) no stated country all pass. A stated value outside the focus does.
 */
export function inFocus(entry: FocusCandidate, focus: ReviewFocus, now = Date.now()): boolean {
  if (!focus.categories.includes(roleTypeForTitle(entry.title))) return false;
  if (entry.countryCodes.length === 0 ? !focus.includeUnstatedCountry : !entry.countryCodes.some((code) => focus.countries.includes(code))) return false;
  if (entry.postedAt) {
    const posted = Date.parse(entry.postedAt);
    if (Number.isFinite(posted) && (posted < now - focus.postedWithinDays * 86_400_000 || posted > now)) return false;
  }
  return focus.minHourlyPay === null || entry.hourlyUsdPay === null || entry.hourlyUsdPay >= focus.minHourlyPay;
}

/** AI fit first (unscored last), then higher stated USD pay, then the newer posting, then id for a stable order. */
export function compareFocus(left: FocusCandidate, right: FocusCandidate): number {
  return (right.fitScore ?? -1) - (left.fitScore ?? -1)
    || (right.hourlyUsdPay ?? -1) - (left.hourlyUsdPay ?? -1)
    || (right.postedAt ?? "").localeCompare(left.postedAt ?? "")
    || left.jobId.localeCompare(right.jobId);
}

/** One-click reasons for dropping a posting from review; each is recorded as the skip reason. */
export const QUICK_SKIP_REASONS = {
  role: "Not for me: role",
  location: "Not for me: location",
  pay: "Not for me: pay",
  company: "Not for me: company",
  closed: "Posting closed"
} as const;

export const quickSkipSchema = z.object({
  jobId: z.string().uuid(),
  reason: z.enum(Object.keys(QUICK_SKIP_REASONS) as [keyof typeof QUICK_SKIP_REASONS, ...Array<keyof typeof QUICK_SKIP_REASONS>])
});
