import type { DatabaseSync } from "node:sqlite";

import {
  applicationHoldFixUsed,
  applicationReceiptConfirmed,
  closeProfileDatabase,
  findBrowserRunIds,
  getApplicationHold,
  getBrowserRun,
  getJobPosting,
  getProfileDatabase,
  listApplicationEvents,
  listBrowserRuns,
  listJobSummaries,
  readApplicationReceiptCheck,
  recordApplicationHoldReopen,
  recordApplicationHoldRetry,
  resolveProfileDataDirectory,
  setJobStatus,
  withApplicationHoldTransaction,
  type ApplicationHold
} from "@internship-agent/db";
import {
  manualOnly,
  mentionsCompany,
  runStartedByPipeline,
  workspaceProfileSchema,
  type BrowserRun,
  type BrowserRunStatus,
  type WorkspaceProfile
} from "@internship-agent/domain";

import { mayHaveSubmitted, observeApplicationHolds } from "./application-holds";
import { cancelBrowserRun } from "./browser-orchestrator";
import { greenhouseMailSender } from "./greenhouse-security-code";
import { acquirePipelineLock } from "./pipeline-lock";
import { AUTOMATIC_RETRY_PREFIX, pipelineSettings, REOPENED_UNSUBMITTED_PREFIX } from "./pipeline-orchestrator";
import { readSubmitEvidence } from "./submit-evidence";
import { resolveWorkdayAccounts, workdayAccountSettings } from "./workday-account-service";
import { putWorkdayAccount, readWorkdayAccounts, WorkdayAccountsFileError, type WorkdayAccountEntry } from "./workday-account-store";

/**
 * Retrying an automatic run that a since-fixed bug held: the run is
 * cancelled and its job goes back to READY_FOR_REVIEW, so the next pipeline
 * pass starts a fresh automatic run under the current code, with the company
 * cap, profile lock, target, and fit rules applied as usual. Only runs the
 * pipeline started qualify, and never one the candidate already touched
 * (an answered pause or a submit approval) or one that may have reached the
 * site. `pnpm pipeline:retry` drives it. Deterministic: no model, no network.
 *
 * `--reopen-unsubmitted` is the one exception for a failed submit: it reopens
 * a run whose submit was clicked only with positive evidence that the site
 * did not complete it (Greenhouse's security-code email after the click, or a
 * verification-code evidence capture), never one with a confirmation.
 *
 * `--held` also releases Workday account holds the account step left as
 * "unexpected" (it stopped on a page it did not recognize, or Workday did not
 * answer). No run was saved for those: the account step runs before the
 * walk, so the host's hold in the accounts file is what keeps the pipeline
 * away. Released, the next pass signs in with the saved password (or tries
 * the account step again). Other hold kinds (CAPTCHA, refused or wrong
 * passwords, lockouts, interrupted creations) are never released here.
 */

/** Statuses a retry may cancel. "failed" is set only by a failed submit, which always carries an approval, so it is refused below. */
const RETRYABLE: ReadonlySet<BrowserRunStatus> = new Set(["paused-needs-input", "awaiting-approval", "failed"]);
/** What `--held` looks at: runs waiting on the candidate. */
const HELD: ReadonlySet<BrowserRunStatus> = new Set(["paused-needs-input", "awaiting-approval"]);

export class AutomaticRetryRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AutomaticRetryRefused";
  }
}

/** Why a run may not be retried, or null when it may. */
export function automaticRetryBlocker(database: DatabaseSync, run: BrowserRun): string | null {
  if (!RETRYABLE.has(run.status)) return `it is ${run.status}; only held (paused or awaiting approval) or failed runs are retried.`;
  if (run.submissionApprovedAt) return "its submission was approved, so it may have reached the site.";
  if (run.pauses.some((pause) => pause.status === "answered")) {
    return "you already answered one of its questions; continue it with pnpm run:answer instead.";
  }
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "APPLYING") return `its application is ${posting.status.toLocaleLowerCase("en-US").replace(/_/g, " ")}, not applying.`;
  const applying = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  if (!runStartedByPipeline(run.createdAt, applying)) return "you started it yourself; only runs the pipeline started are retried.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status === "submitted" || other.status === "submitting")) return "the application already has a submitted run.";
  // The next pass starts a run only when every other run is cancelled; a failed one may have reached the site.
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open or failed.";
  return null;
}

