import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page } from "playwright-core";
import { ZodError } from "zod";

import {
  getBaseResume,
  getBrowserRun,
  getCandidate,
  getCurrentFact,
  getCurrentPackage,
  getDatabase,
  getJobPosting,
  getResumeVariantDocument,
  getResumeVariantMarkdown,
  listBrowserRuns,
  listResumeEntries,
  listResumeVariants,
  LOCAL_CANDIDATE_ID,
  logApplicationEvent,
  saveBrowserRun,
  saveQuestionAnswer,
  setJobStatus,
  updateBrowserRun,
  type CurrentPackage
} from "@internship-agent/db";
import {
  absentDecisionFields,
  applicationWallKind,
  applicationWallReason,
  applyDecisions,
  atsFlowFor,
  capturePostSubmitEvidence,
  challengePause,
  choicesNotTaken,
  classifyAts,
  classifyFieldRole,
  createApplicationPage,
  createWorkdayPage,
  formChangedPause,
  hasApplicationFields,
  hasIcimsSteps,
  hasJobviteConsent,
  hasSiteNavigation,
  hasStepButtons,
  icimsHostOf,
  hasTranscriptField,
  invalidFieldPauses,
  isHandshakeHost,
  isSensitiveRole,
  matchSelfIdentificationOption,
  multiStepStopReason,
  planAutofill,
  securityCodePause,
  postSubmitEvidenceOf,
  recognizeCurrentForm,
  resolveDataDir,
  renderHtmlToPdf,
  resumePdfPath,
  shouldRunHeadless,
  siteWallReason,
  submitAndConfirm,
  SubmissionChallenged,
  SubmissionCodeNotFound,
  SubmissionHeld,
  SubmissionNeedsInput,
  unfilledPause,
  type BrowserPage,
  type EducationInputs,
  type FieldResolution,
  type IcimsAccountSteps,
  type PlannerInputs,
  type PostSubmitEvidence,
  type UnfilledField,
  type VisibleChallenge,
  type WorkdayPage,
  type WorkdayWalkResult
} from "@internship-agent/browser";
import {
  answerKindFor,
  applicationChannelFor,
  AUTO_SUBMIT_EVENT,
  autoSubmitBlockers,
  factDefinitions,
  isWorkdayErrorPauseId,
  manualOnly,
  parseWorkdayUrl,
  planApplicationHistory,
  scopeKey,
  standingConsentSettings,
  type StandingConsentSettings
} from "@internship-agent/domain";
import type {
  ApplicationChannel,
  ApplicationProfile,
  ApplicationType,
  AtsKind,
  BaseResume,
  BrowserRun,
  FillDecision,
  JobPosting,
  PauseRecord,
  QuestionContext,
  RecognizedForm
} from "@internship-agent/domain";
import { renderResumeDocumentHtml, renderResumeHtml } from "@internship-agent/resume";

import {
  currentCandidateDocument,
  stageBaseResumeForUpload,
  uploadedResumeFor,
  verifiedCandidateDocumentPath
} from "./base-resume-service";
import { saveApplicationRecordQuietly, type ApplicationRecordWriter } from "./application-record";
import { answerCandidateQuestion, resolveCandidateQuestion } from "./candidate-service";
import { companyStanding, profileLabel, yearHoldMessage } from "./company-policy";
import { gmailMailboxFactory } from "./gmail-mailbox";
import { greenhouseSecurityCodeLookup } from "./greenhouse-security-code";
import { passOracleEmailStep, type OracleEmailStepSettings } from "./oracle-email-step";
import { assertHandshakeSignedIn } from "./handshake-session-service";
import { applyVoiceDrafts, createDefaultVoiceDrafter, draftSourcesFor, type VoiceDrafter } from "./voice-drafting";
import { AutomaticRunStopped, IcimsAccountHeld, WorkdayAccountHeld } from "./run-errors";
import { postingLocationNames, postingQuestionContext, savedSelfIdentification } from "./saved-answers";
import { saveIcimsEvidenceQuietly, savePostSubmitEvidenceQuietly, saveWorkdayEvidenceQuietly } from "./submit-evidence";
import { ensureIcimsAccount, type IcimsAccountRuntime } from "./icims-account-service";
import { getIcimsAccount } from "./icims-account-store";
import { acceptJobviteConsentStep, logStandingAcceptances, standingPlannerInputs } from "./standing-consent";
import {
  answerForPause,
  answeredPauseDecision,
  pauseAnswerEventDetail,
  planPauseMemory,
  rememberedAnswerFor,
  usedOnce,
  type PauseAnswerOutcome
} from "./question-answers";
import { blockedPause, walkWorkday, WorkdaySignInRequired, type WorkdayRunContext } from "./workday-run";
import type { WorkdayAccountRuntime } from "./workday-account-service";
import { getWorkdayAccount } from "./workday-account-store";
import type { VerificationMailboxFactory } from "./workday-verification-mail";

export type PageFactory = (url: string) => Promise<BrowserPage>;

export { AutomaticRunStopped } from "./run-errors";
export { WorkdayAccountHeld } from "./run-errors";
export { IcimsAccountHeld } from "./run-errors";

/**
 * Where the application form lives: Lever and Ashby host it on a sibling
 * path of the posting; the others show it on the posting or behind its
 * Apply button.
 */
export function applicationUrlFor(source: { externalApplicationUrl?: string | null; companyCareersUrl?: string | null; sourceUrl?: string | null }): string | null {
  const url = source.externalApplicationUrl ?? source.companyCareersUrl ?? source.sourceUrl ?? null;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "jobs.lever.co" && parts.length === 2) return `https://jobs.lever.co/${parts[0]}/${parts[1]}/apply`;
    if (parsed.hostname === "jobs.ashbyhq.com" && parts.length === 2) return `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}/application`;
  } catch {
    return url;
  }
  return url;
}

/** Prints resume HTML to a PDF file and reports its page count; tests pass a stub. */
export type PdfRenderer = (html: string, outputPath: string) => Promise<{ pages: number }>;

export type RunReport = {
  run: BrowserRun;
  form: RecognizedForm;
  applied: number;
};

/**
 * A run may start from an approved package, or again after the latest run
 * failed or was cancelled, as long as no run was ever submitted (or is
 * mid-submission): a retry can never double-apply.
 */
function startBlocker(database: DatabaseSync, jobId: string, status: string, automatic = false): string | null {
  if (status === "APPROVED") return null;
  // An automatic run stands in for the package approval; the candidate's
  // approval at the submit step is then the only human gate.
  if (automatic && status === "READY_FOR_REVIEW") return null;
  if (status === "APPLYING") {
    const runs = listBrowserRuns(database, jobId);
    if (runs.some((run) => run.status === "submitted" || run.status === "submitting")) {
      return "This application already has a submitted run.";
    }
    if (runs[0] && (runs[0].status === "failed" || runs[0].status === "cancelled")) return null;
    return "A browser run for this application is still open; continue or cancel it first.";
  }
  return `Browser runs start only from approved packages; this posting is ${status.toLocaleLowerCase("en-US").replace(/_/g, " ")}.`;
}

export function canStartBrowserRun(jobId: string, database: DatabaseSync = getDatabase()): boolean {
  const posting = getJobPosting(database, jobId);
  return posting !== null && startBlocker(database, jobId, posting.status) === null;
}

function requireApprovedPackage(database: DatabaseSync, jobId: string, automatic = false) {
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown.");
  const blocker = startBlocker(database, jobId, posting.status, automatic);
  if (blocker) throw new Error(blocker);
  const current = getCurrentPackage(database, jobId);
  if (!current?.verification || current.verification.blocked) {
    throw new Error("Browser runs start only from verified packages.");
  }
  const variant = listResumeVariants(database, jobId)[0];
  if (!variant) throw new Error("Browser runs need a resume variant; prepare the application first.");
  return { posting, current, variant };
}

async function defaultOpenPage(url: string, dataDir: string): Promise<BrowserPage> {
  // The Playwright page plus iCIMS's account steps and Jobvite's consent step (taken only when their settings are on).
  return openProfilePage(url, dataDir, createApplicationPage);
}

