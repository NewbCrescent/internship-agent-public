import type { Page } from "playwright-core";

import {
  affirmativeOption,
  ATTESTATION_GROUPS,
  classifyStandingStatement,
  DATA_CONSENT_GROUPS,
  standingStatementDecision,
  textMessageTopic,
  type StandingBasisSetting,
  type StandingConsentSettings,
  type StandingGroup
} from "@internship-agent/domain";

/**
 * A consent dialog over the application form (Track 40, 2026-11-25: after the
 * resume upload, Eightfold's Lockheed Martin site opens a `role="dialog"
 * aria-modal="true"` "Privacy Notice and Security Agreement" with Close,
 * Cancel, and "I Agree" that takes every click until it is agreed to). The
 * dialog's full text is read from the DOM (closed `<details>` bodies
 * included, buttons skipped) and decided with the standing-consent classifier
 * (packages/domain standing-consent.ts), never a looser one: only one dialog,
 * no form field or frame, nothing clipped, no sign-in, session, CAPTCHA, or
 * cookie wording, no fact, marketing, or text-message wording anywhere in it,
 * exactly one agree button beside Cancel or Close, and every operative
 * statement accepted under the candidate's standing settings. Only that agree
 * button is ever clicked; Close and Cancel never. Every other dialog is left
 * to the candidate, as Track 37 and Track 39 do.
 */

/** The longest dialog text the agent decides on; a longer one counts as clipped. */
export const STANDING_DIALOG_TEXT_LIMIT = 6_000;

/** A visible modal dialog, tagged `data-ia-standing-dialog="<index>"`, its buttons tagged `data-ia-standing="<index>-<n>"`. */
export type StandingDialogCandidate = {
  index: number;
  /** aria-label, else the aria-labelledby text; collapsed, ≤300 chars. */
  label: string;
  /** Full text: one line per block element, buttons/inputs/scripts/styles/templates/svg/iframes skipped, closed <details> bodies included; ≤ STANDING_DIALOG_TEXT_LIMIT. */
  text: string;
  /** True when the full text was longer than the limit (then treated as clipped). */
  overLimit: boolean;
  formControls: number;
  frames: number;
  /** "Read/Show/See/View more|all|full…" or "Expand" controls, [aria-expanded="false"] controls whose aria-controls target is missing or empty, closed <details> with an empty body. */
  expanders: number;
  buttons: Array<{ tag: string; text: string; ariaLabel: string; title: string; disabled: boolean }>;
};

export type StandingDialogLeaveReason =
  | "several-dialogs"
  | "form-field"
  | "frame"
  | "clipped"
  | "safeguard"
  | "cookies"
  | "fact"
  | "marketing"
  | "text-messages"
  | "buttons"
  | "no-statement"
  | "not-covered"
  | "needs-setting";

/** Why a dialog was left to the candidate, in the candidate's words (the timeline's "Left …" event). */
export const STANDING_DIALOG_LEAVE_TEXT: Record<StandingDialogLeaveReason, string> = {
  "several-dialogs": "more than one dialog is open",
  "form-field": "it holds a form field",
  frame: "it holds a frame the agent cannot read",
  clipped: "its text is clipped or hidden behind a control",
  safeguard: "it reads like a sign-in, session, or site check",
  cookies: "it is about cookies",
  fact: "it states a fact about you",
  marketing: "it includes a marketing, newsletter, or job-alert opt-in",
  "text-messages": "it asks about text messages",
  buttons: "it does not offer exactly one agree button beside cancel or close",
  "no-statement": "it does not say what its agree button agrees to",
  "not-covered": "it holds a statement your standing settings do not cover",
  "needs-setting": "it needs a standing setting that is off"
};

export type StandingDialogChoice =
  | { verdict: "accept"; tag: string; button: string; label: string; text: string; statements: string[]; setting: StandingBasisSetting; groups: StandingGroup[] }
  | { verdict: "leave"; reason: StandingDialogLeaveReason | "settings-off" | "no-dialog" };

/** What applyDecisions hands the orchestrator after a click on a dialog's agree button. */
export type StandingDialogAcceptance = {
  label: string;
  text: string;
  statements: string[];
  button: string;
  setting: StandingBasisSetting;
  groups: StandingGroup[];
  outcome: "accepted" | "still-shown";
};

