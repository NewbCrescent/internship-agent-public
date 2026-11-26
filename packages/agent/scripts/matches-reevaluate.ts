/**
 * Re-runs the match evaluation for stored matches of postings still in analysis and prints old → new verdicts (Track 56).
 * Dry run by default (read-only database, no lock); --apply takes the pipeline lock. No network, no model.
 * Usage: pnpm matches:reevaluate --profile real|demo [--apply] [--job <id or 8-character prefix>]
 */
import { runMatchReevaluationCommand } from "../src/match-reevaluation";

process.exitCode = runMatchReevaluationCommand(process.argv.slice(2));
