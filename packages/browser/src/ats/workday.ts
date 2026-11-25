import type { Locator, Page } from "playwright-core";

import type { ApplicationHistory, BrowserField, FillDecision, PauseRecord, RecognizedForm } from "@internship-agent/domain";

import { recognizeForm, waitForStableControls, type RawControl } from "../form-recognition";
import { applyDecisions, createPlaywrightPage, ensureNameShim, unfilledPause, type BrowserPage, type UnfilledField } from "../handshake-executor";
import { capturePostSubmitEvidence, type InvalidField, type PostSubmitEvidence } from "../submission-outcome";
import { classifyFieldRole, hasTranscriptField, isSensitiveRole } from "./field-roles";
import { isHearAboutQuestion, pickHearAboutOption } from "./hear-about";
import {
  createWorkdayAccount,
  isWorkdayAccountStep,
  readWorkdayAccountScreen,
  signInToWorkday,
  type WorkdayAccountOutcome,
  type WorkdayAccountScreen,
  type WorkdayCredentials,
  type WorkdaySettleOptions
} from "./workday-account";
import { fillWorkdayHistory, type HistoryFillResult } from "./workday-history";
import {
  closeWorkdayLists,
  openWorkdayListbox,
  pickWorkdayListboxOption,
  pickWorkdayPromptOption,
  settleWorkdayOptions,
  workdayPromptOptions
} from "./workday-lists";

/**
 * Workday career-site application flow. Markers are Workday's own
 * `data-automation-id` attributes, observed on live sites: the job page's
 * Apply (`adventureButton`), the Apply Manually choice, a multi-step
 * `applyFlowPage` with a `progressBar`, fields in `formField-*` containers,
 * and the footer's next button (Save and Continue, then Submit on Review).
 */
export type WorkdayStep = { index: number; total: number; name: string };

export type WorkdayPage = BrowserPage & {
  /** Opens the application (Apply → Apply Manually) unless it is already open. */
  enterApplication(): Promise<"flow" | "sign-in" | "missing">;
  activeStep(): Promise<WorkdayStep | null>;
  /** A sign-in or create-account form is showing instead of the application. */
  signInRequired(): Promise<boolean>;
  /**
   * Clicks the footer's next button and waits for the next step or Workday's
   * errors: `errors` are their distinct texts, `details` each error with the
   * field it sits on (absent when Workday showed no error text).
   */
  nextStep(): Promise<{ moved: boolean; errors: string[]; details?: WorkdayPageError[] }>;
  /** Workday's visible error list (inline field errors, the error banner, alerts); optional so in-memory pages can omit it. */
  workdayErrors?(): Promise<WorkdayPageError[]>;
  /** The footer button's text (Workday labels it Submit on the Review step). */
  footerAction(): Promise<string | null>;
  /** Fills this step's Work Experience and Education sections; null when it has neither. */
  fillHistory(history: ApplicationHistory, answers: Map<string, string>): Promise<HistoryFillResult | null>;
  /** Clicks Back until the named step is active; false when it cannot get there. */
  backTo(stepName: string): Promise<boolean>;
  /** Which account screen (or the application) is showing. Optional so in-memory pages can omit account steps. */
  accountScreen?(): Promise<WorkdayAccountScreen>;
  /** Signs in with saved credentials on the given Workday host; `options` change how long it waits for Workday's answer. */
  signInToAccount?(credentials: WorkdayCredentials, host: string, options?: WorkdaySettleOptions): Promise<WorkdayAccountOutcome>;
  /** Creates a candidate account on the given Workday host; returns the terms checkbox label it checked. */
  createAccount?(
    credentials: WorkdayCredentials,
    host: string,
    options?: WorkdaySettleOptions
  ): Promise<{ outcome: WorkdayAccountOutcome; termsLabel: string | null }>;
  /** Opens a link in a new tab of the same browser context (the run's profile), then closes the tab. */
  openInNewTab?(url: string): Promise<void>;
  /** Navigates this tab to a URL. */
  goto?(url: string): Promise<void>;
};

const FIELD = '[data-automation-id^="formField-"]';
const APPLY_FLOW = '[data-automation-id="applyFlowPage"]';
const NEXT = '[data-automation-id="pageFooterNextButton"]';
const ACTIVE_STEP = '[data-automation-id="progressBarActiveStep"]';
const RESUME_UPLOAD = 'input[type="file"][data-automation-id="file-upload-input-ref"]';
const BACK = '[data-automation-id="pageFooterBackButton"]';
const ACCOUNT_BUTTONS = '[data-automation-id="SignInWithEmailButton"], [data-automation-id="createAccountSubmitButton"], [data-automation-id="signInSubmitButton"]';

