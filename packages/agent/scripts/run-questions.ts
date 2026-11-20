/**
 * Lists a held run's open questions with the Discord notice's Q<n> numbers,
 * their kinds and offered options, and whether an answer would be saved for
 * reuse. Read only; prints no answers.
 *
 * Usage: pnpm run:questions --run <id or 8-character prefix> [--profile real|demo]
 */
import { runQuestionsCommand } from "../src/run-answer";

process.exitCode = await runQuestionsCommand(process.argv.slice(2));
