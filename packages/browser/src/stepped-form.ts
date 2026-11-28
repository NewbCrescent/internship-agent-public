import { parseWorkdayUrl, steppedFieldId, type BrowserField, type FillDecision, type PauseRecord, type RecognizedForm } from "@internship-agent/domain";

import { icimsHostOf } from "./apply-entry";
import { isOracleCandidateExperienceUrl } from "./ats/oracle-apply";
import type { VisibleChallenge } from "./challenge";
import { recognizeFields } from "./form-recognition";
import { applyDecisions, recognizeCurrentForm, unfilledPause, type ApplyDecisionsOptions, type BrowserPage, type UnfilledField } from "./handshake-executor";
import { isHandshakeHost } from "./handshake-session";
import type { StepButtons } from "./site-navigation";
import { invalidFieldKey, invalidFieldPauses, readNewConfirmationUrl, type InvalidField } from "./submission-outcome";

/**
 * Track 74: a several-page application form on a site the agent has no
 * adapter for, walked step by step when the page shows its step count
 * ("Step 1 of 5" in its text, or `step=<n>` in its address). Each step:
 * reject a cookie banner first (cookie-consent.ts, reject or necessary-only),
 * read the step, let the caller plan it with the existing planner, fill it,
 * and click only the step's own Next (a control whose whole text is Next,
 * Continue, Save and continue, Next step, or Proceed and that has no submit
 * word). The walk ends on the step that shows a submit control and no Next
 * (the last step), where nothing is clicked. It pauses on open questions,
 * on fields the page would not take, and on fields the site marks invalid
 * after Next; it is held on anything it cannot tell is safe (a later step
 * with no step count, both a submit control and a Next, a page that did not
 * move, a password field, what looks like a confirmation after Next, more
 * steps than expected). It never clicks a submit control, never types into a
 * password field, and never solves a CAPTCHA or bot check. No model
 * participates. The real Phenom and Paylocity steps after step 1 were never
 * captured: the fixtures that prove it are modelled.
 */

export type StepProgress = { index: number; total: number | null; source: "text" | "url" };

const STEP_TEXT = /\bstep\s+(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})\b/i;
const MAX_STEP = 20;

