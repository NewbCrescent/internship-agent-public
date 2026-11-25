import type { Page } from "playwright-core";

/**
 * A site announcement shown over an application form (Track 37, 2026-11-25:
 * Eightfold's Lockheed Martin careers site opens a `role="dialog"
 * aria-modal="true"` welcome message on load that takes every trusted click
 * until it is closed). Closed only with its own close control, and only when
 * the dialog holds no form field, no frame, and no safeguard wording (sign-in,
 * verification, session, consent, terms, errors, submission). Never an
 * accept, continue, or apply control. Cookie banners are cookie-consent.ts's.
 */

/** A visible modal dialog, its close-like controls tagged `data-ia-dismiss="<index>-<n>"`. */
export type AnnouncementCandidate = {
  index: number;
  /** The dialog's innerText, spaces collapsed, at most 2,000 characters. */
  text: string;
  /** Text inputs, selects, text areas, and editable regions inside it. */
  formControls: number;
  /** Frames inside it. */
  frames: number;
  closes: Array<{ tag: string; text: string; ariaLabel: string; title: string }>;
};

/**
 * Visible modal dialogs outside the cookie-consent containers, in page order,
 * with their visible, enabled buttons. Runs in the page, so every helper is
 * declared here; the roots string is the same list as cookie-consent.ts
 * COOKIE_CONSENT_ROOTS.
 */
export function collectAnnouncementDialogsIn(): AnnouncementCandidate[] {
  const COOKIE_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const DIALOGS = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]';
  const FORM_CONTROLS = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), select, textarea, [contenteditable="true"]';
  for (const tagged of Array.from(document.querySelectorAll("[data-ia-dismiss]"))) tagged.removeAttribute("data-ia-dismiss");
  const shown = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const collapse = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const candidates: AnnouncementCandidate[] = [];
  for (const dialog of Array.from(document.querySelectorAll(DIALOGS))) {
    if (!shown(dialog) || dialog.closest(COOKIE_ROOTS)) continue;
    const index = candidates.length;
    const closes: AnnouncementCandidate["closes"] = [];
    for (const control of Array.from(dialog.querySelectorAll('button, [role="button"]'))) {
      if (!shown(control)) continue;
      if ((control as HTMLButtonElement).disabled || control.getAttribute("aria-disabled") === "true") continue;
      const tag = `${index}-${closes.length}`;
      control.setAttribute("data-ia-dismiss", tag);
      closes.push({
        tag,
        text: collapse((control as HTMLElement).innerText),
        ariaLabel: collapse(control.getAttribute("aria-label")),
        title: collapse(control.getAttribute("title"))
      });
    }
    candidates.push({
      index,
      text: collapse((dialog as HTMLElement).innerText).slice(0, 2_000),
      formControls: dialog.querySelectorAll(FORM_CONTROLS).length,
      frames: dialog.querySelectorAll("iframe").length,
      closes
    });
  }
  return candidates;
}

/**
 * Whether any visible modal dialog (the same selector, visibility, and
 * cookie-container exclusion as collectAnnouncementDialogsIn) covers the page.
 * Runs in the page.
 */
