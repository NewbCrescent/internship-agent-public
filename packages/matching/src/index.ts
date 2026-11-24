import type {
  EligibilityFinding,
  JobMatchReport,
  JobPosting,
  MatchVerdict
} from "@internship-agent/domain";
import { jobMatchReportSchema } from "@internship-agent/domain";

import { evaluateEligibility, type EligibilityInputs } from "./eligibility";
import { scoreFit, type FitInputs } from "./fit";

export * from "./degree-reading";
export * from "./eligibility";
export * from "./fit";
export * from "./review-pursuit";
export * from "./school-restriction";
export * from "./skill-keys";

export type MatchInputs = EligibilityInputs & FitInputs & {
  /** Profile degree text; absent means degree checks pause, never fail. */
  candidateDegree: string | null;
};

/**
 * One deterministic pass: hard eligibility first, then explainable fit.
 * INFERRED readings and silent fields can shape fit but never fail.
 */
export function evaluateJobMatch(
  posting: JobPosting,
  inputs: MatchInputs,
  evaluatedAt = new Date().toISOString()
): JobMatchReport {
  const findings: EligibilityFinding[] = evaluateEligibility(posting, {
    facts: inputs.facts,
    preferences: inputs.preferences,
    candidateDegree: inputs.candidateDegree,
    candidateField: inputs.candidateField,
    candidateSchool: inputs.candidateSchool,
    evidencedTechnologies: inputs.evidencedTechnologies,
    resumeSkills: inputs.resumeSkills
  });
  const { score, reasons } = scoreFit(posting, {
    evidencedTechnologies: inputs.evidencedTechnologies,
    resumeSkills: inputs.resumeSkills,
    allowedClaimCount: inputs.allowedClaimCount,
    preferences: inputs.preferences
  });

  const verdict: MatchVerdict = findings.some((finding) => finding.outcome === "FAIL")
    ? "NOT_QUALIFIED"
    : findings.some((finding) => finding.outcome === "UNKNOWN")
      ? "NEEDS_REVIEW"
      : "QUALIFIED";

  return jobMatchReportSchema.parse({
    jobId: posting.id,
    verdict,
    eligible: verdict !== "NOT_QUALIFIED",
    fitScore: score,
    findings,
    reasons,
    evaluatedAt,
    scoringVersion: 2
  });
}
export * from "./semantic-fit";
