import type { Page } from "playwright-core";

/**
 * Cookie consent, rejected first. One deterministic choice shared by every
 * path that meets a cookie banner (the posting's Apply entry in
 * handshake-executor.ts and the bounded navigation in site-navigation.ts):
 * a reject control first ("Reject All", "Decline", OneTrust's
 * #onetrust-reject-all-handler), then a necessary-only control ("Necessary
 * only", or "Confirm My Choices" when every optional group is off), then a
 * close or dismiss control. Never "Accept all", "Allow all", "Got it", or a
 * settings link. A banner that offers only accept gets no click and stays as
 * it is.
 */

/**
 * Containers of cookie-consent managers (OneTrust, Cookiebot, TrustArc,
 * Usercentrics, Didomi, Cookie Consent, CookieScript, Complianz, CookieYes)
 * and cookie dialogs named as such. Cookie-specific on purpose: never a
 * generic `[id*="consent"]`, which would also match Jobvite's data-consent
 * step and an application's data-retention consent checkbox. The control
 * reader in handshake-executor.ts (collectControlsIn) and the navigation
 * entry reader in site-navigation.ts keep in-page copies of this list.
 */
export const COOKIE_CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';

/** A visible control inside a cookie-consent container, tagged `data-ia-consent="<index>"`. */
export type ConsentCandidate = {
  index: number;
  id: string;
  className: string;
  /** The control's innerText, aria-label, value, and title. */
  texts: string[];
  /** Whether every enabled checkbox of its container that is not a strictly-necessary group is unchecked. */
  optionalGroupsOff: boolean;
};

export type ConsentChoice = { index: number; kind: "reject" | "necessary" | "close"; text: string };

/**
 * The visible controls of every cookie-consent container on the page, in
 * page order. Runs in the page, so every helper is declared here; the
 * roots string is the same list as COOKIE_CONSENT_ROOTS.
 */
