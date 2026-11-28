import { ATS_KIND_LABELS, type BrowserField, type FillDecision, type PauseRecord, type RecognizedForm } from "@internship-agent/domain";

import type { CoveringDialog } from "./announcement-dialog";
import type { AshbySubmitDiagnostics } from "./ats/ashby-diagnostics";
import type { AshbySubmitNetwork } from "./ats/ashby-network";
import { classifyFieldRole, isSensitiveRole } from "./ats/field-roles";
import { SubmissionHeld } from "./challenge";
import { stripRequiredMarker } from "./form-recognition";
import type { BrowserPage } from "./handshake-executor";

/**
 * What a submit click led to when no confirmation was recognized. Read from
 * the page deterministically; no model participates.
 *
 * - `field-errors`: the site marked fields invalid that were not invalid
 *   before the click, and the submit control is still shown, so nothing was
 *   sent. The run waits for the candidate with the approval withdrawn.
 * - `refused`: the site showed an error banner instead of a confirmation.
 * - `challenged`: a CAPTCHA the candidate would see appeared after the click.
 * - `verification-code`: the site asked for a security code it emailed
 *   (Greenhouse's step); the agent reads it from the candidate's mailbox,
 *   else the run waits for the candidate.
 * - `unknown`: nothing recognizable; the run fails closed.
 *
 * Three outcomes are Workday stops, not submit clicks:
 * - `workday-account`: the Workday account step (sign-in or create account) held the host.
 * - `workday-errors`: Workday would not save an application step and showed errors.
 * - `workday-entry`: the Workday application did not open (a closed posting, a security check, or neither).
 *
 * Two are iCIMS stops, not submit clicks either:
 * - `icims-account`: the iCIMS account step held the host.
 * - `icims-application`: the agent reached iCIMS's application after the account step and stopped there.
 *
 * One is a fill stop, not a submit click either (Track 39):
 * - `covering-dialog`: a modal dialog covered the form while the agent filled it ("a dialog covers the form").
 */
export type PostSubmitOutcome =
  | "field-errors" | "refused" | "challenged" | "verification-code" | "unknown" | "workday-account" | "workday-errors" | "workday-entry"
  | "icims-account" | "icims-application" | "covering-dialog";

/** A field the page marks invalid: the control's id (else name, else data-ia-control tag), its label, and the site's error text. */
export type InvalidField = { ref: string | null; label: string; error: string };

/**
 * What the page showed after an unconfirmed submit click, kept in memory
 * until the agent writes it to the run's local evidence folder. Never sent to
 * Discord or a model.
 */
export type PostSubmitEvidence = {
  outcome: PostSubmitOutcome;
  /** The final URL with its query and fragment removed. */
  url: string;
  /** Raw visible text, capped at 20,000 characters; the writer redacts it. */
  bodyText: string;
  invalidFields: InvalidField[];
  alertText: string;
  /** The visible challenge's detail, when one appeared. */
  challenge: string | null;
  /** What the agent says happened (a fixed or agent-written phrase, such as a Workday hold reason). */
  detail?: string | null;
  /**
   * True once an emailed security code was typed into the page: the evidence
   * writer then takes no screenshot, and every text was scrubbed of the code.
   */
  securityCodeEntered?: boolean;
  /** Ashby only: the watch's record of Ashby's GraphQL calls and reCAPTCHA token requests (names, statuses, booleans, error codes and messages; never bodies). */
  ashbyNetwork?: AshbySubmitNetwork | null;
  /**
   * Ashby only (ats/ashby-diagnostics.ts): the watch's read-only diagnostics of
   * the submit click (click target and hit test, request hosts and paths,
   * console and page errors, visible errors), sanitized of the page's own
   * values; kept in the run's local evidence only, never sent anywhere.
   */
  ashbyDiagnostics?: AshbySubmitDiagnostics | null;
  /**
   * `covering-dialog` only (Track 39): the visible modal dialogs over the
   * form (announcement-dialog.ts readCoveringDialogsIn), raw; the writer
   * redacts every text.
   */
  coveringDialogs?: CoveringDialog[] | null;
};

const MAX_BODY_TEXT = 20_000;

