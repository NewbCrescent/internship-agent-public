import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  closeProfileDatabase,
  findBrowserRunIds,
  findJobIds,
  getBrowserRun,
  getJobPosting,
  getProfileDatabase,
  logApplicationEvent,
  resolveProfileDataDirectory
} from "@internship-agent/db";
import {
  captureWorkdayEvidence,
  submitEvidenceRoot,
  type BrowserPage,
  type PostSubmitEvidence,
  type WorkdayPage,
  type WorkdayPageError
} from "@internship-agent/browser";
import { workspaceProfileSchema, type BrowserRun, type JobPosting, type WorkspaceProfile } from "@internship-agent/domain";

import { redactNoticeText } from "./pass-notice";

/**
 * Post-submit evidence: what the page showed after a submit click that was
 * not a recognized confirmation (field errors, a refusal, a challenge, the
 * site's emailed security-code step, or nothing). Kept local in the run's application folder (directory 700, files
 * 600) and read with `pnpm run:evidence`; never sent to Discord or a model.
 * The timeline names only the folder's path relative to the data directory.
 *
 * Workday stops are saved the same way: `workday-account` when the account
 * step held the host (before any run was saved, so the folder is the job's,
 * `<time>-workday-account`, with no run id) and `workday-errors` when Workday
 * would not save a step. `pnpm run:evidence --job` shows a job's evidence.
 */

export const SUBMIT_EVIDENCE_EVENT = "Post-submit evidence saved";
export const WORKDAY_EVIDENCE_EVENT = "Workday evidence saved";
const NOT_SAVED_EVENT = "Post-submit evidence not saved.";
const WORKDAY_NOT_SAVED_EVENT = "Workday evidence not saved.";
const MAX_TEXT = 20_000;

/** Redacts each line as the pipeline's notices do (emails, URL queries, long digit runs), drops empty lines, and caps the text. */
export function redactEvidenceText(text: string, max = MAX_TEXT): string {
  return text
    .split(/\r?\n/)
    .map((line) => redactNoticeText(line))
    .filter(Boolean)
    .join("\n")
    .slice(0, max);
}

export const submitEvidenceFileSchema = z.object({
  version: z.literal(1),
  /** Null for a Workday account-step stop: no run was saved yet. */
  runId: z.string().min(1).nullable(),
  jobId: z.string().min(1),
  capturedAt: z.iso.datetime(),
  outcome: z.enum(["field-errors", "refused", "challenged", "verification-code", "unknown", "workday-account", "workday-errors"]),
  url: z.string().max(2_000),
  invalidFields: z.array(z.object({
    ref: z.string().max(200).nullable(),
    label: z.string().max(300),
    error: z.string().max(300)
  })).max(30),
  alertText: z.string().max(1_000),
  challenge: z.string().max(300).nullable(),
  text: z.string().max(MAX_TEXT),
  screenshot: z.string().nullable(),
  /** What the agent says happened (a Workday hold reason); null on older files. */
  detail: z.string().max(500).nullable().default(null)
});

export type StoredSubmitEvidence = z.infer<typeof submitEvidenceFileSchema>;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

function writePrivateAtomic(path: string, bytes: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

export type SaveSubmitEvidenceInput = {
  database: DatabaseSync;
  dataDir: string;
  /** `id` is null for a Workday account-step stop (no run was saved). */
  run: { id: string | null; jobId: string };
  page: BrowserPage;
  evidence: PostSubmitEvidence;
  /** Values never stored (the account email and password): each is replaced by "[redacted]" in every text. */
  secrets?: string[];
  now?: Date;
};

function scrubSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) result = result.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  return result;
}

const isWorkdayOutcome = (outcome: PostSubmitEvidence["outcome"]) => outcome === "workday-account" || outcome === "workday-errors";

/**
 * Writes one evidence folder for the run: a full-page screenshot (none once
 * an emailed security code was typed into the page) and
 * `evidence.json` (redacted, capped text; the query-stripped URL; invalid
 * fields; the site's error text; the challenge), then logs a timeline event
 * naming the folder relative to the data directory.
 */
