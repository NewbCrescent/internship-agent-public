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
  capturePostSubmitEvidence,
  captureWorkdayEvidence,
  submitEvidenceRoot,
  type AshbySubmitDiagnostics,
  type AshbySubmitNetwork,
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
 * `<time>-workday-account`, with no run id), `workday-errors` when Workday
 * would not save a step, and `workday-entry` when the application did not
 * open (a closed posting, a security check, or neither; the job's folder
 * `<time>-workday-entry` when no run exists yet). `pnpm run:evidence --job`
 * shows a job's evidence.
 * iCIMS stops are saved for the job too: `icims-account` when the account
 * step held the host and `icims-application` when the agent reached iCIMS's
 * application and stopped there (folder `<time>-<outcome>`, no run id).
 *
 * An Ashby submit also keeps its network record (`ashbyNetwork`, Track 22):
 * Ashby's GraphQL operation names and HTTP statuses, the submit's token kind,
 * result type, success, Ashby's error codes and (redacted) messages, and the
 * reCAPTCHA token requests; never a request or response body. It also keeps
 * read-only diagnostics of the click (`ashbyDiagnostics`, Track 27): each click's
 * target and hit test, request methods, hosts and paths after the first click,
 * console and page errors, and visible errors, every text redacted again.
 *
 * A modal dialog over the form while the agent fills it (Track 39) is saved
 * as `covering-dialog`, once per run (saveCoveringDialogEvidenceQuietly):
 * the screenshot, the redacted visible text, and each covering dialog's
 * redacted text, role, aria attributes, and button labels.
 */

export const SUBMIT_EVIDENCE_EVENT = "Post-submit evidence saved";
export const WORKDAY_EVIDENCE_EVENT = "Workday evidence saved";
export const ICIMS_EVIDENCE_EVENT = "iCIMS evidence saved";
export const COVERING_DIALOG_EVIDENCE_EVENT = "Covering dialog evidence saved";
const COVERING_DIALOG_NOT_SAVED_EVENT = "Covering dialog evidence not saved.";
const ICIMS_NOT_SAVED_EVENT = "iCIMS evidence not saved.";
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

const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const RESULT_TYPE = /^[A-Za-z]{1,80}$/;
const FIELD_ENTRY_ID = /^[A-Za-z0-9_-]{1,200}$/;

const networkCall = {
  operation: z.string().regex(OPERATION_NAME),
  status: z.number().int().min(0).max(999).nullable(),
  failed: z.boolean(),
  clicks: z.number().int().min(0).max(20)
};

/** Ashby's submit on the network, as stored (ats/ashby-network.ts): names, statuses, booleans, codes, and redacted messages. */
export const ashbyNetworkFileSchema = z.object({
  calls: z.array(z.object(networkCall)).max(40),
  submits: z.array(z.object({
    ...networkCall,
    recaptchaToken: z.enum(["present", "dummy", "missing", "unknown"]),
    resultType: z.string().max(80).nullable(),
    success: z.boolean(),
    errorCodes: z.array(z.string().max(80)).max(10),
    errorMessages: z.array(z.string().max(200)).max(10),
    formErrorMessages: z.array(z.string().max(200)).max(10),
    fieldErrors: z.array(z.object({ fieldEntryId: z.string().max(200).nullable(), message: z.string().max(200) })).max(10),
    blockMessage: z.boolean()
  })).max(5),
  recaptchaTokenRequests: z.number().int().min(0),
  recaptchaTokenStatuses: z.array(z.number().int().min(0).max(999).nullable()).max(5)
});