/**
 * Visible modal dialogs outside the cookie-consent containers (the same
 * selector, visibility test, and exclusion as readCoveringDialogsIn), in page
 * order, at most 5, each with its full text and its visible buttons. Tags each
 * dialog and button for clickStandingDialogButton and clicks nothing. Runs in
 * the page, so every helper is declared here.
 */
export function readStandingDialogsIn(): StandingDialogCandidate[] {
  const COOKIE_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const DIALOGS = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]';
  const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
  const FORM_CONTROLS = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea, [contenteditable="true"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="listbox"], [role="slider"], [role="spinbutton"]';
  const FRAMES = "iframe, frame, object, embed";
  const LIMIT = 6_000;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "IFRAME", "FRAME", "OBJECT", "EMBED", "SVG"]);
  const BLOCKS = new Set([
    "P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER", "SUMMARY", "DETAILS",
    "TABLE", "TR", "TD", "TH", "DT", "DD", "DL", "BLOCKQUOTE", "PRE", "FORM", "FIELDSET", "LEGEND", "LABEL", "MAIN", "NAV", "ASIDE", "HR"
  ]);
  const EXPANDER = /^(?:read|show|see|view)\s+(?:more|all|full|details|the full)\b|^(?:expand|more|\.\.\.|…)$/i;
  for (const tagged of Array.from(document.querySelectorAll("[data-ia-standing]"))) tagged.removeAttribute("data-ia-standing");
  for (const tagged of Array.from(document.querySelectorAll("[data-ia-standing-dialog]"))) tagged.removeAttribute("data-ia-standing-dialog");
  const shown = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const collapse = (text: string | null | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const named = (ids: string | null): string => (ids ?? "").split(/\s+/).filter(Boolean)
    .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText ?? "")
    .join(" ");
  const walk = (node: Node, parts: string[]): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.textContent ?? "");
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName.toUpperCase();
      if (SKIP.has(tag) || element.getAttribute("role") === "button") continue;
      if (tag === "BR") {
        parts.push("\n");
        continue;
      }
      const block = BLOCKS.has(tag);
      if (block) parts.push("\n");
      walk(element, parts);
      if (block) parts.push("\n");
    }
  };
  const found: StandingDialogCandidate[] = [];
  for (const dialog of Array.from(document.querySelectorAll(DIALOGS))) {
    if (found.length >= 5) break;
    if (!shown(dialog) || dialog.closest(COOKIE_ROOTS)) continue;
    const index = found.length;
    dialog.setAttribute("data-ia-standing-dialog", String(index));
    const parts: string[] = [];
    walk(dialog, parts);
    const full = parts.join("").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
    let expanders = 0;
    for (const control of Array.from(dialog.querySelectorAll('a, button, [role="button"], summary'))) {
      if (EXPANDER.test(collapse(control.textContent, 200))) expanders += 1;
    }
    for (const control of Array.from(dialog.querySelectorAll('[aria-expanded="false"]'))) {
      const ids = (control.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean);
      const targets = ids.map((id) => document.getElementById(id)).filter((target): target is HTMLElement => target !== null);
      if (targets.length === 0 || targets.every((target) => collapse(target.textContent, 10) === "")) expanders += 1;
    }
    for (const details of Array.from(dialog.querySelectorAll("details"))) {
      if ((details as HTMLDetailsElement).open) continue;
      // The body is everything in the details element but its own summary.
      const body = Array.from(details.childNodes)
        .filter((child) => !(child instanceof Element && child.tagName.toUpperCase() === "SUMMARY"))
        .map((child) => child.textContent ?? "")
        .join(" ");
      if (collapse(body, 10) === "") expanders += 1;
    }
    const buttons: StandingDialogCandidate["buttons"] = [];
    for (const control of Array.from(dialog.querySelectorAll(BUTTONS))) {
      if (buttons.length >= 20) break;
      if (!shown(control)) continue;
      const tag = `${index}-${buttons.length}`;
      control.setAttribute("data-ia-standing", tag);
      const input = control instanceof HTMLInputElement ? control : null;
      buttons.push({
        tag,
        text: collapse(input ? input.value : (control as HTMLElement).innerText, 120),
        ariaLabel: collapse(control.getAttribute("aria-label"), 120),
        title: collapse(control.getAttribute("title"), 120),
        disabled: (control as HTMLButtonElement).disabled === true || control.getAttribute("aria-disabled") === "true"
      });
    }
    found.push({
      index,
      label: collapse(dialog.getAttribute("aria-label") || named(dialog.getAttribute("aria-labelledby")), 300),
      text: full.slice(0, LIMIT),
      overLimit: full.length > LIMIT,
      formControls: dialog.querySelectorAll(FORM_CONTROLS).length,
      frames: dialog.querySelectorAll(FRAMES).length,
      expanders,
      buttons
    });
  }
  return found;
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