/** "Step 1 of 5" / "Step 2/4" in the page text (index 1..total, total 2..20), else `step=<n>` (1..20) in the URL query; null otherwise. Text wins over URL. Pure. */
export function readStepProgress(url: string, bodyText: string): StepProgress | null {
  const match = STEP_TEXT.exec(bodyText.replace(/\s+/g, " "));
  if (match) {
    const index = Number.parseInt(match[1]!, 10);
    const total = Number.parseInt(match[2]!, 10);
    if (index >= 1 && total >= 2 && index <= total && total <= MAX_STEP) return { index, total, source: "text" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const raw = parsed.searchParams.get("step");
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  const index = Number.parseInt(raw, 10);
  return index >= 1 && index <= MAX_STEP ? { index, total: null, source: "url" } : null;
}

/**
 * Whether a page the several-page stop would hold may be walked instead: Next and no submit control, a step count, and
 * not Oracle Cloud HCM Candidate Experience (its own open bug), iCIMS, Handshake, or Workday. Pure.
 */
export function steppedWalkEligible(url: string, bodyText: string, buttons: StepButtons): boolean {
  if (buttons.submit || buttons.next === null) return false;
  if (readStepProgress(url, bodyText) === null) return false;
  if (isOracleCandidateExperienceUrl(url) || icimsHostOf(url) !== null || parseWorkdayUrl(url) !== null) return false;
  let host: string | null;
  try {
    host = new URL(url).hostname;
  } catch {
    host = null;
  }
  return !(host !== null && isHandshakeHost(host));
}

export const STEP_NEXT_MARK = "data-ia-step-next";

/**
 * Runs in the page: tags the first visible, enabled control outside cookie-consent containers whose collapsed text
 * equals `text` (case-insensitive), matches the Next pattern, and has no submit word; clears earlier tags. Same element
 * set, text, and visibility rules as site-navigation.ts readStepButtonsIn. Every helper is declared here.
 */
export function tagStepNextIn(root: Element, text: string): boolean {
  // Same list as cookie-consent.ts COOKIE_CONSENT_ROOTS; copied because this runs in the page.
  const CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  // Same value as STEP_NEXT_MARK; copied because this runs in the page.
  const MARK = "data-ia-step-next";
  const NEXT = /^(?:next|continue|save (?:and|&) continue|next step|proceed)$/i;
  const SUBMIT = /\b(?:submit|send|finish|complete|apply)\b/i;
  const wanted = text.replace(/\s+/g, " ").trim().toLowerCase();
  for (const tagged of Array.from(root.querySelectorAll(`[${MARK}]`))) tagged.removeAttribute(MARK);
  if (!NEXT.test(wanted) || SUBMIT.test(wanted)) return false;
  for (const element of Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))) {
    if (element.closest(CONSENT_ROOTS)) continue;
    if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    const shown = ((element as HTMLElement).innerText || (element instanceof HTMLInputElement ? element.value : "") || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ").trim();
    if (!shown || shown.toLowerCase() !== wanted || !NEXT.test(shown) || SUBMIT.test(shown)) continue;
    element.setAttribute(MARK, "1");
    return true;
  }
  return false;
}

export type SteppedPage = BrowserPage & {
  /** Whether the page shows a submit control, and its "Next" control if any. */
  stepButtons(): Promise<StepButtons>;
  /** Clicks the step's own Next control (tagStepNextIn); false when none matched or the click failed. Never a submit control. */
  clickStepNext(text: string): Promise<boolean>;
  /** Rejects or takes necessary-only on a cookie banner (cookie-consent.ts); optional for in-memory pages. */
  rejectCookies?(): Promise<unknown>;
};

export function hasSteppedWalk(page: BrowserPage): page is SteppedPage {
  return "clickStepNext" in page && "stepButtons" in page;
}

export type SteppedStepPlan = {
  decisions: FillDecision[];
  pauses: PauseRecord[];
  safeguardHalt: boolean;
  uploadPathFor?: (decision: FillDecision) => string | null;
  applyOptions?: ApplyDecisionsOptions;
};

/** The step the walk ended on, with ids as the page has them. */
export type SteppedWalkLast = { step: number; form: RecognizedForm; decisions: FillDecision[]; pauses: PauseRecord[]; unfilled: UnfilledField[] };

export type SteppedWalkResult = {
  /**
   * last-page: a step with a submit control and no Next was filled (nothing clicked); paused: open questions,
   * unfillable fields, or fields the site marked invalid after Next; challenge: a visible CAPTCHA or bot check (never
   * solved); held: the walk stopped for the reason in `hold`.
   */
  outcome: "last-page" | "paused" | "challenge" | "held";
  /** Site step numbers visited, in order. */
  steps: number[];
  /** Every step's decisions, ids step-prefixed (steppedFieldId). */
  decisions: FillDecision[];
  /** Every step's pauses, ids step-prefixed. */
  pauses: PauseRecord[];
  /** Step-prefixed id -> label. */
  fieldLabels: Record<string, string>;
  hold: string | null;
  challenge: VisibleChallenge | null;
  /** The step the walk ended on. */
  last: SteppedWalkLast | null;
};

/** A confirmation shown after a Next: stricter than form-recognition.ts CONFIRMATION_PATTERN, which also matches "thank you" and "confirmation". */
const STRONG_CONFIRMATION = /\b(?:thank you for applying|thanks for applying|application (?:has been|was|is) (?:successfully )?(?:submitted|received)|we(?:'|’)ve received your application|we have received your application|successfully submitted|submission received|application submitted)\b/i;
const PASSWORD = /\bpassword\b/i;
/** How long after the Next click a new field error counts as the site refusing the step. */
const INVALID_AFTER_MS = 1_000;

function fieldKey(field: BrowserField): string {
  return `${field.id}\u0000${field.label}`;
}

function fieldFingerprint(fields: BrowserField[]): string {
  return fields.map(fieldKey).sort().join("\n");
}

async function currentFingerprint(page: BrowserPage): Promise<string | null> {
  try {
    return fieldFingerprint(recognizeFields(await page.collectControls()));
  } catch {
    return null;
  }
}

async function readInvalid(page: BrowserPage): Promise<InvalidField[]> {
  if (!page.invalidFields) return [];
  try {
    return await page.invalidFields();
  } catch {
    return [];
  }
}

type StepMove = { kind: "moved" } | { kind: "invalid"; invalid: InvalidField[] } | { kind: "stuck" };

/** Polls until the step moved on (address, step count, or fields changed), the site marked a new field invalid, or the time ran out. */
async function waitForStepMove(
  page: BrowserPage,
  before: { url: string; stepIndex: number; fingerprint: string; invalid: Set<string> },
  settle: { timeoutMs: number; pollMs: number }
): Promise<StepMove> {
  const clickedAt = Date.now();
  const deadline = clickedAt + settle.timeoutMs;
  for (;;) {
    const url = page.url();
    if (url !== before.url) return { kind: "moved" };
    const body = await page.bodyText().catch(() => null);
    if (body !== null && readStepProgress(url, body)?.index !== before.stepIndex) return { kind: "moved" };
    const fingerprint = await currentFingerprint(page);
    if (fingerprint !== null && fingerprint !== before.fingerprint) return { kind: "moved" };
    if (Date.now() - clickedAt >= INVALID_AFTER_MS) {
      const invalid = (await readInvalid(page)).filter((field) => !before.invalid.has(invalidFieldKey(field)));
      if (invalid.length > 0) return { kind: "invalid", invalid };
    }
    if (Date.now() >= deadline) return { kind: "stuck" };
    await new Promise((resolve) => setTimeout(resolve, settle.pollMs));
  }
}

/** Replaces each field the page would not take with its pause (as workday.ts walkWorkdayApplication does). */
function pauseUnfilled(
  form: RecognizedForm,
  decisions: FillDecision[],
  pauses: PauseRecord[],
  unfilled: UnfilledField[],
  runId: string | undefined
): { decisions: FillDecision[]; pauses: PauseRecord[] } {
  let nextDecisions = decisions;
  let nextPauses = pauses;
  for (const entry of unfilled) {
    const field = form.fields.find((candidate) => candidate.id === entry.fieldId);
    if (!field) continue;
    const held = unfilledPause(field, entry.reason, runId);
    nextDecisions = nextDecisions.map((decision) => (decision.fieldId === entry.fieldId ? held.decision : decision));
    nextPauses = [...nextPauses.filter((pause) => pause.fieldId !== entry.fieldId), held.pause];
  }
  return { decisions: nextDecisions, pauses: nextPauses };
}

/**
 * Walks the form from the step the page shows (see the header). `planStep` plans one step's form (fields already
 * filled on an earlier step of this walk are left out); the walk fills it and moves on with the step's own Next. It
 * never calls `page.clickSubmit()`.
 */
export async function walkSteppedForm(
  page: SteppedPage,
  planStep: (step: number, form: RecognizedForm) => Promise<SteppedStepPlan>,
  options: { runId?: string; maxSteps?: number; settle?: { timeoutMs?: number; pollMs?: number } } = {}
): Promise<SteppedWalkResult> {
  const maxSteps = options.maxSteps ?? 12;
  const settle = { timeoutMs: options.settle?.timeoutMs ?? 20_000, pollMs: options.settle?.pollMs ?? 250 };
  const result: SteppedWalkResult = { outcome: "held", steps: [], decisions: [], pauses: [], fieldLabels: {}, hold: null, challenge: null, last: null };
  const held = (reason: string): SteppedWalkResult => {
    result.outcome = "held";
    result.hold = reason;
    return result;
  };
  // This step's records replace any it had (step numbers only rise within one walk).
  const record = (step: number, decisions: FillDecision[], pauses: PauseRecord[]): void => {
    const prefix = `step-${step}::`;
    result.decisions = [
      ...result.decisions.filter((decision) => !decision.fieldId.startsWith(prefix)),
      ...decisions.map((decision) => ({ ...decision, fieldId: steppedFieldId(step, decision.fieldId) }))
    ];
    result.pauses = [
      ...result.pauses.filter((pause) => !pause.fieldId.startsWith(prefix)),
      ...pauses.map((pause) => ({ ...pause, fieldId: steppedFieldId(step, pause.fieldId) }))
    ];
  };
  const seen = new Set<string>();
  let prevStep: number | null = null;
  let lastNext: string | null = null;
  for (let visited = 0; visited < maxSteps; visited += 1) {
    if (page.rejectCookies) await page.rejectCookies().catch(() => undefined);
    const pageForm = await recognizeCurrentForm(page);
    const url = page.url();
    const body = await page.bodyText().catch(() => "");
    const progress = readStepProgress(url, body);
    const step: number = progress?.index ?? (prevStep === null ? 1 : prevStep + 1);
    if (prevStep !== null && step <= prevStep) return held(`the site showed step ${step} again after "${lastNext}"`);
    if (pageForm.fields.some((field) => PASSWORD.test(field.label))) {
      return held(`step ${step} asks for a password (a sign-in or account step), which the agent never types into`);
    }
    const form: RecognizedForm = { ...pageForm, fields: pageForm.fields.filter((field) => !seen.has(fieldKey(field))) };
    const plan = await planStep(step, form);
    result.steps.push(step);
    for (const field of form.fields) result.fieldLabels[steppedFieldId(step, field.id)] = field.label;
    record(step, plan.decisions, plan.pauses);
    if (plan.safeguardHalt) {
      result.outcome = "challenge";
      result.challenge = page.visibleChallenge ? await page.visibleChallenge().catch(() => null) : null;
      result.last = { step, form, decisions: plan.decisions, pauses: plan.pauses, unfilled: [] };
      return result;
    }
    const open = plan.pauses.filter((pause) => pause.status === "open");
    const { unfilled } = await applyDecisions(page, form, plan.decisions, plan.uploadPathFor, plan.applyOptions);
    const filled = pauseUnfilled(form, plan.decisions, plan.pauses, unfilled, options.runId);
    record(step, filled.decisions, filled.pauses);
    result.last = { step, form, decisions: filled.decisions, pauses: filled.pauses, unfilled };
    if (open.length > 0 || unfilled.length > 0) {
      result.outcome = "paused";
      return result;
    }
    for (const field of form.fields) seen.add(fieldKey(field));
    const challenge = page.visibleChallenge ? await page.visibleChallenge().catch(() => null) : null;
    if (challenge) {
      result.outcome = "challenge";
      result.challenge = challenge;
      return result;
    }
    // Read after filling: sites enable their Next late.
    const buttons = await page.stepButtons();
    if (buttons.submit && !buttons.next) {
      result.outcome = "last-page";
      return result;
    }
    if (buttons.submit && buttons.next) return held(`step ${step} shows both a submit control and "${buttons.next}"`);
    if (!buttons.next) return held(`step ${step} shows neither a "Next" nor a submit control`);
    if (!progress || (progress.total !== null && progress.index >= progress.total)) {
      return held(`step ${step} shows "${buttons.next}" but no step count before its last step, so the agent cannot tell it from the final submit`);
    }
    const invalidBefore = new Set((await readInvalid(page)).map(invalidFieldKey));
    // The fields as they show after filling (a choice may draw a follow-up question), so only the step's own move counts.
    const fingerprint = (await currentFingerprint(page)) ?? fieldFingerprint(pageForm.fields);
    if (!(await page.clickStepNext(buttons.next))) return held(`"${buttons.next}" on step ${step} could not be clicked`);
    lastNext = buttons.next;
    const moved = await waitForStepMove(page, { url, stepIndex: progress.index, fingerprint, invalid: invalidBefore }, settle);
    if (moved.kind === "invalid") {
      const refused = invalidFieldPauses(form, filled.decisions, filled.pauses, moved.invalid);
      record(step, refused.decisions, refused.pauses);
      result.last = { step, form, decisions: refused.decisions, pauses: refused.pauses, unfilled };
      result.outcome = "paused";
      return result;
    }
    if (moved.kind === "stuck") return held(`step ${step} did not move on after "${buttons.next}" and showed no field error`);
    const after = await page.bodyText().catch(() => "");
    if ((STRONG_CONFIRMATION.test(after) && !STRONG_CONFIRMATION.test(body)) || readNewConfirmationUrl(url, page.url())) {
      return held(`after "${buttons.next}" on step ${step} the site showed what looks like a confirmation; check the application on the site before anything else (the run is not marked submitted)`);
    }
    await page.waitForFormReady?.();
    prevStep = step;
  }
  return held(`the application had more than ${maxSteps} steps`);
}
