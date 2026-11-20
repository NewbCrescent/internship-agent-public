/**
 * Retries automatic runs a since-fixed bug held: each eligible run is
 * cancelled and its application goes back to ready for review, so the next
 * pipeline pass starts a fresh automatic run under the current code. Only
 * runs the pipeline started qualify, never one with an answered question or
 * a submit approval. --held also releases Workday account holds the account
 * step left as "unexpected" (no run was saved for them), so the next pass
 * signs in with the saved password or tries the account step again; other
 * account holds stay. Holds the workspace's pipeline lock; --dry-run writes
 * nothing. --start then runs one pass with no discovery in this process
 * (like pnpm pipeline:run --skip-discovery), still holding the lock; that
 * opens the visible browser, so on the PC run it under
 * xvfb-run -a env -u WAYLAND_DISPLAY pnpm pipeline:retry ... --start.
 * --reopen-unsubmitted --reason … cancels a failed submit only with evidence
 * the site did not complete it (Greenhouse's security-code email after the
 * click, or a verification-code evidence capture), then the job is ready for
 * review again.
 *
 * Usage: pnpm pipeline:retry [--profile real|demo] (--run <id or 8-character prefix> ... | --held) [--dry-run] [--start] [--reason "<text>"]
 *        pnpm pipeline:retry [--profile real|demo] --run <id or 8-character prefix> ... --reopen-unsubmitted --reason "<text>" [--dry-run] [--start]
 */
import { runRetryCommand } from "../src/automatic-retry";
import { runPipelinePass } from "./pipeline-pass";

process.exitCode = await runRetryCommand(process.argv.slice(2), {
  startPass: (profile, log) => runPipelinePass({ profile, sourceIds: [], log, lockHeld: true })
});
