import { z } from "zod";

import type { TargetTerm } from "./application-target";

/**
 * The candidate's own statement of the internships they want. It is context
 * for the AI fit judgment only: a preference, never an application answer or
 * a candidate fact.
 */
export const APPLICATION_INTENT_MAX_LENGTH = 2000;

export const applicationIntentStatementSchema = z.string()
  .trim()
  .min(1, "The intent statement is empty.")
  .max(APPLICATION_INTENT_MAX_LENGTH, "The intent statement is longer than 2,000 characters.");

export type ApplicationIntent = { statement: string; updatedAt: string };

/** The documented example; the candidate stores their own words with `pnpm fit:intent --set`. */
export const APPLICATION_INTENT_EXAMPLE = "CS student graduating in 2028, looking for a Summer 2027 software engineering or adjacent internship (SWE, ML, data or infra engineering). I'd rather apply to any role I'm a realistic candidate for than only sure bets. Skip roles that need experience or degrees I don't have, or that aren't really engineering.";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const SUMMER_STANDING: Record<number, string> = {
  1: "a rising senior (final year after the internship)",
  2: "a rising junior",
  3: "a rising sophomore"
};

/**
 * Where the candidate stands in school during the internship term, derived
 * only from the expected graduation date (YYYY-MM...). A label for the AI fit
 * prompt, never stored as a candidate fact. Null when the date is unreadable.
 */
export function termStanding(graduationDate: string, term: TargetTerm): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(graduationDate);
  if (!match) return null;
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const monthName = MONTHS[month - 1];
  if (!monthName) return null;
  if (term.season !== "summer") return `Expected graduation ${monthName} ${year}; the internship is in ${term.season} ${term.year}.`;
  const left = year - term.year + (month > 8 ? 1 : 0);
  if (left <= 0) return `Expected to have graduated (${monthName} ${year}) by summer ${term.year}.`;
  const label = SUMMER_STANDING[left] ?? "a first-year student or earlier";
  return `${left} school year${left === 1 ? "" : "s"} left after summer ${term.year} (expected graduation ${monthName} ${year}): ${label} in a four-year bachelor's program.`;
}