/**
 * Cancels an eligible automatic run, moves its job from APPLYING back to
 * READY_FOR_REVIEW, and logs "Automatic run retried after a fix: <reason>".
 * Throws AutomaticRetryRefused (with the reason) for any other run.
 */
export function retryAutomaticRun(database: DatabaseSync, runId: string, options: { reason: string }): BrowserRun {
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A retry needs a reason.");
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  const blocker = automaticRetryBlocker(database, run);
  if (blocker) throw new AutomaticRetryRefused(blocker);
  const cancelled = cancelBrowserRun(run.id, database);
  setJobStatus(database, run.jobId, "APPLYING", "READY_FOR_REVIEW", (AUTOMATIC_RETRY_PREFIX + reason).slice(0, 1_000));
  return cancelled;
}

/** Why a failed submit is known not to have completed on the site (shown in output and the event). */
export type UnsubmittedEvidence = { kind: "security-code-email" | "verification-code-evidence"; text: string };

const SECURITY_CODE_EMAIL_TEXT = "Greenhouse emailed a security code after the submit click";
const VERIFICATION_EVIDENCE_TEXT = "its post-submit evidence shows the site's emailed security-code step";
/** The Gmail watcher's timeline note (mailEventDetail): `Email received: <label> from <domain>: "<subject>"`. */
const MAIL_EVENT = /^Email received: [^"]*? from ([a-z0-9.-]+): "([^"]*)"/i;
/** Mail this long after the approval no longer counts as this submit's. */
const MAIL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RECEIPT_CHECK_FRESH_MS = 15 * 60 * 1_000;

/** Positive evidence, after the submit approval (the click follows it), that the site did not complete the run; null when none. */
export function unsubmittedEvidence(database: DatabaseSync, dataDir: string, run: BrowserRun): UnsubmittedEvidence | null {
  if (!run.submissionApprovedAt) return null;
  const approvedAt = Date.parse(run.submissionApprovedAt);
  if (Number.isNaN(approvedAt)) return null;
  const posting = getJobPosting(database, run.jobId);
  if (posting) {
    const emailed = listApplicationEvents(database, run.jobId).some((event) => {
      const at = Date.parse(event.createdAt);
      if (!(at > approvedAt && at <= approvedAt + MAIL_WINDOW_MS)) return false;
      const match = MAIL_EVENT.exec(event.detail ?? "");
      if (!match) return false;
      const [, domain, subject] = match;
      return greenhouseMailSender(`x@${domain!}`)
        && /security code for your application to /i.test(subject!)
        && mentionsCompany(subject!, posting.companyName);
    });
    if (emailed) return { kind: "security-code-email", text: SECURITY_CODE_EMAIL_TEXT };
  }
  const captured = readSubmitEvidence(dataDir, run).some((entry) => entry.outcome === "verification-code" && Date.parse(entry.capturedAt) >= approvedAt);
  return captured ? { kind: "verification-code-evidence", text: VERIFICATION_EVIDENCE_TEXT } : null;
}

/** Why a failed submit may not be reopened as not submitted, or null when it may. */
export function reopenUnsubmittedBlocker(database: DatabaseSync, dataDir: string, run: BrowserRun): string | null {
  if (run.status !== "failed") return `it is ${run.status}; --reopen-unsubmitted reopens only a failed submit.`;
  if (!run.submissionApprovedAt) return "its submission was never approved, so its submit was never clicked; retry it without --reopen-unsubmitted.";
  if (run.confirmationText && run.confirmationText.trim()) return "a confirmation was recognized, so it stays as it is.";
  if (applicationReceiptConfirmed(database, run.id)) return "a trusted application receipt was found, so it stays as it is.";
  const posting = getJobPosting(database, run.jobId);
  if (!posting) return "its posting is unknown.";
  if (posting.status !== "APPLYING") return `its application is ${posting.status.toLocaleLowerCase("en-US").replace(/_/g, " ")}, not applying.`;
  const applying = listApplicationEvents(database, run.jobId)
    .filter((event) => event.toStatus === "APPLYING")
    .map((event) => ({ detail: event.detail, at: event.createdAt }));
  if (!runStartedByPipeline(run.createdAt, applying)) return "you started it yourself; only runs the pipeline started are reopened.";
  const others = listBrowserRuns(database, run.jobId).filter((other) => other.id !== run.id);
  if (others.some((other) => other.status === "submitted" || other.status === "submitting")) return "the application already has a submitted run.";
  if (others.some((other) => other.status !== "cancelled")) return "another run of this application is open or failed.";
  if (unsubmittedEvidence(database, dataDir, run) === null) {
    return "there is no evidence the site did not complete it (no security-code email after the submit click and no security-code step in its evidence); check the application on the site.";
  }
  const check = readApplicationReceiptCheck(database, run.id);
  const latestEvidence = readSubmitEvidence(dataDir, run)[0]?.capturedAt;
  const latestAttempt = Math.max(Date.parse(run.submissionApprovedAt), latestEvidence ? Date.parse(latestEvidence) : 0);
  const checkedAt = check ? Date.parse(check.checkedAt) : Number.NaN;
  const age = Date.now() - checkedAt;
  if (check?.result !== "absent" || Date.parse(check.attemptedAt) !== Date.parse(run.submissionApprovedAt)
    || !(checkedAt >= latestAttempt && age >= 0 && age <= RECEIPT_CHECK_FRESH_MS)) {
    return `a completed receipt check for this attempt is required (pnpm mail:scan --receipt ${run.id.slice(0, 8)}).`;
  }
  return null;
}

/**
 * Cancels a failed submit the site is known not to have completed, moves its
 * job from APPLYING back to READY_FOR_REVIEW, and logs "Automatic run retried
 * after a fix: reopened as not submitted (<evidence>): <reason>". The
 * AUTOMATIC_RETRY_PREFIX keeps the pipeline's retry semantics (stops before
 * it no longer block). Throws AutomaticRetryRefused (with the reason) otherwise.
 */
export function reopenUnsubmittedRun(
  database: DatabaseSync,
  dataDir: string,
  runId: string,
  options: { reason: string }
): { run: BrowserRun; evidence: UnsubmittedEvidence } {
  const reason = options.reason.replace(/\s+/g, " ").trim();
  if (!reason) throw new Error("A reopen needs a reason.");
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new Error("The browser run is unknown.");
    const blocker = reopenUnsubmittedBlocker(database, dataDir, run);
    if (blocker) throw new AutomaticRetryRefused(blocker);
    const evidence = unsubmittedEvidence(database, dataDir, run)!;
    const cancelled = cancelBrowserRun(run.id, database);
    setJobStatus(database, run.jobId, "APPLYING", "READY_FOR_REVIEW",
      (REOPENED_UNSUBMITTED_PREFIX + `${evidence.text}): ${reason}`).slice(0, 1_000));
    recordApplicationHoldReopen(database, run.jobId, run.id, new Date().toISOString());
    return { run: cancelled, evidence };
  });
}

export type VerifiedHoldFix = { revision: number; recheck: string };

function verifiedHold(
  database: DatabaseSync, dataDir: string, run: BrowserRun, fix: VerifiedHoldFix
): ApplicationHold | string {
  const blocker = automaticRetryBlocker(database, run);
  if (blocker) return blocker;
  if (run.status === "awaiting-approval") return "the run is awaiting approval or review.";
  if (run.pauses.some((pause) => pause.safeguard)) return "the run has a safeguard that requires separate review.";
  if (mayHaveSubmitted(run, readSubmitEvidence(dataDir, run)) || applicationReceiptConfirmed(database, run.id)) {
    return "the run may already have submitted.";
  }
  const hold = getApplicationHold(database, run.jobId, run.id);
  if (!hold?.active || hold.owner !== "manager" || hold.reason !== "automation-fault") return "there is no active manager-owned pre-submit fault.";
  if (hold.revision !== fix.revision) return "the hold revision changed.";
  const current = observeApplicationHolds(database, dataDir).observations.find((item) => item.runId === run.id);
  if (!current || current.owner !== hold.owner || current.reason !== hold.reason || current.identity !== hold.identity) {
    return "the hold evidence or reason changed; refresh and review the trace.";
  }
  if (applicationHoldFixUsed(database, hold, fix.recheck)) return "that recheck was already used for this job and evidence.";
  return hold;
}

export function requeueVerifiedHold(
  database: DatabaseSync, dataDir: string, runId: string, fix: VerifiedHoldFix, reason: string, now = new Date()
): BrowserRun {
  if (!Number.isSafeInteger(fix.revision) || fix.revision < 1 || !/^[a-f0-9]{7,64}$/i.test(fix.recheck) || !reason.trim()) {
    throw new AutomaticRetryRefused("a revision, passing recheck reference, and reason are required.");
  }
  return withApplicationHoldTransaction(database, () => {
    const run = getBrowserRun(database, runId);
    if (!run) throw new AutomaticRetryRefused("the browser run is unknown.");
    const hold = verifiedHold(database, dataDir, run, fix);
    if (typeof hold === "string") throw new AutomaticRetryRefused(hold);
    const cancelled = retryAutomaticRun(database, runId, { reason });
    recordApplicationHoldRetry(database, hold, fix.recheck, now.toISOString());
    return cancelled;
  });
}

/** Every held run (paused or awaiting approval) on an applying job, newest first per job. */
export function listHeldRuns(database: DatabaseSync): BrowserRun[] {
  return listJobSummaries(database)
    .filter((job) => job.status === "APPLYING")
    .flatMap((job) => listBrowserRuns(database, job.id).filter((run) => HELD.has(run.status)));
}

/** Workday account hosts held as "unexpected", which `--held` releases; sorted by host. Throws WorkdayAccountsFileError. */
export function releasableWorkdayHolds(file: string): WorkdayAccountEntry[] {
  return Object.values(readWorkdayAccounts(file))
    .filter((entry) => entry.hold?.kind === "unexpected")
    .sort((left, right) => left.host.localeCompare(right.host));
}

/**
 * Clears one host's "unexpected" hold, keeping its email, password, account
 * state, and creation time. Throws for any other hold kind (or none).
 */
export function releaseWorkdayAccountHold(file: string, host: string, now = new Date()): WorkdayAccountEntry {
  const entry = readWorkdayAccounts(file)[host];
  if (!entry || entry.hold?.kind !== "unexpected") throw new Error(`Workday ${host} has no hold the retry may release.`);
  const released: WorkdayAccountEntry = { ...entry, hold: null, updatedAt: now.toISOString() };
  putWorkdayAccount(file, released);
  return released;
}

// ---- pnpm pipeline:retry ----

export type RetryCommandDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  log(line: string): void;
  acquireLock(dataDir: string): () => void;
  /** One pipeline pass with no discovery, run while this command holds the lock (`--start`). */
  startPass(profile: WorkspaceProfile, log: (line: string) => void): Promise<unknown>;
  env: Record<string, string | undefined>;
};

