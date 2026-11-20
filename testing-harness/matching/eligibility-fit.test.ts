import { describe, expect, it } from "vitest";

import {
  jobPostingSchema,
  type CandidateFact,
  type CandidatePreference,
  type JobPosting
} from "@internship-agent/domain";
import { evaluateJobMatch } from "@internship-agent/matching";

const BASE_POSTING = {
  id: "11111111-1111-4111-8111-111111111111",
  companyName: "Aurora Labs",
  title: "Software Engineering Intern",
  employmentType: "INTERNSHIP",
  status: "DISCOVERED",
  source: {
    applicationType: "HANDSHAKE_INTERNAL",
    sourceUrl: "https://app.joinhandshake.com/jobs/900001",
    externalApplicationUrl: null,
    companyCareersUrl: null
  },
  snapshot: {
    id: "22222222-2222-4222-8222-222222222222",
    jobId: "11111111-1111-4111-8111-111111111111",
    contentHash: "hash",
    normalizedText: "Software Engineering Intern. Must be authorized to work in the US. Python and React preferred.",
    capturedAt: "2026-09-22T12:00:00.000Z"
  },
  locations: [],
  compensation: null,
  requirements: [],
  technologies: [],
  constraints: { graduation: null, authorization: null, sponsorship: null, availability: null },
  createdAt: "2026-09-22T12:00:00.000Z",
  updatedAt: "2026-09-22T12:00:00.000Z"
};

function posting(overrides: Record<string, unknown> = {}): JobPosting {
  return jobPostingSchema.parse({ ...BASE_POSTING, ...overrides });
}

function span(text: string) {
  return { start: 0, end: text.length, excerpt: text };
}

function fact(key: CandidateFact["key"], scope: CandidateFact["scope"], value: boolean | string): CandidateFact {
  const valueType = typeof value === "boolean" ? "boolean" : "date";
  return {
    id: `${key}-fact`,
    candidateId: "local-candidate",
    key,
    scope,
    value,
    valueType: valueType as "boolean" | "date",
    source: "user",
    sourceDetail: { kind: "remembered_answer", question: "Seeded for tests." },
    confidence: 1,
    sensitivity: "standard",
    reusePolicy: "auto",
    rememberedAt: "2026-09-22T12:00:00.000Z",
    createdAt: "2026-09-22T12:00:00.000Z",
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  };
}

const PREFERENCES: CandidatePreference = {
  candidateId: "local-candidate",
  roleTypes: ["Software Engineering"],
  locations: ["Seattle, WA"],
  workModes: ["onsite"],
  industries: [],
  excludeGraduateOnlyInternships: false,
  updatedAt: "2026-09-22T12:00:00.000Z"
};

const BASE_INPUTS = {
  facts: [],
  preferences: PREFERENCES,
  candidateDegree: null,
  evidencedTechnologies: [],
  allowedClaimCount: 0
};

