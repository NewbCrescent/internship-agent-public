import type { DatabaseSync } from "node:sqlite";

import { listDiscoverySources, listPostingsWithoutStatedLocation } from "@internship-agent/db";
import type { DiscoverySource, JobPostingStatus } from "@internship-agent/domain";

import { isPublicBoardSource, publicBoardKey, publicBoardKeyOfPostingUrl } from "./board-polling";
import { checkPublicBoards, PROTECTED_POSTING_STATUSES, type FetchBatch } from "./discovery-orchestrator";
import type { DiscoveryTimeBudget } from "./discovery-time-budget";

/**
 * The board-location backfill (Track 73): board-hosted postings stored before
 * Track 68 carry no `Location:` line and no country, and heal only when their
 * board is read again. This plans which boards to re-read now and re-reads
 * them through the normal board check, so the stated location comes only
 * from the board's own fields. Postings past the approval gate are reported,
 * never revised.
 */

export type StaleLocationPosting = { jobId: string; companyName: string; title: string; status: JobPostingStatus; sourceUrl: string };

export type BoardLocationPlan = {
  boards: Array<{ source: DiscoverySource; key: string; reread: StaleLocationPosting[]; kept: StaleLocationPosting[] }>;
  /** Board-hosted postings whose board is not an enabled discovery source. */
  noBoard: StaleLocationPosting[];
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Board-hosted postings without a stated location, grouped by their enabled board source (Track 73). Reads only. */
export function planBoardLocationBackfill(database: DatabaseSync): BoardLocationPlan {
  const sourcesByKey = new Map<string, DiscoverySource>();
  for (const source of listDiscoverySources(database)) {
    if (!source.enabled || !isPublicBoardSource(source)) continue;
    const key = publicBoardKey(source.url);
    if (key !== null && !sourcesByKey.has(key)) sourcesByKey.set(key, source);
  }
  const groups = new Map<string, BoardLocationPlan["boards"][number]>();
  const noBoard: StaleLocationPosting[] = [];
  for (const posting of listPostingsWithoutStatedLocation(database)) {
    const key = publicBoardKeyOfPostingUrl(posting.sourceUrl);
    if (key === null) continue;
    const source = sourcesByKey.get(key);
    if (!source) { noBoard.push(posting); continue; }
    let group = groups.get(key);
    if (!group) { group = { source, key, reread: [], kept: [] }; groups.set(key, group); }
    (PROTECTED_POSTING_STATUSES.has(posting.status) ? group.kept : group.reread).push(posting);
  }
  const boards = [...groups.values()].sort((a, b) =>
    a.source.label.localeCompare(b.source.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { boards, noBoard };
}

function describe(posting: StaleLocationPosting): string {
  return `${posting.companyName} — ${posting.title} (${posting.status}, job ${posting.jobId.slice(0, 8)})`;
}

/** The plan as report lines, ending with one summary line. */
export function boardLocationBackfillLines(plan: BoardLocationPlan): string[] {
  const lines: string[] = [];
  const keptLines = (kept: StaleLocationPosting[]) => kept.map((posting) =>
    `  kept ${describe(posting)}: past the approval gate, so a board check never revises it; requeue it before re-running this command.`);
  for (const board of plan.boards.filter((entry) => entry.reread.length > 0)) {
    lines.push(`Board ${board.source.label} (${board.key}): re-read for ${board.reread.length} posting(s) without a stated location.`);
    for (const posting of board.reread) lines.push(`  re-read ${describe(posting)}`);
    lines.push(...keptLines(board.kept));
  }
  for (const board of plan.boards.filter((entry) => entry.reread.length === 0)) {
    lines.push(`Board ${board.source.label} (${board.key}): nothing to re-read.`);
    lines.push(...keptLines(board.kept));
  }
  for (const posting of plan.noBoard) lines.push(`No board source: ${describe(posting)}.`);
  const counts = boardLocationBackfillCounts(plan);
  lines.push(`${counts.boards} board(s) to re-read for ${counts.reread} posting(s); ${counts.kept} kept past the approval gate; ` +
    `${counts.noBoard} with no board source.`);
  return lines;
}

export function boardLocationBackfillCounts(plan: BoardLocationPlan): { boards: number; reread: number; kept: number; noBoard: number } {
  return {
    boards: plan.boards.filter((board) => board.reread.length > 0).length,
    reread: plan.boards.reduce((total, board) => total + board.reread.length, 0),
    kept: plan.boards.reduce((total, board) => total + board.kept.length, 0),
    noBoard: plan.noBoard.length
  };
}

/** Re-reads, now, the boards of postings that would gain a stated location: the normal board check with no 6-hour interval and no floor; back-off still applies. */
export async function applyBoardLocationBackfill(database: DatabaseSync, plan: BoardLocationPlan, options: {
  log: (line: string) => void; budget: DiscoveryTimeBudget; traceDirectory?: string; fetcher?: Fetcher; fetchBatch?: FetchBatch;
}): Promise<Awaited<ReturnType<typeof checkPublicBoards>> | null> {
  const sources = plan.boards.filter((board) => board.reread.length > 0).map((board) => board.source);
  if (sources.length === 0) return null;
  return checkPublicBoards(database, sources, {
    log: options.log, budget: options.budget, traceDirectory: options.traceDirectory, fetcher: options.fetcher, fetchBatch: options.fetchBatch,
    limit: sources.length, minChecks: sources.length, minIntervalMs: 0
  });
}
