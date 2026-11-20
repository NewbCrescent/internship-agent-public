import { createHash } from "node:crypto";

import { normalizePostingText } from "./text-normalizer";

/**
 * Deterministic discovery helpers: posting identity, promotion ranking, and
 * a token-bucket rate limiter for source fetches.
 */
export function contentDedupeKey(text: string): string {
  // Lowercased on top of the span coordinate system: a repost in ALL CAPS is
  // the same posting, but ingestion spans keep their case-sensitive offsets.
  return createHash("sha256").update(normalizePostingText(text).toLowerCase()).digest("hex");
}

export function repostKey(companyName: string, title: string): string {
  const squash = (value: string) =>
    value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return `${squash(companyName)}|${squash(title)}`;
}

/** Title alone is too broad: one company can open multiple requisitions for the same role. */
export function postingDedupeKey(companyName: string, title: string, text: string): string {
  return `${repostKey(companyName, title)}|${contentDedupeKey(text)}`;
}

export type DedupeReport<T> = {
  unique: T[];
  duplicates: number;
};

export function dedupeItems<T>(items: T[], keys: (item: T) => string[]): DedupeReport<T> {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const item of items) {
    const codes = keys(item);
    if (codes.some((code) => seen.has(code))) {
      duplicates += 1;
      continue;
    }
    for (const code of codes) seen.add(code);
    unique.push(item);
  }
  return { unique, duplicates };
}

export type RankedJob = { jobId: string; verdict: string; fitScore: number };

export function selectPromotion(
  ranked: RankedJob[],
  options: { threshold?: number; limit?: number } = {}
): RankedJob[] {
  const threshold = options.threshold ?? 60;
  const limit = options.limit ?? 5;
  return ranked
    .filter((job) => job.verdict === "QUALIFIED" && job.fitScore >= threshold)
    .sort((a, b) => b.fitScore - a.fitScore || a.jobId.localeCompare(b.jobId))
    .slice(0, Math.max(0, limit));
}
