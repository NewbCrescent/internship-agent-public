import { describe, expect, it } from "vitest";

import { APPLICATION_INTENT_EXAMPLE, applicationIntentStatementSchema, termStanding } from "@internship-agent/domain";

const summer = { season: "summer", year: 2027 } as const;

describe("term standing", () => {
  it("counts the school years left after a summer internship", () => {
    const senior = termStanding("2028-05-15", summer);
    expect(senior).toContain("1 school year left");
    expect(senior).toContain("rising senior");
    const junior = termStanding("2029-05-15", summer);
    expect(junior).toContain("2 school years");
    expect(junior).toContain("rising junior");
    expect(termStanding("2027-12-15", summer)).toContain("1 school year left");
    expect(termStanding("2027-05-15", summer)).toContain("graduated");
  });

  it("states the graduation for other terms and gives up on an unreadable date", () => {
    expect(termStanding("2028-05-15", { season: "fall", year: 2027 })).toMatch(/^Expected graduation May 2028/);
    expect(termStanding("not-a-date", summer)).toBeNull();
  });
});

describe("application intent statement", () => {
  it("is trimmed, not empty, and at most 2,000 characters", () => {
    expect(applicationIntentStatementSchema.parse("  Summer internships.  ")).toBe("Summer internships.");
    expect(applicationIntentStatementSchema.safeParse("").success).toBe(false);
    expect(applicationIntentStatementSchema.safeParse("   ").success).toBe(false);
    expect(applicationIntentStatementSchema.safeParse("x".repeat(2001)).success).toBe(false);
    expect(applicationIntentStatementSchema.safeParse("x".repeat(2000)).success).toBe(true);
    expect(applicationIntentStatementSchema.parse(APPLICATION_INTENT_EXAMPLE)).toBe(APPLICATION_INTENT_EXAMPLE);
  });
});
