import { describe, expect, it } from "vitest";

import {
  combineTargetDecisions,
  fitSkipLine,
  judgeFit,
  judgeLocation,
  judgePay,
  judgeRole,
  judgeSource,
  judgeTargetPosting,
  judgeTerm,
  parseTargetTerm,
  type SemanticFitAssessment
} from "@internship-agent/domain";

const summer = { season: "summer", year: 2027 } as const;
const intern = (title: string, text = "We build software. The internship includes mentorship.", employmentType: "INTERNSHIP" | "CO_OP" = "INTERNSHIP") =>
  ({ title, text, employmentType });

describe("target term", () => {
  it("parses season-year terms only", () => {
    expect(parseTargetTerm("summer-2027")).toEqual(summer);
    expect(parseTargetTerm(" Summer-2027 ")).toEqual(summer);
    for (const invalid of [undefined, "", "summer", "2027", "summer-27", "july-2027"]) expect(parseTargetTerm(invalid)).toBeNull();
  });

  // Titles from the 2026-11-17 audit of the real workspace (all scored 80+ by the AI).
  it.each([
    "Software Developer Intern (January to June 2027)",
    "Embedded Software Engineering Intern (January 2027) (4 months)",
    "Spring 2027 Systems Engineering - Cloud Technologies Co-Op (January - June)",
    "Winter 2027 Software Engineer Co-op",
    "Fullstack Engineering Internship, Product Team (Fall 2026 & Winter 2027)",
    "Strategic Sourcing & Procurement AI Intern (6 months)",
    "AI Analyst - Placement year internship",
    "Software Development Co-op (Later Influence)",
    "Software Developer (Full Stack) Intern (Spring 2027)",
    "Software Engineering Intern - Summer 2026"
  ])("skips the off-cycle title %s", (title) => {
    expect(judgeTerm(intern(title), summer).outcome).toBe("skip");
  });

  it.each([
    "Software Engineer Intern (Summer 2027)",
    "Summer '27 Software Engineering Intern",
    "Software Engineering Intern"
  ])("accepts %s", (title) => {
    expect(judgeTerm(intern(title), summer).outcome).toBe("apply");
  });

  it("reads the description when the title is silent", () => {
    expect(judgeTerm(intern("Software Engineering Intern", "This 12-week summer internship starts in June."), summer).outcome).toBe("apply");
    expect(judgeTerm(intern("Software Engineering Intern", "The internship runs for the Fall 2026 semester."), summer).outcome).toBe("skip");
    expect(judgeTerm(intern("Software Engineering Intern", "A six-month placement with our team."), summer).outcome).toBe("skip");
    expect(judgeTerm(intern("Software Engineering Intern", "Openings for summer or the Spring 2027 term."), summer).outcome).toBe("review");
    expect(judgeTerm(intern("Software Engineering Intern", "Text", "CO_OP"), summer).outcome).toBe("skip");
    expect(judgeTerm(intern("Summer 2027 Software Co-op", "Text", "CO_OP"), summer).outcome).toBe("review");
    expect(judgeTerm(intern("Software Engineering Intern [Spring/Summer 2027]"), summer).outcome).toBe("review");
    expect(judgeTerm(intern("Software Engineering Co-op (Spring/Summer 2027)"), summer).outcome).toBe("review");
    expect(judgeTerm(intern("Software Engineer Intern (H1 2027)"), summer).outcome).toBe("skip");
  });
});

