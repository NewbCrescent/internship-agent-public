import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  getBaseResume,
  getCandidate,
  getCandidateDocument,
  getCurrentFact,
  getJobPosting,
  getResumeVariant,
  listApplicationEvents,
  listBrowserRuns,
  listSubmittedJobIds,
  logApplicationEvent,
  LOCAL_CANDIDATE_ID
} from "@internship-agent/db";
import {
  appendPdfPages,
  applicationRecordPdfPath,
  baseResumeFilePath,
  candidateDocumentFilePath,
  countPdfPages,
  readablePdfPages,
  renderHtmlToPdf,
  resumePdfPath,
  submittedFieldLabelsPath,
  uploadFileName
} from "@internship-agent/browser";
import { AUTO_SUBMIT_EVENT, profileOfRun, type BrowserRun, type FillDecision } from "@internship-agent/domain";

/**
 * The local PDF record of exactly what one submitted application sent:
 * company, role, URLs, submission time, who approved it, the profile and
 * graduation answers, every form field as submitted, the attached resume and
 * transcript (appended as pages when they can be verified), the confirmation,
 * and the posting snapshot. It is written next to the application's other
 * files in the git-ignored profile data directory (mode 600) and is never
 * attached to messages or sent anywhere.
 */

type RecordRenderer = (html: string, outputPath: string) => Promise<{ pages: number }>;

export const APPLICATION_RECORD_EVENT = "Application record saved";

export type ApplicationRecordInput = { database: DatabaseSync; dataDir: string; jobId: string; labels?: Record<string, string> };
export type ApplicationRecordWriter = (input: ApplicationRecordInput) => Promise<void>;

export type ApplicationRecord = {
  jobId: string;
  runId: string | null;
  companyName: string;
  title: string;
  postingUrl: string;
  applicationUrl: string | null;
  applicationType: string;
  atsKind: string | null;
  submittedAt: string | null;
  generatedAt: string;
  approval:
    | { kind: "policy"; at: string; basis: string }
    | { kind: "candidate"; at: string | null }
    | { kind: "manual"; at: string | null }
    | { kind: "unknown" };
  profile: { kind: "default" | "transcript-alternate"; graduationDate: string | null; answeredGraduation: string | null } | null;
  fields: Array<{ label: string; labelReconstructed: boolean; value: string; source: string }>;
  leftBlank: string[];
  attachments: Array<{
    role: "resume" | "transcript";
    description: string;
    uploadedAs: string | null;
    sha256: string | null;
    byteSize: number | null;
    pages: number | null;
    appended: boolean;
    note: string | null;
  }>;
  confirmation: string | null;
  posting: { capturedAt: string; text: string; truncated: boolean };
};

const POSTING_TEXT_LIMIT = 100_000;
const MANUAL_DETAIL = "Candidate applied manually.";

const sidecarSchema = z.object({ version: z.literal(1), runId: z.string(), labels: z.record(z.string(), z.string()) });

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** `graduation_date` -> `Graduation date`; `legalFirstName` -> `Legal first name`. */
function humanize(key: string): string {
  const words = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLocaleLowerCase("en-US").trim();
  return words ? words.charAt(0).toLocaleUpperCase("en-US") + words.slice(1) : key;
}

function readSidecarLabels(dataDir: string, jobId: string, runId: string): Record<string, string> {
  try {
    const parsed = sidecarSchema.parse(JSON.parse(readFileSync(submittedFieldLabelsPath(dataDir, jobId), "utf8")) as unknown);
    return parsed.runId === runId ? parsed.labels : {};
  } catch {
    return {};
  }
}

function writePrivateAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
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

function writeSidecar(dataDir: string, jobId: string, runId: string, labels: Record<string, string>): void {
  const merged = { ...readSidecarLabels(dataDir, jobId, runId), ...labels };
  writePrivateAtomic(submittedFieldLabelsPath(dataDir, jobId), JSON.stringify({ version: 1, runId, labels: merged }) + "\n");
}

