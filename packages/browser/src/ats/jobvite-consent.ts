import type { Page } from "playwright-core";

import { findVisibleChallengeIn } from "../challenge";
import { ensureNameShim } from "../handshake-executor";

/**
 * Jobvite's Data Consent step (residence and language, then Accept), taken
 * only under the candidate's standing data-consent setting
 * (INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT). The residence is the one option
 * naming the profile country; the policy text the step shows is returned for
 * the timeline. Nothing here stores or logs anything; a CAPTCHA, an
 * ambiguous residence, or a missing Accept control changes nothing.
 */

const US_COUNTRY = new Set(["us", "usa", "united states", "united states of america"]);
const US_OPTION = /\b(?:us|u\.s\.?|usa|u\.s\.a\.?|united states(?: of america)?)(?![a-z])/i;
const NOT_US_OPTION = /\bnon[- ]us\b|\boutside (?:the )?(?:us|u\.s\.|united states)\b/i;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The one residence option matching the profile country: any spelling of the
 * United States for a US profile (never a "Non-US" option), else the country
 * named as whole words; several matches keep the English ones. Null when no
 * country is saved or no single option matches.
 */
export function chooseResidenceOption(country: string | null | undefined, options: string[]): string | null {
  const wanted = (country ?? "").trim();
  if (!wanted) return null;
  const offered = options.map((option) => option.trim()).filter((option) => option && !/^select\b/i.test(option));
  const key = wanted.toLocaleLowerCase("en-US").replace(/\./g, "").replace(/\s+/g, " ");
  const matches = US_COUNTRY.has(key)
    ? offered.filter((option) => US_OPTION.test(option) && !NOT_US_OPTION.test(option))
    : offered.filter((option) => new RegExp(`(?:^|[^\\p{L}])${escapeRegExp(wanted)}(?:$|[^\\p{L}])`, "iu").test(option));
  const narrowed = matches.length > 1 ? matches.filter((option) => /\benglish\b/i.test(option)) : matches;
  return narrowed.length === 1 ? narrowed[0]! : null;
}

export type JobviteConsentOutcome =
  | { result: "accepted"; residence: string; policyText: string; acceptText: string }
  | { result: "no-residence"; options: string[] }
  | { result: "captcha" }
  | { result: "still-shown" }
  | { result: "other"; detail: string };

const ACCEPT_MARK = "data-ia-jobvite-accept";
const SELECT_MARK = "data-ia-jobvite-residence";

/** Tags the visible residence list (#jv-country-select, else the select labelled "Location of Residence"); false when none. */
function markResidenceIn(mark: string): boolean {
  const shown = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  for (const element of Array.from(document.querySelectorAll(`[${mark}]`))) element.removeAttribute(mark);
  const byId = document.getElementById("jv-country-select");
  if (byId instanceof HTMLSelectElement && shown(byId)) {
    byId.setAttribute(mark, "1");
    return true;
  }
  for (const select of Array.from(document.querySelectorAll("select"))) {
    const label = Array.from(select.labels ?? []).map((entry) => entry.textContent ?? "").join(" ") || select.getAttribute("aria-label") || "";
    if (shown(select) && /location of residence/i.test(label)) {
      select.setAttribute(mark, "1");
      return true;
    }
  }
  return false;
}

/** Tags the consent step's one Accept control and reads the policy text; null when there is no single Accept control. */
function markAcceptIn(marks: { select: string; accept: string }): { acceptText: string; policyText: string } | null {
  const shown = (element: Element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const select = document.querySelector(`[${marks.select}]`);
  const container = select?.closest("form") ?? document.querySelector("article.jv-page-body") ?? document.body;
  const scopes = [container, document.querySelector("article.jv-page-body")].filter((entry): entry is Element => entry !== null);
  const accepts: Element[] = [];
  for (const scope of scopes) {
    for (const control of Array.from(scope.querySelectorAll("button, a, input[type=submit]"))) {
      const text = (control instanceof HTMLInputElement ? control.value : (control as HTMLElement).innerText ?? control.textContent ?? "").replace(/\s+/g, " ").trim();
      if (shown(control) && /^\s*(?:i\s+)?(?:accept|agree)(?:\s+and\s+continue)?\s*$/i.test(text) && !accepts.includes(control)) accepts.push(control);
    }
  }
  for (const element of Array.from(document.querySelectorAll(`[${marks.accept}]`))) element.removeAttribute(marks.accept);
  if (accepts.length !== 1) return null;
  const accept = accepts[0]!;
  accept.setAttribute(marks.accept, "1");
  const clone = container.cloneNode(true) as Element;
  for (const removed of Array.from(clone.querySelectorAll("select, script, style, button, input[type=submit]"))) removed.remove();
  const policyText = (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000);
  const acceptText = (accept instanceof HTMLInputElement ? accept.value : (accept as HTMLElement).innerText ?? accept.textContent ?? "").replace(/\s+/g, " ").trim();
  return { acceptText, policyText };
}

async function bodyText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 5_000 });
  } catch {
    return "";
  }
}

/**
 * Chooses the residence `choose` picks from the offered options, then clicks
 * the step's Accept control and waits for the step to go away. Every failure
 * returns a fixed phrase, never page or Playwright text.
 */
export async function passJobviteConsent(
  page: Page,
  choose: (options: string[]) => string | null,
  options: { timeoutMs?: number } = {}
): Promise<JobviteConsentOutcome> {
  await ensureNameShim(page);
  const challenge = await page.evaluate(findVisibleChallengeIn).catch(() => null);
  if (challenge) return { result: "captcha" };
  const found = await page.evaluate(markResidenceIn, SELECT_MARK).catch(() => false);
  if (!found) return { result: "other", detail: "no residence list" };
  const select = page.locator(`[${SELECT_MARK}]`).first();
  const offered = await select.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options).filter((option) => option.value !== "").map((option) => option.text.trim()).filter(Boolean)
  ).catch(() => [] as string[]);
  const choice = choose(offered);
  if (!choice) return { result: "no-residence", options: offered };
  try {
    await select.selectOption({ label: choice }, { timeout: 10_000 });
  } catch {
    return { result: "other", detail: "the residence could not be chosen" };
  }
  let marked: { acceptText: string; policyText: string } | null = null;
  const acceptDeadline = Date.now() + 5_000;
  for (;;) {
    marked = await page.evaluate(markAcceptIn, { select: SELECT_MARK, accept: ACCEPT_MARK }).catch(() => null);
    if (marked || Date.now() >= acceptDeadline) break;
    await page.waitForTimeout(250);
  }
  if (!marked) return { result: "other", detail: "no Accept control" };
  try {
    await page.locator(`[${ACCEPT_MARK}]`).first().click({ timeout: 10_000 });
  } catch {
    return { result: "other", detail: "the Accept control could not be clicked" };
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    const text = await bodyText(page);
    if (text && !/\bdata consent\b/i.test(text)) {
      return { result: "accepted", residence: choice, policyText: marked.policyText, acceptText: marked.acceptText };
    }
    if (Date.now() >= deadline) return { result: "still-shown" };
    await page.waitForTimeout(250);
  }
}
