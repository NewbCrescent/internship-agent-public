import type { Locator, Page } from "playwright-core";

import type { BrowserField, FillDecision, PauseRecord, RecognizedForm } from "@internship-agent/domain";

import { chooseApplyEntry, type ApplyEntryCandidate } from "./apply-entry";
import { matchSuggestion } from "./autofill-planner";
import { findVisibleChallengeIn, SubmissionChallenged, SubmissionRefused, type VisibleChallenge } from "./challenge";
import { isSubmitControl, readNewConfirmation, recognizeForm, waitForStableControls, type RawControl } from "./form-recognition";
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
  /** Visible error or alert text, read after a submit that showed no confirmation. */
  alertText?(): Promise<string>;
  /**
   * Text of the site's own post-submit success container (Ashby's
   * `.ashby-application-form-success-container`), read from the DOM; empty
   * when none is shown.
   */
  successText?(): Promise<string>;
  /**
   * Follows the posting's Apply entry once (chooseApplyEntry) and returns the
   * URL it reached, or null when the page has none.
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
  const controls = await page.collectControls();
  return recognizeForm(page.url(), await page.title(), controls);
}

/**
 * A field the page would not take a known value into: a type-ahead with no
 * matching suggestion, a choice that is not a text box, an option that is not
 * there. The run pauses on the field instead of stopping.
 */
export class FieldUnfillable extends Error {}

/** A field applyDecisions could not fill, with a plain reason (never a raw Playwright message). */
export type UnfilledField = { fieldId: string; reason: string };

function unfilledReason(error: unknown): string {
  if (error instanceof FieldUnfillable) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return "the field did not respond in time";
  return "the page did not accept the value";
}

/** The pause that replaces a decision applyDecisions could not apply. */
export function unfilledPause(field: BrowserField, reason: string): { decision: FillDecision; pause: PauseRecord } {
  const question = `The agent could not fill "${field.label}": ${reason}. Answer it here, or fill it in the browser.`.slice(0, 500);
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
      sensitive: false,
      upload: field.kind === "file",
      status: "open",
      answer: null,
      draft: null,
      fieldKind: field.kind,
      ...(field.options?.length ? { options: field.options } : {})
    }
  };
}

/**
 * Applies the planned decisions. A page action that fails (a timeout, a
 * type-ahead with no matching suggestion, a choice that is not a text box)
 * is reported in `unfilled` instead of stopping the run; callers turn each
 * into a pause. An upload with no resolved file is a broken invariant and
 * still throws.
 */
