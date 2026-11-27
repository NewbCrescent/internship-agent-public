import type { Locator, Page } from "playwright-core";

import { rejectCookieConsent } from "./cookie-consent";

/**
 * The posting page's own Apply entry, chosen deterministically. A posting
 * page with no form (iCIMS, Jobvite, a company careers page) sends the
 * candidate on through an Apply link or button; the agent follows it once,
 * only to the same site, the same company domain, or a known ATS host.
 * Third-party sign-in buttons ("Apply with LinkedIn"), job aggregators,
 * sharing, referral, and save-for-later links are never followed.
 *
 * A careers page that embeds a Greenhouse application (an iframe or frame
 * from Greenhouse's embed, or Greenhouse's embed script plus the page's own
 * `gh_jid`) is opened at that embed's own address (greenhouseEmbedTarget);
 * the board is read only from the page, never guessed. A clicked Apply button
 * that opens a new tab (Eightfold's Apply Now, which opens the employer's
 * Workday posting) is read and closed, and its address is followed only under
 * the same rule as a link: the same site, the same company domain, or a known
 * ATS host (adoptablePopup, clickApplyEntry).
 */

export type ApplyEntryCandidate = {
  tag: "a" | "button";
  /** The anchor's absolute href; null for a button. */
  href: string | null;
  /** The element's innerText, title, aria-label, and value. */
  texts: string[];
  className: string;
  /** 0 for the main frame, then same-host child frames in page order. */
  frame: number;
  /** Position in that frame's candidate list. */
  index: number;
  /** Element id if present. */
  id?: string | null;
};