describe("deterministic eligibility", () => {
  it("fails only on a stated constraint contradiction", () => {
    const evaluated = evaluateJobMatch(
      posting({
        constraints: {
          graduation: null,
          authorization: null,
          sponsorship: {
            sponsorshipAvailable: false,
            countryCode: "US",
            raw: "We do not sponsor visas.",
            extraction: "DETERMINISTIC",
            assertion: "STATED",
            span: span("We do not sponsor visas.")
          },
          availability: null
        }
      }),
      {
        ...BASE_INPUTS,
        facts: [fact("requires_sponsorship", { kind: "country", code: "US" }, true)]
      }
    );
    expect(evaluated.verdict).toBe("NOT_QUALIFIED");
    expect(evaluated.eligible).toBe(false);
    expect(evaluated.findings.some((finding) => finding.outcome === "FAIL")).toBe(true);
  });

  it("treats a silent posting as deciding nothing", () => {
    const evaluated = evaluateJobMatch(posting(), BASE_INPUTS);
    expect(evaluated.findings.filter((finding) => finding.outcome === "FAIL")).toHaveLength(0);
    expect(evaluated.verdict).toBe("QUALIFIED");
  });

  it("pauses on unknown facts instead of failing", () => {
    const evaluated = evaluateJobMatch(
      posting({
        constraints: {
          graduation: {
            earliest: null,
            latest: "2027-06-01",
            raw: "Graduating by June 2027.",
            extraction: "DETERMINISTIC",
            assertion: "STATED",
            span: span("Graduating by June 2027.")
          },
          authorization: null,
          sponsorship: null,
          availability: null
        }
      }),
      BASE_INPUTS
    );
    expect(evaluated.verdict).toBe("NEEDS_REVIEW");
    expect(evaluated.eligible).toBe(true);
    expect(evaluated.findings.some((finding) => finding.outcome === "UNKNOWN")).toBe(true);
  });

  it("passes a graduation fact inside the stated window", () => {
    const evaluated = evaluateJobMatch(
      posting({
        constraints: {
          graduation: {
            earliest: "2026-01-01",
            latest: "2027-06-01",
            raw: "Graduating between 2026 and June 2027.",
            extraction: "DETERMINISTIC",
            assertion: "STATED",
            span: span("Graduating between 2026 and June 2027.")
          },
          authorization: null,
          sponsorship: null,
          availability: null
        }
      }),
      { ...BASE_INPUTS, facts: [fact("graduation_date", { kind: "global" }, "2027-05-15")] }
    );
    expect(evaluated.verdict).toBe("QUALIFIED");
  });

  it("checks Handshake-internal postings against the Handshake graduation date only there", () => {
    const window2029 = {
      graduation: {
        earliest: "2029-01-01",
        latest: "2029-06-30",
        raw: "Graduating in the first half of 2029.",
        extraction: "DETERMINISTIC",
        assertion: "STATED",
        span: span("Graduating in the first half of 2029.")
      },
      authorization: null,
      sponsorship: null,
      availability: null
    };
    const facts = [
      fact("graduation_date", { kind: "global" }, "2028-05-15"),
      fact("graduation_date", { kind: "application_channel", channel: "handshake_internal" }, "2029-05-15")
    ];
    const handshake = evaluateJobMatch(posting({ constraints: window2029 }), { ...BASE_INPUTS, facts });
    expect(handshake.verdict).toBe("QUALIFIED");

    const external = evaluateJobMatch(posting({
      constraints: window2029,
      source: { ...BASE_POSTING.source, applicationType: "EXTERNAL_ATS" }
    }), { ...BASE_INPUTS, facts });
    expect(external.verdict).toBe("NOT_QUALIFIED");
    expect(external.findings.find((finding) => finding.subject === "graduation")?.reason).toContain("2028-05-15");
  });

  it("passes an evidence-backed hard skill instead of pausing", () => {
    const excerpt = "Experience with Python required.";
    const evaluated = evaluateJobMatch(
      posting({
        requirements: [
          {
            id: "44444444-4444-4434-8444-444444444444",
            jobId: BASE_POSTING.id,
            text: excerpt,
            category: "HARD",
            subject: "SKILL",
            extraction: "DETERMINISTIC",
            assertion: "STATED",
            confidence: 0.9,
            span: span(excerpt)
          }
        ]
      }),
      { ...BASE_INPUTS, evidencedTechnologies: ["dependency:python"] }
    );
    expect(evaluated.findings.find((finding) => finding.subject === "SKILL")?.outcome).toBe("PASS");
    expect(evaluated.verdict).toBe("QUALIFIED");
  });

  it("passes a matching degree and pauses on a weak one without ever failing", () => {
    const excerpt = "Must be enrolled in a Bachelor's degree program in Computer Science.";
    const requirement = {
      id: "55555555-5555-4555-8555-555555555555",
      jobId: BASE_POSTING.id,
      text: excerpt,
      category: "HARD" as const,
      subject: "DEGREE" as const,
      extraction: "DETERMINISTIC" as const,
      assertion: "STATED" as const,
      confidence: 0.9,
      span: span(excerpt)
    };
    const matched = evaluateJobMatch(posting({ requirements: [requirement] }), {
      ...BASE_INPUTS,
      candidateDegree: "B.S. Computer Science"
    });
    expect(matched.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("PASS");

    const weak = evaluateJobMatch(posting({ requirements: [requirement] }), {
      ...BASE_INPUTS,
      candidateDegree: "Juris Doctor"
    });
    expect(weak.findings.filter((finding) => finding.outcome === "FAIL")).toHaveLength(0);
    expect(weak.verdict).toBe("NEEDS_REVIEW");
  });

  it("pauses on a doctorate-only requirement when the profile records only a bachelor's degree", () => {
    const excerpt = "Must be working towards a PhD in computer science.";
    const requirement = {
      id: "66666666-6666-4666-8666-666666666666",
      jobId: BASE_POSTING.id,
      text: excerpt,
      category: "HARD" as const,
      subject: "DEGREE" as const,
      extraction: "DETERMINISTIC" as const,
      assertion: "STATED" as const,
      confidence: 0.9,
      span: span(excerpt)
    };
    const role = posting({ requirements: [requirement] });
    const unconfirmed = evaluateJobMatch(role, { ...BASE_INPUTS, candidateDegree: "B.S. Computer Science" });
    expect(unconfirmed.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("UNKNOWN");
    expect(unconfirmed.verdict).toBe("NEEDS_REVIEW");

    const confirmed = evaluateJobMatch(role, { ...BASE_INPUTS, candidateDegree: "PhD Computer Science" });
    expect(confirmed.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("PASS");
    expect(confirmed.verdict).toBe("QUALIFIED");

    const alternative = evaluateJobMatch(posting({ requirements: [{ ...requirement, text: "Must be pursuing a Bachelor's or PhD in computer science." }] }), {
      ...BASE_INPUTS,
      candidateDegree: "B.S. Computer Science"
    });
    expect(alternative.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("PASS");

    const mastersAlternative = posting({ requirements: [{ ...requirement, text: "Must be pursuing a Master's or PhD in computer science." }] });
    const bachelorsAgainstMasters = evaluateJobMatch(mastersAlternative, { ...BASE_INPUTS, candidateDegree: "B.S. Computer Science" });
    expect(bachelorsAgainstMasters.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("UNKNOWN");

    const nonAlternative = posting({ requirements: [{ ...requirement, text: "A Bachelor's degree is insufficient; a PhD in computer science is required." }] });
    const bachelorsAgainstRequirement = evaluateJobMatch(nonAlternative, { ...BASE_INPUTS, candidateDegree: "B.S. Computer Science" });
    expect(bachelorsAgainstRequirement.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("UNKNOWN");

    const mastersOnly = posting({ requirements: [{ ...requirement, text: "Must be working towards a Master's degree in computer science." }] });
    const bachelorsAgainstMastersOnly = evaluateJobMatch(mastersOnly, { ...BASE_INPUTS, candidateDegree: "B.S. Computer Science" });
    expect(bachelorsAgainstMastersOnly.findings.find((finding) => finding.subject === "DEGREE")?.outcome).toBe("UNKNOWN");
  });

  it("excludes graduate-only internships only when the saved preference is enabled", () => {
    const excerpt = "Must be pursuing a Master's or PhD in computer science.";
    const requirement = {
      id: "77777777-7777-4777-8777-777777777777",
      jobId: BASE_POSTING.id,
      text: excerpt,
      category: "HARD" as const,
      subject: "DEGREE" as const,
      extraction: "DETERMINISTIC" as const,
      assertion: "STATED" as const,
      confidence: 0.9,
      span: span(excerpt)
    };
    const inputs = { ...BASE_INPUTS, candidateDegree: "B.S. Computer Science" };
    const enabled = { ...inputs, preferences: { ...PREFERENCES, excludeGraduateOnlyInternships: true } };

    const ordinary = posting({ requirements: [requirement] });
    expect(evaluateJobMatch(ordinary, enabled).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(ordinary, inputs).findings.some((finding) => finding.reason.includes("saved preference"))).toBe(false);
    const mastersOnly = posting({ requirements: [{ ...requirement, text: "Must be pursuing a Master's degree in computer science." }] });
    expect(evaluateJobMatch(mastersOnly, enabled).verdict).toBe("NOT_QUALIFIED");

    const titled = posting({ title: "PhD Research Intern" });
    expect(evaluateJobMatch(titled, enabled).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ title: "Master's Research Intern" }), enabled).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ title: "Master the Product Intern" }), enabled).verdict).toBe("QUALIFIED");

    const bachelorsAlternative = posting({ requirements: [{ ...requirement, text: "Must be pursuing a Bachelor's or Master's degree in computer science." }] });
    expect(evaluateJobMatch(bachelorsAlternative, enabled).verdict).toBe("QUALIFIED");
    const abbreviatedAlternative = posting({ requirements: [{ ...requirement, text: "Currently pursuing a B.S. or M.S. in Computer Science." }] });
    expect(evaluateJobMatch(abbreviatedAlternative, enabled).verdict).toBe("QUALIFIED");

    const preferred = posting({ requirements: [{ ...requirement, category: "PREFERRED" }] });
    expect(evaluateJobMatch(preferred, enabled).verdict).toBe("QUALIFIED");

    // Regression: Example Analytics (2026-11-17) stated graduate enrollment under
    // "Education and Experience:", so the extractor left it PREFERRED at 0.4 for lack of any cue.
    const enrollment = "Current students pursuing a master's degree in mathematics, Physics, Financial Engineering, Quantitative Finance, or a related quantitative field.";
    const defaulted = { ...requirement, text: enrollment, span: span(enrollment), category: "PREFERRED" as const, confidence: 0.4 };
    expect(evaluateJobMatch(posting({ requirements: [defaulted] }), enabled).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ requirements: [defaulted] }), inputs).verdict).not.toBe("NOT_QUALIFIED");
    // A Preferred heading (0.7) or preference wording keeps it soft; so does a verb "master".
    expect(evaluateJobMatch(posting({ requirements: [{ ...defaulted, confidence: 0.7 }] }), enabled).verdict).toBe("QUALIFIED");
    const wordedSoft = "Current students pursuing a master's degree preferred.";
    expect(evaluateJobMatch(posting({ requirements: [{ ...defaulted, text: wordedSoft, span: span(wordedSoft) }] }), enabled).verdict).toBe("QUALIFIED");
    const verb = "Master's the team's business domain basics within 1 month.";
    expect(evaluateJobMatch(posting({ requirements: [{ ...defaulted, text: verb, span: span(verb) }] }), enabled).verdict).toBe("QUALIFIED");
    const proseMention = posting({ snapshot: { ...BASE_POSTING.snapshot, normalizedText: "A team mentor has a PhD." } });
    expect(evaluateJobMatch(proseMention, enabled).verdict).toBe("QUALIFIED");
  });

  it("checks graduate programs like an MBA from the requirement text, whatever subject the model gave it", () => {
    // Regression: Example Software "Intern, AI Agent Evaluations" (2026-09-24) stated "Currently
    // enrolled in a MBA." The model labeled it GRADUATION, so it produced no finding.
    const excerpt = "Currently enrolled in a MBA.";
    const requirement = {
      id: "88888888-8888-4888-8888-888888888888",
      jobId: BASE_POSTING.id,
      text: excerpt,
      category: "HARD" as const,
      subject: "GRADUATION" as const,
      extraction: "MODEL" as const,
      assertion: "STATED" as const,
      confidence: 0.9,
      span: span(excerpt)
    };
    const inputs = { ...BASE_INPUTS, candidateDegree: "B.A. Computer Science" };
    const enabled = { ...inputs, preferences: { ...PREFERENCES, excludeGraduateOnlyInternships: true } };
    const mba = posting({ requirements: [requirement] });

    const excluded = evaluateJobMatch(mba, enabled);
    expect(excluded.verdict).toBe("NOT_QUALIFIED");
    expect(excluded.findings.find((finding) => finding.outcome === "FAIL")?.statedExcerpt).toBe(excerpt);
    const reviewed = evaluateJobMatch(mba, inputs);
    expect(reviewed.verdict).toBe("NEEDS_REVIEW");
    expect(reviewed.findings.find((finding) => finding.requirementId === requirement.id)?.outcome).toBe("UNKNOWN");

    for (const text of ["Currently enrolled in an MBA program with expected graduation within 1 year.", "Pursuing an M.B.A.",
      "Enrolled in a Master of Business Administration program.", "Currently pursuing an MEng in Computer Science.", "Current J.D. candidate."]) {
      expect(evaluateJobMatch(posting({ requirements: [{ ...requirement, text, subject: "OTHER" as const }] }), enabled).verdict, text).toBe("NOT_QUALIFIED");
    }
    expect(evaluateJobMatch(posting({ title: "Product Management Intern - MBA (Summer 2027)" }), enabled).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ requirements: [{ ...requirement, text: "Pursuing a B.S. or MBA." }] }), enabled).verdict).not.toBe("NOT_QUALIFIED");
    // A tool name is not a degree: without program wording, "MS" in a skill line stays a skill.
    const skillLine = posting({ requirements: [{ ...requirement, subject: "SKILL" as const, text: "Experience with MS SQL Server and MA-style dashboards." }] });
    expect(evaluateJobMatch(skillLine, enabled).verdict).not.toBe("NOT_QUALIFIED");
    // Unrelated graduation lines are still left to the graduation-date check.
    expect(evaluateJobMatch(posting({ requirements: [{ ...requirement, text: "Graduating between December 2027 and June 2028." }] }), enabled).verdict).toBe("QUALIFIED");
  });

  it("lets the resume meet hard skill requirements, matching whole words only", () => {
    const skill = (id: string, text: string, subject: "SKILL" | "EXPERIENCE" = "SKILL") => ({
      id, jobId: BASE_POSTING.id, text, category: "HARD" as const, subject, extraction: "MODEL" as const,
      assertion: "STATED" as const, confidence: 0.9, span: span(text)
    });
    const role = posting({ requirements: [
      skill("a1111111-1111-4111-8111-111111111111", "Proficiency in Python or Go."),
      skill("a2222222-2222-4222-8222-222222222222", "Experience building services with Node.js.", "EXPERIENCE"),
      skill("a3333333-3333-4333-8333-333333333333", "Strong React skills.")
    ] });
    const withResume = evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["Python", "Node.js", "C", "JavaScript"] });
    const outcome = (id: string) => withResume.findings.find((finding) => finding.requirementId === id);
    expect(outcome("a1111111-1111-4111-8111-111111111111")).toMatchObject({ outcome: "PASS", reason: "Your resume lists Python, which this requirement names." });
    expect(outcome("a2222222-2222-4222-8222-222222222222")?.outcome).toBe("PASS");
    // "C" is not inside "React", and "JavaScript" is not a stray letter "a": the old substring check passed these.
    expect(outcome("a3333333-3333-4333-8333-333333333333")?.outcome).toBe("UNKNOWN");
    expect(withResume.verdict).toBe("NEEDS_REVIEW");
    expect(evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["Python", "Node.js", "React"] }).verdict).toBe("QUALIFIED");
    expect(evaluateJobMatch(role, BASE_INPUTS).findings.every((finding) => finding.outcome === "UNKNOWN")).toBe(true);
    // Verified evidence keeps its own wording when both apply.
    expect(evaluateJobMatch(role, { ...BASE_INPUTS, evidencedTechnologies: ["python"], resumeSkills: ["Python"] })
      .findings.find((finding) => finding.requirementId === "a1111111-1111-4111-8111-111111111111")?.reason).toContain("Verified evidence");
  });

  it("counts resume skills toward fit without a missing-skill penalty for them", () => {
    const technology = (label: string, key: string) => ({ jobId: BASE_POSTING.id, label, normalizedKey: key, extraction: "DETERMINISTIC" as const, span: span(label) });
    const role = posting({ technologies: [technology("Python", "python"), technology("React", "react"), technology("Rust", "rust")] });
    const none = evaluateJobMatch(role, BASE_INPUTS);
    const resume = evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["Python", "React"] });
    expect(resume.fitScore).toBeGreaterThan(none.fitScore);
    expect(resume.reasons.find((reason) => reason.factor === "Technology coverage")).toMatchObject({ delta: 67 });
    expect(resume.reasons.find((reason) => reason.factor === "Technology coverage")?.detail).toContain("2 of 3");
    expect(resume.fitScore).toBe(67);
  });

  it("never fails on skills, experience, or preferred readings", () => {
    const excerpt = "5 years of CUDA experience required.";
    const evaluated = evaluateJobMatch(
      posting({
        requirements: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            jobId: BASE_POSTING.id,
            text: excerpt,
            category: "PREFERRED",
            subject: "SKILL",
            extraction: "DETERMINISTIC",
            assertion: "STATED",
            confidence: 0.8,
            span: span(excerpt)
          }
        ]
      }),
      BASE_INPUTS
    );
    expect(evaluated.findings.filter((finding) => finding.outcome === "FAIL")).toHaveLength(0);
    expect(evaluated.eligible).toBe(true);
  });
});

