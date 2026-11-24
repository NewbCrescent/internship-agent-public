import type { Frame, Locator, Page } from "playwright-core";

import { findVisibleChallengeIn } from "../challenge";
import { ensureNameShim } from "../handshake-executor";
import { classifyWorkdayAccountMessage, WORKDAY_ACCOUNT_PATTERNS, type WorkdayAccountResult } from "./workday-account";

/**
 * iCIMS's candidate-account screens, mirroring workday-account.ts: the
 * email-first step, the create-profile form, the password screen of an
 * existing account, an email-verification notice or code, a CAPTCHA, and the
 * application behind them. Only visible controls are touched, and nothing is
 * typed until the whole screen is understood. The screens are read and
 * driven in iCIMS's same-host content frame when the page draws one (career-site
 * wrappers), else in the page; a frame on another host is never driven. This
 * module stores nothing and logs nothing; credentials pass through only.
 */
export type IcimsAccountScreen = "email" | "sign-in" | "create" | "verify-email" | "code" | "captcha" | "application" | "other";

/** How long to wait for iCIMS's answer to a submit: by default 30 s after a create, 20 s otherwise, checked every 500 ms. */
export type IcimsWaitOptions = { timeoutMs?: number; pollMs?: number };

/**
 * `accepted` holds the statements of the boxes the step ticked. `message` is
 * the site's own error text (collapsed, at most 300 characters); callers
 * redact it. `detail` is a fixed agent-written phrase.
 */
export type IcimsStepResult = { accepted: string[] } & (
  | { result: "next"; screen: IcimsAccountScreen }
  | { result: "consent-needed"; statement: string }
  | { result: "error"; kind: WorkdayAccountResult | null; message: string }
  | { result: "no-answer" }
  | { result: "other"; detail: string }
);

/** A browser step of the iCIMS account flow failed; the message is fixed and never carries a typed value. */
export class IcimsAccountStepError extends Error {}

export type IcimsProfileInput = { email: string; password: string; firstName: string; lastName: string; phone?: string };

const MARK = "data-ia-icims";
const OTHER_CAPTCHA = 'iframe[src*="hcaptcha"], iframe[src*="turnstile"]';
const ERRORS = '[role="alert"], .iCIMS_Error, .iCIMS_ErrorMessage, .error, .errorMessage, .field-error';
const CHECK_EMAIL = /check your (?:e-?mail|inbox)/i;

type InspectedBox = { ref: string; statement: string; required: boolean; checked: boolean };
type InspectedField = { ref: string; label: string; tag: string; type: string; required: boolean; value: string };
type Inspection = {
  email: string | null;
  passwords: string[];
  code: boolean;
  submits: string[];
  boxes: InspectedBox[];
  fields: InspectedField[];
  controls: number;
  text: string;
};

/**
 * Runs inside the page: tags the visible controls of the form holding the
 * email or password inputs (else the page) with `data-ia-icims` handles and
 * describes them. Self-contained.
 */
