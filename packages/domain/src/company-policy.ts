import type { ApplicationProfile } from "./browser";
import { applicationChannelFor } from "./candidate-facts";
import { normalizeCompanyName } from "./company-name";
import { parseWorkdayUrl } from "./workday";

/**
 * Per-company limits for the automatic pipeline: how many applications one
 * company may receive per target term, and the one graduation profile a
 * company sees. These are the pure rules; the agent reads the history.
 */

/** Most automatic applications per company per target term when INTERNSHIP_AGENT_COMPANY_CAP is unset. */
export const DEFAULT_COMPANY_CAP = 2;

/** Every company-cap timeline detail starts with this, so it is logged once per posting. */
export const COMPANY_CAP_PREFIX = "Company cap: ";

/** The identities a posting answers to: its normalized name and the Workday tenant host of any of its URLs. */
export function companyIdentities(input: { companyName: string; urls: ReadonlyArray<string | null | undefined> }): string[] {
  const identities = new Set<string>();
  const name = normalizeCompanyName(input.companyName);
  if (name) identities.add(`name:${name}`);
  for (const url of input.urls) {
    const host = url ? parseWorkdayUrl(url)?.host : undefined;
    if (host) identities.add(`workday:${host}`);
  }
  return [...identities];
}

/** True when two postings share any identity (same normalized name or same Workday tenant host). */
export function sharesCompany(a: readonly string[], b: readonly string[]): boolean {
  return a.some((identity) => b.includes(identity));
}

/** INTERNSHIP_AGENT_COMPANY_CAP as a whole number clamped to 1–20, or null when unset or invalid. */
export function companyCapSetting(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.INTERNSHIP_AGENT_COMPANY_CAP?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return null;
  return Math.min(20, Math.max(1, Number.parseInt(raw, 10)));
}

/** The timeline and report reason for a posting over its company's cap. */
export function companyCapReason(company: string, applications: number): string {
  return `${COMPANY_CAP_PREFIX}already ${applications} application${applications === 1 ? "" : "s"} to ${company}.`;
}

/** One earlier run or submission at a company and the profile it used. */
export type ProfileEvidence = { profile: ApplicationProfile; submitted: boolean; at: string };

/** The profile a company already saw: the earliest submitted entry's, else the earliest entry's; null when none. */
export function pinnedProfile(evidence: readonly ProfileEvidence[]): ApplicationProfile | null {
  const earliest = (entries: readonly ProfileEvidence[]) =>
    entries.reduce<ProfileEvidence | null>((first, entry) => (!first || entry.at < first.at ? entry : first), null);
  return (earliest(evidence.filter((entry) => entry.submitted)) ?? earliest(evidence))?.profile ?? null;
}

/** The profile a run used: its recorded value, else read from its decisions and the posting's channel as before migration 0029. */
export function profileOfRun(
  run: { applicationProfile?: ApplicationProfile | null; decisions: ReadonlyArray<{ basis: { kind: string } | null }> },
  applicationType: string | null | undefined
): ApplicationProfile {
  if (run.applicationProfile) return run.applicationProfile;
  if (applicationChannelFor(applicationType)) return "transcript";
  return run.decisions.some((decision) => decision.basis?.kind === "candidate_document") ? "transcript" : "default";
}

/** The run-start events browser-orchestrator logs (setJobStatus to APPLYING); keep in step with its texts. */
const RUN_START = /^(?:Browser|Workday) run (?:started|restarted)\b/;
/** Marks a run the pipeline started ("… run started automatically from the verified package …"). */
export const AUTOMATIC_START_MARK = "started automatically";

/**
 * Whether the pipeline (not the candidate) started a run, from its job's run-start events: the latest one at or
 * before the run's creation decides. With none recorded the run counts as automatic, so an unknown row never
 * frees an extra automatic application.
 */
export function runStartedByPipeline(runCreatedAt: string, events: ReadonlyArray<{ detail: string | null; at: string }>): boolean {
  let latest: { detail: string; at: string } | null = null;
  for (const event of events) {
    if (!event.detail || !RUN_START.test(event.detail) || event.at > runCreatedAt) continue;
    if (!latest || event.at >= latest.at) latest = { detail: event.detail, at: event.at };
  }
  return latest ? latest.detail.includes(AUTOMATIC_START_MARK) : true;
}
