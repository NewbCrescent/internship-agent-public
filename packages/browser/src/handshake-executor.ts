import type { Locator, Page } from "playwright-core";

import { promptSearchTerms, type AtsKind, type BrowserField, type FillDecision, type PauseRecord, type RecognizedForm, type StandingConsentSettings } from "@internship-agent/domain";

import { dismissAnnouncementDialog, readCoveringDialogsIn, visibleModalDialogIn, type CoveringDialog } from "./announcement-dialog";
import { chooseApplyEntry, clickApplyEntry, dismissCookieBanner, embedSourcesOf, greenhouseEmbedTarget, icimsPostingPage, type ApplyEntryCandidate } from "./apply-entry";
import { isDoverOrAshby } from "./ats/adapters";
import {
  ASHBY_ACCEPTED_CONFIRMATION,
  ASHBY_BLOCKED_MESSAGE,
  ashbyFormErrorsMessage,
  ashbyNetworkInvalidFields,
  ashbyNetworkVerdict,
  ashbySubmitSentAfter,
  createAshbyNetworkRecorder,
  type AshbyNetworkRecorder,
  type AshbySubmitNetwork
} from "./ats/ashby-network";
import {
  ASHBY_NOT_SENT_DETAIL,
  ashbyClickSentNothing,
  ashbyNotSentMessage,
  createAshbyDiagnosticsRecorder,
  describeSubmitTargetIn,
  readAshbyVisibleErrorsIn,
  readFormValuesIn,
  scrubValuesFrom,
  type AshbyDiagnosticsRecorder,
  type AshbySubmitDiagnostics
} from "./ats/ashby-diagnostics";
import {
  ASHBY_BUSY_DETAIL,
  ASHBY_RECLICK_SETTLE_MS,
  ASHBY_SAVE_SETTLE_MS,
  ASHBY_SPAM_CHECK_DETAIL,
  ASHBY_SPAM_CHECK_MESSAGE,
  ashbyBusyMessage,
  EMPTY_ASHBY_SUBMIT_STATE,
  isAshbyApplication,
  nextAshbyStep,
  readAshbySubmitStateIn,
  watchAshbySubmitFeedbackIn,
  type AshbySubmitState
} from "./ats/ashby-submit";
import { classifyFieldRole, isSensitiveRole } from "./ats/field-roles";
import { matchSuggestion } from "./autofill-planner";
import { findVisibleChallengeIn, isTurnstileFrameSource, SubmissionChallenged, SubmissionRefused, type VisibleChallenge } from "./challenge";
import { isSubmitControl, readableText, readNewConfirmation, recognizeFields, recognizeForm, waitForStableControls, type RawControl } from "./form-recognition";
import {
  capturePostSubmitEvidence,
  classifyUnconfirmed,
  isSecurityCodeStep,
  postSubmitEvidenceOf,
  readNewConfirmationUrl,
  scrubSecret,
  SECURITY_CODE_STILL_ASKED,
  SecurityCodeNotEntered,
  securityCodeHoldMessage,
  stripUrlQuery,
  SubmissionCodeNotFound,
  SubmissionNeedsInput,
  SubmissionUnconfirmed,
  withoutSecret,
  type InvalidField,
  type PostSubmitEvidence,
  type SecurityCodeLookup,
  type SecurityCodeLookupResult
} from "./submission-outcome";
import { readStopRegionIn, type StopRegion, type StopRegionRequest } from "./stop-evidence";
import {
  clickStandingDialogButton,
  readStandingDialogsIn,
  standingDialogDecision,
  type StandingDialogAcceptance,
  type StandingDialogCandidate,
  type StandingDialogLeaveReason
} from "./standing-dialog";

/**
 * The minimal page surface the executor needs. Production passes a Playwright
 * adapter; tests pass an in-memory stub. Nothing here can click a submit
 * control except `submitAndConfirm`, which the orchestrator gates behind an
 * explicit human approval.
 */
export type BrowserPage = {
  url(): string;
  title(): Promise<string>;
  collectControls(): Promise<RawControl[]>;
  bodyText(): Promise<string>;
  fillField(field: BrowserField, value: string): Promise<void>;
  chooseOption(field: BrowserField, option: string): Promise<void>;
  setChecked(field: BrowserField, checked: boolean): Promise<void>;
  uploadFile(field: BrowserField, path: string): Promise<void>;
  clickSubmit(): Promise<void>;
  screenshot(path: string, options?: { fullPage?: boolean }): Promise<void>;
  close(): Promise<void>;
  /** Fields the page marks invalid, read from the DOM; [] when none. */
  invalidFields?(): Promise<InvalidField[]>;
  /**
   * The form's fields as the page shows them now, read without opening any list
   * (the read-back before a submit click); same ids as recognizeCurrentForm.
   */
  readFields?(): Promise<BrowserField[]>;
  /** Whether the terminal submit control is still shown. */
  submitControlShown?(): Promise<boolean>;
  /**
   * Handshake Quick apply: clicks the page's "Quick apply" button and scopes
   * every later read, fill, and submit to the "Apply to …" dialog. Resolves
   * false when the page shows no Quick apply button.
   */
  openApplicationDialog?(): Promise<boolean>;
  /** File names the open dialog already shows as attached. */
  attachedDocumentNames?(): Promise<string[]>;
  /** Whether the application dialog is still showing (after a submit click). */
  applicationDialogOpen?(): Promise<boolean>;
  /** Waits for a client-rendered form to finish drawing its fields. */
  waitForFormReady?(): Promise<void>;
  /** A CAPTCHA challenge the candidate would see, read from the DOM only (challenge.ts); null otherwise. */
  visibleChallenge?(): Promise<VisibleChallenge | null>;
  /**
   * The visible modal dialogs over the page (announcement-dialog.ts
   * readCoveringDialogsIn), read from the DOM without clicking anything; []
   * when none (Track 39).
   */
  coveringDialogs?(): Promise<CoveringDialog[]>;
  /** Visible modal dialogs with their full text and tagged buttons (standing-dialog.ts readStandingDialogsIn); [] when none (Track 40). */
  standingDialogs?(): Promise<StandingDialogCandidate[]>;
  /** Clicks a dialog button standingDialogs tagged, after checking its name (Track 40). */
  clickDialogButton?(tag: string, name: string): Promise<"hidden" | "still-shown" | "failed">;
  /** Track 42: a bounded, sanitized excerpt of the page region a stop concerns (stop-evidence.ts readStopRegionIn), read without clicking, focusing, or typing; input values are never read. */
  stopRegion?(request: StopRegionRequest): Promise<StopRegion>;
  /** Visible error or alert text, read after a submit that showed no confirmation. */
  alertText?(): Promise<string>;
  /**
   * Text of the site's own post-submit success container (Ashby's
   * `.ashby-application-form-success-container`), read from the DOM; empty
   * when none is shown.
   */
  successText?(): Promise<string>;
  /**
   * Ashby only (ats/ashby-submit.ts): blurs the focused field, starts watching
   * for Ashby's busy notice, and waits `waitMs` so the answer saves finish
   * before a submit click.
   */
  settleAshbySaves?(waitMs: number): Promise<void>;
  /**
   * Ashby only: whether Ashby's busy notice appeared since the last settle
   * (and is still shown), and its failure container's text.
   */
  ashbySubmitState?(): Promise<AshbySubmitState>;
  /**
   * Ashby only (ats/ashby-network.ts): starts recording Ashby's GraphQL calls
   * and reCAPTCHA token requests: operation names, HTTP statuses, booleans,
   * error codes and messages; never a request or response body.
   */
  watchAshbyNetwork?(): Promise<void>;
  /**
   * What the Ashby watch recorded, waiting at most waitMs (default 2,000) for
   * answers still being read; null when no watch was started.
   */
  ashbySubmitNetwork?(waitMs?: number): Promise<AshbySubmitNetwork | null>;
  /**
   * Ashby only (ats/ashby-diagnostics.ts): read-only diagnostics kept by the
   * same watch (each submit click's target and hit test, request hosts and
   * paths after the first click, console and page errors, visible errors),
   * sanitized of the page's own values; null when no watch was started.
   */
  ashbySubmitDiagnostics?(): Promise<AshbySubmitDiagnostics | null>;
  /**
   * Follows the posting's Apply entry once (chooseApplyEntry), or opens the
   * Greenhouse application the page embeds (greenhouseEmbedTarget), and
   * returns the URL it reached, or null when the page has none. Looks again
   * every 500 ms for up to 8 s (entries drawn after the load event); a
   * clicked button that opens a new tab is followed only to the same site, the
   * same company domain, or a known ATS host (clickApplyEntry).
   */
  followApplyEntry?(): Promise<string | null>;
  /**
   * Visible inputs of a site's emailed security-code step (Greenhouse's
   * `#security-input-<n>` boxes, an input with autocomplete="one-time-code",
   * or one named or labelled for a security or verification code); 0 when none.
   */
  securityCodeInputs?(): Promise<number>;
  /**
   * Types the emailed code into those inputs (one character per box when
   * there are several), then clicks the step's own submit control. Throws
   * SecurityCodeNotEntered (before any click) when the field does not take
   * it; no error ever carries the code.
   */
  submitSecurityCode?(code: string): Promise<void>;
};

export async function recognizeCurrentForm(page: BrowserPage): Promise<RecognizedForm> {
  await page.waitForFormReady?.();
  // An iCIMS posting page: the career-site wrapper's boxes (a site search, a newsletter signup) are never the
  // application, which starts behind the posting's Apply entry, so none is read (the Apply entry is then followed).
  const controls = icimsPostingPage(page.url()) ? [] : await page.collectControls();
  return recognizeForm(page.url(), await page.title(), controls);
}

/**
 * A field the page would not take a known value into: a type-ahead with no
 * matching suggestion, a choice that is not a text box, an option that is not
 * there. The run pauses on the field instead of stopping.
 */
export class FieldUnfillable extends Error {}

/** The reason a bare list is left unfilled when a modal dialog still covers the form (clickBareList). */
export const COVERING_DIALOG_REASON = "a dialog covers the form";

/** A field applyDecisions could not fill, with a plain reason (never a raw Playwright message). */
export type UnfilledField = { fieldId: string; reason: string };

function unfilledReason(error: unknown): string {
  if (error instanceof FieldUnfillable) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "the field did not respond in time";
  return "the page did not accept the value";
}

/** The pause that replaces a decision applyDecisions could not apply. */
export function unfilledPause(field: BrowserField, reason: string, runId?: string): { decision: FillDecision; pause: PauseRecord } {
  // A covering dialog is never clicked through (Track 39): the candidate is told to look at it first, and where the capture is.
  const question = (reason === COVERING_DIALOG_REASON
    ? `The agent could not fill "${field.label}": ${reason}, and the agent does not click through or close such a dialog. Open the application in your browser to see what the dialog asks${runId ? ` (pnpm run:evidence --run ${runId.slice(0, 8)} shows what the agent saw)` : ""}, then answer it here, or fill it in the browser.`
    : `The agent could not fill "${field.label}": ${reason}. Answer it here, or fill it in the browser.`).slice(0, 500);
  return {
    decision: {
      fieldId: field.id,
      action: "pause",
      value: null,
      basis: null,
      reason: question,
      pause: { question, key: null, scope: null, safeguard: false }
    },
    pause: {
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
    }
  };
}

/** The safeguard pause's field id when approved answers are no longer on the form at the submit click. */
export const FORM_CHANGED_FIELD = "form-changed";

/** Decisions that put a value on the page. */
const VALUE_ACTIONS: ReadonlySet<FillDecision["action"]> = new Set(["fill", "choose", "check", "upload"]);

/**
 * Field ids of decisions that put a value on the page but whose field the form does not show. Before the submit
 * click such a decision would be skipped silently (Track 25: Ashby renamed a single-choice question on every load).
 */
export function absentDecisionFields(form: RecognizedForm, decisions: FillDecision[]): string[] {
  const present = new Set(form.fields.map((field) => field.id));
  return decisions.filter((decision) => VALUE_ACTIONS.has(decision.action) && !present.has(decision.fieldId)).map((decision) => decision.fieldId);
}

/** The safeguard pause that holds a run whose approved answers are no longer on the form; nothing is clicked. */
export function formChangedPause(count: number): { decision: FillDecision; pause: PauseRecord } {
  const question = `${count} answer(s) the approval covered are no longer on the application form, so nothing was clicked. Check the application in your browser, or cancel this run and start it again.`.slice(0, 500);
  return {
    decision: { fieldId: FORM_CHANGED_FIELD, action: "pause", value: null, basis: null, reason: question, pause: { question, key: null, scope: null, safeguard: true } },
    pause: {
      fieldId: FORM_CHANGED_FIELD, label: "Application form", question, suggestedKey: null, suggestedScope: null,
      safeguard: true, sensitive: false, upload: false, status: "open", answer: null, draft: null
    }
  };
}