function inspectIcimsIn(mark: string): Inspection {
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  const shown = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  for (const element of Array.from(document.querySelectorAll(`[${mark}]`))) element.removeAttribute(mark);
  const visibleInputs = Array.from(document.querySelectorAll("input, select, textarea")).filter(shown) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
  const isPassword = (element: Element) => element instanceof HTMLInputElement && element.type === "password";
  const isEmail = (element: Element) => element instanceof HTMLInputElement && (element.type === "email" || element.name === "loginName" || element.id === "email");
  const anchor = visibleInputs.find(isPassword) ?? visibleInputs.find(isEmail) ?? null;
  const scope: Element = anchor?.closest("form") ?? document.body;
  const inScope = visibleInputs.filter((element) => scope.contains(element));
  let counter = 0;
  const tag = (element: Element, name: string) => {
    const ref = `${name}-${counter++}`;
    element.setAttribute(mark, ref);
    return ref;
  };
  const labelOf = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => collapse(
    Array.from(element.labels ?? []).map((label) => label.textContent ?? "").join(" ")
    || element.getAttribute("aria-label") || element.closest("label")?.textContent || element.getAttribute("placeholder") || element.name || ""
  );
  const marker = /\s*(?:[*∗✱＊]+|\(required\))\s*$/i;
  const requiredOf = (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, label: string) =>
    element.required || element.getAttribute("aria-required") === "true" || marker.test(label);
  const statementOf = (box: HTMLInputElement): string => {
    const own = labelOf(box).replace(marker, "");
    if (own.length >= 40 && !/^(?:i agree|i accept|yes|agree|accept)\.?$/i.test(own)) return own.slice(0, 600);
    const parts: string[] = [];
    // The text of the box's row's previous siblings (at most 3, stopping at another control).
    let row: Element = box;
    while (row.parentElement && row.parentElement !== scope) row = row.parentElement;
    let sibling = row.previousElementSibling;
    for (let taken = 0; sibling && taken < 3; sibling = sibling.previousElementSibling) {
      if (sibling.querySelector("input, select, textarea") || sibling.matches("input, select, textarea")) break;
      const text = collapse((sibling as HTMLElement).innerText ?? sibling.textContent ?? "");
      if (text) {
        parts.unshift(text);
        taken += 1;
      }
    }
    if (parts.length === 0) {
      // Else the nearest preceding paragraph with no other control between it and the box.
      let paragraph: string | null = null;
      for (const element of Array.from(scope.querySelectorAll("p, input, select, textarea"))) {
        if (element === box) break;
        if (element.tagName === "P") paragraph = collapse((element as HTMLElement).innerText ?? element.textContent ?? "");
        else paragraph = null;
      }
      if (paragraph) parts.push(paragraph);
    }
    parts.push(own);
    return collapse(parts.join(" ")).slice(0, 600);
  };
  const inspection: Inspection = { email: null, passwords: [], code: false, submits: [], boxes: [], fields: [], controls: 0, text: "" };
  for (const element of inScope) {
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : element.tagName.toLowerCase();
    if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
    inspection.controls += 1;
    if (isPassword(element)) {
      inspection.passwords.push(tag(element, "password"));
      continue;
    }
    if (element instanceof HTMLInputElement && type === "checkbox") {
      const label = labelOf(element);
      inspection.boxes.push({ ref: tag(element, "box"), statement: statementOf(element), required: requiredOf(element, label), checked: element.checked });
      continue;
    }
    const label = labelOf(element);
    const idText = `${element.getAttribute("autocomplete") ?? ""} ${element.name} ${element.id} ${label}`;
    if (element instanceof HTMLInputElement && (element.getAttribute("autocomplete") === "one-time-code" || /verification code|one[- ]time|security code/i.test(idText))) {
      inspection.code = true;
    }
    const ref = tag(element, "field");
    if (isEmail(element) && inspection.email === null) inspection.email = ref;
    inspection.fields.push({ ref, label: label.replace(marker, ""), tag: element.tagName.toLowerCase(), type, required: requiredOf(element, label), value: element.value ?? "" });
  }
  const submitText = /^(?:next|continue|submit|log ?in|sign ?in|submit profile|create (?:profile|account)|register)$/i;
  for (const control of Array.from(scope.querySelectorAll("input[type=submit], button[type=submit], button:not([type])"))) {
    if (!shown(control)) continue;
    const text = collapse(control instanceof HTMLInputElement ? control.value : (control as HTMLElement).innerText ?? control.textContent ?? "");
    if (submitText.test(text)) inspection.submits.push(tag(control, "submit"));
  }
  inspection.text = collapse(document.body?.innerText ?? "").slice(0, 5_000);
  return inspection;
}

const visible = (scope: Page | Frame, selector: string): Locator => scope.locator(selector).filter({ visible: true });
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";

const hostOf = (page: Page) => {
  try { return new URL(page.url()).hostname; } catch { return ""; }
};

const CONTENT_FRAME = "icims_content_iframe";

/** iCIMS's content frame: a direct, same-host child of the top document named icims_content_iframe or loaded with in_iframe=1. */
function contentFrameState(frame: Frame, main: Frame, pageHost: string): "yes" | "no" | "loading" {
  if (frame === main || frame.parentFrame() !== main || frame.isDetached()) return "no";
  const named = frame.name() === CONTENT_FRAME;
  let url: URL;
  try { url = new URL(frame.url()); } catch { return named ? "loading" : "no"; }
  if (url.protocol === "about:") return named ? "loading" : "no";
  if (url.hostname.toLowerCase() !== pageHost) return "no";
  return named || url.searchParams.get("in_iframe") === "1" ? "yes" : "no";
}