const RETRY_USAGE = "Usage: pnpm pipeline:retry [--profile real|demo] (--run <id or 8-character prefix> ... | --held) [--dry-run] [--start] [--reason \"<text>\"] | --run <id or 8-character prefix> ... --reopen-unsubmitted --reason \"<text>\" [--dry-run] [--start] | --run <ref> --verified-hold --revision <n> --recheck <hex ref> --reason \"<text>\" [--dry-run]";
const DEFAULT_REASON = "the bug that held it is fixed.";
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RetryArgs = { profile: WorkspaceProfile; runs: string[]; held: boolean; dryRun: boolean; start: boolean; reason: string; reopen: boolean; verified: VerifiedHoldFix | null };

/** `--run` takes one or more references (repeated flags or several values); null on anything unknown, missing, or contradictory. */
function parseRetryArgs(argv: string[]): RetryArgs | null {
  let profileText: string | undefined;
  let reason: string | undefined;
  const runs: string[] = [];
  let held = false;
  let dryRun = false;
  let start = false;
  let reopen = false;
  let verified = false;
  let revision: string | undefined;
  let recheck: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--held" || arg === "--dry-run" || arg === "--start" || arg === "--reopen-unsubmitted" || arg === "--verified-hold") {
      if ((arg === "--held" && held) || (arg === "--dry-run" && dryRun) || (arg === "--start" && start)
        || (arg === "--reopen-unsubmitted" && reopen) || (arg === "--verified-hold" && verified)) return null;
      if (arg === "--held") held = true;
      else if (arg === "--dry-run") dryRun = true;
      else if (arg === "--reopen-unsubmitted") reopen = true;
      else if (arg === "--verified-hold") verified = true;
      else start = true;
    } else if (arg === "--run") {
      const before = runs.length;
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) {
        runs.push(argv[index + 1]!.trim());
        index += 1;
      }
      if (runs.length === before) return null;
    } else if (arg === "--revision" || arg === "--recheck") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--revision" && revision === undefined) revision = value;
      else if (arg === "--recheck" && recheck === undefined) recheck = value;
      else return null;
      index += 1;
    } else if (arg === "--profile" || arg === "--reason") {
      const value = argv[index + 1];
      if (value === undefined || (arg === "--profile" ? profileText !== undefined : reason !== undefined)) return null;
      if (arg === "--profile") profileText = value;
      else reason = value;
      index += 1;
    } else {
      return null;
    }
  }
  const profile = workspaceProfileSchema.safeParse(profileText ?? "real");
  if (!profile.success) return null;
  if (held === (runs.length > 0)) return null; // exactly one of --run / --held
  if (runs.some((ref) => ref === "")) return null;
  if (dryRun && start) return null; // a dry run writes nothing, so it cannot start a pass
  const trimmed = reason?.replace(/\s+/g, " ").trim();
  if (reason !== undefined && !trimmed) return null;
  // A reopen names its runs and says why; the default reason never applies.
  if (reopen && (held || reason === undefined)) return null;
  if (verified && (held || start || reopen || runs.length !== 1 || !trimmed || !revision || !recheck
    || !/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !/^[a-f0-9]{7,64}$/i.test(recheck))) return null;
  if (!verified && (revision !== undefined || recheck !== undefined)) return null;
  return { profile: profile.data, runs, held, dryRun, start, reason: trimmed ?? DEFAULT_REASON, reopen,
    verified: verified ? { revision: Number(revision), recheck: recheck!.toLowerCase() } : null };

}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeRun(database: DatabaseSync, run: BrowserRun): string {
  const posting = getJobPosting(database, run.jobId);
  const name = posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
  return `${run.id.slice(0, 8)} ${name} (${run.status})`;
}

