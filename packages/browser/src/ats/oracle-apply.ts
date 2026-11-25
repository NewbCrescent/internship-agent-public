import type { Page } from "playwright-core";

import { findVisibleChallengeIn } from "../challenge";
import { ensureNameShim } from "../handshake-executor";

/**
 * Oracle Cloud HCM Candidate Experience's email and one-time-code (PIN)
 * screens, in front of its application form. The markup is derived from
 * Oracle's public Candidate Experience bundle (static.oracle.com
 * oj-hcm-ce 2610.17: the email-verification, legal-disclaimer, pin-code,
 * candidate-verification, and apply-flow-pagination templates) and from a
 * read-only capture of two tenants' email steps on 2026-11-24; the PIN,
 * identity, and already-applied screens were never captured. Deterministic,
 * no model. The step types into nothing but the `primary-email` box and the
 * PIN boxes; it never clicks Resend, Cancel, the terms link, "keep me signed
 * in", the SMS toggle, or anything on an identity or already-applied screen,
 * and it never solves a CAPTCHA. The emailed code is never logged, returned,
 * or put in an error.
 */
export type OracleApplyScreen = "email" | "pin" | "identity" | "already-applied" | "captcha" | "loading" | "form" | "other";

/** How long to wait for Oracle's answer to Next or Verify: by default 30 s, checked every 250 ms. */
export type OracleWaitOptions = { timeoutMs?: number; pollMs?: number };

export type OracleInspection = {
  /** Visible `input[id^="primary-email"]` (else visible `input[type=email]`) inside a form. */
  emailInputs: number;
  /** The email box's form has a visible, enabled submit button. */
  emailNext: boolean;
  /** `#legal-disclaimer-checkbox` exists. */
  termsPresent: boolean;
  termsChecked: boolean;
  /** The terms box's label text, collapsed, without a trailing "*", at most 300 characters. */
  termsStatement: string;
  /** `#applyFlowVerifyEmail` is pressed; null when the page shows no verification-method toggles. */
  emailMethodActive: boolean | null;
  /** Visible PIN boxes. */
  pinInputs: number;
  /** The PIN row is marked invalid or its error shows. */
  pinInvalid: boolean;
  /** The PIN form shows only a note (too many attempts), no boxes. */
  pinLocked: boolean;
  /** An "authenticate your identity" screen (last name, date of birth, email, or phone check). */
  identity: boolean;
  /** An already-applied or existing-submission screen. */
  alreadyApplied: boolean;
  unconfirmedSubmission: boolean;
  /** A visible progress bar or spinner. */
  loading: boolean;
};

/** A browser step of Oracle's email or PIN screen failed; the message is fixed and never carries a typed value. */
export class OracleApplyStepError extends Error {}

/** An https Oracle Cloud host (dot-bounded) serving Candidate Experience. Pure. */
export function isOracleCandidateExperienceUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === "https:" && parsed.hostname.toLowerCase().endsWith(".oraclecloud.com") && parsed.pathname.includes("/hcmUI/CandidateExperience/");
}

const MARK = "data-ia-oracle";

/**
 * Runs in the page: reads Oracle's email, terms, PIN, identity, and
 * already-applied markers below `root`, and tags the one email box
 * (`data-ia-oracle="email"`), its form's Next (`"next"`), and the PIN form's
 * Verify (`"verify"`). Self-contained: every helper is declared here.
 */