/** Ashby's submit diagnostics, as stored (ats/ashby-diagnostics.ts): booleans, tags, hosts, paths, and redacted texts. */
export const ashbyDiagnosticsFileSchema = z.object({
  clicks: z.array(z.object({
    ashbySubmitButton: z.boolean(),
    hitTarget: z.boolean(),
    hitElement: z.string().max(120).nullable(),
    tag: z.string().max(20),
    typeAttribute: z.string().max(20).nullable(),
    text: z.string().max(60)
  })).max(5),
  requests: z.array(z.object({
    method: z.string().regex(/^[A-Z]{1,10}$/),
    host: z.string().max(253),
    path: z.string().max(160),
    resourceType: z.string().max(30),
    clicks: z.number().int().min(0).max(20),
    count: z.number().int().min(1),
    lastStatus: z.number().int().min(0).max(999).nullable(),
    failed: z.boolean()
  })).max(80),
  requestsDropped: z.number().int().min(0),
  console: z.array(z.object({
    kind: z.enum(["error", "warning", "page-error"]),
    text: z.string().max(200),
    clicks: z.number().int().min(0).max(20)
  })).max(20),
  consoleDropped: z.number().int().min(0),
  visibleErrors: z.array(z.string().max(200)).max(10)
});

/** A modal dialog that covered the form (Track 39), as stored: every text redacted, every list cut to its bound. */
export const coveringDialogFileSchema = z.object({
  tag: z.string().max(20),
  role: z.string().max(40).nullable(),
  label: z.string().max(300),
  description: z.string().max(300),
  ariaAttributes: z.array(z.object({ name: z.string().regex(/^aria-[a-z-]{1,40}$/), value: z.string().max(300) })).max(20),
  text: z.string().max(2_000),
  buttons: z.array(z.object({ text: z.string().max(120), ariaLabel: z.string().max(120), title: z.string().max(120), disabled: z.boolean() })).max(20)
});

export const submitEvidenceFileSchema = z.object({
  version: z.literal(1),
  /** Null for a Workday account-step stop: no run was saved yet. */
  runId: z.string().min(1).nullable(),
  jobId: z.string().min(1),
  capturedAt: z.iso.datetime(),
  outcome: z.enum(["field-errors", "refused", "challenged", "verification-code", "unknown", "workday-account", "workday-errors", "workday-entry", "icims-account", "icims-application", "covering-dialog"]),
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
  detail: z.string().max(500).nullable().default(null),
  /** Ashby only: what the submit sent and got back (Track 22); null on other sites and older files. */
  ashbyNetwork: ashbyNetworkFileSchema.nullable().default(null),
  /** Ashby only: read-only diagnostics of the submit click (Track 27); null on other sites and older files. */
  ashbyDiagnostics: ashbyDiagnosticsFileSchema.nullable().default(null),
  /** `covering-dialog` only: the dialogs over the form (Track 39); null on other outcomes and older files. */
  coveringDialogs: z.array(coveringDialogFileSchema).max(5).nullable().default(null)
});

export type StoredSubmitEvidence = z.infer<typeof submitEvidenceFileSchema>;
type StoredAshbyNetwork = z.infer<typeof ashbyNetworkFileSchema>;
type StoredAshbyDiagnostics = z.infer<typeof ashbyDiagnosticsFileSchema>;

const httpStatus = (status: number | null): number | null =>
  status !== null && Number.isInteger(status) && status >= 0 && status <= 999 ? status : null;

/**
 * The network record as stored: every list cut to its bound, operation names
 * and error codes kept only in their expected shape, and every message
 * redacted like the pipeline's notices.
 */