describe("explainable fit", () => {
  function techPosting() {
    const python = "We use Python daily.";
    const cuda = "CUDA experience is a plus.";
    return posting({
      technologies: [
        {
          jobId: BASE_POSTING.id,
          label: "Python",
          normalizedKey: "python",
          extraction: "DETERMINISTIC",
          span: span(python)
        },
        {
          jobId: BASE_POSTING.id,
          label: "CUDA",
          normalizedKey: "cuda",
          extraction: "DETERMINISTIC",
          span: span(cuda)
        }
      ]
    });
  }

  it("rewards evidence-backed overlap with readable reasons", () => {
    const evaluated = evaluateJobMatch(techPosting(), {
      ...BASE_INPUTS,
      evidencedTechnologies: ["python"],
      allowedClaimCount: 4
    });
    const overlap = evaluated.reasons.find((reason) => reason.factor === "Technology coverage");
    expect(overlap?.delta).toBeGreaterThan(0);
    expect(overlap?.detail).toContain("named technologies");
    expect(evaluated.reasons.length).toBeGreaterThan(1);
    expect(evaluated.reasons.every((reason) => reason.detail.length > 0)).toBe(true);
  });

  it("reduces fit for missing skills without touching eligibility", () => {
    const without = evaluateJobMatch(techPosting(), BASE_INPUTS);
    const withEvidence = evaluateJobMatch(techPosting(), {
      ...BASE_INPUTS,
      evidencedTechnologies: ["python", "cuda"]
    });
    expect(without.fitScore).toBe(0);
    expect(without.eligible).toBe(true);
    expect(withEvidence.fitScore).toBeGreaterThan(without.fitScore);
  });

  it("keeps every score inside 0-100", () => {
    const evaluated = evaluateJobMatch(techPosting(), {
      ...BASE_INPUTS,
      evidencedTechnologies: ["python"],
      allowedClaimCount: 40
    });
    expect(evaluated.fitScore).toBeGreaterThanOrEqual(0);
    expect(evaluated.fitScore).toBeLessThanOrEqual(100);
  });
});