/**
 * The frame holding iCIMS's account screens. iCIMS career sites draw the
 * email step, sign-in, and create-profile forms inside a same-host content
 * frame (`icims_content_iframe`, `?in_iframe=1`); a page without one is read
 * itself. A frame on another host is never chosen.
 */
export async function icimsAccountFrame(page: Page): Promise<Frame> {
  const main = page.mainFrame();
  const pageHost = hostOf(page).toLowerCase();
  if (!pageHost) return main;
  const content = page.frames().find((frame) => contentFrameState(frame, main, pageHost) !== "no");
  if (!content) return main;
  await content.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  return contentFrameState(content, main, pageHost) === "yes" ? content : main;
}

async function inspect(page: Page, frame: Frame): Promise<Inspection> {
  await ensureNameShim(page);
  if (frame !== page.mainFrame()) await frame.evaluate(NAME_SHIM);
  return frame.evaluate(inspectIcimsIn, MARK);
}

const byRef = (frame: Frame, ref: string) => frame.locator(`[${MARK}="${ref}"]`).first();

async function visibleChallenge(page: Page, frame: Frame): Promise<boolean> {
  let found = false;
  try {
    await ensureNameShim(page);
    found = (await page.evaluate(findVisibleChallengeIn)) !== null;
  } catch {
    found = false;
  }
  if (found || frame === page.mainFrame()) return found;
  try {
    await frame.evaluate(NAME_SHIM);
    return (await frame.evaluate(findVisibleChallengeIn)) !== null;
  } catch {
    return false;
  }
}

function screenOf(url: string, inspection: Inspection, captcha: boolean): IcimsAccountScreen {
  if (captcha || WORKDAY_ACCOUNT_PATTERNS.ROBOT.test(inspection.text)) return "captcha";
  if (inspection.passwords.length >= 2) return "create";
  if (inspection.passwords.length === 1) return "sign-in";
  if (inspection.code) return "code";
  if (WORKDAY_ACCOUNT_PATTERNS.VERIFY.test(inspection.text) || CHECK_EMAIL.test(inspection.text)) return "verify-email";
  if (inspection.email && inspection.submits.length > 0) return "email";
  let path = "";
  try { path = new URL(url).pathname; } catch { /* unreadable */ }
  if (!/\/login\/?$/.test(path) && inspection.controls > 0) return "application";
  return "other";
}

/** Which iCIMS account screen (or the application behind it) the page shows. */
export async function readIcimsAccountScreen(page: Page): Promise<IcimsAccountScreen> {
  const frame = await icimsAccountFrame(page);
  const captcha = await visibleChallenge(page, frame)
    || (await visible(page, OTHER_CAPTCHA).count().catch(() => 0)) > 0
    || (frame !== page.mainFrame() && (await visible(frame, OTHER_CAPTCHA).count().catch(() => 0)) > 0);
  return screenOf(frame.url(), await inspect(page, frame), captcha);
}

function onHost(page: Page, host: string): boolean {
  try { return new URL(page.url()).hostname === host; } catch { return false; }
}

/** Types a value and checks the field holds it; failures never carry the value or Playwright's text. */
async function typeInto(field: Locator, value: string, failure: string): Promise<void> {
  try {
    await field.fill(value, { timeout: 10_000 });
    if ((await field.inputValue({ timeout: 10_000 })) !== value) throw new Error("mismatch");
  } catch {
    throw new IcimsAccountStepError(failure);
  }
}

async function check(frame: Frame, ref: string): Promise<void> {
  const box = byRef(frame, ref);
  try {
    await box.check({ timeout: 10_000 });
  } catch {
    try {
      await box.check({ force: true, timeout: 10_000 });
    } catch {
      throw new IcimsAccountStepError("a consent checkbox could not be checked");
    }
  }
}

async function click(frame: Frame, ref: string, failure: string): Promise<void> {
  try {
    await byRef(frame, ref).click({ timeout: 10_000 });
  } catch {
    throw new IcimsAccountStepError(failure);
  }
}

async function errorText(scope: Frame): Promise<string> {
  const texts = await visible(scope, ERRORS).allInnerTexts().catch(() => [] as string[]);
  return [...new Set(texts.map(collapse).filter(Boolean))].join(" ");
}

/** Which boxes to tick; a required box the candidate's settings do not accept stops the step before anything is typed. */
function boxPlan(boxes: InspectedBox[], accept: (statement: string) => boolean): { tick: InspectedBox[]; refused: InspectedBox | null } {
  const tick: InspectedBox[] = [];
  for (const box of boxes) {
    if (box.checked) continue;
    if (accept(box.statement)) tick.push(box);
    else if (box.required) return { tick, refused: box };
  }
  return { tick, refused: null };
}

