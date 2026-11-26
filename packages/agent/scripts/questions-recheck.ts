/**
 * Re-checks every held run's open questions against the saved answers (saved
 * facts, standard answers, question memory, and recorded wordings). The
 * default dry run opens the database read-only and writes nothing; --apply
 * marks the matched questions answered under the pipeline lock. Prints counts
 * and question labels only, never an answer.
 *
 * Usage: pnpm questions:recheck [--profile real|demo] [--apply]
 */
import { runQuestionsRecheckCommand } from "../src/run-answer";

process.exitCode = await runQuestionsRecheckCommand(process.argv.slice(2));