export async function savePostSubmitEvidence(input: SaveSubmitEvidenceInput): Promise<{ relativeDir: string; screenshotSaved: boolean }> {
  const { database, dataDir, run, page, evidence } = input;
  const secrets = (input.secrets ?? []).filter((secret) => secret.length > 0);
  const scrub = (text: string) => scrubSecrets(text, secrets);
  const capturedAt = (input.now ?? new Date()).toISOString();
  const folder = `${capturedAt.replace(/[:.]/g, "-")}-${run.id ?? "workday-account"}`;
  const root = submitEvidenceRoot(dataDir, run.jobId);
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(dir, 0o700);

  const screenshotPath = join(dir, "screenshot.png");
  let screenshotSaved = false;
  // A screenshot after the emailed security code was typed could show it; the code is never stored.
  if (!evidence.securityCodeEntered) {
    try {
      await page.screenshot(screenshotPath, { fullPage: true });
      chmodSync(screenshotPath, 0o600);
      screenshotSaved = true;
    } catch {
      rmSync(screenshotPath, { force: true });
    }
  }

  const stored = submitEvidenceFileSchema.parse({
    version: 1,
    runId: run.id,
    jobId: run.jobId,
    capturedAt,
    outcome: evidence.outcome,
    url: clip(scrub(evidence.url), 2_000),
    invalidFields: evidence.invalidFields.slice(0, 30).map((field) => ({
      ref: field.ref === null ? null : clip(field.ref, 200),
      label: clip(redactNoticeText(scrub(field.label)), 300),
      error: clip(redactNoticeText(scrub(field.error)), 300)
    })),
    alertText: clip(redactNoticeText(scrub(evidence.alertText)), 1_000),
    challenge: evidence.challenge === null ? null : clip(evidence.challenge, 300),
    text: redactEvidenceText(scrub(evidence.bodyText)),
    screenshot: screenshotSaved ? "screenshot.png" : null,
    detail: typeof evidence.detail === "string" ? clip(redactNoticeText(scrub(evidence.detail)), 500) : null
  } satisfies StoredSubmitEvidence);
  writePrivateAtomic(join(dir, "evidence.json"), JSON.stringify(stored, null, 2) + "\n");

  const relativeDir = `applications/${run.jobId}/submit-evidence/${folder}`;
  const status = getJobPosting(database, run.jobId)?.status ?? "APPLYING";
  logApplicationEvent(database, {
    jobId: run.jobId, fromStatus: status, toStatus: status,
    detail: `${isWorkdayOutcome(evidence.outcome) ? WORKDAY_EVIDENCE_EVENT : SUBMIT_EVIDENCE_EVENT} (${evidence.outcome}): ${relativeDir}; view it with pnpm run:evidence ${run.id ? `--run ${run.id.slice(0, 8)}` : `--job ${run.jobId.slice(0, 8)}`}.`
  });
  return { relativeDir, screenshotSaved };
}

/** savePostSubmitEvidence that never throws and never changes the run's outcome; a failure logs a plain event (no path, no error text). */
export async function savePostSubmitEvidenceQuietly(input: SaveSubmitEvidenceInput): Promise<void> {
  try {
    await savePostSubmitEvidence(input);
  } catch {
    try {
      const status = getJobPosting(input.database, input.run.jobId)?.status ?? "APPLYING";
      logApplicationEvent(input.database, { jobId: input.run.jobId, fromStatus: status, toStatus: status, detail: NOT_SAVED_EVENT });
    } catch {
      // The submission's own outcome stands.
    }
  }
}

export type SaveWorkdayEvidenceInput = {
  database: DatabaseSync;
  dataDir: string;
  run: { id: string | null; jobId: string };
  page: WorkdayPage;
  outcome: "workday-account" | "workday-errors";
  /** What happened, in the agent's words (the hold reason, or the step Workday would not save). */
  detail: string;
  /** Workday's errors when the walk already read them; otherwise they are read from the page. */
  errors?: WorkdayPageError[];
  secrets?: string[];
  now?: Date;
};

/**
 * Saves the evidence of a Workday stop while its page is still open. Never
 * throws and never changes the run's outcome; a failure logs a plain event.
 */
