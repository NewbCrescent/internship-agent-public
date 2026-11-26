import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  findJobIds,
  getCurrentPackage,
  getDiscoverySkip,
  getJobMatch,
  getJobPosting,
  getProfileDatabase,
  getRequirementLabelHold,
  listBrowserRuns,
  listJobSummaries,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  openProfileDatabaseReadOnly,
  resolveProfileDataDirectory,
  saveJobMatch,
  statusForVerdict
} from "@internship-agent/db";
import {
  workspaceProfileSchema,
  type BrowserRun,
  type JobPostingStatus,
  type MatchVerdict,
  type WorkspaceProfile
} from "@internship-agent/domain";

import { evaluateMatch } from "./match-orchestrator";
import { acquirePipelineLock } from "./pipeline-lock";

/**
 * Re-runs the stored match evaluation after a matching change (Track 56).
 * Match verdicts are stored, so a rule fix reaches stored postings only
 * through here. It never evaluates postings the candidate decided on or that
 * are past analysis, and it writes only postings still in analysis whose
 * status matches their stored verdict and that were never prepared or run.
 */

/** Why a stored match is not re-evaluated. */
export const REEVALUATION_SKIPS = {
  notAnalyzed: "not analyzed yet",
  submitted: "submitted or later",
  approved: "approved",
  candidateSkipped: "skipped or closed by the candidate",
  applying: "applying with a browser run",
  labelHeld: "held for AI requirement labels"
} as const;

/** Why a changed verdict is listed but never written. */
export const LEFT_IN_PLACE = {
  inProgress: "application in progress",
  setApart: "status set apart from its verdict"
} as const;

const SUBMITTED_OR_LATER: ReadonlySet<JobPostingStatus> = new Set(["SUBMITTED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"]);
const IN_ANALYSIS: ReadonlySet<JobPostingStatus> = new Set(["DISCOVERED", "ANALYZING", "QUALIFIED", "NOT_QUALIFIED"]);

/** Whether a stored match may be re-evaluated, and whether a changed verdict may be written (pure). */
export function reevaluationGate(input: {
  status: JobPostingStatus;
  storedVerdict: MatchVerdict;
  discoverySkipped: boolean;
  labelHeld: boolean;
  runStatuses: BrowserRun["status"][];
  prepared: boolean;
}): { kind: "skip"; reason: string } | { kind: "evaluate"; leftInPlace: string | null } {
  if (SUBMITTED_OR_LATER.has(input.status)) return { kind: "skip", reason: REEVALUATION_SKIPS.submitted };
  if (input.status === "APPROVED") return { kind: "skip", reason: REEVALUATION_SKIPS.approved };
  if (input.discoverySkipped) return { kind: "skip", reason: REEVALUATION_SKIPS.candidateSkipped };
  // A failed run counts: a failed submit may still have gone through.
  if (input.status === "APPLYING" && input.runStatuses.some((status) => status !== "cancelled")) {
    return { kind: "skip", reason: REEVALUATION_SKIPS.applying };
  }
  if (input.labelHeld) return { kind: "skip", reason: REEVALUATION_SKIPS.labelHeld };
  if (!IN_ANALYSIS.has(input.status) || input.prepared || input.runStatuses.length > 0) {
    return { kind: "evaluate", leftInPlace: LEFT_IN_PLACE.inProgress };
  }
  if (input.status !== statusForVerdict(input.storedVerdict)) {
    return { kind: "evaluate", leftInPlace: LEFT_IN_PLACE.setApart };
  }
  return { kind: "evaluate", leftInPlace: null };
}

export type ReevaluatedPosting = { companyName: string; title: string; from: MatchVerdict; to: MatchVerdict };