export async function applyDecisions(
  page: BrowserPage,
  form: RecognizedForm,
  decisions: FillDecision[],
  uploadPathFor?: (decision: FillDecision) => string | null
): Promise<{ applied: number; skipped: number; unfilled: UnfilledField[] }> {
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  let applied = 0;
  let skipped = 0;
  const unfilled: UnfilledField[] = [];
  const attempt = async (field: BrowserField, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      applied += 1;
    } catch (error) {
      unfilled.push({ fieldId: field.id, reason: unfilledReason(error) });
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
        await attempt(field, () => page.uploadFile(field, path));
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
 *
 * Every error after the click carries the page's evidence; the agent writes it
 * to the run's local folder.
 */
export async function submitAndConfirm(
  page: BrowserPage,
  options: { timeoutMs?: number; pollMs?: number; securityCode?: SecurityCodeLookup | null } = {}
): Promise<string> {
  const before = await page.bodyText();
  const beforeUrl = page.url();
  const successBefore = page.successText ? (await page.successText()).trim() : "";
  const invalidBefore = page.invalidFields ? await page.invalidFields().catch((): InvalidField[] => []) : [];
  const codeInputsBefore = page.securityCodeInputs ? await page.securityCodeInputs().catch(() => 0) : 0;
  const clickedAt = new Date();
  await page.clickSubmit();
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
    const evidence = scrubbed(await capturePostSubmitEvidence(page, kind, { invalidFields: invalidAfter, alertText: refusal }));
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
    const dialogClosed = page.applicationDialogOpen ? !(await page.applicationDialogOpen()) : false;
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
      return controls;
    },
    bodyText: async () => {
      await ensureNameShim(page);
      return page.evaluate(() => document.body?.innerText ?? "");
    },
    fillField: async (field, value) => {
      const control = await locateField(field);
      const kind = await control.evaluate((element) => element instanceof HTMLInputElement ? element.type : "", undefined, { timeout: 10_000 });
      // A radio, checkbox, or upload is never typed into.
      if (kind === "radio" || kind === "checkbox" || kind === "file") throw new FieldUnfillable("it is a choice, not a text box");
      await control.fill(value, { timeout: 10_000 });
    },
    chooseOption: async (field, option) => {
      if (field.widget === "autocomplete") {
        await chooseSuggestion(page, await locateField(field), field, option);
        return;
      }
      if (field.kind === "radio" || field.kind === "checkbox") {
        // Radios (and checkboxes outside a group element) sharing a name are one question: the field id is that name.
        const named = within().locator(`input[type="${field.kind}"][name="${cssValue(field.id)}"]`);
        const byId = field.kind === "checkbox" ? await within().locator(idSelector(field.id)).count().catch(() => 0) : 0;
        if (byId === 0 && (await named.count().catch(() => 0)) > 0) {
          const target = named.and(within().getByRole(field.kind, { name: option, exact: true }));
          if ((await target.count()) === 0) throw new FieldUnfillable("the option was not found");
          await target.first().check({ timeout: 10_000 });
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
      await root().locator(SUBMIT_SELECTOR).nth(index).click();
    },
    screenshot: async (path, options) => {
      await page.screenshot({ path, fullPage: options?.fullPage ?? false });
    },
    close: () => page.close(),
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
    applicationDialogOpen: async () => (scope ? scope.isVisible() : false),
    waitForFormReady: async () => {
      await waitForStableControls(() => root().locator(FORM_CONTROLS).count());
    },
    visibleChallenge: async () => {
      // The top document, not the dialog scope: challenge frames sit outside forms.
      try {
        await ensureNameShim(page);
        return await page.evaluate(findVisibleChallengeIn);
      } catch {
        return null;
      }
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
    followApplyEntry: async () => {
      // The whole page, not a dialog scope: the main frame plus same-host frames
      // (iCIMS draws the job inside a same-host iframe). One entry, at most.
      try {
        await ensureNameShim(page);
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
        if (!chosen) return null;
        if (chosen.tag === "a" && chosen.href) {
          await page.goto(chosen.href, { waitUntil: "domcontentloaded" });
        } else {
          await frames[chosen.frame]!.locator(`[data-ia-apply-entry="${chosen.index}"]`).first().click({ timeout: 10_000 });
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        }
        return page.url();
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
    const index = entries.length;
    element.setAttribute("data-ia-apply-entry", String(index));
    entries.push({ tag: anchor ? "a" : "button", href, texts, className, index });
  }
  return entries;
}

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

/**
 * Types the saved value into a type-ahead field and picks the suggestion
 * that matches it exactly or uniquely (matchSuggestion). A "City, Region"
 * value with no match is typed again as the city alone (a search that does
 * not know "Springfield, IL"), and the suggestions are still matched against the
 * whole value. No match: the typed text is cleared, its list closed, and the
 * field left without focus so the list never covers the next field; the field
 * is reported unfillable, never guessed.
 */
async function chooseSuggestion(page: Page, input: Locator, field: BrowserField, value: string): Promise<void> {
  await settleOpenMenus(page);
  const shown = value.length > 60 ? `${value.slice(0, 59)}…` : value;
  if (field.kind === "select") await input.click({ timeout: 10_000 });
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
        const match = matchSuggestion(value, texts);
        if (match !== null) found = { source, index: texts.indexOf(match) };
        break;
      }
      if (!found) await page.waitForTimeout(250);
    }
    return found;
  };
  let picked = await search(value);
  const city = value.includes(",") ? value.slice(0, value.indexOf(",")).trim() : "";
  if (!picked && city) picked = await search(city);
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

/**
 * Picks one option of a react-select list and checks that the control shows
 * it. Greenhouse's phone-country list shows only the chosen country's dialing
 * code ("+1" for "United States +1"), which counts as showing that option.
 */
async function chooseComboboxOption(page: Page, control: Locator, field: BrowserField, option: string): Promise<void> {
  await settleOpenMenus(page);
  await control.click({ timeout: 5_000 });
  // A list that loads its options (Greenhouse's Degree catalog) shows them a moment after opening.
  await page.locator('[role="option"], [class*="select__option"]').filter({ visible: true }).first()
    .waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  const byRole = page.getByRole("option", { name: option, exact: true });
  const target = (await byRole.count()) > 0
    ? byRole.first()
    : page.locator('[class*="select__option"]').filter({ hasText: new RegExp(`^\\s*${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }).first();
  await target.click({ timeout: 5_000 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const shown = await control.evaluate((element) =>
      element.closest('[class*="select__control"]')?.querySelector('[class*="single-value"]')?.textContent?.trim() ?? "");
    if (shown === option || (/^\+\d{1,4}$/.test(shown) && option.endsWith(` ${shown}`))) return;
    await page.waitForTimeout(200);
  }
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
  for (const element of Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [id$="-error"], .error, .error-message, .flash-error'))) {
    if (element.getClientRects().length === 0) continue;
    const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts.join(" ").slice(0, 300);
}

/** The text of the first shown post-submit success container (Ashby's), collapsed and clipped; "" when none. Runs in the page. */
function readSuccessTextIn(): string {
  for (const element of Array.from(document.querySelectorAll(".ashby-application-form-success-container"))) {
    if (element.getClientRects().length === 0) continue;
    const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 2_000);
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
 * groups become one question, type-ahead inputs are marked `autocomplete`, and
 * react-select's hidden required inputs, Ashby's "Autofill from resume" parser
 * input, a resume-autofill drop zone's input (a `role="button"` box whose text
 * says "autofill", as Dover's), and the CAPTCHA token field are not controls. Ashby's Yes/No button
 * pairs are read as one radio question, its `_required` question-title class
 * marks a question required, and a fieldset's question-title label (not one
 * for its radios) labels the radio group. A short Greenhouse question label
 * with no "?" takes its `<id>-description` question as well ("HISTORY WITH
 * IRONVALE: Have you previously applied to a position at Ironvale?"). A control
 * with neither id nor name is tagged `data-ia-control="ia-control-<n>"` and
 * carries that tag as its ref; the tag stays the same across repeated
 * collections, so a field id from an earlier recognition still names the
 * same element.
 */
function collectControlsIn(root: Element): RawControl[] {
  const controls: RawControl[] = [];
  const TOKEN = /^(?:g-recaptcha-response|h-captcha-response|cf-turnstile-response)(?:-\d+)?$/i;
  const GENERIC_FILE = /^(?:attach|upload|choose (?:a )?file|browse|select (?:a )?file|add (?:a )?file|drop (?:files? )?here.*)$/i;
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
  const textOf = (element: Element | null | undefined): string => {
    if (!element) return "";
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node): number => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        const child = node as Element;
        if (child.matches("input, textarea, select, button, option, script, style")) return NodeFilter.FILTER_REJECT;
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
    const input = element as HTMLInputElement;
    if (input instanceof HTMLInputElement && ["hidden", "submit", "image", "button", "reset"].includes(input.type)) return false;
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
  /** The label and where it came from; placeholder and name are the last resort, after the question text near the control. */
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
      // Lever wraps the whole question in a label: its own label element holds the question.
      const own = Array.from(wrapping.querySelectorAll('[class*="label"]')).find((candidate) => !candidate.querySelector(CONTROL) && textOf(candidate));
      const wrapped = textOf(own) || textOf(wrapping);
      if (wrapped) return wrapped.slice(0, 300);
    }
    const near = questionLabelNear(element);
    if (near) return near;
    return collapse(element.getAttribute("placeholder")) || nameLabel((element as HTMLInputElement).name) || undefined;
  };
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
      if (Array.from(node.querySelectorAll(CONTROL)).filter((other) => isQuestion(other) && other !== element).length > 0) return own;
      for (const candidate of Array.from(node.querySelectorAll('legend, label, [class*="label"], [class*="FormLabel"]'))) {
        if (candidate.getAttribute("for") === element.id && element.id) continue;
        if (candidate.closest(ACTION)) continue;
        if (notQuestionText(candidate)) continue;
        const text = textOf(candidate);
        if (text && !GENERIC_FILE.test(unstar(text))) return text;
      }
    }
    return own;
  };
  /** Ashby marks a required question with a `_required` class on its question title. */
  const ashbyRequired = (element: Element): boolean => {
    const title = element.closest(".ashby-application-form-field-entry")?.querySelector(".ashby-application-form-question-title");
    return Boolean(title && Array.from(title.classList).some((name) => /^_required(?:_|$)/.test(name)));
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
    // React-select's shadow input that only carries `required` for the form.
    if (input.getAttribute("aria-hidden") === "true" && input.getAttribute("tabindex") === "-1" && type !== "file") continue;
    // The hidden CAPTCHA token field is page machinery.
    if (TOKEN.test(input.name ?? "") || TOKEN.test(input.id ?? "")) continue;
    // Ashby's "Autofill from resume" box parses a resume into the form; it is not a question.
    if (type === "file" && input.closest(".ashby-application-form-autofill-pane")) continue;
    // A drop zone that autofills the form from a resume (Dover's "Autofill from resume") parses a resume; it is not a question, like Ashby's.
    if (type === "file" && /\bautofill\b/i.test(collapse(input.closest('[role="button"]')?.textContent))) continue;
    if (input instanceof HTMLInputElement && type === "radio" && input.name) {
      // Radios sharing a name are one choice question.
      if (namesDone.has(`radio:${input.name}`)) continue;
      namesDone.add(`radio:${input.name}`);
      const radios = named("radio", input.name);
      const group = input.closest('fieldset, [role="radiogroup"]');
      // Ashby's question title: a label inside the group that holds no control and is not one of its radios' labels.
      const radioIds = new Set(radios.map((radio) => radio.id).filter(Boolean));
      const titleLabel = group ? Array.from(group.querySelectorAll("label")).find((label) =>
        !label.querySelector(CONTROL) && !radioIds.has(label.getAttribute("for") ?? "")) : undefined;
      const rawLabel = (group ? textOf(group.querySelector("legend")) || byIds(group.getAttribute("aria-labelledby")) || collapse(group.getAttribute("aria-label")) || textOf(titleLabel) || "" : "")
        || questionLabelNear(input) || nameLabel(input.name);
      const checked = radios.find((radio) => radio.checked);
      controls.push({
        tag: "input",
        type: "radio",
        id: input.name,
        name: input.name,
        label: unstar(rawLabel) || undefined,
        required: radios.some((radio) => radio.required) || group?.getAttribute("aria-required") === "true" || ashbyRequired(input) || MARKER.test(rawLabel),
        options: radios.map(optionLabel).filter(Boolean),
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
          label: unstar(ownLabel ?? "") || undefined,
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
        const legend = group.querySelector("legend");
        const rawLabel = textOf(legend) || byIds(group.getAttribute("aria-labelledby")) || collapse(group.getAttribute("aria-label")) || "";
        const checked = boxes.filter((box) => box.checked).map(optionLabel).filter(Boolean);
        controls.push({
          tag: "input",
          type: "checkbox",
          widget: "checkbox-group",
          id: group.id || boxes[0]!.name || `checkbox-group-${groupsDone.size}`,
          label: unstar(rawLabel) || undefined,
          required: group.getAttribute("aria-required") === "true" || boxes.some((box) => box.required) || MARKER.test(rawLabel),
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
    const rawLabel = type === "file" ? fileLabel(input, ownLabel) : ownLabel;
    const label = withDescription(input, rawLabel === undefined ? undefined : unstar(rawLabel) || undefined);
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
    controls.push({
      tag: input.tagName.toLowerCase() as RawControl["tag"],
      type,
      name: input.name || undefined,
      id: input.id || undefined,
      label,
      placeholder: collapse(input.getAttribute("placeholder")) || undefined,
      required,
      options,
      widget: input instanceof HTMLInputElement && typeAhead(input) ? "autocomplete" : undefined,
      ref: input.id || input.name ? undefined : refOf(input)
    });
  }
  return controls;
}

const SUBMIT_SELECTOR = 'button, input[type="submit"]';
/** Visible form controls, for deciding when a client-rendered form has finished drawing. */
const FORM_CONTROLS = 'input:not([type="hidden"]), textarea, select';

/**
 * Index (among `button, input[type="submit"]` under `root`) of the terminal
 * submit control, or -1. A control that says submit wins over one that only
 * says apply; a "Quick apply" opener, a cancel control, and hidden or
 * disabled controls never count.
 */
function findSubmitIndex(root: Element): number {
  const candidates = [...root.querySelectorAll('button, input[type="submit"]')].map((element, index) => ({
    index,
    element: element as HTMLElement,
    text: `${element.textContent ?? ""} ${(element as HTMLInputElement).value ?? ""} ${(element as HTMLInputElement).type ?? ""}`
  })).filter((candidate) => !/\b(quick apply|cancel)\b/i.test(candidate.text)
    && candidate.element.getClientRects().length > 0
    && !(candidate.element as HTMLButtonElement).disabled);
  const submit = candidates.find((candidate) => /\b(submit|send application|complete application)\b/i.test(candidate.text))
    ?? candidates.find((candidate) => /\bapply\b/i.test(candidate.text));
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

export { isSubmitControl };