describe("skill aliases and degree wording", () => {
  const line = (id: string, text: string, subject: "SKILL" | "DEGREE" | "EXPERIENCE" = "SKILL") => ({
    id, jobId: BASE_POSTING.id, text, category: "HARD" as const, subject, extraction: "MODEL" as const,
    assertion: "STATED" as const, confidence: 0.9, span: span(text)
  });
  const outcomeOf = (report: ReturnType<typeof evaluateJobMatch>, id: string) =>
    report.findings.find((finding) => finding.requirementId === id);

  it("lets a listed skill cover its other names and the broader skill, one way only", () => {
    const role = posting({ requirements: [
      line("b1111111-1111-4111-8111-111111111111", "Basic understanding of databases and SQL."),
      line("b2222222-2222-4222-8222-222222222222", "Knowledge of relational databases (e.g. Postgres)."),
      line("b3333333-3333-4333-8333-333333333333", "Familiarity with cloud platforms."),
      line("b4444444-4444-4444-8444-444444444444", "Experience with Oracle Cloud ERP."),
      line("b5555555-5555-4555-8555-555555555555", "Hands-on PostgreSQL tuning.")
    ] });
    const report = evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["PostgreSQL", "AWS"] });
    const ml = posting({ requirements: [line("b6666666-6666-4666-8666-666666666666", "Experience with ML or LLM fine-tuning.")] });
    expect(outcomeOf(evaluateJobMatch(ml, { ...BASE_INPUTS, resumeSkills: ["QLoRA"] }), "b6666666-6666-4666-8666-666666666666")?.outcome).toBe("PASS");
    const llm = posting({ requirements: [line("b7777777-7777-4777-8777-777777777777", "Experience working with large language models (LLMs).")] });
    expect(outcomeOf(evaluateJobMatch(llm, { ...BASE_INPUTS, resumeSkills: ["QLoRA"] }), "b7777777-7777-4777-8777-777777777777")?.outcome).toBe("PASS");
    expect(outcomeOf(evaluateJobMatch(ml, { ...BASE_INPUTS, resumeSkills: ["Machine Learning"] }), "b6666666-6666-4666-8666-666666666666")?.reason)
      .toBe("Your resume lists Machine Learning (as ML), which this requirement names.");
    expect(outcomeOf(report, "b1111111-1111-4111-8111-111111111111")).toMatchObject({
      outcome: "PASS", reason: "Your resume lists PostgreSQL (as SQL), which this requirement names."
    });
    expect(outcomeOf(report, "b2222222-2222-4222-8222-222222222222")?.outcome).toBe("PASS");
    expect(outcomeOf(report, "b3333333-3333-4333-8333-333333333333")?.outcome).toBe("PASS");
    // "Cloud" counts only as a phrase like "cloud platforms", never a vendor's product.
    expect(outcomeOf(report, "b4444444-4444-4444-8444-444444444444")?.outcome).toBe("UNKNOWN");
    // SQL on a resume never covers PostgreSQL.
    const generalOnly = evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["SQL"] });
    expect(outcomeOf(generalOnly, "b5555555-5555-4555-8555-555555555555")?.outcome).toBe("UNKNOWN");

    const technology = (label: string, key: string) => ({ jobId: BASE_POSTING.id, label, normalizedKey: key, extraction: "DETERMINISTIC" as const, span: span(label) });
    const fit = evaluateJobMatch(posting({ technologies: [technology("SQL", "sql"), technology("Postgres", "postgres")] }), { ...BASE_INPUTS, resumeSkills: ["PostgreSQL"] });
    expect(fit.reasons.find((reason) => reason.factor === "Technology coverage")).toMatchObject({ delta: 100 });
    expect(fit.reasons.some((reason) => reason.factor === "Missing preferred skills")).toBe(false);
  });

  it("reads level lists and field families for a bachelor's candidate, pausing on anything it does not understand", () => {
    const inputs = { ...BASE_INPUTS, candidateDegree: "B.A. Computer Science, CDSS", candidateField: "Computer Science" };
    const passes = [
      "Current enrollment in a Bachelor's, Master's, or PhD program in Computer Science, Electrical Engineering or Computer Engineering from an accredited university.",
      "Currently pursuing a BA/BS, MS, or PhD in Computer Science, Computer Engineering, or a related field.",
      "Pursuing a Bachelor's degree or higher in a quantitative or technical field",
      "Currently pursuing a bachelors or advanced degree (preferably in Mechanical, Electrical, Industrial or Civil Engineering).",
      "Currently pursuing a related technical degree.",
      "Currently pursuing a STEM degree",
      "Current enrollment in a bachelor's degree program"
    ];
    const pauses = [
      "BS, MS or PhD in Electrical Engineering, Computer Science, Computer Engineering (obtained).",
      "Currently enrolled in a full-time Bachelor's degree program",
      "Current sophomore or junior undergraduate students pursuing a bachelor's degree.",
      "You must be a current undergraduate at a US or Canadian university.",
      "Pursuing a Bachelor's or Master's degree in Electrical Engineering, Mechanical Engineering, Physics, or a related technical field.",
      "Currently enrolled in a college degree program in an Information Technology-related major",
      "Current enrollment in a Bachelor's degree program in Software Engineering",
      "Must be pursuing a Bachelor's degree in an applicable major",
      "Must be pursuing a Master's or PhD in computer science.",
      "Must have a 3.0 GPA or higher",
      "High School Diploma required",
      // A graduation window is understood only when the posting's graduation constraint checks it.
      "Undergraduate student pursuing a degree in a STEM-related field, graduating in late 2027 or 2028"
    ];
    for (const text of passes) {
      const report = evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", text, "DEGREE")] }), inputs);
      expect(outcomeOf(report, "c1111111-1111-4111-8111-111111111111")?.outcome, text).toBe("PASS");
    }
    for (const text of pauses) {
      const report = evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", text, "DEGREE")] }), inputs);
      expect(outcomeOf(report, "c1111111-1111-4111-8111-111111111111")?.outcome, text).toBe("UNKNOWN");
    }
    const listed = evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", passes[1]!, "DEGREE")] }), inputs);
    expect(outcomeOf(listed, "c1111111-1111-4111-8111-111111111111")?.reason)
      .toBe("Your degree (B.A. Computer Science, CDSS) meets this requirement: it accepts a bachelor's degree, and it names computer science.");
    const windowed = "Undergraduate student pursuing a degree in a STEM-related field, graduating in late 2027 or 2028";
    const graduation = { earliest: "2027-09-01", latest: "2028-12-31", raw: "graduating in late 2027 or 2028", extraction: "MODEL",
      assertion: "STATED", span: span("graduating in late 2027 or 2028") };
    const checked = evaluateJobMatch(posting({
      requirements: [line("c1111111-1111-4111-8111-111111111111", windowed, "DEGREE")],
      constraints: { graduation, authorization: null, sponsorship: null, availability: null }
    }), inputs);
    expect(outcomeOf(checked, "c1111111-1111-4111-8111-111111111111")?.outcome).toBe("PASS");
    // "Full-time" is understood only once the candidate has answered it.
    const fullTimeLine = posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", "Currently enrolled in a full-time Bachelor's degree program", "DEGREE")] });
    const unanswered = outcomeOf(evaluateJobMatch(fullTimeLine, inputs), "c1111111-1111-4111-8111-111111111111");
    expect(unanswered).toMatchObject({ outcome: "UNKNOWN" });
    expect(unanswered?.reason).toContain("Are you a full-time student?");
    const fullTimeFact = fact("enrolled_full_time", { kind: "global" }, true);
    expect(outcomeOf(evaluateJobMatch(fullTimeLine, { ...inputs, facts: [fullTimeFact] }), "c1111111-1111-4111-8111-111111111111")).toMatchObject({
      outcome: "PASS",
      reason: "Your degree (B.A. Computer Science, CDSS) meets this requirement: it accepts a bachelor's degree, and you are enrolled full-time."
    });
    const partTime = outcomeOf(evaluateJobMatch(fullTimeLine, { ...inputs, facts: [{ ...fullTimeFact, value: false }] }), "c1111111-1111-4111-8111-111111111111");
    expect(partTime?.outcome).toBe("UNKNOWN");
    expect(partTime?.reason).not.toContain("Are you a full-time student?");
    // A B.S. and a B.A. are different degrees: a line naming only one kind pauses for the other.
    const scienceOnly = "Current enrollment in a Bachelor of Science (BS), Master of Science (MS), or PhD program in Computer Science.";
    const mismatch = outcomeOf(evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", scienceOnly, "DEGREE")] }), inputs), "c1111111-1111-4111-8111-111111111111");
    expect(mismatch).toMatchObject({
      outcome: "UNKNOWN",
      reason: "The posting names a B.S., and your degree is a B.A.; they are different degrees, so this needs your review."
    });
    for (const text of [scienceOnly, "Currently pursuing a B.S. in Computer Science.", "BSc in Computer Science"]) {
      const report = evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", text, "DEGREE")] }), { ...inputs, candidateDegree: "B.S. Computer Science" });
      expect(outcomeOf(report, "c1111111-1111-4111-8111-111111111111")?.outcome, text).toBe("PASS");
    }
    // The graduate-only exclusion reads the same level lists, whatever the bachelor's kind.
    const enabled = { ...inputs, preferences: { ...PREFERENCES, excludeGraduateOnlyInternships: true } };
    expect(evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", scienceOnly, "DEGREE")] }), enabled).verdict).not.toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ requirements: [line("c1111111-1111-4111-8111-111111111111", passes[0]!, "DEGREE")] }), enabled).verdict).toBe("QUALIFIED");
  });
});