/** Option text compared as the page shows it: invisible characters dropped, spaces collapsed, case ignored. */
function choiceText(value: string | null | undefined): string {
  return readableText(value).replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

/**
 * Read-back before the submit click: every `choose` on a radio question (native radios, Ashby's single-choice
 * questions and Yes/No pairs) must show its option as chosen, read without opening any list
 * (`BrowserPage.readFields`). A field gone from the page, a different or no option shown, or a read that fails
 * counts as not taken. Lists, check boxes, and type-aheads are not read back. A page without `readFields` reads
 * nothing back. Never reports a value, only the field and a plain reason.
 */
export async function choicesNotTaken(page: BrowserPage, form: RecognizedForm, decisions: FillDecision[]): Promise<UnfilledField[]> {
  if (!page.readFields) return [];
  const planned = new Map(form.fields.map((field) => [field.id, field]));
  const choices = decisions.filter((decision) => decision.action === "choose" && decision.value !== null && planned.get(decision.fieldId)?.kind === "radio");
  if (choices.length === 0) return [];
  let shown: Map<string, BrowserField> | null;
  try {
    shown = new Map((await page.readFields()).map((field) => [field.id, field]));
  } catch {
    shown = null;
  }
  const notTaken: UnfilledField[] = [];
  for (const decision of choices) {
    if (!shown) {
      notTaken.push({ fieldId: decision.fieldId, reason: "the agent could not read the choice back" });
      continue;
    }
    const field = shown.get(decision.fieldId);
    if (!field) {
      notTaken.push({ fieldId: decision.fieldId, reason: "it is no longer on the page" });
      continue;
    }
    const wanted = choiceText(decision.value);
    const current = choiceText(field.currentValue);
    // Recognition clips a long option with "…"; the shown value is compared by that prefix.
    const same = current === wanted || (wanted.endsWith("…") && current.startsWith(wanted.slice(0, -1).trimEnd()));
    if (!same) notTaken.push({ fieldId: decision.fieldId, reason: "the page did not take the choice" });
  }
  return notTaken;
}

/**
 * The evidence of a modal dialog over the form (Track 39): the page's visible
 * text, query-stripped URL, and alert text (capturePostSubmitEvidence) plus
 * each covering dialog's text, role, aria attributes, and button labels, read
 * without clicking anything. Never throws; a piece the page cannot give is
 * left empty.
 */
export async function captureCoveringDialogEvidence(page: BrowserPage, fieldLabel: string): Promise<PostSubmitEvidence> {
  let coveringDialogs: CoveringDialog[] = [];
  try {
    coveringDialogs = page.coveringDialogs ? await page.coveringDialogs() : [];
  } catch {
    coveringDialogs = [];
  }
  const evidence = await capturePostSubmitEvidence(page, "covering-dialog", {
    invalidFields: [],
    ashbyNetwork: null,
    ashbyDiagnostics: null,
    detail: `A dialog covered the form when the agent filled "${fieldLabel}"; the agent left it open and clicked nothing in it.`.slice(0, 500)
  });
  return { ...evidence, coveringDialogs };
}

export type ApplyDecisionsOptions = {
  /**
   * Called once per call, the first time a field is left unfilled with
   * COVERING_DIALOG_REASON, with the page's evidence while the dialog is
   * still up (Track 39). Awaited; an error it throws is ignored.
   */
  onCoveringDialog?: (evidence: PostSubmitEvidence) => Promise<void>;
  /**
   * Track 40: the candidate's standing settings. A modal dialog over the form that
   * standingDialogDecision accepts is agreed to with its one agree button, right after
   * an upload (up to 1 s for it to appear) or when it leaves a field unfilled with
   * COVERING_DIALOG_REASON (the field is then tried once more). onAccepted gets every
   * click; onLeft gets, once per call, why a covering dialog was left. Errors they throw are ignored.
   */
  standingDialogs?: {
    settings: StandingConsentSettings;
    onAccepted: (acceptance: StandingDialogAcceptance) => Promise<void> | void;
    onLeft?: (left: { label: string; reason: StandingDialogLeaveReason }) => Promise<void> | void;
  };
};

/** How long applyDecisions looks for a consent dialog after an upload (Track 40). */
const STANDING_DIALOG_UPLOAD_WAIT_MS = 1_000;
/** The most agree buttons applyDecisions clicks in one call (Track 40). */
const MAX_STANDING_DIALOG_CLICKS = 3;

/**
 * Applies the planned decisions. A page action that fails (a timeout, a
 * type-ahead with no matching suggestion, a choice that is not a text box)
 * is reported in `unfilled` instead of stopping the run; callers turn each
 * into a pause. An upload with no resolved file is a broken invariant and
 * still throws. The first field a covering dialog leaves unfilled hands its
 * evidence to `options.onCoveringDialog`. Under `options.standingDialogs`, a
 * dialog the candidate's standing settings accept is agreed to after an upload
 * or on a covered field, which is then tried once more (Track 40).
 */
export async function applyDecisions(
  page: BrowserPage,
  form: RecognizedForm,
  decisions: FillDecision[],
  uploadPathFor?: (decision: FillDecision) => string | null,
  options: ApplyDecisionsOptions = {}
): Promise<{ applied: number; skipped: number; unfilled: UnfilledField[] }> {
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  let applied = 0;
  let skipped = 0;
  const unfilled: UnfilledField[] = [];
  let dialogReported = false;
  let standingClicks = 0;
  let leftReported = false;
  // Track 40: agrees to a covering dialog the standing settings accept; true once it hid after the click.
  const tryStandingDialog = async (waitMs: number, reportLeft: boolean): Promise<boolean> => {
    const standing = options.standingDialogs;
    if (!standing || (!standing.settings.acceptDataConsent && !standing.settings.signAttestations)) return false;
    if (!page.standingDialogs || !page.clickDialogButton || standingClicks >= MAX_STANDING_DIALOG_CLICKS) return false;
    try {
      const deadline = Date.now() + waitMs;
      let candidates = await page.standingDialogs();
      while (candidates.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        candidates = await page.standingDialogs();
      }
      if (candidates.length === 0) return false;
      // A CAPTCHA on the page is never clicked through.
      if (page.visibleChallenge && (await page.visibleChallenge())) return false;
      const choice = standingDialogDecision(candidates, standing.settings);
      if (choice.verdict === "leave") {
        if (reportLeft && standing.onLeft && !leftReported && choice.reason !== "settings-off" && choice.reason !== "no-dialog") {
          leftReported = true;
          try {
            await standing.onLeft({ label: candidates[0]?.label ?? "", reason: choice.reason });
          } catch {
            // The timeline entry never changes the fill's outcome.
          }
        }
        return false;
      }
      standingClicks += 1;
      const outcome = await page.clickDialogButton(choice.tag, choice.button).catch(() => "failed" as const);
      if (outcome === "failed") return false;
      try {
        await standing.onAccepted({
          label: choice.label,
          text: choice.text,
          statements: choice.statements,
          button: choice.button,
          setting: choice.setting,
          groups: choice.groups,
          outcome: outcome === "hidden" ? "accepted" : "still-shown"
        });
      } catch {
        // The timeline entry never changes the fill's outcome.
      }
      return outcome === "hidden";
    } catch {
      return false;
    }
  };
  const attempt = async (field: BrowserField, action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      applied += 1;
      return true;
    } catch (error) {
      let reason = unfilledReason(error);
      if (reason === COVERING_DIALOG_REASON && (await tryStandingDialog(0, true))) {
        // The dialog was agreed to: the field is tried once more.
        try {
          await action();
          applied += 1;
          return true;
        } catch (retryError) {
          reason = unfilledReason(retryError);
        }
      }
      unfilled.push({ fieldId: field.id, reason });
      if (reason === COVERING_DIALOG_REASON && !dialogReported && options.onCoveringDialog) {
        dialogReported = true;
        try {
          await options.onCoveringDialog(await captureCoveringDialogEvidence(page, field.label));
        } catch {
          // The capture never changes the fill's outcome.
        }
      }
      return false;
    }
  };
  for (const decision of decisions) {
    const field = fields.get(decision.fieldId);
    if (!field) {
      skipped += 1;
      continue;
    }
    switch (decision.action) {
      case "fill": {
        const value = decision.value;
        if (value === null) throw new Error(`Fill decision for ${field.id} carries no value.`);
        await attempt(field, () => page.fillField(field, value));
        break;
      }
      case "choose": {
        const value = decision.value;
        if (value === null) throw new Error(`Choose decision for ${field.id} carries no value.`);
        await attempt(field, () => page.chooseOption(field, value));
        break;
      }
      case "check":
        await attempt(field, () => page.setChecked(field, true));
        break;
      case "upload": {
        const path = uploadPathFor?.(decision) ?? null;
        if (!path) throw new Error(`Upload decision for ${field.id} has no resolved file.`);
        // A consent dialog the upload opens is agreed to before the next field when the standing settings accept it.
        if (await attempt(field, () => page.uploadFile(field, path))) await tryStandingDialog(STANDING_DIALOG_UPLOAD_WAIT_MS, false);
        break;
      }
      case "keep":
      case "pause":
      case "skip":
      // History rows are removed by the Workday history filler, never here.
      case "remove":
        skipped += 1;
        break;
    }
  }
  return { applied, skipped, unfilled };
}

/**
 * Terminal submission. Callers must hold a recorded human approval; the
 * function itself refuses safeguard-tainted pages by checking the page for a
 * confirmation rather than assuming the click worked. Outcomes, read
 * deterministically from the page (submission-outcome.ts):
 *
 * - (a) confirmed: a confirmation phrase that is new after the click, the
 *   site's own success container (Ashby's) appearing after the click, or a
 *   new Greenhouse `/confirmation` / `?confirmation` or Lever `/thanks` URL.
 *   Resolves with the confirmation text.
 * - (b) field errors: at the deadline the site marks fields invalid that were
 *   not invalid before the click and still shows the submit control, so
 *   nothing was sent: `SubmissionNeedsInput` (a hold) with the fields.
 * - (c) refused or challenged: a CAPTCHA appearing after the click
 *   (`SubmissionChallenged`, thrown at once) or a visible error at the
 *   deadline (`SubmissionRefused`). Both are holds.
 * - (d) unknown: nothing recognized; fails closed (`SubmissionUnconfirmed`).
 * - (e) verification code requested: security-code inputs that were not
 *   there before the click appear with text about a code sent by email
 *   (Greenhouse's step). The `securityCode` lookup reads the emailed code;
 *   exactly one is typed in, the step's own submit is clicked, and the
 *   confirmation wait starts again. No code (none, several, no mailbox, an
 *   unreadable one, a field that does not take it, a non-Greenhouse page)
 *   holds the run (`SubmissionCodeNotFound`, nothing sent); a step still
 *   shown after entry fails closed. The code is never logged or put in an
 *   error, and every text returned or kept after it was typed is scrubbed.
 * - Ashby (ats/ashby-submit.ts): the agent waits for Ashby's answer saves
 *   before the click, and clicks again (at most 3 clicks) only after Ashby's
 *   "We're updating your application" notice, which means that click sent
 *   nothing, has gone. Ashby's spam-check failure is held as challenged and
 *   any other failure container as refused (never clicked again); a closed
 *   dialog never counts as a confirmation there. Ashby's network record
 *   (ats/ashby-network.ts) is watched from before the first click: its
 *   server's FormSubmitSuccess confirms, a FormRender naming fields pauses
 *   them (approval withdrawn), a `RECAPTCHA_SCORE_BELOW_THRESHOLD` error is
 *   held as challenged, and the block message is refused; once a submit
 *   request went out after a click, the agent never clicks again. When the
 *   read-only diagnostics (ats/ashby-diagnostics.ts) prove the click reached
 *   Ashby's own submit button and Ashby sent no submit request, the run is
 *   held as a site safeguard (`SubmissionChallenged`), never retried.
 *
 * Every error after the click carries the page's evidence; the agent writes it
 * to the run's local folder.
 */