/**
 * Workday's own "Create Account/Sign In" step met inside the walk: the
 * account wall, never questions. A password field is never planned, filled,
 * or paused.
 */
export class WorkdayAccountWall extends Error {}

/**
 * Real Workday sites draw the apply flow (with its "Create Account/Sign In"
 * step) before the account form, so the flow alone does not mean the
 * application is open. Waits only while the active step is not attached yet;
 * a flow already on another step returns at once.
 */
async function onAccountStep(page: Page): Promise<boolean> {
  const step = page.locator(ACTIVE_STEP).first();
  await step.waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  const text = await step.innerText({ timeout: 2_000 }).catch(() => "");
  return isWorkdayAccountStep(text);
}

/** Waits for the account form Workday draws after the flow (a timeout is tolerated). */
async function waitForAccountForm(page: Page): Promise<void> {
  await Promise.race([
    page.locator('input[type="password"]').first().waitFor({ state: "visible", timeout: 15_000 }),
    page.locator(ACCOUNT_BUTTONS).first().waitFor({ state: "visible", timeout: 15_000 })
  ]).catch(() => undefined);
}

/** Reads one step's fields, in the page, from Workday's field containers. */
function collectWorkdayControlsIn(root: Element): RawControl[] {
  const controls: RawControl[] = [];
  const visible = (element: Element) => (element as HTMLElement).offsetParent !== null || element.getClientRects().length > 0;
  const textOf = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  for (const container of Array.from(root.querySelectorAll('[data-automation-id^="formField-"]'))) {
    if (!visible(container)) continue;
    // Work Experience and Education rows are filled by the history filler.
    if (container.closest("[data-ia-section]")) continue;
    const id = container.getAttribute("data-automation-id")!;
    const rawLabel = textOf(container.querySelector("label, legend")) ||
      container.querySelector("[aria-label]")?.getAttribute("aria-label")?.trim() || id;
    const required = rawLabel.endsWith("*") || container.querySelector('[aria-required="true"]') !== null;
    const label = rawLabel.replace(/\*+$/, "").trim();
    const listbox = container.querySelector('button[aria-haspopup="listbox"]');
    const radios = Array.from(container.querySelectorAll('input[type="radio"]'));
    const checkbox = container.querySelectorAll('input[type="checkbox"]');
    const file = container.querySelector('input[type="file"]');
    const textarea = container.querySelector("textarea");
    const prompt = container.querySelector('[data-automation-id="multiselectInputContainer"], [data-automation-id="selectedItemList"]');
    const dateParts = container.querySelector('[data-automation-id^="dateSection"]');
    if (listbox) {
      const shown = textOf(listbox);
      const value = /select one/i.test(shown) ? undefined : shown || undefined;
      controls.push({ tag: "select", id, label, required, value, options: [] });
    } else if (radios.length > 0) {
      const optionLabel = (radio: Element) => textOf(root.ownerDocument.querySelector(`label[for="${CSS.escape(radio.id)}"]`)) ||
        radio.getAttribute("aria-label") || radio.getAttribute("value") || "";
      const checked = radios.find((radio) => (radio as HTMLInputElement).checked);
      controls.push({ tag: "input", type: "radio", id, label, required, options: radios.map(optionLabel).filter(Boolean), value: checked ? optionLabel(checked) : undefined });
    } else if (checkbox.length === 1) {
      controls.push({ tag: "input", type: "checkbox", id, label, required, value: (checkbox[0] as HTMLInputElement).checked ? "true" : undefined });
    } else if (file) {
      controls.push({ tag: "input", type: "file", id, label, required });
    } else if (textarea) {
      controls.push({ tag: "textarea", id, label, required, value: (textarea as HTMLTextAreaElement).value || undefined });
    } else if (prompt) {
      const selected = Array.from(container.querySelectorAll('[data-automation-id="selectedItem"]')).map(textOf).filter(Boolean).join(", ");
      controls.push({ tag: "select", id, label, required, value: selected || undefined, options: [] });
    } else if (dateParts) {
      // Split month/year boxes are not typed as one value; they pause.
      controls.push({ tag: "input", type: "workday-date", id, label, required });
    } else {
      const input = container.querySelector('input:not([type="hidden"])') as HTMLInputElement | null;
      if (input) controls.push({ tag: "input", type: input.type || "text", id, label, required, value: input.value || undefined });
    }
  }
  // My Experience's resume upload sits outside a formField container.
  const upload = root.querySelector('input[type="file"][data-automation-id="file-upload-input-ref"]');
  if (upload && !controls.some((control) => control.type === "file")) {
    controls.push({ tag: "input", type: "file", id: "file-upload-input-ref", label: "Resume/CV", required: false });
  }
  return controls;
}