describe("software or adjacent role", () => {
  it.each([
    "Software Engineer Intern (Summer 2027)", "Intern - Analytics Web Systems Developer", "Data Engineering Intern",
    "Software Engineer (Machine Learning) Intern", "AI/SWE Intern", "Site Reliability Engineering Intern",
    "Security Engineer Intern", "Quant Developer Intern", "Humana Technology Internship – Summer 2027",
    "Data Scientist Intern", "Salesforce Developer Intern", "Forward Deployed Engineer Intern", "Member of Technical Staff, Intern"
  ])("pursues %s", (title) => {
    expect(judgeRole(title).outcome).toBe("apply");
  });

  it.each([
    "Internship Product Data Analyst F/M", "Product Manager Co-op (Spring 2027)", "Quantitative Research Analyst Internship",
    "Summer Intern - Quantitative Risk Management", "R&D PhD Summer Intern - AI Research Engineer", "Mechanical Engineering Intern",
    "Intern- AI Business Operations-Nashville, TN-Summer", "Marketing Intern", "UX Design Intern", "Strategic Sourcing & Procurement AI Intern",
    "Research Scientist Intern", "Hardware Engineering Intern", "AI Analyst - Placement year internship", "Finance Intern", "Intern - IT, Enterprise Data & AI Administration"
  ])("skips %s", (title) => {
    expect(judgeRole(title).outcome).toBe("skip");
  });
});

describe("location", () => {
  it("passes a stated US location, skips another country, and holds silence", () => {
    expect(judgeLocation(["US"]).outcome).toBe("apply");
    expect(judgeLocation(["SG", "US"]).outcome).toBe("apply");
    expect(judgeLocation(["FR"]).outcome).toBe("skip");
    expect(judgeLocation(["CA", "CA"]).reasons[0]).toBe("Location: CA, not the United States.");
    expect(judgeLocation([]).outcome).toBe("review");
  });

  it("combines the text steps with the strictest outcome", () => {
    const decision = judgeTargetPosting({ title: "Software Engineer Intern (Summer 2027)", text: "Text", employmentType: "INTERNSHIP", countryCodes: [], onHandshake: false }, summer);
    expect(decision.outcome).toBe("review");
    expect(combineTargetDecisions({ outcome: "review", reasons: ["a"] }, { outcome: "skip", reasons: ["b"] }, { outcome: "apply", reasons: [] }))
      .toEqual({ outcome: "skip", reasons: ["a", "b"] });
  });
});

describe("source", () => {
  it("skips Handshake postings, even an otherwise on-target one", () => {
    expect(judgeSource(false)).toEqual({ outcome: "apply", reasons: [] });
    expect(judgeSource(true)).toEqual({ outcome: "skip", reasons: ["Source: Handshake is out of scope (GitHub lists only)."] });
    const posting = { title: "Software Engineer Intern (Summer 2027)", text: "Text", employmentType: "INTERNSHIP" as const, countryCodes: ["US"] };
    expect(judgeTargetPosting({ ...posting, onHandshake: false }, summer)).toEqual({ outcome: "apply", reasons: [] });
    expect(judgeTargetPosting({ ...posting, onHandshake: true }, summer))
      .toEqual({ outcome: "skip", reasons: ["Source: Handshake is out of scope (GitHub lists only)."] });
  });
});