/** The URL without its query and fragment; "" when it does not parse. */
export function stripUrlQuery(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

const GREENHOUSE_HOSTS = new Set(["job-boards.greenhouse.io", "job-boards.eu.greenhouse.io", "boards.greenhouse.io", "boards.eu.greenhouse.io"]);
const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const ASHBY_HOSTS = new Set(["jobs.ashbyhq.com", "ashbyhq.com"]);
const DOVER_HOSTS = new Set(["app.dover.io", "jobs.dover.com", "dover.io", "dover.com"]);

/** A Greenhouse job-board page (new or classic board, US or EU). */
export function isGreenhouseBoardUrl(url: string): boolean {
  try {
    return GREENHOUSE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A site's own confirmation address: Greenhouse's `/confirmation` path or
 * `?confirmation` parameter, Lever's `/thanks` path, Ashby's `/submitted` or
 * `/confirmation`, and Dover's `/applied` or `/confirmation`. Any other host
 * is never a confirmation by URL.
 */
export function isConfirmationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
  if (GREENHOUSE_HOSTS.has(host)) return path.endsWith("/confirmation") || parsed.searchParams.has("confirmation");
  if (LEVER_HOSTS.has(host)) return path.endsWith("/thanks");
  if (ASHBY_HOSTS.has(host) || host.endsWith(".ashbyhq.com")) {
    return path.endsWith("/confirmation") || path.endsWith("/submitted") || path.endsWith("/thanks") || parsed.searchParams.has("submitted") || parsed.searchParams.has("confirmation");
  }
  if (DOVER_HOSTS.has(host) || host.endsWith(".dover.com") || host.endsWith(".dover.io")) {
    return path.endsWith("/confirmation") || path.endsWith("/applied") || path.endsWith("/thanks") || parsed.searchParams.has("applied") || parsed.searchParams.has("confirmation");
  }
  return false;
}

/** A confirmation URL reached because of the click (the page before it was not one), query stripped; null otherwise. */
export function readNewConfirmationUrl(before: string, after: string): string | null {
  return !isConfirmationUrl(before) && isConfirmationUrl(after) ? stripUrlQuery(after) : null;
}

export function invalidFieldKey(field: InvalidField): string {
  return `${field.ref ?? ""}|${field.label}|${field.error}`;
}

const BENIGN_HEADER_PREFIXES = /^(?:apply\s*[-–—:]|application\s*[-–—:]|job\s+application\s*[-–—:])/i;
const BENIGN_HEADER_EXACT = /^(?:apply|application|job\s+application)$/i;
const ERROR_INDICATORS = /\b(?:error|errors|problem|failed|failure|invalid|required|sorry|unable|cannot|denied|wrong|rejected|unsuccessful|already applied|deadline|closed)\b/i;

/**
 * Whether the alert text represents a benign page header or title (e.g. Rippling's
 * aria-live job title banner "Apply - Engineering Intern (Summer 2027)") rather than
 * a genuine error or submission refusal.
 */
export function isBenignAlertText(alertText: string, context?: { pageTitle?: string; headingText?: string }): boolean {
  const trimmed = alertText.trim();
  if (!trimmed) return true;
  if (ERROR_INDICATORS.test(trimmed)) {
    return false;
  }
  if (BENIGN_HEADER_PREFIXES.test(trimmed) || BENIGN_HEADER_EXACT.test(trimmed)) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (context?.pageTitle) {
    const title = context.pageTitle.trim().toLowerCase();
    if (title && (title === lower || title.includes(lower) || lower.includes(title))) {
      return true;
    }
  }
  if (context?.headingText) {
    const heading = context.headingText.trim().toLowerCase();
    if (heading && (heading === lower || heading.includes(lower) || lower.includes(heading))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the alert text indicates a genuine refusal rather than empty or benign page title text.
 */
export function isRefusalAlert(alertText: string, context?: { pageTitle?: string; headingText?: string }): boolean {
  const trimmed = alertText.trim();
  if (!trimmed) return false;
  return !isBenignAlertText(trimmed, context);
}

/**
 * The outcome of a click that showed no confirmation and no challenge by the
 * deadline. Field errors need at least one invalid field that was not invalid
 * before the click and a submit control still shown; otherwise a genuine error
 * alert means refused, and nothing/benign alert means unknown.
 */
export function classifyUnconfirmed(input: {
  invalidBefore: InvalidField[];
  invalidAfter: InvalidField[];
  submitShown: boolean;
  alertText: string;
  pageTitle?: string;
  headingText?: string;
}): "field-errors" | "refused" | "unknown" {
  const before = new Set(input.invalidBefore.map(invalidFieldKey));
  const fresh = input.invalidAfter.some((field) => !before.has(invalidFieldKey(field)));
  if (fresh && input.submitShown) return "field-errors";
  if (isRefusalAlert(input.alertText, { pageTitle: input.pageTitle, headingText: input.headingText })) return "refused";
  return "unknown";
}

/**
 * Whether a closed application dialog transition qualifies as a confirmed submission.
 * On Dover and Ashby, if an application modal dialog closes without field validation errors,
 * alert refusals, or CAPTCHA challenges, this transition confirms the submission.
 */
export function isDialogCloseConfirmed(input: {
  dialogClosed: boolean;
  invalidBefore: InvalidField[];
  invalidAfter: InvalidField[];
  submitShown: boolean;
  alertText: string;
  isDoverOrAshby?: boolean;
}): boolean {
  if (!input.dialogClosed) return false;
  const outcome = classifyUnconfirmed({
    invalidBefore: input.invalidBefore,
    invalidAfter: input.invalidAfter,
    submitShown: input.submitShown,
    alertText: input.alertText
  });
  if (outcome !== "unknown") return false;
  return Boolean(input.isDoverOrAshby);
}

/** The site marked fields invalid after the click, so nothing was sent: the run waits for the candidate. */
export class SubmissionNeedsInput extends SubmissionHeld {
  constructor(message: string, evidence: PostSubmitEvidence, readonly invalidFields: InvalidField[]) {
    super(message, evidence);
  }
}

/** The click showed nothing recognizable. Not a hold: the pipeline lists it under errors, and it is never retried. */
export class SubmissionUnconfirmed extends Error {
  constructor(message: string, readonly evidence: PostSubmitEvidence) {
    super(message);
  }
}

/**
 * Track 80: a submit the auto-submit policy clicked on a site whose confirmation page the agent has not captured
 * (`uncapturedSiteRun`): the page read as a confirmation, or the site then asked for an emailed code the agent cannot
 * enter there. Not a hold for the candidate: the run is failed with its approval kept and its evidence saved, so the
 * hold refresh holds it as a possible submission until a receipt check, and it is never submitted again automatically.
 */
export class SubmissionUnverified extends SubmissionUnconfirmed {}

export const UNVERIFIED_CONFIRMATION_DETAIL = "Auto-submit policy: the page read as a confirmation, but this site's confirmation page was never captured, so the outcome waits for a receipt check.";
export const UNVERIFIED_CODE_DETAIL = "Auto-submit policy: after the submit click the site asked for an emailed code on a site whose confirmation page was never captured, so the outcome waits for a receipt check.";

/** The SubmissionUnverified for a policy submit on such a site; `evidence` is the code step's capture, or null to capture the confirmation page now. */
export async function unverifiedSubmission(
  page: BrowserPage,
  run: { id: string; atsKind: string; stepped: boolean },
  evidence: PostSubmitEvidence | null
): Promise<SubmissionUnverified> {
  const label = (ATS_KIND_LABELS as Record<string, string>)[run.atsKind];
  const site = run.stepped ? "the several-page application" : label ? `the ${label} application` : "the application";
  let host = "";
  try {
    host = new URL(page.url()).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const ref = run.id.slice(0, 8);
  const tail = `so it is held as a possible submission until a receipt check finds the site's receipt (pnpm mail:scan --receipt ${ref}). It is never submitted again automatically, and the run is not marked submitted.`;
  if (evidence) {
    return new SubmissionUnverified(
      `The auto-submit policy clicked the final submit of ${site} at ${host}, and the site then asked for an emailed code the agent cannot enter there; the application may have been sent, ${tail}`,
      { ...evidence, detail: evidence.detail ?? UNVERIFIED_CODE_DETAIL }
    );
  }
  const captured = await capturePostSubmitEvidence(page, "unknown", { detail: UNVERIFIED_CONFIRMATION_DETAIL });
  return new SubmissionUnverified(
    `The auto-submit policy clicked the final submit of ${site} at ${host} and the page read as a confirmation, but the agent has not captured this site's confirmation page yet, ${tail}`,
    captured
  );
}

export type SecurityCodeLookupResult =
  | { kind: "found"; code: string }
  /** No matching code in time. */
  | { kind: "none" }
  /** More than one distinct code. */
  | { kind: "ambiguous" }
  /** No mailbox is set up. */
  | { kind: "no-mailbox" }
  /** The mailbox could not be opened or read. */
  | { kind: "unavailable" }
  /** Not a Greenhouse page. */
  | { kind: "unsupported" };

/**
 * Finds the code a site emailed after the submit click; never throws for a
 * missing code. Implemented in packages/agent: the browser package never
 * reads mail.
 */
export type SecurityCodeLookup = (request: { url: string; clickedAt: Date }) => Promise<SecurityCodeLookupResult>;

/**
 * The site asked for a security code it emailed and the agent could not
 * enter one, so nothing was sent: the run waits for the candidate with the
 * approval withdrawn.
 */
export class SubmissionCodeNotFound extends SubmissionHeld {}

/**
 * Thrown by the page adapter before any click when the code field would not
 * take the code; its messages are fixed phrases and never contain the code.
 */
export class SecurityCodeNotEntered extends Error {}

const CODE_HOLD_TAIL = " The run waits for you with the approval withdrawn; it is not marked submitted.";

export type SecurityCodeHoldKind = "none" | "ambiguous" | "no-mailbox" | "unavailable" | "unsupported" | "not-entered";

const CODE_HOLD_TEXT: Record<SecurityCodeHoldKind, string> = {
  none: "Greenhouse emailed a security code; it was not found in your mailbox in time, so nothing was sent.",
  ambiguous: "Greenhouse emailed a security code; it was not found unambiguously (more than one code arrived), so nothing was sent.",
  "no-mailbox": "Greenhouse emailed a security code; it was not found because no mailbox is set up (INTERNSHIP_AGENT_GMAIL_ADDRESS and _APP_PASSWORD), so nothing was sent.",
  unavailable: "Greenhouse emailed a security code; it was not found because the mailbox could not be read, so nothing was sent.",
  "not-entered": "Greenhouse emailed a security code; it was found but the code field did not take it, so nothing was sent.",
  unsupported: "The site asked for a security code it emailed; the agent reads only Greenhouse's security-code emails, so nothing was sent."
};

/** The fixed hold message for a security code the agent could not enter; it never contains the code. */
export function securityCodeHoldMessage(kind: SecurityCodeHoldKind): string {
  return CODE_HOLD_TEXT[kind] + CODE_HOLD_TAIL;
}

export const SECURITY_CODE_STILL_ASKED = "The agent entered the security code Greenhouse emailed, but the site still asks for it. Check the application on the site before retrying; the run is not marked submitted.";

const CODE_SENT = /\bcode\b[\s\S]{0,120}\b(?:sent|emailed|e-mailed|email|inbox)\b|\b(?:sent|emailed|e-mailed|email|inbox)\b[\s\S]{0,120}\bcode\b/i;

/**
 * The emailed security-code step: code inputs that were not there before the
 * click appeared after it, and the page says a code was sent by email. The
 * inputs are the strict signal; the text is a deliberately broad guard (the
 * real page's wording is not captured).
 */
export function isSecurityCodeStep(input: { codeInputsBefore: number; codeInputsAfter: number; bodyText: string }): boolean {
  if (input.codeInputsBefore !== 0 || input.codeInputsAfter <= 0) return false;
  return CODE_SENT.test(input.bodyText.replace(/\s+/g, " "));
}

/** The text with every case-insensitive occurrence of the secret replaced by "[code]"; unchanged when there is no secret. */
export function scrubSecret(text: string, secret: string | null): string {
  if (!secret) return text;
  return text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[code]");
}

/** A copy of the evidence with every text scrubbed of the secret, marked as taken after the code was typed. */
export function withoutSecret(evidence: PostSubmitEvidence, secret: string): PostSubmitEvidence {
  return {
    ...evidence,
    url: scrubSecret(evidence.url, secret),
    bodyText: scrubSecret(evidence.bodyText, secret),
    alertText: scrubSecret(evidence.alertText, secret),
    challenge: evidence.challenge === null ? null : scrubSecret(evidence.challenge, secret),
    ...(typeof evidence.detail === "string" ? { detail: scrubSecret(evidence.detail, secret) } : {}),
    invalidFields: evidence.invalidFields.map((field) => ({
      ref: field.ref === null ? null : scrubSecret(field.ref, secret),
      label: scrubSecret(field.label, secret),
      error: scrubSecret(field.error, secret)
    })),
    ...(evidence.ashbyDiagnostics
      ? {
        ashbyDiagnostics: {
          ...evidence.ashbyDiagnostics,
          clicks: evidence.ashbyDiagnostics.clicks.map((check) => ({ ...check, text: scrubSecret(check.text, secret) })),
          requests: evidence.ashbyDiagnostics.requests.map((entry) => ({ ...entry })),
          console: evidence.ashbyDiagnostics.console.map((entry) => ({ ...entry, text: scrubSecret(entry.text, secret) })),
          visibleErrors: evidence.ashbyDiagnostics.visibleErrors.map((text) => scrubSecret(text, secret))
        }
      }
      : {}),
    securityCodeEntered: true
  };
}

export const SECURITY_CODE_FIELD_ID = "site-security-code";

/**
 * The safeguard pause for a security code the agent could not enter. The
 * candidate never answers it (an answer would store the code) and the run is
 * never re-approved: it is reopened or retried, or finished on the site by hand.
 */
export function securityCodePause(message: string, runRef: string): { decision: FillDecision; pause: PauseRecord } {
  // Greenhouse's hold is reopened as not submitted (its answered pauses block a plain retry); another site's is retried.
  const command = message === securityCodeHoldMessage("unsupported")
    ? `Retry it with pnpm pipeline:retry --run ${runRef}`
    : `Reopen it with pnpm pipeline:retry --run ${runRef} --reopen-unsubmitted --reason "<why>"`;
  const question = clip(`${message} ${command}, or finish the application on the site yourself.`, 500);
  return {
    decision: {
      fieldId: SECURITY_CODE_FIELD_ID,
      action: "pause",
      value: null,
      basis: null,
      reason: question,
      pause: { question, key: null, scope: null, safeguard: true }
    },
    pause: {
      fieldId: SECURITY_CODE_FIELD_ID,
      label: "Emailed security code",
      question,
      suggestedKey: null,
      suggestedScope: null,
      safeguard: true,
      sensitive: false,
      upload: false,
      status: "open",
      answer: null,
      draft: null
    }
  };
}

/** The post-submit evidence a submit error carries, if any. */
export function postSubmitEvidenceOf(error: unknown): PostSubmitEvidence | null {
  if (error instanceof SubmissionHeld || error instanceof SubmissionUnconfirmed) return error.evidence ?? null;
  return null;
}

/**
 * Reads what the page shows after the click. Never throws: a piece the page
 * cannot give is left empty. Values the caller already read are reused.
 */
export async function capturePostSubmitEvidence(
  page: BrowserPage,
  outcome: PostSubmitOutcome,
  known: {
    bodyText?: string;
    invalidFields?: InvalidField[];
    alertText?: string;
    challenge?: string | null;
    detail?: string | null;
    ashbyNetwork?: AshbySubmitNetwork | null;
    ashbyDiagnostics?: AshbySubmitDiagnostics | null;
  } = {}
): Promise<PostSubmitEvidence> {
  let url = "";
  try {
    url = stripUrlQuery(page.url());
  } catch {
    url = "";
  }
  let bodyText = known.bodyText;
  if (bodyText === undefined) {
    try {
      bodyText = await page.bodyText();
    } catch {
      bodyText = "";
    }
  }
  let invalidFields = known.invalidFields;
  if (invalidFields === undefined) {
    try {
      invalidFields = page.invalidFields ? await page.invalidFields() : [];
    } catch {
      invalidFields = [];
    }
  }
  let alertText = known.alertText;
  if (alertText === undefined) {
    try {
      alertText = page.alertText ? (await page.alertText()).trim() : "";
    } catch {
      alertText = "";
    }
  }
  if (isBenignAlertText(alertText)) {
    alertText = "";
  }
  let ashbyNetwork = known.ashbyNetwork;
  if (ashbyNetwork === undefined) {
    try {
      ashbyNetwork = page.ashbySubmitNetwork ? await page.ashbySubmitNetwork() : null;
    } catch {
      ashbyNetwork = null;
    }
  }
  let ashbyDiagnostics = known.ashbyDiagnostics;
  if (ashbyDiagnostics === undefined) {
    try {
      ashbyDiagnostics = page.ashbySubmitDiagnostics ? await page.ashbySubmitDiagnostics() : null;
    } catch {
      ashbyDiagnostics = null;
    }
  }
  return {
    outcome,
    url,
    bodyText: bodyText.slice(0, MAX_BODY_TEXT),
    invalidFields,
    alertText,
    challenge: known.challenge ?? null,
    detail: known.detail ?? null,
    ...(ashbyNetwork ? { ashbyNetwork } : {}),
    ...(ashbyDiagnostics ? { ashbyDiagnostics } : {})
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

function normalizedLabel(label: string): string {
  return stripRequiredMarker(label.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()).label;
}

function fieldFor(form: RecognizedForm, invalid: InvalidField): BrowserField | null {
  if (invalid.ref) {
    const byId = form.fields.find((field) => field.id === invalid.ref);
    if (byId) return byId;
  }
  const wanted = normalizedLabel(invalid.label);
  if (!wanted) return null;
  const byLabel = form.fields.filter((field) => normalizedLabel(field.label) === wanted);
  return byLabel.length === 1 ? byLabel[0]! : null;
}

/**
 * A pause per field the site marked invalid after the click, carrying the
 * site's error text ("School: This field is required."). A field found on the
 * form (by id, else by a unique label) pauses on its own id; one the agent
 * cannot find becomes a `site-error-<n>` safeguard the candidate fixes in the
 * browser. Existing pauses for the same field are replaced.
 */
export function invalidFieldPauses(
  form: RecognizedForm,
  decisions: FillDecision[],
  pauses: PauseRecord[],
  invalid: InvalidField[]
): { decisions: FillDecision[]; pauses: PauseRecord[] } {
  let nextDecisions = decisions;
  let nextPauses = pauses;
  let unmatched = 0;
  for (const entry of invalid) {
    const error = entry.error.trim() || "The site marked this field invalid.";
    const field = fieldFor(form, entry);
    let pause: PauseRecord;
    if (field) {
      const question = clip(`${field.label}: ${error}`, 500);
      pause = {
        fieldId: field.id,
        label: field.label,
        question,
        suggestedKey: null,
        suggestedScope: null,
        safeguard: false,
        sensitive: isSensitiveRole(classifyFieldRole(field)),
        upload: field.kind === "file",
        status: "open",
        answer: null,
        draft: null,
        fieldKind: field.kind,
        ...(field.options?.length ? { options: field.options } : {})
      };
    } else {
      unmatched += 1;
      const label = clip(entry.label.trim() || "Unnamed field", 300);
      const question = clip(`${label}: ${error}. The agent could not find this field on the form; fix it in your browser.`, 500);
      pause = {
        fieldId: `site-error-${unmatched}`,
        label,
        question,
        suggestedKey: null,
        suggestedScope: null,
        safeguard: true,
        sensitive: false,
        upload: false,
        status: "open",
        answer: null,
        draft: null
      };
    }
    const decision: FillDecision = {
      fieldId: pause.fieldId,
      action: "pause",
      value: null,
      basis: null,
      reason: pause.question,
      pause: { question: pause.question, key: null, scope: null, safeguard: pause.safeguard }
    };
    nextDecisions = nextDecisions.some((existing) => existing.fieldId === decision.fieldId)
      ? nextDecisions.map((existing) => (existing.fieldId === decision.fieldId ? decision : existing))
      : [...nextDecisions, decision];
    nextPauses = [...nextPauses.filter((existing) => existing.fieldId !== pause.fieldId), pause];
  }
  return { decisions: nextDecisions, pauses: nextPauses };
}
