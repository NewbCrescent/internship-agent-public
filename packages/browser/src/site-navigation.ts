import type { Frame, Page } from "playwright-core";

import { parseWorkdayUrl, type BrowserField, type FieldRole } from "@internship-agent/domain";

import {
  applicationWallKind, chooseApplyEntry, clickApplyEntry, embedSourcesOf, greenhouseEmbedTarget, hostRank, isCookieBannerCandidate, NEVER_FOLLOWED,
  type ApplyEntryCandidate
} from "./apply-entry";
import { classifyFieldRole } from "./ats/field-roles";
import { findVisibleChallengeIn } from "./challenge";
import { rejectCookieConsent } from "./cookie-consent";
import { isSignupField, recognizeFields, waitForStableControls } from "./form-recognition";
import { collectControlsIn, ensureNameShim } from "./handshake-executor";

/**
 * Deterministic navigation for sites the agent has no adapter for: from a
 * posting page to the first page that shows an application form. The walker
 * rejects cookie banners (cookie-consent.ts), then follows at most four
 * entries, in this order of kinds: a guest choice ("Apply as guest"), the
 * posting's Apply entry (apply-entry.ts chooseApplyEntry), an "Apply
 * manually" choice, and, on a page with no question at all, a plain
 * "Continue" / "Start application". It never follows sign-in, account
 * creation, third-party apply ("Apply with LinkedIn"), sharing, a cookie
 * control, a link to another site, or a button that submits a form with
 * inputs, and it never types, uploads, or submits. No model participates.
 * A page that embeds a Greenhouse application (apply-entry.ts
 * greenhouseEmbedTarget) is opened at the embed's address as an "embed" hop.
 * A clicked button that opens a new tab is followed only to the same site,
 * the same company domain, or a known ATS host (clickApplyEntry). An entry
 * that reaches a Workday posting stops the walk as "adapter": the Workday run
 * takes it from there.
 */

/** The roles only an application form asks for: a page showing one of them is the form. */
export const APPLICATION_FIELD_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>(["name", "email", "phone", "resume", "cover", "transcript", "work-auth", "sponsorship", "linkedin", "github"]);

/** A search box, job-alert or newsletter signup, or talent-community box: never the application's own field. */
const NOT_APPLICATION = /\b(?:search|keywords?|job alerts?|subscribe|newsletter|talent (?:community|network))\b/i;

/** Whether the fields include one an application form asks for (name, email, phone, resume, …). Pure. */
export function hasApplicationFields(fields: BrowserField[]): boolean {
  return fields.some((field) => !NOT_APPLICATION.test(field.label) && !isSignupField(field) && APPLICATION_FIELD_ROLES.has(classifyFieldRole(field)));
}

export type NavigationEntryCandidate = ApplyEntryCandidate & {
  /** A submit button of a form that holds visible inputs: clicking it would send that form. */
  submitsForm: boolean;
};

/**
 * Links and buttons that could lead on toward the application form, in page
 * order, outside cookie-consent containers. Each is tagged
 * `data-ia-nav-entry="<index>"` so the chosen one is clicked by that tag.
 * Same element set and visibility rules as handshake-executor.ts
 * collectApplyEntriesIn. Runs in the page, so every helper is declared here.
 */
export function collectNavigationEntriesIn(root: Element): Array<Omit<NavigationEntryCandidate, "frame">> {
  // Same list as cookie-consent.ts COOKIE_CONSENT_ROOTS; copied because this runs in the page.
  const CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  for (const tagged of Array.from(root.querySelectorAll("[data-ia-nav-entry]"))) tagged.removeAttribute("data-ia-nav-entry");
  const visibleInput = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    if (element instanceof HTMLInputElement) return !["hidden", "submit", "button", "reset", "image"].includes(element.type);
    return true;
  };
  const submitsForm = (element: Element): boolean => {
    const isSubmit = (element instanceof HTMLButtonElement && element.type === "submit")
      || (element instanceof HTMLInputElement && element.type === "submit");
    if (!isSubmit) return false;
    const form = (element as HTMLButtonElement | HTMLInputElement).form ?? element.closest("form");
    if (!form) return false;
    return Array.from(form.querySelectorAll("input, select, textarea")).some(visibleInput);
  };
  const entries: Array<Omit<NavigationEntryCandidate, "frame">> = [];
  const elements = Array.from(root.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]'));
  for (const element of elements) {
    if (element.closest(CONSENT_ROOTS)) continue;
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
    const id = element.id || null;
    const index = entries.length;
    element.setAttribute("data-ia-nav-entry", String(index));
    entries.push({ tag: anchor ? "a" : "button", href, texts, className, index, id, submitsForm: submitsForm(element) });
  }
  return entries;
}