export const NEVER_FOLLOWED = /\b(?:linkedin|indeed|glassdoor|ziprecruiter|facebook|twitter|google|seek|monster|dice|handshake|share|refer(?:ral)?|e-?mail|later|save|sign in|log in|login|cookie|cookies|onetrust|privacy preference)\b/;
const APPLY_TEXT = /^(?:apply|apply now|apply online|apply here|apply for (?:this|the) (?:job|position|role)(?: online)?|start (?:your |my )?application)$/;
const SMARTRECRUITERS_INTERESTED_TEXT = /^(?:i[']?m|im|i\s+am)\s+interested(?:\s+(?:in\s+(?:this\s+)?(?:job|role|position)|online))?$/;
const KNOWN_ATS_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "myworkdaysite.com", "icims.com",
  "jobvite.com", "smartrecruiters.com", "oraclecloud.com", "workable.com", "rippling.com", "paylocity.com"
];

function normalizedText(text: string): string {
  return text.replace(/[\u2018\u2019']/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Whether a candidate button or link belongs to a cookie consent banner,
 * Privacy Preference Center, or cookie policy overlay.
 */
export function isCookieBannerCandidate(candidate: ApplyEntryCandidate): boolean {
  const id = (candidate.id ?? "").toLowerCase();
  const cls = candidate.className.toLowerCase();
  const href = (candidate.href ?? "").toLowerCase();
  const texts = candidate.texts.map(normalizedText);

  // OneTrust specific IDs and classes
  if (
    id.includes("onetrust") ||
    cls.includes("onetrust") ||
    cls.includes("save-preference-btn-handler") ||
    id === "accept-recommended-btn-handler" ||
    id === "onetrust-accept-btn-handler"
  ) {
    return true;
  }

  // Cookie IDs / classes with allow/accept/settings/preferences/close
  if (id.includes("cookie") || cls.includes("cookie") || id.includes("consent") || cls.includes("consent")) {
    if (
      id.includes("accept") || id.includes("allow") || id.includes("agree") || id.includes("close") ||
      id.includes("pref") || id.includes("setting") || id.includes("banner") || id.includes("notice") ||
      cls.includes("accept") || cls.includes("allow") || cls.includes("agree") || cls.includes("close") ||
      cls.includes("pref") || cls.includes("setting") || cls.includes("banner") || cls.includes("notice") ||
      texts.some((t) => /\b(?:accept|allow|agree|cookie|cookies|consent|preference|preferences|settings|reject|dismiss|got it|close)\b/i.test(t))
    ) {
      return true;
    }
  }

  // Texts explicitly referencing cookies, OneTrust, or privacy preference centers
  if (texts.some((t) => /\b(?:cookie|cookies|onetrust|privacy preference(?: center)?)\b/i.test(t))) {
    return true;
  }

  // Href pointing to cookie policy or privacy preferences
  if (href && /\b(?:cookie|privacy[-_]?preference|onetrust)\b/i.test(href)) {
    return true;
  }

  return false;
}

/**
 * Rejects the page's cookie consent banner before an Apply entry is chosen
 * or clicked, so the banner never covers it: reject first, then
 * necessary-only, then close; never accept (cookie-consent.ts, shared with
 * the site navigation). Returns true when a control was clicked; false when
 * there is no banner or it offers only accept, which is left as it is.
 */
export async function dismissCookieBanner(page: Page): Promise<boolean> {
  return (await rejectCookieConsent(page)) !== null;
}

function parsedUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function lastTwoLabels(host: string): string {
  return host.split(".").slice(-2).join(".");
}

function hostEndsWith(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** 0 same host, 1 same company domain, 2 a known ATS host; null for any other site. */
export function hostRank(pageHost: string, host: string): number | null {
  if (host === pageHost) return 0;
  if (lastTwoLabels(host) === lastTwoLabels(pageHost)) return 1;
  if (KNOWN_ATS_HOSTS.some((suffix) => hostEndsWith(host, suffix))) return 2;
  return null;
}

const GREENHOUSE_EMBED_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io", "boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io"]);
const BOARD_TOKEN = /^[A-Za-z0-9_-]{1,80}$/;
const GREENHOUSE_JOB_ID = /^\d{1,20}$/;

/**
 * The Greenhouse application a careers page embeds, or null. Read only from
 * the page's own embed, never from a guessed board: an iframe or frame at
 * Greenhouse's `/embed/job_app?for=<board>&token=<id>` (kept on its own host;
 * its token must equal the page's `gh_jid` when the page has one), else, when
 * the page carries a `gh_jid` and exactly one Greenhouse embed script or board
 * (`/embed/job_board/js?for=<board>`), the application Greenhouse's embed
 * script itself builds: `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<gh_jid>`.
 * The embed address, not the board's job page, because the board's own job
 * page redirects back to the company's careers page. Several distinct
 * applications or boards give null. Pure.
 */
export function greenhouseEmbedTarget(pageUrl: string, sources: readonly string[]): string | null {
  const page = parsedUrl(pageUrl);
  const ghJid = page?.searchParams.get("gh_jid") ?? null;
  const pageJob = ghJid !== null && GREENHOUSE_JOB_ID.test(ghJid) ? ghJid : null;
  const applications = new Set<string>();
  const boards = new Set<string>();
  for (const source of sources) {
    const url = parsedUrl(source);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.port) continue;
    const host = url.hostname.toLowerCase();
    if (!GREENHOUSE_EMBED_HOSTS.has(host)) continue;
    const board = url.searchParams.get("for");
    if (board === null || !BOARD_TOKEN.test(board)) continue;
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/embed/job_app") {
      const token = url.searchParams.get("token");
      if (token === null || !GREENHOUSE_JOB_ID.test(token)) continue;
      if (pageJob !== null && token !== pageJob) continue;
      applications.add("https://" + host + "/embed/job_app?for=" + board + "&token=" + token);
    } else if (path === "/embed/job_board/js" || path === "/embed/job_board") {
      const boardHost = host.includes(".eu.") ? "job-boards.eu.greenhouse.io" : "job-boards.greenhouse.io";
      boards.add(boardHost + "\n" + board);
    }
  }
  if (applications.size === 1) return [...applications][0]!;
  if (applications.size > 1) return null;
  if (pageJob !== null && boards.size === 1) {
    const [boardHost, board] = [...boards][0]!.split("\n") as [string, string];
    return "https://" + boardHost + "/embed/job_app?for=" + board + "&token=" + pageJob;
  }
  return null;
}

/**
 * The addresses a page could embed a Greenhouse application from: every
 * frame's address, plus the main frame's iframe, frame, and script sources.
 * The caller has already run ensureNameShim; an unreadable page gives the
 * frame addresses alone.
 */
export async function embedSourcesOf(page: Page): Promise<string[]> {
  const frames = page.frames().map((frame) => frame.url());
  const elements = await page.evaluate(() => Array.from(document.querySelectorAll("iframe[src], frame[src], script[src]"))
    .map((element) => (element as HTMLIFrameElement | HTMLScriptElement).src)).catch(() => [] as string[]);
  return [...frames, ...elements];
}

/**
 * The new tab a clicked Apply entry opened that the agent may follow: exactly
 * one opened address, https, on the same host, the same company domain, or a
 * known ATS host (hostRank). Null otherwise (none, several, about:blank, an
 * aggregator). Pure.
 */
export function adoptablePopup(pageUrl: string, opened: readonly string[]): string | null {
  if (opened.length !== 1) return null;
  const page = parsedUrl(pageUrl);
  const target = parsedUrl(opened[0]);
  if (!page || !target || target.protocol !== "https:") return null;
  return hostRank(page.hostname.toLowerCase(), target.hostname.toLowerCase()) === null ? null : opened[0]!;
}

/**
 * Clicks an Apply button and waits up to settleMs for what it does: the
 * address changes in place (Oracle Candidate Experience routes to its email
 * step), or a new tab opens (Eightfold's Apply Now opens the employer's
 * Workday posting). A new tab is read, closed, and followed in this page only
 * when adoptablePopup allows it. Never types or submits.
 */
export async function clickApplyEntry(page: Page, target: Locator, settleMs = 5_000): Promise<void> {
  const before = new Set(page.context().pages());
  const startUrl = page.url();
  await target.click({ timeout: 10_000 });
  const opened = () => page.context().pages().filter((tab) => !before.has(tab));
  for (let waited = 0; waited < settleMs && opened().length === 0 && page.url() === startUrl; waited += 100) {
    await page.waitForTimeout(100);
  }
  const openedUrls: string[] = [];
  for (const tab of opened()) {
    for (let waited = 0; waited < settleMs && (tab.url() === "" || tab.url() === "about:blank"); waited += 100) {
      await tab.waitForTimeout(100).catch(() => undefined);
    }
    openedUrls.push(tab.url());
    await tab.close().catch(() => undefined);
  }
  const follow = adoptablePopup(startUrl, openedUrls);
  if (follow) await page.goto(follow, { waitUntil: "domcontentloaded" });
  else await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

/**
 * The one Apply entry to follow, or null when the page offers none the agent
 * may follow. Ranked by site (same host, then same domain, then a known ATS
 * host), then anchors before buttons, then page order.
 */
export function chooseApplyEntry(pageUrl: string, candidates: ApplyEntryCandidate[]): ApplyEntryCandidate | null {
  const page = parsedUrl(pageUrl);
  if (!page) return null;
  const pageHost = page.hostname.toLowerCase();
  const isSmartRecruitersPage = hostEndsWith(pageHost, "smartrecruiters.com");
  const accepted: Array<{ candidate: ApplyEntryCandidate; rank: number }> = [];
  for (const candidate of candidates) {
    if (isCookieBannerCandidate(candidate)) continue;
    const texts = candidate.texts.map(normalizedText).filter(Boolean);
    if (texts.some((text) => NEVER_FOLLOWED.test(text))) continue;
    const byApplyText = texts.some((text) => APPLY_TEXT.test(text));
    const targetHost = candidate.href ? parsedUrl(candidate.href)?.hostname.toLowerCase() ?? "" : "";
    const isSmartRecruitersTarget = targetHost !== "" && hostEndsWith(targetHost, "smartrecruiters.com");
    const bySmartRecruitersInterest = (isSmartRecruitersPage || isSmartRecruitersTarget) && texts.some((text) => SMARTRECRUITERS_INTERESTED_TEXT.test(text));
    const byText = byApplyText || bySmartRecruitersInterest;
    if (candidate.tag === "button") {
      if (byText) accepted.push({ candidate, rank: 0 });
      continue;
    }
    const href = parsedUrl(candidate.href);
    if (!href || (href.protocol !== "http:" && href.protocol !== "https:")) {
      if (byText) accepted.push({ candidate, rank: 0 });
      continue;
    }
    const host = href.hostname.toLowerCase();
    const rank = hostRank(pageHost, host);
    if (rank === null) continue;
    const icimsApply = hostEndsWith(host, "icims.com") && href.searchParams.get("mode") === "apply";
    const jobviteApply = hostEndsWith(host, "jobvite.com") && /\/apply\/?$/.test(href.pathname);
    const smartrecruitersApply = (isSmartRecruitersPage || hostEndsWith(host, "smartrecruiters.com")) && (
      candidate.className.includes("js-oneclick") ||
      candidate.className.includes("st-apply") ||
      /\/oneclick-ui\//.test(href.pathname) ||
      bySmartRecruitersInterest
    );
    if (candidate.className.includes("iCIMS_ApplyOnlineButton") || icimsApply || jobviteApply || smartrecruitersApply || byText) {
      accepted.push({ candidate, rank });
    }
  }
  accepted.sort((a, b) => a.rank - b.rank
    || (a.candidate.tag === b.candidate.tag ? 0 : a.candidate.tag === "a" ? -1 : 1)
    || a.candidate.frame - b.candidate.frame
    || a.candidate.index - b.candidate.index);
  return accepted[0]?.candidate ?? null;
}

export type ApplicationWallKind = "icims-account" | "jobvite-consent";

/** Which step in front of the application form the page shows: iCIMS's email-first account step or Jobvite's data-consent step. */
export function applicationWallKind(url: string, bodyText: string): ApplicationWallKind | null {
  const parsed = parsedUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".icims.com") && /\/login(?:$|\/)/.test(parsed.pathname)) return "icims-account";
  if (host.endsWith("jobvite.com") && /\bdata consent\b/i.test(bodyText)) return "jobvite-consent";
  return null;
}

/** The iCIMS tenant host of a URL (a hostname ending in ".icims.com", lower-cased), or null. */
export function icimsHostOf(url: string): string | null {
  const host = parsedUrl(url)?.hostname.toLowerCase() ?? null;
  return host && host.endsWith(".icims.com") ? host : null;
}

/**
 * An iCIMS job page (`/jobs/<number>/job` or `/jobs/<number>/<slug>/job` on a `*.icims.com` host) that carries no
 * `mode` parameter (iCIMS's Apply and application steps, such as `mode=apply`, carry one): the posting, never the
 * application. Its own boxes belong to the employer's career-site wrapper (a site search, a newsletter signup);
 * iCIMS's application starts behind its Apply entry.
 */
export function icimsPostingPage(url: string): boolean {
  const parsed = parsedUrl(url);
  if (!parsed || !icimsHostOf(url)) return false;
  if (parsed.searchParams.has("mode")) return false;
  return /^\/jobs\/\d+(?:\/[^/]+)?\/job\/?$/i.test(parsed.pathname);
}

/**
 * A step in front of the application form that stops the run unless the
 * run's settings take it: iCIMS's email-first account step (taken only with
 * INTERNSHIP_AGENT_ICIMS_ACCOUNTS on an automatic run) and Jobvite's
 * data-consent step (taken only with INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT).
 * Null for any other page.
 */
export function applicationWallReason(url: string, bodyText: string): string | null {
  const kind = applicationWallKind(url, bodyText);
  if (!kind) return null;
  const host = parsedUrl(url)!.hostname.toLowerCase();
  if (kind === "icims-account") {
    return `iCIMS needs an account at ${host} before its application form, and the agent does not create iCIMS accounts. Sign in at ${host} in the agent's browser, then start the run yourself.`;
  }
  return `Jobvite asks you to accept its data-consent policy at ${host} before its application form, and the agent never gives consent for you. Accept it in the agent's browser, then start the run yourself.`;
}
