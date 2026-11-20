import type { DatabaseSync } from "node:sqlite";

import { getCandidate, getCurrentFact, getJobPosting, listCompanyHistory } from "@internship-agent/db";
import {
  applicationChannelFor,
  companyIdentities,
  judgeTerm,
  pinnedProfile,
  profileOfRun,
  runStartedByPipeline,
  sharesCompany,
  type ApplicationProfile,
  type BrowserRunStatus,
  type ProfileEvidence,
  type TargetTerm
} from "@internship-agent/domain";

/**
 * Reads application history for the automatic pipeline's per-company limits:
 * how many automatic applications a company already has this term, and which
 * graduation profile it already saw. The pure rules live in packages/domain company-policy.
 */

export type CompanyStanding = {
  /** The posting's own company name, for messages. */
  company: string;
  /**
   * Other same-company postings with a run the pipeline started that is in flight or submitted (the target term
   * only, when one is set); the candidate's own runs and checklist submissions do not count.
   */
  applications: number;
  /** The profile earlier runs and submissions at this company fixed, this posting's own earlier runs included. */
  profile: ApplicationProfile | null;
};

/** A run that may still reach the site: "failed" is set only by a failed submit, which may have been sent. */
const IN_FLIGHT: ReadonlySet<BrowserRunStatus> = new Set(["started", "paused-needs-input", "awaiting-approval", "submitting", "failed"]);

/** The company's count of applications and fixed graduation profile, seen from one posting; null when the posting is unknown. */
export function companyStanding(
  database: DatabaseSync,
  jobId: string,
  options: { term?: TargetTerm | null } = {}
): CompanyStanding | null {
  const posting = getJobPosting(database, jobId);
  if (!posting) return null;
  const mine = companyIdentities({
    companyName: posting.companyName,
    urls: [posting.source.sourceUrl, posting.source.externalApplicationUrl, posting.source.companyCareersUrl]
  });
  const evidence: ProfileEvidence[] = [];
  let applications = 0;
  for (const entry of listCompanyHistory(database)) {
    const theirs = companyIdentities({
      companyName: entry.companyName,
      urls: [...entry.urls, ...entry.runs.map((run) => run.applicationUrl)]
    });
    if (!sharesCompany(mine, theirs)) continue;
    for (const run of entry.runs) {
      evidence.push({ profile: profileOfRun(run, entry.applicationType), submitted: run.status === "submitted", at: run.createdAt });
    }
    // A submission without a run (the manual checklist): its year is known only for a Handshake-internal posting.
    if (entry.submitted && entry.runs.length === 0 && applicationChannelFor(entry.applicationType)) {
      evidence.push({ profile: "transcript", submitted: true, at: entry.updatedAt });
    }
    if (entry.jobId === jobId) continue;
    // Only the agent's own applications count: runs the pipeline started that are in flight or submitted.
    // The candidate's runs and checklist submissions fix the profile above but never use a slot.
    const counts = entry.runs.some((run) =>
      (IN_FLIGHT.has(run.status) || run.status === "submitted") && runStartedByPipeline(run.createdAt, entry.applyingEvents));
    if (!counts) continue;
    if (options.term && judgeTerm({ title: entry.title, text: entry.text, employmentType: entry.employmentType }, options.term).outcome === "skip") continue;
    applications += 1;
  }
  return { company: posting.companyName, applications, profile: pinnedProfile(evidence) };
}

/** "2028 profile" from the profile's graduation answer, else "default profile" / "transcript profile". */
export function profileLabel(database: DatabaseSync, candidateId: string, profile: ApplicationProfile): string {
  const fact = getCurrentFact(
    database,
    candidateId,
    "graduation_date",
    profile === "transcript" ? { kind: "application_channel", channel: "handshake_internal" } : { kind: "global" }
  )?.value;
  const value = typeof fact === "string" ? fact : profile === "default" ? getCandidate(database, candidateId)?.graduationDate : undefined;
  const year = value?.slice(0, 4);
  return year && /^\d{4}$/.test(year) ? `${year} profile` : `${profile} profile`;
}

/** Why an automatic run is held when a company that saw the default profile would now get the transcript profile. */
export function yearHoldMessage(database: DatabaseSync, candidateId: string, company: string): string {
  return `${company} already received your ${profileLabel(database, candidateId, "default")}. This application would send your ${profileLabel(database, candidateId, "transcript")} (the form asks for a transcript, or it applies through Handshake), so the run is held for you: ${company} should see one graduation year. Apply yourself if you still want this one.`;
}