export function readOracleInspectionIn(root: Element): OracleInspection {
  const mark = "data-ia-oracle";
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  const shown = (element: Element | null): boolean => {
    if (!element || element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.visibility !== "collapse";
  };
  const enabled = (element: Element) => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true";
  const anyShown = (selector: string) => Array.from(root.querySelectorAll(selector)).some(shown);
  for (const tagged of Array.from(root.querySelectorAll(`[${mark}]`))) tagged.removeAttribute(mark);

  const inForm = (element: Element) => element.closest("form") !== null;
  let emails = Array.from(root.querySelectorAll('input[id^="primary-email"]')).filter((element) => shown(element) && inForm(element));
  if (emails.length === 0) emails = Array.from(root.querySelectorAll('input[type="email"]')).filter((element) => shown(element) && inForm(element));
  let emailNext = false;
  if (emails.length === 1) {
    const email = emails[0]!;
    email.setAttribute(mark, "email");
    const form = email.closest("form")!;
    const submits = Array.from(form.querySelectorAll('button[type="submit"]')).filter((button) => shown(button) && enabled(button));
    const next = submits.find((button) => button.closest("footer.apply-flow-pagination__buttons")) ?? submits[0];
    if (next) {
      next.setAttribute(mark, "next");
      emailNext = true;
    }
  }

  const terms = root.querySelector("#legal-disclaimer-checkbox") as HTMLInputElement | null;
  const termsLabel = root.querySelector("#legal-disclaimer-checkbox-label") as HTMLElement | null;
  const rawStatement = termsLabel ? (termsLabel.innerText || termsLabel.textContent || "") : (root.querySelector('label[for="legal-disclaimer-checkbox"]')?.textContent ?? "");
  const termsStatement = collapse(rawStatement).replace(/\s*\*+\s*$/, "").slice(0, 300);

  const method = root.querySelector("#applyFlowVerifyEmail");
  const emailMethodActive = method ? method.getAttribute("aria-pressed") === "true" : null;

  let pins = Array.from(root.querySelectorAll("input.pin-code-input__input")).filter(shown);
  if (pins.length === 0) pins = Array.from(root.querySelectorAll('.pin-code-input input[id^="pin-code-"]')).filter(shown);
  const pinInvalid = anyShown(".input-row--pin-code.input-row--invalid") || anyShown("#pin-code-error") || pins.some((pin) => pin.getAttribute("aria-invalid") === "true");
  const pinLocked = pins.length === 0 && Array.from(root.querySelectorAll("form.pin-code-verification")).some((form) => shown(form) && Array.from(form.querySelectorAll('p[role="note"]')).some(shown));
  if (pins.length > 0) {
    const form = pins[0]!.closest("form");
    const verify = form
      ? Array.from(form.querySelectorAll('button[type="submit"]')).find((button) => shown(button) && enabled(button) && !button.classList.contains("pin-code-form__action-button"))
      : undefined;
    const inline = Array.from(root.querySelectorAll(".inline-pin-code-form__submit")).find((button) => shown(button) && enabled(button));
    const chosen = verify ?? inline;
    if (chosen) chosen.setAttribute(mark, "verify");
  }

  const identity = anyShown(".apply-flow-last-name-check, .apply-flow-date-of-birth-check, .apply-flow-email-check, .apply-flow-phone-check");
  const unconfirmedSubmission = anyShown(".apply-flow-unconfirmed-submission");
  const alreadyApplied = unconfirmedSubmission || anyShown(".apply-flow-already-applied, .apply-flow-confirmed-submission");
  const loading = anyShown("indeterminate-progress-bar, oj-progress-bar, oj-progress-circle, .apply-flow-pagination__spinner, .spinner, .loading-spinner");
  return {
    emailInputs: emails.length,
    emailNext,
    termsPresent: terms !== null,
    termsChecked: terms?.checked === true,
    termsStatement,
    emailMethodActive,
    pinInputs: pins.length,
    pinInvalid,
    pinLocked,
    identity,
    alreadyApplied,
    unconfirmedSubmission,
    loading
  };
}

/** Which Oracle screen the page shows, from its address, its inspection, and a visible CAPTCHA. Pure. */
export function oracleApplyScreenOf(url: string, inspection: OracleInspection, captcha: boolean): OracleApplyScreen {
  let path = "";
  try { path = new URL(url).pathname; } catch { /* unreadable */ }
  if (captcha) return "captcha";
  if (inspection.identity) return "identity";
  if (inspection.alreadyApplied || /\/apply\/submission-exists\/?$/.test(path)) return "already-applied";
  if (inspection.pinInputs > 0 || inspection.pinLocked) return "pin";
  if (/\/apply\/section\/\d+(?:\/|$)/.test(path)) return "form";
  if (/\/apply\/email(?:\/|$)/.test(path) && inspection.emailInputs >= 1) return "email";
  if (inspection.loading) return "loading";
  return "other";
}

export type OracleEmailResult =
  | { result: "next"; screen: OracleApplyScreen; clickedAt: Date; accepted: string | null }
  | { result: "terms-declined"; statement: string }
  | { result: "captcha" }
  /** Not on the email screen, not exactly one email box, or no Next. Nothing was typed. */
  | { result: "unexpected" }
  | { result: "stuck"; detail: string; accepted: string | null };

export type OraclePinResult = { result: "next"; screen: OracleApplyScreen } | { result: "wrong-code" } | { result: "not-entered" } | { result: "stuck" };

export type OracleApplySteps = {
  screen(): Promise<OracleApplyScreen>;
  /**
   * Types the email into Oracle's email step, ticks its terms box only when
   * `accept(statement)` says so (asked before anything is typed), and clicks
   * Next once.
   */
  submitEmail(email: string, accept: (statement: string) => boolean, wait?: OracleWaitOptions): Promise<OracleEmailResult>;
  /** Types the code into the PIN boxes and clicks Verify once; never Resend. */
  enterCode(code: string, wait?: OracleWaitOptions): Promise<OraclePinResult>;
};

const EMPTY: OracleInspection = {
  emailInputs: 0, emailNext: false, termsPresent: false, termsChecked: false, termsStatement: "", emailMethodActive: null,
  pinInputs: 0, pinInvalid: false, pinLocked: false, identity: false, alreadyApplied: false, unconfirmedSubmission: false, loading: true
};

async function read(page: Page): Promise<{ screen: OracleApplyScreen; inspection: OracleInspection }> {
  try {
    await ensureNameShim(page);
    const captcha = (await page.evaluate(findVisibleChallengeIn)) !== null;
    const inspection = await page.locator("body").evaluate(readOracleInspectionIn);
    return { screen: oracleApplyScreenOf(page.url(), inspection, captcha), inspection };
  } catch {
    // A navigation in progress.
    return { screen: "loading", inspection: EMPTY };
  }
}

/** The visible validation or alert text inside the email box's form, collapsed. Runs in the page. */
function readEmailFormErrorIn(root: Element): string {
  const email = root.querySelector('[data-ia-oracle="email"]') ?? root.querySelector('input[id^="primary-email"], input[type="email"]');
  const scope = email?.closest("form") ?? root;
  return Array.from(scope.querySelectorAll('.input-row__validation, [role="alert"]'))
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

const tagged = (page: Page, name: string) => page.locator(`[${MARK}="${name}"]`).first();

async function step<T>(failure: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new OracleApplyStepError(failure);
  }
}

function redactEmail(text: string, email: string): string {
  const trimmed = email.trim();
  if (!trimmed) return text;
  return text.replace(new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[email]");
}

export function oracleApplySteps(page: Page): OracleApplySteps {
  const screen = async () => (await read(page)).screen;

  async function settle(from: OracleApplyScreen, wait: OracleWaitOptions, early?: (inspection: OracleInspection, screen: OracleApplyScreen) => boolean): Promise<{ screen: OracleApplyScreen; early: boolean } | null> {
    const timeoutMs = wait.timeoutMs ?? 30_000;
    const pollMs = wait.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await page.waitForTimeout(pollMs).catch(() => undefined);
      const current = await read(page);
      if (current.screen !== from && current.screen !== "loading") return { screen: current.screen, early: false };
      if (early && current.screen === from && early(current.inspection, current.screen)) return { screen: current.screen, early: true };
      if (Date.now() >= deadline) return null;
    }
  }

  return {
    screen,
    async submitEmail(email, accept, wait = {}) {
      let current = await read(page);
      if (current.screen === "captcha") return { result: "captcha" };
      if (current.screen !== "email" || current.inspection.emailInputs !== 1 || !current.inspection.emailNext) return { result: "unexpected" };
      const needsTerms = current.inspection.termsPresent && !current.inspection.termsChecked;
      const statement = current.inspection.termsStatement;
      if (needsTerms && !accept(statement)) return { result: "terms-declined", statement };
      if (current.inspection.emailMethodActive === false) {
        await step("the email verification method could not be chosen", () => page.locator("#applyFlowVerifyEmail").first().click({ timeout: 10_000 }));
        current = await read(page);
        if (current.screen !== "email" || current.inspection.emailMethodActive !== true || current.inspection.emailInputs !== 1 || !current.inspection.emailNext) {
          return { result: "unexpected" };
        }
      }
      await step("the email box did not take the email", async () => {
        const box = tagged(page, "email");
        await box.fill(email, { timeout: 10_000 });
        await box.dispatchEvent("change");
        await box.dispatchEvent("blur");
        if ((await box.inputValue({ timeout: 10_000 })) !== email) throw new Error("mismatch");
      });
      let accepted: string | null = null;
      if (needsTerms) {
        await step("the terms box could not be checked", async () => {
          const button = page.locator('label[for="legal-disclaimer-checkbox"] .apply-flow-input-checkbox__button').filter({ visible: true });
          if (await button.count() > 0) await button.first().click({ timeout: 10_000 });
          else await page.locator("#legal-disclaimer-checkbox-label").first().click({ timeout: 10_000 });
          if (!(await page.locator("#legal-disclaimer-checkbox").first().isChecked({ timeout: 10_000 }))) throw new Error("unchecked");
        });
        accepted = statement;
      }
      // Re-read so the tags point at the current Next (Knockout may have redrawn the footer).
      const ready = await read(page);
      if (ready.screen !== "email" || !ready.inspection.emailNext) throw new OracleApplyStepError("the email step's Next button went away");
      const clickedAt = new Date();
      await step("the email step's Next button could not be clicked", () => tagged(page, "next").click({ timeout: 10_000 }));
      const settled = await settle("email", wait);
      if (settled) return { result: "next", screen: settled.screen, clickedAt, accepted };
      let detail = "";
      try {
        await ensureNameShim(page);
        detail = redactEmail(await page.locator("body").evaluate(readEmailFormErrorIn), email).slice(0, 200);
      } catch {
        detail = "";
      }
      return { result: "stuck", detail, accepted };
    },
    async enterCode(code, wait = {}) {
      const current = await read(page);
      if (current.screen !== "pin" || current.inspection.pinInputs === 0 || current.inspection.pinLocked) return { result: "not-entered" };
      try {
        const ids = await page.locator("body").evaluate((root) => {
          const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
          let pins = Array.from(root.querySelectorAll("input.pin-code-input__input")).filter(shown);
          if (pins.length === 0) pins = Array.from(root.querySelectorAll('.pin-code-input input[id^="pin-code-"]')).filter(shown);
          return pins.map((pin) => pin.id);
        });
        const numbered = ids.map((id) => ({ id, number: /^pin-code-(\d+)$/.exec(id)?.[1] })).filter((entry) => entry.number !== undefined);
        let boxes: string[];
        if (ids.length === 1) boxes = ids;
        else if (numbered.length === ids.length) boxes = numbered.sort((a, b) => Number(a.number) - Number(b.number)).map((entry) => entry.id);
        else return { result: "not-entered" };
        if (boxes.length > 1 && boxes.length !== code.length) return { result: "not-entered" };
        const parts = boxes.length === 1 ? [code] : [...code];
        for (const [index, id] of boxes.entries()) await page.locator(`[id="${id}"]`).first().fill(parts[index]!, { timeout: 10_000 });
        let typed = "";
        for (const id of boxes) typed += await page.locator(`[id="${id}"]`).first().inputValue({ timeout: 10_000 });
        if (typed !== code) return { result: "not-entered" };
        const again = await read(page);
        if (again.screen !== "pin" || (await page.locator(`[${MARK}="verify"]`).count()) === 0) return { result: "not-entered" };
        await tagged(page, "verify").click({ timeout: 10_000 });
      } catch {
        return { result: "not-entered" };
      }
      const settled = await settle("pin", wait, (inspection) => inspection.pinInvalid || inspection.pinLocked);
      if (!settled) return { result: "stuck" };
      if (settled.early) return { result: "wrong-code" };
      return { result: "next", screen: settled.screen };
    }
  };
}