/**
 * Waits for iCIMS's answer to a submit: a different screen, a CAPTCHA, visible
 * error text, leaving the host, or the deadline.
 */
async function settle(page: Page, after: "sign-in" | "create", from: IcimsAccountScreen, host: string, accepted: string[], wait: IcimsWaitOptions = {}): Promise<IcimsStepResult> {
  const timeoutMs = wait.timeoutMs ?? (after === "create" ? 30_000 : 20_000);
  const pollMs = wait.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    if (!onHost(page, host)) return { accepted, result: "other", detail: "the page left the iCIMS site" };
    let screen: IcimsAccountScreen;
    let errors: string;
    try {
      screen = await readIcimsAccountScreen(page);
      if (screen === "captcha") return { accepted, result: "next", screen };
      errors = await errorText(await icimsAccountFrame(page));
    } catch {
      continue; // A navigation is under way.
    }
    if (errors) return { accepted, result: "error", kind: classifyWorkdayAccountMessage(after, errors), message: errors.slice(0, 300) };
    if (screen !== from) return { accepted, result: "next", screen };
  }
  return { accepted, result: "no-answer" };
}

const FIRST_NAME = /^(?:legal )?first name$|^given name$/i;
const LAST_NAME = /^(?:legal )?last name$|^family name$|^surname$/i;
const EMAIL_LABEL = /^e-?mail(?: address)?$/i;
const LOGIN_LABEL = /^(?:login|log ?in name|user ?name|user ?id|login id)$/i;
const PHONE_LABEL = /^(?:phone|mobile|cell)(?: phone)?(?: number)?$/i;

/** Enters the email on the email-first step, ticks the boxes `accept` allows, and submits it. */
export async function submitIcimsEmail(page: Page, email: string, accept: (statement: string) => boolean, host: string, wait?: IcimsWaitOptions): Promise<IcimsStepResult> {
  if (!onHost(page, host)) return { accepted: [], result: "other", detail: "the page is not on the iCIMS site" };
  const frame = await icimsAccountFrame(page);
  const inspection = await inspect(page, frame);
  if (!inspection.email) return { accepted: [], result: "other", detail: "the email step has no email field" };
  if (inspection.submits.length !== 1) return { accepted: [], result: "other", detail: "no single submit control" };
  const { tick, refused } = boxPlan(inspection.boxes, accept);
  if (refused) return { accepted: [], result: "consent-needed", statement: refused.statement };
  await typeInto(byRef(frame, inspection.email), email, "the email field could not be filled");
  const accepted: string[] = [];
  for (const box of tick) {
    await check(frame, box.ref);
    accepted.push(box.statement);
  }
  await click(frame, inspection.submits[0]!, "the email step's submit control could not be clicked");
  return settle(page, "sign-in", "email", host, accepted, wait);
}

/**
 * Fills iCIMS's create-profile form (name, email, login, phone when given,
 * password and its confirmation), ticks the boxes `accept` allows, calls
 * `beforeSubmit`, and submits it. Any other required field stops the step
 * before anything is typed.
 */