function storedAshbyNetwork(network: AshbySubmitNetwork, scrub: (text: string) => string): StoredAshbyNetwork {
  const message = (text: string) => clip(redactNoticeText(scrub(text)), 200);
  const call = (entry: AshbySubmitNetwork["calls"][number]) => ({
    operation: entry.operation,
    status: httpStatus(entry.status),
    failed: entry.failed,
    clicks: Math.min(20, Math.max(0, Math.trunc(entry.clicks)))
  });
  return {
    calls: network.calls.filter((entry) => OPERATION_NAME.test(entry.operation)).slice(0, 40).map(call),
    submits: network.submits.filter((entry) => OPERATION_NAME.test(entry.operation)).slice(0, 5).map((entry) => ({
      ...call(entry),
      recaptchaToken: entry.recaptchaToken,
      resultType: entry.resultType !== null && RESULT_TYPE.test(entry.resultType) ? entry.resultType : null,
      success: entry.success,
      errorCodes: entry.errorCodes.filter((code) => ERROR_CODE.test(code)).slice(0, 10),
      errorMessages: entry.errorMessages.slice(0, 10).map(message),
      formErrorMessages: entry.formErrorMessages.slice(0, 10).map(message),
      fieldErrors: entry.fieldErrors.slice(0, 10).map((error) => ({
        fieldEntryId: error.fieldEntryId !== null && FIELD_ENTRY_ID.test(error.fieldEntryId) ? error.fieldEntryId : null,
        message: message(error.message)
      })),
      blockMessage: entry.blockMessage
    })),
    recaptchaTokenRequests: Math.max(0, Math.trunc(network.recaptchaTokenRequests)),
    recaptchaTokenStatuses: network.recaptchaTokenStatuses.slice(0, 5).map(httpStatus)
  };
}

const count = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;

/**
 * The diagnostics as stored: every list cut to its bound, every text redacted
 * again like the pipeline's notices, hosts and methods kept only in their
 * expected shape, and numbers clamped.
 */
function storedAshbyDiagnostics(diagnostics: AshbySubmitDiagnostics, scrub: (text: string) => string): StoredAshbyDiagnostics {
  const text = (value: string, max: number) => clip(redactNoticeText(scrub(value)), max);
  return {
    clicks: diagnostics.clicks.slice(0, 5).map((check) => ({
      ashbySubmitButton: check.ashbySubmitButton === true,
      hitTarget: check.hitTarget === true,
      hitElement: check.hitElement === null ? null : text(check.hitElement, 120),
      tag: text(check.tag, 20),
      typeAttribute: check.typeAttribute === null ? null : text(check.typeAttribute, 20),
      text: text(check.text, 60)
    })),
    requests: diagnostics.requests.slice(0, 80).map((entry) => {
      const method = entry.method.toUpperCase();
      return {
        method: /^[A-Z]{1,10}$/.test(method) ? method : "OTHER",
        host: /^[a-z0-9.-]{1,253}$/.test(entry.host) ? entry.host : "[host]",
        path: text(entry.path, 160),
        resourceType: text(entry.resourceType, 30),
        clicks: count(entry.clicks, 0, 20),
        count: count(entry.count, 1, Number.MAX_SAFE_INTEGER),
        lastStatus: httpStatus(entry.lastStatus),
        failed: entry.failed === true
      };
    }),
    requestsDropped: count(diagnostics.requestsDropped, 0, Number.MAX_SAFE_INTEGER),
    console: diagnostics.console.slice(0, 20).map((entry) => ({
      kind: entry.kind,
      text: text(entry.text, 200),
      clicks: count(entry.clicks, 0, 20)
    })),
    consoleDropped: count(diagnostics.consoleDropped, 0, Number.MAX_SAFE_INTEGER),
    visibleErrors: diagnostics.visibleErrors.slice(0, 10).map((value) => text(value, 200))
  };
}

type StoredCoveringDialog = z.infer<typeof coveringDialogFileSchema>;

/** The dialogs as stored: every text redacted like the pipeline's notices and clipped, attribute names kept only in their aria-* shape. */
function storedCoveringDialogs(dialogs: NonNullable<PostSubmitEvidence["coveringDialogs"]>, scrub: (text: string) => string): StoredCoveringDialog[] {
  const text = (value: string, max: number) => clip(redactNoticeText(scrub(value)), max);
  return dialogs.slice(0, 5).map((dialog) => ({
    tag: /^[a-z][a-z0-9-]{0,19}$/.test(dialog.tag) ? dialog.tag : "element",
    role: dialog.role === null ? null : text(dialog.role, 40),
    label: text(dialog.label, 300),
    description: text(dialog.description, 300),
    ariaAttributes: dialog.ariaAttributes
      .filter((attribute) => /^aria-[a-z-]{1,40}$/.test(attribute.name))
      .slice(0, 20)
      .map((attribute) => ({ name: attribute.name, value: text(attribute.value, 300) })),
    text: text(dialog.text, 2_000),
    buttons: dialog.buttons.slice(0, 20).map((button) => ({
      text: text(button.text, 120), ariaLabel: text(button.ariaLabel, 120), title: text(button.title, 120), disabled: button.disabled === true
    }))
  }));
}

