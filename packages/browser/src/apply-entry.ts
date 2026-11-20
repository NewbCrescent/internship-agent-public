/**
 * The posting page's own Apply entry, chosen deterministically. A posting
 * page with no form (iCIMS, Jobvite, a company careers page) sends the
 * candidate on through an Apply link or button; the agent follows it once,
 * only to the same site, the same company domain, or a known ATS host.
 * Third-party sign-in buttons ("Apply with LinkedIn"), job aggregators,
 * sharing, referral, and save-for-later links are never followed.
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
};

const NEVER_FOLLOWED = /\b(?:linkedin|indeed|glassdoor|ziprecruiter|facebook|twitter|google|seek|monster|dice|handshake|share|refer(?:ral)?|e-?mail|later|save|sign in|log in|login)\b/;
const APPLY_TEXT = /^(?:apply|apply now|apply online|apply here|apply for (?:this|the) (?:job|position|role)(?: online)?|start (?:your |my )?application)$/;
const KNOWN_ATS_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "myworkdaysite.com", "icims.com",
  "jobvite.com", "smartrecruiters.com", "oraclecloud.com", "workable.com", "rippling.com"
];

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
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
function hostRank(pageHost: string, host: string): number | null {
  if (host === pageHost) return 0;
  if (lastTwoLabels(host) === lastTwoLabels(pageHost)) return 1;
  if (KNOWN_ATS_HOSTS.some((suffix) => hostEndsWith(host, suffix))) return 2;
  return null;
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
  const accepted: Array<{ candidate: ApplyEntryCandidate; rank: number }> = [];
  for (const candidate of candidates) {
    const texts = candidate.texts.map(normalizedText).filter(Boolean);
    if (texts.some((text) => NEVER_FOLLOWED.test(text))) continue;
    const byText = texts.some((text) => APPLY_TEXT.test(text));
    if (candidate.tag === "button") {
      if (byText) accepted.push({ candidate, rank: 0 });
      continue;
    }
    const href = parsedUrl(candidate.href);
    if (!href || (href.protocol !== "http:" && href.protocol !== "https:")) continue;
    const host = href.hostname.toLowerCase();
    const rank = hostRank(pageHost, host);
    if (rank === null) continue;
    const icimsApply = hostEndsWith(host, "icims.com") && href.searchParams.get("mode") === "apply";
    const jobviteApply = hostEndsWith(host, "jobvite.com") && /\/apply\/?$/.test(href.pathname);
    if (candidate.className.includes("iCIMS_ApplyOnlineButton") || icimsApply || jobviteApply || byText) {
      accepted.push({ candidate, rank });
    }
  }
  accepted.sort((a, b) => a.rank - b.rank
    || (a.candidate.tag === b.candidate.tag ? 0 : a.candidate.tag === "a" ? -1 : 1)
    || a.candidate.frame - b.candidate.frame
    || a.candidate.index - b.candidate.index);
  return accepted[0]?.candidate ?? null;
}

/**
 * A step in front of the application form that the agent never takes for the
 * candidate: iCIMS's email-first account step and Jobvite's data-consent
 * step. Null for any other page.
 */
export function applicationWallReason(url: string, bodyText: string): string | null {
  const parsed = parsedUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".icims.com") && /\/login(?:$|\/)/.test(parsed.pathname)) {
    return `iCIMS needs an account at ${host} before its application form, and the agent does not create iCIMS accounts. Sign in at ${host} in the agent's browser, then start the run yourself.`;
  }
  if (host.endsWith("jobvite.com") && /\bdata consent\b/i.test(bodyText)) {
    return `Jobvite asks you to accept its data-consent policy at ${host} before its application form, and the agent never gives consent for you. Accept it in the agent's browser, then start the run yourself.`;
  }
  return null;
}