function reconstructedLabel(decision: FillDecision, run: BrowserRun): string {
  const pause = run.pauses.find((entry) => entry.fieldId === decision.fieldId);
  if (pause) return pause.label;
  const basis = decision.basis;
  switch (basis?.kind) {
    case "package-answer": return basis.prompt;
    case "fact": return humanize(basis.key);
    case "profile": return humanize(basis.field);
    case "variant":
    case "base_resume": return "Resume";
    case "candidate_document": return "Transcript";
    default: return decision.fieldId.replace(/::/g, ": ");
  }
}

function sourceOf(decision: FillDecision): string {
  const basis = decision.basis;
  switch (basis?.kind) {
    case "fact": return `Saved answer (${basis.key}, ${basis.scope})`;
    case "profile": return `Profile (${basis.field})`;
    case "package-answer": return "Prepared answer";
    case "voice_draft": return "Drafted in your voice (voice gate passed)";
    case "resume_entry": return "Resume entry";
    case "variant": return "Tailored resume";
    case "base_resume": return "Uploaded base resume";
    case "candidate_document": return "Transcript";
    case "question_answer": return "Saved answer (question memory)";
    default: return clip(decision.reason, 160);
  }
}

type Attachment = ApplicationRecord["attachments"][number];
type FileCheck = { path: string | null; bytes: Uint8Array | null; note: string | null };

/** Finds a stored file whose bytes still match the checksum recorded when it was stored. */
function verifiedFile(paths: string[], recordedSha256: string): FileCheck {
  let mismatch: string | null = null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (sha256(bytes) === recordedSha256) return { path, bytes, note: null };
    mismatch ??= path;
  }
  if (mismatch) return { path: mismatch, bytes: null, note: "The file on disk no longer matches the recorded checksum." };
  return { path: null, bytes: null, note: "The file is no longer on disk." };
}

/** The transcript's stored path, then any `documents.removed-*` folder it was moved to. */
function documentPaths(dataDir: string, fileName: string): string[] {
  const paths = [candidateDocumentFilePath(dataDir, fileName)];
  try {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("documents.removed-")) paths.push(join(dataDir, entry.name, fileName));
    }
  } catch {
    // An unreadable data directory leaves only the stored path.
  }
  return paths;
}

