import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { listDiscoverySources, saveImportedBoardSources } from "@internship-agent/db";

import { canonicalBoardUrl, publicBoardKey } from "./board-polling";
import { parsePublicBoardUrl, type PublicBoard } from "./public-board-source";

/**
 * Imports a reviewed list of public Greenhouse, Lever, and Ashby boards (a
 * scout run's output) as discovery sources (Track 52). Rows are validated,
 * deduped by board kind and slug against every existing source and earlier
 * rows, and capped per import; the normal posting-level target rules then
 * decide each posting the boards list.
 */

/** New boards one import may add. */
export const MAX_BOARD_IMPORT = 300;
/** Rows one import file may hold. */
export const MAX_BOARD_IMPORT_ROWS = 5_000;

function httpsWithoutCredentials(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const boardRowSchema = z.preprocess(
  // Track 51's scouts name the provenance link `source_url`.
  (value) => value && typeof value === "object" && !Array.isArray(value) && !("evidence_url" in value) &&
    "source_url" in value && typeof value.source_url === "string"
    ? { ...value, evidence_url: value.source_url }
    : value,
  z.object({
    company: z.string().trim().min(1).max(160),
    board_url: z.string().trim().min(1).max(2_000),
    ats: z.enum(["greenhouse", "lever", "ashby"]),
    evidence_url: z.string().trim().max(2_000).refine(httpsWithoutCredentials, "evidence_url must be a public https link"),
    has_intern_posting: z.boolean()
  })
);

type BoardEntry = { row: number; company: string; url: string };
export type BoardImportReport = {
  dryRun: boolean;
  added: BoardEntry[];
  alreadyPresent: Array<BoardEntry & { reason: "already a discovery source" | "listed earlier in this file" }>;
  invalid: Array<{ row: number; reason: string }>;
  overCap: BoardEntry[];
};

/** Validates, dedupes, and caps the rows; unless `dryRun`, saves the added boards in one transaction. */
export function importBoardSources(
  database: DatabaseSync,
  rows: readonly unknown[],
  options: { dryRun: boolean; importedFrom: string; now?: Date }
): BoardImportReport {
  if (rows.length > MAX_BOARD_IMPORT_ROWS) {
    throw new Error(`The file holds ${rows.length} rows; one import reads at most ${MAX_BOARD_IMPORT_ROWS}.`);
  }
  const report: BoardImportReport = { dryRun: options.dryRun, added: [], alreadyPresent: [], invalid: [], overCap: [] };
  const valid: Array<{ row: number; company: string; board: PublicBoard; evidenceUrl: string; hasInternPosting: boolean }> = [];
  rows.forEach((raw, index) => {
    const row = index + 1;
    const parsed = boardRowSchema.safeParse(raw);
    if (!parsed.success) {
      const reason = parsed.error.issues.map((issue) => (issue.path.join(".") || "row") + ": " + issue.message).join("; ");
      report.invalid.push({ row, reason: reason.slice(0, 300) });
      return;
    }
    let board: PublicBoard;
    try {
      board = parsePublicBoardUrl(parsed.data.board_url);
    } catch (error) {
      report.invalid.push({ row, reason: ("board_url: " + (error instanceof Error ? error.message : String(error))).slice(0, 300) });
      return;
    }
    if (parsed.data.ats !== board.kind) {
      report.invalid.push({ row, reason: `ats is "${parsed.data.ats}" but board_url is a ${board.kind} board` });
      return;
    }
    valid.push({ row, company: parsed.data.company, board, evidenceUrl: parsed.data.evidence_url, hasInternPosting: parsed.data.has_intern_posting });
  });

  const existing = new Set(listDiscoverySources(database).flatMap((source) => publicBoardKey(source.url) ?? []));
  const inFile = new Set<string>();
  // Boards that list an internship now go first, so the cap keeps them.
  const ordered = valid.slice().sort((a, b) => Number(b.hasInternPosting) - Number(a.hasInternPosting) || a.row - b.row);
  const evidence = new Map<number, string>();
  for (const entry of ordered) {
    const key = `${entry.board.kind}:${entry.board.slug.toLowerCase()}`;
    const item = { row: entry.row, company: entry.company, url: canonicalBoardUrl(entry.board) };
    if (existing.has(key)) report.alreadyPresent.push({ ...item, reason: "already a discovery source" });
    else if (inFile.has(key)) report.alreadyPresent.push({ ...item, reason: "listed earlier in this file" });
    else if (report.added.length >= MAX_BOARD_IMPORT) report.overCap.push(item);
    else {
      report.added.push(item);
      evidence.set(entry.row, entry.evidenceUrl);
    }
    inFile.add(key);
  }

  if (!options.dryRun && report.added.length) {
    const importedAt = (options.now ?? new Date()).toISOString();
    saveImportedBoardSources(database, report.added.map((item) => ({
      label: item.company, url: item.url, importedFrom: options.importedFrom, importedAt, evidenceUrl: evidence.get(item.row)!
    })));
  }
  return report;
}

/** Printable lines for an import, ending with one machine-readable `BOARD_IMPORT_REPORT` line of counts. */
export function formatBoardImportReport(report: BoardImportReport, context: { profile: string; file: string }): string[] {
  const lines = [`Board import for the ${context.profile} workspace from ${context.file}` +
    (report.dryRun ? " (dry run: nothing was written)." : ".")];
  lines.push(`${report.dryRun ? "Would add" : "Added"} ${report.added.length}, already present ${report.alreadyPresent.length}, ` +
    `invalid ${report.invalid.length}, over the ${MAX_BOARD_IMPORT}-board cap ${report.overCap.length}.`);
  for (const item of report.added) lines.push(`  ${report.dryRun ? "would add" : "added"}: ${item.company} ${item.url}`);
  if (report.invalid.length) {
    lines.push("Invalid rows:");
    for (const item of report.invalid) lines.push(`  row ${item.row}: ${item.reason}`);
  }
  if (report.overCap.length) {
    lines.push(`Over the ${MAX_BOARD_IMPORT}-board cap, not imported:`);
    for (const item of report.overCap) lines.push(`  row ${item.row}: ${item.company} ${item.url}`);
  }
  lines.push("BOARD_IMPORT_REPORT " + JSON.stringify({
    profile: context.profile, dryRun: report.dryRun, added: report.added.length,
    alreadyPresent: report.alreadyPresent.length, invalid: report.invalid.length, overCap: report.overCap.length
  }));
  return lines;
}
