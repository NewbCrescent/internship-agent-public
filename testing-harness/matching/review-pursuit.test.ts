import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { EligibilityFinding, JobRequirement } from "@internship-agent/domain";
import {
  bachelorKindMismatch,
  DEGREE_WORDING_REVIEW_REASON,
  DOCTORAL_STUDY_REVIEW_REASON,
  isBachelorKindMismatchReason,
  MASTER_STUDY_REVIEW_REASON,
  reviewPursuit,
  SKILL_REVIEW_REASON
} from "@internship-agent/matching";

/**
 * The needs-review pursuit allowlist (candidate approval, 2026-11-24): only
 * unverified skill, experience, degree-wording, and B.S./B.A. findings let a
 * needs-review posting go ahead on its AI fit.
 */
const JOB_ID = randomUUID();

function requirement(text: string, overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    id: randomUUID(),
    jobId: JOB_ID,
    text,
    category: "HARD",
    subject: "SKILL",
    extraction: "MODEL",
    assertion: "STATED",
    confidence: 0.9,
    span: { start: 0, end: text.length, excerpt: text },
    ...overrides
  };
}

function unknown(subject: string, reason: string, requirementId: string | null): EligibilityFinding {
  return { subject, requirementId, outcome: "UNKNOWN", reason, statedExcerpt: null };
}

function pass(subject: string, requirementId: string | null = null): EligibilityFinding {
  return { subject, requirementId, outcome: "PASS", reason: "Passes.", statedExcerpt: null };
}

type Case = { title?: string; requirements: JobRequirement[]; findings: EligibilityFinding[]; verdict?: "QUALIFIED" | "NOT_QUALIFIED" | "NEEDS_REVIEW"; eligible?: boolean };

function pursue({ title = "Software Engineering Intern", requirements, findings, verdict = "NEEDS_REVIEW", eligible = true }: Case) {
  return reviewPursuit({ verdict, eligible, findings }, { title, requirements });
}

/** One open requirement with one UNKNOWN finding on it. */
function single(text: string, subject: JobRequirement["subject"], reason: string, overrides: Partial<JobRequirement> = {}) {
  const line = requirement(text, { subject, ...overrides });
  return { requirements: [line], findings: [unknown(subject, reason, line.id)] };
}