const DIALOG_SAFEGUARD = /\b(?:captcha|recaptcha|hcaptcha|turnstile|robot|bot (?:check|detection)|security check|are you (?:a )?human|verify (?:that )?you(?:'re| are) (?:a )?human|sign[- ]?in|log[- ]?in|password|session (?:has )?(?:expired|timed out|timeout))\b/i;
const COOKIES = /\bcookies?\b|\btracking technolog\w*/i;
const DIALOG_AFFIRMATIVE = /^(?:i\s+)?(?:agree|accept|acknowledge|consent)(?:\s+(?:and|&)\s+(?:continue|proceed))?[.!]?$/i;
const DIALOG_OTHER = /^(?:cancel|close|×|✕|x|decline|i decline|no|no,? thanks|i do not agree|i don'?t agree|disagree|back|go back)$/i;
const SEGMENT_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"“'(])/;
const OPERATIVE: RegExp[] = [
  /\bby (?:clicking|selecting|pressing|tapping|choosing|checking|continuing|proceeding|submitting|using)\b/i,
  /\b(?:click|select|press|tap|choose)\b[^.]{0,60}\b(?:to|you) (?:agree|accept|consent|acknowledge|confirm|certify)\b/i,
  /\b(?:i|you)\b(?:\s+(?:hereby|also|further|fully|expressly|have|do))*\s+(?:agree|accept|consent|acknowledge|certify|attest|authori[sz]e|confirm|understand|declare|represent|affirm|waive|release|read)\b/i,
  /\bagree(?:s|d)? (?:to|that|with)\b/i,
  /\bconsent(?:s|ed)? to\b/i
];
const NOTICE_ACK = /\backnowledg\w*\b[^.]{0,80}\b(?:read|notice|understand\w*)\b|\bhave read\b|\bread and understand\b/i;

/**
 * Whether the candidate's standing settings let the agent click a covering
 * dialog's one agree button, and which statements that click accepts. Pure
 * and deterministic; every rule leaves the dialog in doubt.
 */
export function standingDialogDecision(candidates: StandingDialogCandidate[], settings: StandingConsentSettings): StandingDialogChoice {
  if (!settings.acceptDataConsent && !settings.signAttestations) return { verdict: "leave", reason: "settings-off" };
  if (candidates.length === 0) return { verdict: "leave", reason: "no-dialog" };
  if (candidates.length > 1) return { verdict: "leave", reason: "several-dialogs" };
  const dialog = candidates[0]!;
  if (dialog.formControls > 0) return { verdict: "leave", reason: "form-field" };
  if (dialog.frames > 0) return { verdict: "leave", reason: "frame" };
  if (dialog.overLimit || dialog.expanders > 0) return { verdict: "leave", reason: "clipped" };
  const lines = dialog.text.split("\n").map(collapse).filter(Boolean);
  if (lines.length === 0) return { verdict: "leave", reason: "no-statement" };
  const whole = collapse(`${dialog.label} ${lines.join(" ")}`);
  if (lines.some((line) => line.endsWith("…") || line.endsWith("..."))) return { verdict: "leave", reason: "clipped" };
  // An empty section heading: its content is not in the DOM.
  const emptyHeading = lines.some((line, index) => line.endsWith(":") && (index === lines.length - 1 || lines[index + 1]!.endsWith(":")));
  if (emptyHeading) return { verdict: "leave", reason: "clipped" };
  if (DIALOG_SAFEGUARD.test(whole)) return { verdict: "leave", reason: "safeguard" };
  if (COOKIES.test(whole)) return { verdict: "leave", reason: "cookies" };
  const classified = classifyStandingStatement(whole);
  if (classified.truncated) return { verdict: "leave", reason: "clipped" };
  if (classified.fact) return { verdict: "leave", reason: "fact" };
  if (classified.marketing) return { verdict: "leave", reason: "marketing" };
  if (textMessageTopic(whole) !== null) return { verdict: "leave", reason: "text-messages" };

  const nameOf = (button: StandingDialogCandidate["buttons"][number]) => collapse(button.text || button.ariaLabel || button.title);
  if (dialog.buttons.some((button) => button.disabled && DIALOG_AFFIRMATIVE.test(nameOf(button)))) return { verdict: "leave", reason: "buttons" };
  const enabled = dialog.buttons.filter((button) => !button.disabled);
  const chosenName = affirmativeOption(enabled.map(nameOf));
  if (chosenName === null || !DIALOG_AFFIRMATIVE.test(chosenName)) return { verdict: "leave", reason: "buttons" };
  const chosen = enabled.filter((button) => nameOf(button) === chosenName);
  if (chosen.length !== 1) return { verdict: "leave", reason: "buttons" };
  if (enabled.some((button) => button !== chosen[0] && !DIALOG_OTHER.test(nameOf(button)))) return { verdict: "leave", reason: "buttons" };

  const segments = lines.flatMap((line) => line.split(SEGMENT_SPLIT)).map(collapse).filter(Boolean);
  const operative = segments.filter((segment) => OPERATIVE.some((pattern) => pattern.test(segment)));
  if (operative.length === 0) return { verdict: "leave", reason: "no-statement" };
  const groups: StandingGroup[] = [];
  const add = (group: StandingGroup) => {
    if (!groups.includes(group)) groups.push(group);
  };
  for (const segment of operative) {
    const decision = standingStatementDecision(segment, settings);
    if (decision.verdict === "fact") return { verdict: "leave", reason: "fact" };
    if (decision.verdict === "marketing") return { verdict: "leave", reason: "marketing" };
    if (decision.verdict === "needs-setting") return { verdict: "leave", reason: "needs-setting" };
    if (decision.verdict === "none") return { verdict: "leave", reason: "not-covered" };
    for (const group of decision.groups) add(group);
  }
  // A privacy-notice acknowledgment is an attestation: the dialog then needs the attestation setting too.
  if (operative.some((segment) => NOTICE_ACK.test(segment))) add("acknowledgment");
  const needsData = groups.some((group) => DATA_CONSENT_GROUPS.has(group));
  const needsAttestation = groups.some((group) => ATTESTATION_GROUPS.has(group));
  if ((needsData && !settings.acceptDataConsent) || (needsAttestation && !settings.signAttestations)) return { verdict: "leave", reason: "needs-setting" };
  const setting: StandingBasisSetting = needsData && needsAttestation ? "both" : needsData ? "accept_data_consent" : "sign_attestations";
  return {
    verdict: "accept",
    tag: chosen[0]!.tag,
    button: chosenName,
    label: dialog.label,
    text: lines.join(" "),
    statements: operative,
    setting,
    groups
  };
}

/**
 * Clicks the dialog button readStandingDialogsIn tagged, after checking that
 * it still carries `name`, with a trusted click, then waits up to 3 s for its
 * dialog to hide. "failed" when the tag is malformed, the button is gone or
 * renamed, or the click failed. Never throws.
 */
export async function clickStandingDialogButton(page: Page, tag: string, name: string): Promise<"hidden" | "still-shown" | "failed"> {
  try {
    if (!/^\d+-\d+$/.test(tag)) return "failed";
    const button = page.locator(`[data-ia-standing="${tag}"]`);
    if ((await button.count()) !== 1) return "failed";
    const shownName = await button.evaluate((element) => {
      const text = element instanceof HTMLInputElement ? element.value : (element as HTMLElement).innerText;
      return (text || element.getAttribute("aria-label") || element.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    });
    if (shownName !== name) return "failed";
    await button.click({ timeout: 3_000 });
    const index = tag.split("-")[0]!;
    return await page.locator(`[data-ia-standing-dialog="${index}"]`).waitFor({ state: "hidden", timeout: 3_000 }).then(() => "hidden" as const, () => "still-shown" as const);
  } catch {
    return "failed";
  }
}