export async function buildApplicationRecord(
  database: DatabaseSync,
  dataDir: string,
  jobId: string,
  now: Date = new Date()
): Promise<{ record: ApplicationRecord; appendFiles: Uint8Array[] }> {
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown.");
  const events = listApplicationEvents(database, jobId);
  const submittedEvent = events.find((event) => event.toStatus === "SUBMITTED" && event.fromStatus !== "SUBMITTED") ?? null;
  const run = listBrowserRuns(database, jobId).find((entry) => entry.status === "submitted") ?? null;
  if (!submittedEvent && !run) throw new Error("This application has not been submitted.");
  const submittedAt = submittedEvent?.createdAt ?? run?.updatedAt ?? null;

  let approval: ApplicationRecord["approval"];
  if (run) {
    const until = submittedAt ?? now.toISOString();
    const policyEvent = events.filter((event) =>
      event.detail?.startsWith(AUTO_SUBMIT_EVENT) && event.createdAt >= run.createdAt && event.createdAt <= until).at(-1);
    approval = policyEvent?.detail
      ? { kind: "policy", at: policyEvent.createdAt, basis: policyEvent.detail.slice(AUTO_SUBMIT_EVENT.length).replace(/^[:.]\s*/, "") }
      : { kind: "candidate", at: run.submissionApprovedAt };
  } else if (submittedEvent?.detail === MANUAL_DETAIL) {
    approval = { kind: "manual", at: submittedEvent.createdAt };
  } else {
    approval = { kind: "unknown" };
  }

  const standardGrad = stringValue(getCurrentFact(database, LOCAL_CANDIDATE_ID, "graduation_date", { kind: "global" })?.value)
    ?? getCandidate(database, LOCAL_CANDIDATE_ID)?.graduationDate ?? null;
  const alternateGrad = stringValue(getCurrentFact(database, LOCAL_CANDIDATE_ID, "graduation_date", { kind: "application_channel", channel: "handshake_internal" })?.value);
  const alternate = run !== null && profileOfRun(run, posting.source.applicationType) === "transcript";

  let profile: ApplicationRecord["profile"] = null;
  const fields: ApplicationRecord["fields"] = [];
  const leftBlank: string[] = [];
  const attachments: Attachment[] = [];
  const appendFiles: Uint8Array[] = [];

  if (run) {
    const submittedValue = (decision: FillDecision) => run.submittedAnswers?.[decision.fieldId] ?? decision.value;
    // The graduation question's answer is a full date; an education End date
    // month or year ("May", "2028") shares its fact basis but is not that answer.
    const graduationDecision = run.decisions.find((decision) => decision.basis?.kind === "fact" && decision.basis.key === "graduation_date"
      && /^\d{4}-\d{2}-\d{2}$/.test(submittedValue(decision) ?? ""));
    profile = {
      kind: alternate ? "transcript-alternate" : "default",
      graduationDate: alternate ? alternateGrad : standardGrad,
      answeredGraduation: graduationDecision ? submittedValue(graduationDecision) ?? null : null
    };

    const sidecar = readSidecarLabels(dataDir, jobId, run.id);
    const labelOf = (decision: FillDecision) => {
      const recorded = sidecar[decision.fieldId];
      return recorded ? { label: recorded, labelReconstructed: false } : { label: reconstructedLabel(decision, run), labelReconstructed: true };
    };

    // One attachment per distinct file the run uploaded.
    const uploadedAsByKey = new Map<string, string | null>();
    const pending: Array<{ attachment: Attachment; bytes: Uint8Array | null }> = [];
    // Older runs recorded the base resume on the run with variant decisions;
    // a run with base_resume decisions names its uploads per decision, so its
    // variant decisions are printed variants.
    const hasBaseResumeDecision = run.decisions.some((decision) => decision.basis?.kind === "base_resume");
    const legacyBaseResumeId = hasBaseResumeDecision ? null : run.baseResumeId;
    for (const decision of run.decisions) {
      if (decision.action !== "upload" || !decision.basis) continue;
      const basis = decision.basis;
      if (basis.kind === "base_resume" || (basis.kind === "variant" && legacyBaseResumeId)) {
        const id = basis.kind === "base_resume" ? basis.baseResumeId : legacyBaseResumeId ?? "";
        const key = `base:${id}`;
        if (uploadedAsByKey.has(key)) continue;
        const resume = getBaseResume(database, id);
        if (!resume) {
          uploadedAsByKey.set(key, null);
          pending.push({ attachment: { role: "resume", description: "Uploaded base resume (record no longer exists)", uploadedAs: null, sha256: null, byteSize: null, pages: null, appended: false, note: "The base resume record no longer exists." }, bytes: null });
          continue;
        }
        const path = baseResumeFilePath(dataDir, resume.fileName);
        const check = verifiedFile([path], resume.sha256);
        // The site received the checksum-verified copy under the candidate's own file name.
        const uploadedAs = uploadFileName(resume.originalName);
        uploadedAsByKey.set(key, uploadedAs);
        pending.push({
          attachment: {
            role: "resume", description: `Uploaded base resume "${resume.label}" (originally ${resume.originalName})`,
            uploadedAs, sha256: resume.sha256, byteSize: resume.byteSize, pages: null, appended: false, note: check.note
          },
          bytes: check.bytes
        });
      } else if (basis.kind === "variant") {
        const key = `variant:${basis.variantId}`;
        if (uploadedAsByKey.has(key)) continue;
        const grad = alternate ? alternateGrad : null;
        const standard = resumePdfPath(dataDir, jobId, basis.variantId);
        const path = grad ? standard.replace(/\.pdf$/, `-graduating-${grad}.pdf`) : standard;
        const label = getResumeVariant(database, basis.variantId)?.label ?? basis.variantId;
        const description = `Tailored resume "${label}"` + (grad ? ` printed with graduation date ${grad}` : "");
        uploadedAsByKey.set(key, basename(path));
        if (existsSync(path)) {
          const bytes = readFileSync(path);
          pending.push({
            attachment: {
              role: "resume", description, uploadedAs: basename(path), sha256: sha256(bytes), byteSize: bytes.length,
              pages: null, appended: false, note: "Checksum of the printed file on disk when this record was made."
            },
            bytes
          });
        } else {
          pending.push({
            attachment: {
              role: "resume", description, uploadedAs: basename(path), sha256: null, byteSize: null, pages: null, appended: false,
              note: "The printed file is no longer on disk; it was printed from the frozen resume variant above."
            },
            bytes: null
          });
        }
      } else if (basis.kind === "candidate_document") {
        const key = `document:${basis.documentId}`;
        if (uploadedAsByKey.has(key)) continue;
        const document = getCandidateDocument(database, basis.documentId);
        if (!document) {
          uploadedAsByKey.set(key, null);
          pending.push({ attachment: { role: "transcript", description: "Transcript (record no longer exists)", uploadedAs: null, sha256: null, byteSize: null, pages: null, appended: false, note: "The transcript record no longer exists." }, bytes: null });
          continue;
        }
        const check = verifiedFile(documentPaths(dataDir, document.fileName), document.sha256);
        uploadedAsByKey.set(key, document.fileName);
        pending.push({
          attachment: {
            role: "transcript", description: `Transcript "${document.label}" (originally ${document.originalName})`,
            uploadedAs: basename(check.path ?? document.fileName), sha256: document.sha256, byteSize: document.byteSize, pages: null, appended: false, note: check.note
          },
          bytes: check.bytes
        });
      }
    }
    for (const { attachment, bytes } of pending) {
      if (bytes) {
        const pages = await readablePdfPages(bytes);
        if (pages === null) {
          attachment.note = "The PDF could not be read for appending (it may be encrypted).";
        } else {
          attachment.pages = pages;
          attachment.appended = true;
          appendFiles.push(bytes);
        }
      }
      attachments.push(attachment);
    }

    const uploadedAsFor = (decision: FillDecision): string | null => {
      const basis = decision.basis;
      if (!basis) return null;
      if (basis.kind === "base_resume") return uploadedAsByKey.get(`base:${basis.baseResumeId}`) ?? null;
      if (basis.kind === "variant") {
        return (legacyBaseResumeId ? uploadedAsByKey.get(`base:${legacyBaseResumeId}`) : uploadedAsByKey.get(`variant:${basis.variantId}`)) ?? null;
      }
      if (basis.kind === "candidate_document") return uploadedAsByKey.get(`document:${basis.documentId}`) ?? null;
      return null;
    };

    for (const decision of run.decisions) {
      const { label, labelReconstructed } = labelOf(decision);
      let value: string;
      switch (decision.action) {
        case "fill":
        case "choose":
          value = submittedValue(decision) ?? "";
          break;
        case "check": {
          const checked = submittedValue(decision) ?? "";
          value = checked === "true" ? "Checked" : checked;
          break;
        }
        case "upload": {
          const uploadedAs = uploadedAsFor(decision);
          value = uploadedAs ? `Uploaded ${uploadedAs}` : "Uploaded (file not identified)";
          break;
        }
        case "keep":
          value = "Kept the file already attached on the site" + (decision.value ? `: ${decision.value}` : "");
          break;
        case "remove":
          value = "Removed an existing entry" + (decision.value ? `: ${decision.value}` : "");
          break;
        default:
          leftBlank.push(label);
          continue;
      }
      fields.push({ label, labelReconstructed, value, source: sourceOf(decision) });
    }
  }

  const postingText = posting.snapshot.normalizedText;
  const record: ApplicationRecord = {
    jobId,
    runId: run?.id ?? null,
    companyName: posting.companyName,
    title: posting.title,
    postingUrl: posting.source.sourceUrl,
    applicationUrl: run?.applicationUrl ?? null,
    applicationType: posting.source.applicationType,
    atsKind: run?.atsKind ?? null,
    submittedAt,
    generatedAt: now.toISOString(),
    approval,
    profile,
    fields,
    leftBlank,
    attachments,
    confirmation: run?.confirmationText ?? null,
    posting: {
      capturedAt: posting.snapshot.capturedAt,
      text: postingText.slice(0, POSTING_TEXT_LIMIT),
      truncated: postingText.length > POSTING_TEXT_LIMIT
    }
  };
  return { record, appendFiles };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const RECORD_STYLE = `
@page { size: Letter; margin: 0.6in; }
body { font-family: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; color: #111; line-height: 1.4; }
h1 { font-size: 16pt; margin: 0 0 6pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 6pt; border-bottom: 1px solid #999; padding-bottom: 2pt; }
.banner { border: 1px solid #555; padding: 6pt 8pt; margin: 6pt 0 10pt; font-weight: 600; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { text-align: left; vertical-align: top; border: 1px solid #bbb; padding: 3pt 5pt; word-break: break-word; overflow-wrap: anywhere; }
th { background: #eee; }
table.facts th { width: 28%; }
.block { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; border: 1px solid #bbb; padding: 6pt; font-size: 9.5pt; }
.note { font-size: 9pt; color: #333; }
ul { margin: 4pt 0; padding-left: 16pt; }
.attachment { margin: 0 0 8pt; }
`;

export function renderApplicationRecordHtml(record: ApplicationRecord): string {
  const e = escapeHtml;
  const utc = (iso: string) => `${iso} (UTC)`;
  const row = (label: string, value: string) => `<tr><th>${e(label)}</th><td>${e(value)}</td></tr>`;
  const parts: string[] = [];

  parts.push(`<h1>${e(`Application record: ${record.companyName} — ${record.title}`)}</h1>`);
  parts.push(`<div class="banner">${e("Kept on this computer only. This record is never attached to messages or sent anywhere.")}</div>`);

  parts.push("<h2>Application</h2>", '<table class="facts">',
    row("Company", record.companyName),
    row("Role", record.title),
    row("Posting URL", record.postingUrl),
    row("Application URL", record.applicationUrl ?? "Not recorded"),
    row("Application type", record.applicationType),
    row("Site type", record.atsKind ?? "Not recorded"),
    row("Submitted at", record.submittedAt ? utc(record.submittedAt) : "Not recorded"),
    row("Job id", record.jobId),
    row("Run id", record.runId ?? "None"),
    row("Record generated at", utc(record.generatedAt)),
    "</table>");

  parts.push("<h2>Approval</h2>");
  const approval = record.approval;
  if (approval.kind === "policy") {
    parts.push(`<p>${e(`Approved automatically by your auto-submit policy at ${utc(approval.at)}.`)}</p>`);
    parts.push(`<p>${e(`Basis: ${approval.basis}`)}</p>`);
  } else if (approval.kind === "candidate") {
    parts.push(`<p>${e(approval.at ? `Approved by you at ${utc(approval.at)}.` : "Approved by you.")}</p>`);
  } else if (approval.kind === "manual") {
    parts.push(`<p>${e(approval.at ? `You applied yourself, outside the agent (checked off at ${utc(approval.at)}).` : "You applied yourself, outside the agent.")}</p>`);
  } else {
    parts.push(`<p>${e("Submitted; how it was approved is not recorded.")}</p>`);
  }

  parts.push("<h2>Profile used</h2>");
  if (!record.profile) {
    parts.push(`<p>${e("Not known: the agent did not fill this application.")}</p>`);
  } else {
    parts.push(`<p>${e(record.profile.kind === "transcript-alternate" ? "Transcript alternate profile" : "Default profile")}</p>`);
    parts.push("<ul>",
      `<li>${e(`Graduation date for this profile (current saved answer): ${record.profile.graduationDate ?? "not recorded"}`)}</li>`,
      `<li>${e(`Graduation date answered on the form: ${record.profile.answeredGraduation ?? "not asked as a form field"}`)}</li>`,
      "</ul>");
  }

  parts.push("<h2>Form fields as submitted</h2>");
  if (!record.runId) {
    parts.push(`<p>${e("The agent did not fill this form; what was sent is not recorded.")}</p>`);
  } else {
    if (record.fields.length > 0) {
      parts.push('<table><colgroup><col style="width:32%"><col style="width:43%"><col style="width:25%"></colgroup>',
        "<tr><th>Label</th><th>Value</th><th>Source</th></tr>");
      for (const field of record.fields) {
        const label = field.labelReconstructed ? `<em>${e(field.label)}</em>` : e(field.label);
        parts.push(`<tr><td>${label}</td><td>${e(field.value)}</td><td>${e(field.source)}</td></tr>`);
      }
      parts.push("</table>");
    } else {
      parts.push(`<p>${e("No fields were filled.")}</p>`);
    }
    if (record.fields.some((field) => field.labelReconstructed)) {
      parts.push(`<p class="note">${e("Italic labels were not recorded at submission and are reconstructed from the answer's source.")}</p>`);
    }
  }
  if (record.leftBlank.length > 0) parts.push(`<p>${e(`Left blank: ${record.leftBlank.join("; ")}`)}</p>`);

  parts.push("<h2>Attachments</h2>");
  if (record.attachments.length === 0) {
    parts.push(`<p>${e("No files were uploaded by the agent.")}</p>`);
  } else {
    for (const attachment of record.attachments) {
      const lines = [
        `Uploaded as: ${attachment.uploadedAs ?? "not recorded"}`,
        `SHA-256: ${attachment.sha256 ?? "not available"}`
      ];
      if (attachment.byteSize !== null) lines.push(`Size: ${formatBytes(attachment.byteSize)}`);
      if (attachment.pages !== null) lines.push(`Pages: ${attachment.pages}`);
      if (attachment.appended) {
        lines.push("Appended after this record.");
        if (attachment.note) lines.push(attachment.note);
      } else {
        lines.push(`Not appended: ${attachment.note ?? "the file is not available."}`);
      }
      parts.push(`<div class="attachment"><p><strong>${e(attachment.description)}</strong></p><ul>${lines.map((line) => `<li>${e(line)}</li>`).join("")}</ul></div>`);
    }
  }

  parts.push("<h2>Confirmation</h2>");
  parts.push(record.confirmation
    ? `<div class="block">${e(record.confirmation)}</div>`
    : `<p>${e("No confirmation text was recorded.")}</p>`);

  parts.push(`<h2>${e(`Posting text (snapshot captured ${record.posting.capturedAt})`)}</h2>`);
  parts.push(`<div class="block">${e(record.posting.text)}</div>`);
  if (record.posting.truncated) parts.push(`<p class="note">${e("(Truncated to the first 100,000 characters.)")}</p>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(`Application record: ${record.companyName}`)}</title><style>${RECORD_STYLE}</style></head><body>${parts.join("\n")}</body></html>`;
}

/**
 * Writes the record (and, with labels, the sidecar of form labels) for a
 * submitted application, atomically and with mode 600, then logs the
 * timeline event without any path.
 */
export async function saveApplicationRecord(
  input: ApplicationRecordInput,
  options: { renderPdf?: RecordRenderer; now?: Date } = {}
): Promise<{ path: string; pages: number }> {
  const { database, dataDir, jobId } = input;
  if (input.labels && Object.keys(input.labels).length > 0) {
    const run = listBrowserRuns(database, jobId).find((entry) => entry.status === "submitted");
    if (run) writeSidecar(dataDir, jobId, run.id, input.labels);
  }
  const { record, appendFiles } = await buildApplicationRecord(database, dataDir, jobId, options.now);
  const finalPath = applicationRecordPdfPath(dataDir, jobId);
  const directory = dirname(finalPath);
  mkdirSync(directory, { recursive: true });
  const renderTemp = join(directory, `.application-record-${randomUUID()}.render.pdf`);
  const finalTemp = `${finalPath}.${randomUUID()}.tmp`;
  let merged: Uint8Array;
  try {
    await (options.renderPdf ?? renderHtmlToPdf)(renderApplicationRecordHtml(record), renderTemp);
    if (!existsSync(renderTemp)) throw new Error("The record renderer wrote no file.");
    merged = await appendPdfPages(readFileSync(renderTemp), appendFiles);
    writeFileSync(finalTemp, merged, { flag: "wx", mode: 0o600 });
    chmodSync(finalTemp, 0o600);
    renameSync(finalTemp, finalPath);
    chmodSync(finalPath, 0o600);
  } finally {
    rmSync(renderTemp, { force: true });
    rmSync(finalTemp, { force: true });
  }
  const status = getJobPosting(database, jobId)?.status ?? "SUBMITTED";
  logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: `${APPLICATION_RECORD_EVENT} locally.` });
  return { path: finalPath, pages: countPdfPages(merged) };
}