/** The run a typed reference names, or why none is chosen. */
function resolveRef(database: DatabaseSync, typed: string): BrowserRun | string {
  const shown = clip(typed, 40);
  if (FULL_ID.test(typed)) return getBrowserRun(database, typed.toLowerCase()) ?? `no browser run matches "${shown}".`;
  const ids = findBrowserRunIds(database, typed);
  if (ids.length === 0) return `no browser run matches "${shown}".`;
  if (ids.length > 1) return `several runs match "${shown}"; give more characters.`;
  return getBrowserRun(database, ids[0]!) ?? `no browser run matches "${shown}".`;
}

/**
 * `pnpm pipeline:retry`: retries the named runs (or every held one with
 * `--held`) under the workspace's pipeline lock and prints one line per run,
 * `retried` or `skipped (<reason>)`. `--dry-run` writes nothing and takes no
 * lock. `--start` then runs one pass with no discovery while still holding
 * the lock. `--reopen-unsubmitted --reason "<text>"` (with `--run` only)
 * reopens failed submits instead, each only with evidence the site did not
 * complete it (reopenUnsubmittedBlocker), printing `reopened` or `skipped`.
 * With Workday account automation on, `--held` also releases the account
 * holds left as "unexpected" (releasableWorkdayHolds), one line per host.
 * Returns 0, 1 (lock, retry, accounts file, or pass failure), or 2 (usage).
 */
