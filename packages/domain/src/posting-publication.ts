import { z } from "zod";

/** An employer's publication date, with the exact public field that supplied it. */
export const postingPublicationSchema = z.object({
  postedAt: z.iso.datetime(),
  sourceUrl: z.url(),
  field: z.enum(["first_published", "publishedAt", "startDate", "releasedDate", "ExternalPostedStartDate", "datePosted", "published"]),
  precision: z.enum(["timestamp", "date"])
});
export type PostingPublication = z.infer<typeof postingPublicationSchema>;

/** Never substitutes an import, update, closing, or aggregator date. */
export function employerPublication(
  value: unknown, sourceUrl: string, field: PostingPublication["field"]
): PostingPublication | null {
  if (typeof value !== "string") return null;
  const dateOnly = z.iso.date().safeParse(value).success;
  if (!dateOnly && !z.iso.datetime({ offset: true }).safeParse(value).success) return null;
  const instant = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(instant.getTime()) || instant.getTime() > Date.now()) return null;
  const result = postingPublicationSchema.safeParse({
    postedAt: instant.toISOString(), sourceUrl, field, precision: dateOnly ? "date" : "timestamp"
  });
  return result.success ? result.data : null;
}