/** saveApplicationRecord that never throws: a failure logs how to retry, without the error or any path. */
export async function saveApplicationRecordQuietly(
  input: ApplicationRecordInput,
  options: { renderPdf?: RecordRenderer } = {}
): Promise<void> {
  try {
    await saveApplicationRecord(input, options);
  } catch {
    try {
      const status = getJobPosting(input.database, input.jobId)?.status ?? "SUBMITTED";
      logApplicationEvent(input.database, {
        jobId: input.jobId, fromStatus: status, toStatus: status,
        detail: `Application record not saved; run pnpm application:record --job ${input.jobId}.`
      });
    } catch {
      // Nothing further: a record never fails anything else.
    }
  }
}

export type ApplicationRecordSelection = { kind: "missing" } | { kind: "all" } | { kind: "job"; jobId: string };

export type ApplicationRecordResult = {
  jobId: string;
  companyName: string | null;
  title: string | null;
  status: "saved" | "skipped" | "failed";
  detail: string;
};

/** (Re)writes the records of submitted applications, one at a time. */
export async function regenerateApplicationRecords(options: {
  database: DatabaseSync; dataDir: string; select: ApplicationRecordSelection; renderPdf?: RecordRenderer;
}): Promise<ApplicationRecordResult[]> {
  const { database, dataDir, select } = options;
  const submitted = listSubmittedJobIds(database);
  const jobIds = select.kind === "job" ? [select.jobId] : submitted;
  const results: ApplicationRecordResult[] = [];
  for (const jobId of jobIds) {
    const posting = getJobPosting(database, jobId);
    const base = { jobId, companyName: posting?.companyName ?? null, title: posting?.title ?? null };
    if (select.kind === "job" && !submitted.includes(jobId) && !listBrowserRuns(database, jobId).some((run) => run.status === "submitted")) {
      results.push({ ...base, status: "failed", detail: "This application has not been submitted." });
      continue;
    }
    if (select.kind === "missing" && existsSync(applicationRecordPdfPath(dataDir, jobId))) {
      results.push({ ...base, status: "skipped", detail: "Record already exists." });
      continue;
    }
    try {
      const { path, pages } = await saveApplicationRecord({ database, dataDir, jobId }, { renderPdf: options.renderPdf });
      results.push({ ...base, status: "saved", detail: `${relative(dataDir, path)} (${pages} pages)` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...base, status: "failed", detail: message.split(dataDir).join("<data dir>") });
    }
  }
  return results;
}