export async function createIcimsProfile(
  page: Page,
  input: IcimsProfileInput,
  accept: (statement: string) => boolean,
  beforeSubmit: () => void,
  host: string,
  wait?: IcimsWaitOptions
): Promise<IcimsStepResult> {
  if (!onHost(page, host)) return { accepted: [], result: "other", detail: "the page is not on the iCIMS site" };
  const frame = await icimsAccountFrame(page);
  const inspection = await inspect(page, frame);
  if (inspection.passwords.length !== 2) return { accepted: [], result: "other", detail: "the create-profile form has unexpected password fields" };
  if (inspection.submits.length !== 1) return { accepted: [], result: "other", detail: "no single submit control" };
  const typed: Array<{ ref: string; value: string; failure: string }> = [];
  for (const field of inspection.fields) {
    if (FIRST_NAME.test(field.label)) typed.push({ ref: field.ref, value: input.firstName, failure: "the first-name field could not be filled" });
    else if (LAST_NAME.test(field.label)) typed.push({ ref: field.ref, value: input.lastName, failure: "the last-name field could not be filled" });
    else if (EMAIL_LABEL.test(field.label) || field.type === "email") {
      if (field.value.trim().toLocaleLowerCase("en-US") !== input.email.toLocaleLowerCase("en-US")) {
        typed.push({ ref: field.ref, value: input.email, failure: "the email field could not be filled" });
      }
    } else if (LOGIN_LABEL.test(field.label)) typed.push({ ref: field.ref, value: input.email, failure: "the login field could not be filled" });
    else if (PHONE_LABEL.test(field.label) || field.type === "tel") {
      if (input.phone) typed.push({ ref: field.ref, value: input.phone, failure: "the phone field could not be filled" });
      else if (field.required) return { accepted: [], result: "other", detail: `the create-profile form asks for "${field.label.slice(0, 80)}"` };
    } else if (field.required) {
      return { accepted: [], result: "other", detail: `the create-profile form asks for "${(field.label || "an unlabeled field").slice(0, 80)}"` };
    }
  }
  const { tick, refused } = boxPlan(inspection.boxes, accept);
  if (refused) return { accepted: [], result: "consent-needed", statement: refused.statement };
  for (const entry of typed) await typeInto(byRef(frame, entry.ref), entry.value, entry.failure);
  await typeInto(byRef(frame, inspection.passwords[0]!), input.password, "the password field could not be filled");
  await typeInto(byRef(frame, inspection.passwords[1]!), input.password, "the confirm-password field could not be filled");
  const accepted: string[] = [];
  for (const box of tick) {
    await check(frame, box.ref);
    accepted.push(box.statement);
  }
  beforeSubmit();
  await click(frame, inspection.submits[0]!, "the create-profile submit control could not be clicked");
  return settle(page, "create", "create", host, accepted, wait);
}

/** Signs in with the saved password on the password screen of an existing account. */
export async function signInToIcims(page: Page, input: { email: string; password: string }, host: string, wait?: IcimsWaitOptions): Promise<IcimsStepResult> {
  if (!onHost(page, host)) return { accepted: [], result: "other", detail: "the page is not on the iCIMS site" };
  const frame = await icimsAccountFrame(page);
  const inspection = await inspect(page, frame);
  if (inspection.passwords.length !== 1) return { accepted: [], result: "other", detail: "the sign-in form has unexpected fields" };
  if (inspection.submits.length !== 1) return { accepted: [], result: "other", detail: "no single submit control" };
  const login = inspection.fields.find((field) => field.ref === inspection.email) ?? inspection.fields.find((field) => LOGIN_LABEL.test(field.label));
  if (login && !login.value.trim()) await typeInto(byRef(frame, login.ref), input.email, "the email field could not be filled");
  await typeInto(byRef(frame, inspection.passwords[0]!), input.password, "the password field could not be filled");
  await click(frame, inspection.submits[0]!, "the sign-in submit control could not be clicked");
  return settle(page, "sign-in", "sign-in", host, [], wait);
}

export type IcimsAccountSteps = {
  screen(): Promise<IcimsAccountScreen>;
  submitEmail(email: string, accept: (statement: string) => boolean, wait?: IcimsWaitOptions): Promise<IcimsStepResult>;
  createProfile(input: IcimsProfileInput, accept: (statement: string) => boolean, beforeSubmit: () => void, wait?: IcimsWaitOptions): Promise<IcimsStepResult>;
  signIn(input: { email: string; password: string }, wait?: IcimsWaitOptions): Promise<IcimsStepResult>;
  /** Opens a link (an emailed verification link) in a new tab of the same browser context, then closes it. */
  openInNewTab(url: string): Promise<void>;
  goto(url: string): Promise<void>;
};

/** iCIMS's account steps on a Playwright page; the host is read from the page when each step runs. */
export function icimsAccountSteps(page: Page): IcimsAccountSteps {
  return {
    screen: () => readIcimsAccountScreen(page),
    submitEmail: (email, accept, wait) => submitIcimsEmail(page, email, accept, hostOf(page), wait),
    createProfile: (input, accept, beforeSubmit, wait) => createIcimsProfile(page, input, accept, beforeSubmit, hostOf(page), wait),
    signIn: (input, wait) => signInToIcims(page, input, hostOf(page), wait),
    openInNewTab: async (url) => {
      const tab = await page.context().newPage();
      try {
        await tab.goto(url, { waitUntil: "load" });
      } finally {
        await tab.close();
      }
    },
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
  };
}