/** The lines `pnpm run:evidence` prints for the dialogs over the form; [] when the capture has none stored. */
export function describeCoveringDialogs(dialogs: StoredSubmitEvidence["coveringDialogs"]): string[] {
  if (dialogs === null) return [];
  if (dialogs.length === 0) return ["Covering dialogs: none was still shown when the capture was read"];
  const lines = [`Covering dialogs: ${dialogs.length}`];
  dialogs.forEach((dialog, index) => {
    const attributes = dialog.ariaAttributes.map((attribute) => `${attribute.name}="${attribute.value}"`).join(", ");
    lines.push(`  - dialog ${index + 1}: <${dialog.tag}> role ${dialog.role === null ? "none" : `"${dialog.role}"`}; ${attributes || "no aria attributes"}`);
    if (dialog.label) lines.push(`    label: ${dialog.label}`);
    if (dialog.description) lines.push(`    description: ${dialog.description}`);
    lines.push(`    text: ${dialog.text || "(none)"}`);
    if (dialog.buttons.length === 0) lines.push("    buttons: none");
    else {
      lines.push("    buttons:");
      for (const button of dialog.buttons) {
        const extra = [button.ariaLabel && `aria-label "${button.ariaLabel}"`, button.title && `title "${button.title}"`, button.disabled && "disabled"].filter(Boolean).join(", ");
        lines.push(`      - "${button.text}"${extra ? ` (${extra})` : ""}`);
      }
    }
  });
  return lines;
}

/** The lines `pnpm run:evidence` prints for Ashby's submit diagnostics; [] when there are none. */
export function describeAshbyDiagnostics(diagnostics: StoredSubmitEvidence["ashbyDiagnostics"]): string[] {
  if (diagnostics === null) return [];
  const lines = [`Ashby submit click(s): ${diagnostics.clicks.length}`];
  diagnostics.clicks.forEach((check, index) => {
    lines.push(
      `  - click ${index + 1}: on Ashby's submit button: ${check.ashbySubmitButton ? "yes" : "no"}; `
      + `hit test at its centre: ${check.hitTarget ? "yes" : "no"}${check.hitElement ? `, found ${check.hitElement}` : ""}; `
      + `${check.tag}${check.typeAttribute === null ? ", no type attribute" : `, type "${check.typeAttribute}"`}; "${check.text}"`
    );
  });
  lines.push(`Requests after the first click: ${diagnostics.requests.length} (${diagnostics.requestsDropped} not kept)`);
  for (const entry of diagnostics.requests) {
    const answer = entry.lastStatus !== null ? `HTTP ${entry.lastStatus}` : entry.failed ? "failed" : "no answer";
    lines.push(`  - ${entry.method} ${entry.host}${entry.path} ×${entry.count} after click ${entry.clicks}: ${answer}`);
  }
  lines.push(`Console after the watch started: ${diagnostics.console.length}`);
  for (const entry of diagnostics.console) lines.push(`  - [${entry.kind}, click ${entry.clicks}] ${entry.text || "(not kept)"}`);
  if (diagnostics.visibleErrors.length === 0) lines.push("Visible errors: none");
  else {
    lines.push("Visible errors:");
    for (const error of diagnostics.visibleErrors) lines.push(`  - ${error}`);
  }
  return lines;
}