describe("reviewPursuit", () => {
  it("pursues an unverified skill and names its requirement text", () => {
    expect(pursue(single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON))).toEqual({ pursue: true, unverified: ["Experience with Elixir"] });
  });

  it("pursues an unverified experience requirement", () => {
    const result = pursue(single("Experience building REST APIs in Go", "EXPERIENCE", SKILL_REVIEW_REASON));
    expect(result).toEqual({ pursue: true, unverified: ["Experience building REST APIs in Go"] });
  });

  it("pursues degree wording the reader cannot compare", () => {
    const result = pursue(single("Degree in a quantitative field", "DEGREE", DEGREE_WORDING_REVIEW_REASON));
    expect(result).toEqual({ pursue: true, unverified: ["Degree in a quantitative field"] });
  });

  it("pursues a B.S. line against a B.A. degree", () => {
    const reason = bachelorKindMismatch("B.S. in Computer Science", "B.A. Computer Science");
    expect(reason).toBeTruthy();
    expect(isBachelorKindMismatchReason(reason!)).toBe(true);
    expect(isBachelorKindMismatchReason(SKILL_REVIEW_REASON)).toBe(false);
    expect(isBachelorKindMismatchReason(DEGREE_WORDING_REVIEW_REASON)).toBe(false);
    expect(pursue(single("B.S. in Computer Science", "DEGREE", reason!))).toEqual({ pursue: true, unverified: ["B.S. in Computer Science"] });
  });

  it("pursues a bachelor's-or-master's line, since it states a bachelor's alternative", () => {
    const result = pursue(single("Bachelor's or Master's degree in Computer Science", "DEGREE", DEGREE_WORDING_REVIEW_REASON));
    expect(result).toEqual({ pursue: true, unverified: ["Bachelor's or Master's degree in Computer Science"] });
  });

  it("does not pursue a doctoral requirement", () => {
    const result = pursue(single("Currently pursuing a PhD in Computer Science", "DEGREE", DOCTORAL_STUDY_REVIEW_REASON));
    expect(result.pursue).toBe(false);
    expect(["The posting requires or prefers graduate study.", "An open requirement asks for graduate study."])
      .toContain(result.pursue ? "" : result.reason);
  });

  it("does not pursue a master's-study finding, even when the line itself is not graduate-only", () => {
    // A line the requirement scan does not read as graduate-only still stops on the finding's reason.
    const result = pursue(single("Relevant coursework required", "DEGREE", MASTER_STUDY_REVIEW_REASON));
    expect(result).toEqual({ pursue: false, reason: "An open requirement asks for graduate study." });
  });

  it("does not pursue a posting that prefers a master's degree", () => {
    const skill = requirement("Experience with Elixir");
    const preferred = requirement("Master's degree in Computer Science preferred", { category: "PREFERRED", subject: "DEGREE" });
    const result = pursue({ requirements: [skill, preferred], findings: [unknown("SKILL", SKILL_REVIEW_REASON, skill.id), pass("DEGREE", preferred.id)] });
    expect(result).toEqual({ pursue: false, reason: "The posting requires or prefers graduate study." });
  });

  it("does not pursue a graduate-study title", () => {
    const result = pursue({ title: "PhD Software Engineering Intern", ...single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON) });
    expect(result).toEqual({ pursue: false, reason: "The title targets graduate study." });
  });

  it("pursues a title that also names a bachelor's level", () => {
    const result = pursue({ title: "Research Intern (BS/MS/PhD)", ...single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON) });
    expect(result).toEqual({ pursue: true, unverified: ["Experience with Elixir"] });
  });

  it("reads an MS in the title as Mississippi only at a Mississippi posting (Track 56)", () => {
    const title = "Intern, MS - Summer 2027";
    const open = single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON);
    const report = { verdict: "NEEDS_REVIEW" as const, eligible: true, findings: open.findings };
    const raw = "Jackson, MS";
    const jackson = {
      jobId: JOB_ID, raw, city: "Jackson", region: "MS", countryCode: "US", workMode: "UNSPECIFIED" as const,
      span: { start: 0, end: raw.length, excerpt: raw }
    };
    expect(reviewPursuit(report, { title, requirements: open.requirements, locations: [jackson] }))
      .toEqual({ pursue: true, unverified: ["Experience with Elixir"] });
    expect(reviewPursuit(report, { title, requirements: open.requirements }))
      .toEqual({ pursue: false, reason: "The title targets graduate study." });
  });

  it("does not pursue a missing degree or a missing full-time answer", () => {
    const missing = pursue(single("Bachelor's degree in Computer Science", "DEGREE",
      "No degree is recorded on the profile, so degree eligibility needs candidate review."));
    expect(missing.pursue).toBe(false);
    expect(missing.pursue ? "" : missing.reason).toMatch(/^Open item needs your answer: No degree is recorded/);
    const fullTime = pursue(single("Full-time student pursuing a Bachelor's degree", "DEGREE",
      "The posting asks for full-time enrollment, which is not recorded yet; answer \"Are you a full-time student?\" in candidate memory."));
    expect(fullTime.pursue).toBe(false);
    expect(fullTime.pursue ? "" : fullTime.reason).toMatch(/^Open item needs your answer: The posting asks for full-time enrollment/);
  });

  it("does not pursue constraint or school findings", () => {
    const skill = requirement("Experience with Elixir");
    const authorization = pursue({
      requirements: [skill],
      findings: [unknown("SKILL", SKILL_REVIEW_REASON, skill.id), unknown("authorization", "Work authorization is not recorded.", null)]
    });
    expect(authorization.pursue).toBe(false);
    const school = pursue({
      requirements: [skill],
      findings: [unknown("school", "The posting may be for another school's students.", null), unknown("SKILL", SKILL_REVIEW_REASON, skill.id)]
    });
    expect(school.pursue).toBe(false);
  });

  it("does not pursue an allowlisted reason without a stated requirement", () => {
    const result = pursue({ requirements: [], findings: [unknown("SKILL", SKILL_REVIEW_REASON, null)] });
    expect(result).toEqual({ pursue: false, reason: "An open item has no stated requirement." });
  });

  it("does not pursue when any requirement failed", () => {
    const { requirements, findings } = single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON);
    const result = pursue({ requirements, findings: [...findings, { subject: "graduation", requirementId: null, outcome: "FAIL", reason: "Graduation is outside the window.", statedExcerpt: null }] });
    expect(result).toEqual({ pursue: false, reason: "A requirement failed." });
  });

  it("pursues only an eligible needs-review match", () => {
    const base = single("Experience with Elixir", "SKILL", SKILL_REVIEW_REASON);
    const reason = "Only an eligible needs-review posting is pursued on its AI fit.";
    expect(pursue({ ...base, verdict: "QUALIFIED" })).toEqual({ pursue: false, reason });
    expect(pursue({ ...base, verdict: "NOT_QUALIFIED", eligible: false })).toEqual({ pursue: false, reason });
    expect(pursue({ ...base, eligible: false })).toEqual({ pursue: false, reason });
  });

  it("does not pursue a statement of fact only the candidate can confirm", () => {
    const fact = "An open requirement is a statement of fact only you can confirm.";
    expect(pursue(single("Active security clearance", "SKILL", SKILL_REVIEW_REASON))).toEqual({ pursue: false, reason: fact });
    expect(pursue(single("Must be authorized to work in the US", "EXPERIENCE", SKILL_REVIEW_REASON))).toEqual({ pursue: false, reason: fact });
    expect(pursue(single("Must be a U.S. person for export-controlled work", "SKILL", SKILL_REVIEW_REASON))).toEqual({ pursue: false, reason: fact });
  });

  it("does not pursue a match with no open finding", () => {
    const line = requirement("Experience with Elixir");
    expect(pursue({ requirements: [line], findings: [pass("SKILL", line.id)] })).toEqual({ pursue: false, reason: "No open requirement to pursue past." });
  });

  it("deduplicates requirement texts and clips long ones", () => {
    const first = requirement("Experience with  Elixir");
    const second = requirement("experience with elixir", { subject: "EXPERIENCE" });
    const long = requirement(`Experience with ${"distributed systems ".repeat(12)}`.trim());
    const result = pursue({
      requirements: [first, second, long],
      findings: [
        unknown("SKILL", SKILL_REVIEW_REASON, first.id),
        unknown("EXPERIENCE", SKILL_REVIEW_REASON, second.id),
        unknown("SKILL", SKILL_REVIEW_REASON, long.id)
      ]
    });
    expect(result.pursue).toBe(true);
    const unverified = result.pursue ? result.unverified : [];
    expect(unverified).toHaveLength(2);
    expect(unverified[0]).toBe("Experience with Elixir");
    expect(unverified[1]).toHaveLength(160);
    expect(unverified[1]!.endsWith("…")).toBe(true);
  });
});
