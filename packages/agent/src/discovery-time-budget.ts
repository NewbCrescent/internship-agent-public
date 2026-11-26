/**
 * A pass's wall-clock budget for discovery (Track 58). Real pass 24 analyzed
 * and prepared every new posting inline and never reached its application
 * step; the pass now checks this budget before each new posting's analysis
 * and before each public board's fetch, and leaves the rest for the next pass.
 */
export const DISCOVERY_BUDGET_DEFAULT_MS = 15 * 60_000;
export const DISCOVERY_BUDGET_MIN_MS = 60_000;
export const DISCOVERY_BUDGET_MAX_MS = 6 * 60 * 60_000;

/** INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS: whole milliseconds, clamped to 1 minute–6 hours; anything else is the 15-minute default. */
export function discoveryTimeBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.INTERNSHIP_AGENT_DISCOVERY_BUDGET_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DISCOVERY_BUDGET_DEFAULT_MS;
  return Math.min(DISCOVERY_BUDGET_MAX_MS, Math.max(DISCOVERY_BUDGET_MIN_MS, Number.parseInt(raw, 10)));
}

export type DiscoveryTimeBudget = {
  /** Whether the budget is used up. Reads the clock once per call. */
  spent(): boolean;
  deferBoard(): void;
  deferPosting(): void;
  readonly deferredBoards: number;
  readonly deferredPostings: number;
};

/** Starts a budget of `ms`; the clock is read once now and once per `spent()` call, never otherwise. */
export function startDiscoveryTimeBudget(ms: number, clock: () => number = Date.now): DiscoveryTimeBudget {
  const deadline = clock() + ms;
  let boards = 0;
  let postings = 0;
  return {
    spent: () => clock() >= deadline,
    deferBoard: () => { boards += 1; },
    deferPosting: () => { postings += 1; },
    get deferredBoards() { return boards; },
    get deferredPostings() { return postings; }
  };
}

/** The pass's line for what the budget left, or null when it left nothing. */
export function discoveryTimeBudgetLine(budget: Pick<DiscoveryTimeBudget, "deferredBoards" | "deferredPostings">): string | null {
  const boards = budget.deferredBoards;
  const postings = budget.deferredPostings;
  if (boards === 0 && postings === 0) return null;
  return `discovery: ${boards} board${boards === 1 ? "" : "s"} and ${postings} posting${postings === 1 ? "" : "s"} left for the next pass (budget).`;
}