export async function saveWorkdayEvidenceQuietly(input: SaveWorkdayEvidenceInput): Promise<void> {
  try {
    const evidence = await captureWorkdayEvidence(input.page, input.outcome, { detail: input.detail, errors: input.errors });
    await savePostSubmitEvidence({
      database: input.database, dataDir: input.dataDir, run: input.run, page: input.page, evidence, secrets: input.secrets, now: input.now
    });
  } catch {
    try {
      const status = getJobPosting(input.database, input.run.jobId)?.status ?? "READY_FOR_REVIEW";
      logApplicationEvent(input.database, { jobId: input.run.jobId, fromStatus: status, toStatus: status, detail: WORKDAY_NOT_SAVED_EVENT });
    } catch {
      // The run's own outcome stands.
    }
  }
}

/** Every valid evidence entry under the job's folder, newest first. */
function readEvidenceEntries(dataDir: string, jobId: string): Array<StoredSubmitEvidence & { dir: string }> {
  const root = submitEvidenceRoot(dataDir, jobId);
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const found: Array<StoredSubmitEvidence & { dir: string }> = [];
  for (const name of entries) {
    const dir = join(root, name);
    let parsed: ReturnType<typeof submitEvidenceFileSchema.safeParse>;
    try {
      parsed = submitEvidenceFileSchema.safeParse(JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8")));
    } catch {
      continue;
    }
    if (parsed.success && parsed.data.jobId === jobId) found.push({ ...parsed.data, dir });
  }
  return found.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0));
}

/** The run's stored evidence, newest first; unreadable or invalid files are skipped. */
export function readSubmitEvidence(dataDir: string, run: Pick<BrowserRun, "id" | "jobId">): Array<StoredSubmitEvidence & { dir: string }> {
  return readEvidenceEntries(dataDir, run.jobId).filter((entry) => entry.runId === run.id);
}

/** All of a job's stored evidence (its runs' and its Workday account-step stops'), newest first. */
export function readJobEvidence(dataDir: string, jobId: string): Array<StoredSubmitEvidence & { dir: string }> {
  return readEvidenceEntries(dataDir, jobId);
}

export type RunEvidenceDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  log(line: string): void;
};

const EVIDENCE_USAGE = "Usage: pnpm run:evidence (--run <id or 8-character prefix> | --job <id or 8-character prefix>) [--all] [--profile real|demo]";
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME_TEXT: Record<StoredSubmitEvidence["outcome"], string> = {
  "field-errors": "the site marked fields invalid",
  refused: "the site showed an error",
  challenged: "a CAPTCHA appeared after the click",
  "verification-code": "the site asked for a security code it emailed",
  unknown: "no confirmation was recognized",
  "workday-account": "the Workday account step stopped",
  "workday-errors": "Workday would not save a step"
};

type EvidenceFlags = { target: { kind: "run" | "job"; ref: string }; profile: WorkspaceProfile; all: boolean };

function parseEvidenceFlags(argv: string[]): EvidenceFlags | null {
  let run: string | undefined;
  let job: string | undefined;
  let profileText: string | undefined;
  let all = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--all") {
      if (all) return null;
      all = true;
    } else if (arg === "--run" || arg === "--job" || arg === "--profile") {
      const value = argv[index + 1];
      if (value === undefined) return null;
      if (arg === "--run") {
        if (run !== undefined) return null;
        run = value;
      } else if (arg === "--job") {
        if (job !== undefined) return null;
        job = value;
      } else {
        if (profileText !== undefined) return null;
        profileText = value;
      }
      index += 1;
    } else {
      return null;
    }
  }
  // Exactly one of --run and --job.
  if ((run === undefined) === (job === undefined)) return null;
  const ref = (run ?? job)!.trim();
  if (!ref) return null;
  let profile: WorkspaceProfile = "real";
  if (profileText !== undefined) {
    const parsed = workspaceProfileSchema.safeParse(profileText);
    if (!parsed.success) return null;
    profile = parsed.data;
  }
  return { target: { kind: run !== undefined ? "run" : "job", ref }, profile, all };
}