const ACCOUNT = /\b(?:create (?:an )?account|register|sign up|join (?:our )?talent)\b/;
const GUEST = /^(?:(?:apply|continue|proceed)\s+)?as\s+(?:a\s+)?guest$|^guest(?:\s+(?:apply|application|checkout))?$|^apply without (?:an account|signing in|registering|registration)$|^continue without (?:an account|signing in)$/;
const MANUAL = /^(?:apply manually|fill (?:in|out) (?:the )?(?:application|form) manually|enter (?:my|your) (?:details|information) manually|continue without (?:a )?(?:resume|autofill))$/;
const ADVANCE = /^(?:continue|next|start|begin|get started|(?:start|begin|continue)\s+(?:my |your |the |an )?application|continue to (?:the )?application|proceed(?: to (?:the )?application)?)$/;

function normalizedText(text: string): string {
  return text.replace(/[‘’']/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

function parsedUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The key that marks an entry as followed: its href, or the page address and its text. */
export function navigationEntryKey(pageUrl: string, candidate: NavigationEntryCandidate): string {
  return candidate.href ?? `${pageUrl}#${candidate.texts[0] ?? ""}`;
}

export type NavigationEntryKind = "guest" | "apply" | "manual" | "advance";

/**
 * The one entry to follow next, or null. Guest choices first, then the
 * posting's Apply entry (chooseApplyEntry's rules), then "apply manually",
 * then, only on a page with no recognized question (`pageHasFields` false),
 * a plain Continue / Next / Start application. Cookie controls, sign-in,
 * account creation, sharing, third-party apply, a form's submit, links to
 * another site, and already-followed entries are never chosen. Pure.
 */
export function chooseNavigationEntry(
  pageUrl: string,
  candidates: NavigationEntryCandidate[],
  followed: ReadonlySet<string>,
  pageHasFields: boolean
): { candidate: NavigationEntryCandidate; kind: NavigationEntryKind } | null {
  const page = parsedUrl(pageUrl);
  if (!page) return null;
  const pageHost = page.hostname.toLowerCase();
  const remaining = candidates.filter((candidate) => {
    if (isCookieBannerCandidate(candidate)) return false;
    const texts = candidate.texts.map(normalizedText).filter(Boolean);
    if (texts.some((text) => NEVER_FOLLOWED.test(text) || ACCOUNT.test(text))) return false;
    if (candidate.submitsForm) return false;
    if (candidate.tag === "a" && candidate.href) {
      const href = parsedUrl(candidate.href);
      if (!href || (href.protocol !== "http:" && href.protocol !== "https:")) return false;
      if (hostRank(pageHost, href.hostname.toLowerCase()) === null) return false;
    }
    return !followed.has(navigationEntryKey(pageUrl, candidate));
  }).sort((a, b) => a.frame - b.frame || a.index - b.index);
  const byText = (pattern: RegExp) => remaining.find((candidate) => candidate.texts.map(normalizedText).some((text) => pattern.test(text)));
  const guest = byText(GUEST);
  if (guest) return { candidate: guest, kind: "guest" };
  const apply = chooseApplyEntry(pageUrl, remaining) as NavigationEntryCandidate | null;
  if (apply) return { candidate: apply, kind: "apply" };
  const manual = byText(MANUAL);
  if (manual) return { candidate: manual, kind: "manual" };
  if (!pageHasFields) {
    const advance = byText(ADVANCE);
    if (advance) return { candidate: advance, kind: "advance" };
  }
  return null;
}

/**
 * A step in front of the application form that no adapter takes yet and the
 * walker must name instead of reporting a form: Oracle Cloud HCM Candidate
 * Experience's email step (/apply/email, or an email box with no name,
 * phone, or resume field), which emails a one-time code before the form.
 * Null for any other page.
 */
export function siteWallReason(url: string, fields: BrowserField[]): string | null {
  const parsed = parsedUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".oraclecloud.com") || !parsed.pathname.includes("/hcmUI/CandidateExperience/")) return null;
  const roles = fields.map(classifyFieldRole);
  const emailStep = /\/apply\/email(?:$|[/?#])/.test(parsed.pathname)
    || (roles.includes("email") && !roles.some((role) => role === "name" || role === "phone" || role === "resume"));
  if (!emailStep) return null;
  return `Oracle Cloud HCM asks for your email at ${host}, then emails you a one-time code, before its application form; the agent does not take that step yet. Apply in your own browser.`;
}

export type StepButtons = {
  /** A visible, enabled control says submit, send, finish, complete, or apply. */
  submit: boolean;
  /** The first visible, enabled control that only moves on ("Next", "Continue", "Next Step"), or null. */
  next: string | null;
};

/**
 * The page's step buttons, outside cookie-consent containers. Runs in the
 * page, so every helper is declared here.
 */
export function readStepButtonsIn(root: Element): StepButtons {
  // Same list as cookie-consent.ts COOKIE_CONSENT_ROOTS; copied because this runs in the page.
  const CONSENT_ROOTS = '#onetrust-consent-sdk, #onetrust-banner-sdk, #onetrust-pc-sdk, #ot-sdk-cookie-policy, .ot-sdk-container, #CybotCookiebotDialog, #truste-consent-track, #truste-consent-content, #consent_blackbar, #usercentrics-root, #didomi-host, .cc-window, #cookiescript_injected, #cmplz-cookiebanner-container, #cookie-law-info-bar, #cookie-banner, #cookie-consent, #cookieConsent, [role="dialog"][aria-label*="cookie" i], [role="alertdialog"][aria-label*="cookie" i], [role="region"][aria-label*="cookie" i]';
  const SUBMIT = /\b(?:submit|send|finish|complete|apply)\b/i;
  const EXCLUDED = /\b(?:quick apply|cancel)\b/i;
  const NEXT = /^(?:next|continue|save (?:and|&) continue|next step|proceed)$/i;
  let submit = false;
  let next: string | null = null;
  for (const element of Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))) {
    if (element.closest(CONSENT_ROOTS)) continue;
    if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === "hidden") continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    const text = ((element as HTMLElement).innerText || (element instanceof HTMLInputElement ? element.value : "") || element.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (SUBMIT.test(text) && !EXCLUDED.test(text)) submit = true;
    if (next === null && NEXT.test(text)) next = text;
  }
  return { submit, next };
}

/**
 * Why a run stops on a page of several (a "Next" and no submit control): the
 * agent fills several-page forms only on sites it has an adapter for. Null
 * when the page shows a submit control or no "Next".
 */
export function multiStepStopReason(url: string, buttons: StepButtons): string | null {
  if (buttons.submit || !buttons.next) return null;
  const host = parsedUrl(url)?.hostname.toLowerCase() ?? url;
  return `The application at ${host} continues over several pages (its button says "${buttons.next}"), and the agent fills several-page forms only on sites it has an adapter for. Finish this application in your own browser.`;
}

export type NavigationHop = { kind: "consent" | "embed" | NavigationEntryKind; text: string };

export type NavigationOutcome = {
  /** Where the walk ended. */
  url: string;
  /** Whether any entry was followed (a cookie click alone does not count). */
  moved: boolean;
  hops: NavigationHop[];
  /**
   * form: an application field is shown; challenge: a CAPTCHA or bot check is
   * shown; wall: an account or email step in front of the form; no-entry:
   * nothing left to follow; hop-limit: four entries followed; left-site: an
   * entry led to another site; adapter: an entry led to a site the agent has
   * its own run for (a Workday posting).
   */
  stop: "form" | "challenge" | "wall" | "no-entry" | "hop-limit" | "left-site" | "adapter";
};

const MAX_HOPS = 4;

/**
 * A posting page saying the job is closed or gone (Greenhouse's "no longer open", Garmin's careers 404, Paylocity's Job Not Found,
 * iCIMS's "either does not exist or is no longer open" notice, which iCIMS draws in its same-host content frame, SmartRecruiters'
 * "This job has expired").
 */
const CLOSED_POSTING = /\b(?:the job you are looking for is no longer open|this job is no longer (?:open|available|accepting applications)|this job has expired|this (?:position|posting|job) (?:has been filled|is closed|has closed|is no longer available)|no longer accepting applications|(?:that|this) job does not exist or is not currently active|this job may be no longer available|the page you are looking for no longer exists|the job (?:that )?you were looking for (?:either )?does not exist or is no longer open)\b/i;

/** Ashby's page for a posting or job board it no longer serves (seen 2026-11-26 on a board that moved to another ATS); read only on jobs.ashbyhq.com, where no other page says it. */
const ASHBY_NOT_FOUND = /\bthe page you requested was not found\b/i;

/**
 * A posting page saying the job is closed or gone (Greenhouse's "no longer open", Garmin's careers 404, Paylocity's Job Not Found,
 * iCIMS's frame notice, SmartRecruiters' "This job has expired", and, when the page's address is on jobs.ashbyhq.com, Ashby's not-found
 * page); the matched words, or null. Pure.
 */
export function closedPostingNotice(bodyText: string, url?: string): string | null {
  const text = bodyText.replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
  const closed = CLOSED_POSTING.exec(text)?.[0];
  if (closed) return closed;
  if (url !== undefined && hostOf(url) === "jobs.ashbyhq.com") return ASHBY_NOT_FOUND.exec(text)?.[0] ?? null;
  return null;
}

/** A named sign-in choice a careers site shows in place of its application ("Sign in using Microsoft", "Sign in with Google"; Microsoft Careers' apply page, captured 2026-11-27). */
const SIGN_IN_CHOICE = /\bsign in (?:using|with) (microsoft|linkedin|google|facebook|apple)\b/gi;

/**
 * The named sign-in choices of a page that offers at least two of them (Microsoft Careers' apply page: "Sign in using Microsoft",
 * "Sign in using LinkedIn", "Sign in using Google", "Sign in using Facebook"), in page order, each provider once, as the page words
 * them; null when it offers fewer than two. Read only where no application form was reached. Pure.
 */
export function signInChoicesNotice(bodyText: string): string[] | null {
  const text = bodyText.replace(/\s+/g, " ");
  const choices = new Map<string, string>();
  for (const match of text.matchAll(SIGN_IN_CHOICE)) {
    const provider = match[1]!.toLowerCase();
    if (!choices.has(provider)) choices.set(provider, match[0]);
  }
  return choices.size >= 2 ? [...choices.values()] : null;
}
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((target) => target);";

function hostOf(url: string): string | null {
  return parsedUrl(url)?.hostname.toLowerCase() ?? null;
}

/**
 * The closed-posting words on the page: its main document and its same-host child frames (iCIMS draws a
 * job, and its closed notice, in a same-host content frame), never another host's frame. Read-only; a frame
 * that went away or runs no scripts adds nothing. Null when none says the posting is closed.
 */
export async function readClosedPostingNotice(page: Page): Promise<string | null> {
  const pageUrl = page.url();
  const pageHost = hostOf(pageUrl);
  const main = page.mainFrame();
  const frames: Frame[] = [main, ...page.frames().filter((frame) => frame !== main && pageHost !== null && hostOf(frame.url()) === pageHost)];
  const texts: string[] = [];
  for (const frame of frames) {
    try {
      await frame.evaluate(NAME_SHIM);
      texts.push(await frame.evaluate(() => document.body?.innerText ?? ""));
    } catch {
      // A frame that went away or runs no scripts says nothing.
    }
  }
  return closedPostingNotice(texts.join("\n"), pageUrl);
}

/** Visible form controls, for waiting until a page reached by a hop has drawn its form. Runs in the page. */
function countVisibleControlsIn(root: Element): number {
  return Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea, select')).filter((element) => element.getClientRects().length > 0).length;
}

/**
 * Walks from the current page toward the application form (see the header):
 * reads the page for a challenge, rejects a cookie banner, names a wall
 * before counting fields (an email-only account step is a wall, not a form),
 * stops at a page with an application field, and otherwise follows the
 * entry chooseNavigationEntry picks, at most four times. Main frame plus
 * same-host child frames, like followApplyEntry. Never types, uploads, or
 * clicks a form's submit.
 */
export async function advanceToApplicationForm(page: Page): Promise<NavigationOutcome> {
  const originalHost = hostOf(page.url()) ?? "";
  const hops: NavigationHop[] = [];
  const followed = new Set<string>();
  let moved = false;
  const outcome = (stop: NavigationOutcome["stop"]): NavigationOutcome => ({ url: page.url(), moved, hops, stop });
  for (let hop = 0; ; hop += 1) {
    await ensureNameShim(page).catch(() => undefined);
    const challenge = await page.evaluate(findVisibleChallengeIn).catch(() => null);
    if (challenge) return outcome("challenge");
    const consent = await rejectCookieConsent(page);
    if (consent) hops.push({ kind: "consent", text: consent.text });
    const controls = await page.locator("body").evaluate(collectControlsIn).catch(() => []);
    const fields = recognizeFields(controls);
    const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (applicationWallKind(page.url(), body) || siteWallReason(page.url(), fields)) return outcome("wall");
    if (hasApplicationFields(fields)) return outcome("form");
    if (hop >= MAX_HOPS) return outcome("hop-limit");
    // A careers page that embeds a Greenhouse application: open the embed's own address.
    const embedded = greenhouseEmbedTarget(page.url(), await embedSourcesOf(page));
    if (embedded && embedded !== page.url() && !followed.has(embedded)) {
      followed.add(embedded);
      try {
        await page.goto(embedded, { waitUntil: "domcontentloaded" });
      } catch {
        return outcome("no-entry");
      }
      hops.push({ kind: "embed", text: "Greenhouse application" });
      moved = true;
      await ensureNameShim(page).catch(() => undefined);
      await waitForStableControls(() => page.locator("body").evaluate(countVisibleControlsIn).catch(() => 0), { timeoutMs: 10_000 });
      continue;
    }
    const pageUrl = page.url();
    const pageHost = hostOf(pageUrl);
    const main = page.mainFrame();
    const frames: Frame[] = [main, ...page.frames().filter((frame) => frame !== main && pageHost !== null && hostOf(frame.url()) === pageHost)];
    const candidates: NavigationEntryCandidate[] = [];
    for (const [number, frame] of frames.entries()) {
      try {
        await frame.evaluate(NAME_SHIM);
        const found = await frame.locator("body").evaluate(collectNavigationEntriesIn);
        for (const entry of found) candidates.push({ ...entry, frame: number });
      } catch {
        // A frame that went away or runs no scripts offers no entry.
      }
    }
    const choice = chooseNavigationEntry(pageUrl, candidates, followed, fields.some((field) => field.kind !== "unknown"));
    if (!choice) return outcome("no-entry");
    followed.add(navigationEntryKey(pageUrl, choice.candidate));
    try {
      if (choice.candidate.tag === "a" && choice.candidate.href) {
        await page.goto(choice.candidate.href, { waitUntil: "domcontentloaded" });
      } else {
        await clickApplyEntry(page, frames[choice.candidate.frame]!.locator(`[data-ia-nav-entry="${choice.candidate.index}"]`).first());
      }
    } catch {
      return outcome("no-entry");
    }
    hops.push({ kind: choice.kind, text: choice.candidate.texts[0] ?? "" });
    moved = true;
    await ensureNameShim(page).catch(() => undefined);
    await waitForStableControls(() => page.locator("body").evaluate(countVisibleControlsIn).catch(() => 0), { timeoutMs: 10_000 });
    if (parseWorkdayUrl(page.url())) return outcome("adapter");
    const host = hostOf(page.url());
    if (host === null || hostRank(originalHost, host) === null) return outcome("left-site");
  }
}