async function openProfilePage<T extends BrowserPage>(url: string, dataDir: string, adapt: (page: Page) => T): Promise<T> {
  mkdirSync(join(dataDir, "browser-profile"), { recursive: true });
  const context = await chromium.launchPersistentContext(join(dataDir, "browser-profile"), {
    // Visible by default: real runs look like the candidate's own browser.
    headless: shouldRunHeadless(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await context.newPage();
  await page.goto(url);
  const adapter = adapt(page);
  const closePage = adapter.close.bind(adapter);
  adapter.close = async () => {
    await closePage();
    await context.close();
  };
  return adapter;
}

/**
 * The candidate's alternate (2029) application profile applies to
 * Handshake Quick Apply / Apply runs and to any run whose form asks for a
 * transcript: the 2029 resume, the transcript, and 2029 graduation answers
 * travel together so the application stays consistent.
 */
function runChannel(applicationType: ApplicationType | undefined, transcriptRequired: boolean): ApplicationChannel | null {
  return applicationChannelFor(applicationType) ?? (transcriptRequired ? "handshake_internal" : null);
}

function questionContextFor(channel: ApplicationChannel | null): QuestionContext {
  return channel ? { applicationChannel: channel } : {};
}

function usesTranscript(decisions: FillDecision[]): boolean {
  return decisions.some((decision) => decision.basis?.kind === "candidate_document");
}

function uploadedResumeReason(resume: BaseResume, profile: ApplicationProfile): string {
  return `Uploads your uploaded ${profile === "transcript" ? "2029 " : ""}resume "${resume.label}" byte for byte (PDF, checksum-verified).`;
}

/** Every resume upload sends the candidate's uploaded resume for the profile, when there is one; nothing is printed. */
function withUploadedResume(decisions: FillDecision[], resume: BaseResume | null, profile: ApplicationProfile): FillDecision[] {
  if (!resume) return decisions;
  return decisions.map((decision): FillDecision => decision.action === "upload" && decision.basis?.kind === "variant"
    ? { ...decision, basis: { kind: "base_resume", baseResumeId: resume.id }, reason: uploadedResumeReason(resume, profile) }
    : decision);
}

/**
 * Each field the page would not take (applyDecisions' `unfilled`) becomes a
 * pause in place of its decision: the run waits for the candidate instead of
 * stopping on a timeout.
 */
function pauseUnfilled(
  form: RecognizedForm,
  decisions: FillDecision[],
  pauses: PauseRecord[],
  unfilled: UnfilledField[]
): { decisions: FillDecision[]; pauses: PauseRecord[] } {
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  let nextDecisions = decisions;
  let nextPauses = pauses;
  for (const entry of unfilled) {
    const field = fields.get(entry.fieldId);
    if (!field) continue;
    const held = unfilledPause(field, entry.reason);
    nextDecisions = nextDecisions.map((decision) => (decision.fieldId === entry.fieldId ? held.decision : decision));
    nextPauses = [...nextPauses.filter((pause) => pause.fieldId !== entry.fieldId), held.pause];
  }
  return { decisions: nextDecisions, pauses: nextPauses };
}

/** The uploaded resume a run's decisions send, if any. */
function uploadedBaseResumeId(decisions: FillDecision[]): string | null {
  for (const decision of decisions) {
    if (decision.action === "upload" && decision.basis?.kind === "base_resume") return decision.basis.baseResumeId;
  }
  return null;
}

/**
 * Resolves every upload decision to a file, each from its own basis.
 * Transcript fields get the stored transcript; a `base_resume` upload gets a
 * checksum-verified copy of the candidate's uploaded resume (still its
 * channel's current upload) under its own file name; a `variant` upload gets
 * the verified variant rendered to PDF, printed only when some upload needs
 * it. Every candidate file is checked before anything is printed.
 */
async function prepareUploads(
  database: DatabaseSync,
  dataDir: string,
  source: ResumeSource,
  decisions: FillDecision[],
  renderPdf: PdfRenderer
): Promise<(decision: FillDecision) => string | null> {
  const uploads = decisions.filter((decision) => decision.action === "upload");
  if (uploads.length === 0) return () => null;
  const documentPaths = new Map<string, string>();
  for (const decision of uploads) {
    if (decision.basis?.kind === "candidate_document" && !documentPaths.has(decision.basis.documentId)) {
      documentPaths.set(decision.basis.documentId, verifiedCandidateDocumentPath(database, dataDir, decision.basis.documentId));
    }
  }
  const baseResumePaths = new Map<string, string>();
  for (const decision of uploads) {
    if (decision.basis?.kind === "base_resume" && !baseResumePaths.has(decision.basis.baseResumeId)) {
      baseResumePaths.set(decision.basis.baseResumeId, stageBaseResumeForUpload(database, dataDir, source.jobId, decision.basis.baseResumeId));
    }
  }
  const needsVariant = uploads.some((decision) => decision.basis?.kind === "variant");
  const variantPath = needsVariant ? await prepareResumePath(database, dataDir, source, renderPdf) : null;
  return (decision) => {
    if (decision.action !== "upload") return null;
    if (decision.basis?.kind === "candidate_document") return documentPaths.get(decision.basis.documentId) ?? null;
    if (decision.basis?.kind === "base_resume") return baseResumePaths.get(decision.basis.baseResumeId) ?? null;
    return variantPath;
  };
}

/** The graduation answer the 2029 profile uses; the tailored resume prints it on that profile. */
function alternateGraduationDate(database: DatabaseSync, candidateId = LOCAL_CANDIDATE_ID): string | null {
  const value = getCurrentFact(database, candidateId, "graduation_date", { kind: "application_channel", channel: "handshake_internal" })?.value;
  return typeof value === "string" ? value : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The graduation date a run's education end month and year come from, and
 * its basis: on the transcript profile only its own 2029 answer (never the
 * default date); on the default profile the global answer, else the profile's
 * graduation date. Absent when that profile has none, so the fields pause.
 */
function runGraduation(
  database: DatabaseSync,
  candidateId: string,
  profile: ApplicationProfile,
  candidate: ReturnType<typeof getCandidate>
): EducationInputs["graduation"] {
  if (profile === "transcript") {
    const scope = { kind: "application_channel" as const, channel: "handshake_internal" as const };
    const value = getCurrentFact(database, candidateId, "graduation_date", scope)?.value;
    return typeof value === "string" && ISO_DATE.test(value)
      ? { date: value, basis: { kind: "fact", key: "graduation_date", scope: scopeKey(scope) } }
      : undefined;
  }
  const value = getCurrentFact(database, candidateId, "graduation_date", { kind: "global" })?.value;
  if (typeof value === "string" && ISO_DATE.test(value)) return { date: value, basis: { kind: "fact", key: "graduation_date", scope: "global" } };
  const date = candidate?.graduationDate;
  return date && ISO_DATE.test(date) ? { date, basis: { kind: "profile", field: "graduationDate" } } : undefined;
}

type ResumeSource = {
  jobId: string;
  variantId: string | null;
  channel: ApplicationChannel | null;
  /** Prints the tailored resume with this graduation date (a Workday form that asked for a transcript). */
  graduationDate?: string | null;
};

async function prepareResumePath(
  database: DatabaseSync,
  dataDir: string,
  source: ResumeSource,
  renderPdf: PdfRenderer
): Promise<string | null> {
  // The generated variant, printed only when the run sends no uploaded resume
  // (see withUploadedResume / uploadedResumeFor). The 2029 profile (Handshake
  // Quick Apply / Apply, or a form asking for a transcript) prints it with the
  // candidate's 2029 graduation answer, as Workday does. Its one-page limit
  // applies only to this generated print.
  if (!source.variantId) return null;
  const graduationDate = source.graduationDate ?? (source.channel === "handshake_internal" ? alternateGraduationDate(database) : null);
  if (source.channel === "handshake_internal" && !graduationDate) {
    throw new Error("This application uses your 2029 profile (Handshake Quick Apply / Apply, or a form that asks for a transcript), and no 2029 graduation date is recorded. Answer the graduation question for the 2029 profile in candidate memory, then start the run again.");
  }
  const printed = await printResumeVariant(database, dataDir, source.jobId, source.variantId, renderPdf, graduationDate);
  if (!printed) return null;
  if (printed.pages > 1) {
    throw new Error(`The generated resume runs to ${printed.pages} pages. Trim or archive entries on the Resume page, then prepare the application again.`);
  }
  return printed.path;
}

/**
 * Prints a frozen resume variant exactly as an upload would: structured
 * variants from their document, older variants from their markdown snapshot.
 */
export async function printResumeVariant(
  database: DatabaseSync,
  dataDir: string,
  jobId: string,
  variantId: string,
  renderPdf: PdfRenderer = renderHtmlToPdf,
  graduationDate: string | null = null
): Promise<{ path: string; pages: number } | null> {
  const frozen = getResumeVariantDocument(database, variantId);
  const markdown = frozen ? null : getResumeVariantMarkdown(database, variantId);
  if (!frozen && !markdown) return null;
  if (graduationDate && !frozen?.education) {
    throw new Error("This resume has no structured education line, so its graduation year cannot change to match the transcript. Prepare the application again.");
  }
  // Only the graduation date changes: the candidate's own alternate answer.
  const document = frozen && graduationDate && frozen.education
    ? { ...frozen, education: { ...frozen.education, graduationDate } }
    : frozen;
  const standard = resumePdfPath(resolveDataDir(dataDir), jobId, variantId);
  const path = graduationDate ? standard.replace(/\.pdf$/, `-graduating-${graduationDate}.pdf`) : standard;
  const { pages } = await renderPdf(document ? renderResumeDocumentHtml(document) : renderResumeHtml(markdown ?? ""), path);
  return { path, pages };
}

export type ResumeVariantUse = { variantId: string; label: string; used: boolean };

/**
 * Which resume an application actually sends, per variant. Browser runs
 * record the truth (the candidate's uploaded resume, or the variant they
 * printed); before any run, a posting is known to send the candidate's
 * uploaded resume for its expected profile when one is stored (the 2029
 * resume on Handshake Quick Apply / Apply, the default one elsewhere, the
 * 2029 one if the form turns out to ask for a transcript), and otherwise the
 * newest variant.
 */
export function getResumeVariantUsage(jobId: string, database: DatabaseSync = getDatabase()): ResumeVariantUse[] {
  const variants = listResumeVariants(database, jobId);
  const runs = listBrowserRuns(database, jobId).filter((run) => run.status !== "cancelled");
  const applicationType = getJobPosting(database, jobId)?.source.applicationType;
  const uploadedResume = (run: BrowserRun) => run.decisions.some((decision) =>
    (decision.action === "upload" || decision.action === "keep")
    && (decision.basis?.kind === "variant" || decision.basis?.kind === "base_resume"));
  const named = (resume: BaseResume) => `your uploaded ${resume.channel === "handshake_internal" ? "2029 " : ""}resume "${resume.label}"`;
  const printedVariant = (run: BrowserRun) => run.decisions.some((decision) => decision.action === "upload" && decision.basis?.kind === "variant");
  const uploadedDefault = uploadedResumeFor("default", database);
  const uploaded2029 = uploadedResumeFor("transcript", database);
  return variants.map((variant, index) => {
    const run = runs.find((entry) => entry.variantId === variant.id);
    if (run) {
      if (run.baseResumeId && !printedVariant(run)) {
        const sent = getBaseResume(database, run.baseResumeId);
        return {
          variantId: variant.id,
          label: `Not used: this application ${run.status === "submitted" ? "sent" : "sends"} ${sent ? named(sent) : "your uploaded resume"}`,
          used: false
        };
      }
      if (run.decisions.some((decision) => decision.fieldId === ATTACHED_RESUME_FIELD && decision.action === "keep")) {
        return { variantId: variant.id, label: "Not used: Handshake Quick Apply sends the resume on your Handshake account", used: false };
      }
      if (!uploadedResume(run)) return { variantId: variant.id, label: "Not used: the application form asked for no resume upload", used: false };
      if (run.status === "submitted") return { variantId: variant.id, label: "Uploaded with the submitted application", used: true };
      return { variantId: variant.id, label: "Used by the current browser run", used: true };
    }
    if (index > 0) return { variantId: variant.id, label: "Earlier preparation, not used", used: false };
    if (applicationChannelFor(applicationType) === "handshake_internal") {
      if (uploaded2029) {
        return {
          variantId: variant.id,
          label: `Not used: Handshake uploads send ${named(uploaded2029)}; Quick Apply keeps your Handshake resume once you confirm it`,
          used: false
        };
      }
      return {
        variantId: variant.id,
        label: "Printed with your 2029 graduation date if Handshake asks for an upload; Quick Apply keeps your Handshake resume once you confirm it",
        used: true
      };
    }
    if (uploadedDefault) {
      return {
        variantId: variant.id,
        label: `Not used: this application will send ${named(uploadedDefault)} (${uploaded2029 ? `or ${named(uploaded2029)}` : "the tailored resume printed with your 2029 graduation date"} if the form asks for a transcript)`,
        used: false
      };
    }
    if (uploaded2029) {
      return {
        variantId: variant.id,
        label: `Will be uploaded as a PDF (${named(uploaded2029)} goes instead if the form asks for a transcript)`,
        used: true
      };
    }
    return {
      variantId: variant.id,
      label: "Will be uploaded as a PDF (printed with your 2029 graduation date if the form asks for a transcript)",
      used: true
    };
  });
}

/**
 * Handshake Quick Apply / Apply runs happen inside the "Apply to …" dialog:
 * open it before reading or filling anything. A Handshake-internal posting
 * without a Quick apply button stops the run instead of guessing.
 */
async function enterHandshakeDialog(page: BrowserPage, applicationType: ApplicationType | undefined): Promise<boolean> {
  if (applicationType !== "HANDSHAKE_INTERNAL" || !isHandshakeHost(new URL(page.url()).hostname)) return false;
  if (!page.openApplicationDialog) return false;
  if (!(await page.openApplicationDialog())) {
    throw new Error("This Handshake posting shows no Quick apply button, so the run stopped. Apply on Handshake yourself.");
  }
  return true;
}

/** Whether the page is on Handshake (an unreadable address counts as Handshake, so nothing is followed). */
function onHandshakeHost(url: string): boolean {
  try {
    return isHandshakeHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

export const ATTACHED_RESUME_FIELD = "handshake-attached-resume";

/**
 * The Quick apply dialog attaches the resume stored on the candidate's
 * Handshake account; the agent never removes or replaces it. The run keeps it
 * only after the candidate confirms it is their current resume, so it pauses
 * with that question.
 */
async function attachedResumeCheck(page: BrowserPage): Promise<{ decision: FillDecision; pause: PauseRecord } | null> {
  const names = page.attachedDocumentNames ? await page.attachedDocumentNames() : [];
  if (names.length === 0) return null;
  const listed = names.join('", "');
  return {
    decision: {
      fieldId: ATTACHED_RESUME_FIELD,
      action: "keep",
      value: names.join("\n"),
      basis: null,
      reason: `Keeps the resume Handshake attached from your Handshake account ("${listed}") once you confirm it is current.`,
      pause: null
    },
    pause: {
      fieldId: ATTACHED_RESUME_FIELD,
      label: "Resume Handshake attached",
      question: `Handshake attached "${listed}" from your Handshake account. Is it your current resume? Answer yes to keep it; if not, update your resume on Handshake and start a new run.`,
      suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false, upload: false, status: "open", answer: null, draft: null
    }
  };
}

/** The attachment the candidate confirmed must still be exactly what the dialog shows. */
async function assertKeptAttachment(page: BrowserPage, decisions: FillDecision[]): Promise<void> {
  const kept = decisions.find((decision) => decision.fieldId === ATTACHED_RESUME_FIELD && decision.action === "keep");
  if (!kept?.value) return;
  const expected = kept.value.split("\n");
  const names = page.attachedDocumentNames ? await page.attachedDocumentNames() : [];
  if (names.length !== expected.length || !expected.every((name) => names.includes(name))) {
    throw new Error(`The attached resume changed since you confirmed it (expected "${expected.join('", "')}"). Start a new run.`);
  }
}

/** Decisions that act on the page or ask the candidate: a run with none of them never reached an application form. */
const ACTED = new Set(["fill", "choose", "check", "upload", "keep", "pause"]);

function reachedApplicationForm(decisions: FillDecision[]): boolean {
  return decisions.some((decision) => ACTED.has(decision.action));
}

function noFormReachedReason(url: string): string {
  return `No application form was reached at ${url}: the page shows no question the agent can fill or ask you about. It may sit behind an Apply button or a step the agent cannot take; start the run yourself from the form's address.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

async function resolveFields(
  form: RecognizedForm,
  database: DatabaseSync,
  context: QuestionContext
): Promise<Map<string, FieldResolution>> {
  const resolutions = new Map<string, FieldResolution>();
  const selfIdentification = savedSelfIdentification(database, LOCAL_CANDIDATE_ID);
  for (const field of form.fields) {
    if (["email", "tel", "file", "unknown"].includes(field.kind)) {
      resolutions.set(field.id, { status: "UNAVAILABLE" });
      continue;
    }
    if (isSensitiveRole(classifyFieldRole(field))) {
      const saved = matchSelfIdentificationOption(field, selfIdentification);
      resolutions.set(field.id, saved ? { status: "SELF_IDENTIFIED", key: saved.key, option: saved.option } : { status: "UNAVAILABLE" });
      continue;
    }
    const resolution = await resolveCandidateQuestion(field.label, { ...context, fieldKind: field.kind }, { database });
    if (resolution.status === "RESOLVED" && resolution.fact) {
      resolutions.set(field.id, {
        status: "RESOLVED",
        key: resolution.fact.key,
        scope: scopeKey(resolution.fact.scope),
        display: resolution.displayAnswer,
        value: resolution.fact.value as boolean | string
      });
    } else if (resolution.status === "NEEDS_INPUT" && resolution.mapping) {
      resolutions.set(field.id, {
        status: "NEEDS_INPUT",
        key: resolution.mapping.key,
        scope: scopeKey(resolution.mapping.scope)
      });
    } else if (resolution.status === "UNMAPPED") {
      // Catalog facts first; question memory only for questions the catalog does not map.
      const saved = rememberedAnswerFor(database, LOCAL_CANDIDATE_ID, field, context.companyName ?? null);
      resolutions.set(field.id, saved
        ? { status: "REMEMBERED_ANSWER", answerId: saved.id, answer: saved.answer, answerKey: saved.answerKey, answerKind: saved.answerKind }
        : { status: "UNAVAILABLE" });
    } else {
      // The catalog recognized the question, but nothing saved answers it (needs confirmation, ambiguous, no saved fact for the mapping).
      resolutions.set(field.id, { status: "UNAVAILABLE", held: true });
    }
  }
  return resolutions;
}

/** The planner's inputs for a run: profile contact and education, package answers, standing settings, and the posting's places. */
function plannerInputsFor(database: DatabaseSync, candidateId: string, candidate: ReturnType<typeof getCandidate>, input: {
  resolutions: Map<string, FieldResolution>;
  packageAnswers: Array<{ prompt: string; text: string }>;
  variantId: string | null;
  transcriptDocumentId: string | null;
  profile: ApplicationProfile;
  standing: StandingConsentSettings;
  postingLocations: string[];
}): PlannerInputs {
  return {
    profile: {
      email: candidate?.email,
      phone: candidate?.phone,
      portfolioUrl: candidate?.portfolioUrl,
      fullName: candidate?.fullName,
      preferredName: candidate?.preferredName,
      linkedinUrl: candidate?.linkedinUrl,
      githubUrl: candidate?.githubUrl,
      legalFirstName: candidate?.legalFirstName,
      legalLastName: candidate?.legalLastName,
      addressLine1: candidate?.addressLine1,
      addressLine2: candidate?.addressLine2,
      addressCity: candidate?.addressCity,
      addressRegion: candidate?.addressRegion,
      addressPostalCode: candidate?.addressPostalCode,
      addressCountry: candidate?.addressCountry,
      phoneType: candidate?.phoneType,
      fieldOfStudy: candidate?.fieldOfStudy,
      gpa: candidate?.gpa
    },
    resolutions: input.resolutions,
    packageAnswers: input.packageAnswers,
    variantId: input.variantId,
    transcriptDocumentId: input.transcriptDocumentId,
    education: {
      school: candidate?.school,
      degree: candidate?.degree,
      startMonth: candidate?.educationStartMonth,
      graduation: runGraduation(database, candidateId, input.profile, candidate)
    },
    standing: standingPlannerInputs(candidate, input.standing),
    postingLocations: input.postingLocations
  };
}

/** The run's own package answers for planning its pauses again; none when the current package is another one or cannot be read. */
function runPackageAnswers(database: DatabaseSync, run: BrowserRun): Array<{ prompt: string; text: string }> {
  try {
    const current = getCurrentPackage(database, run.jobId);
    return current && current.package.id === run.packageId ? current.package.answers.map(({ prompt, text }) => ({ prompt, text })) : [];
  } catch {
    return [];
  }
}

/**
 * The Milestone 7 orchestration seam. Runs advance through explicit,
 * auditable steps — start, answer pauses, continue, approve submission,
 * submit — and every step re-opens the candidate's own persistent browser
 * session rather than holding a daemon. Submission is impossible without a
 * recorded human approval, and safeguard pauses can never be answered
 * through.
 */
export async function startBrowserRun(
  jobId: string,
  applicationUrl: string,
  options: {
    database?: DatabaseSync;
    candidateId?: string;
    dataDir?: string;
    openPage?: PageFactory;
    renderPdf?: PdfRenderer;
    /** Started by the pipeline from a verified package, without a package approval. */
    automatic?: boolean;
    /** Drafts open-ended answers in the candidate's voice; null disables drafting. */
    voiceDrafter?: VoiceDrafter | null;
    /** Workday account automation; used by automatic runs only, which may create an account. */
    workdayAccounts?: WorkdayAccountRuntime | null;
    /** The graduation profile earlier applications to this company used (automatic runs only); the run keeps to it or is held. */
    companyProfile?: ApplicationProfile | null;
    /** The candidate's standing consent and attestation settings; default from INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT and INTERNSHIP_AGENT_SIGN_ATTESTATIONS. */
    standingConsent?: StandingConsentSettings;
    /** iCIMS account automation; used by automatic runs only, which may create an account. */
    icimsAccounts?: IcimsAccountRuntime | null;
    /** Oracle Cloud HCM's email and one-time-code step: the mailbox it reads and its address. Default from INTERNSHIP_AGENT_GMAIL_*; null never takes the step (the email-step stop stays). */
    oracleEmailStep?: OracleEmailStepSettings | null;
  } = {}
): Promise<RunReport> {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const automatic = options.automatic === true;
  const standing = options.standingConsent ?? standingConsentSettings(process.env);
  const { posting, current, variant } = requireApprovedPackage(database, jobId, automatic);
  // Automatic runs keep to the profile the company already saw; candidate-started runs are only warned.
  const lock = automatic ? options.companyProfile ?? null : null;
  const manualPin = automatic ? null : companyStanding(database, jobId)?.profile ?? null;
  if (lock === "transcript" && !alternateGraduationDate(database, candidateId)) {
    throw new AutomaticRunStopped(`${posting.companyName} already received your transcript profile, and no 2029 graduation date is recorded. Answer the graduation question for the 2029 profile in candidate memory, then start the run again.`);
  }
  const dataDir = resolveDataDir(options.dataDir);
  const openPage = options.openPage ?? ((url: string) => defaultOpenPage(url, dataDir));
  const renderPdf = options.renderPdf ?? renderHtmlToPdf;
  if (parseWorkdayUrl(applicationUrl)) {
    const report = await startWorkdayRun(database, { jobId, candidateId, applicationUrl, posting, current, variantId: variant.id, automatic, lock }, {
      dataDir, openPage: options.openPage, renderPdf, voiceDrafter: options.voiceDrafter,
      account: automatic && options.workdayAccounts ? { runtime: options.workdayAccounts, mode: "create" } : null, standing
    });
    noteMixedProfile(database, report.run, posting.companyName, candidateId, manualPin);
    return report;
  }

  const candidate = getCandidate(database, candidateId);
  const page = await openPage(applicationUrl);
  try {
    // A signed-out Handshake session stops before anything changes.
    assertHandshakeSignedIn(database, page.url());
    const inDialog = await enterHandshakeDialog(page, posting.source.applicationType);
    let form = await recognizeCurrentForm(page);
    let formUrl = applicationUrl;
    // A posting page with no form: follow its own Apply entry once (never on
    // Handshake, whose Quick apply dialog is enterHandshakeDialog's job), and
    // save the form's address, so continue and submit reopen the form itself.
    if (!inDialog && page.followApplyEntry && !form.fields.some((field) => field.kind !== "unknown") && !onHandshakeHost(page.url())) {
      const reached = await page.followApplyEntry();
      if (reached) {
        form = await recognizeCurrentForm(page);
        formUrl = reached;
      }
    }
    // A site with no adapter: walk on toward its form (reject cookies, then
    // guest, Apply, manual, or continue entries; at most four, never sign-in,
    // account creation, or a submit), and save the address the walk reached.
    if (!inDialog && !onHandshakeHost(page.url()) && hasSiteNavigation(page) && !hasApplicationFields(form.fields)) {
      const outcome = await page.advanceToApplicationForm();
      if (outcome.moved) {
        form = await recognizeCurrentForm(page);
        formUrl = outcome.url;
      }
    }
    // iCIMS's account step and Jobvite's data-consent step: taken only when
    // their settings are on (Jobvite's on any run, iCIMS's on automatic runs);
    // otherwise never typed into.
    const body = await page.bodyText();
    const wallKind = applicationWallKind(page.url(), body);
    if (wallKind === "jobvite-consent" && standing.acceptDataConsent && hasJobviteConsent(page)) {
      const stop = await acceptJobviteConsentStep(database, page, { jobId, country: candidate?.addressCountry });
      if (stop) {
        if (automatic) throw new AutomaticRunStopped(stop);
        throw new Error(stop);
      }
      form = await recognizeCurrentForm(page);
    } else if (wallKind === "icims-account" && automatic && options.icimsAccounts && hasIcimsSteps(page)) {
      await runIcimsAccountStep(database, page, {
        jobId, dataDir, company: posting.companyName, candidate, runtime: options.icimsAccounts, acceptDataConsent: standing.acceptDataConsent
      });
    } else {
      const wall = applicationWallReason(page.url(), body);
      if (wall) {
        if (automatic) throw new AutomaticRunStopped(wall);
        throw new Error(wall);
      }
    }
    // Oracle Cloud HCM's email step: the saved email typed, its terms box accepted only under the standing settings, and an emailed one-time code read from the candidate's own mailbox (oracle-email-step.ts). The saved address stays the email step's, so continue and submit take it again.
    const oracle = await passOracleEmailStep(database, page, form, { jobId, company: posting.companyName, candidateEmail: candidate?.email, standing, settings: options.oracleEmailStep });
    if (oracle.kind === "stopped") throw automatic ? new AutomaticRunStopped(oracle.reason) : new Error(oracle.reason);
    if (oracle.kind === "passed") form = oracle.form;
    // A step no adapter takes (Oracle's email step on a page without its steps): named before anything is typed.
    const siteWall = siteWallReason(page.url(), form.fields);
    if (siteWall) throw automatic ? new AutomaticRunStopped(siteWall) : new Error(siteWall);
    if (automatic) {
      // Never type into a sign-in or account form, and never record an empty
      // "ready" run for a page that is not the application itself.
      if (form.fields.some((field) => /\bpassword\b/i.test(field.label))) {
        throw new AutomaticRunStopped("The application site asks you to sign in or create an account first. Do that in the agent's browser, then start the run yourself.");
      }
      if (!form.fields.some((field) => field.kind !== "unknown")) {
        // A CAPTCHA or bot-check page in place of the form is named as such.
        const blocking = page.visibleChallenge ? await page.visibleChallenge() : null;
        if (blocking) {
          throw new AutomaticRunStopped(`The application page at ${hostOf(page.url())} showed ${blocking.detail}; the agent never solves CAPTCHAs, so start this application yourself.`);
        }
        throw new AutomaticRunStopped("No application form was found at " + applicationUrl + ". It may sit behind an Apply button; start the run yourself from the form's address.");
      }
    }
    // Read-only: a challenge the candidate would see holds the run; the hidden token field and invisible badge do not.
    const challenge = page.visibleChallenge ? await page.visibleChallenge() : null;
    const classification = classifyAts(form.url, form.title, await page.bodyText());
    const flow = atsFlowFor(classification);
    // A form of several pages on a site with no adapter (unknown or approval-only kinds; iCIMS is its own flow):
    // filling only its first page would leave the run stuck at submit, so it stops with the reason.
    if (!challenge && !inDialog && flow !== "auto" && !onHandshakeHost(page.url()) && !icimsHostOf(page.url()) && hasStepButtons(page)) {
      const multi = multiStepStopReason(page.url(), await page.stepButtons());
      if (multi) throw automatic ? new AutomaticRunStopped(multi) : new Error(multi);
    }
    const transcriptRequired = hasTranscriptField(form.fields);
    if (lock === "default" && runChannel(posting.source.applicationType, transcriptRequired)) {
      throw new AutomaticRunStopped(yearHoldMessage(database, candidateId, posting.companyName));
    }
    const channel = runChannel(posting.source.applicationType, transcriptRequired || lock === "transcript");
    const transcript = transcriptRequired ? currentCandidateDocument("transcript", database, candidateId) : null;
    if (transcriptRequired && !transcript) {
      throw new Error("This application asks for your transcript. Upload it on the profile page, then start the run again.");
    }
    const profile: ApplicationProfile = channel ? "transcript" : "default";
    const uploaded = uploadedResumeFor(profile, database, candidateId);
    const resolutions = await resolveFields(form, database, { ...questionContextFor(channel), ...postingQuestionContext(posting) });
    const plan = planAutofill(form, plannerInputsFor(database, candidateId, candidate, {
      resolutions,
      packageAnswers: current.package.answers.map((answer) => ({ prompt: answer.prompt, text: answer.text })),
      variantId: variant.id,
      transcriptDocumentId: transcript?.id ?? null,
      profile,
      standing,
      postingLocations: postingLocationNames(posting)
    }));
    const decisions = withUploadedResume(channel
      ? plan.decisions.map((decision): FillDecision => decision.action === "upload" && decision.basis?.kind === "variant"
        ? { ...decision, reason: "Uploads your tailored resume printed with your 2029 graduation date." }
        : decision)
      : plan.decisions, uploaded, profile);
    const drafter = options.voiceDrafter === undefined
      ? createDefaultVoiceDrafter({ dataDir, database })
      : options.voiceDrafter;
    if (drafter) {
      const drafted = await applyVoiceDrafts({ decisions, pauses: plan.pauses }, form, {
        drafter, posting, sources: draftSourcesFor(database, candidateId)
      });
      decisions.splice(0, decisions.length, ...drafted.decisions);
      plan.pauses = drafted.pauses;
    }
    const attached = inDialog ? await attachedResumeCheck(page) : null;
    if (attached) {
      decisions.push(attached.decision);
      plan.pauses = [...plan.pauses, attached.pause];
    }
    if (challenge) {
      // A safeguard pause: never answered through, and safeguard runs are never submitted.
      const held = challengePause(challenge);
      decisions.push(held.decision);
      plan.pauses = [...plan.pauses, held.pause];
    }
    // Only skips (a copy-link box, a cookie panel's toggles): no application form was reached, so nothing is saved.
    if (!reachedApplicationForm(decisions)) {
      const reason = noFormReachedReason(page.url());
      throw automatic ? new AutomaticRunStopped(reason) : new Error(reason);
    }
    const uploadPathFor = await prepareUploads(
      database,
      dataDir,
      { jobId, variantId: variant.id, channel },
      decisions,
      renderPdf
    );
    setJobStatus(database, jobId, null, "APPLYING", posting.status === "APPLYING"
      ? "Browser run restarted after the previous run failed or was cancelled."
      : automatic
        ? "Browser run started automatically from the verified package; your approval is required before submission."
        : "Browser run started from the approved package.");
    const { applied, unfilled } = await applyDecisions(page, form, decisions, uploadPathFor);
    const filled = pauseUnfilled(form, decisions, plan.pauses, unfilled);
    // Each statement accepted or signed under the standing settings, with its exact text (unfilled ones are pauses now).
    logStandingAcceptances(database, jobId, filled.decisions);
    const now = new Date().toISOString();
    const run = saveBrowserRun(database, {
      id: randomUUID(),
      jobId,
      applicationUrl: formUrl,
      status: "started",
      packageId: current.package.id,
      variantId: variant.id,
      baseResumeId: uploadedBaseResumeId(filled.decisions),
      applicationProfile: channel ? "transcript" : "default",
      atsKind: flow === "auto" ? classification.kind : "unknown",
      atsConfidence: classification.confidence,
      suggestedAtsKind: flow === "auto" ? null : classification.kind === "unknown" ? null : classification.kind,
      atsConfirmed: flow === "auto",
      decisions: filled.decisions,
      pauses: filled.pauses,
      submittedAnswers: null,
      confirmationText: null,
      submissionApprovedAt: null,
      createdAt: now,
      updatedAt: now
    });
    const settled = updateBrowserRun(database, run.id, {
      status: filled.pauses.length > 0 ? "paused-needs-input" : "awaiting-approval"
    });
    noteMixedProfile(database, settled, posting.companyName, candidateId, manualPin);
    return { run: settled, form, applied };
  } finally {
    await page.close();
  }
}

/**
 * Values evidence must never store for an iCIMS host: the account email, and
 * the host's saved email and password (the account email alone when the
 * accounts file cannot be read).
 */
function icimsAccountSecrets(runtime: IcimsAccountRuntime, host: string | null): string[] {
  const secrets = [runtime.email];
  try {
    const entry = host ? getIcimsAccount(runtime.file, host) : null;
    if (entry) secrets.push(entry.email, entry.password ?? "");
  } catch {
    return [runtime.email].filter(Boolean);
  }
  return secrets.filter(Boolean);
}

/**
 * iCIMS's account step on an automatic run with the iCIMS account opt-in:
 * creates or signs in to the account (icims-account-service.ts), then stops
 * at iCIMS's application, which the agent does not walk yet, saving evidence
 * for the job either way. Always throws: IcimsAccountHeld for a hold,
 * AutomaticRunStopped once the application is reached. No run is saved.
 */
async function runIcimsAccountStep(
  database: DatabaseSync,
  page: BrowserPage & { icims: IcimsAccountSteps },
  input: {
    jobId: string; dataDir: string; company: string; candidate: ReturnType<typeof getCandidate>;
    runtime: IcimsAccountRuntime; acceptDataConsent: boolean;
  }
): Promise<never> {
  const host = icimsHostOf(page.url());
  const evidence = (outcome: "icims-account" | "icims-application", detail: string) => saveIcimsEvidenceQuietly({
    database, dataDir: input.dataDir, jobId: input.jobId, page, outcome, detail, secrets: icimsAccountSecrets(input.runtime, host)
  });
  let result: "signed-in" | "created";
  try {
    result = await ensureIcimsAccount(page, {
      database, jobId: input.jobId, applicationUrl: page.url(), company: input.company,
      candidate: {
        email: input.candidate?.email, legalFirstName: input.candidate?.legalFirstName,
        legalLastName: input.candidate?.legalLastName, phone: input.candidate?.phone
      },
      runtime: input.runtime, acceptDataConsent: input.acceptDataConsent
    });
  } catch (error) {
    if (error instanceof IcimsAccountHeld) await evidence("icims-account", error.message);
    throw error;
  }
  const site = host ?? "the iCIMS site";
  const stop = `iCIMS ${site}: the agent ${result === "created" ? "created your iCIMS account and signed in" : "signed in with the saved account"}, but it does not fill iCIMS's multi-page application yet. Finish the application at ${site}; \`pnpm icims:account --site ${site}\` prints the saved password.`;
  await evidence("icims-application", stop);
  throw new AutomaticRunStopped(stop);
}

/**
 * A reopened Jobvite form that shows its Data Consent step again: accepted
 * under the standing data-consent setting, else the run stops with today's
 * reason before anything is filled.
 */
async function passJobviteConsentAgain(database: DatabaseSync, page: BrowserPage, jobId: string, standing: StandingConsentSettings): Promise<void> {
  const body = await page.bodyText();
  if (applicationWallKind(page.url(), body) !== "jobvite-consent") return;
  if (standing.acceptDataConsent && hasJobviteConsent(page)) {
    const stop = await acceptJobviteConsentStep(database, page, { jobId, country: getCandidate(database, LOCAL_CANDIDATE_ID)?.addressCountry });
    if (stop) throw new Error(stop);
    return;
  }
  throw new Error(applicationWallReason(page.url(), body) ?? "Jobvite shows its data-consent step.");
}

/** A candidate-started run is never blocked by the company's year; it is only noted on the timeline. */
function noteMixedProfile(database: DatabaseSync, run: BrowserRun, company: string, candidateId: string, pinned: ApplicationProfile | null): void {
  const used = run.applicationProfile ?? null;
  if (!pinned || !used || pinned === used) return;
  const status = getJobPosting(database, run.jobId)?.status ?? "APPLYING";
  logApplicationEvent(database, {
    jobId: run.jobId, fromStatus: status, toStatus: status,
    detail: `Heads-up: ${company} already received your ${profileLabel(database, candidateId, pinned)}; this run uses your ${profileLabel(database, candidateId, used)}. Recruiters there may see two graduation years.`.slice(0, 1_000)
  });
}

export async function answerRunPause(
  runId: string,
  fieldId: string,
  answer: string,
  remember: boolean,
  options: { database?: DatabaseSync } = {}
): Promise<{ run: BrowserRun; remembered: boolean; outcome: PauseAnswerOutcome }> {
  const database = options.database ?? getDatabase();
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  const pause = run.pauses.find((entry) => entry.fieldId === fieldId);
  if (!pause) throw new Error("The paused field is unknown.");
  if (pause.safeguard) throw new Error("Safeguard challenges are never answered through; resolve them in your own browser session.");
  if (pause.upload) {
    throw new Error("This field needs a document, not a typed answer. Attach it yourself in the application, or upload your transcript on the profile page and start a new run.");
  }
  if (pause.status === "answered") throw new Error("This pause is already answered; continue the run.");
  if (fieldId === ATTACHED_RESUME_FIELD) {
    if (!/^\s*(?:yes|y)\s*$/i.test(answer)) {
      throw new Error("Only a yes keeps the attached resume. Update your resume on Handshake, then start a new run.");
    }
    const confirmed = run.pauses.map((entry) => (entry.fieldId === fieldId ? { ...entry, status: "answered" as const, answer: "yes" } : entry));
    return { run: updateBrowserRun(database, runId, { pauses: confirmed }), remembered: false, outcome: usedOnce("confirmation") };
  }
  // Catalog questions go through candidate memory; generic ones the catalog
  // does not map go to question memory; never-save rules (sensitive, blocked,
  // ambiguous, company-specific, essays, --once) use the answer for this run
  // only, and the timeline records why. The caller reports whether anything
  // was stored, so a checked "remember" box never silently does nothing.
  const posting = getJobPosting(database, run.jobId);
  // The posting's own context (its one country, its pay), then the pause's suggested scope.
  const context: QuestionContext = { ...postingQuestionContext(posting), ...(pauseContext(pause.suggestedScope) ?? {}) };
  const chosen = answerForPause(pause, answer);
  const plan = await planPauseMemory(pause, { companyName: posting?.companyName ?? null, context, answer: chosen.value });
  let outcome: PauseAnswerOutcome;
  if (plan.path === "fact") {
    try {
      const resolution = await answerCandidateQuestion({ question: pause.question, answer, remember, context }, { database });
      if (resolution.status === "RESOLVED") outcome = remember ? { saved: true, store: "fact", factKey: plan.key } : usedOnce("not_requested");
      else if (resolution.status === "ANSWERED_ONCE") outcome = remember ? usedOnce("fact_rule", resolution.reason) : usedOnce("not_requested");
      else if (resolution.status === "NEEDS_INPUT") outcome = usedOnce("fact_rule", resolution.reason);
      // "fact_policy" comes from re-reading a fact that WAS saved (its reuse policy is never or confirm), so it counts as stored.
      else if (resolution.status === "REQUIRES_CONFIRMATION" && resolution.policy === "fact_policy") outcome = remember ? { saved: true, store: "fact", factKey: plan.key } : usedOnce("not_requested");
      else if (resolution.status === "REQUIRES_CONFIRMATION") outcome = usedOnce(resolution.policy === "attestation" ? "blocked_attestation" : "blocked_protected");
      else throw new Error(`That answer did not resolve: ${resolution.reason}`);
    } catch (error) {
      // An offered option the matching fact cannot hold (e.g. "Yes, I am authorized") is used for this run only.
      if (chosen.offered && (error instanceof ZodError || (error instanceof Error && error.message === "Answer with yes or no."))) outcome = usedOnce("not_a_fact_value");
      else throw error;
    }
  } else if (plan.path === "question") {
    if (!remember) outcome = usedOnce("not_requested");
    else {
      const kind = answerKindFor(pause.fieldKind);
      const stored = saveQuestionAnswer(database, {
        candidateId: LOCAL_CANDIDATE_ID,
        question: pause.label,
        answerKind: kind,
        answer: kind === "option" ? chosen.value : chosen.value.trim(),
        sourceRunId: run.id
      });
      outcome = { saved: true, store: "question", answerId: stored.answer.id, status: stored.status };
    }
  } else {
    outcome = usedOnce(plan.reason);
  }
  const pauses = run.pauses.map((entry) =>
    entry.fieldId === fieldId ? { ...entry, status: "answered" as const, answer: chosen.value } : entry
  );
  const updated = updateBrowserRun(database, runId, { pauses });
  const status = posting?.status ?? "APPLYING";
  logApplicationEvent(database, {
    jobId: run.jobId,
    fromStatus: status,
    toStatus: status,
    detail: pauseAnswerEventDetail(
      pause.label,
      outcome,
      outcome.saved && outcome.store === "fact" ? factDefinitions[outcome.factKey].label : undefined
    )
  });
  return { run: updated, remembered: outcome.saved, outcome };
}

export function pauseContext(suggestedScope: string | null): QuestionContext | undefined {
  if (!suggestedScope || suggestedScope === "global") return undefined;
  if (suggestedScope === "channel:handshake_internal") {
    return { applicationChannel: "handshake_internal" };
  }
  if (suggestedScope.startsWith("country:")) {
    return { countryCode: suggestedScope.slice("country:".length) };
  }
  if (suggestedScope.startsWith("location:")) {
    return { location: suggestedScope.slice("location:".length) };
  }
  if (suggestedScope.startsWith("company:")) {
    return { companyName: suggestedScope.slice("company:".length) };
  }
  return undefined;
}

/**
 * The pending/other-ATS flow: the candidate confirms the suggested kind or
 * picks generic explicitly. A correction (suggested X, confirmed Y) is
 * logged as an event and kept visible; it never silently changes behavior.
 */
export function confirmRunAts(
  runId: string,
  kind: AtsKind,
  options: { database?: DatabaseSync } = {}
): BrowserRun {
  const database = options.database ?? getDatabase();
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (run.status === "submitted" || run.status === "cancelled" || run.status === "failed") {
    throw new Error("Closed runs keep their recorded ATS kind.");
  }
  const updated = updateBrowserRun(database, runId, { atsKind: kind, suggestedAtsKind: null, atsConfirmed: true });
  if (run.suggestedAtsKind && run.suggestedAtsKind !== kind) {
    logApplicationEvent(database, {
      jobId: run.jobId,
      fromStatus: null,
      toStatus: getJobPosting(database, run.jobId)?.status ?? "APPLYING",
      detail: `ATS correction recorded: suggested ${run.suggestedAtsKind}, confirmed ${kind}. Corrections never apply silently.`
    });
  }
  return updated;
}

export async function continueBrowserRun(
  runId: string,
  options: {
    database?: DatabaseSync;
    dataDir?: string;
    openPage?: PageFactory;
    renderPdf?: PdfRenderer;
    /** Workday only; undefined keeps the default drafter, null drafts nothing (pnpm run:answer). */
    voiceDrafter?: VoiceDrafter | null;
    /** The candidate's standing consent and attestation settings; default from the environment. */
    standingConsent?: StandingConsentSettings;
    /** Oracle Cloud HCM's email and one-time-code step: the mailbox it reads and its address. Default from INTERNSHIP_AGENT_GMAIL_*; null never takes the step (the email-step stop stays). */
    oracleEmailStep?: OracleEmailStepSettings | null;
  } = {}
): Promise<RunReport> {
  const database = options.database ?? getDatabase();
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (run.status !== "paused-needs-input") throw new Error("Only paused runs continue.");
  const dataDir = resolveDataDir(options.dataDir);
  const standing = options.standingConsent ?? standingConsentSettings(process.env);
  if (parseWorkdayUrl(run.applicationUrl)) {
    const { walk, url, title } = await continueWorkdayRun(database, run, {
      dataDir, openPage: options.openPage, renderPdf: options.renderPdf ?? renderHtmlToPdf, voiceDrafter: options.voiceDrafter, mode: "fill", account: null, lock: null,
      standing
    });
    const { status, pauses } = workdayOutcome(walk, run.pauses);
    const settled = updateBrowserRun(database, runId, {
      decisions: walk.decisions, pauses, status, applicationProfile: walk.transcript ? "transcript" : "default",
      baseResumeId: uploadedBaseResumeId(walk.decisions)
    });
    return { run: settled, form: { url, title, fields: [] }, applied: countApplied(walk.decisions) };
  }
  const openPage = options.openPage ?? ((url: string) => defaultOpenPage(url, dataDir));
  const channel = runChannel(
    getJobPosting(database, run.jobId)?.source.applicationType,
    usesTranscript(run.decisions) || run.applicationProfile === "transcript"
  );

  const page = await openPage(run.applicationUrl);
  try {
    assertHandshakeSignedIn(database, page.url());
    await enterHandshakeDialog(page, getJobPosting(database, run.jobId)?.source.applicationType);
    // A resume the candidate confirmed must not have changed while the run waited.
    await assertKeptAttachment(page, run.decisions);
    await passJobviteConsentAgain(database, page, run.jobId, standing);
    let form = await recognizeCurrentForm(page);
    // A form reached through a button on a site with no adapter (its address did not change): walk to it again.
    if (!onHandshakeHost(page.url()) && hasSiteNavigation(page) && !hasApplicationFields(form.fields)) {
      const outcome = await page.advanceToApplicationForm();
      if (outcome.moved) form = await recognizeCurrentForm(page);
    }
    // Oracle Cloud HCM's email step again (the run's saved address is the email step's); the
    // re-planning below then reads the form the step reached, not the email step.
    const posting = getJobPosting(database, run.jobId);
    const candidate = getCandidate(database, LOCAL_CANDIDATE_ID);
    const oracle = await passOracleEmailStep(database, page, form, {
      jobId: run.jobId, company: posting?.companyName ?? "", candidateEmail: candidate?.email,
      standing, settings: options.oracleEmailStep
    });
    if (oracle.kind === "stopped") throw new Error(oracle.reason);
    if (oracle.kind === "passed") form = oracle.form;
    const resolutions = await resolveFields(form, database, { ...questionContextFor(channel), ...postingQuestionContext(posting) });
    const packageAnswers = runPackageAnswers(database, run);
    // Open pauses nothing answered are planned again with today's rules: a standing setting, a saved
    // self-identification answer, or a rule added since the run paused may answer them now.
    const replanned = planAutofill(form, plannerInputsFor(database, LOCAL_CANDIDATE_ID, candidate, {
      resolutions,
      packageAnswers,
      variantId: run.variantId,
      transcriptDocumentId: null,
      profile: channel ? "transcript" : "default",
      standing,
      postingLocations: postingLocationNames(posting)
    }));
    const fresh = new Map(replanned.decisions.map((entry) => [entry.fieldId, entry]));
    const freshPauses = new Map(replanned.pauses.map((entry) => [entry.fieldId, entry]));
    const settled = new Map<string, PauseRecord>();
    const decisions: FillDecision[] = [];
    // An answer that fits no option of its list reopens its pause instead of being typed into the list.
    const reopened = new Set<string>();
    for (const decision of run.decisions) {
      if (decision.action !== "pause") {
        decisions.push(decision);
        continue;
      }
      const pause = run.pauses.find((entry) => entry.fieldId === decision.fieldId);
      const field = form.fields.find((entry) => entry.id === decision.fieldId);
      const resolution = field ? resolutions.get(field.id) : undefined;
      if (pause?.status === "answered" && pause.answer && field) {
        const answered = answeredPauseDecision(
          field,
          pause.answer,
          pause.suggestedKey && pause.suggestedScope
            ? { kind: "fact", key: pause.suggestedKey, scope: pause.suggestedScope }
            : null
        );
        if (!answered) {
          reopened.add(pause.fieldId);
          decisions.push(decision);
          continue;
        }
        decisions.push(answered);
        continue;
      }
      if (field && resolution?.status === "RESOLVED") {
        const answered = answeredPauseDecision(field, resolution.display, { kind: "fact", key: resolution.key, scope: resolution.scope });
        if (answered) {
          decisions.push(answered.action === "skip" ? answered : { ...answered, reason: "Candidate memory now answers this pause." });
          // The pause is answered now, so it no longer holds the run (as Workday's continue does).
          if (pause?.status === "open") settled.set(pause.fieldId, { ...pause, status: "answered", answer: pause.sensitive ? null : resolution.display });
          continue;
        }
      }
      const next = field ? fresh.get(field.id) : undefined;
      if (field && pause && pause.status === "open" && !pause.safeguard && !pause.upload && next && next.action !== "upload") {
        decisions.push(next);
        const sensitive = pause.sensitive || isSensitiveRole(classifyFieldRole(field));
        if (next.action === "pause") {
          // Same position, today's question, sensitivity and options; still open.
          const today = freshPauses.get(field.id);
          settled.set(pause.fieldId, today ? { ...today, draft: today.draft ?? pause.draft } : pause);
        } else {
          // A protected option is never copied into the pause record.
          const answer = sensitive ? null : next.action === "check" ? "yes" : next.action === "skip" ? null : next.value;
          settled.set(pause.fieldId, { ...pause, sensitive, status: "answered", answer });
        }
        continue;
      }
      decisions.push(decision);
    }
    const pauses = run.pauses.map((entry) => reopened.has(entry.fieldId) ? { ...entry, status: "open" as const, answer: null } : settled.get(entry.fieldId) ?? entry);
    const uploadPathFor = await prepareUploads(
      database,
      dataDir,
      { jobId: run.jobId, variantId: run.variantId, channel },
      decisions,
      options.renderPdf ?? renderHtmlToPdf
    );
    const { applied, unfilled } = await applyDecisions(page, form, decisions, uploadPathFor);
    const filled = pauseUnfilled(form, decisions, pauses, unfilled);
    const stillOpen = filled.pauses.filter((entry) => entry.status === "open").length;
    // Nothing filled and nothing left to ask: the reopened page is not the run's form, so the run stays paused.
    if (stillOpen === 0 && applied === 0 && !filled.decisions.some((decision) => decision.action === "keep")) {
      throw new Error(noFormReachedReason(page.url()));
    }
    const updated = updateBrowserRun(database, runId, {
      decisions: filled.decisions,
      pauses: filled.pauses,
      status: stillOpen > 0 ? "paused-needs-input" : "awaiting-approval"
    });
    // Statements newly accepted under the standing settings, logged once with their exact text.
    logStandingAcceptances(database, run.jobId, filled.decisions, run.decisions);
    return { run: updated, form, applied };
  } finally {
    await page.close();
  }
}

export function approveRunSubmission(
  runId: string,
  note: string | undefined,
  options: { database?: DatabaseSync } = {}
): BrowserRun {
  const database = options.database ?? getDatabase();
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (run.status !== "awaiting-approval") {
    throw new Error("Only runs awaiting approval can have their submission approved.");
  }
  if (run.pauses.some((pause) => pause.status === "open")) {
    throw new Error("Open pauses must be answered before submission.");
  }
  if (run.pauses.some((pause) => pause.safeguard)) {
    throw new Error("This run touched a safeguard challenge; submission stays blocked.");
  }
  void note;
  return updateBrowserRun(database, runId, { submissionApprovedAt: new Date().toISOString() });
}

/**
 * The candidate's opt-in auto-submit policy standing in for the submit
 * approval. It refuses every run autoSubmitBlockers names, and the timeline
 * records it as the policy's approval, never as the candidate's.
 */
export function approveRunSubmissionAutomatically(
  runId: string,
  basis: string[],
  options: { database?: DatabaseSync } = {}
): BrowserRun {
  const database = options.database ?? getDatabase();
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (manualOnly()) throw new Error("Manual checklist mode is on; nothing is submitted automatically.");
  const blockers = autoSubmitBlockers(run);
  if (blockers.length > 0) throw new Error("Not submitted automatically: " + blockers.join(" "));
  const approved = updateBrowserRun(database, runId, { submissionApprovedAt: new Date().toISOString() });
  const status = getJobPosting(database, run.jobId)?.status ?? "APPLYING";
  logApplicationEvent(database, {
    jobId: run.jobId, fromStatus: status, toStatus: status,
    detail: (AUTO_SUBMIT_EVENT + (basis.length ? ": " + basis.join(" ") : ".")).slice(0, 1_000)
  });
  return approved;
}

/** A challenge seen before the submit click: the approval is withdrawn and the run pauses with one safeguard; nothing is clicked. */
function holdForChallengeBeforeClick(database: DatabaseSync, runId: string, run: BrowserRun, challenge: VisibleChallenge): SubmissionChallenged {
  const held = challengePause(challenge);
  updateBrowserRun(database, runId, {
    status: "paused-needs-input",
    submissionApprovedAt: null,
    decisions: [...run.decisions.filter((decision) => decision.fieldId !== held.decision.fieldId), held.decision],
    pauses: [...run.pauses.filter((pause) => pause.fieldId !== held.pause.fieldId), held.pause]
  });
  return new SubmissionChallenged(`Before the submit click the site showed ${challenge.detail}. The agent never solves CAPTCHAs, so this application is held for you: finish it in your own browser. The run is not marked submitted.`);
}

export async function submitBrowserRun(
  runId: string,
  options: {
    database?: DatabaseSync; dataDir?: string; openPage?: PageFactory; renderPdf?: PdfRenderer;
    /** Workday account automation for the auto-submit path: signs in with a saved password only, never creates. */
    workdayAccounts?: WorkdayAccountRuntime | null;
    /** Writes the local record of what was sent after a confirmed submission. Default: the real writer; null skips it (tests). Never fails the submission. */
    applicationRecord?: ApplicationRecordWriter | null;
    /** The company's pinned profile (the auto-submit path); a Workday walk that meets a transcript step on a default-pinned company stops instead of switching. */
    companyProfile?: ApplicationProfile | null;
    /** Tests only: how long the submit waits for a confirmation (default 30 s, polling every 500 ms). */
    submitWait?: { timeoutMs?: number; pollMs?: number };
    /**
     * Reads Greenhouse's emailed security code after a submit click. Default:
     * the Gmail mailbox from INTERNSHIP_AGENT_GMAIL_* (none when unset); null
     * reads none, so the step holds the run.
     */
    securityCodeMailbox?: VerificationMailboxFactory | null;
    /** Tests only: how the code is polled (default every 10 s for up to 3 minutes). */
    securityCodeWait?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
    /** The candidate's standing consent and attestation settings; default from the environment. */
    standingConsent?: StandingConsentSettings;
    /** Oracle Cloud HCM's email and one-time-code step: the mailbox it reads and its address. Default from INTERNSHIP_AGENT_GMAIL_*; null never takes the step (the email-step stop stays). */
    oracleEmailStep?: OracleEmailStepSettings | null;
  } = {}
): Promise<BrowserRun> {
  const database = options.database ?? getDatabase();
  const standing = options.standingConsent ?? standingConsentSettings(process.env);
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (!run.submissionApprovedAt) {
    throw new Error("Submission needs an explicit human approval first.");
  }
  if (run.status !== "awaiting-approval") {
    throw new Error("Only runs awaiting approval can be submitted.");
  }
  if (!run.atsConfirmed) {
    throw new Error("Confirm the ATS kind (or generic explicitly) before submitting.");
  }
  const dataDir = resolveDataDir(options.dataDir);
  if (parseWorkdayUrl(run.applicationUrl)) {
    updateBrowserRun(database, runId, { status: "submitting" });
    let walk: WorkdayWalkResult;
    try {
      ({ walk } = await continueWorkdayRun(database, run, {
        dataDir, openPage: options.openPage, renderPdf: options.renderPdf ?? renderHtmlToPdf, mode: "submit",
        account: options.workdayAccounts ? { runtime: options.workdayAccounts, mode: "sign-in" } : null,
        lock: options.companyProfile ?? null, standing
      }));
    } catch (error) {
      updateBrowserRun(database, runId, { status: "failed" });
      throw error;
    }
    if (walk.outcome !== "submitted") {
      // Workday changed or asked for more before Review: the approval covered
      // what the candidate saw, so it is withdrawn and asked for again.
      const { pauses } = workdayOutcome(walk, run.pauses);
      updateBrowserRun(database, runId, {
        status: "paused-needs-input", decisions: walk.decisions, pauses, submissionApprovedAt: null,
        applicationProfile: walk.transcript ? "transcript" : "default", baseResumeId: uploadedBaseResumeId(walk.decisions)
      });
      throw new Error("Workday asked for more before Review. Answer the new questions, continue the run, and approve again.");
    }
    const submittedAnswers: Record<string, string> = {};
    for (const decision of walk.decisions) {
      if ((decision.action === "fill" || decision.action === "choose" || decision.action === "check") && decision.value !== null) {
        submittedAnswers[decision.fieldId] = decision.value;
      }
    }
    const confirmation = walk.confirmation ?? "";
    const submitted = updateBrowserRun(database, runId, {
      status: "submitted", submittedAnswers, confirmationText: confirmation, applicationProfile: walk.transcript ? "transcript" : "default",
      baseResumeId: uploadedBaseResumeId(walk.decisions)
    });
    setJobStatus(database, run.jobId, null, "SUBMITTED", `Submitted on Workday with confirmation: ${confirmation.slice(0, 200)}`);
    await recordSubmission(database, dataDir, run.jobId, walk.fieldLabels, options.applicationRecord);
    return submitted;
  }
  const openPage = options.openPage ?? ((url: string) => defaultOpenPage(url, dataDir));
  const channel = runChannel(
    getJobPosting(database, run.jobId)?.source.applicationType,
    usesTranscript(run.decisions) || run.applicationProfile === "transcript"
  );

  const page = await openPage(run.applicationUrl);
  try {
    // Checked before "submitting" so a signed-out session, a missing Quick
    // apply dialog, or a changed attachment never fails the run.
    assertHandshakeSignedIn(database, page.url());
    await enterHandshakeDialog(page, getJobPosting(database, run.jobId)?.source.applicationType);
    await assertKeptAttachment(page, run.decisions);
    // Jobvite's Data Consent step shown again: accepted under the standing setting, else the run keeps waiting for approval.
    await passJobviteConsentAgain(database, page, run.jobId, standing);
    // A challenge the candidate would see is never solved: the run goes back to them, approval withdrawn.
    const challenge = page.visibleChallenge ? await page.visibleChallenge() : null;
    if (challenge) throw holdForChallengeBeforeClick(database, runId, run, challenge);
    // The approved form must still be there: a page showing none of its fields is never submitted.
    let shown = await recognizeCurrentForm(page);
    if (!onHandshakeHost(page.url()) && hasSiteNavigation(page) && !hasApplicationFields(shown.fields)) {
      const outcome = await page.advanceToApplicationForm();
      if (outcome.moved) shown = await recognizeCurrentForm(page);
    }
    // Oracle Cloud HCM's email step again; a stop keeps the run waiting for approval.
    const oracle = await passOracleEmailStep(database, page, shown, {
      jobId: run.jobId, company: getJobPosting(database, run.jobId)?.companyName ?? "", candidateEmail: getCandidate(database, LOCAL_CANDIDATE_ID)?.email,
      standing, settings: options.oracleEmailStep
    });
    if (oracle.kind === "stopped") throw new Error(`${oracle.reason} Nothing was submitted, and the run still waits for approval.`);
    if (oracle.kind === "passed") shown = oracle.form;
    const present = new Set(shown.fields.map((field) => field.id));
    const onForm = run.decisions.some((decision) => SHOWN_ACTIONS.has(decision.action)
      && (present.has(decision.fieldId) || (decision.action === "keep" && decision.fieldId === ATTACHED_RESUME_FIELD)));
    if (!onForm) {
      throw new Error(`The application form was not found at ${page.url()} when the agent came back to submit; nothing was clicked, and the run still waits for approval.`);
    }
  } catch (error) {
    await page.close();
    throw error;
  }
  updateBrowserRun(database, runId, { status: "submitting" });
  let outcome: { submitted: BrowserRun; labels: Record<string, string> } | undefined;
  // Set when a field would not fill before the click, or the site marked fields
  // invalid after it (nothing was sent): the run is back with the candidate, not failed.
  let heldForInput = false;
  let form: RecognizedForm | null = null;
  // What the page showed after a click that was not a recognized confirmation.
  let postSubmit: PostSubmitEvidence | null = null;
  try {
    form = await recognizeCurrentForm(page);
    // Every answer the approval covered must still be on the reloaded form; applyDecisions would skip one that is not.
    const absent = absentDecisionFields(form, run.decisions);
    if (absent.length > 0) {
      const held = formChangedPause(absent.length);
      updateBrowserRun(database, runId, {
        status: "paused-needs-input",
        submissionApprovedAt: null,
        decisions: [...run.decisions.filter((decision) => decision.fieldId !== held.decision.fieldId), held.decision],
        pauses: [...run.pauses.filter((pause) => pause.fieldId !== held.pause.fieldId), held.pause]
      });
      heldForInput = true;
      throw new SubmissionHeld(held.pause.question);
    }
    const uploadPathFor = await prepareUploads(
      database,
      dataDir,
      { jobId: run.jobId, variantId: run.variantId, channel },
      run.decisions,
      options.renderPdf ?? renderHtmlToPdf
    );
    const { unfilled } = await applyDecisions(page, form, run.decisions, uploadPathFor);
    if (unfilled.length > 0) {
      // Nothing is clicked: the approval covered a form that is no longer filled as shown.
      const filled = pauseUnfilled(form, run.decisions, run.pauses, unfilled);
      updateBrowserRun(database, runId, {
        status: "paused-needs-input", submissionApprovedAt: null, decisions: filled.decisions, pauses: filled.pauses
      });
      heldForInput = true;
      const fields = new Map(form.fields.map((field) => [field.id, field.label]));
      const labels = unfilled.map((entry) => `"${fields.get(entry.fieldId) ?? entry.fieldId}"`).join(", ");
      throw new SubmissionHeld(`Before the submit click the agent could not fill ${unfilled.length} field(s) (${labels}); the application is held for you.`.slice(0, 600));
    }
    // Read back before the click: every choice on a radio question must show as made (Track 25).
    const notTaken = await choicesNotTaken(page, form, run.decisions);
    if (notTaken.length > 0) {
      const filled = pauseUnfilled(form, run.decisions, run.pauses, notTaken);
      updateBrowserRun(database, runId, {
        status: "paused-needs-input", submissionApprovedAt: null, decisions: filled.decisions, pauses: filled.pauses
      });
      heldForInput = true;
      const fields = new Map(form.fields.map((field) => [field.id, field.label]));
      const labels = notTaken.map((entry) => `"${fields.get(entry.fieldId) ?? entry.fieldId}"`).join(", ");
      throw new SubmissionHeld(`Before the submit click ${labels} did not take the choice, so nothing was clicked; the application is held for you.`.slice(0, 600));
    }
    // A widget drawn while the form filled (Dover's Turnstile renders late) is read again right before the click.
    const lateChallenge = page.visibleChallenge ? await page.visibleChallenge() : null;
    if (lateChallenge) {
      heldForInput = true;
      throw holdForChallengeBeforeClick(database, runId, run, lateChallenge);
    }
    // Greenhouse's emailed security-code step: the code is read from the candidate's mailbox (read only, in memory).
    const securityCode = greenhouseSecurityCodeLookup({
      mailbox: options.securityCodeMailbox === undefined ? gmailMailboxFactory(process.env) : options.securityCodeMailbox,
      company: getJobPosting(database, run.jobId)?.companyName ?? "",
      wait: options.securityCodeWait
    });
    let confirmation: string;
    try {
      confirmation = await submitAndConfirm(page, { ...options.submitWait, securityCode, atsKind: run.atsKind });
    } catch (error) {
      // Anything after the click (even a failed click) keeps what the page showed.
      postSubmit = postSubmitEvidenceOf(error) ?? await capturePostSubmitEvidence(page, "unknown");
      throw error;
    }
    const submittedAnswers: Record<string, string> = {};
    for (const decision of run.decisions) {
      if ((decision.action === "fill" || decision.action === "choose" || decision.action === "check") && decision.value !== null) {
        submittedAnswers[decision.fieldId] = decision.value;
      }
    }
    const submitted = updateBrowserRun(database, runId, {
      status: "submitted",
      submittedAnswers,
      confirmationText: confirmation
    });
    setJobStatus(database, run.jobId, null, "SUBMITTED", `Submitted with confirmation: ${confirmation.slice(0, 200)}`);
    outcome = { submitted, labels: Object.fromEntries(form.fields.map((field) => [field.id, field.label])) };
  } catch (error) {
    if (error instanceof SubmissionCodeNotFound) {
      // Nothing was sent: the run goes back to the candidate with the approval withdrawn.
      const held = securityCodePause(error.message, run.id.slice(0, 8));
      updateBrowserRun(database, runId, {
        status: "paused-needs-input",
        submissionApprovedAt: null,
        decisions: [...run.decisions.filter((decision) => decision.fieldId !== held.decision.fieldId), held.decision],
        pauses: [...run.pauses.filter((pause) => pause.fieldId !== held.pause.fieldId), held.pause]
      });
      heldForInput = true;
    }
    if (error instanceof SubmissionNeedsInput && form) {
      // The site refused the form with field errors, so nothing was sent: the
      // run waits for the candidate's answers and the approval is withdrawn.
      const held = invalidFieldPauses(form, run.decisions, run.pauses, error.invalidFields);
      updateBrowserRun(database, runId, {
        status: "paused-needs-input", submissionApprovedAt: null, decisions: held.decisions, pauses: held.pauses
      });
      heldForInput = true;
    }
    if (!heldForInput) updateBrowserRun(database, runId, { status: "failed" });
    // Kept local (mode 600) and never sent anywhere; saving it never changes the outcome.
    if (postSubmit) await savePostSubmitEvidenceQuietly({ database, dataDir, run, page, evidence: postSubmit });
    throw error;
  } finally {
    await page.close();
  }
  if (!outcome) throw new Error("The submission finished without a result.");
  await recordSubmission(database, dataDir, run.jobId, outcome.labels, options.applicationRecord);
  return outcome.submitted;
}

async function recordSubmission(
  database: DatabaseSync,
  dataDir: string,
  jobId: string,
  labels: Record<string, string>,
  writer: ApplicationRecordWriter | null | undefined
): Promise<void> {
  const write = writer === undefined ? saveApplicationRecordQuietly : writer;
  if (!write) return;
  try {
    await write({ database, dataDir, jobId, labels });
  } catch {
    // A record never fails a confirmed submission.
  }
}

export function cancelBrowserRun(runId: string, database: DatabaseSync = getDatabase()): BrowserRun {
  const run = getBrowserRun(database, runId);
  if (!run) throw new Error("The browser run is unknown.");
  if (run.status === "submitted") throw new Error("Submitted runs stay in history; withdraw the application instead.");
  return updateBrowserRun(database, runId, { status: "cancelled" });
}

export function getBrowserRuns(jobId: string, database: DatabaseSync = getDatabase()): BrowserRun[] {
  return listBrowserRuns(database, jobId);
}

// ---- Workday career sites: a multi-step flow walked by the Workday adapter ----

function asWorkdayPage(page: BrowserPage): WorkdayPage {
  if (!("enterApplication" in page)) throw new Error("A Workday run needs the Workday page adapter.");
  return page as WorkdayPage;
}

function workdayContext(
  database: DatabaseSync,
  input: { jobId: string; candidateId: string; posting: JobPosting; packageAnswers: Array<{ prompt: string; text: string }>; variantId: string | null },
  dataDir: string,
  renderPdf: PdfRenderer,
  drafter: VoiceDrafter | null,
  answers: Map<string, string>,
  account: WorkdayRunContext["account"],
  standing: StandingConsentSettings,
  transcript = false,
  lock: ApplicationProfile | null = null
): WorkdayRunContext {
  const candidate = getCandidate(database, input.candidateId);
  const graduation = (scope: Parameters<typeof getCurrentFact>[3]) => {
    const value = getCurrentFact(database, input.candidateId, "graduation_date", scope)?.value;
    return typeof value === "string" ? value : null;
  };
  const standardGraduation = graduation({ kind: "global" }) ?? candidate?.graduationDate ?? null;
  // A form that asks for a transcript uses the alternate (2029) graduation answer.
  const transcriptGraduation = graduation({ kind: "application_channel", channel: "handshake_internal" });
  const entries = listResumeEntries(database, input.candidateId);
  // Each step sends the candidate's uploaded resume for its profile, when one is stored.
  const uploaded = {
    default: uploadedResumeFor("default", database, input.candidateId),
    transcript: uploadedResumeFor("transcript", database, input.candidateId)
  };
  return {
    database, candidateId: input.candidateId, posting: input.posting, candidate, jobId: input.jobId, account,
    packageAnswers: input.packageAnswers, variantId: input.variantId, drafter, answers, transcript,
    history: {
      standard: planApplicationHistory({ entries, candidate, graduationDate: standardGraduation }),
      // A company that already received the default profile never switches.
      transcript: lock !== "default" && transcriptGraduation
        ? planApplicationHistory({ entries, candidate, graduationDate: transcriptGraduation })
        : null,
      answers
    },
    profileLock: lock,
    standing: standingPlannerInputs(candidate, standing),
    transcriptDocumentId: () => currentCandidateDocument("transcript", database, input.candidateId)?.id ?? null,
    deps: {
      resolveFields: (form, usesTranscript, employerSite) => resolveFields(form, database, {
        ...questionContextFor(usesTranscript ? "handshake_internal" : null),
        ...postingQuestionContext(input.posting),
        ...(employerSite ? { employerSite } : {})
      }),
      uploadsFor: (decisions, usesTranscript) => prepareUploads(database, dataDir, {
        jobId: input.jobId, variantId: input.variantId, channel: null,
        graduationDate: usesTranscript ? transcriptGraduation : null
      }, decisions, renderPdf),
      chooseResume: (decisions, usesTranscript) => withUploadedResume(
        decisions,
        usesTranscript ? uploaded.transcript : uploaded.default,
        usesTranscript ? "transcript" : "default"
      )
    }
  };
}

/**
 * Run status and pauses after a walk. Workday's validation errors are one
 * open pause each (the walk made them); the single "(Workday errors)" pause is
 * added only when a blocked walk has none, e.g. Workday showed no error text.
 */
function workdayOutcome(walk: WorkdayWalkResult, earlier: PauseRecord[] = []): { status: BrowserRun["status"]; pauses: PauseRecord[] } {
  const current = new Set(walk.pauses.map((pause) => pause.fieldId));
  const pauses = [...earlier.filter((pause) => pause.status === "answered" && !current.has(pause.fieldId)), ...walk.pauses];
  if (walk.outcome === "blocked" && !walk.pauses.some((pause) => isWorkdayErrorPauseId(pause.fieldId) && pause.status === "open")) {
    pauses.push(blockedPause(walk.steps.at(-1)?.name ?? "the application", walk.errors.length ? walk.errors : ["unknown error"]));
  }
  const open = pauses.some((pause) => pause.status === "open");
  return { status: walk.outcome === "review" && !open ? "awaiting-approval" : "paused-needs-input", pauses };
}

async function startWorkdayRun(
  database: DatabaseSync,
  input: {
    jobId: string; candidateId: string; applicationUrl: string; posting: JobPosting; current: CurrentPackage; variantId: string; automatic: boolean;
    lock: ApplicationProfile | null;
  },
  options: {
    dataDir: string; openPage?: PageFactory; renderPdf: PdfRenderer; voiceDrafter?: VoiceDrafter | null; account: WorkdayRunContext["account"];
    standing: StandingConsentSettings;
  }
): Promise<RunReport> {
  const openPage = options.openPage ?? ((url: string) => openProfilePage(url, options.dataDir, createWorkdayPage));
  const drafter = options.voiceDrafter === undefined ? createDefaultVoiceDrafter({ dataDir: options.dataDir, database }) : options.voiceDrafter;
  const page = asWorkdayPage(await openPage(input.applicationUrl));
  try {
    const context = workdayContext(database, {
      jobId: input.jobId, candidateId: input.candidateId, posting: input.posting, variantId: input.variantId,
      packageAnswers: input.current.package.answers.map((answer) => ({ prompt: answer.prompt, text: answer.text }))
    }, options.dataDir, options.renderPdf, drafter, new Map(), options.account, options.standing, input.lock === "transcript", input.lock);
    const walk = await walkWorkdayWithEvidence(database, page, input.applicationUrl, context, "fill", {
      dataDir: options.dataDir, run: { id: null, jobId: input.jobId }, account: options.account
    });
    logStandingAcceptances(database, input.jobId, walk.decisions);
    const { status, pauses } = workdayOutcome(walk);
    setJobStatus(database, input.jobId, null, "APPLYING", input.automatic
      ? "Workday run started automatically from the verified package; your approval is required before submission."
      : "Workday run started from the approved package.");
    const now = new Date().toISOString();
    const run = saveBrowserRun(database, {
      id: randomUUID(), jobId: input.jobId, applicationUrl: input.applicationUrl, status, packageId: input.current.package.id,
      variantId: input.variantId, baseResumeId: uploadedBaseResumeId(walk.decisions), applicationProfile: walk.transcript ? "transcript" : "default", atsKind: "workday", atsConfidence: 1, suggestedAtsKind: null, atsConfirmed: true,
      decisions: walk.decisions, pauses, submittedAnswers: null, confirmationText: null, submissionApprovedAt: null, createdAt: now, updatedAt: now
    });
    if (walk.outcome === "blocked") {
      await saveWorkdayEvidenceQuietly({
        database, dataDir: options.dataDir, run: { id: run.id, jobId: run.jobId }, page, outcome: "workday-errors",
        detail: workdayErrorsDetail(walk), errors: walk.workdayErrors,
        secrets: workdayAccountSecrets(options.account, input.applicationUrl)
      });
    }
    return { run, form: { url: page.url(), title: await page.title(), fields: [] }, applied: countApplied(walk.decisions) };
  } finally {
    await page.close();
  }
}

async function continueWorkdayRun(
  database: DatabaseSync,
  run: BrowserRun,
  options: {
    dataDir: string; openPage?: PageFactory; renderPdf: PdfRenderer; voiceDrafter?: VoiceDrafter | null; mode: "fill" | "submit";
    account: WorkdayRunContext["account"];
    /** The company's pinned profile on the auto-submit path; null on candidate-started steps. */
    lock: ApplicationProfile | null;
    standing: StandingConsentSettings;
  }
): Promise<{ walk: WorkdayWalkResult; url: string; title: string }> {
  const posting = getJobPosting(database, run.jobId);
  const current = getCurrentPackage(database, run.jobId);
  if (!posting || !current) throw new Error("The posting or its package is missing.");
  const openPage = options.openPage ?? ((url: string) => openProfilePage(url, options.dataDir, createWorkdayPage));
  const drafter = options.voiceDrafter === undefined ? createDefaultVoiceDrafter({ dataDir: options.dataDir, database }) : options.voiceDrafter;
  const answers = new Map(run.pauses.filter((pause) => pause.status === "answered" && pause.answer !== null).map((pause) => [pause.fieldId, pause.answer!]));
  const page = asWorkdayPage(await openPage(run.applicationUrl));
  const context = workdayContext(database, {
    jobId: run.jobId, candidateId: LOCAL_CANDIDATE_ID, posting, variantId: run.variantId,
    packageAnswers: current.package.answers.map((answer) => ({ prompt: answer.prompt, text: answer.text }))
  }, options.dataDir, options.renderPdf, drafter, answers, options.account, options.standing,
  run.applicationProfile === "transcript" || usesTranscript(run.decisions), options.lock);
  try {
    const target = { id: run.id, jobId: run.jobId };
    const walk = await walkWorkdayWithEvidence(database, page, run.applicationUrl, context, options.mode, {
      dataDir: options.dataDir, run: target, account: options.account
    }, options.mode === "submit" ? readWorkdayConfirmation : undefined);
    logStandingAcceptances(database, run.jobId, walk.decisions, run.decisions);
    if (walk.outcome === "blocked") {
      await saveWorkdayEvidenceQuietly({
        database, dataDir: options.dataDir, run: target, page, outcome: "workday-errors",
        detail: workdayErrorsDetail(walk), errors: walk.workdayErrors,
        secrets: workdayAccountSecrets(options.account, run.applicationUrl)
      });
    }
    return { walk, url: page.url(), title: await page.title() };
  } finally {
    await page.close();
  }
}

function workdayErrorsDetail(walk: WorkdayWalkResult): string {
  return `Workday could not save ${walk.steps.at(-1)?.name ?? "the application"}.`;
}

/**
 * Values evidence must never store for this run: the account email, and the
 * host's saved email and password. Read after a hold, when the password is
 * saved; the account email alone when the accounts file cannot be read.
 */
function workdayAccountSecrets(account: WorkdayRunContext["account"], applicationUrl: string): string[] {
  if (!account) return [];
  const secrets = [account.runtime.email];
  try {
    const location = parseWorkdayUrl(applicationUrl);
    const entry = location ? getWorkdayAccount(account.runtime.file, location.host) : null;
    if (entry) secrets.push(entry.email, entry.password ?? "");
  } catch {
    return [account.runtime.email].filter(Boolean);
  }
  return secrets.filter(Boolean);
}

/**
 * walkWorkday that saves evidence when the account step holds the host
 * (WorkdayAccountHeld), with the page still open, then rethrows. A
 * candidate-started run that finds Workday signed out saves nothing.
 */
async function walkWorkdayWithEvidence(
  database: DatabaseSync,
  page: WorkdayPage,
  applicationUrl: string,
  context: WorkdayRunContext,
  mode: "fill" | "submit",
  evidence: { dataDir: string; run: { id: string | null; jobId: string }; account: WorkdayRunContext["account"] },
  confirm?: (page: WorkdayPage) => Promise<string>
): Promise<WorkdayWalkResult> {
  try {
    return await walkWorkday(page, applicationUrl, context, mode, confirm);
  } catch (error) {
    if (error instanceof WorkdayAccountHeld) {
      await saveWorkdayEvidenceQuietly({
        database, dataDir: evidence.dataDir, run: evidence.run, page, outcome: "workday-account", detail: error.message,
        secrets: workdayAccountSecrets(evidence.account, applicationUrl)
      });
    }
    throw error;
  }
}

/** Workday confirms on the page after Submit; nothing counts as submitted without it. */
async function readWorkdayConfirmation(page: WorkdayPage): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = await page.bodyText();
    if (/application (has been |was )?submitted|thank you for (applying|your application)|successfully submitted|congratulations/i.test(body)) {
      return body.replace(/\s+/g, " ").trim().slice(0, 2_000);
    }
    if (Date.now() >= deadline) {
      throw new Error("Submit was clicked but Workday showed no confirmation. Check the application on the site before retrying; the run is not marked submitted.");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Decisions whose field must still be on the page at submit. */
const SHOWN_ACTIONS = new Set(["fill", "choose", "check", "upload", "keep"]);

function countApplied(decisions: FillDecision[]): number {
  return decisions.filter((decision) => ["fill", "choose", "check", "upload"].includes(decision.action)).length;
}

export { WorkdaySignInRequired };
