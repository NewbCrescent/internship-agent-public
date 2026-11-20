/**
 * Prints a run's stored evidence (--run), or a job's (--job: its runs' and
 * its Workday account-step stops', which have no run): the outcome, the
 * query-stripped URL, the agent's detail, the fields the site marked invalid
 * with its error texts, the site's error text, the screenshot path, and the
 * redacted visible text. Evidence covers submit clicks without a
 * confirmation and Workday stops (the account step, or a step Workday would
 * not save). For the manager, to tell the candidate what happened. Read
 * only; no lock, no network, no model.
 *
 * Usage: pnpm run:evidence (--run <id or 8-character prefix> | --job <id or 8-character prefix>) [--all] [--profile real|demo]
 */
import { runEvidenceCommand } from "../src/submit-evidence";

process.exitCode = await runEvidenceCommand(process.argv.slice(2));
