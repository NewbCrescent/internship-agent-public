import type { DatabaseSync } from "node:sqlite";

import { getJobMatch, getJobPosting } from "@internship-agent/db";
import { reviewPursuit } from "@internship-agent/matching";

/** Logged on the PREPARING transition of a needs-review posting pursued on its AI fit. */
export const PURSUED_ON_FIT_PREFIX = "Pursued on AI fit ";

/** A needs-review posting the pipeline pursued on its AI fit (candidate approval, 2026-11-24). */
export type PursuedOnFit = { score: number; unverified: string[] };

export function pursuedOnFitDetail(pursuit: PursuedOnFit): string {
  return `${PURSUED_ON_FIT_PREFIX}${pursuit.score} despite unverified requirements: ${pursuit.unverified.join("; ")}`.slice(0, 1_000);
}

/** The unverified requirements of a needs-review posting the pipeline may pursue on its AI fit; empty otherwise. */
export function unverifiedRequirements(database: DatabaseSync, jobId: string): string[] {
  const match = getJobMatch(database, jobId);
  const posting = getJobPosting(database, jobId);
  if (!match || !posting || match.verdict !== "NEEDS_REVIEW") return [];
  const pursuit = reviewPursuit(match, posting);
  return pursuit.pursue ? pursuit.unverified : [];
}