describe("non-discriminating soft requirements", () => {
  const line = (id: string, text: string, subject: "SKILL" | "EXPERIENCE" = "SKILL") => ({
    id, jobId: BASE_POSTING.id, text, category: "HARD" as const, subject, extraction: "MODEL" as const,
    assertion: "STATED" as const, confidence: 0.9, span: span(text)
  });
  const outcomeOf = (report: ReturnType<typeof evaluateJobMatch>, id: string) =>
    report.findings.find((finding) => finding.requirementId === id);
  const POLICY = "Non-discriminating requirement; generic traits carry no hiring signal, so this passes by policy.";

  it("passes pure soft wording by policy instead of pausing", () => {
    const fluff = [
      "Strong written and verbal communication skills",
      "Excellent communication skills.",
      "A team player",
      "Strong analytical and problem-solving skills.",
      "Eagerness to learn in a fast-paced environment",
      "Self-starter with strong attention to detail"
    ];
    const role = posting({ requirements: fluff.map((text, index) =>
      line(`c1111111-1111-4111-8111-11111111111${index}`, text)) });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("QUALIFIED");
    for (const finding of report.findings.filter((entry) => entry.requirementId !== null)) {
      expect(finding).toMatchObject({ outcome: "PASS", reason: POLICY });
    }
  });

  it("keeps mixed, technical, and tenure wording on the evidence path", () => {
    const role = posting({ requirements: [
      line("c2222222-2222-4222-8222-222222222222", "Strong analytical skills with Python."),
      line("c3333333-3333-4333-8333-333333333333", "Excellent communication skills and Tableau experience."),
      line("c4444444-4444-4444-8444-444444444444", "Strong verbal skills and a 3.0 GPA."),
      line("c5555555-5555-4555-8555-555555555555", "Proficient in Microsoft Excel."),
      line("c6666666-6666-4666-8666-666666666666", "No more than 2 years of professional experience.", "EXPERIENCE")
    ] });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("NEEDS_REVIEW");
    for (const finding of report.findings.filter((entry) => entry.requirementId !== null)) {
      expect(finding.outcome).toBe("UNKNOWN");
    }
  });

  it("passes non-tenure experience fluff by policy", () => {
    const role = posting({ requirements: [
      line("c8888888-8888-4888-8888-888888888888", "Prior experience working in a fast-paced environment.", "EXPERIENCE"),
      line("c9999999-9999-4999-8999-999999999999", "Demonstrated analytical project experience is expected.", "EXPERIENCE")
    ] });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("QUALIFIED");
    for (const finding of report.findings.filter((entry) => entry.requirementId !== null)) {
      expect(finding).toMatchObject({ outcome: "PASS", reason: POLICY });
    }
  });

  it("passes plural and verb forms of soft traits, not just dictionary forms", () => {
    const fluff = [
      "Good written and oral communications skills",
      "Excellent communication and collaboration skills",
      "Self-motivated and able to work independently",
      "Strong organizational skills",
      "Adaptable and flexible team member",
      "Demonstrated leadership qualities",
      "Ability to work well in a team",
      "Ability to analyze a problem and present a plan",
      "Professional demeanor and positive attitude",
      "Builds effective peer relationships"
    ];
    const role = posting({ requirements: fluff.map((text, index) =>
      line(`d${index}111111-1111-4111-8111-111111111111`, text)) });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("QUALIFIED");
    for (const finding of report.findings.filter((entry) => entry.requirementId !== null)) {
      expect(finding).toMatchObject({ outcome: "PASS", reason: POLICY });
    }
  });

  it("keeps new stem forms on the evidence path when concrete content joins them", () => {
    const role = posting({ requirements: [
      line("d9999999-9999-4999-8999-999999999999", "Collaborative Python development with the team."),
      line("daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", "Motivated analyst with Tableau experience.")
    ] });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("NEEDS_REVIEW");
    for (const finding of report.findings.filter((entry) => entry.requirementId !== null)) {
      expect(finding.outcome).toBe("UNKNOWN");
    }
  });

  it("keeps digit-free tenure spans paused", () => {
    const role = posting({ requirements: [
      line("caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Several years of experience working in a team.", "EXPERIENCE")
    ] });
    const report = evaluateJobMatch(role, BASE_INPUTS);
    expect(report.verdict).toBe("NEEDS_REVIEW");
    expect(outcomeOf(report, "caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?.outcome).toBe("UNKNOWN");
  });

  it("prefers a specific resume match over the policy pass", () => {
    const role = posting({ requirements: [
      line("c7777777-7777-4777-8777-777777777777", "Basic understanding of databases and SQL.")
    ] });
    const report = evaluateJobMatch(role, { ...BASE_INPUTS, resumeSkills: ["PostgreSQL"] });
    expect(outcomeOf(report, "c7777777-7777-4777-8777-777777777777")).toMatchObject({
      outcome: "PASS", reason: "Your resume lists PostgreSQL (as SQL), which this requirement names."
    });
  });
});

describe("school-specific postings", () => {
  const inputs = { ...BASE_INPUTS, candidateSchool: "UC Berkeley" };

  it("fails a posting stated to be for another school's students and passes the candidate's own", () => {
    const mit = evaluateJobMatch(posting({ title: "MIT- Software Engineer Intern | Helios" }), inputs);
    expect(mit.verdict).toBe("NOT_QUALIFIED");
    expect(mit.findings.find((finding) => finding.subject === "school")).toMatchObject({
      outcome: "FAIL",
      reason: "The posting is for MIT students only, and your school is UC Berkeley.",
      statedExcerpt: "MIT- Software Engineer Intern | Helios"
    });
    const openOnly = posting({ snapshot: { ...BASE_POSTING.snapshot, normalizedText: "This role is open only to students at Stanford University." } });
    expect(evaluateJobMatch(openOnly, inputs).verdict).toBe("NOT_QUALIFIED");
    expect(evaluateJobMatch(posting({ title: "Software Engineer Intern (UC Berkeley students only)" }), inputs).verdict).toBe("QUALIFIED");
    expect(evaluateJobMatch(posting({ title: "Berkeley - Software Engineer Intern" }), inputs).findings
      .find((finding) => finding.subject === "school")?.outcome).toBe("PASS");
    expect(evaluateJobMatch(posting({ title: "MIT- Software Engineer Intern" }), BASE_INPUTS).verdict).toBe("NEEDS_REVIEW");
  });

  it("never reads a place, a company, or a passing mention as a school restriction", () => {
    for (const title of ["Software Intern - Columbia, MD", "Duke Energy - Software Intern", "Stanford Health Care - IT Intern", "Intern, Commit Tools"]) {
      expect(evaluateJobMatch(posting({ title }), inputs).findings.some((finding) => finding.subject === "school"), title).toBe(false);
    }
    const mention = posting({ snapshot: { ...BASE_POSTING.snapshot, normalizedText: "Our founders met at MIT. Open to students at all universities." } });
    expect(evaluateJobMatch(mention, inputs).findings.some((finding) => finding.subject === "school")).toBe(false);
  });
});

describe("relocation recorded per country", () => {
  function locationPosting(raw: string, city: string, countryCode: string) {
    const excerpt = `This role is on-site in ${raw}; you must work from that office.`;
    return posting({
      locations: [{ jobId: BASE_POSTING.id, raw, city, region: null, countryCode, workMode: "ONSITE", span: span(raw) }],
      requirements: [{
        id: "77777777-7777-4777-8777-777777777771",
        jobId: BASE_POSTING.id,
        text: excerpt,
        category: "HARD",
        subject: "LOCATION",
        extraction: "DETERMINISTIC",
        assertion: "STATED",
        confidence: 0.9,
        span: span(excerpt)
      }]
    });
  }
  const inputs = { ...BASE_INPUTS, facts: [fact("willing_to_relocate", { kind: "country", code: "US" }, true)] };
  const locationOutcome = (target: JobPosting) =>
    evaluateJobMatch(target, inputs).findings.find((finding) => finding.subject === "LOCATION")?.outcome;

  it("passes a hard location in the country the candidate would relocate within, and leaves another country unknown", () => {
    expect(locationOutcome(locationPosting("Austin, TX", "Austin", "US"))).toBe("PASS");
    expect(locationOutcome(locationPosting("Toronto, ON", "Toronto", "CA"))).toBe("UNKNOWN");
  });
});