function resolveEvidenceRun(database: DatabaseSync, typed: string): BrowserRun {
  const runRef = clip(typed, 40);
  if (FULL_ID.test(typed)) {
    const run = getBrowserRun(database, typed.toLowerCase());
    if (!run) throw new Error(`No browser run matches "${runRef}".`);
    return run;
  }
  const ids = findBrowserRunIds(database, typed);
  if (ids.length === 0) throw new Error(`No browser run matches "${runRef}".`);
  if (ids.length > 1) throw new Error(`Several runs match "${runRef}"; give more characters.`);
  const run = getBrowserRun(database, ids[0]!);
  if (!run) throw new Error(`No browser run matches "${runRef}".`);
  return run;
}

function resolveEvidenceJob(database: DatabaseSync, typed: string): JobPosting {
  const jobRef = clip(typed, 40);
  if (FULL_ID.test(typed)) {
    const job = getJobPosting(database, typed.toLowerCase());
    if (!job) throw new Error(`No job matches "${jobRef}".`);
    return job;
  }
  const ids = findJobIds(database, typed);
  if (ids.length === 0) throw new Error(`No job matches "${jobRef}".`);
  if (ids.length > 1) throw new Error(`Several jobs match "${jobRef}"; give more characters.`);
  const job = getJobPosting(database, ids[0]!);
  if (!job) throw new Error(`No job matches "${jobRef}".`);
  return job;
}

/**
 * `pnpm run:evidence (--run <ref> | --job <ref>) [--all] [--profile real|demo]`:
 * prints a run's stored evidence, or a job's (its runs' and its Workday
 * account-step stops'), the newest capture or all with --all.
 * Read only: no lock, no writes, no network, no model.
 */
export async function runEvidenceCommand(argv: string[], deps: Partial<RunEvidenceDeps> = {}): Promise<number> {
  const io: RunEvidenceDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    log: deps.log ?? ((line) => console.log(line))
  };
  const flags = parseEvidenceFlags(argv);
  if (!flags) {
    io.log(EVIDENCE_USAGE);
    return 2;
  }
  const database = io.open(flags.profile);
  try {
    let stored: Array<StoredSubmitEvidence & { dir: string }>;
    const byJob = flags.target.kind === "job";
    try {
      if (byJob) {
        const job = resolveEvidenceJob(database, flags.target.ref);
        io.log(`Job ${job.id.slice(0, 8)}: ${clip(job.companyName, 120)} — ${clip(job.title, 120)} (${job.status})`);
        stored = readJobEvidence(io.dataDir(flags.profile), job.id);
      } else {
        const run = resolveEvidenceRun(database, flags.target.ref);
        const posting = getJobPosting(database, run.jobId);
        const name = posting ? `${clip(posting.companyName, 120)} — ${clip(posting.title, 120)}` : "Unknown posting";
        io.log(`Run ${run.id.slice(0, 8)}: ${name} (${run.status})`);
        stored = readSubmitEvidence(io.dataDir(flags.profile), run);
      }
    } catch (error) {
      io.log(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (stored.length === 0) {
      io.log(byJob ? "No evidence is stored for this job." : "No post-submit evidence is stored for this run.");
      return 0;
    }
    const shown = flags.all ? stored : stored.slice(0, 1);
    for (const [index, entry] of shown.entries()) {
      io.log(`Evidence ${index + 1} of ${stored.length}, captured ${entry.capturedAt}: ${entry.outcome} (${OUTCOME_TEXT[entry.outcome]})`);
      if (byJob) io.log(entry.runId ? `Run: ${entry.runId.slice(0, 8)}` : "Run: none (the account step stopped before a run was saved)");
      io.log(`URL: ${entry.url || "(none)"}`);
      if (entry.detail !== null) io.log(`Detail: ${entry.detail}`);
      if (entry.invalidFields.length === 0) {
        io.log("Invalid fields: none");
      } else {
        io.log("Invalid fields:");
        for (const field of entry.invalidFields) io.log(`  - ${field.label}: ${field.error}`);
      }
      if (entry.alertText) io.log(`Site error text: ${entry.alertText}`);
      if (entry.challenge !== null) io.log(`Challenge: ${entry.challenge}`);
      io.log(entry.screenshot ? `Screenshot: ${join(entry.dir, entry.screenshot)}` : "Screenshot: not saved");
      io.log("Visible text (redacted):");
      io.log(entry.text);
    }
    return 0;
  } finally {
    io.close(flags.profile);
  }
}
