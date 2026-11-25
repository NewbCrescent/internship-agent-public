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
 * click, a verification-code evidence capture, or post-submit evidence that
 * shows the site never took the click: Ashby's busy notice, Dover's
 * Turnstile, or an older capture of the intact Ashby form or of a Dover form
 * with a Turnstile marker), then the job is ready for review again unless a
 * trusted receipt has been recorded; a fresh absent receipt check is required.
 * --close-unsubmitted --reason … closes a failed submit that was never
 * clicked ("No submit control was found") on a posting its evidence shows
 * closed: the run is cancelled and the job skipped as "Posting closed"; it is
 * never retried. --correct-submitted --reason … corrects a SUBMITTED record
 * that rests only on the closed-dialog relabel ("Modal dialog closed after
 * submit without errors") when the evidence shows the site never took it; it
 * writes only with --confirm (--dry-run checks), leaves the run failed and
 * held as a possible submission, and deletes no history.
 * --verified-hold --revision <n> --recheck <hex ref> --reason "<text>" names
 * one verified pre-submit repair and requeues only its manager-owned hold.
 *
 * Usage: pnpm pipeline:retry [--profile real|demo] (--run <id or 8-character prefix> ... | --held) [--dry-run] [--start] [--reason "<text>"]
 *        pnpm pipeline:retry [--profile real|demo] --run <id or 8-character prefix> ... --reopen-unsubmitted --reason "<text>" [--dry-run] [--start]
 *        pnpm pipeline:retry [--profile real|demo] --run <id or 8-character prefix> ... --close-unsubmitted --reason "<text>" [--dry-run]
 *        pnpm pipeline:retry [--profile real|demo] --run <id or 8-character prefix> ... --correct-submitted --reason "<text>" (--dry-run | --confirm)
 */
import { runRetryCommand } from "../src/automatic-retry";
import { runPipelinePass } from "./pipeline-pass";

process.exitCode = await runRetryCommand(process.argv.slice(2), {
  startPass: (profile, log) => runPipelinePass({ profile, sourceIds: [], log, lockHeld: true })
});
