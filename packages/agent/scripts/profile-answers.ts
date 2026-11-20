/**
 * Lists the saved question-memory answers (generic questions outside the fact
 * catalog) and revokes one.
 *
 * Usage: pnpm profile:answers [--profile real|demo] [--revoke <id or 8-character prefix>]
 */
import { runProfileAnswersCommand } from "../src/run-answer";

process.exitCode = await runProfileAnswersCommand(process.argv.slice(2));