/**
 * One error Workday shows after Save and Continue: an inline field error
 * (`source: "field"`, with the `formField-*` container's id and label), an
 * item of the error banner, or another alert on the page.
 */
export type WorkdayPageError = { fieldId: string | null; label: string | null; text: string; source: "field" | "banner" | "page" };

/**
 * Reads Workday's visible errors, in the page: `errorMessage`, `inputAlert`,
 * banner items, and alerts, innermost matches only, with a leading "Error:"
 * marker stripped. Identical (field, text) pairs are kept once; at most 20.
 */
function collectWorkdayErrorsIn(root: ParentNode): WorkdayPageError[] {
  const selector = '[data-automation-id="errorMessage"], [data-automation-id="inputAlert"], [data-automation-id="errorBanner"] li, [role="alert"]';
  const visible = (element: Element) => (element as HTMLElement).offsetParent !== null || element.getClientRects().length > 0;
  const textOf = (element: Element | null | undefined) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
  const candidates = Array.from(root.querySelectorAll(selector)).filter(visible);
  const leaves = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
  const found: WorkdayPageError[] = [];
  const seen = new Set<string>();
  for (const node of leaves) {
    const text = textOf(node).replace(/^errors?\s*[:\-–—]\s*/i, "").trim();
    if (!text) continue;
    const container = node.closest('[data-automation-id^="formField-"]');
    let entry: WorkdayPageError;
    if (container) {
      const raw = textOf(container.querySelector("label, legend")) || container.querySelector("[aria-label]")?.getAttribute("aria-label")?.trim() || "";
      entry = { fieldId: container.getAttribute("data-automation-id"), label: raw.replace(/\*+$/, "").trim() || null, text, source: "field" };
    } else {
      entry = { fieldId: null, label: null, text, source: node.closest('[data-automation-id="errorBanner"]') ? "banner" : "page" };
    }
    const key = `${entry.fieldId ?? ""}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(entry);
    if (found.length >= 20) break;
  }
  return found;
}

/** Workday's visible error list; empty when the page cannot be read. */
export async function readWorkdayErrors(page: Page): Promise<WorkdayPageError[]> {
  try {
    await ensureNameShim(page);
    return await page.locator("html").first().evaluate(collectWorkdayErrorsIn);
  } catch {
    return [];
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one form field whose label appears in the text as a whole phrase; null for none or several. */
function fieldNamedIn(form: RecognizedForm, text: string): BrowserField | null {
  const matches = form.fields.filter((field) => {
    const label = field.label.trim();
    return label !== "" && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(label)}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);
  });
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * One pause per Workday error on a step that would not save, so the
 * candidate sees the real question: "<field label>: <Workday's error text>".
 * An error is attributed to a form field by its container's id, else (banner
 * and page errors) by the one field its text names; a banner item for a field
 * that already has an inline error, and an unattributed error repeating an
 * attributed one, are dropped. Errors on no known field pause as
 * `workday-error-<n>`. At most 10 pauses; ids are not step-prefixed.
 * The labels carry Workday's text, so their answers never go to generic
 * question memory (isWorkdayErrorPauseId).
 */
export function workdayErrorPauses(stepName: string, form: RecognizedForm, errors: WorkdayPageError[]): PauseRecord[] {
  const entries = errors.map((error) => {
    const text = error.text.trim();
    if (error.fieldId) return { error, field: form.fields.find((field) => field.id === error.fieldId) ?? null, text };
    if (error.source === "field") return { error, field: null, text };
    const field = fieldNamedIn(form, text);
    if (!field) return { error, field: null, text };
    const stripped = text.replace(new RegExp(`^\\s*${escapeRegExp(field.label.trim())}\\s*[:\\-–—]\\s*`, "i"), "").trim();
    return { error, field, text: stripped || text };
  }).filter((entry) => entry.text !== "");
  const withFieldError = new Set(entries.filter((entry) => entry.field && entry.error.source === "field").map((entry) => entry.field!.id));
  const attributed = entries.filter((entry) => entry.field && (entry.error.source === "field" || !withFieldError.has(entry.field.id)));
  const attributedTexts = attributed.map((entry) => entry.text.toLocaleLowerCase("en-US"));
  const pauses: PauseRecord[] = [];
  const paused = new Set<string>();
  let unattributed = 0;
  for (const entry of entries) {
    if (pauses.length >= 10) break;
    const { field, text } = entry;
    if (field) {
      // One pause per field: the first kept error (inline errors win over banner items).
      if (!attributed.includes(entry) || paused.has(field.id)) continue;
      paused.add(field.id);
      const label = `${field.label}: ${text}`;
      pauses.push({
        fieldId: `workday-error::${field.id}`,
        label: clip(label, 300),
        question: clip(label, 500),
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
      });
      continue;
    }
    const lower = text.toLocaleLowerCase("en-US");
    if (attributedTexts.some((known) => lower === known || lower.endsWith(known))) continue;
    unattributed += 1;
    const pageLabel = entry.error.label?.trim() || null;
    pauses.push({
      fieldId: `workday-error-${unattributed}`,
      label: clip(`${pageLabel ?? stepName}: ${text}`, 300),
      question: clip(`Workday could not save ${stepName}: ${pageLabel ? `${pageLabel}: ` : ""}${text}`, 500),
      suggestedKey: null,
      suggestedScope: null,
      safeguard: false,
      sensitive: false,
      upload: false,
      status: "open",
      answer: null,
      draft: null
    });
  }
  return pauses;
}

/**
 * What the page shows at a Workday stop (the account step, or a step Workday
 * would not save), for the run's local evidence folder: fields with Workday's
 * errors become invalid fields, other errors the alert text. Never throws.
 */
export async function captureWorkdayEvidence(
  page: WorkdayPage,
  outcome: "workday-account" | "workday-errors",
  known: { detail: string; errors?: WorkdayPageError[] }
): Promise<PostSubmitEvidence> {
  let errors = known.errors;
  if (errors === undefined) {
    try {
      errors = page.workdayErrors ? await page.workdayErrors() : [];
    } catch {
      errors = [];
    }
  }
  const named = (error: WorkdayPageError) => Boolean(error.fieldId || error.label);
  const invalidFields: InvalidField[] = errors.filter(named).map((error) => ({ ref: error.fieldId, label: error.label ?? "", error: error.text }));
  const alertText = errors.filter((error) => !named(error)).map((error) => error.text).join(" | ").slice(0, 1_000);
  return capturePostSubmitEvidence(page, outcome, { invalidFields, alertText, detail: known.detail });
}

export function createWorkdayPage(page: Page): WorkdayPage {
  const base = createPlaywrightPage(page);
  const root = () => page.locator(`${APPLY_FLOW}, body`).first();
  const container = (field: BrowserField): Locator => field.id === "file-upload-input-ref"
    ? page.locator("body")
    : page.locator(`[data-automation-id="${field.id}"]`).first();

  return {
    ...base,
    collectControls: async () => {
      await ensureNameShim(page);
      const controls = await root().evaluate(collectWorkdayControlsIn);
      // Listbox options only exist once opened; opening one saves nothing. They are
      // read from the list this button opened, after the previous list closed,
      // once they stop changing (workday-lists.ts).
      for (const control of controls) {
        if (control.tag !== "select" || !control.id) continue;
        const button = page.locator(`[data-automation-id="${control.id}"] button[aria-haspopup="listbox"]`).first();
        if (!(await button.count())) {
          // Search-and-pick prompts are opened only for "How did you hear
          // about us?"; others (country lists, phone codes) stay closed.
          if (!control.value && isHearAboutQuestion(control.label ?? "")) {
            control.options = await openPromptOptions(page, control.id);
            await closeWorkdayLists(page, true);
          }
          continue;
        }
        control.options = (await openWorkdayListbox(page, button)).slice(0, 500);
        await closeWorkdayLists(page, true);
      }
      return controls;
    },
    waitForFormReady: async () => {
      // Only visible field containers count: Workday can draw a step's fields hidden while it loads.
      await waitForStableControls(async () =>
        (await page.locator(FIELD).filter({ visible: true }).count()) + (await page.locator(RESUME_UPLOAD).count()));
    },
    fillField: async (field, value) => {
      await container(field).locator('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea').first().fill(value);
    },
    chooseOption: async (field, option) => {
      const box = container(field);
      if (await box.locator('input[type="radio"]').count()) {
        await box.getByLabel(option, { exact: true }).check();
        return;
      }
      if (!(await box.locator('button[aria-haspopup="listbox"]').count())) {
        await choosePromptOption(page, field, option);
        return;
      }
      const button = box.locator('button[aria-haspopup="listbox"]').first();
      await openWorkdayListbox(page, button);
      if (!(await pickWorkdayListboxOption(page, button, option))) {
        await closeWorkdayLists(page, true);
        // The option is never echoed: it may be a legal answer.
        throw new Error(`Workday's list for "${field.label}" did not offer the planned option.`);
      }
    },
    setChecked: async (field, checked) => {
      await container(field).locator('input[type="checkbox"]').first().setChecked(checked);
    },
    uploadFile: async (field, path) => {
      if (field.id === "file-upload-input-ref") {
        // A resume already attached (an earlier run, or the 2028 resume before a
        // transcript switched to 2029) is replaced, never kept alongside.
        const attached = page.locator('[data-automation-id="delete-file"]:visible');
        for (let guard = 0; guard < 5 && (await attached.count()) > 0; guard += 1) {
          await attached.first().click();
          await page.waitForTimeout(300);
        }
      }
      await container(field).locator('input[type="file"]').first().setInputFiles(path);
    },
    clickSubmit: async () => {
      // Only the Review step's footer button submits; it must say so.
      const button = page.locator(NEXT).first();
      if (!/^\s*submit\s*$/i.test(await button.innerText())) throw new Error("The Workday footer button is not Submit; the run is not on the Review step.");
      await button.click();
    },
    enterApplication: async () => {
      if (await page.locator(APPLY_FLOW).count()) {
        if (await onAccountStep(page)) { await waitForAccountForm(page); return "sign-in"; }
        return "flow";
      }
      const apply = page.locator('[data-automation-id="adventureButton"]').first();
      if (!(await apply.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false))) return "missing";
      await apply.click();
      const manual = page.locator('[data-automation-id="applyManually"]').first();
      const continueApplication = page.locator('[data-automation-id="continueButton"]').first();
      await Promise.race([
        manual.waitFor({ state: "visible", timeout: 15_000 }),
        page.locator(APPLY_FLOW).waitFor({ state: "visible", timeout: 15_000 }),
        continueApplication.waitFor({ state: "visible", timeout: 15_000 })
      ]).catch(() => undefined);
      if (await continueApplication.isVisible().catch(() => false)) await continueApplication.click();
      else if (await manual.isVisible().catch(() => false)) await manual.click();
      const reached = await Promise.race([
        page.locator(APPLY_FLOW).waitFor({ state: "visible", timeout: 20_000 }).then(() => "flow" as const),
        page.locator('input[type="password"]').first().waitFor({ state: "visible", timeout: 20_000 }).then(() => "sign-in" as const),
        page.locator(ACCOUNT_BUTTONS).first().waitFor({ state: "visible", timeout: 20_000 }).then(() => "sign-in" as const)
      ]).catch(() => "missing" as const);
      if (reached === "flow" && await onAccountStep(page)) { await waitForAccountForm(page); return "sign-in"; }
      return reached;
    },
    activeStep: async () => {
      const step = page.locator(ACTIVE_STEP).first();
      if (!(await step.count())) return null;
      return parseWorkdayStep(await step.innerText());
    },
    signInRequired: async () => (await page.locator('input[type="password"]:visible').count()) > 0 ||
      (await page.locator(ACCOUNT_BUTTONS).filter({ visible: true }).count()) > 0 ||
      isWorkdayAccountStep(await page.locator(ACTIVE_STEP).first().innerText({ timeout: 1_000 }).catch(() => "")),
    accountScreen: () => readWorkdayAccountScreen(page),
    signInToAccount: (credentials, host, options) => signInToWorkday(page, credentials, host, options),
    createAccount: (credentials, host, options) => createWorkdayAccount(page, credentials, host, options),
    workdayErrors: () => readWorkdayErrors(page),
    openInNewTab: async (url) => {
      const tab = await page.context().newPage();
      try {
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await tab.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      } finally {
        await tab.close();
      }
    },
    goto: async (url) => { await page.goto(url, { waitUntil: "domcontentloaded" }); },
    footerAction: async () => {
      const button = page.locator(NEXT).first();
      return (await button.count()) ? (await button.innerText()).trim() : null;
    },
    fillHistory: (history, answers) => fillWorkdayHistory(page, history, answers),
    backTo: async (stepName) => {
      for (let guard = 0; guard < 10; guard += 1) {
        const now = parseWorkdayStep(await page.locator(ACTIVE_STEP).first().innerText().catch(() => ""));
        if (now?.name === stepName) return true;
        const back = page.locator(BACK).first();
        if (!(await back.count())) return false;
        const before = now?.name;
        await back.click();
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await page.waitForTimeout(250);
          const moved = parseWorkdayStep(await page.locator(ACTIVE_STEP).first().innerText().catch(() => ""));
          if (moved && moved.name !== before) break;
        }
      }
      return false;
    },
    nextStep: async () => {
      const before = (await page.locator(ACTIVE_STEP).first().innerText().catch(() => "")).trim();
      await page.locator(NEXT).first().click();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        const now = (await page.locator(ACTIVE_STEP).first().innerText().catch(() => "")).trim();
        if (now && now !== before) return { moved: true, errors: [] };
        const details = await readWorkdayErrors(page);
        if (details.length) return { moved: false, errors: [...new Set(details.map((error) => error.text))].slice(0, 10), details };
      }
      return { moved: false, errors: ["Workday did not move to the next step within 20 seconds."] };
    }
  };
}

