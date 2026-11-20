import type { SemanticFitAssessment } from "@internship-agent/domain";

/** Synthetic sorting fixture, not a reviewed accuracy label. */
export function competitivenessFixture(score: number): SemanticFitAssessment {
  return { version: 2, score, rating: score >= 75 ? "STRONG" : score >= 40 ? "MODERATE" : "WEAK",
    confidence: "LOW", summary: "Synthetic sorting fixture.", strengths: [], gaps: [],
    unknowns: ["Synthetic fixture does not measure real competitiveness."], decisions: [], unknownCount: 1,
    model: "fixture", evaluatedAt: new Date().toISOString() };
}