export type MatchReevaluationReport = {
  apply: boolean;
  evaluated: number;
  /** "<old> → <new>" for every evaluated posting, unchanged ones included. */
  transitions: Record<string, number>;
  /** Changed verdicts written (with --apply) or that would be written (dry run). */
  changed: ReevaluatedPosting[];
  /** Changed verdicts never written, and why. */
  leftInPlace: Array<ReevaluatedPosting & { reason: string }>;
  skipped: Record<string, number>;
  errors: string[];
};

/** The timeline detail an applied re-evaluation logs before "<old> → <new>.". */
export const REEVALUATION_EVENT_PREFIX = "Match re-evaluated by pnpm matches:reevaluate: ";

function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function byCompanyAndTitle(left: ReevaluatedPosting, right: ReevaluatedPosting): number {
  return left.companyName.localeCompare(right.companyName, "en-US") || left.title.localeCompare(right.title, "en-US");
}

/** Re-evaluates stored matches; writes changed verdicts only with apply. The report holds no job ids. */
export function reevaluateMatches(
  database: DatabaseSync,
  options: { apply: boolean; candidateId?: string; jobId?: string }
): MatchReevaluationReport {
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const report: MatchReevaluationReport = {
    apply: options.apply, evaluated: 0, transitions: {}, changed: [], leftInPlace: [], skipped: {}, errors: []
  };
  const skip = (reason: string) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };
  const jobIds = options.jobId ? [options.jobId] : listJobSummaries(database).map((job) => job.id);

  for (const jobId of jobIds) {
    const posting = getJobPosting(database, jobId);
    if (!posting) continue;
    const match = getJobMatch(database, jobId);
    if (!match) {
      skip(REEVALUATION_SKIPS.notAnalyzed);
      continue;
    }
    const gate = reevaluationGate({
      status: posting.status,
      storedVerdict: match.verdict,
      discoverySkipped: Boolean(getDiscoverySkip(database, jobId)),
      labelHeld: Boolean(getRequirementLabelHold(database, jobId)),
      runStatuses: listBrowserRuns(database, jobId).map((run) => run.status),
      prepared: Boolean(getCurrentPackage(database, jobId))
    });
    if (gate.kind === "skip") {
      skip(gate.reason);
      continue;
    }

    let to: MatchVerdict;
    let evaluation: ReturnType<typeof evaluateMatch>;
    try {
      evaluation = evaluateMatch(jobId, { database, candidateId });
      to = evaluation.report.verdict;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(clip(`${posting.companyName} — ${posting.title}: ${message}`, 300));
      continue;
    }
    const from = match.verdict;
    report.evaluated += 1;
    const key = `${from} → ${to}`;
    report.transitions[key] = (report.transitions[key] ?? 0) + 1;
    if (to === from) continue;

    const entry: ReevaluatedPosting = { companyName: posting.companyName, title: posting.title, from, to };
    if (gate.leftInPlace) {
      report.leftInPlace.push({ ...entry, reason: gate.leftInPlace });
      continue;
    }
    report.changed.push(entry);
    if (options.apply) {
      saveJobMatch(database, evaluation.report);
      logApplicationEvent(database, {
        jobId,
        fromStatus: posting.status,
        toStatus: statusForVerdict(to),
        detail: `${REEVALUATION_EVENT_PREFIX}${from} → ${to}.`
      });
    }
  }

  report.changed.sort(byCompanyAndTitle);
  report.leftInPlace.sort(byCompanyAndTitle);
  return report;
}

export const REEVALUATE_USAGE = "Usage: pnpm matches:reevaluate --profile real|demo [--apply] [--job <id or 8-character prefix>]";

export type ReevaluateCommandDeps = {
  log?: (line: string) => void;
  openReadOnly?: (profile: WorkspaceProfile) => DatabaseSync;
  openForWrite?: (profile: WorkspaceProfile) => DatabaseSync;
  closeForWrite?: (profile: WorkspaceProfile) => void;
  dataDir?: (profile: WorkspaceProfile) => string;
  acquireLock?: (dataDir: string) => () => void;
};