/**
 * Opens a prompt and returns only the options it revealed: Workday draws the
 * list a moment after the click, so it waits up to 5 s for options that were
 * not on screen before the click, outside picked items (other widgets' chips
 * stay out), and reads them once they stop changing.
 */
async function openPromptOptions(page: Page, fieldId: string): Promise<string[]> {
  await closeWorkdayLists(page);
  const before = new Set(await workdayPromptOptions(page));
  await page.locator(`[data-automation-id="${fieldId}"] input`).first().click();
  return (await settleWorkdayOptions(page, async () => (await workdayPromptOptions(page)).filter((text) => !before.has(text)))).slice(0, 500);
}

const SUB_LIST_WAIT_MS = 5_000;
const SUB_LIST_POLL_MS = 150;

/**
 * Picks an option in a search-and-pick prompt. Workday prompts can be
 * hierarchical (a category opens a sub-list, drawn a moment after the click);
 * a sub-list is answered with the same "How did you hear about us?" rule,
 * which is the only prompt opened, among the options not on screen before the
 * click, outside picked items.
 */
async function choosePromptOption(page: Page, field: BrowserField, option: string): Promise<void> {
  const selected = page.locator(`[data-automation-id="${field.id}"] [data-automation-id="selectedItem"]`);
  let choices = await openPromptOptions(page, field.id);
  let target: string | null = option;
  for (let level = 0; level < 3 && target; level += 1) {
    if (!choices.includes(target)) break;
    const before = new Set(await workdayPromptOptions(page));
    if (!(await pickWorkdayPromptOption(page, target))) break;
    // A category opens a sub-list: answer it with the same rule, among the
    // options the click revealed only, once they stop changing.
    let next: string[] = [];
    let previous: string[] = [];
    const deadline = Date.now() + SUB_LIST_WAIT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(SUB_LIST_POLL_MS);
      if ((await selected.count()) > 0) {
        await closeWorkdayLists(page, true);
        return;
      }
      next = (await workdayPromptOptions(page)).filter((text) => !before.has(text));
      if (next.length > 0 && next.join("\n") === previous.join("\n")) break;
      previous = next;
    }
    choices = next;
    target = pickHearAboutOption(choices, `${field.id}|${option}|${level}`);
  }
  await closeWorkdayLists(page, true);
  throw new Error(`"${field.label}" did not accept an option.`);
}

