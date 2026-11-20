import type { ApplicationType, EmploymentType } from "@internship-agent/domain";

const HANDSHAKE_HOSTS = new Set(["joinhandshake.com", "app.joinhandshake.com", "handshake.com"]);

const ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "myworkdayjobs.com",
  "workday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "workable.com",
  "breezy.hr"
];

/**
 * Milestone 3 ingests pasted content, so the application type is derived from
 * the URLs the candidate supplies rather than from a live page. An external
 * application URL on a Handshake posting is Handshake's "Apply Externally"
 * path, which Milestone 8 handles.
 */
export function classifyApplicationType(
  sourceUrl: string,
  externalApplicationUrl: string | null
): ApplicationType {
  if (externalApplicationUrl) {
    return isAtsHost(externalApplicationUrl) ? "EXTERNAL_ATS" : "EMPLOYER_SITE";
  }
  if (isHandshakeHost(sourceUrl)) return "HANDSHAKE_INTERNAL";
  if (isAtsHost(sourceUrl)) return "EXTERNAL_ATS";
  return "UNKNOWN";
}

export function isHandshakeHost(url: string): boolean {
  const host = hostname(url);
  return host !== null && (HANDSHAKE_HOSTS.has(host) || host.endsWith(".joinhandshake.com"));
}

export function isAtsHost(url: string): boolean {
  const host = hostname(url);
  return host !== null && ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`));
}

export function classifyEmploymentType(title: string, normalizedText: string): EmploymentType {
  const haystack = `${title}\n${normalizedText.slice(0, 2_000)}`.toLocaleLowerCase("en-US");
  if (/\bco-?op\b/.test(haystack)) return "CO_OP";
  if (/\bintern(ship)?\b/.test(haystack)) return "INTERNSHIP";
  if (/\b(new ?grad|university grad|entry[- ]level|early career)\b/.test(haystack)) return "NEW_GRAD";
  return "OTHER";
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return null;
  }
}