describe("pay", () => {
  // The candidate's rule (2026-11-24): "unpaid inter ships should be ruled out". Fictional postings.
  const unpaid = { outcome: "skip", reasons: ["Pay: the posting says the internship is unpaid."] };
  const pass = { outcome: "apply", reasons: [] };
  const body = (text: string, compensation: Parameters<typeof judgePay>[0]["compensation"] = null) =>
    judgePay({ title: "Software Engineering Intern", text, compensation });
  const hourly = { minimum: 25, maximum: 32, period: "HOUR" } as const;

  it.each([
    "Lakeshore Rides — Software Engineering Internship (UNPAID)",
    "Software Engineering Intern [Unpaid]",
    "Unpaid Software Engineering Intern",
    "Software Developer Internship - Unpaid",
    "Web Developer Intern (Volunteer)"
  ])("skips the unpaid title %s", (title) => {
    expect(judgePay({ title, text: "We build software.", compensation: null })).toEqual(unpaid);
  });

  it.each([
    "This is an unpaid internship for students interested in web development.",
    "The internship is unpaid and offers academic credit.",
    "This position is unpaid.",
    "Join us for an unpaid summer internship building our booking app.",
    "No compensation will be provided for this internship.",
    "There is no compensation for this internship.",
    "This is a volunteer position supporting our engineering team.",
    "Internship (unpaid), 10 hours per week."
  ])("skips the unpaid description %s", (text) => {
    expect(body(text)).toEqual(unpaid);
  });

  it("skips an extracted pay of exactly zero", () => {
    expect(body("Pay: $0 per hour.", { minimum: 0, maximum: null, period: "HOUR" }))
      .toEqual({ outcome: "skip", reasons: ["Pay: the posting states zero pay."] });
    expect(body("Pay: $0 - $0 per hour.", { minimum: 0, maximum: 0, period: "HOUR" }).outcome).toBe("skip");
  });

  it.each([
    "We build software. The internship includes mentorship.",
    "This is a paid internship.",
    "Interns receive a competitive stipend.",
    "The hourly pay for this internship is $28 to $34.",
    "You will automate the reconciliation of unpaid invoices.",
    "Build dashboards that track unpaid balances for our finance team.",
    "We offer both paid and unpaid internships across departments.",
    "This role may be a paid or unpaid internship depending on the team.",
    "This is not an unpaid internship.",
    "We never offer unpaid internships.",
    "There is no compensation for travel; the role is remote.",
    "No compensation decisions are based on protected characteristics.",
    "Employees enjoy paid volunteer opportunities.",
    "Volunteer work counts as experience."
  ])("passes %s", (text) => {
    expect(body(text)).toEqual(pass);
  });

  it.each([
    "Accounts Receivable Software Intern - Unpaid Invoices Automation",
    "Software Engineering Intern (Paid or Unpaid)",
    "Software Engineering Intern (Paid)",
    "Volunteer Management Systems Software Intern"
  ])("passes the title %s", (title) => {
    expect(judgePay({ title, text: "We build software.", compensation: null })).toEqual(pass);
  });

  it("passes stated pay and silence, and holds a description that says unpaid beside a positive figure", () => {
    expect(body("The hourly pay is $25 to $32.", hourly)).toEqual(pass);
    expect(body("Interns receive a stipend.", { minimum: null, maximum: null, period: "STIPEND" })).toEqual(pass);
    expect(body("This is an unpaid internship. No stipend is provided.", { minimum: null, maximum: null, period: "STIPEND" })).toEqual(unpaid);
    expect(body("This is an unpaid internship. Travel is reimbursed at $25 per hour.", hourly))
      .toEqual({ outcome: "review", reasons: ["Pay: the description calls the internship unpaid but also states pay."] });
  });

  it("rules an unpaid posting out of the combined target decision, alone among the reasons", () => {
    const posting = { text: "We build software.", employmentType: "INTERNSHIP" as const, countryCodes: ["US"], onHandshake: false };
    expect(judgeTargetPosting({ ...posting, title: "Software Engineering Intern (UNPAID)" }, summer)).toEqual(unpaid);
    expect(judgeTargetPosting({ ...posting, title: "Software Engineering Intern", text: "This is an unpaid internship." }, summer)).toEqual(unpaid);
    expect(judgeTargetPosting({ ...posting, title: "Software Engineering Intern", compensation: { minimum: 0, maximum: 0, period: "HOUR" } }, summer))
      .toEqual({ outcome: "skip", reasons: ["Pay: the posting states zero pay."] });
    expect(judgeTargetPosting({ ...posting, title: "Software Engineering Intern", compensation: hourly }, summer)).toEqual(pass);
  });
});