export async function runRetryCommand(argv: string[], deps: Partial<RetryCommandDeps> = {}): Promise<number> {
  const io: RetryCommandDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    log: deps.log ?? ((line) => console.log(line)),
    acquireLock: deps.acquireLock ?? ((dataDir) => acquirePipelineLock(dataDir)),
    startPass: deps.startPass ?? (async () => { throw new Error("no pipeline pass is available here."); }),
    env: deps.env ?? process.env
  };
  const args = parseRetryArgs(argv);
  if (!args) {
    io.log(RETRY_USAGE);
    return 2;
  }
  if ((!args.dryRun || args.verified) && manualOnly(io.env)) {
    io.log("Not run: manual checklist mode is on; the pipeline starts no browser runs.");
    return 1;
  }
  let release: () => void = () => {};
  if (!args.dryRun) {
    try {
      release = io.acquireLock(io.dataDir(args.profile));
    } catch (error) {
      io.log(`Not run: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
      return 1;
    }
  }
  let exit = 0;
  try {
    let retried = 0;
    let skipped = 0;
    let released = 0;
    const database = io.open(args.profile);
    try {
      const seen = new Set<string>();
      const targets: Array<BrowserRun | { ref: string; reason: string }> = args.held
        ? listHeldRuns(database)
        : args.runs.map((ref) => {
          const found = resolveRef(database, ref);
          return typeof found === "string" ? { ref: clip(ref, 40), reason: found } : found;
        });
      if (args.held && targets.length === 0) io.log("No held runs.");
      for (const target of targets) {
        if (!("id" in target)) {
          skipped += 1;
          io.log(`skipped ${target.ref} (${target.reason})`);
          continue;
        }
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        const label = describeRun(database, target);
        if (args.verified) {
          const dataDir = io.dataDir(args.profile);
          const hold = verifiedHold(database, dataDir, target, args.verified);
          if (typeof hold === "string") {
            skipped += 1;
            io.log(`skipped ${label} (${hold})`);
            continue;
          }
          try {
            if (!args.dryRun) requeueVerifiedHold(database, dataDir, target.id, args.verified, args.reason);
            retried += 1;
            io.log(`${args.dryRun ? "would requeue" : "requeued"} ${label} after verified pre-submit fix.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        if (args.reopen) {
          const dataDir = io.dataDir(args.profile);
          const blocker = reopenUnsubmittedBlocker(database, dataDir, target);
          if (blocker) {
            skipped += 1;
            io.log(`skipped ${label} (${blocker})`);
            continue;
          }
          if (args.dryRun) {
            retried += 1;
            io.log(`would reopen ${label} (${unsubmittedEvidence(database, dataDir, target)!.text})`);
            continue;
          }
          try {
            const { evidence } = reopenUnsubmittedRun(database, dataDir, target.id, { reason: args.reason });
            retried += 1;
            io.log(`reopened ${label}: cancelled as not submitted (${evidence.text}); the application is back to ready for review.`);
          } catch (error) {
            skipped += 1;
            exit = 1;
            io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
          }
          continue;
        }
        const blocker = automaticRetryBlocker(database, target);
        if (blocker) {
          skipped += 1;
          io.log(`skipped ${label} (${blocker})`);
          continue;
        }
        if (args.dryRun) {
          retried += 1;
          io.log(`would retry ${label}`);
          continue;
        }
        try {
          retryAutomaticRun(database, target.id, { reason: args.reason });
          retried += 1;
          io.log(`retried ${label}: cancelled; the application is back to ready for review.`);
        } catch (error) {
          skipped += 1;
          exit = 1;
          io.log(`skipped ${label} (${clip(error instanceof Error ? error.message : String(error), 300)})`);
        }
      }
      if (args.held && !args.reopen) {
        const outcome = releaseWorkdayHolds(io, args);
        released = outcome.released;
        if (outcome.failed) exit = 1;
      }
    } finally {
      io.close(args.profile);
    }
    const verb = args.reopen ? "reopen" : "retry";
    io.log(args.dryRun
      ? `Dry run: would ${verb} ${retried}; skipped ${skipped}; nothing written.`
      : `${args.reopen ? "Reopened" : "Retried"} ${retried}; skipped ${skipped}.`);
    if (released > 0) {
      io.log(args.dryRun ? `Dry run: would release ${released} Workday account hold(s).` : `Released ${released} Workday account hold(s).`);
    }
    if (!args.dryRun && retried + released > 0 && !pipelineSettings(io.env).autoApply) {
      io.log("Auto-apply is off (INTERNSHIP_AGENT_AUTO_APPLY), so no pass will start these runs until it is on.");
    }
    if (args.start) {
      if (retried + released === 0) {
        io.log(args.reopen ? "Nothing reopened; no pass started." : "Nothing retried; no pass started.");
      } else {
        io.log("Starting one pipeline pass without discovery.");
        try {
          await io.startPass(args.profile, io.log);
        } catch (error) {
          exit = 1;
          io.log(`Pass failed: ${clip(error instanceof Error ? error.message : String(error), 300)}`);
        }
      }
    }
  } finally {
    release();
  }
  return exit;
}

