import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openApplicationAuditDatabase, resolveProfileDatabasePath, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import {
  buildScoreboard, compareSnapshots, formatScoreboard, pruneScoreboardSnapshots, readPreviousSnapshot,
  SCOREBOARD_DEFAULT_DAYS, SCOREBOARD_MAX_DAYS, scoreboardMatcher, writeScoreboardSnapshot, type Scoreboard, type ValueMatcher
} from "../src/pipeline-scoreboard";
import { claimBlocker, finishBlocker, releaseBlocker } from "../src/scoreboard-claims";

/**
 * pipeline:scoreboard
 *
 * Read-only application funnel (confirmed submissions only) and ranked blocker board for a
 * workspace, with the changes since the last scoreboard snapshot, and blocker claims for fix
 * tracks. It opens the database read-only and never writes it.
 */
const USAGE = "Usage: pnpm pipeline:scoreboard [--profile real|demo] [--days N] [--json] [--no-save]"
  + ` | --claim <id> --track "<track>" | --release <id> --reason "<text>" | --done <id>`;

const VALUE_FLAGS = new Set(["--profile", "--days", "--claim", "--track", "--release", "--reason", "--done"]);
const SWITCHES = new Set(["--json", "--no-save"]);

type Options = {
  profile: "real" | "demo"; days: number; json: boolean; save: boolean;
  claim?: string; track?: string; release?: string; reason?: string; done?: string;
};

function parseArgs(raw: string[]): Options | { error: string } {
  const args = raw[0] === "--" ? raw.slice(1) : raw;
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (SWITCHES.has(flag)) {
      switches.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) return { error: `Unknown argument: ${flag.slice(0, 40)}` };
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value.` };
    if (values.has(flag)) return { error: `${flag} was given twice.` };
    values.set(flag, value);
    index += 1;
  }
  const profile = workspaceProfileSchema.safeParse(values.get("--profile") ?? "real");
  if (!profile.success) return { error: "--profile must be real or demo." };
  const daysText = values.get("--days");
  const days = daysText === undefined ? SCOREBOARD_DEFAULT_DAYS : /^\d+$/.test(daysText) ? Number(daysText) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > SCOREBOARD_MAX_DAYS) return { error: `--days must be a whole number from 1 to ${SCOREBOARD_MAX_DAYS}.` };
  const actions = ["--claim", "--release", "--done"].filter((flag) => values.has(flag));
  if (actions.length > 1) return { error: "Give only one of --claim, --release, or --done." };
  if (values.has("--track") && !values.has("--claim")) return { error: "--track goes with --claim." };
  if (values.has("--reason") && !values.has("--release")) return { error: "--reason goes with --release." };
  if (values.has("--claim") && !values.has("--track")) return { error: "--claim needs --track." };
  if (values.has("--release") && !values.has("--reason")) return { error: "--release needs --reason." };
  return {
    profile: profile.data, days, json: switches.has("--json"), save: !switches.has("--no-save"),
    claim: values.get("--claim"), track: values.get("--track"), release: values.get("--release"),
    reason: values.get("--reason"), done: values.get("--done")
  };
}

export async function runScoreboardCommand(args: string[], io: { log(line: string): void; now?: () => Date }): Promise<number> {
  const options = parseArgs(args);
  if ("error" in options) {
    io.log(options.error);
    io.log(USAGE);
    return 2;
  }
  const now = io.now?.() ?? new Date();
  const dataDir = resolveProfileDataDirectory(options.profile);
  if (options.release !== undefined) {
    const result = releaseBlocker(dataDir, { id: options.release, reason: options.reason ?? "" }, now);
    io.log(result.message);
    return result.ok ? 0 : 1;
  }
  if (options.done !== undefined) {
    const result = finishBlocker(dataDir, { id: options.done }, now);
    io.log(result.message);
    return result.ok ? 0 : 1;
  }
  if (!existsSync(resolveProfileDatabasePath(options.profile))) {
    io.log(`No database for profile ${options.profile}.`);
    return 1;
  }
  const database = openApplicationAuditDatabase(options.profile);
  let board: Scoreboard;
  let matches: ValueMatcher;
  try {
    board = buildScoreboard({ database, dataDir, now, days: options.days });
    matches = scoreboardMatcher(database);
  } finally {
    database.close();
  }
  if (options.claim !== undefined) {
    const blocker = board.blockers.find((candidate) => candidate.id === options.claim);
    if (!blocker) {
      io.log(`No blocker ${options.claim.slice(0, 40)} on the current board.`);
      return 1;
    }
    const result = claimBlocker(dataDir, { id: blocker.id, label: blocker.label, track: options.track ?? "" }, now);
    io.log(result.message);
    return result.ok ? 0 : 1;
  }
  const previous = readPreviousSnapshot(dataDir, now);
  board.changes = previous ? compareSnapshots(previous, board, matches) : null;
  if (options.json) io.log(JSON.stringify(board, null, 2));
  else for (const line of formatScoreboard(board)) io.log(line);
  if (options.save) {
    try {
      writeScoreboardSnapshot(dataDir, board);
      pruneScoreboardSnapshots(dataDir, now);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "write failed";
      io.log(`Could not save the scoreboard snapshot (${code}); the next run will not show changes since this one.`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runScoreboardCommand(process.argv.slice(2), { log: (line) => console.log(line) }).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
