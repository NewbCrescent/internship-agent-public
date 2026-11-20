/**
 * Answers one held run's question (the Discord notice's Q<n>) under the
 * workspace's pipeline lock, saves it for reuse unless --once or a never-save
 * rule applies, and continues the run when no question is left open (or with
 * --continue). Never prints the answer; never calls a model. Continuing opens
 * the visible browser, so on the PC run it under xvfb-run -a.
 *
 * Usage: pnpm run:answer --run <id or 8-character prefix> --q <n> --answer "<text or option>" [--once] [--continue] [--profile real|demo]
 */
import { runAnswerCommand } from "../src/run-answer";

process.exitCode = await runAnswerCommand(process.argv.slice(2));