/**
 * `--held`'s Workday part: releases (or, in a dry run, lists) every
 * "unexpected" account hold when account automation is on for this
 * workspace; prints nothing when it is off.
 */
function releaseWorkdayHolds(io: RetryCommandDeps, args: RetryArgs): { released: number; failed: boolean } {
  const settings = workdayAccountSettings(io.env);
  if (!settings) return { released: 0, failed: false };
  const resolved = resolveWorkdayAccounts(settings, io.dataDir(args.profile), io.env);
  if (!("runtime" in resolved)) return { released: 0, failed: false };
  const file = resolved.runtime.file;
  let released = 0;
  try {
    for (const entry of releasableWorkdayHolds(file)) {
      const reason = clip(entry.hold?.reason ?? "", 200);
      if (args.dryRun) {
        released += 1;
        io.log(`would release the Workday account hold on ${entry.host} (${reason})`);
        continue;
      }
      releaseWorkdayAccountHold(file, entry.host);
      released += 1;
      const next = entry.password && entry.account !== "refused" ? "signs in with the saved password" : "tries the account step again";
      io.log(`released the Workday account hold on ${entry.host} (${reason}): the next pass ${next}.`);
    }
  } catch (error) {
    if (!(error instanceof WorkdayAccountsFileError)) throw error;
    io.log("Workday account holds not released: the accounts file cannot be read.");
    return { released, failed: true };
  }
  return { released, failed: false };
}
