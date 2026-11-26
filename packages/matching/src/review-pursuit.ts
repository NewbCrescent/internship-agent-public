import type { JobMatchReport, JobPosting } from "@internship-agent/domain";

import { isBachelorKindMismatchReason } from "./degree-reading";
import {
  DEGREE_WORDING_REVIEW_REASON,
  DOCTORAL_STUDY_REVIEW_REASON,
  MASTER_STUDY_REVIEW_REASON,
  SKILL_REVIEW_REASON,
  graduateOnlyRequirement,
  titleNamesGraduateStudy
} from "./eligibility";

/** Whether the automatic pipeline may pursue a needs-review posting on its AI fit (candidate approval, 2026-11-24), and the requirements left unverified. */
export type ReviewPursuit = { pursue: true; unverified: string[] } | { pursue: false; reason: string };

/** Statements of fact only the candidate can confirm; an open requirement naming one is never pursued past. */
const CANDIDATE_FACT = /\b(?:security clearance|clearance|citizen(?:ship)?|u\.?\s?s\.? persons?|green card|permanent residen(?:t|cy)|export[- ]control(?:led|s)?|itar|polygraph|ts\/sci|authori[sz]ed to work|work authori[sz]ation|sponsorship|visa)\b/i;

function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/**
 * Allowlist, fail closed: an eligible needs-review match is pursued only when
 * every open finding is a skill or experience neither evidence nor the resume
 * names, degree wording the reader cannot compare, or a B.S./B.A. mismatch.
 * Graduate study, missing facts, statements of fact, failures, and any other
 * reason (including ones added later) are not pursued.
 */
export function reviewPursuit(
  report: Pick<JobMatchReport, "verdict" | "eligible" | "findings">,
  posting: Pick<JobPosting, "title" | "requirements"> & Partial<Pick<JobPosting, "locations" | "snapshot">>
): ReviewPursuit {
  if (report.verdict !== "NEEDS_REVIEW" || !report.eligible) {
    return { pursue: false, reason: "Only an eligible needs-review posting is pursued on its AI fit." };
  }
  if (report.findings.some((finding) => finding.outcome === "FAIL")) return { pursue: false, reason: "A requirement failed." };
  if (titleNamesGraduateStudy(posting.title, { locations: posting.locations, text: posting.snapshot?.normalizedText })) return { pursue: false, reason: "The title targets graduate study." };
  if (posting.requirements.some((requirement) => graduateOnlyRequirement(requirement))) {
    return { pursue: false, reason: "The posting requires or prefers graduate study." };
  }

  const unverified: string[] = [];
  const seen = new Set<string>();
  for (const finding of report.findings) {
    if (finding.outcome !== "UNKNOWN") continue;
    if (finding.reason === DOCTORAL_STUDY_REVIEW_REASON || finding.reason === MASTER_STUDY_REVIEW_REASON) {
      return { pursue: false, reason: "An open requirement asks for graduate study." };
    }
    const pursuable =
      ((finding.subject === "SKILL" || finding.subject === "EXPERIENCE") && finding.reason === SKILL_REVIEW_REASON) ||
      (finding.subject === "DEGREE" && (finding.reason === DEGREE_WORDING_REVIEW_REASON || isBachelorKindMismatchReason(finding.reason)));
    if (!pursuable) return { pursue: false, reason: `Open item needs your answer: ${finding.reason.slice(0, 200)}` };
    const requirement = finding.requirementId
      ? posting.requirements.find((candidate) => candidate.id === finding.requirementId)
      : undefined;
    if (!requirement) return { pursue: false, reason: "An open item has no stated requirement." };
    if (CANDIDATE_FACT.test(requirement.text)) {
      return { pursue: false, reason: "An open requirement is a statement of fact only you can confirm." };
    }
    const text = clip(requirement.text.replace(/\s+/g, " ").trim(), 160);
    const key = text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    unverified.push(text);
  }
  if (unverified.length === 0) return { pursue: false, reason: "No open requirement to pursue past." };
  return { pursue: true, unverified };
}