/** The lines `pnpm run:evidence` prints for an Ashby network record. */
export function describeAshbyNetwork(network: StoredSubmitEvidence["ashbyNetwork"]): string[] {
  if (network === null) return [];
  const statuses = network.recaptchaTokenStatuses;
  const lines = [
    `Ashby network: ${network.calls.length} GraphQL call(s) recorded; reCAPTCHA token requests: ${network.recaptchaTokenRequests}${statuses.length ? ` (HTTP ${statuses.map((status) => status ?? "no answer").join(", ")})` : ""}`
  ];
  if (network.submits.length === 0) {
    lines.push("  - no submit request was sent");
    return lines;
  }
  for (const submit of network.submits) {
    const answer = submit.status === null ? (submit.failed ? "request failed" : "no answer") : `HTTP ${submit.status}`;
    const codes = submit.errorCodes.join(", ");
    lines.push(
      `  - ${submit.operation} after click ${submit.clicks}: ${answer}; token ${submit.recaptchaToken}; result ${submit.resultType ?? "none"}${submit.success ? " (accepted)" : ""}; error codes: ${codes || "none"}`
      + `${submit.errorMessages.length ? `; errors: ${submit.errorMessages.join(" | ")}` : ""}`
      + `${submit.formErrorMessages.length ? `; form errors: ${submit.formErrorMessages.join(" | ")}` : ""}`
      + `${submit.fieldErrors.length ? `; field errors: ${submit.fieldErrors.length}` : ""}`
      + `${submit.blockMessage ? "; block message shown" : ""}`
    );
  }
  return lines;
}

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

const isWorkdayOutcome = (outcome: PostSubmitEvidence["outcome"]) => outcome === "workday-account" || outcome === "workday-errors" || outcome === "workday-entry";
const isIcimsOutcome = (outcome: PostSubmitEvidence["outcome"]) => outcome === "icims-account" || outcome === "icims-application";