export function collectConsentControlsIn(): ConsentCandidate[] {
  const ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const NECESSARY_GROUP = /necessary|essential|required|strictly|C0001/i;
  for (const tagged of Array.from(document.querySelectorAll("[data-ia-consent]"))) tagged.removeAttribute("data-ia-consent");
  const shown = (element: Element): boolean => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const collapse = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  /** The outermost consent container holding the element: OneTrust's banner and preference center share #onetrust-consent-sdk. */
  const outermost = (element: Element): Element => {
    let top = element;
    for (let node: Element | null = element.parentElement; node; node = node.parentElement) {
      if (node.matches(ROOTS)) top = node;
    }
    return top;
  };
  const checkboxText = (box: HTMLInputElement): string => {
    const owner = box.id ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`) : null;
    const labelledBy = (box.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    return [box.id, box.name, box.getAttribute("aria-label") ?? "", owner?.textContent ?? "", box.closest("label")?.textContent ?? "", labelledBy].join(" ");
  };
  const groupsOff = new Map<Element, boolean>();
  const optionalOff = (root: Element): boolean => {
    const known = groupsOff.get(root);
    if (known !== undefined) return known;
    const boxes = Array.from(root.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    const off = boxes.filter((box) => !box.disabled && !NECESSARY_GROUP.test(checkboxText(box))).every((box) => !box.checked);
    groupsOff.set(root, off);
    return off;
  };
  const seen = new Set<Element>();
  const candidates: ConsentCandidate[] = [];
  for (const root of Array.from(document.querySelectorAll(ROOTS))) {
    for (const element of Array.from(root.querySelectorAll('button, a[href], [role="button"], input[type="button"], input[type="submit"]'))) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (!shown(element)) continue;
      if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
      const texts = [
        (element as HTMLElement).innerText ?? "",
        element.getAttribute("aria-label") ?? "",
        element instanceof HTMLInputElement ? element.value : "",
        element.getAttribute("title") ?? ""
      ].map(collapse).filter(Boolean);
      const index = candidates.length;
      element.setAttribute("data-ia-consent", String(index));
      candidates.push({
        index,
        id: element.id ?? "",
        className: typeof element.className === "string" ? element.className : element.getAttribute("class") ?? "",
        texts,
        optionalGroupsOff: optionalOff(outermost(element))
      });
    }
  }
  return candidates;
}

const NECESSARY = /^(?:(?:use|allow|accept)\s+)?(?:only\s+)?(?:strictly\s+)?(?:necessary|essential|required)(?:\s+cookies)?(?:\s+only)?$|^(?:only|strictly)\s+(?:necessary|essential|required)(?:\s+cookies)?$|^(?:necessary|essential|required)\s+only$/;
const REJECT = /^(?:reject|decline|deny|refuse)(?:\s+all)?(?:\s+(?:optional|non-essential|additional|unnecessary))?(?:\s+cookies)?$|^(?:i\s+)?(?:do not|don't)\s+(?:accept|agree)$|^continue without accepting$/;
const REJECT_IDS = new Set(["onetrust-reject-all-handler", "cybotcookiebotdialogbodybuttondecline"]);
const CONFIRM = /^(?:confirm my choices|save (?:my )?(?:preferences|choices|settings))$/;
const ACCEPT = /\b(?:accept|allow|agree|consent|i understand|got it|ok(?:ay)?)\b/;
const CLOSE = /^(?:close|dismiss|no thanks|×|✕|x)$/;

function normalized(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The one consent control to click, or null: the first reject control in
 * page order, else the first necessary-only control (or "Confirm My Choices"
 * with every optional group off), else the first close or dismiss control
 * that does not accept. Never an accept, allow, settings, or preferences
 * control. Pure and deterministic.
 */
export function chooseConsentControl(candidates: ConsentCandidate[]): ConsentChoice | null {
  const ordered = [...candidates].sort((a, b) => a.index - b.index);
  let necessary: ConsentChoice | null = null;
  let close: ConsentChoice | null = null;
  for (const candidate of ordered) {
    const texts = candidate.texts.map(normalized).filter(Boolean);
    const id = candidate.id.toLowerCase();
    const cls = candidate.className.toLowerCase();
    const text = candidate.texts[0] ?? candidate.id;
    if (REJECT_IDS.has(id) || cls.includes("ot-pc-refuse-all-handler") || texts.some((entry) => REJECT.test(entry))) {
      return { index: candidate.index, kind: "reject", text };
    }
    if (id === "truste-consent-required" || texts.some((entry) => NECESSARY.test(entry))) {
      necessary ??= { index: candidate.index, kind: "necessary", text };
      continue;
    }
    // Checked only after reject and necessary-only matched nothing for this control.
    const accepts = texts.some((entry) => ACCEPT.test(entry)) || /accept|allow|agree/.test(id) || /accept|allow|agree/.test(cls);
    if (accepts) continue;
    if (candidate.optionalGroupsOff && texts.some((entry) => CONFIRM.test(entry))) {
      necessary ??= { index: candidate.index, kind: "necessary", text };
      continue;
    }
    if (id === "onetrust-close-btn-handler" || /(?:^|\s)banner-close-button(?:\s|$)/.test(cls)
      || texts.some((entry) => CLOSE.test(entry) || /\bclose\b/.test(entry))) {
      close ??= { index: candidate.index, kind: "close", text };
    }
  }
  return necessary ?? close;
}

/** esbuild's keepNames helper stand-in (see handshake-executor.ts ensureNameShim); copied so this file imports no executor code. */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";

/**
 * Rejects the page's cookie banner (main frame only) with the control
 * chooseConsentControl picks, clicked with a trusted click. Returns the
 * choice when the click went through; null when there is no banner, only
 * accept is offered, or the click failed. Never throws.
 */
export async function rejectCookieConsent(page: Page): Promise<ConsentChoice | null> {
  try {
    await page.evaluate(NAME_SHIM).catch(() => undefined);
    const candidates = await page.evaluate(collectConsentControlsIn).catch((): ConsentCandidate[] => []);
    const choice = chooseConsentControl(candidates);
    if (!choice) return null;
    await page.locator(`[data-ia-consent="${choice.index}"]`).first().click({ timeout: 3_000 });
    await page.waitForTimeout(300).catch(() => undefined);
    return choice;
  } catch {
    return null;
  }
}
