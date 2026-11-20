import { z } from "zod";

import { parsePostingFilters } from "./posting-filters";
import { reviewViewSchema } from "./review-focus";

export const reviewQueueSortSchema = z.enum(["fit", "newest"]);
export type ReviewQueueSort = z.infer<typeof reviewQueueSortSchema>;
export type ReviewQueueQuery = { sort?: unknown; days?: unknown; page?: unknown; country?: unknown; minPay?: unknown; view?: unknown };
const ageSchema = z.union([
  z.number(), z.string().regex(/^\d{1,3}$/).transform(Number)
]).pipe(z.number().int().min(1).max(365));

/** URL arrays use their first value, just like the Jobs toolbar. */
export function parseReviewQueueOptions(query: ReviewQueueQuery) {
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
  const sort = reviewQueueSortSchema.safeParse(first(query.sort));
  const days = ageSchema.safeParse(first(query.days));
  const view = reviewViewSchema.safeParse(first(query.view));
  return { view: view.success ? view.data : "focus" as const, sort: sort.success ? sort.data : "fit" as const,
    postedWithinDays: days.success ? days.data : null, page: first(query.page), ...parsePostingFilters(query) };
}