function evidenceEvent(outcome: PostSubmitEvidence["outcome"]): string {
  if (outcome === "covering-dialog") return COVERING_DIALOG_EVIDENCE_EVENT;
  if (isWorkdayOutcome(outcome)) return WORKDAY_EVIDENCE_EVENT;
  if (isIcimsOutcome(outcome)) return ICIMS_EVIDENCE_EVENT;
  return SUBMIT_EVIDENCE_EVENT;
}

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
  const folder = `${capturedAt.replace(/[:.]/g, "-")}-${run.id ?? evidence.outcome}`;
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
    detail: typeof evidence.detail === "string" ? clip(redactNoticeText(scrub(evidence.detail)), 500) : null,
    ashbyNetwork: evidence.ashbyNetwork ? storedAshbyNetwork(evidence.ashbyNetwork, scrub) : null,
    ashbyDiagnostics: evidence.ashbyDiagnostics ? storedAshbyDiagnostics(evidence.ashbyDiagnostics, scrub) : null,
    coveringDialogs: evidence.coveringDialogs ? storedCoveringDialogs(evidence.coveringDialogs, scrub) : null
  } satisfies StoredSubmitEvidence);
  writePrivateAtomic(join(dir, "evidence.json"), JSON.stringify(stored, null, 2) + "\n");

  const relativeDir = `applications/${run.jobId}/submit-evidence/${folder}`;
  const status = getJobPosting(database, run.jobId)?.status ?? "APPLYING";
  logApplicationEvent(database, {
    jobId: run.jobId, fromStatus: status, toStatus: status,
    detail: `${evidenceEvent(evidence.outcome)} (${evidence.outcome}): ${relativeDir}; view it with pnpm run:evidence ${run.id ? `--run ${run.id.slice(0, 8)}` : `--job ${run.jobId.slice(0, 8)}`}.`
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
  outcome: "workday-account" | "workday-errors" | "workday-entry";
  /** What happened, in the agent's words (the hold reason, the step Workday would not save, or why the application did not open). */
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

export type SaveIcimsEvidenceInput = {
  database: DatabaseSync;
  dataDir: string;
  jobId: string;
  page: BrowserPage;
  outcome: "icims-account" | "icims-application";
  /** What happened, in the agent's words (the hold reason, or the stop after reaching the application). */
  detail: string;
  /** The account email and the host's saved email and password: never stored. */
  secrets?: string[];
  now?: Date;
};

/**
 * Saves the evidence of an iCIMS stop for the job (no run was saved) while
 * its page is still open: the screenshot and redacted text a follow-up iCIMS
 * adapter can be built from. Never throws; a failure logs a plain event.
 */
export async function saveIcimsEvidenceQuietly(input: SaveIcimsEvidenceInput): Promise<void> {
  try {
    const evidence = await capturePostSubmitEvidence(input.page, input.outcome, { detail: input.detail });
    await savePostSubmitEvidence({
      database: input.database, dataDir: input.dataDir, run: { id: null, jobId: input.jobId }, page: input.page, evidence,
      secrets: input.secrets, now: input.now
    });
  } catch {
    try {
      const status = getJobPosting(input.database, input.jobId)?.status ?? "READY_FOR_REVIEW";
      logApplicationEvent(input.database, { jobId: input.jobId, fromStatus: status, toStatus: status, detail: ICIMS_NOT_SAVED_EVENT });
    } catch {
      // The run's own outcome stands.
    }
  }
}

export type SaveCoveringDialogEvidenceInput = {
  database: DatabaseSync;
  dataDir: string;
  /** The run the fill belongs to; at start its id is chosen before the run is saved. */
  run: { id: string; jobId: string };
  page: BrowserPage;
  /** captureCoveringDialogEvidence's result, read while the dialog was up. */
  evidence: PostSubmitEvidence;
  now?: Date;
};

/**
 * Saves the evidence of a modal dialog over the form (Track 39) the first
 * time one leaves a field unfilled in the run: nothing when the run already
 * keeps a `covering-dialog` capture. Clicks nothing. Never throws and never
 * changes the run's outcome; a failure logs a plain event.
 */
export async function saveCoveringDialogEvidenceQuietly(input: SaveCoveringDialogEvidenceInput): Promise<void> {
  try {
    if (readSubmitEvidence(input.dataDir, input.run).some((entry) => entry.outcome === "covering-dialog")) return;
    await savePostSubmitEvidence({
      database: input.database, dataDir: input.dataDir, run: input.run, page: input.page,
      evidence: { ...input.evidence, outcome: "covering-dialog" }, now: input.now
    });
  } catch {
    try {
      const status = getJobPosting(input.database, input.run.jobId)?.status ?? "APPLYING";
      logApplicationEvent(input.database, { jobId: input.run.jobId, fromStatus: status, toStatus: status, detail: COVERING_DIALOG_NOT_SAVED_EVENT });
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
  "workday-errors": "Workday would not save a step",
  "workday-entry": "the Workday application did not open",
  "icims-account": "the iCIMS account step stopped",
  "icims-application": "the agent reached iCIMS's application and stopped",
  "covering-dialog": "a dialog covered the form while the agent filled it"
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
      if (byJob) io.log(entry.runId
        ? `Run: ${entry.runId.slice(0, 8)}`
        : entry.outcome === "workday-entry"
          ? "Run: none (the application did not open, so no run was saved)"
          : "Run: none (the account step stopped before a run was saved)");
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
      if (entry.ashbyNetwork !== null) for (const line of describeAshbyNetwork(entry.ashbyNetwork)) io.log(line);
      if (entry.ashbyDiagnostics !== null) for (const line of describeAshbyDiagnostics(entry.ashbyDiagnostics)) io.log(line);
      if (entry.coveringDialogs !== null) for (const line of describeCoveringDialogs(entry.coveringDialogs)) io.log(line);
      io.log(entry.screenshot ? `Screenshot: ${join(entry.dir, entry.screenshot)}` : "Screenshot: not saved");
      io.log("Visible text (redacted):");
      io.log(entry.text);
    }
    return 0;
  } finally {
    io.close(flags.profile);
  }
}