export async function submitAndConfirm(
  page: BrowserPage,
  options: { timeoutMs?: number; pollMs?: number; securityCode?: SecurityCodeLookup | null; atsKind?: AtsKind | null } = {}
): Promise<string> {
  const ashby = isAshbyApplication(page.url(), options.atsKind);
  // Ashby's submit is judged by its server's answer too: record its GraphQL calls from before the first click.
  if (ashby && page.watchAshbyNetwork) await page.watchAshbyNetwork().catch(() => undefined);
  // Ashby refuses a submit click while an answer is still saving: let its saves finish first.
  if (ashby && page.settleAshbySaves) await page.settleAshbySaves(ASHBY_SAVE_SETTLE_MS);
  const before = await page.bodyText();
  const beforeUrl = page.url();
  const successBefore = page.successText ? (await page.successText()).trim() : "";
  const invalidBefore = page.invalidFields ? await page.invalidFields().catch((): InvalidField[] => []) : [];
  const codeInputsBefore = page.securityCodeInputs ? await page.securityCodeInputs().catch(() => 0) : 0;
  const dialogOpenBefore = page.applicationDialogOpen ? await page.applicationDialogOpen().catch(() => false) : false;
  // Ashby's form is inline; its only dialogs are the type-ahead list and the cookie banner, so on Ashby a
  // closed dialog is never a confirmation (its success container is).
  const targetAts = isDoverOrAshby(beforeUrl, options.atsKind) && !ashby;
  const clickedAt = new Date();
  await page.clickSubmit();
  let clicks = 1;
  // A submission is a network round trip: keep the page open and watch for a
  // new confirmation instead of reading once and closing mid-request.
  const timeoutMs = options.timeoutMs ?? 30_000;
  let deadline = Date.now() + timeoutMs;
  // The emailed security code once it was typed in; held in memory only and
  // scrubbed from every text this function returns or keeps.
  let secret: string | null = null;
  const scrubbed = (evidence: PostSubmitEvidence): PostSubmitEvidence => (secret === null ? evidence : withoutSecret(evidence, secret));
  try {
    for (;;) {
      // A read during a navigation never ends the wait.
      const body = await page.bodyText().catch(() => "");
      const urlConfirmed = readNewConfirmationUrl(beforeUrl, page.url());
      if (urlConfirmed) return scrubSecret(body.trim() || `Confirmation page: ${urlConfirmed}`, secret).slice(0, 2_000);
      if (readNewConfirmation(before, body)) return scrubSecret(body, secret).slice(0, 2_000);
      if (!successBefore && page.successText) {
        const success = (await page.successText().catch(() => "")).trim();
        if (success) return scrubSecret(success, secret).slice(0, 2_000);
      }
      // A challenge after the click is never solved: the run is held for the candidate.
      const challenge = page.visibleChallenge ? await page.visibleChallenge() : null;
      if (challenge) {
        throw new SubmissionChallenged(
          `After the submit click the site showed ${challenge.detail}. The agent never solves CAPTCHAs, so this application is held for you: finish it in your own browser. The run is not marked submitted.`,
          scrubbed(await capturePostSubmitEvidence(page, "challenged", { bodyText: body, challenge: challenge.detail }))
        );
      }
      // Ashby's server answer to the submit (ats/ashby-network.ts), read before its page feedback.
      let network: AshbySubmitNetwork | null = null;
      if (ashby && page.ashbySubmitNetwork) {
        network = await page.ashbySubmitNetwork(0).catch(() => null);
        const verdict = ashbyNetworkVerdict(network);
        if (verdict === "recaptcha-rejected") {
          // Ashby's reCAPTCHA Enterprise spam check refused the submit: never worked around, held for the candidate.
          throw new SubmissionChallenged(ASHBY_SPAM_CHECK_MESSAGE, scrubbed(await capturePostSubmitEvidence(page, "challenged", { bodyText: body, challenge: ASHBY_SPAM_CHECK_DETAIL })));
        }
        if (verdict === "accepted") {
          const success = page.successText ? (await page.successText().catch(() => "")).trim() : "";
          return scrubSecret(success || ASHBY_ACCEPTED_CONFIRMATION, secret).slice(0, 2_000);
        }
        if (verdict === "blocked") {
          throw new SubmissionRefused(ASHBY_BLOCKED_MESSAGE, scrubbed(await capturePostSubmitEvidence(page, "refused", { bodyText: body })));
        }
        if (verdict === "form-errors") {
          const invalid = ashbyNetworkInvalidFields(network);
          const evidence = scrubbed(await capturePostSubmitEvidence(page, "field-errors", { bodyText: body, invalidFields: invalid }));
          throw new SubmissionNeedsInput(ashbyFormErrorsMessage(invalid.length), evidence, evidence.invalidFields);
        }
      }
      // Ashby's own submit feedback: its spam check or an error refuses the submission; a click made while an
      // answer was still saving sent nothing, so it is made again once Ashby has finished saving.
      if (ashby && page.ashbySubmitState) {
        const state = await page.ashbySubmitState().catch(() => EMPTY_ASHBY_SUBMIT_STATE);
        const step = nextAshbyStep(state, clicks);
        if (step === "spam-check") {
          throw new SubmissionChallenged(
            ASHBY_SPAM_CHECK_MESSAGE,
            scrubbed(await capturePostSubmitEvidence(page, "challenged", { bodyText: body, challenge: ASHBY_SPAM_CHECK_DETAIL, alertText: state.failureText }))
          );
        }
        if (step === "refused") {
          throw new SubmissionRefused(
            `The site did not accept the submission ("${scrubSecret(state.failureText, secret).slice(0, 200)}"). The run is not marked submitted; check the application on the site before retrying.`,
            scrubbed(await capturePostSubmitEvidence(page, "refused", { bodyText: body, alertText: state.failureText }))
          );
        }
        // Never a second submit: once a submit request went out after the latest click, keep waiting instead.
        if (step === "click-again" && !ashbySubmitSentAfter(network, clicks)) {
          await page.settleAshbySaves?.(ASHBY_RECLICK_SETTLE_MS);
          try {
            await page.clickSubmit();
            clicks += 1;
            deadline = Date.now() + timeoutMs;
          } catch {
            // No submit control any more: keep reading the outcome until the deadline.
          }
          continue;
        }
      }
      // If a modal dialog was open before submit and has now closed without errors, challenge, or refusal:
      if (dialogOpenBefore && page.applicationDialogOpen) {
        const dialogOpenNow = await page.applicationDialogOpen().catch(() => false);
        if (!dialogOpenNow) {
          const invalidAfter = page.invalidFields ? await page.invalidFields().catch((): InvalidField[] => []) : [];
          const submitShown = page.submitControlShown ? await page.submitControlShown().catch(() => false) : false;
          const refusal = page.alertText ? (await page.alertText()).trim() : "";
          const kind = classifyUnconfirmed({ invalidBefore, invalidAfter, submitShown, alertText: refusal });
          if (kind === "field-errors") {
            const evidence = scrubbed(await capturePostSubmitEvidence(page, kind, { invalidFields: invalidAfter, alertText: refusal }));
            throw new SubmissionNeedsInput(
              `After the submit click the site marked ${invalidAfter.length} field(s) invalid, so nothing was sent. The run waits for your answers with the approval withdrawn; it is not marked submitted.`,
              evidence,
              evidence.invalidFields
            );
          }
          if (kind === "refused") {
            const evidence = scrubbed(await capturePostSubmitEvidence(page, kind, { invalidFields: invalidAfter, alertText: refusal }));
            throw new SubmissionRefused(`The site did not accept the submission ("${scrubSecret(refusal, secret).slice(0, 200)}"). The run is not marked submitted; check the application on the site before retrying.`, evidence);
          }
          if (targetAts) {
            const success = page.successText ? (await page.successText().catch(() => "")).trim() : "";
            const text = success || readNewConfirmation(before, body) || (urlConfirmed ? body.trim() || `Confirmation page: ${urlConfirmed}` : null);
            return scrubSecret(text || "Application submitted (application dialog closed)", secret).slice(0, 2_000);
          }
        }
      }
      // The site's emailed security-code step: the code comes from the candidate's mailbox, else the run is held.
      if (secret === null && page.securityCodeInputs) {
        const codeInputsAfter = await page.securityCodeInputs().catch(() => 0);
        if (isSecurityCodeStep({ codeInputsBefore, codeInputsAfter, bodyText: body })) {
          const found: SecurityCodeLookupResult = options.securityCode
            ? await options.securityCode({ url: stripUrlQuery(page.url()), clickedAt }).catch((): SecurityCodeLookupResult => ({ kind: "unavailable" }))
            : { kind: "no-mailbox" };
          if (found.kind !== "found") {
            throw new SubmissionCodeNotFound(securityCodeHoldMessage(found.kind), await capturePostSubmitEvidence(page, "verification-code", { bodyText: body }));
          }
          if (!page.submitSecurityCode) {
            throw new SubmissionCodeNotFound(securityCodeHoldMessage("not-entered"), await capturePostSubmitEvidence(page, "verification-code", { bodyText: body }));
          }
          try {
            await page.submitSecurityCode(found.code);
          } catch (error) {
            if (error instanceof SecurityCodeNotEntered) {
              throw new SubmissionCodeNotFound(
                securityCodeHoldMessage("not-entered"),
                withoutSecret(await capturePostSubmitEvidence(page, "verification-code"), found.code)
              );
            }
            // Any other error: the step's submit may have been clicked; keep waiting like any submit.
          }
          secret = found.code;
          deadline = Date.now() + timeoutMs;
          continue;
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
    }
    // The code was typed in but the step is still shown: fail closed, never call it submitted.
    if (secret !== null && page.securityCodeInputs) {
      const stillInputs = await page.securityCodeInputs().catch(() => 0);
      const stillBody = stillInputs > 0 ? await page.bodyText().catch(() => "") : "";
      if (isSecurityCodeStep({ codeInputsBefore: 0, codeInputsAfter: stillInputs, bodyText: stillBody })) {
        throw new SubmissionUnconfirmed(SECURITY_CODE_STILL_ASKED, withoutSecret(await capturePostSubmitEvidence(page, "verification-code"), secret));
      }
    }
    const invalidAfter = page.invalidFields ? await page.invalidFields().catch((): InvalidField[] => []) : [];
    const submitShown = page.submitControlShown ? await page.submitControlShown().catch(() => false) : false;
    const refusal = page.alertText ? (await page.alertText()).trim() : "";
    const kind = classifyUnconfirmed({ invalidBefore, invalidAfter, submitShown, alertText: refusal });
    const ashbyBusy = ashby && page.ashbySubmitState ? (await page.ashbySubmitState().catch(() => EMPTY_ASHBY_SUBMIT_STATE)).busySeen : false;
    // Ashby's click reached its Submit Application button and Ashby sent nothing (Track 27): held as a site safeguard.
    if (ashby && kind === "unknown" && !ashbyBusy && page.ashbySubmitDiagnostics) {
      const network = page.ashbySubmitNetwork ? await page.ashbySubmitNetwork().catch(() => null) : null;
      const diagnostics = await page.ashbySubmitDiagnostics().catch(() => null);
      if (ashbyClickSentNothing(network, diagnostics)) {
        throw new SubmissionChallenged(
          ashbyNotSentMessage(stripUrlQuery(page.url())),
          scrubbed(await capturePostSubmitEvidence(page, "challenged", {
            invalidFields: invalidAfter,
            alertText: refusal,
            challenge: ASHBY_NOT_SENT_DETAIL,
            ashbyNetwork: network,
            ashbyDiagnostics: diagnostics
          }))
        );
      }
    }
    const evidence = scrubbed(await capturePostSubmitEvidence(page, kind, {
      invalidFields: invalidAfter,
      alertText: refusal,
      ...(kind === "unknown" && ashbyBusy ? { detail: ASHBY_BUSY_DETAIL } : {})
    }));
    if (kind === "field-errors") {
      // No page text or field labels here: this message reaches the pipeline's notices.
      throw new SubmissionNeedsInput(
        `After the submit click the site marked ${invalidAfter.length} field(s) invalid, so nothing was sent. The run waits for your answers with the approval withdrawn; it is not marked submitted.`,
        evidence,
        evidence.invalidFields
      );
    }
    if (kind === "refused") {
      throw new SubmissionRefused(`The site did not accept the submission ("${scrubSecret(refusal, secret).slice(0, 200)}"). The run is not marked submitted; check the application on the site before retrying.`, evidence);
    }
    if (kind === "unknown" && ashbyBusy) throw new SubmissionUnconfirmed(ashbyBusyMessage(clicks), evidence);
    const dialogClosed = page.applicationDialogOpen ? (dialogOpenBefore && !(await page.applicationDialogOpen().catch(() => true))) : false;
    if (dialogClosed && targetAts && kind === "unknown") {
      const success = page.successText ? (await page.successText().catch(() => "")).trim() : "";
      return scrubSecret(success || "Application submitted (application dialog closed)", secret).slice(0, 2_000);
    }
    throw new SubmissionUnconfirmed(dialogClosed
      ? "The submit button was clicked and the application dialog closed, but no confirmation text was recognized. Check the application on the site before retrying; the run is not marked submitted."
      : "The submit button was clicked but no new confirmation appeared. Check the application on the site before retrying; the run is not marked submitted.", evidence);
  } catch (error) {
    // Once the code was typed, nothing leaves without scrubbed evidence: an
    // error that carries none is replaced, so no caller captures the page raw.
    if (secret !== null && postSubmitEvidenceOf(error) === null) {
      throw new SubmissionUnconfirmed(
        "The submit button was clicked but no new confirmation appeared. Check the application on the site before retrying; the run is not marked submitted.",
        withoutSecret(await capturePostSubmitEvidence(page, "unknown"), secret)
      );
    }
    throw error;
  }
}

/**
 * esbuild's keepNames (used by tsx, and so by `pnpm pipeline:run`) wraps
 * functions in an `__name(fn, "name")` helper. Functions passed to evaluate()
 * run inside the page, where that helper does not exist, so the page gets a
 * no-op stand-in. It is a string, which no compiler rewrites.
 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";
/** How long followApplyEntry looks again for an Apply entry drawn after the load event. */
const APPLY_ENTRY_WAIT_MS = 8_000;
const shimmedPages = new WeakSet<Page>();

export async function ensureNameShim(page: Page): Promise<void> {
  if (!shimmedPages.has(page)) {
    shimmedPages.add(page);
    await page.addInitScript({ content: NAME_SHIM }); // every later navigation
  }
  await page.evaluate(NAME_SHIM); // the document already loaded
}

/** Playwright adapter: translates the minimal surface onto a real Page. */
export function createPlaywrightPage(page: Page): BrowserPage {
  // Once a Quick apply dialog is open, every read, fill, and submit stays inside it.
  let scope: Locator | null = null;
  const root = () => scope ?? page.locator("body");
  const within = () => scope ?? page;
  // Ashby's network record, once watchAshbyNetwork started it (ats/ashby-network.ts).
  let ashbyNetwork: AshbyNetworkRecorder | null = null;
  // Ashby's read-only submit diagnostics, started with the network record (ats/ashby-diagnostics.ts).
  let ashbyDiagnostics: AshbyDiagnosticsRecorder | null = null;
  // The page drew a tagged control again (Ashby redraws its form after a resume upload; Track 71, run traces <run id>,
  // <run id>, <run id>): the new element has no tag, and Ashby's label[for] names no element, so the label lookup would
  // wait out its timeout. The controls are collected again; the one field with the same label, when it is a tagged
  // control, is the redrawn element. Two fields with that label, or an untagged one, find nothing here.
  const redrawnTagged = async (field: BrowserField): Promise<Locator | null> => {
    try {
      await ensureNameShim(page);
      const same = recognizeFields(await root().evaluate(collectControlsIn)).filter((candidate) => candidate.label === field.label);
      if (same.length !== 1 || !TAGGED_CONTROL.test(same[0]!.id)) return null;
      const located = within().locator(`[data-ia-control="${cssValue(same[0]!.id)}"]`);
      return (await located.count()) === 1 ? located : null;
    } catch {
      return null;
    }
  };
  // The field's own element by id, so two fields with one label ("Attach")
  // never hit the same control; the label is the fallback.
  const locateField = async (field: BrowserField): Promise<Locator> => {
    const byId = within().locator(idSelector(field.id));
    if ((await byId.count().catch(() => 0)) === 1) return byId;
    // A control without an id is recognized by its name.
    const byName = within().locator(`[name="${cssValue(field.id)}"]`);
    if ((await byName.count().catch(() => 0)) === 1) return byName;
    // A control with neither (Ashby's location box) carries the tag collectControlsIn gave it.
    const byRef = within().locator(`[data-ia-control="${cssValue(field.id)}"]`);
    if ((await byRef.count().catch(() => 0)) === 1) return byRef;
    if (TAGGED_CONTROL.test(field.id)) {
      const redrawn = await redrawnTagged(field);
      if (redrawn) return redrawn;
    }
    return within().getByLabel(field.label, { exact: false }).first();
  };
  return {
    url: () => page.url(),
    title: () => page.title(),
    collectControls: async () => {
      await ensureNameShim(page);
      const controls = await root().evaluate(collectControlsIn);
      // React-select lists draw their options only once opened; opening one saves nothing.
      let opened = 0;
      for (const control of controls) {
        if (control.widget !== "combobox" || !control.id || opened >= 40) continue;
        opened += 1;
        control.options = await readComboboxOptions(page, within(), control.id);
        // A list with no options until something is typed (Greenhouse's "Location (City)") is a type-ahead.
        // So are Greenhouse's School and Discipline lists: they search their catalogs as you type, and
        // the first page shown on opening is never the whole list (the options read are kept).
        if (control.options.length === 0 || /^(?:school|discipline)--\d+$/.test(control.id)) control.widget = "autocomplete";
      }
      // Bare ARIA lists (Eightfold's Octuple Select, Rippling's searchable select) draw their options only while
      // open, like react-select's. Opening one saves nothing; a list that shows no options on opening stays a type-ahead.
      for (const control of controls) {
        if (!control.listbox || opened >= 40) continue;
        const selector = control.id
          ? idSelector(control.id)
          : control.name ? `[name="${cssValue(control.name)}"]` : control.ref ? `[data-ia-control="${cssValue(control.ref)}"]` : null;
        if (!selector) continue;
        opened += 1;
        const options = await readAriaListOptions(page, within().locator(selector).first());
        if (options.length === 0) continue;
        control.tag = "select";
        control.type = undefined;
        control.options = options;
        // A list that shows its options on opening is chosen by clicking its option (recognizeFields drops
        // "combobox"; chooseOption routes the role="combobox" control to chooseComboboxOption), readonly or not:
        // Eightfold's Octuple lists filter as you type yet show every option on opening, and a click never
        // types into them (Track 37: typing through the type-ahead path timed out on the live form).
        control.widget = "combobox";
      }
      return controls;
    },
    bodyText: async () => {
      await ensureNameShim(page);
      return page.evaluate(() => document.body?.innerText ?? "");
    },
    fillField: async (field, value) => {
      const control = await locateField(field);
      const read = await control.evaluate((element) => {
        const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
        return {
          type: element instanceof HTMLInputElement ? element.type : "",
          readOnly: text ? element.readOnly : false,
          value: text ? element.value : ""
        };
      }, undefined, { timeout: 10_000 });
      // A radio, checkbox, or upload is never typed into.
      if (read.type === "radio" || read.type === "checkbox" || read.type === "file") throw new FieldUnfillable("it is a choice, not a text box");
      // A read-only box (Oracle's Email Address, filled by its email step) is never typed into: it either shows the value already or pauses.
      if (read.readOnly) {
        const same = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
        if (same(read.value) === same(value)) return;
        throw new FieldUnfillable("it is read-only and shows another value");
      }
      await control.fill(value, { timeout: 10_000 });
    },
    chooseOption: async (field, option) => {
      if (field.widget === "autocomplete") {
        await chooseSuggestion(page, await locateField(field), field, option);
        return;
      }
      if (field.kind === "radio" || field.kind === "checkbox") {
        // Radios (and checkboxes outside a group element) sharing a name are one question: the field id is that name.
        const named = field.kind === "radio"
          ? within().locator(`input[type="radio"][name="${cssValue(field.id)}"], input[type="radio"][data-ia-radio-group="${cssValue(field.id)}"]`)
          : within().locator(`input[type="checkbox"][name="${cssValue(field.id)}"]`);
        const byId = field.kind === "checkbox" ? await within().locator(idSelector(field.id)).count().catch(() => 0) : 0;
        if (byId === 0 && (await named.count().catch(() => 0)) > 0) {
          if (field.kind === "radio") {
            // Match the label read from this group, including when ARIA gives it a different name.
            const target = named.and(within().locator(`[data-ia-radio-option="${cssValue(option)}"]`));
            const count = await target.count();
            if (count === 0) throw new FieldUnfillable("the option was not found");
            if (count > 1) throw new FieldUnfillable("more than one option matched");
            // Ashby's single-choice question: React draws the choice from its own state (the option's `data-checked`),
            // and a click on the option already chosen clears it. Click the option's own label once, then wait for
            // Ashby to show it chosen; never the DOM fallback below (Track 25).
            const ashbyOption = target.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ashby-application-form-input-radio-group-option ')][1]");
            if ((await ashbyOption.count()) === 1) {
              if ((await ashbyOption.getAttribute("data-checked")) !== null) return;
              const radioId = await target.getAttribute("id");
              const label = radioId ? within().locator(`label[for="${cssValue(radioId)}"]`) : null;
              if (label && (await label.count()) === 1) await label.click({ timeout: 10_000 });
              else await target.click({ timeout: 10_000 });
              for (let attempt = 0; attempt < 10; attempt += 1) {
                if ((await ashbyOption.getAttribute("data-checked").catch(() => null)) !== null) return;
                await page.waitForTimeout(200);
              }
              throw new FieldUnfillable("the site did not keep the choice");
            }
            // Workable's option: a `role=radio` element over a hidden native radio. Click the option itself and wait for
            // it to show `aria-checked="true"` (or the radio to be checked); never the DOM fallback below (Track 77).
            const roleOption = target.locator('xpath=ancestor::*[@role="radio"][1]');
            if ((await roleOption.count()) === 1) {
              const kept = async (): Promise<boolean> =>
                (await roleOption.getAttribute("aria-checked").catch(() => null)) === "true"
                || (await target.isChecked().catch(() => false));
              if (await kept()) return;
              await roleOption.click({ timeout: 10_000 });
              for (let attempt = 0; attempt < 10; attempt += 1) {
                if (await kept()) return;
                await page.waitForTimeout(200);
              }
              throw new FieldUnfillable("the site did not keep the choice");
            }
            try {
              await target.check({ timeout: 10_000 });
            } catch {
              // Styled or hidden radios (such as Jobvite's 0x0 radios) fail actionability. Fall back to clicking
              // the associated label (`<label for="...">`) or dispatching a click, and ensure form validation triggers.
              const id = await target.getAttribute("id").catch(() => null);
              const label = id ? within().locator(`label[for="${cssValue(id)}"]`) : null;
              if (label && (await label.count().catch(() => 0)) > 0) {
                await label.first().click({ timeout: 10_000 });
              } else {
                await target.dispatchEvent("click");
              }
              await target.evaluate((input: HTMLInputElement) => {
                if (!input.checked) input.checked = true;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }).catch(() => undefined);
            }
          } else {
            const target = named.and(within().getByRole(field.kind, { name: option, exact: true }));
            if ((await target.count()) === 0) throw new FieldUnfillable("the option was not found");
            await target.first().check({ timeout: 10_000 });
          }
          return;
        }
      }
      const control = await locateField(field);
      await ensureNameShim(page);
      const shape = await control.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        group: element.tagName.toLowerCase() === "fieldset" || element.getAttribute("role") === "group",
        yesno: Boolean(element.closest(".ashby-application-form-input-yesno"))
      }));
      if (shape.yesno) {
        // Ashby's Yes/No question: a pair of buttons over a hidden checkbox. Click the named button.
        const escaped = option.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const button = control
          .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ashby-application-form-input-yesno ')][1]")
          .locator("button")
          .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, "i") })
          .first();
        if ((await button.count()) === 0) throw new FieldUnfillable("the option was not found");
        await button.click({ timeout: 10_000 });
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if ((await button.getAttribute("aria-pressed").catch(() => null)) === "true") return;
          await page.waitForTimeout(200);
        }
        throw new FieldUnfillable("the site did not keep the choice");
      }
      if (shape.tag === "select") {
        await control.selectOption({ label: option }, { timeout: 10_000 });
      } else if (shape.role === "combobox") {
        await chooseComboboxOption(page, control, field, option);
      } else if (field.kind === "checkbox") {
        // A checkbox group answered as one question: check the one chosen option.
        const group = shape.group ? control : within().getByRole("group", { name: field.label });
        await group.getByRole("checkbox", { name: option, exact: true }).first().check({ timeout: 10_000 });
      } else {
        await within().getByRole("radio", { name: option }).first().check({ timeout: 10_000 });
      }
    },
    setChecked: async (field, checked) => {
      await (await locateField(field)).setChecked(checked, { timeout: 10_000 });
    },
    uploadFile: async (field, path) => {
      await (await locateField(field)).setInputFiles(path, { timeout: 10_000 });
    },
    clickSubmit: async () => {
      // Pick the control in the page, then click it with a real (trusted)
      // mouse click: sites may ignore script-dispatched clicks.
      await ensureNameShim(page);
      const index = await root().evaluate(findSubmitIndex);
      if (index < 0) throw new Error("No submit control was found.");
      const target = root().locator(SUBMIT_SELECTOR).nth(index);
      if (ashbyDiagnostics) {
        // Read-only: what the click will hit, read just before it.
        await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
        const check = await target.evaluate(describeSubmitTargetIn).catch(() => null);
        ashbyDiagnostics.noteClick(check);
      }
      ashbyNetwork?.noteClick();
      try {
        await target.click();
      } catch (error) {
        ashbyNetwork?.cancelClick();
        ashbyDiagnostics?.cancelClick();
        throw error;
      }
    },
    screenshot: async (path, options) => {
      await page.screenshot({ path, fullPage: options?.fullPage ?? false });
    },
    close: () => page.close(),
    readFields: async () => {
      await ensureNameShim(page);
      return recognizeFields(await root().evaluate(collectControlsIn));
    },
    invalidFields: async () => {
      try {
        await ensureNameShim(page);
        return await root().evaluate(readInvalidFieldsIn);
      } catch {
        return [];
      }
    },
    submitControlShown: async () => {
      try {
        await ensureNameShim(page);
        return (await root().evaluate(findSubmitIndex)) >= 0;
      } catch {
        return false;
      }
    },
    openApplicationDialog: async () => {
      // Handshake renders the button after the load event; wait for it.
      const trigger = page.getByRole("button", { name: /quick apply/i }).first();
      const shown = await trigger.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      if (!shown) return false;
      await trigger.click();
      const dialog = page.getByRole("dialog").filter({ hasText: /apply to/i }).first();
      await dialog.waitFor({ state: "visible", timeout: 15_000 });
      scope = dialog;
      return true;
    },
    attachedDocumentNames: async () => (scope ? attachedNamesFromText(await scope.innerText()) : []),
    applicationDialogOpen: async () => {
      if (scope) return scope.isVisible().catch(() => false);
      try {
        await ensureNameShim(page);
        return await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], dialog[open], .MuiDialog-root, [aria-modal="true"]');
          if (!dialog) return false;
          const el = dialog as HTMLElement;
          return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
        });
      } catch {
        return false;
      }
    },
    waitForFormReady: async () => {
      await waitForStableControls(() => root().locator(FORM_CONTROLS).count());
    },
    visibleChallenge: async () => {
      // The top document, not the dialog scope: challenge frames sit outside forms.
      try {
        await ensureNameShim(page);
        const found = await page.evaluate(findVisibleChallengeIn);
        if (found) return found;
      } catch {
        // A read during a navigation; the frame tree below may still show the widget.
      }
      // Turnstile's frame in a closed shadow root is invisible to the read above.
      return findShadowTurnstileFrame(page).catch(() => null);
    },
    coveringDialogs: async () => {
      // The top document, like the challenge read: clickBareList's modal check reads it there too.
      try {
        await ensureNameShim(page);
        return await page.evaluate(readCoveringDialogsIn);
      } catch {
        return [];
      }
    },
    standingDialogs: async () => {
      // The top document, like the covering-dialog read.
      try {
        await ensureNameShim(page);
        return await page.evaluate(readStandingDialogsIn);
      } catch {
        return [];
      }
    },
    clickDialogButton: (tag, name) => clickStandingDialogButton(page, tag, name),
    stopRegion: async (request) => {
      await ensureNameShim(page);
      return page.evaluate(readStopRegionIn, request);
    },
    alertText: async () => {
      try {
        await ensureNameShim(page);
        return await page.evaluate(readAlertTextIn);
      } catch {
        return "";
      }
    },
    successText: async () => {
      // The top document, not the dialog scope, like the challenge and alert reads.
      try {
        await ensureNameShim(page);
        return await page.evaluate(readSuccessTextIn);
      } catch {
        return "";
      }
    },
    settleAshbySaves: async (waitMs) => {
      try {
        await ensureNameShim(page);
        await page.evaluate(watchAshbySubmitFeedbackIn);
      } catch {
        // A read during a navigation: the wait below still runs.
      }
      await page.waitForTimeout(waitMs);
    },
    ashbySubmitState: async () => {
      try {
        await ensureNameShim(page);
        return await page.evaluate(readAshbySubmitStateIn);
      } catch {
        return EMPTY_ASHBY_SUBMIT_STATE;
      }
    },
    watchAshbyNetwork: async () => {
      if (ashbyNetwork) return;
      const recorder = createAshbyNetworkRecorder();
      ashbyNetwork = recorder;
      // Playwright's own event listeners only: nothing is injected into the page and no launch flag changes.
      const diagnostics = createAshbyDiagnosticsRecorder();
      ashbyDiagnostics = diagnostics;
      page.on("request", (request) => {
        try {
          recorder.request(request, request.url(), () => request.postData());
        } catch {
          // The record never breaks the page.
        }
        try {
          diagnostics.request(request, request.url(), request.method(), request.resourceType());
        } catch {
          // The record never breaks the page.
        }
      });
      page.on("response", (response) => {
        try {
          recorder.response(response.request(), response.status(), () => response.text());
        } catch {
          // The record never breaks the page.
        }
        try {
          diagnostics.response(response.request(), response.status());
        } catch {
          // The record never breaks the page.
        }
      });
      page.on("requestfailed", (request) => {
        try {
          recorder.failed(request);
        } catch {
          // The record never breaks the page.
        }
        try {
          diagnostics.failed(request);
        } catch {
          // The record never breaks the page.
        }
      });
      page.on("console", (message) => {
        try {
          diagnostics.consoleMessage(message.type(), message.text());
        } catch {
          // The record never breaks the page.
        }
      });
      page.on("pageerror", (error) => {
        try {
          diagnostics.pageError(`${error.name}: ${error.message}`);
        } catch {
          // The record never breaks the page.
        }
      });
    },
    ashbySubmitNetwork: async (waitMs) => (ashbyNetwork ? ashbyNetwork.snapshot(waitMs) : null),
    ashbySubmitDiagnostics: async () => {
      if (!ashbyDiagnostics) return null;
      try {
        await ensureNameShim(page);
      } catch {
        // The reads below fail closed without it.
      }
      // The page's values are read only to scrub them from the texts; null drops the texts.
      const values = await page.evaluate(readFormValuesIn).then(scrubValuesFrom, () => null);
      const errors = await page.evaluate(readAshbyVisibleErrorsIn).catch(() => [] as string[]);
      return ashbyDiagnostics.snapshot(values, errors);
    },
    followApplyEntry: async () => {
      // The whole page, not a dialog scope: the main frame plus same-host frames
      // (iCIMS draws the job inside a same-host iframe). One entry, at most.
      try {
        await ensureNameShim(page);
        await dismissCookieBanner(page);
        // A client-rendered posting draws its Apply entry, or Greenhouse's embed, after the load event (Oracle Candidate Experience: about 2 s); look again every 500 ms.
        const deadline = Date.now() + APPLY_ENTRY_WAIT_MS;
        for (;;) {
          const embedded = greenhouseEmbedTarget(page.url(), await embedSourcesOf(page));
          if (embedded && embedded !== page.url()) {
            await page.goto(embedded, { waitUntil: "domcontentloaded" });
            return page.url();
          }
          const pageHost = hostOf(page.url());
          const main = page.mainFrame();
          const frames = [main, ...page.frames().filter((frame) => frame !== main && pageHost !== null && hostOf(frame.url()) === pageHost)];
          const candidates: ApplyEntryCandidate[] = [];
          for (const [number, frame] of frames.entries()) {
            try {
              await frame.evaluate(NAME_SHIM);
              const found = await frame.locator("body").evaluate(collectApplyEntriesIn);
              for (const entry of found) candidates.push({ ...entry, frame: number });
            } catch {
              // A frame that went away or runs no scripts offers no entry.
            }
          }
          const chosen = chooseApplyEntry(page.url(), candidates);
          if (chosen) {
            await dismissCookieBanner(page);
            if (chosen.tag === "a" && chosen.href) {
              await page.goto(chosen.href, { waitUntil: "domcontentloaded" });
            } else {
              await clickApplyEntry(page, frames[chosen.frame]!.locator(`[data-ia-apply-entry="${chosen.index}"]`).first());
            }
            return page.url();
          }
          if (Date.now() >= deadline) return null;
          await page.waitForTimeout(500);
          await ensureNameShim(page).catch(() => undefined);
        }
      } catch {
        return null;
      }
    },
    securityCodeInputs: async () => {
      try {
        await ensureNameShim(page);
        return await root().evaluate(tagSecurityCodeInputsIn);
      } catch {
        return 0;
      }
    },
    submitSecurityCode: async (code) => {
      // Every failure before the click is a fixed phrase: no caught error (which could echo the code) is passed on.
      try {
        await ensureNameShim(page);
        const count = await root().evaluate(tagSecurityCodeInputsIn);
        if (count === 0 || (count > 1 && count !== code.length)) throw new Error("mismatch");
        const box = (index: number) => within().locator(`[data-ia-security-code="${index}"]`).first();
        if (count === 1) {
          await box(0).fill(code, { timeout: 10_000 });
        } else {
          for (let index = 0; index < count; index += 1) await box(index).fill(code[index]!, { timeout: 10_000 });
        }
        const typed = await root().evaluate(readSecurityCodeValueIn);
        if (typed !== code) throw new Error("mismatch");
      } catch {
        throw new SecurityCodeNotEntered("The security code field did not take the code.");
      }
      // The step's own submit follows its inputs; it may enable only once every box holds a character.
      let index = -1;
      for (let attempt = 0; attempt < 25 && index < 0; attempt += 1) {
        index = await root().evaluate(findSecurityCodeSubmitIndex).catch(() => -1);
        if (index < 0) await page.waitForTimeout(200);
      }
      if (index < 0) index = await root().evaluate(findSubmitIndex).catch(() => -1);
      if (index < 0) throw new SecurityCodeNotEntered("No submit control follows the security code field.");
      try {
        await root().locator(SUBMIT_SELECTOR).nth(index).click();
      } catch {
        // A plain error: the click may have happened, so the caller keeps waiting.
        throw new Error("The security code's submit click failed.");
      }
    }
  };
}

