import type { Frame, Locator, Page, Request, Response } from "playwright-core";

import { findVisibleChallengeIn } from "../challenge";
import { ensureNameShim } from "../handshake-executor";

/**
 * Workday's candidate-account screens: sign in, create account, the sign-in
 * method choice, and what follows a submit (an error, an email-verification
 * notice, a CAPTCHA, or the application). Markers are Workday's own
 * `data-automation-id` attributes. Only the named controls are ever typed in
 * or checked: Workday's robot honeypot (`beecatcher`) is never touched. This
 * module stores nothing and logs nothing; credentials pass through only.
 * Account submits are clicked no sooner than one second after the form
 * appears (the candidate's choice, 2026-11-24), so Workday's minimum-time
 * check passes.
 */
export type WorkdayCredentials = { email: string; password: string };

export type WorkdayAccountScreen =
  | "application" | "job" | "sign-in" | "create-account" | "method" | "captcha" | "verify-email" | "other-method" | "other";

export type WorkdayAccountResult =
  | "signed-in" | "created" | "no-account" | "exists" | "wrong-password" | "password-refused" | "verify-email" | "captcha" | "locked"
  | "no-answer" | "error" | "other";

/**
 * `detail` is agent-written text with optional HTTP status diagnostics,
 * never page text or a typed value.
 * `message` is Workday's own error text (collapsed, at most 300 characters),
 * set only for `"error"`; callers must redact it before showing it.
 */
export type WorkdayAccountOutcome = { result: WorkdayAccountResult; detail?: string; message?: string };

/** The clock the account step waits on; tests inject a virtual one. */
export type WorkdayWaitClock = { now(): number; sleep(ms: number): Promise<void> };

/**
 * How long to wait for Workday's answer to a submit: by default 60 seconds
 * after a create-account submit and 20 after a sign-in, checked every 500 ms.
 */
export type WorkdaySettleOptions = { timeoutMs?: number; pollMs?: number; clock?: WorkdayWaitClock };

/** A browser step of the account flow failed; the message is fixed and never carries a typed value. */
export class WorkdayAccountStepError extends Error {}

