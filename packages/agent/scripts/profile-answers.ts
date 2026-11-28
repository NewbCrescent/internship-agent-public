/**
 * Lists the saved question-memory answers (generic questions outside the fact
 * catalog), revokes one or a recorded wording, or promotes one to its canonical
 * fact key (Track 79: sat_score, act_score; `--dry-run` writes nothing).
 *
 * Usage: pnpm profile:answers [--profile real|demo] [--revoke <id or 8-character prefix> | --revoke-alias <id or 8-character prefix> | --promote <id or 8-character prefix> --key <fact key> [--dry-run]]
 */
import { runProfileAnswersCommand } from "../src/run-answer";

process.exitCode = await runProfileAnswersCommand(process.argv.slice(2));