export function visibleModalDialogIn(): boolean {
  const COOKIE_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const DIALOGS = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]';
  return Array.from(document.querySelectorAll(DIALOGS)).some((dialog) => {
    if (dialog.getClientRects().length === 0 || dialog.closest(COOKIE_ROOTS)) return false;
    const style = getComputedStyle(dialog);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

/**
 * A visible modal dialog as the evidence capture reads it (Track 39): what a
 * candidate needs to tell what it is, read without clicking, focusing, or
 * tagging anything. Raw page text; the evidence writer redacts it.
 */
export type CoveringDialog = {
  /** The element's tag name, lower case ("div", "dialog"). */
  tag: string;
  /** Its `role` attribute, or null for a `dialog` element without one. */
  role: string | null;
  /** Its aria-label, else the text of the elements its aria-labelledby names; at most 300 characters. */
  label: string;
  /** The text of the elements its aria-describedby names; at most 300 characters. */
  description: string;
  /** Every `aria-*` attribute on it, values at most 300 characters; at most 20. */
  ariaAttributes: Array<{ name: string; value: string }>;
  /** Its innerText, spaces collapsed, at most 2,000 characters. */
  text: string;
  /** Its visible buttons (`button`, `[role="button"]`, button-type inputs), at most 20. */
  buttons: Array<{ text: string; ariaLabel: string; title: string; disabled: boolean }>;
};

/**
 * Visible modal dialogs outside the cookie-consent containers (the same
 * selector, visibility, and exclusion as visibleModalDialogIn), in page order,
 * at most 5. Read only: unlike collectAnnouncementDialogsIn it tags nothing.
 * Runs in the page, so every helper is declared here.
 */
export function readCoveringDialogsIn(): CoveringDialog[] {
  const COOKIE_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const DIALOGS = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"], dialog[open]';
  const BUTTONS = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]';
  const shown = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const collapse = (text: string | null | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const named = (ids: string | null): string => (ids ?? "").split(/\s+/).filter(Boolean)
    .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText ?? "")
    .join(" ");
  const found: CoveringDialog[] = [];
  for (const dialog of Array.from(document.querySelectorAll(DIALOGS))) {
    if (found.length >= 5) break;
    if (!shown(dialog) || dialog.closest(COOKIE_ROOTS)) continue;
    const ariaAttributes = Array.from(dialog.attributes)
      .filter((attribute) => attribute.name.startsWith("aria-"))
      .slice(0, 20)
      .map((attribute) => ({ name: attribute.name, value: collapse(attribute.value, 300) }));
    const buttons: CoveringDialog["buttons"] = [];
    for (const control of Array.from(dialog.querySelectorAll(BUTTONS))) {
      if (buttons.length >= 20) break;
      if (!shown(control)) continue;
      const input = control instanceof HTMLInputElement ? control : null;
      buttons.push({
        text: collapse(input ? input.value : (control as HTMLElement).innerText, 120),
        ariaLabel: collapse(control.getAttribute("aria-label"), 120),
        title: collapse(control.getAttribute("title"), 120),
        disabled: (control as HTMLButtonElement).disabled === true || control.getAttribute("aria-disabled") === "true"
      });
    }
    found.push({
      tag: dialog.tagName.toLowerCase().slice(0, 20),
      role: dialog.getAttribute("role") === null ? null : collapse(dialog.getAttribute("role"), 40),
      label: collapse(dialog.getAttribute("aria-label") || named(dialog.getAttribute("aria-labelledby")), 300),
      description: collapse(named(dialog.getAttribute("aria-describedby")), 300),
      ariaAttributes,
      text: collapse((dialog as HTMLElement).innerText, 2_000),
      buttons
    });
  }
  return found;
}

/** Wording that makes a dialog more than an announcement: it is never closed by the agent. */
const SAFEGUARD_WORDING = /\b(?:sign\s?in|log\s?in|password|captcha|robot|human|verif\w*|security check|cookies?|consent|session|expired?|error|terms|privacy|submit\w*|application)\b/i;
const CLOSE_WORDING = /^(?:close|dismiss)\b/;
const CLOSE_MARKS: ReadonlySet<string> = new Set(["×", "✕", "x"]);

/**
 * The tag of the close control to click, or null: the first close control
 * ("Close…", "Dismiss…", "×", "✕", or "x" as its aria-label, title, or text)
 * of the first dialog with no form field, no frame, and no safeguard wording.
 * Pure and deterministic.
 */
export function chooseAnnouncementClose(candidates: AnnouncementCandidate[]): string | null {
  for (const candidate of [...candidates].sort((a, b) => a.index - b.index)) {
    if (candidate.formControls > 0 || candidate.frames > 0 || SAFEGUARD_WORDING.test(candidate.text)) continue;
    const close = candidate.closes.find((control) => [control.ariaLabel, control.title, control.text].some((entry) => {
      const text = entry.trim().toLocaleLowerCase("en-US");
      return Boolean(text) && (CLOSE_WORDING.test(text) || CLOSE_MARKS.has(text));
    }));
    if (close) return close.tag;
  }
  return null;
}

/** esbuild's keepNames helper stand-in (see handshake-executor.ts ensureNameShim); copied so this file imports no executor code. */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";

/**
 * Closes a site announcement dialog that chooseAnnouncementClose accepts,
 * with a trusted click on its close control, then waits up to 1 s for the
 * dialog to hide. True when the click went through; false when there is no
 * such dialog or the click failed. Never throws.
 */
export async function dismissAnnouncementDialog(page: Page): Promise<boolean> {
  try {
    await page.evaluate(NAME_SHIM).catch(() => undefined);
    const candidates = await page.evaluate(collectAnnouncementDialogsIn).catch((): AnnouncementCandidate[] => []);
    const tag = chooseAnnouncementClose(candidates);
    if (!tag) return false;
    const control = page.locator(`[data-ia-dismiss="${tag}"]`).first();
    await control.click({ timeout: 3_000 });
    // The close control sits inside its dialog: it hides (or goes away) with it.
    await control.waitFor({ state: "hidden", timeout: 1_000 }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
