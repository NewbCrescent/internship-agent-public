import { competitivenessResponseSchema, semanticFitResponseSchema, type FitEvidence, type JobRequirement, type SemanticFitResponse } from "@internship-agent/domain";

/** Assess only professional capability; legal/degree eligibility stays in the existing policy. */
export function fitRequirements(requirements: JobRequirement[]) {
  return requirements.filter((r) => r.subject === "SKILL" || r.subject === "EXPERIENCE");
}

export function validateSemanticFit(response: unknown, requirements: JobRequirement[], evidence: FitEvidence[]): SemanticFitResponse {
  const result = semanticFitResponseSchema.parse(response);
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const sources = new Map(evidence.map((e) => [e.id, e.text]));
  const seen = new Set<string>();
  for (const decision of result.decisions) {
    const requirement = byId.get(decision.requirementId);
    if (!requirement || seen.has(requirement.id) || decision.postingQuote !== requirement.text) throw new Error("Invalid or duplicate posting citation.");
    seen.add(requirement.id);
    for (const citation of decision.citations) {
      if (!sources.get(citation.evidenceId)?.includes(citation.quote)) throw new Error("Invalid candidate evidence citation.");
    }
    if ((decision.assessment === "SUPPORTED" || decision.assessment === "PARTIAL") && decision.citations.length === 0)
      throw new Error("Positive assessments require candidate evidence.");
    if (decision.assessment === "MISSING" && evidence.length === 0) throw new Error("Absent evidence must be unknown, not missing.");
  }
  if (seen.size !== byId.size) throw new Error("Every supplied requirement must be assessed exactly once.");
  return result;
}

/** Unknowns contribute no coverage; their count is always shown, never omitted from the denominator. */
export function scoreSemanticFit(result: SemanticFitResponse, requirements: JobRequirement[]) {
  const weights = new Map(requirements.map((r) => [r.id, r.category === "HARD" ? 2 : 1]));
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const covered = result.decisions.reduce((sum, d) => sum + (weights.get(d.requirementId) ?? 0) *
    (d.assessment === "SUPPORTED" ? 1 : d.assessment === "PARTIAL" ? 0.5 : 0), 0);
  return { score: total ? Math.round(100 * covered / total) : 0,
    unknownCount: result.decisions.filter((d) => d.assessment === "UNKNOWN").length };
}

export type CompetitivenessIssue = { path: string; message: string };

/** Every provenance or consistency defect, located for a repair attempt. Empty means valid. */
export function diagnoseCompetitiveness(response: unknown, posting: string, evidence: FitEvidence[]): CompetitivenessIssue[] {
  const result = competitivenessResponseSchema.parse(response);
  const issues: CompetitivenessIssue[] = [];
  const sources = new Map(evidence.map((e) => [e.id, e.text]));
  (["strengths", "gaps"] as const).forEach((section) => {
    result[section].forEach((point, index) => {
      const at = `${section}[${index}]`;
      if (!posting.includes(point.postingQuote))
        issues.push({ path: `${at}.postingQuote`, message: `Invalid posting citation: ${JSON.stringify(point.postingQuote.slice(0, 120))} is not an exact substring of the posting.` });
      point.citations.forEach((citation, citationIndex) => {
        const source = sources.get(citation.evidenceId);
        if (!source)
          issues.push({ path: `${at}.citations[${citationIndex}]`, message: `Invalid candidate evidence citation: ${JSON.stringify(citation.evidenceId)} is not one of the supplied evidence IDs.` });
        else if (citation.quote.includes("[redacted]") || !source.includes(citation.quote))
          issues.push({ path: `${at}.citations[${citationIndex}]`, message: `Invalid candidate evidence citation: ${JSON.stringify(citation.quote.slice(0, 120))} is not an exact substring of ${JSON.stringify(citation.evidenceId)}.` });
      });
      if (section === "strengths" && point.citations.length === 0)
        issues.push({ path: at, message: "Strengths need candidate evidence." });
    });
  });
  if (evidence.length === 0 && (result.rating !== "INSUFFICIENT_INFORMATION" || result.score !== 0 || result.confidence !== "LOW"))
    issues.push({ path: "rating", message: "Absent candidate evidence cannot establish competitiveness." });
  const expected = result.score >= 75 ? "STRONG" : result.score >= 40 ? "MODERATE" : "WEAK";
  if (result.rating !== "INSUFFICIENT_INFORMATION" && result.rating !== expected)
    issues.push({ path: "rating", message: `Inconsistent rating and score: ${result.rating} does not match ${result.score}.` });
  if (result.rating === "INSUFFICIENT_INFORMATION" && (result.score !== 0 || result.confidence !== "LOW"))
    issues.push({ path: "rating", message: "Insufficient information requires zero score and low confidence." });
  if (result.rating === "STRONG" && result.strengths.length === 0)
    issues.push({ path: "strengths", message: "Strong ratings require supported strengths." });
  return issues;
}

/** Validate provenance without replacing the model's overall judgment with keyword arithmetic. */
export function validateCompetitiveness(response: unknown, posting: string, evidence: FitEvidence[]) {
  const result = competitivenessResponseSchema.parse(response);
  const issues = diagnoseCompetitiveness(result, posting, evidence);
  if (issues.length > 0) throw new Error(issues[0].message);
  return result;
}
