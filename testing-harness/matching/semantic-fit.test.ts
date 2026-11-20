import { describe, it, expect } from "vitest";
import { scoreSemanticFit, validateSemanticFit, validateCompetitiveness, diagnoseCompetitiveness } from "@internship-agent/matching";
import type { JobRequirement } from "@internship-agent/domain";
const id = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const requirement = (key: string, category: "HARD" | "PREFERRED"): JobRequirement => ({
  id: key, jobId: id, text: "Build TypeScript services", category, subject: "SKILL", assertion: "STATED",
  confidence: 1, extraction: "DETERMINISTIC", span: { start: 0, end: 25, excerpt: "Build TypeScript services" }
});
const requirements = [requirement(id, "HARD"), requirement(second, "PREFERRED")];
const evidence = [{ id: "resume:1", text: "Built TypeScript services for a class project." }];
const decision = (key: string, assessment: "SUPPORTED" | "PARTIAL" | "UNKNOWN" | "MISSING") => ({
  requirementId: key, postingQuote: requirements[0].text, assessment,
  citations: assessment === "SUPPORTED" || assessment === "PARTIAL" ? [{ evidenceId: "resume:1", quote: evidence[0].text }] : []
});
describe("grounded semantic fit", () => {
  it("weights hard capability coverage twice, partial half, and retains unknowns in the denominator", () => {
    const response = validateSemanticFit({ decisions: [decision(id, "PARTIAL"), decision(second, "UNKNOWN")] }, requirements, evidence);
    expect(scoreSemanticFit(response, requirements)).toEqual({ score: 33, unknownCount: 1 });
    expect(scoreSemanticFit({ decisions: [decision(id, "SUPPORTED"), decision(second, "SUPPORTED")] }, requirements).score).toBe(100);
  });
  it("rejects invented sources, quotes, duplicate or omitted requirements, and unsupported positives", () => {
    const valid = { decisions: [decision(id, "SUPPORTED"), decision(second, "UNKNOWN")] };
    expect(() => validateSemanticFit({ decisions: [valid.decisions[0]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [valid.decisions[0], valid.decisions[0]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [{ ...valid.decisions[0], postingQuote: "Invented requirement" }, valid.decisions[1]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [{ ...valid.decisions[0], citations: [{ evidenceId: "fake", quote: evidence[0].text }] }, valid.decisions[1]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [{ ...valid.decisions[0], citations: [{ evidenceId: "resume:1", quote: "Led a team of 100" }] }, valid.decisions[1]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [{ ...valid.decisions[0], citations: [] }, valid.decisions[1]] }, requirements, evidence)).toThrow();
    expect(() => validateSemanticFit({ decisions: [decision(id, "MISSING"), decision(second, "UNKNOWN")] }, requirements, [])).toThrow();
  });
});

describe("overall AI competitiveness", () => {
  const posting = "Receive training in SQL. Undergraduate enrollment required.";
  const result = {score: 81, rating: "STRONG", confidence: "MEDIUM", summary: "Relevant transferable experience.",
    strengths: [{text: "Relevant project",postingQuote: "Receive training in SQL.", citations: [{evidenceId: "resume:1", quote: evidence[0].text}]}],
    gaps: [], unknowns: ["Applicant competition is unknown."]};
  it("preserves the AI judgment instead of computing keyword coverage", () => {
    expect(validateCompetitiveness(result,posting,evidence).score).toBe(81);
  });
  it("rejects fabricated citations and unsupported strength claims", () => {
    expect(() => validateCompetitiveness({...result,strengths:[{...result.strengths[0],postingQuote:"SQL required"}]},posting,evidence)).toThrow();
    expect(() => validateCompetitiveness({...result,strengths:[{...result.strengths[0],citations:[]}]},posting,evidence)).toThrow();
    expect(() => validateCompetitiveness({...result,strengths:[{...result.strengths[0],citations:[{evidenceId:"fake",quote:evidence[0].text}]}]},posting,evidence)).toThrow();
    expect(() => validateCompetitiveness({...result,strengths:[{...result.strengths[0],citations:[{evidenceId:"resume:1",quote:"Invented experience"}]}]},posting,evidence)).toThrow();
    expect(() => validateCompetitiveness({...result,rating:"WEAK"},posting,evidence)).toThrow();
  });
  it("requires insufficient information with no evidence instead of an inflated rating", () => {
    expect(() => validateCompetitiveness(result,posting,[])).toThrow();
    expect(validateCompetitiveness({...result,score:0,rating:"INSUFFICIENT_INFORMATION",confidence:"LOW",strengths:[]},posting,[]).rating).toBe("INSUFFICIENT_INFORMATION");
  });
});

describe("competitiveness diagnosis", () => {
  const posting = "Receive training in SQL. Undergraduate enrollment required.";
  const evidence = [{ id: "resume:1", text: "Built TypeScript services for a class project." }];
  const valid = {score: 81, rating: "STRONG", confidence: "MEDIUM", summary: "Relevant transferable experience.",
    strengths: [{text: "Relevant project",postingQuote: "Receive training in SQL.", citations: [{evidenceId: "resume:1", quote: evidence[0].text}]}],
    gaps: [], unknowns: ["Applicant competition is unknown."]};
  it("returns no issues for a valid assessment", () => {
    expect(diagnoseCompetitiveness(valid,posting,evidence)).toEqual([]);
  });
  it("locates a hallucinated evidence ID with its point path", () => {
    const broken = {...valid,strengths:[{...valid.strengths[0],citations:[{evidenceId:"resume:hallucinated",quote:evidence[0].text}]}]};
    expect(diagnoseCompetitiveness(broken,posting,evidence)).toEqual([
      { path: "strengths[0].citations[0]", message: 'Invalid candidate evidence citation: "resume:hallucinated" is not one of the supplied evidence IDs.' }
    ]);
    expect(() => validateCompetitiveness(broken,posting,evidence)).toThrowError(/not one of the supplied evidence IDs/);
  });
  it("locates inexact posting and evidence quotes", () => {
    const badPosting = {...valid,strengths:[{...valid.strengths[0],postingQuote:"SQL required"}]};
    expect(diagnoseCompetitiveness(badPosting,posting,evidence)[0].path).toBe("strengths[0].postingQuote");
    const badQuote = {...valid,strengths:[{...valid.strengths[0],citations:[{evidenceId:"resume:1",quote:"Invented experience"}]}]};
    const issues = diagnoseCompetitiveness(badQuote,posting,evidence);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("strengths[0].citations[0]");
    expect(issues[0].message).toMatch(/not an exact substring of "resume:1"/);
  });
  it("flags rating and score inconsistencies with the expected match", () => {
    const issues = diagnoseCompetitiveness({...valid,rating:"WEAK"},posting,evidence);
    expect(issues).toEqual([{ path: "rating", message: "Inconsistent rating and score: WEAK does not match 81." }]);
  });
});