describe("AI judgment", () => {
  const assessment = (overrides: Partial<Extract<SemanticFitAssessment, { version: 2 }>> = {}): SemanticFitAssessment => ({
    score: 86, rating: "STRONG", confidence: "MEDIUM", summary: "Strong.", strengths: [], gaps: [], unknowns: ["Applicant pool."],
    decisions: [], unknownCount: 1, model: "test", evaluatedAt: "2026-11-17T00:00:00.000Z", version: 2, ...overrides
  });

  it("applies on a current, confident judgment at or above the bar", () => {
    expect(judgeFit(assessment(), 80).outcome).toBe("apply");
    expect(judgeFit(null, 80)).toEqual({ outcome: "review", reasons: ["Fit: no current AI judgment."] });
    expect(judgeFit(assessment({ score: 78, rating: "STRONG" }), 80).outcome).toBe("review");
    expect(judgeFit(assessment({ score: 70, rating: "MODERATE" }), 60).outcome).toBe("apply");
    expect(judgeFit(assessment({ confidence: "LOW" }), 80).outcome).toBe("review");
    expect(judgeFit(assessment({ score: 55, rating: "MODERATE" }), 80).outcome).toBe("review");
    expect(judgeFit(assessment({ score: 0, rating: "INSUFFICIENT_INFORMATION", confidence: "LOW" }), 80).outcome).toBe("review");
  });

  it("judges against the bar of 50 and skips below the skip line", () => {
    const moderate = (score: number, overrides: Partial<Extract<SemanticFitAssessment, { version: 2 }>> = {}) =>
      assessment({ score, rating: "MODERATE", confidence: "MEDIUM", ...overrides });
    expect(judgeFit(moderate(49), 50)).toEqual({ outcome: "skip", reasons: ["Fit: AI score 49 (moderate) is below the skip line of 50."] });
    expect(judgeFit(moderate(50), 50)).toEqual({ outcome: "apply", reasons: [] });
    expect(judgeFit(moderate(74), 50)).toEqual({ outcome: "apply", reasons: [] });
    expect(judgeFit(assessment({ score: 80, rating: "STRONG", confidence: "MEDIUM" }), 50)).toEqual({ outcome: "apply", reasons: [] });
    const low = judgeFit(moderate(70, { confidence: "LOW" }), 50);
    expect(low.outcome).toBe("review");
    expect(low.reasons).toContain("Fit: the AI's confidence is low.");
    expect(judgeFit(assessment({ score: 0, rating: "INSUFFICIENT_INFORMATION", confidence: "LOW" }), 50))
      .toEqual({ outcome: "review", reasons: ["Fit: the AI had too little to judge."] });
    const gap = { text: "Not demonstrated as a current master's student.", postingQuote: "pursuing a master's degree", citations: [] };
    const levelGap = judgeFit(moderate(60, { gaps: [gap] }), 50);
    expect(levelGap.outcome).toBe("review");
    expect(levelGap.reasons[0]).toContain("degree-level gap");
    expect(judgeFit(moderate(60), 80)).toEqual({ outcome: "review", reasons: ["Fit: AI score 60 is below 80."] });
    expect(judgeFit(moderate(45), 40)).toEqual({ outcome: "apply", reasons: [] });
    expect(judgeFit(assessment({ score: 39, rating: "WEAK", confidence: "MEDIUM" }), 40).outcome).toBe("skip");
  });

  it("puts the skip line at 50, following a lower bar down to 40", () => {
    expect(fitSkipLine(50)).toBe(50);
    expect(fitSkipLine(80)).toBe(50);
    expect(fitSkipLine(40)).toBe(40);
    expect(fitSkipLine(0)).toBe(40);
  });

  it("holds a strong score whose gaps name a degree-level mismatch", () => {
    // Example Analytics (2026-11-17): the AI flagged the master's requirement the hard check missed.
    const gap = { text: "Not demonstrated as a current master's student in the listed quantitative fields.", postingQuote: "pursuing a master's degree", citations: [] };
    const decision = judgeFit(assessment({ gaps: [gap] }), 80);
    expect(decision.outcome).toBe("review");
    expect(decision.reasons[0]).toContain("degree-level gap");
  });
});