const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedArgs = { profile: WorkspaceProfile; apply: boolean; job: string | null };

function parseArgs(args: string[]): ParsedArgs | null {
  let profile: string | null = null;
  let apply = false;
  let job: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      if (apply) return null;
      apply = true;
    } else if (arg === "--profile" || arg === "--job") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      index += 1;
      if (arg === "--profile") {
        if (profile !== null) return null;
        profile = value;
      } else {
        if (job !== null) return null;
        job = value;
      }
    } else {
      return null;
    }
  }
  const parsed = workspaceProfileSchema.safeParse(profile);
  return parsed.success ? { profile: parsed.data, apply, job } : null;
}

/** `pnpm matches:reevaluate`: a dry run by default (read-only handle, no lock); --apply takes the pipeline lock. */
export function runMatchReevaluationCommand(args: string[], deps: ReevaluateCommandDeps = {}): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const openReadOnly = deps.openReadOnly ?? openProfileDatabaseReadOnly;
  const openForWrite = deps.openForWrite ?? getProfileDatabase;
  const closeForWrite = deps.closeForWrite ?? closeProfileDatabase;
  const dataDir = deps.dataDir ?? resolveProfileDataDirectory;
  const acquireLock = deps.acquireLock ?? acquirePipelineLock;

  const parsed = parseArgs(args);
  if (!parsed) {
    log(REEVALUATE_USAGE);
    return 1;
  }
  const { profile, apply, job } = parsed;

  let release: (() => void) | undefined;
  if (apply) {
    try {
      release = acquireLock(dataDir(profile));
    } catch (error) {
      log(`Not started: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  let database: DatabaseSync | undefined;
  try {
    try {
      database = apply ? openForWrite(profile) : openReadOnly(profile);
    } catch (error) {
      log(`The ${profile} workspace database could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    let jobId: string | undefined;
    if (job !== null) {
      if (FULL_ID.test(job) && getJobPosting(database, job)) {
        jobId = job;
      } else {
        const matches = findJobIds(database, job);
        if (matches.length === 0) {
          log(`No job matches "${clip(job, 40)}".`);
          return 1;
        }
        if (matches.length > 1) {
          log(`Several jobs match "${job}"; give more characters.`);
          return 1;
        }
        jobId = matches[0];
      }
    }

    const report = reevaluateMatches(database, { apply, ...(jobId ? { jobId } : {}) });
    log(`Match re-evaluation (${profile}, ${apply ? "applied" : "dry run"}): ${report.evaluated} evaluated.`);
    log("Verdicts (old → new):");
    for (const [key, count] of Object.entries(report.transitions).sort(([left], [right]) => left.localeCompare(right, "en-US"))) {
      log(`  ${key}: ${count}`);
    }
    log(`Changed (${report.changed.length}):`);
    for (const posting of report.changed) log(`  ${posting.from} → ${posting.to}  ${posting.companyName} — ${posting.title}`);
    log(`Changed but left in place (${report.leftInPlace.length}):`);
    for (const posting of report.leftInPlace) {
      log(`  ${posting.from} → ${posting.to}  ${posting.companyName} — ${posting.title} (${posting.reason})`);
    }
    log("Skipped:");
    for (const [reason, count] of Object.entries(report.skipped).sort(([left], [right]) => left.localeCompare(right, "en-US"))) {
      log(`  ${reason}: ${count}`);
    }
    if (report.errors.length > 0) {
      log(`Errors (${report.errors.length}):`);
      for (const error of report.errors) log(`  ${error}`);
    }
    log(`MATCH_REEVALUATION_REPORT ${JSON.stringify({ profile, ...report })}`);
    if (!apply) log("Dry run: nothing was written. Re-run with --apply to save these changes.");
    return 0;
  } finally {
    if (database) {
      if (apply) closeForWrite(profile);
      else if (database.isOpen) database.close();
    }
    release?.();
  }
}