/** "current step 2 of 5My Experience" → { index: 2, total: 5, name: "My Experience" }. */
export function parseWorkdayStep(text: string): WorkdayStep | null {
  const match = /step\s+(\d+)\s+of\s+(\d+)\s*(.+)$/i.exec(text.replace(/\s+/g, " ").trim());
  return match ? { index: Number(match[1]), total: Number(match[2]), name: match[3]!.trim() } : null;
}

export type WorkdayStepPlan = {
  decisions: FillDecision[];
  pauses: PauseRecord[];
  safeguardHalt: boolean;
  uploadPathFor?: (decision: FillDecision) => string | null;
};

export type WorkdayWalkResult = {
  outcome: "review" | "paused" | "blocked" | "submitted";
  /** A step asked for a transcript, so the run used the alternate (2029) profile. */
  transcript: boolean;
  steps: WorkdayStep[];
  /** Every decision made, with field ids prefixed by their step name. */
  decisions: FillDecision[];
  pauses: PauseRecord[];
  errors: string[];
  confirmation: string | null;
  /** Form label of every field the walk recognized, by step-prefixed field id. */
  fieldLabels: Record<string, string>;
  /** Workday's errors on the step that would not save (outcome "blocked"); empty otherwise. */
  workdayErrors: WorkdayPageError[];
};

