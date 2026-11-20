import { describe, expect, it } from "vitest";

import { compareFocus, DEFAULT_REVIEW_FOCUS, inFocus, reviewFocusSchema, type FocusCandidate } from "@internship-agent/domain";

const now = Date.parse("2026-10-13T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const entry = (overrides: Partial<FocusCandidate>): FocusCandidate => ({
  jobId: "job", title: "Software Engineering Intern", countryCodes: ["US"], postedAt: daysAgo(1), hourlyUsdPay: null, fitScore: null, ...overrides
});

describe("review focus settings", () => {
  it("always keeps software engineering and normalizes countries", () => {
    expect(reviewFocusSchema.parse({ ...DEFAULT_REVIEW_FOCUS, categories: ["Data and AI"], countries: ["us", "US", "ca"] }))
      .toMatchObject({ categories: ["Software engineering", "Data and AI"], countries: ["US", "CA"] });
    expect(reviewFocusSchema.safeParse({ ...DEFAULT_REVIEW_FOCUS, categories: ["Astronaut"] }).success).toBe(false);
    expect(reviewFocusSchema.safeParse({ ...DEFAULT_REVIEW_FOCUS, postedWithinDays: 0 }).success).toBe(false);
  });
});

describe("what the focus view shows", () => {
  const focus = { ...DEFAULT_REVIEW_FOCUS, minHourlyPay: 40 };

  it("keeps focused categories, countries, and recent postings", () => {
    expect(inFocus(entry({}), focus, now)).toBe(true);
    expect(inFocus(entry({ title: "Machine Learning Intern" }), focus, now)).toBe(true);
    expect(inFocus(entry({ title: "Quantitative Trading Intern" }), focus, now)).toBe(false);
    expect(inFocus(entry({ countryCodes: ["SG"] }), focus, now)).toBe(false);
    expect(inFocus(entry({ countryCodes: ["SG", "US"] }), focus, now)).toBe(true);
    expect(inFocus(entry({ postedAt: daysAgo(14) }), focus, now)).toBe(true);
    expect(inFocus(entry({ postedAt: daysAgo(15) }), focus, now)).toBe(false);
  });

  it("never hides a posting for what it does not say, unless told to", () => {
    expect(inFocus(entry({ postedAt: null }), focus, now)).toBe(true);
    expect(inFocus(entry({ countryCodes: [] }), focus, now)).toBe(true);
    expect(inFocus(entry({ countryCodes: [] }), { ...focus, includeUnstatedCountry: false }, now)).toBe(false);
    expect(inFocus(entry({ hourlyUsdPay: null }), focus, now)).toBe(true);
    expect(inFocus(entry({ hourlyUsdPay: 39.99 }), focus, now)).toBe(false);
    expect(inFocus(entry({ hourlyUsdPay: 40 }), focus, now)).toBe(true);
  });

  it("ranks by AI fit, then pay, then the newer posting", () => {
    const ranked = [
      entry({ jobId: "unscored-rich", fitScore: null, hourlyUsdPay: 90 }),
      entry({ jobId: "fit-80-low-pay", fitScore: 80, hourlyUsdPay: 30 }),
      entry({ jobId: "fit-80-high-pay", fitScore: 80, hourlyUsdPay: 60 }),
      entry({ jobId: "fit-80-no-pay-newer", fitScore: 80, postedAt: daysAgo(1) }),
      entry({ jobId: "fit-80-no-pay-older", fitScore: 80, postedAt: daysAgo(5) }),
      entry({ jobId: "fit-95", fitScore: 95 })
    ].sort(compareFocus).map((candidate) => candidate.jobId);
    expect(ranked).toEqual(["fit-95", "fit-80-high-pay", "fit-80-low-pay", "fit-80-no-pay-newer", "fit-80-no-pay-older", "unscored-rich"]);
  });
});