export const WORKDAY_ACCOUNT_PATTERNS = {
  ROBOT: /not a robot|verify (that )?you('re| are) (a )?human|complete the captcha|security check/i,
  VERIFY: /\b(account|e-?mail|address)\b[^.]{0,80}\b(verif|activat)|\b(verif|activat)\w*\b[^.]{0,80}\b(account|e-?mail|address)\b/i,
  ABOUT_PASSWORD: /\b(password|credentials|user ?name)\b/i,
  LOCKED: /\block(ed|out)\b|too many (failed )?(attempts|tries|sign-?ins|log-?ins)|temporarily (disabled|suspended)|\b(disabled|suspended)\b[^.]{0,30}\baccount|\baccount\b[^.]{0,30}\b(disabled|suspended)/i,
  WRONG: /\b(invalid|incorrect|wrong)\b[^.]{0,40}\b(user ?name|e-?mail|address|password|credentials|log-?in|sign-?in)|\b(user ?name|e-?mail|address|password|credentials)\b[^.]{0,40}\b(is|are|was)? ?(invalid|incorrect|wrong|not recogni[sz]ed)|(does not|doesn['’]t|do not|don['’]t) match/i,
  MISSING: /account (does not exist|not found)|no account (found|exists)|(could not|couldn['’]t) find an account/i,
  EXISTS: /already (exists|registered|in use|been used|have an account)|account (already )?exists|existing account/i,
  PASSWORD_RULE: /password (must|should|does not|doesn['’]t|requirements?|is too)|must (contain|include|be at least)/i,
  ELSEWHERE: /passkey|security key|single sign-on|\bsso\b|text message|\bsms\b|phone number to verify|authenticator/i,
  /**
   * An account that must be verified before it signs in ("Your account has not
   * been verified", "verify your email", "resend the verification email").
   * "Verify New Password" on the create form does not match.
   */
  VERIFY_REQUIRED: /\b(?:not (?:yet )?(?:been )?(?:verified|activated|confirmed)|unverified|verify your (?:account|e-?mail(?: address)?)|(?:verify|activate|confirm) (?:it|your account|your e-?mail(?: address)?|the account) before|resend (?:the |your |account )*(?:verification|activation))\b/i
} as const;

export const HONEYPOT_PATTERN = /enter website[.]?\s*this input is for robots only[,]?\s*do not enter if you['’]re human[.]?/i;
export const HONEYPOT = 'input[data-automation-id="beecatcher"], input[name="website"], input[id*="website" i], input[aria-label*="robots only" i]';

/**
 * A verification notice that appeared after a submit: the page text after it
 * asks to verify the account while the text before it did not. Workday may
 * draw the notice as plain text, not in an error element, and keep the form.
 */
export function newWorkdayVerifyNotice(before: string, after: string): boolean {
  const p = WORKDAY_ACCOUNT_PATTERNS;
  const beforeText = collapse(before).replace(HONEYPOT_PATTERN, " ").trim();
  const afterText = collapse(after).replace(HONEYPOT_PATTERN, " ").trim();
  const matches = (text: string) => p.VERIFY_REQUIRED.test(text) || (p.VERIFY.test(text) && !p.ABOUT_PASSWORD.test(text));
  return matches(afterText) && !matches(beforeText);
}

/** The application step Workday shows while its account screen is up ("Create Account/Sign In"). */
export const WORKDAY_ACCOUNT_STEP = /\b(?:create account|sign in)\b/i;

export function isWorkdayAccountStep(text: string): boolean {
  return WORKDAY_ACCOUNT_STEP.test(text);
}

/** Reads Workday's message after a sign-in or create submit; null when it means nothing the agent acts on. */
export function classifyWorkdayAccountMessage(after: "sign-in" | "create", text: string): WorkdayAccountResult | null {
  const p = WORKDAY_ACCOUNT_PATTERNS;
  const clean = text.replace(HONEYPOT_PATTERN, " ").trim();
  if (p.ROBOT.test(clean)) return "captcha";
  if (after === "create") {
    if (p.EXISTS.test(clean)) return "exists";
    if (p.PASSWORD_RULE.test(clean)) return "password-refused";
    if (p.VERIFY_REQUIRED.test(clean)) return "verify-email";
    if (p.VERIFY.test(clean) && !p.ABOUT_PASSWORD.test(clean)) return "verify-email";
    return null;
  }
  if (p.LOCKED.test(clean)) return "locked";
  // Before the password checks: a not-verified message that also mentions the password is a verify outcome.
  if (p.VERIFY_REQUIRED.test(clean)) return "verify-email";
  if (p.VERIFY.test(clean) && !p.ABOUT_PASSWORD.test(clean)) return "verify-email";
  if (p.MISSING.test(clean)) return "no-account";
  if (p.WRONG.test(clean) || p.ABOUT_PASSWORD.test(clean)) return "wrong-password";
  return null;
}

// Workday wraps every create-account button in `noCaptchaWrapper`, with or
// without a challenge (seen on employer-a.wd115 and employer-b.wd3), and pages may carry
// the invisible reCAPTCHA badge (an iframe titled "reCAPTCHA"): neither is a
// challenge. A CAPTCHA is what challenge.ts reads as one the candidate would
// see, a visible hCaptcha or Turnstile frame, or Workday's robot text.
const OTHER_CAPTCHA = 'iframe[src*="hcaptcha"], iframe[src*="turnstile"]';
const CODE_FIELD = 'input[data-automation-id="verificationCode"], input[autocomplete="one-time-code"]';
const PASSWORD = 'input[type="password"]';
const EMAIL = 'input[data-automation-id="email"]';
const PASSWORD_FIELD = 'input[data-automation-id="password"]';
const VERIFY_PASSWORD = 'input[data-automation-id="verifyPassword"]';
const TERMS = 'input[data-automation-id="createAccountCheckbox"]';
const SIGN_IN_SUBMIT = '[data-automation-id="signInSubmitButton"], [data-automation-id="signInContent"] [data-automation-id="click_filter"][aria-label="Sign In" i], [data-automation-id="applyFlowPage"] [data-automation-id="click_filter"][aria-label="Sign In" i], form [data-automation-id="click_filter"][aria-label="Sign In" i]';
const CREATE_SUBMIT = '[data-automation-id="createAccountSubmitButton"], [data-automation-id="signInContent"] [data-automation-id="click_filter"][aria-label="Create Account" i], [data-automation-id="applyFlowPage"] [data-automation-id="click_filter"][aria-label="Create Account" i], form [data-automation-id="click_filter"][aria-label="Create Account" i]';
/** The form's own submit button for each action (Workday hides it under its click filter). */
const OWN_SUBMIT = { "Sign In": '[data-automation-id="signInSubmitButton"]', "Create Account": '[data-automation-id="createAccountSubmitButton"]' } as const;
/** The click filters inside the nearest noCaptchaWrapper around a button: Workday's cover for that button. */
const WRAPPER_FILTER = 'xpath=ancestor::*[@data-automation-id="noCaptchaWrapper"][1]//*[@data-automation-id="click_filter"]';
/**
 * Workday's sign-in widget (candidate-experience-apply-flow 2026.47.19) silently drops an account
 * submit made under 500 ms after the form's submit button mounts. The candidate chose on 2026-11-24
 * ("yes a second") to let the agent click no sooner than this long after the form appears.
 */
const SUBMIT_DWELL_MS = 1_000;
const METHOD_EMAIL = '[data-automation-id="SignInWithEmailButton"]';
const OTHER_PROVIDERS = '[data-automation-id="GoogleSignInButton"], [data-automation-id="AppleSignInButton"], [data-automation-id="LinkedInSignInButton"]';
const SIGN_IN_LINK = '[data-automation-id="signInLink"]';
const CREATE_LINK = '[data-automation-id="createAccountLink"]';
const APPLY_FLOW = '[data-automation-id="applyFlowPage"]';
const ACTIVE_STEP = '[data-automation-id="progressBarActiveStep"]';
const ERRORS = '[data-automation-id="errorMessage"], [data-automation-id="inputAlert"], [data-automation-id="errorBanner"], [data-automation-id="errorBanner"] li, [role="alert"]';
const SCOPES = ['[data-automation-id="signInContent"]', '[role="dialog"]', APPLY_FLOW];

const visible = (page: Page, selector: string): Locator => page.locator(selector).filter({ visible: true });
const shown = async (page: Page, selector: string): Promise<boolean> => (await visible(page, selector).count().catch(() => 0)) > 0;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** challenge.ts's read-only visible-challenge check; false when the page cannot be read. */
async function visibleChallenge(page: Page): Promise<boolean> {
  try {
    await ensureNameShim(page);
    return (await page.evaluate(findVisibleChallengeIn)) !== null;
  } catch {
    return false;
  }
}

async function scopeText(page: Page): Promise<string> {
  for (const selector of SCOPES) {
    const scope = visible(page, selector).first();
    if (await scope.count().catch(() => 0)) return collapse(await scope.innerText().catch(() => "")).slice(0, 5_000);
  }
  return collapse(await page.locator("body").innerText().catch(() => "")).slice(0, 5_000);
}

/** Which account screen (or the application, or the job page) Workday is showing. */
export async function readWorkdayAccountScreen(page: Page): Promise<WorkdayAccountScreen> {
  const p = WORKDAY_ACCOUNT_PATTERNS;
  const rawText = await scopeText(page);
  const text = rawText.replace(HONEYPOT_PATTERN, " ").trim();
  const hasPassword = await shown(page, PASSWORD);
  if (await visibleChallenge(page) || await shown(page, OTHER_CAPTCHA) || p.ROBOT.test(text)) return "captcha";
  const codeField = await shown(page, CODE_FIELD);
  if (p.ELSEWHERE.test(text) && (codeField || !hasPassword)) return "other-method";
  if (await shown(page, OTHER_PROVIDERS) && !(await shown(page, EMAIL)) && !(await shown(page, METHOD_EMAIL))) return "other-method";
  if (await shown(page, METHOD_EMAIL)) return "method";
  const createSubmit = await shown(page, CREATE_SUBMIT);
  const signInSubmit = await shown(page, SIGN_IN_SUBMIT);
  if (codeField || (!hasPassword && p.VERIFY.test(text) && !createSubmit && !signInSubmit)) return "verify-email";
  if (createSubmit && hasPassword) return "create-account";
  if (signInSubmit && hasPassword) return "sign-in";
  if (hasPassword) return "other";
  if (await shown(page, APPLY_FLOW)) {
    const step = collapse(await visible(page, ACTIVE_STEP).first().innerText().catch(() => ""));
    if (!isWorkdayAccountStep(step)) return "application";
  }
  if (await shown(page, '[data-automation-id="adventureButton"]') || await shown(page, '[data-automation-id="jobPostingPage"]') || await shown(page, '[data-automation-id="utilityButtonSignOut"]')) return "job";
  return "other";
}

function onHost(page: Page, host: string): boolean {
  try { return new URL(page.url()).hostname === host; } catch { return false; }
}

async function waitForScreen(page: Page, wanted: WorkdayAccountScreen[], timeoutMs = 10_000): Promise<WorkdayAccountScreen> {
  const deadline = Date.now() + timeoutMs;
  let screen = await readWorkdayAccountScreen(page);
  while (!wanted.includes(screen) && Date.now() < deadline) {
    await page.waitForTimeout(250);
    screen = await readWorkdayAccountScreen(page);
  }
  return screen;
}

async function waitForChange(page: Page, from: WorkdayAccountScreen, timeoutMs = 10_000): Promise<WorkdayAccountScreen> {
  const deadline = Date.now() + timeoutMs;
  let screen = await readWorkdayAccountScreen(page);
  while (screen === from && Date.now() < deadline) {
    await page.waitForTimeout(250);
    screen = await readWorkdayAccountScreen(page);
  }
  return screen;
}

async function clickVisible(page: Page, selector: string, failure: string): Promise<void> {
  const target = visible(page, selector).first();
  if (!(await target.count().catch(() => 0))) throw new WorkdayAccountStepError(failure);
  await target.click({ timeout: 10_000 }).catch(() => { throw new WorkdayAccountStepError(failure); });
}

/** Types a value and checks the field holds it; failures never carry the value or Playwright's text. */
async function typeInto(field: Locator, value: string, failure: string): Promise<void> {
  try {
    await field.fill(value, { timeout: 10_000 });
    if ((await field.inputValue({ timeout: 10_000 })) !== value) throw new Error("mismatch");
  } catch {
    throw new WorkdayAccountStepError(failure);
  }
}

/**
 * Waits until SUBMIT_DWELL_MS have passed since `shownAt`, the moment the agent first saw the form
 * (its own submit button, or the click filter over it, visible), so time spent typing counts and a
 * slow page does not wait twice. Real time, even when tests inject a virtual clock for the answer wait.
 */
async function waitAfterFormShown(page: Page, shownAt: number): Promise<void> {
  const remaining = shownAt + SUBMIT_DWELL_MS - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining);
}

/**
 * Workday covers its submit buttons with a click filter and hides the real
 * button under it (aria-hidden, tabindex -2). The click goes, first hit
 * winning, to: the one visible click filter inside the noCaptchaWrapper that
 * holds the form's own submit button (its automation id), whatever the
 * filter's label, since Workday labels it by its internal view ("Sign In",
 * "Create Account", or "Submit", as on rockwellautomation.wd1's sign-in form);
 * else a filter with the button's label beside the form's own submit; else a
 * filter with the label inside the sign-in content, then inside a dialog
 * (never page-wide, since "Sign In" also names the header's utility button and
 * the "Already have an account?" link); else the visible button itself.
 */
async function press(page: Page, button: string, label: "Sign In" | "Create Account"): Promise<void> {
  const failure = `the ${label} button could not be clicked`;
  const matchingFilter = `*[@data-automation-id="click_filter"][translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")="${label.toLowerCase()}"]`;
  const adjacentFilter = `xpath=ancestor::*[position() <= 4][.//${matchingFilter}][1]//${matchingFilter}`;
  let target: Locator | null = null;
  // Workday's own cover for this form's submit: the one visible click filter in the noCaptchaWrapper
  // holding the form's submit button, whatever its label. Workday labels it by its internal auth view,
  // so a sign-in filter may read "Submit" (rockwellautomation.wd1, 2026-11-24).
  const owns = page.locator(OWN_SUBMIT[label]);
  const ownCount = Math.min(5, await owns.count().catch(() => 0));
  for (let index = 0; index < ownCount && !target; index += 1) {
    const covers = owns.nth(index).locator(WRAPPER_FILTER).filter({ visible: true });
    if ((await covers.count().catch(() => 0)) === 1) target = covers.first();
  }
  const buttons = page.locator(button);
  const count = Math.min(5, await buttons.count().catch(() => 0));
  for (let index = 0; index < count && !target; index += 1) {
    const candidate = buttons.nth(index);
    const isFilter = await candidate.getAttribute("data-automation-id").then((id) => id === "click_filter", () => false);
    if (isFilter && (await candidate.isVisible().catch(() => false))) {
      target = candidate;
      break;
    }
    const beside = candidate.locator(adjacentFilter).filter({ visible: true }).first();
    if (await beside.count().catch(() => 0)) target = beside;
  }
  for (const scope of ['[data-automation-id="signInContent"]', '[role="dialog"]', APPLY_FLOW, 'form']) {
    if (target) break;
    const scoped = page.locator(scope).locator(`[data-automation-id="click_filter"][aria-label="${label}" i]`).filter({ visible: true }).first();
    if (await scoped.count().catch(() => 0)) target = scoped;
  }
  if (!target) {
    const own = visible(page, button).first();
    if (await own.count().catch(() => 0)) target = own;
  }
  if (!target) throw new WorkdayAccountStepError(failure);
  await target.click({ timeout: 10_000 }).catch(() => { throw new WorkdayAccountStepError(failure); });
}

function screenOutcome(screen: WorkdayAccountScreen): WorkdayAccountOutcome {
  if (screen === "application" || screen === "job") return { result: "signed-in" };
  if (screen === "captcha") return { result: "captcha" };
  if (screen === "verify-email") return { result: "verify-email" };
  if (screen === "other-method") return { result: "other", detail: "a text-message, app or other sign-in method" };
  return { result: "other", detail: "a page the agent does not recognize" };
}

async function errorText(page: Page): Promise<string> {
  const texts = await visible(page, ERRORS).allInnerTexts().catch(() => [] as string[]);
  return [...new Set(texts.map(collapse).filter(Boolean))].join(" ");
}

/**
 * Waits for Workday's answer to a sign-in or create submit, checking the page
 * every `pollMs`: up to 60 seconds after a create (accounts can take that
 * long) and 20 after a sign-in, unless `options` say otherwise. `before` is
 * the account screen's text just before the submit: a verification notice
 * that was not there then is a verify-email outcome even with the form still
 * showing.
 */
async function settle(
  page: Page,
  after: "sign-in" | "create",
  host: string,
  options: WorkdaySettleOptions,
  before: string,
  onScreenChange: () => void
): Promise<WorkdayAccountOutcome> {
  const timeoutMs = options.timeoutMs ?? (after === "create" ? 60_000 : 20_000);
  const pollMs = options.pollMs ?? 500;
  const clock: WorkdayWaitClock = options.clock ?? { now: () => Date.now(), sleep: (ms) => page.waitForTimeout(ms) };
  const deadline = clock.now() + timeoutMs;
  let unknownErrors = 0;
  while (clock.now() < deadline) {
    await clock.sleep(pollMs);
    if (!onHost(page, host)) return { result: "other", detail: "the page left the Workday site" };
    const screen = await readWorkdayAccountScreen(page);
    if (screen !== (after === "create" ? "create-account" : "sign-in")) onScreenChange();
    if (screen === "captcha") return { result: "captcha" };
    if (screen === "other-method") return { result: "other", detail: "a text-message, app or other sign-in method" };
    const errors = await errorText(page);
    if (errors) {
      const classified = classifyWorkdayAccountMessage(after, errors);
      if (classified) return { result: classified };
    }
    // A verification notice drawn as plain text while the form stays up.
    if ((screen === "sign-in" || screen === "create-account") && newWorkdayVerifyNotice(before, await scopeText(page))) {
      return { result: "verify-email" };
    }
    if (screen === "verify-email") return { result: "verify-email" };
    if (screen === "application" || screen === "job") return { result: "signed-in" };
    if (after === "create" && screen === "sign-in" && !errors) return { result: "created" };
    if (errors) {
      unknownErrors += 1;
      if (unknownErrors >= 3) {
        return { result: "error", detail: "Workday showed an error the agent does not recognize", message: errors.slice(0, 300) };
      }
    } else {
      unknownErrors = 0;
    }
  }
  return {
    result: "no-answer",
    detail: `Workday did not answer the ${after === "create" ? "create-account" : "sign-in"} submit within ${Math.round(timeoutMs / 1000)} seconds`
  };
}

/** Observe only account-window traffic metadata. Even a same-host response does not establish what it answered. */
async function submitAccount(
  page: Page,
  after: "sign-in" | "create",
  host: string,
  options: WorkdaySettleOptions,
  before: string
): Promise<WorkdayAccountOutcome> {
  const requests = new WeakSet<Request>();
  const statuses = new Set<number>();
  let requestSeen = false;
  let transitionSeen = false;
  const markTransition = () => { transitionSeen = true; };
  const onRequest = (request: Request) => {
    if (!["document", "fetch", "xhr"].includes(request.resourceType())) return;
    if (URL.parse(request.url())?.hostname !== host) return;
    requests.add(request);
    requestSeen = true;
  };
  const onResponse = (response: Response) => {
    if (requests.has(response.request())) statuses.add(response.status());
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) markTransition();
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("framenavigated", onNavigation);
  try {
    if (after === "create") await press(page, CREATE_SUBMIT, "Create Account");
    else await press(page, SIGN_IN_SUBMIT, "Sign In");
    const outcome = await settle(page, after, host, options, before, markTransition);
    if (outcome.result !== "no-answer") return outcome;
    const traffic = !requestSeen ? "no same-host request observed" : statuses.size === 0
      ? "same-host request observed without a response"
      : `same-host response status: ${[...statuses].sort((a, b) => a - b).join(", ")}`;
    const transition = transitionSeen ? "page transition observed" : "no page transition observed";
    return { ...outcome, detail: `${outcome.detail}; ${traffic}; ${transition}` };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("framenavigated", onNavigation);
  }
}

/** Signs in with saved credentials. Types nothing unless the sign-in form is showing on the Workday host. */
export async function signInToWorkday(
  page: Page,
  credentials: WorkdayCredentials,
  host: string,
  options: WorkdaySettleOptions = {}
): Promise<WorkdayAccountOutcome> {
  if (!onHost(page, host)) return { result: "other", detail: "the page is not on the Workday site" };
  let screen = await readWorkdayAccountScreen(page);
  const selectedEmailMethod = screen === "method";
  if (!onHost(page, host)) return { result: "other", detail: "the page left the Workday site" };
  if (selectedEmailMethod) {
    await clickVisible(page, METHOD_EMAIL, "the sign-in method could not be chosen");
    screen = await waitForChange(page, "method");
    if (!onHost(page, host)) return { result: "other", detail: "the page left the Workday site" };
  }
  if (screen === "create-account") {
    if (!(await shown(page, SIGN_IN_LINK))) return { result: "other", detail: "the sign-in form could not be opened" };
    await clickVisible(page, SIGN_IN_LINK, "the sign-in form could not be opened");
    screen = await waitForScreen(page, ["sign-in", "method"]);
    if (!onHost(page, host)) return { result: "other", detail: "the page left the Workday site" };
    if (screen === "method" && !selectedEmailMethod) {
      await clickVisible(page, METHOD_EMAIL, "the sign-in method could not be chosen");
      screen = await waitForChange(page, "method");
      if (!onHost(page, host)) return { result: "other", detail: "the page left the Workday site" };
    }
  }
  if (screen !== "sign-in") return screenOutcome(screen);
  // The screen reader has just seen the form's submit control: Workday's minimum-time check counts from about here.
  const shownAt = Date.now();
  const email = visible(page, EMAIL).filter({ hasNot: page.locator(HONEYPOT) });
  const password = visible(page, PASSWORD);
  if ((await email.count()) !== 1 || (await password.count()) !== 1) return { result: "other", detail: "the sign-in form has unexpected fields" };
  await typeInto(email.first(), credentials.email, "the email field could not be filled");
  await typeInto(password.first(), credentials.password, "the password field could not be filled");
  await waitAfterFormShown(page, shownAt);
  const before = await scopeText(page);
  return submitAccount(page, "sign-in", host, options, before);
}

/** Creates an account with the given credentials and checks the terms box, returning its label for the timeline. */
export async function createWorkdayAccount(
  page: Page,
  credentials: WorkdayCredentials,
  host: string,
  options: WorkdaySettleOptions = {}
): Promise<{ outcome: WorkdayAccountOutcome; termsLabel: string | null }> {
  if (!onHost(page, host)) return { outcome: { result: "other", detail: "the page is not on the Workday site" }, termsLabel: null };
  let screen = await readWorkdayAccountScreen(page);
  if (screen === "method") {
    await clickVisible(page, METHOD_EMAIL, "the sign-in method could not be chosen");
    screen = await waitForChange(page, "method");
  }
  if (screen === "sign-in") {
    if (!(await shown(page, CREATE_LINK))) return { outcome: { result: "other", detail: "the create-account form could not be opened" }, termsLabel: null };
    await clickVisible(page, CREATE_LINK, "the create-account form could not be opened");
    screen = await waitForScreen(page, ["create-account"]);
  }
  if (screen !== "create-account") return { outcome: screenOutcome(screen), termsLabel: null };
  // The screen reader has just seen the form's submit control: Workday's minimum-time check counts from about here.
  const shownAt = Date.now();
  const email = visible(page, EMAIL).filter({ hasNot: page.locator(HONEYPOT) });
  const password = visible(page, PASSWORD_FIELD);
  const verify = visible(page, VERIFY_PASSWORD);
  const verifyCount = await verify.count();
  if ((await email.count()) !== 1 || (await password.count()) !== 1 || verifyCount > 1) {
    return { outcome: { result: "other", detail: "the create-account form has unexpected fields" }, termsLabel: null };
  }
  await typeInto(email.first(), credentials.email, "the email field could not be filled");
  await typeInto(password.first(), credentials.password, "the password field could not be filled");
  if (verifyCount === 1) await typeInto(verify.first(), credentials.password, "the verify-password field could not be filled");
  let termsLabel: string | null = null;
  const terms = visible(page, TERMS).first();
  if (await terms.count()) {
    const label = await terms.evaluate((element) => {
      const input = element as HTMLInputElement;
      const fromLabels = Array.from(input.labels ?? []).map((entry) => entry.textContent ?? "").join(" ");
      return fromLabels.trim() || input.getAttribute("aria-label") || input.closest("div, label, fieldset")?.textContent || "";
    }).catch(() => "");
    try {
      await terms.check({ timeout: 10_000 });
    } catch {
      try {
        await terms.check({ force: true, timeout: 10_000 });
      } catch {
        throw new WorkdayAccountStepError("the terms checkbox could not be checked");
      }
    }
    termsLabel = collapse(label).slice(0, 200) || "the terms checkbox";
  }
  await waitAfterFormShown(page, shownAt);
  const before = await scopeText(page);
  return { outcome: await submitAccount(page, "create", host, options, before), termsLabel };
}
