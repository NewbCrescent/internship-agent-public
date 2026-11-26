import type { DiscoverySource } from "@internship-agent/domain";

import { parsePublicBoardUrl, type PublicBoard } from "./public-board-source";

/**
 * Pure rules for polling public boards in a pass (Track 52): each board at
 * most once per interval, oldest first, a bounded number per pass, and a
 * failing or missing board backed off instead of retried every pass. The
 * per-board state (last fetch, failures, retry time) lives in the local
 * SQLite discovery_sources row.
 */

/** The shortest time between two pass checks of one board. */
export const BOARD_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The longest back-off, and the back-off for a board that answered 404 or 410. */
export const BOARD_MAX_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
/** Board fetches in flight at once in a pass. */
export const BOARD_CHECK_CONCURRENCY = 4;
/** Boards checked in one pass; the rest wait for a later pass, oldest first. */
export const BOARD_CHECKS_PER_PASS = 100;

/** `kind:slug` (slug lowercased) for a public board URL, or null for anything else. */
export function publicBoardKey(url: string | null): string | null {
  if (url === null) return null;
  try {
    const board = parsePublicBoardUrl(url);
    return `${board.kind}:${board.slug.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function isPublicBoardSource(source: { url: string | null }): boolean {
  return publicBoardKey(source.url) !== null;
}

/** The board's root URL on its main host; the slug's case is kept. */
export function canonicalBoardUrl(board: PublicBoard): string {
  if (board.kind === "greenhouse") return `https://boards.greenhouse.io/${board.slug}`;
  if (board.kind === "lever") return `https://jobs.lever.co/${board.slug}`;
  return `https://jobs.ashbyhq.com/${board.slug}`;
}

/**
 * When a board that has now failed `failureCount` times in a row (at least 1)
 * may be checked again: 12 h doubling up to 7 days, or 7 days at once when it
 * answered 404 or 410.
 */
export function boardRetryAfter(failureCount: number, status: number | null, at: Date): string {
  const delay = status === 404 || status === 410
    ? BOARD_MAX_BACKOFF_MS
    : Math.min(BOARD_MIN_INTERVAL_MS * 2 ** failureCount, BOARD_MAX_BACKOFF_MS);
  return new Date(at.getTime() + delay).toISOString();
}

/** Splits boards into those this pass checks, those left for a later pass, and those not due or backed off. */
export function planBoardChecks(
  boards: readonly DiscoverySource[],
  now = new Date(),
  limit = BOARD_CHECKS_PER_PASS
): { due: DiscoverySource[]; deferred: DiscoverySource[]; notDue: DiscoverySource[]; backedOff: DiscoverySource[] } {
  const backedOff: DiscoverySource[] = [];
  const notDue: DiscoverySource[] = [];
  const candidates: DiscoverySource[] = [];
  for (const board of boards) {
    if (board.retryAfter && Date.parse(board.retryAfter) > now.getTime()) backedOff.push(board);
    else if (board.lastFetchedAt && now.getTime() - Date.parse(board.lastFetchedAt) < BOARD_MIN_INTERVAL_MS) notDue.push(board);
    else candidates.push(board);
  }
  const compare = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
  candidates.sort((a, b) => compare(a.lastFetchedAt, b.lastFetchedAt) || compare(a.createdAt, b.createdAt));
  return { due: candidates.slice(0, limit), deferred: candidates.slice(limit), notDue, backedOff };
}