/**
 * A shown Cloudflare Turnstile frame the in-page read cannot reach (Turnstile
 * draws it inside a closed shadow root; Dover's application pages, 2026-11-24).
 * The browser's frame tree lists it anyway. Reads only each frame's address,
 * its element's src, visibility, and box; never evaluates in, clicks, or types
 * into a frame. A hidden or zero-size (invisible-mode) frame is no challenge.
 */
async function findShadowTurnstileFrame(page: Page): Promise<VisibleChallenge | null> {
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    const element = await frame.frameElement().catch(() => null);
    if (!element) continue;
    try {
      const source = (await element.getAttribute("src").catch(() => null)) ?? "";
      if (!isTurnstileFrameSource(source) && !isTurnstileFrameSource(frame.url())) continue;
      if (!(await element.isVisible().catch(() => false))) continue;
      const box = await element.boundingBox().catch(() => null);
      if (!box || box.width < 20 || box.height < 20) continue;
      return { kind: "turnstile", detail: "a Cloudflare Turnstile challenge" };
    } finally {
      await element.dispose().catch(() => undefined);
    }
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Links and buttons that could be a posting's Apply entry, in page order. Each
 * is tagged `data-ia-apply-entry="<index>"` so the chosen one is clicked by
 * that tag. An anchor's href is null when it only points into the page ("#").
 * Runs in the page.
 */
function collectApplyEntriesIn(root: Element): Array<Omit<ApplyEntryCandidate, "frame">> {
  const entries: Array<Omit<ApplyEntryCandidate, "frame">> = [];
  const elements = Array.from(root.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]'));
  for (const element of elements) {
    if (element.getClientRects().length === 0) continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    const anchor = element.tagName.toLowerCase() === "a";
    const raw = anchor ? (element.getAttribute("href") ?? "").trim() : "";
    const href = anchor && raw !== "" && !raw.startsWith("#") ? (element as HTMLAnchorElement).href : null;
    const texts = [
      (element as HTMLElement).innerText ?? "",
      element.getAttribute("title") ?? "",
      element.getAttribute("aria-label") ?? "",
      element instanceof HTMLInputElement ? element.value : ""
    ].map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
    const className = typeof element.className === "string" ? element.className : element.getAttribute("class") ?? "";
    const id = element.id || null;
    const index = entries.length;
    element.setAttribute("data-ia-apply-entry", String(index));
    entries.push({ tag: anchor ? "a" : "button", href, texts, className, index, id });
  }
  return entries;
}

/** A tag collectControlsIn gives a control with neither id nor name (refOf). */
const TAGGED_CONTROL = /^ia-control-\d+$/;

/** A value for a quoted CSS attribute selector (Lever names look like `cards[<uuid>][field0]`). */
function cssValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** An attribute selector for an element id (ids may hold brackets, as Greenhouse's `question_1[]`). */
function idSelector(id: string): string {
  return `[id="${cssValue(id)}"]`;
}

/**
 * The suggestions a type-ahead input shows, in order: the listbox its
 * aria-controls/aria-owns names, react-select's options for its id, Ashby's
 * location suggestion rows, Lever's `.dropdown-results` entries in its
 * question, then options near it.
 */
async function suggestionsFor(page: Page, input: Locator): Promise<Locator[]> {
  const attributes = await input.evaluate((element) => ({
    owns: `${element.getAttribute("aria-controls") ?? ""} ${element.getAttribute("aria-owns") ?? ""}`.trim(),
    id: element.id
  }));
  const sources: Locator[] = [];
  for (const id of attributes.owns.split(/\s+/).filter(Boolean)) sources.push(page.locator(`[id="${cssValue(id)}"] [role="option"]`));
  if (attributes.id) sources.push(page.locator(`[id^="react-select-${cssValue(attributes.id)}-option-"]`));
  sources.push(page.locator('[class*="select__menu"] [role="option"], [role="listbox"] [role="option"]'));
  sources.push(page.locator(".ashby-application-form-input-autocomplete-popup-result"));
  sources.push(input.locator("xpath=ancestor::*[self::li or self::label][1]").locator(".dropdown-results > *"));
  sources.push(input.locator("xpath=ancestor::*[position() <= 5]").locator('[role="option"]'));
  return sources.map((source) => source.filter({ visible: true }));
}

/**
 * A react-select menu left open is absolutely positioned and covers the
 * fields below it (seen on Greenhouse's School list), so every list choice
 * starts with none open: Escape, then the focus leaves the page's active
 * element, then up to 1 s for the menu to hide. Never throws.
 */
async function settleOpenMenus(page: Page): Promise<void> {
  try {
    const menu = page.locator('[class*="select__menu"]').filter({ visible: true });
    if ((await menu.count()) === 0) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await ensureNameShim(page);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await menu.first().waitFor({ state: "hidden", timeout: 1_000 }).catch(() => undefined);
  } catch {
    // A page that went away has no menu to close.
  }
}

/** "Address Line 1", "Street address line 2", "Street Address": the labels whose type-ahead may keep a typed address. */
const STREET_ADDRESS_LABEL = /^(?:street )?address(?: line)? ?[12]$|^street address$/;

function streetLabelOf(label: string): string {
  return label.toLocaleLowerCase("en-US").replace(/\(optional\)/g, "").replace(/[*:]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Types the saved value into a type-ahead field and picks the suggestion
 * that matches it exactly or uniquely (matchSuggestion). A "City, Region"
 * value with no match is typed again as the city alone (a search that does
 * not know "Springfield, IL"), and the suggestions are still matched against the
 * whole value. No match: the typed text is cleared, its list closed, and the
 * field left without focus so the list never covers the next field; the field
 * is reported unfillable, never guessed. A street-address box that showed no
 * suggestion at all keeps the typed address.
 */
async function chooseSuggestion(page: Page, input: Locator, field: BrowserField, value: string): Promise<void> {
  await settleOpenMenus(page);
  const shown = value.length > 60 ? `${value.slice(0, 59)}…` : value;
  if (field.kind === "select") await input.click({ timeout: 10_000 });
  let sawSuggestion = false;
  const search = async (typed: string): Promise<{ source: Locator; index: number } | null> => {
    await input.fill("", { timeout: 10_000 });
    await input.pressSequentially(typed, { delay: 40, timeout: 10_000 });
    const sources = await suggestionsFor(page, input);
    const deadline = Date.now() + 6_000;
    let found: { source: Locator; index: number } | null = null;
    while (!found && Date.now() < deadline) {
      for (const source of sources) {
        const texts = (await source.allInnerTexts().catch(() => [] as string[])).map((text) => text.replace(/\s+/g, " ").trim());
        if (!texts.some(Boolean)) continue;
        sawSuggestion = true;
        const match = matchSuggestion(value, texts);
        if (match !== null) {
          found = { source, index: texts.indexOf(match) };
          break;
        }
      }
      if (!found) await page.waitForTimeout(250);
    }
    return found;
  };
  const candidates: string[] = [value];
  const hyphenated = value.replace(/,\s*/g, " - ");
  if (hyphenated !== value) candidates.push(hyphenated);
  for (const term of promptSearchTerms(value)) {
    if (!candidates.includes(term)) candidates.push(term);
  }
  const city = value.includes(",") ? value.slice(0, value.indexOf(",")).trim() : "";
  if (city && !candidates.includes(city)) candidates.push(city);
  let picked: { source: Locator; index: number } | null = null;
  for (const term of candidates) {
    picked = await search(term);
    if (picked) break;
  }
  if (!picked && !sawSuggestion && STREET_ADDRESS_LABEL.test(streetLabelOf(field.label))) {
    // A street-address box whose type-ahead offered nothing keeps the typed saved address (Oracle's Address Line 1,
    // Track 63); a box that offered suggestions none of which matched still pauses.
    try {
      await input.fill(value, { timeout: 10_000 });
      await page.keyboard.press("Escape").catch(() => undefined);
      await input.blur().catch(() => undefined);
      if ((await input.inputValue({ timeout: 5_000 })) === value) return;
    } catch {
      // Falls through to the pause below.
    }
  }
  if (!picked) {
    await input.fill("", { timeout: 5_000 }).catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await input.blur().catch(() => undefined);
    throw new FieldUnfillable(`no suggestion matched "${shown}"`);
  }
  await picked.source.nth(picked.index).click({ timeout: 5_000 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const kept = await input.evaluate((element) => {
      const single = element.closest('[class*="select__control"]')?.querySelector('[class*="single-value"]');
      if (single) return (single.textContent ?? "").trim() !== "";
      return (element as HTMLInputElement).value.trim() !== "";
    }).catch(() => false);
    if (kept) return;
    await page.waitForTimeout(200);
  }
  throw new FieldUnfillable("the site did not keep the suggestion");
}

/** Opens a react-select list, reads its options, and closes it. Opening a list saves nothing. Never throws. */
async function readComboboxOptions(page: Page, scope: Page | Locator, id: string): Promise<string[]> {
  try {
    await scope.locator(idSelector(id)).first().click({ timeout: 3_000 });
    const escaped = id.replace(/["\\]/g, "\\$&");
    // Only the opened list's options: other listboxes on the page (Greenhouse's phone-country
    // picker keeps one in the DOM) are not this question's options.
    const options = page.locator(`[id^="react-select-${escaped}-option-"], [class*="select__menu"] [role="option"]`).filter({ visible: true });
    // Greenhouse's School, Degree, and Discipline lists load their first page from its catalog.
    const wait = /^(?:school|degree|discipline)--\d+$/.test(id) ? 5_000 : 1_500;
    await options.first().waitFor({ state: "visible", timeout: wait }).catch(() => undefined);
    const texts = (await options.allInnerTexts()).map((text) => text.trim()).filter(Boolean).slice(0, 500);
    await page.keyboard.press("Escape").catch(() => undefined);
    return texts;
  } catch {
    await page.keyboard.press("Escape").catch(() => undefined);
    return [];
  }
}

/** The ids an ARIA list control names for its listbox: aria-controls and aria-owns on it or its ancestors up to 3 levels (Octuple sets aria-owns on its wrapper while open). Runs in the page. */
function listboxIdsIn(element: Element): string[] {
  const ids: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth <= 3; depth += 1, node = node.parentElement) {
    for (const attribute of ["aria-controls", "aria-owns"]) {
      for (const id of (node.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * A click on a bare ARIA list's control or option (never react-select, a
 * native select, a radio, Ashby, Workday, or a submit control). A trusted
 * click first. When it times out (something covers the form: Eightfold's
 * welcome dialog on load, or whatever kept every trusted list click from
 * landing after the resume upload on Lockheed Martin run <run id>, Track 37),
 * a site announcement is closed when that is safe (announcement-dialog.ts)
 * and the trusted click is tried once more. Still blocked: a visible
 * CAPTCHA or other site check, or a modal dialog still shown, makes the field
 * unfillable, so a safeguard is never clicked through; otherwise the click is
 * dispatched to the element itself. Other errors are thrown as they are.
 */
async function clickBareList(page: Page, target: Locator, timeoutMs: number): Promise<void> {
  try {
    await target.click({ timeout: timeoutMs });
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
  }
  if (await dismissAnnouncementDialog(page)) {
    try {
      await target.click({ timeout: 3_000 });
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
  }
  await ensureNameShim(page);
  if (await page.evaluate(findVisibleChallengeIn)) throw new FieldUnfillable("a site check covers the form");
  if (await page.evaluate(visibleModalDialogIn)) throw new FieldUnfillable(COVERING_DIALOG_REASON);
  await target.dispatchEvent("click");
}

/**
 * Opens a bare ARIA list (Eightfold's Octuple Select) with clickBareList,
 * reads its options, and closes it: the visible `role="option"` items of the listbox its
 * aria-controls/aria-owns names (on it or its ancestors), else of the one
 * visible `role="listbox"` on the page. Then Escape, the focus leaves the
 * active element, and up to 1 s for the list to hide. Opening a list saves
 * nothing. Never throws.
 */
async function readAriaListOptions(page: Page, control: Locator): Promise<string[]> {
  try {
    await clickBareList(page, control, 3_000);
    let texts: string[] = [];
    let listbox: Locator | null = null;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const ids = await control.evaluate(listboxIdsIn).catch(() => [] as string[]);
      for (const id of ids) {
        const owner = page.locator(idSelector(id));
        const options = owner.locator('[role="option"]').filter({ visible: true });
        if ((await options.count().catch(() => 0)) > 0) {
          listbox = owner.first();
          texts = await options.allInnerTexts();
          break;
        }
      }
      if (!listbox) {
        const visible = page.locator('[role="listbox"]').filter({ visible: true });
        if ((await visible.count().catch(() => 0)) === 1) {
          const options = visible.locator('[role="option"]').filter({ visible: true });
          if ((await options.count().catch(() => 0)) > 0) {
            listbox = visible.first();
            texts = await options.allInnerTexts();
          }
        }
      }
      if (listbox) break;
      await page.waitForTimeout(150);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await ensureNameShim(page);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    }).catch(() => undefined);
    if (listbox) await listbox.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => undefined);
    return texts.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 500);
  } catch {
    await page.keyboard.press("Escape").catch(() => undefined);
    return [];
  }
}

/**
 * Picks one option of a react-select list or a bare ARIA list and checks that
 * the control shows it. Greenhouse's phone-country list shows only the chosen
 * country's dialing code ("+1" for "United States +1"), which counts as
 * showing that option. A react-select multi-select ("mark all that apply")
 * shows the choice as a chip, which counts as showing it. A bare ARIA list
 * (Eightfold's Octuple Select, Rippling's searchable select) is opened and its
 * option clicked with clickBareList; its option is looked up in the listbox
 * it names (a "…"-clipped option by its prefix), and an editable one that does
 * not show the option on opening is searched by typing it.
 */
async function chooseComboboxOption(page: Page, control: Locator, field: BrowserField, option: string): Promise<void> {
  const shown = () => control.evaluate((element) => {
    const box = element.closest('[class*="select__control"]');
    return {
      single: box?.querySelector('[class*="single-value"]')?.textContent?.trim() ?? "",
      multi: Array.from(box?.querySelectorAll('[class*="multi-value__label"]') ?? []).map((chip) => chip.textContent?.trim() ?? ""),
      // A bare ARIA list (Eightfold's Octuple Select) shows the chosen option's text as the input's value.
      value: element instanceof HTMLInputElement ? element.value.replace(/\s+/g, " ").trim() : ""
    };
  });
  // Already chosen: react-select hides chosen options from a multi menu.
  if ((await shown()).multi.includes(option)) return;
  // React-select keeps its own path; only a bare ARIA list gets clickBareList and the typing fallback.
  const bare = await control.evaluate((element) => element instanceof HTMLInputElement
    && element.getAttribute("role") === "combobox" && !element.closest('[class*="select__control"]')).catch(() => false);
  await settleOpenMenus(page);
  if (bare) await clickBareList(page, control, 5_000);
  else await control.click({ timeout: 5_000 });
  // A list that loads its options (Greenhouse's Degree catalog) shows them a moment after opening.
  await page.locator('[role="option"], [class*="select__option"]').filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  // A bare ARIA list's option is looked up in the listbox it names, so another open list's same-named option is never clicked.
  const ownListboxOf = () => control.evaluate((element) => {
    if (element.closest('[class*="select__control"]')) return null;
    const ids: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; node && depth <= 3; depth += 1, node = node.parentElement) {
      for (const attribute of ["aria-controls", "aria-owns"]) {
        for (const id of (node.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) if (!ids.includes(id)) ids.push(id);
      }
    }
    return ids.find((id) => {
      const owner = document.getElementById(id);
      return Boolean(owner && owner.getClientRects().length > 0 && getComputedStyle(owner).visibility !== "hidden");
    }) ?? null;
  }).catch(() => null);
  const wanted = choiceText(option);
  const clipped = wanted.endsWith("…") ? wanted.slice(0, -1).trimEnd() : null;
  const optionIn = async (listboxId: string | null): Promise<Locator | null> => {
    const scope = listboxId ? page.locator(idSelector(listboxId)) : page;
    const byRole = scope.getByRole("option", { name: option, exact: true });
    if ((await byRole.count()) > 0) return byRole.first();
    if (bare && clipped) {
      // Recognition clipped a long option with "…": the first option it starts.
      const options = scope.locator('[role="option"]').filter({ visible: true });
      const texts = await options.allInnerTexts().catch(() => [] as string[]);
      const index = texts.findIndex((text) => choiceText(text).startsWith(clipped));
      if (index >= 0) return options.nth(index);
    }
    return null;
  };
  let target = await optionIn(await ownListboxOf());
  if (!target && bare) {
    const editable = await control.evaluate((element) => !(element as HTMLInputElement).readOnly).catch(() => false);
    if (editable) {
      // An editable list that does not show the option on opening is searched for it.
      await control.fill("", { timeout: 5_000 });
      await control.pressSequentially(option.replace(/…$/, "").trimEnd(), { delay: 40, timeout: 10_000 });
      const deadline = Date.now() + 3_000;
      while (!target && Date.now() < deadline) {
        target = await optionIn(await ownListboxOf());
        if (!target) await page.waitForTimeout(200);
      }
    }
    if (!target) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await control.blur().catch(() => undefined);
      throw new FieldUnfillable("the option was not found");
    }
  }
  target ??= page.locator('[class*="select__option"]').filter({ hasText: new RegExp(`^\\s*${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
  if (bare) await clickBareList(page, target, 5_000);
  else await target.click({ timeout: 5_000 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { single, multi, value } = await shown();
    if (single === option || (/^\+\d{1,4}$/.test(single) && option.endsWith(` ${single}`))) return;
    if (multi.includes(option)) {
      // A multi menu stays open after a choice.
      await page.keyboard.press("Escape").catch(() => undefined);
      return;
    }
    if (value) {
      const current = choiceText(value);
      // Recognition clips a long option with "…": the shown value is compared by that prefix (as choicesNotTaken does).
      if (current === wanted || (clipped !== null && current.startsWith(clipped))) return;
      // A phone-country picker shows only the dialing code ("+1" for "United States (+1)").
      if (/^\+\d{1,4}$/.test(value) && (option.endsWith(` ${value}`) || option.endsWith(`(${value})`))) return;
    }
    await page.waitForTimeout(200);
  }
  if (bare) throw new FieldUnfillable("the site did not keep the choice");
  throw new Error(`"${field.label}" did not accept the option.`);
}

/**
 * Fields the page marks invalid under `root`, with their labels and the
 * site's error texts, in document order (at most 30). Reads controls with
 * `aria-invalid="true"` and shown error elements: Greenhouse's `<id>-error`
 * and `.helper-text--error`, and error-classed elements inside Ashby's and
 * Lever's field containers (selectors derived from public markup, not
 * verified live; a miss only turns field errors into an unknown outcome).
 * Runs in the page, so every helper is declared here.
 */
function readInvalidFieldsIn(root: Element): InvalidField[] {
  const TOKEN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;
  const MARKER = /\s*(?:[*∗✱＊]+|\(required\))\s*$/i;
  const CONTROL = "input, textarea, select";
  const CONTAINER = ".ashby-application-form-field-entry, .application-question, .field-wrapper";
  const ERROR_ELEMENTS = '[id$="-error"], .helper-text--error, .ashby-application-form-field-entry [class*="error" i], .application-question [class*="error" i]';
  const collapse = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const shown = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const textOf = (element: Element | null | undefined): string => (element ? collapse((element as HTMLElement).innerText ?? element.textContent) : "");
  const isField = (element: Element | null | undefined): element is Element => {
    if (!element || !element.matches(CONTROL)) return false;
    if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(element.type)) return false;
    const input = element as HTMLInputElement;
    return !(TOKEN.test(input.name ?? "") || TOKEN.test(input.id ?? ""));
  };
  const labelOf = (control: Element): string => {
    const unstar = (text: string): string => {
      let value = text;
      for (let guard = 0; guard < 3 && MARKER.test(value); guard += 1) value = value.replace(MARKER, "").trim();
      return value.slice(0, 200);
    };
    const labelledBy = collapse((control.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => textOf(document.getElementById(id))).join(" "));
    if (labelledBy) return unstar(labelledBy);
    const aria = collapse(control.getAttribute("aria-label"));
    if (aria) return unstar(aria);
    if (control.id) {
      const forLabel = textOf(document.querySelector(`label[for="${CSS.escape(control.id)}"]`));
      if (forLabel) return unstar(forLabel);
    }
    const legend = textOf(control.closest("fieldset")?.querySelector("legend"));
    if (legend) return unstar(legend);
    const wrapping = textOf(control.closest("label"));
    if (wrapping) return unstar(wrapping);
    return unstar(collapse((control as HTMLInputElement).name));
  };
  const errorLike = (element: Element): boolean => {
    const className = typeof (element as HTMLElement).className === "string" ? (element as HTMLElement).className : element.getAttribute("class") ?? "";
    return element.id.endsWith("-error") || /error/i.test(className) || element.getAttribute("role") === "alert";
  };
  const describedError = (control: Element): string => {
    const ids = [
      ...(control.getAttribute("aria-errormessage") ?? "").split(/\s+/),
      ...(control.getAttribute("aria-describedby") ?? "").split(/\s+/),
      control.id ? `${control.id}-error` : ""
    ].filter(Boolean);
    for (const id of ids) {
      const element = document.getElementById(id);
      if (!element || !errorLike(element) || !shown(element)) continue;
      const text = textOf(element);
      if (text) return text.slice(0, 200);
    }
    return "";
  };
  const containerError = (control: Element): string => {
    const container = control.closest(CONTAINER);
    if (!container) return "";
    for (const element of Array.from(container.querySelectorAll('[class*="error" i], [id$="-error"]'))) {
      if (element.matches(CONTROL) || element.querySelector(CONTROL) || !shown(element)) continue;
      const text = textOf(element);
      if (text && text.length <= 200) return text;
    }
    return "";
  };
  const found: Array<InvalidField & { element: Element }> = [];
  const seen = new Set<string>();
  const add = (control: Element, error: string): void => {
    const ref = control.id || (control as HTMLInputElement).name || control.getAttribute("data-ia-control") || null;
    const label = labelOf(control) || "Unnamed field";
    const key = ref ?? label;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ref, label, error: error || "The site marked this field invalid.", element: control });
  };
  for (const control of Array.from(root.querySelectorAll('[aria-invalid="true"]'))) {
    if (!isField(control)) continue;
    add(control, describedError(control) || containerError(control));
  }
  for (const element of Array.from(root.querySelectorAll(ERROR_ELEMENTS))) {
    if (element.matches(CONTROL) || element.querySelector(CONTROL) || !shown(element)) continue;
    const text = textOf(element);
    if (!text) continue;
    let control: Element | null = null;
    if (element.id) {
      control = Array.from(root.querySelectorAll("[aria-describedby], [aria-errormessage]")).find((candidate) =>
        (candidate.getAttribute("aria-describedby") ?? "").split(/\s+/).includes(element.id)
        || candidate.getAttribute("aria-errormessage") === element.id) ?? null;
      if (!control && element.id.endsWith("-error")) control = document.getElementById(element.id.slice(0, -6));
    }
    if (!control) {
      control = Array.from(element.closest(CONTAINER)?.querySelectorAll(CONTROL) ?? []).find((candidate) => isField(candidate)) ?? null;
    }
    if (isField(control)) add(control, text.slice(0, 200));
  }
  found.sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return found.slice(0, 30).map(({ ref, label, error }) => ({ ref, label, error }));
}

/** Visible alert and error texts, deduplicated and clipped. Runs in the page. */
function readAlertTextIn(): string {
  const texts: string[] = [];
  const docTitle = (document.title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .map((h) => ((h as HTMLElement).innerText ?? h.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

  for (const element of Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [id$="-error"], .error, .error-message, .flash-error'))) {
    if (element.getClientRects().length === 0) continue;
    const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const isExplicitError =
      Boolean(element.id && element.id.endsWith("-error")) ||
      element.matches('.error, .error-message, .flash-error, [id$="-error"]');

    const hasErrorKeyword = /\b(?:error|errors|problem|failed|failure|invalid|required|sorry|unable|cannot|denied|wrong|rejected|unsuccessful|already applied|deadline|closed)\b/i.test(text);

    if (!isExplicitError && !hasErrorKeyword) {
      if (element.matches('h1, h2, h3, h4, h5, h6, header, [role="heading"], [role="banner"]') || element.closest('header, [role="banner"]')) {
        continue;
      }
      if (/^(?:apply\s*[-–—:]|application\s*[-–—:]|job\s+application\s*[-–—:]|apply$|application$)/i.test(text)) {
        continue;
      }
      const lower = text.toLowerCase();
      if (docTitle && (docTitle === lower || docTitle.startsWith(lower) || lower.startsWith(docTitle) || (docTitle.length > 5 && (docTitle.includes(lower) || lower.includes(docTitle))))) {
        continue;
      }
      if (headings.some((h) => h === lower || (h.length > 5 && (h.includes(lower) || lower.includes(h))))) {
        continue;
      }
    }

    if (!texts.includes(text)) texts.push(text);
  }
  return texts.join(" ").slice(0, 300);
}

/** The text of the first shown post-submit success container (Ashby's, Dover's MUI alert/snackbar, or status toast), collapsed and clipped; "" when none. Runs in the page. */
function readSuccessTextIn(): string {
  const SELECTORS = [
    ".ashby-application-form-success-container",
    '[data-testid="application-form-success"]',
    ".MuiAlert-standardSuccess",
    ".MuiAlert-colorSuccess",
    ".MuiSnackbar-root",
    '[data-testid="toast"]',
    '[role="status"]'
  ].join(", ");
  for (const element of Array.from(document.querySelectorAll(SELECTORS))) {
    if (element.getClientRects().length === 0) continue;
    const className = typeof (element as HTMLElement).className === "string" ? (element as HTMLElement).className : element.getAttribute("class") ?? "";
    if (/error|danger|invalid|refused/i.test(className)) continue;
    const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (element.matches(".ashby-application-form-success-container, .MuiAlert-standardSuccess, .MuiAlert-colorSuccess, [data-testid='application-form-success']")) {
      return text.slice(0, 2_000);
    }
    if (/\b(applied|submitted|received|thanks|thank you|success|sent)\b/i.test(text)) {
      return text.slice(0, 2_000);
    }
  }
  return "";
}

/**
 * Handshake lists an attached document as its file name followed by a
 * "Preview document" link, on the same line or the line before.
 */
export function attachedNamesFromText(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.flatMap((line, index) => {
    const match = line.match(/^(.*?)\s*Preview document\b/);
    if (!match) return [];
    const sameLine = match[1]!.trim();
    if (sameLine) return [sameLine];
    return index > 0 ? [lines[index - 1]!] : [];
  });
}

/**
 * Reads the form's controls in the page. Runs inside the page, so every
 * helper and pattern is declared here. Labels come from aria-labelledby,
 * aria-label, label[for], a wrapping label (its own label element first, as
 * Lever's `.application-label`), then the question text near the control
 * (Ashby's question title, Lever's custom-question label, Dover's sibling
 * `styles__FormLabel-…` div, matched by a case-sensitive "FormLabel" class),
 * and placeholder and name last. An option's own label (a label holding
 * exactly one radio or checkbox, as MUI's "Yes" option) and aria-hidden text
 * are never a question's label, and an upload's walk for a nearby label stops
 * at an ancestor that holds another question's control. Every source drops invisible characters (Dover's outlined inputs
 * carry a notched-outline legend holding only U+200B, which is skipped like
 * an empty one) and counts as empty when it is a bare UUID; a name holding a
 * UUID (Dover's custom questions) never labels a control. The order of the
 * sources is unchanged. Label text skips nested controls, live regions, status and
 * listbox widgets, and hidden elements, so "Current location ✱No location
 * found…Loading" reads "Current location ✱". Text inside a button or link
 * (Oracle JET's "Discard" label span) never labels a control, and button or
 * reset inputs and controls with a button, link, menu item, or tab role are
 * not fields. An upload whose own label only
 * says "Attach" takes its group's label. React-select lists become one select
 * (options are read by opening them), radios sharing a name and checkbox
 * groups become one question, type-ahead inputs are marked `autocomplete`, a
 * bare ARIA combobox input (not react-select, a datalist, a location box, or a
 * "Start typing..." box) is marked `listbox` with the value it shows (its list
 * is read by opening it), a wrapping label's aria-labelledby labels its
 * control (Rippling's uploads), and
 * react-select's hidden required inputs, Ashby's "Autofill from resume" parser
 * input (its pane, its survey-form uploader, or its input root), a resume-autofill drop zone's input (a `role="button"` box whose text
 * says "autofill", as Dover's), and the CAPTCHA token field are not controls. Ashby's Yes/No button
 * pairs are read as one radio question, its `_required` question-title class
 * marks a question required (single- and multi-choice questions, which Ashby
 * draws without the field-entry wrapper, take it from the radio or checkbox
 * group's title), a short Ashby title with no "?" takes the question from
 * Ashby's description ("Visa Support: Do you require any visa support…?"),
 * and a fieldset's question-title label (not one
 * for its radios) labels the radio group. Ashby's text-message consent radios
 * (in `.ashby-application-form-texting-consent-description`, inside the phone
 * field's entry) take the consent text as their question (a channel heading in
 * front), never the radio name or the phone's title, and do not inherit the
 * phone title's `_required`; a fieldset checkbox group with no legend takes its
 * question-title label (Ashby's checkbox groups), never an option's label. A short Greenhouse question label
 * with no "?" takes its `<id>-description` question as well ("HISTORY WITH
 * IRONVALE: Have you previously applied to a position at Ironvale?"). A lone
 * checkbox labelled only by an agreement ("I agree and consent") in a fieldset
 * takes the legend in front. A control
 * with neither id nor name is tagged `data-ia-control="ia-control-<n>"` and
 * carries that tag as its ref; the tag stays the same across repeated
 * collections, so a field id from an earlier recognition still names the
 * same element. Controls inside a cookie-consent manager (OneTrust's banner
 * and preference-center toggles, its vendor search), a share or copy-link
 * box (an id or name saying copy-link or share-link, or a read-only text box
 * holding a URL), a honeypot text box ("Leave this field blank", "for
 * robots", Workday's beecatcher), Oracle Digital Assistant's chatbot
 * controls on Oracle Cloud hosts, and a newsletter, subscribe, mailing-list,
 * job-alert, or talent-community box (a container within six ancestors whose
 * id or class says so, holding no file upload and at most four controls) are
 * never fields.
 */
export function collectControlsIn(root: Element): RawControl[] {
  const controls: RawControl[] = [];
  // Same list as cookie-consent.ts COOKIE_CONSENT_ROOTS; copied because this runs in the page.
  const CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const COPY_LINK = /(?:^|[-_])copy[-_]?link(?:$|[-_])|share[-_]?link/i;
  const HONEYPOT = /\b(?:honey ?pot|robots? only|for robots|if you(?:'|’| a)re (?:a )?human|leave (?:this )?(?:field )?(?:blank|empty)|do not (?:fill|enter|type))\b|beecatcher/i;
  const TEXT_LIKE = ["text", "email", "url", "tel", "search", "number"];
  /** A container id or class naming a newsletter, subscribe, mailing-list, job-alert, or talent-community box. */
  const SIGNUP_BOX = /newsletter|subscri(?:be|ption)|mailing[-_ ]?list|job[-_ ]?alerts?|talent[-_ ]?(?:community|network)/i;
  /**
   * A control inside a signup box: the first of its six nearest ancestors whose id or class matches SIGNUP_BOX holds
   * no file upload and at most four controls a person fills (an application section with an upload is never one).
   */
  const inSignupBox = (element: Element): boolean => {
    let ancestor = element.parentElement;
    for (let depth = 0; depth < 6 && ancestor && ancestor !== document.body && ancestor !== document.documentElement; depth += 1) {
      const className = typeof ancestor.className === "string" ? ancestor.className : ancestor.getAttribute("class") ?? "";
      if (SIGNUP_BOX.test(ancestor.id) || SIGNUP_BOX.test(className)) {
        if (ancestor.querySelector('input[type="file"]')) return false;
        const filled = Array.from(ancestor.querySelectorAll("input, textarea, select")).filter((control) =>
          !(control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "image"].includes(control.type)));
        return filled.length <= 4;
      }
      ancestor = ancestor.parentElement;
    }
    return false;
  };
  const TOKEN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;
  const GENERIC_FILE = /^(?:attach|upload|choose (?:a )?file|browse|select|select (?:a )?file|add (?:a )?file|drop (?:files? )?here.*)$/i;
  const MARKER = /\s*(?:[*∗✱＊]+|\(required\))\s*$/i;
  const CONTROL = "input, textarea, select, button";
  /** Buttons and links: their text (Oracle JET's "Discard" label span) never labels a control. */
  const ACTION = 'button, [role="button"], a[href], [role="link"], [role="menuitem"]';
  const ACTION_ROLE = /^(?:button|link|menuitem|tab)$/i;
  const SKIPPED_ROLE = /^(?:status|alert|log|listbox|option)$/i;
  // Invisible characters and UUIDs: the same rules as form-recognition.ts (INVISIBLE_CHARACTERS, nameAsLabel),
  // copied here because this function runs inside the page.
  const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
  const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  /** Text with invisible characters removed and whitespace collapsed; a bare UUID reads as empty. */
  const collapse = (text: string | null | undefined): string => {
    const readable = (text ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
    return UUID_ONLY.test(readable) ? "" : readable;
  };
  /** A control name as a label: empty when it holds a generated UUID (Dover's custom questions). */
  const nameLabel = (name: string | null | undefined): string => {
    const text = collapse(name);
    return UUID_IN.test(text) ? "" : text;
  };
  const unstar = (text: string): string => text.replace(MARKER, "").trim();
  /** Visible text of a label: nested controls, live regions, status/listbox widgets, and hidden elements are skipped. */
  const textOf = (element: Element | null | undefined, skip?: (child: Element) => boolean): string => {
    if (!element) return "";
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node): number => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const child = node as Element;
        if (child.matches("input, textarea, select, button, option, script, style")) return NodeFilter.FILTER_REJECT;
        if (skip?.(child)) return NodeFilter.FILTER_REJECT;
        if (child.hasAttribute("aria-live") || SKIPPED_ROLE.test(child.getAttribute("role") ?? "")) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(child);
        if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) parts.push((node as Text).data);
    }
    return collapse(parts.join(""));
  };
  const byIds = (ids: string | null): string => collapse((ids ?? "").split(/\s+/).filter(Boolean)
    .map((id) => textOf(document.getElementById(id))).join(" "));
  /** A control that is a question of its own (buttons, hidden inputs, and the token field are not). */
  const isQuestion = (element: Element): boolean => {
    if (element instanceof HTMLButtonElement) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if ((element as HTMLElement).hidden) return false;
    const input = element as HTMLInputElement;
    if (input instanceof HTMLInputElement && ["hidden", "submit", "image", "button", "reset"].includes(input.type)) return false;
    if (/^oda-|^chatbot|chatbot/i.test(input.id || input.name || "")) return false;
    return !(TOKEN.test(input.name ?? "") || TOKEN.test(input.id ?? ""));
  };
  /**
   * A label candidate that is never a question's label: one inside an option's
   * own label (a label holding exactly one radio or checkbox, as MUI's
   * "MuiFormControlLabel-label" span reading "Yes"), or one inside an
   * aria-hidden element. A label holding several controls (Lever's whole
   * question) is not an option label.
   */
  const notQuestionText = (candidate: Element): boolean => {
    const option = candidate.closest("label");
    if (option && option.querySelectorAll(CONTROL).length === 1
      && option.querySelector('input[type="radio"], input[type="checkbox"]')) return true;
    return Boolean(candidate.closest('[aria-hidden="true"]'));
  };
  /**
   * The question text near a control with no label of its own: the first
   * legend, label (not one for another control), heading, or element whose
   * class says label/question/title (or holds "FormLabel", as Dover's
   * `styles__FormLabel-…` question div) in the closest ancestors, stopping at
   * an ancestor that also holds another question's control. An option's own
   * label and aria-hidden text are never the question.
   */
  const questionLabelNear = (element: Element): string => {
    const name = (element as HTMLInputElement).name;
    const sameQuestion = (other: Element): boolean => other === element
      || (Boolean(name) && (other as HTMLInputElement).name === name && other.tagName === element.tagName);
    let node: Element | null = element.parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth += 1, node = node.parentElement) {
      const others = Array.from(node.querySelectorAll(CONTROL)).filter((other) => isQuestion(other) && !sameQuestion(other));
      if (others.length > 0) return "";
      for (const candidate of Array.from(node.querySelectorAll('legend, label, [role="heading"], [class*="label"], [class*="FormLabel"], [class*="question"], [class*="title"]'))) {
        if (candidate.matches(CONTROL) || candidate.querySelector(CONTROL) || candidate.closest(ACTION)) continue;
        if (notQuestionText(candidate)) continue;
        const target = candidate.getAttribute("for");
        if (target) {
          const owner = document.getElementById(target);
          if (owner && owner !== element && owner.matches(CONTROL)) continue;
        }
        const text = textOf(candidate);
        if (text) return text.slice(0, 300);
      }
    }
    return "";
  };
  /**
   * The question text written before a control with no label, aria name, or placeholder: in the closest
   * ancestor holding the control and no other question's control, the text of its children before the one
   * holding the control. Rippling's custom questions draw `div > [div > p "Question?"] + [div[data-testid=field]
   * > … > input]` with a random `name` and nothing else naming the control (Track 37, read-only capture of
   * 2026-11-25). An option's own label, aria-hidden text, and buttons or links are never the question.
   */
  const questionTextBefore = (element: Element): string => {
    const name = (element as HTMLInputElement).name;
    const sameQuestion = (other: Element): boolean => other === element
      || (Boolean(name) && (other as HTMLInputElement).name === name && other.tagName === element.tagName);
    let child: Element = element;
    let node: Element | null = element.parentElement;
    for (let depth = 0; node && depth < 6 && node !== document.body; depth += 1, child = node, node = node.parentElement) {
      if (Array.from(node.querySelectorAll(CONTROL)).some((other) => isQuestion(other) && !sameQuestion(other))) return "";
      const before: string[] = [];
      for (const sibling of Array.from(node.children)) {
        if (sibling === child) break;
        if (sibling.matches(CONTROL) || sibling.querySelector(CONTROL) || sibling.closest(ACTION) || notQuestionText(sibling)) continue;
        // A question and its help text in separate blocks read as two sentences, not one run-on word.
        const ownText = Array.from(sibling.childNodes).some((part) => part.nodeType === Node.TEXT_NODE && (part.textContent ?? "").trim());
        const blocks = sibling.children.length > 1 && !ownText ? Array.from(sibling.children) : [sibling];
        for (const block of blocks) {
          const text = notQuestionText(block) ? "" : textOf(block);
          if (text) before.push(text);
        }
      }
      if (before.length > 0) return collapse(before.join(" ")).slice(0, 300);
    }
    return "";
  };
  /** The label and where it came from; placeholder, the question text before the control, and name are the last resort, after the question text near the control. */
  const labelFor = (element: Element): string | undefined => {
    const labelled = byIds(element.getAttribute("aria-labelledby"));
    if (labelled) return labelled;
    const aria = collapse(element.getAttribute("aria-label"));
    if (aria) return aria;
    const id = element.id;
    if (id) {
      const owner = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = textOf(owner);
      if (text) return text;
    }
    const wrapping = element.closest("label");
    if (wrapping) {
      // A wrapping label's accessible name is its aria-labelledby: Rippling wraps each upload in
      // `label[aria-labelledby]` whose own text only says "Upload" (bugs/resolved/uploads-labelled-through-their-wrapping-label-read-unlabeled.md).
      const named = byIds(wrapping.getAttribute("aria-labelledby"));
      if (named) return named.slice(0, 300);
      // Lever wraps the whole question in a label: its own label element holds the question.
      const own = Array.from(wrapping.querySelectorAll('[class*="label"]')).find((candidate) => !candidate.querySelector(CONTROL) && textOf(candidate));
      const wrapped = textOf(own) || textOf(wrapping);
      if (wrapped) return wrapped.slice(0, 300);
    }
    const near = questionLabelNear(element);
    if (near) return near;
    return collapse(element.getAttribute("placeholder")) || questionTextBefore(element)
      || nameLabel((element as HTMLInputElement).name) || undefined;
  };
  const RESUME_LABEL = /\b(resume|cv|curriculum vitae)\b|r[eé]sum[eé]|add resume|attach resume/i;
  const isSiblingPaste = (other: Element) => other.tagName === "TEXTAREA" && /paste|resume/i.test(other.id || other.className);
  /**
   * An upload labelled only "Attach" takes the label of its upload group or
   * nearby heading (Dover's `styles__FormLabel-…` div included); the walk
   * stops at an ancestor that holds another question's control, and an
   * option's own label or aria-hidden text is never the upload's label.
   */
  const fileLabel = (element: Element, own: string | undefined): string | undefined => {
    if (own && !GENERIC_FILE.test(unstar(own))) return own;
    const group = element.closest('[role="group"][aria-labelledby]');
    const grouped = group ? byIds(group.getAttribute("aria-labelledby")) : "";
    if (grouped && !GENERIC_FILE.test(unstar(grouped))) return grouped;
    let node: Element | null = element.parentElement;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      if (Array.from(node.querySelectorAll(CONTROL)).filter((other) => isQuestion(other) && other !== element && !isSiblingPaste(other)).length > 0) return own;
      for (const candidate of Array.from(node.querySelectorAll('legend, label, [role="heading"], h1, h2, h3, h4, h5, h6, [class*="label"], [class*="FormLabel"], [class*="title"], [class*="jv-field-label"]'))) {
        if (candidate.getAttribute("for") === element.id && element.id) continue;
        if (candidate.closest(ACTION)) continue;
        if (notQuestionText(candidate)) continue;
        const text = textOf(candidate);
        if (text) {
          if (RESUME_LABEL.test(text)) return text;
          if (!GENERIC_FILE.test(unstar(text))) return text;
        }
      }
    }
    return own;
  };
  /**
   * Ashby's question entry. Ashby draws single- and multi-choice questions (ValueSelect,
   * MultiValueSelect) without the field-entry wrapper: the radio or checkbox group fieldset holds
   * the title, inside a bare `[data-field-entry-id]` div.
   */
  const ASHBY_ENTRY = ".ashby-application-form-field-entry, [data-field-entry-id], .ashby-application-form-input-radio-group, .ashby-application-form-input-checkbox-group";
  /** Ashby marks a required question with a `_required` class on its question title (in its field entry or choice group). */
  const ashbyRequired = (element: Element): boolean => {
    const title = element.closest(ASHBY_ENTRY)?.querySelector(".ashby-application-form-question-title");
    return Boolean(title && Array.from(title.classList).some((name) => /^_required(?:_|$)/.test(name)));
  };
  /**
   * Ashby's short titles ("Visa Support") put the question in the description: a label with no "?"
   * of at most 60 characters takes its entry's description of at most 240 characters that ends in
   * "?" (a trailing ":" is dropped).
   */
  const ashbyDescribed = (element: Element, label: string): string => {
    if (!label || label.includes("?") || label.length > 60) return label;
    const description = textOf(element.closest(ASHBY_ENTRY)?.querySelector(".ashby-application-form-question-description") ?? null).replace(/:\s*$/, "").trim();
    if (!description || description.length > 240 || !description.endsWith("?")) return label;
    return `${label}: ${description}`;
  };
  /** Ashby's text-message consent block, drawn inside the phone field's entry: its radios are not the phone question. */
  const TEXTING_CONSENT = ".ashby-application-form-texting-consent-description";
  const isOptionLabel = (element: Element): boolean => element.tagName === "LABEL" && Boolean(element.querySelector('input[type="radio"], input[type="checkbox"]'));
  /**
   * The question of Ashby's text-message consent radios (`communicationConsent`; `smsConsent` and
   * `whatsAppConsent` when both channels are asked): the consent body's first paragraph outside the
   * option labels and channel items, else the block's text without its option labels; a channel
   * item's own heading ("SMS", "WhatsApp") goes in front. Empty outside the block.
   */
  const textingConsentQuestion = (input: Element): string => {
    const block = input.closest(TEXTING_CONSENT);
    if (!block) return "";
    const paragraph = Array.from(block.querySelectorAll("p"))
      .filter((p) => !p.closest("label") && !p.closest("li"))
      .map((p) => textOf(p)).find(Boolean);
    const body = paragraph || textOf(block, isOptionLabel);
    const item = input.closest("li");
    const channel = item && block.contains(item)
      ? Array.from(item.querySelectorAll("p")).filter((p) => !p.closest("label")).map((p) => textOf(p)).find(Boolean) ?? ""
      : "";
    return collapse(channel && body ? `${channel}: ${body}` : body);
  };
  const requiredOf = (element: Element, label: string | undefined): boolean => {
    if ((element as HTMLInputElement).required || element.getAttribute("aria-required") === "true") return true;
    if (element.closest('[role="group"], [role="radiogroup"], fieldset')?.getAttribute("aria-required") === "true") return true;
    if (ashbyRequired(element)) return true;
    return MARKER.test(label ?? "");
  };
  /**
   * Greenhouse writes some questions as a short heading ("HISTORY WITH
   * IRONVALE") with the question itself in `<id>-description`: a label with no
   * "?" of at most 60 characters takes a visible description of at most 240
   * characters that ends in "?" (a trailing ":" is dropped).
   */
  const withDescription = (element: Element, label: string | undefined): string | undefined => {
    if (!label || !element.id || label.includes("?") || label.length > 60) return label;
    const description = textOf(document.getElementById(`${element.id}-description`)).replace(/:\s*$/, "").trim();
    if (!description || description.length > 240 || !description.endsWith("?")) return label;
    return `${label}: ${description}`;
  };
  const BARE_AGREEMENT = /^(?:yes[,.]?\s*)?(?:i\s+)?(?:agree|accept|consent|acknowledge|understand|confirm)(?:\s*(?:,|and|&)\s*(?:i\s+)?(?:agree|accept|consent|acknowledge|understand|confirm))*[.!]?$/i;
  /**
   * A lone checkbox whose own label is only an agreement ("I agree and consent") inside a fieldset with a
   * legend (Greenhouse's one-option checkbox question) takes the legend in front: "<legend>: <label>".
   */
  const withFieldsetQuestion = (element: Element, label: string | undefined): string | undefined => {
    if (!label || !(element instanceof HTMLInputElement) || element.type !== "checkbox" || label.length > 60 || !BARE_AGREEMENT.test(unstar(label))) return label;
    const fieldset = element.closest("fieldset");
    if (!fieldset || !root.contains(fieldset) || fieldset.querySelectorAll('input[type="checkbox"]').length !== 1) return label;
    const question = unstar(textOf(fieldset.querySelector("legend")) || byIds(fieldset.getAttribute("aria-labelledby"))).replace(/:\s*$/, "").trim();
    return question && question !== unstar(label) ? `${question}: ${unstar(label)}` : label;
  };
  /** A stable handle for a control with neither id nor name: the same element keeps its tag across collections. */
  const refOf = (element: Element): string => {
    const existing = element.getAttribute("data-ia-control");
    if (existing) return existing;
    let highest = 0;
    for (const tagged of Array.from(document.querySelectorAll("[data-ia-control]"))) {
      const match = /^ia-control-(\d+)$/.exec(tagged.getAttribute("data-ia-control") ?? "");
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    const ref = `ia-control-${highest + 1}`;
    element.setAttribute("data-ia-control", ref);
    return ref;
  };
  const optionLabel = (box: HTMLInputElement): string => {
    const owner = box.id ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`) : null;
    return unstar(textOf(owner) || textOf(box.closest("label")) || collapse(box.getAttribute("aria-label")) || nameLabel(box.value) || "");
  };
  /** A type-ahead input: a combobox, an aria-autocomplete list, a datalist, Lever's location box, or a "Start typing..." box. */
  const typeAhead = (input: HTMLInputElement): boolean => (input.type === "text" || input.type === "search")
    && (input.getAttribute("role") === "combobox"
      || /^(?:list|both)$/i.test(input.getAttribute("aria-autocomplete") ?? "")
      || input.hasAttribute("list")
      || /(?:^|\s)location-input(?:\s|$)/.test(input.className)
      || input.getAttribute("data-qa") === "location-input"
      || /^start typing/i.test(input.getAttribute("placeholder") ?? ""));
  /** A fieldset (or labelled group) holding only checkboxes, two or more: one question. */
  const checkboxGroupOf = (box: HTMLInputElement): Element | null => {
    const group = box.closest('fieldset, [role="group"][aria-labelledby], [role="group"][aria-label]');
    if (!group || !root.contains(group)) return null;
    const boxes = group.querySelectorAll('input[type="checkbox"]');
    if (boxes.length < 2) return null;
    const others = group.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]), select, textarea');
    return others.length === 0 ? group : null;
  };
  const named = (type: "radio" | "checkbox", name: string): HTMLInputElement[] =>
    (Array.from(root.querySelectorAll(`input[type="${type}"]`)) as HTMLInputElement[]).filter((box) => box.name === name);
  const groupsDone = new Set<Element>();
  const namesDone = new Set<string>();
  for (const element of Array.from(root.querySelectorAll(CONTROL))) {
    // A cookie-consent manager's buttons and toggles are never the application's.
    if (element.closest(CONSENT_ROOTS)) continue;
    if (element instanceof HTMLButtonElement) {
      controls.push({
        tag: "button",
        label: element.innerText?.trim() || element.textContent?.trim() || undefined
      });
      continue;
    }
    const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const type = input instanceof HTMLInputElement ? input.type : undefined;
    // A button drawn as an input ("Back", "Cancel"), or a control playing a button, link, or tab, is not a field.
    if (type === "button" || type === "reset" || ACTION_ROLE.test(input.getAttribute("role") ?? "")) continue;
    // A share or copy-link box (Oracle's copy-link-<uuid>) holds the posting's address, not a question.
    if (COPY_LINK.test(input.id || "") || COPY_LINK.test(input.getAttribute("name") ?? "")) continue;
    // Oracle Digital Assistant's chatbot popup (its required work-summary box, #oda-work-summary-text-area) is not the application's.
    if (location.hostname.endsWith(".oraclecloud.com") && input.closest('[id^="oda-"], .oda-chat-wrapper')) continue;
    if (input instanceof HTMLInputElement && type === "text" && input.readOnly && /^https?:\/\//i.test(input.value)) continue;
    // A newsletter or subscribe box (Amperity's footer newsletter form, Lucid's Subscribe block; captured 2026-11-27,
    // Track 77) asks for a marketing email, not an application answer.
    if (inSignupBox(input)) continue;
    // React-select's shadow input that only carries `required` for the form. A native radio inside a `role=radio` option
    // (Workable's Yes/No questions draw each option as div[role=radio] > label > hidden radio; captured 2026-11-27,
    // Track 77) is that option's own state, read as the radio question below.
    if (input.getAttribute("aria-hidden") === "true" && input.getAttribute("tabindex") === "-1" && type !== "file"
      && !(type === "radio" && input.closest('[role="radio"]'))) continue;
    // The hidden CAPTCHA token field is page machinery.
    if (TOKEN.test(input.name ?? "") || TOKEN.test(input.id ?? "")) continue;
    // Ashby's "Autofill from resume" box parses a resume into the form and redraws it, which drops every data-ia-control
    // tag; it is not a question. A form with surveys draws it as ashby-application-form-autofill-uploader, and the box
    // itself is always ashby-application-form-autofill-input-root (Ashby's public bundle index-DYKNvNNQ.js, read
    // 2026-11-27; TELUS Digital run <run id>, Track 67).
    if (type === "file" && input.closest(".ashby-application-form-autofill-pane, .ashby-application-form-autofill-uploader, .ashby-application-form-autofill-input-root")) continue;
    // A drop zone that autofills the form from a resume (Dover's "Autofill from resume") parses a resume; it is not a question, like Ashby's.
    if (type === "file" && /\bautofill\b/i.test(collapse(input.closest('[role="button"]')?.textContent))) continue;
    // Oracle Candidate Experience's "Import your profile from resume" box parses a resume into the form and redraws it
    // with new ids; it is not a question (Track 63, captured 2026-11-27).
    if (type === "file" && input.closest(".apply-flow-block--profile-import, .apply-flow-profile-import")) continue;
    if (input instanceof HTMLInputElement && type === "radio" && input.name) {
      // Radios sharing a name are one choice question.
      if (namesDone.has(`radio:${input.name}`)) continue;
      namesDone.add(`radio:${input.name}`);
      // Ashby names a single-choice question's radios after its field entry, "<form render id>_<field path>", and the
      // render id changes on every page load: the field path is the question's stable id (Track 25).
      const entry = input.closest("[data-field-entry-id]");
      const path = entry?.getAttribute("data-field-path") ?? "";
      const fieldId = path && entry?.getAttribute("data-field-entry-id") === input.name && input.name.endsWith(`_${path}`) ? path : input.name;
      const radios = named("radio", input.name);
      const group = input.closest('fieldset, [role="radiogroup"]');
      const consentBlock = input.closest(TEXTING_CONSENT);
      // Ashby's question title: a label inside the group that holds no control and is not one of its radios' labels.
      const radioIds = new Set(radios.map((radio) => radio.id).filter(Boolean));
      const titleLabel = group ? Array.from(group.querySelectorAll("label")).find((label) =>
        !label.querySelector(CONTROL) && !radioIds.has(label.getAttribute("for") ?? "")) : undefined;
      const rawLabel = textingConsentQuestion(input)
        || (group ? textOf(group.querySelector("legend")) || byIds(group.getAttribute("aria-labelledby")) || collapse(group.getAttribute("aria-label")) || textOf(titleLabel) || "" : "")
        || questionLabelNear(input) || nameLabel(input.name);
      // Ashby draws a chosen option from its own state (the option's `data-checked`); a DOM-only `checked` is not its answer.
      // Workable's `role=radio` option shows its state as `aria-checked`.
      const chosen = (radio: HTMLInputElement): boolean => {
        const option = radio.closest(".ashby-application-form-input-radio-group-option");
        if (option) return option.hasAttribute("data-checked");
        return radio.checked || radio.closest('[role="radio"]')?.getAttribute("aria-checked") === "true";
      };
      const checked = radios.find(chosen);
      const options = radios.map((radio) => {
        const label = optionLabel(radio);
        radio.setAttribute("data-ia-radio-option", label);
        radio.setAttribute("data-ia-radio-group", fieldId);
        return label;
      });
      controls.push({
        tag: "input",
        type: "radio",
        id: fieldId,
        name: input.name,
        label: (consentBlock ? unstar(rawLabel) : ashbyDescribed(input, unstar(rawLabel))) || undefined,
        required: radios.some((radio) => radio.required) || group?.getAttribute("aria-required") === "true" || (!consentBlock && ashbyRequired(input)) || MARKER.test(rawLabel),
        options: options.filter(Boolean),
        value: checked ? optionLabel(checked) || undefined : undefined
      });
      continue;
    }
    if (input instanceof HTMLInputElement && type === "checkbox") {
      // Ashby's Yes/No question: two or more buttons over a hidden checkbox, read as one radio question.
      const yesno = input.closest(".ashby-application-form-input-yesno");
      const choices = yesno ? Array.from(yesno.querySelectorAll("button")).map((button) => ({ button, text: collapse(button.textContent) })).filter((choice) => choice.text) : [];
      if (yesno && choices.length >= 2) {
        const ownLabel = labelFor(input);
        const pressed = choices.find((choice) => choice.button.getAttribute("aria-pressed") === "true");
        controls.push({
          tag: "input",
          type: "radio",
          id: input.id || undefined,
          name: input.name || undefined,
          label: ashbyDescribed(input, unstar(ownLabel ?? "")) || undefined,
          required: requiredOf(input, ownLabel),
          options: choices.map((choice) => choice.text),
          value: pressed?.text
        });
        continue;
      }
      const group = checkboxGroupOf(input);
      if (group) {
        if (groupsDone.has(group)) continue;
        groupsDone.add(group);
        const boxes = Array.from(group.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
        const boxIds = new Set(boxes.map((box) => box.id).filter(Boolean));
        const titleLabel = Array.from(group.querySelectorAll("label")).find((label) => !label.querySelector(CONTROL) && !boxIds.has(label.getAttribute("for") ?? "") && textOf(label));
        const legend = group.querySelector("legend");
        const rawLabel = textOf(legend) || byIds(group.getAttribute("aria-labelledby")) || collapse(group.getAttribute("aria-label")) || textOf(titleLabel) || "";
        const checked = boxes.filter((box) => box.checked).map(optionLabel).filter(Boolean);
        controls.push({
          tag: "input",
          type: "checkbox",
          widget: "checkbox-group",
          id: group.id || boxes[0]!.name || `checkbox-group-${groupsDone.size}`,
          label: unstar(rawLabel) || undefined,
          required: group.getAttribute("aria-required") === "true" || boxes.some((box) => box.required) || MARKER.test(rawLabel)
            || (!group.closest(TEXTING_CONSENT) && ashbyRequired(group)),
          options: boxes.map(optionLabel).filter(Boolean),
          value: checked.length ? checked.join(", ") : undefined
        });
        continue;
      }
      // Checkboxes sharing a name outside a group element: one question too.
      const boxes = input.name ? named("checkbox", input.name) : [];
      if (boxes.length >= 2) {
        if (namesDone.has(`checkbox:${input.name}`)) continue;
        namesDone.add(`checkbox:${input.name}`);
        const rawLabel = questionLabelNear(input) || nameLabel(input.name);
        const checked = boxes.filter((box) => box.checked).map(optionLabel).filter(Boolean);
        controls.push({
          tag: "input",
          type: "checkbox",
          widget: "checkbox-group",
          id: input.name,
          name: input.name,
          label: unstar(rawLabel) || undefined,
          required: boxes.some((box) => box.required) || MARKER.test(rawLabel),
          options: boxes.map(optionLabel).filter(Boolean),
          value: checked.length ? checked.join(", ") : undefined
        });
        continue;
      }
    }
    const ownLabel = labelFor(input);
    // A honeypot text box is a trap for bots: never a field, never filled.
    if ((input instanceof HTMLTextAreaElement || TEXT_LIKE.includes(type ?? ""))
      && HONEYPOT.test(`${ownLabel ?? ""} ${input.getAttribute("aria-label") ?? ""} ${input.getAttribute("placeholder") ?? ""} ${input.getAttribute("name") ?? ""} ${input.id ?? ""}`)) continue;
    const rawLabel = type === "file" ? fileLabel(input, ownLabel) : ownLabel;
    const label = withFieldsetQuestion(input, withDescription(input, rawLabel === undefined ? undefined : unstar(rawLabel) || undefined));
    const required = requiredOf(input, rawLabel);
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    if (input instanceof HTMLInputElement && input.getAttribute("role") === "combobox"
      && (/(?:^|\s)select__input(?:\s|$)/.test(input.className) || describedBy.includes("react-select-"))) {
      const shown = input.closest('[class*="select__control"]')?.querySelector('[class*="single-value"]')?.textContent?.trim();
      controls.push({ tag: "select", widget: "combobox", id: input.id || undefined, name: input.name || undefined, label, required, options: [], value: shown || undefined });
      continue;
    }
    const options = input instanceof HTMLSelectElement
      ? [...input.options].map((option) => option.label || option.value).filter(Boolean)
      : undefined;
    // A bare ARIA combobox (Eightfold's Octuple Select: `input[role=combobox]` naming its listbox by
    // aria-controls, readonly unless it filters): its list is read by opening it (createPlaywrightPage.collectControls).
    // A datalist, Lever's location box, and a "Start typing..." box are type-aheads, never opened.
    const listbox = input instanceof HTMLInputElement && (type === "text" || type === "search")
      && input.getAttribute("role") === "combobox"
      && !input.hasAttribute("list")
      && !/(?:^|\s)location-input(?:\s|$)/.test(input.className)
      && input.getAttribute("data-qa") !== "location-input"
      && !/^start typing/i.test(input.getAttribute("placeholder") ?? "")
      ? (input.readOnly ? "readonly" as const : "editable" as const)
      : undefined;
    controls.push({
      tag: input.tagName.toLowerCase() as RawControl["tag"],
      type,
      name: input.name || undefined,
      id: input.id || undefined,
      label,
      placeholder: collapse(input.getAttribute("placeholder")) || undefined,
      required,
      options,
      // Only a bare ARIA list reads the choice it shows ("+1" on a phone-country picker).
      value: listbox ? collapse(input.value) || undefined : undefined,
      widget: input instanceof HTMLInputElement && typeAhead(input) ? "autocomplete" : undefined,
      ref: input.id || input.name ? undefined : refOf(input),
      listbox
    });
  }
  return controls;
}

const SUBMIT_SELECTOR = 'button, input[type="submit"]';
/** Visible form controls, for deciding when a client-rendered form has finished drawing. */
const FORM_CONTROLS = 'input:not([type="hidden"]), textarea, select';

/**
 * Index (among `button, input[type="submit"]` under `root`) of the terminal
 * submit control, or -1. On Ashby its own submit button
 * (`.ashby-application-form-submit-button`) always wins, chosen while visible
 * even when disabled (Ashby disables it while loading; the click then waits
 * for it), and no other button on that page ever counts. Elsewhere a control
 * whose text (or an input's value) says submit wins over one that only says
 * apply, and the first control with an explicit type="submit" attribute is
 * the last resort; a "Quick apply" opener, a cancel control, disabled
 * controls, hidden controls (a zero box or visibility:hidden), cookie-consent
 * controls (inside a consent container, an osano-cm/onetrust/cookie id or
 * class, or accept-only wording), and a step's own controls ("Next",
 * "Continue", "Back") never count. A button's default type is never read as
 * saying submit: a `<button>` with no type attribute reports "submit", Ashby
 * draws every button that way, and before Track 27 every Ashby click went to
 * the autofill pane's "Upload file" button. Track 38: on MITRE's Phenom form
 * the last resort read Osano's typeless, hidden Accept as a submit. Runs in
 * the page.
 */
function findSubmitIndex(root: Element): number {
  const all = [...root.querySelectorAll('button, input[type="submit"]')];
  const ashbySubmits = all.filter((element) => element.matches(".ashby-application-form-submit-button"));
  if (ashbySubmits.length > 0) {
    const shown = ashbySubmits.find((element) => element.getClientRects().length > 0);
    return shown ? all.indexOf(shown) : -1;
  }
  // Track 38: never a cookie banner's control. Same list as cookie-consent.ts COOKIE_CONSENT_ROOTS, plus Osano's window.
  const CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i], .osano-cm-window';
  const CONSENT_MARK = /osano-cm-|onetrust|cookie/i;
  const CONSENT_TEXT = /^(?:accept|accept all|accept all cookies|accept cookies|allow all|allow all cookies|allow cookies|got it)$/i;
  // A step's own controls move between pages; they never submit.
  const STEP = /^(?:next|next step|continue|save (?:and|&) continue|proceed|back|previous)$/i;
  const shown = (element: HTMLElement): boolean => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const candidates = all.map((element, index) => {
    const value = element instanceof HTMLInputElement
      ? (element.value || ((element.type ?? "").toLowerCase() === "submit" ? "Submit" : ""))
      : ((element as HTMLButtonElement).value ?? "");
    const text = `${element.textContent ?? ""} ${value}`;
    return { index, element: element as HTMLElement, text, label: text.replace(/\s+/g, " ").trim() };
  }).filter((candidate) => !/\b(quick apply|cancel)\b/i.test(candidate.text)
    && shown(candidate.element)
    && !(candidate.element as HTMLButtonElement).disabled
    && !candidate.element.closest(CONSENT_ROOTS)
    && !CONSENT_MARK.test(`${candidate.element.id ?? ""} ${typeof candidate.element.className === "string" ? candidate.element.className : ""}`)
    && !STEP.test(candidate.label)
    && !CONSENT_TEXT.test(candidate.label));
  const submit = candidates.find((candidate) => /\b(submit|send application|complete application)\b/i.test(candidate.text))
    ?? candidates.find((candidate) => /\bapply\b/i.test(candidate.text))
    // Only an explicit type="submit": a <button> with no type reports "submit" by default (Osano's Accept did).
    ?? candidates.find((candidate) => (candidate.element.getAttribute("type") ?? "").toLowerCase() === "submit");
  return submit ? submit.index : -1;
}

/**
 * Tags the visible inputs of an emailed security-code step under `root` with
 * `data-ia-security-code="<index>"` and returns how many there are (0 when
 * none). Greenhouse's `#security-input-<n>` boxes win, in their numbered
 * order; otherwise inputs with autocomplete="one-time-code" or named or
 * labelled for a security or verification code, in document order. The
 * markup is derived from third-party descriptions, not captured. Runs in the
 * page, so every helper is declared here.
 */
function tagSecurityCodeInputsIn(root: Element): number {
  const SKIPPED = ["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file"];
  const NAMED = /\b(?:security|verification)\s*code\b/i;
  const BOX = /^security-input-(\d+)$/;
  for (const element of Array.from(root.querySelectorAll("[data-ia-security-code]"))) element.removeAttribute("data-ia-security-code");
  const shown = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const words = (text: string | null | undefined): string => (text ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  const candidates = Array.from(root.querySelectorAll("input")).filter((input) =>
    !input.disabled && shown(input) && !SKIPPED.includes((input.type || "text").toLowerCase()));
  let chosen: HTMLInputElement[];
  const boxes = candidates.filter((input) => BOX.test(input.id));
  if (boxes.length > 0) {
    chosen = boxes.sort((a, b) => Number(BOX.exec(a.id)![1]) - Number(BOX.exec(b.id)![1]));
  } else {
    chosen = candidates.filter((input) => {
      if ((input.getAttribute("autocomplete") ?? "").toLowerCase() === "one-time-code") return true;
      const labelledBy = (input.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "");
      const names = [
        input.id, input.name, input.getAttribute("aria-label"), input.getAttribute("placeholder"),
        ...Array.from(input.labels ?? []).map((label) => label.textContent ?? ""),
        ...labelledBy
      ].map(words).join(" ");
      return NAMED.test(names);
    });
  }
  chosen.forEach((input, index) => input.setAttribute("data-ia-security-code", String(index)));
  return chosen.length;
}

/** The values of the tagged security-code inputs, joined in index order. Runs in the page. */
function readSecurityCodeValueIn(root: Element): string {
  return Array.from(root.querySelectorAll("[data-ia-security-code]"))
    .map((element) => ({ index: Number(element.getAttribute("data-ia-security-code")), value: (element as HTMLInputElement).value ?? "" }))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.value)
    .join("");
}

/**
 * Index (among `button, input[type="submit"]` under `root`, the basis of
 * SUBMIT_SELECTOR) of the security-code step's own submit: the first visible,
 * enabled control after the last tagged code input whose text says submit,
 * verify, confirm, or continue; -1 when none or no input is tagged. Runs in
 * the page.
 */
function findSecurityCodeSubmitIndex(root: Element): number {
  const tagged = Array.from(root.querySelectorAll("[data-ia-security-code]"));
  const last = tagged[tagged.length - 1];
  if (!last) return -1;
  const controls = Array.from(root.querySelectorAll('button, input[type="submit"]'));
  for (const [index, element] of controls.entries()) {
    if (!(last.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    const text = `${element.textContent ?? ""} ${(element as HTMLInputElement).value ?? ""}`;
    if (/\b(quick apply|cancel)\b/i.test(text)) continue;
    if (/\b(submit|verify|confirm|continue)\b/i.test(text)) return index;
  }
  return -1;
}

export { findSubmitIndex, isSubmitControl };