/**
 * Walks the application step by step: read the step, let the caller plan it,
 * fill, and Save and Continue. Stops at the first step with open questions,
 * on Workday's own validation errors, on a step from which it could read no
 * field (blocked; that step is never saved), or on Review. Only in `submit` mode, and
 * only on Review, does it click Submit; the caller must hold the candidate's
 * approval before choosing that mode.
 */
export type WorkdayHistoryOptions = {
  /** Rows for the default profile (2028 graduation). */
  standard: ApplicationHistory;
  /** Rows for the alternate profile (2029 graduation), used once a step asks for a transcript. */
  transcript: ApplicationHistory | null;
  /** The candidate's answers to earlier history questions, by step-prefixed field id. */
  answers: Map<string, string>;
};

export async function walkWorkdayApplication(
  page: WorkdayPage,
  planStep: (step: WorkdayStep, form: RecognizedForm, state: { transcript: boolean }) => Promise<WorkdayStepPlan>,
  options: {
    mode: "fill" | "submit";
    maxSteps?: number;
    confirm?: (page: WorkdayPage) => Promise<string>;
    history?: WorkdayHistoryOptions;
    /** Start on the alternate profile (an earlier walk of this run already met a transcript field). */
    transcript?: boolean;
  }
): Promise<WorkdayWalkResult> {
  const result: WorkdayWalkResult = {
    outcome: "blocked", transcript: options.transcript ?? false, steps: [], decisions: [], pauses: [], errors: [], confirmation: null, fieldLabels: {},
    workdayErrors: []
  };
  const prefix = (step: WorkdayStep, id: string) => `${step.name}::${id}`;
  const unprefixed = (step: WorkdayStep, answers: Map<string, string>) =>
    new Map([...answers].filter(([id]) => id.startsWith(`${step.name}::`)).map(([id, answer]) => [id.slice(step.name.length + 2), answer]));
  let historyStep: string | null = null;
  // Going back to backfill adds steps to the walk.
  for (let visited = 0; visited < (options.maxSteps ?? 16); visited += 1) {
    const step = await page.activeStep();
    if (!step) { result.errors.push("The Workday application steps did not load."); return result; }
    result.steps.push(step);
    if (/^review$/i.test(step.name)) {
      if (options.mode === "fill") { result.outcome = "review"; return result; }
      await page.clickSubmit();
      result.confirmation = options.confirm ? await options.confirm(page) : null;
      result.outcome = "submitted";
      return result;
    }
    if (isWorkdayAccountStep(step.name)) throw new WorkdayAccountWall(`Workday showed its ${step.name} screen inside the application.`);
    await page.waitForFormReady?.();
    const controls = await page.collectControls();
    if (controls.some((control) => control.type === "password" || /\bpassword\b/i.test(control.label ?? ""))) {
      throw new WorkdayAccountWall(`Workday showed a password field on ${step.name}.`);
    }
    let form = recognizeForm(page.url(), await page.title(), controls);
    // A transcript switches the run to the alternate profile. If the history
    // was already entered on an earlier step, go back and backfill it (the
    // college end year, and the resume re-rendered with that year).
    if (!result.transcript && options.history?.transcript && hasTranscriptField(form.fields)) {
      result.transcript = true;
      if (historyStep && historyStep !== step.name) {
        if (!(await page.backTo(historyStep))) {
          result.errors.push(`${step.name} asks for a transcript, and the run could not go back to ${historyStep} to change the graduation year.`);
          return result;
        }
        // The walk re-enters every step from the history step on; their earlier records are replaced.
        const from = result.steps.map((entry) => entry.name).lastIndexOf(historyStep);
        const redone = new Set(result.steps.slice(from).map((entry) => `${entry.name}::`));
        const kept = (fieldId: string) => ![...redone].some((prefixText) => fieldId.startsWith(prefixText));
        // Deleted rows stay recorded: the second pass finds nothing left to delete.
        result.decisions = result.decisions.filter((decision) => decision.action === "remove" || kept(decision.fieldId));
        result.pauses = result.pauses.filter((pause) => kept(pause.fieldId));
        continue;
      }
    }
    const historyPauses: PauseRecord[] = [];
    if (options.history) {
      const rows = result.transcript && options.history.transcript ? options.history.transcript : options.history.standard;
      const filled = await page.fillHistory(rows, unprefixed(step, options.history.answers));
      if (filled) {
        historyStep = step.name;
        result.decisions.push(...filled.decisions.map((decision) => ({ ...decision, fieldId: prefix(step, decision.fieldId) })));
        historyPauses.push(...filled.pauses);
        form = recognizeForm(page.url(), await page.title(), await page.collectControls());
      }
    }
    // A step read with no fields (Workday may draw it before its fields can be read) is read once more and never saved past.
    if (form.fields.length === 0 && historyStep !== step.name) {
      await page.waitForFormReady?.();
      const again = await page.collectControls();
      if (again.some((control) => control.type === "password" || /\bpassword\b/i.test(control.label ?? ""))) {
        throw new WorkdayAccountWall(`Workday showed a password field on ${step.name}.`);
      }
      form = recognizeForm(page.url(), await page.title(), again);
      if (form.fields.length === 0) {
        result.errors.push(`${step.name}: the run could not read any field on this step, so it did not save it.`);
        return result; // outcome stays "blocked"
      }
    }
    const plan = await planStep(step, form, { transcript: result.transcript });
    for (const field of form.fields) result.fieldLabels[prefix(step, field.id)] = field.label;
    result.decisions.push(...plan.decisions.map((decision) => ({ ...decision, fieldId: prefix(step, decision.fieldId) })));
    const open = [...historyPauses, ...plan.pauses].filter((pause) => pause.status === "open");
    result.pauses.push(...[...historyPauses, ...plan.pauses].map((pause) => ({ ...pause, fieldId: prefix(step, pause.fieldId) })));
    if (plan.safeguardHalt) { result.errors.push(`A safeguard challenge appeared on ${step.name}.`); return result; }
    // A field the page would not take pauses the walk on this step; it is never saved past.
    const pauseUnfilled = (unfilled: UnfilledField[]): void => {
      for (const entry of unfilled) {
        const field = form.fields.find((candidate) => candidate.id === entry.fieldId);
        if (!field) continue;
        const held = unfilledPause(field, entry.reason);
        const id = prefix(step, entry.fieldId);
        result.decisions = result.decisions.map((decision) => (decision.fieldId === id ? { ...held.decision, fieldId: id } : decision));
        result.pauses = [...result.pauses.filter((pause) => pause.fieldId !== id), { ...held.pause, fieldId: id }];
      }
    };
    if (open.length > 0) {
      // Fill what is known so the step shows progress, but do not save it.
      pauseUnfilled((await applyDecisions(page, form, plan.decisions, plan.uploadPathFor)).unfilled);
      result.outcome = "paused";
      return result;
    }
    const { unfilled } = await applyDecisions(page, form, plan.decisions, plan.uploadPathFor);
    if (unfilled.length > 0) {
      pauseUnfilled(unfilled);
      result.outcome = "paused";
      return result;
    }
    const moved = await page.nextStep();
    if (!moved.moved) {
      result.errors.push(...moved.errors.map((error) => `${step.name}: ${error}`));
      // Each Workday error becomes its own pause, so the candidate sees the real question.
      result.workdayErrors = moved.details ?? [];
      result.pauses.push(...workdayErrorPauses(step.name, form, result.workdayErrors).map((pause) => ({ ...pause, fieldId: prefix(step, pause.fieldId) })));
      result.outcome = "blocked";
      return result;
    }
  }
  result.errors.push("The Workday application had more steps than expected.");
  return result;
}
