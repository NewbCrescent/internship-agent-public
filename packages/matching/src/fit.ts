import type { CandidatePreference, FitReason, JobPosting } from "@internship-agent/domain";

import { canonicalSkillKey, displaySkillKey, impliedSkills, mentionsSkill } from "./skill-keys";

/**
 * Explainable fit scoring. Every point carries a reason the dashboard can
 * display. A missing preferred skill reduces fit; it never fails eligibility.
 */
export type FitInputs = {
  /** Normalized technology keys backed by ALLOWED + CURRENT evidence claims. */
  evidencedTechnologies: string[];
  /** Skills the candidate's approved resume entries name; they count toward fit like evidence. */
  resumeSkills?: string[];
  /** Count of ALLOWED + CURRENT claims across the candidate's projects. */
  allowedClaimCount: number;
  preferences: CandidatePreference | null;
};

export function scoreFit(
  posting: JobPosting,
  inputs: FitInputs
): { score: number; reasons: FitReason[] } {
  const covered = new Set([...inputs.evidencedTechnologies.map(displaySkillKey), ...(inputs.resumeSkills ?? [])]
    .flatMap(impliedSkills).map(canonicalSkillKey));
  const matched = posting.technologies.filter((t) => covered.has(canonicalSkillKey(t.normalizedKey)));
  const preferred = posting.requirements.filter((r) => r.category === "PREFERRED" && (r.subject === "SKILL" || r.subject === "EXPERIENCE"));
  const strengths = [...inputs.evidencedTechnologies.map(displaySkillKey), ...(inputs.resumeSkills ?? [])].flatMap(impliedSkills);
  const count = preferred.filter((r) => strengths.some((skill) => mentionsSkill(r.text, skill))).length;
  const hasTech = posting.technologies.length > 0;
  const hasPreferred = preferred.length > 0;
  const techWeight = hasTech ? (hasPreferred ? 70 : 100) : 0;
  const preferredWeight = hasPreferred ? (hasTech ? 30 : 100) : 0;
  const technology = hasTech ? Math.round(techWeight * matched.length / posting.technologies.length) : 0;
  const preference = hasPreferred ? Math.round(preferredWeight * count / preferred.length) : 0;
  const reasons: FitReason[] = [{ factor: "Technology coverage", delta: technology,
    detail: `${matched.length} of ${posting.technologies.length} named technologies have keyword support in approved evidence or your resume. This does not establish experience depth.` },
    { factor: "Preferred capability coverage", delta: preference,
      detail: `${count} of ${preferred.length} preferred skill/experience requirements mention your approved strengths. No baseline or unrelated bonuses are added.` }];
  if (!hasTech && !hasPreferred) reasons.push({ factor: "Insufficient comparable requirements", delta: 0,
    detail: "No comparable technologies or preferred capabilities were extracted. Zero means no measured coverage, not proven poor fit." });
  return { score: Math.min(100, technology + preference), reasons };
}
