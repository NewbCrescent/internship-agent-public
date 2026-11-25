import { describe, expect, it } from "vitest";

import { classifyStandingStatement, standingStatementDecision } from "@internship-agent/domain";

/**
 * Terms consent under the standing data-consent setting (the candidate's
 * decision, 2026-11-24). Fictional statements; Fixture Robotics is not a real
 * employer.
 */
const DATA_ONLY = { acceptDataConsent: true, signAttestations: false };
const ATTESTATIONS_ONLY = { acceptDataConsent: false, signAttestations: true };
const NONE = { acceptDataConsent: false, signAttestations: false };
const BOTH = { acceptDataConsent: true, signAttestations: true };

describe("terms and conditions or terms of use accepted as a condition of applying", () => {
  const accepted: Array<[string, string[]]> = [
    ["I agree with the terms and conditions", ["terms-of-use"]],
    ["By checking this box, I accept the Terms of Use of this career site", ["terms-of-use"]],
    ["I have read, understood, and agree to the Fixture Robotics Terms & Conditions", ["terms-of-use"]],
    ["Personal Data: I have read and accept the Fixture Robotics Terms and Conditions and Privacy Policy", ["privacy-policy", "terms-of-use"]],
    ["Terms of Use and Privacy Notice: I agree and consent", ["terms-of-use", "privacy-policy"]],
    ["Data Privacy Consent: I agree", ["privacy-policy"]],
    ["Personal Data Processing: I consent", ["data-processing"]]
  ];

  it.each(accepted)("accepts %s under the data-consent setting", (statement, groups) => {
    const decision = standingStatementDecision(statement, DATA_ONLY);
    expect(decision).toEqual({ verdict: "accept", setting: "accept_data_consent", groups });
  });

  it.each(accepted)("waits for the setting on %s", (statement, groups) => {
    expect(standingStatementDecision(statement, NONE)).toEqual({ verdict: "needs-setting", groups });
    expect(standingStatementDecision(statement, ATTESTATIONS_ONLY)).toEqual({ verdict: "needs-setting", groups });
  });

  it("never accepts terms bundled with marketing, texts, job alerts, or a newsletter", () => {
    for (const statement of [
      "I agree to the Terms and Conditions and to receive marketing emails and job alerts",
      "I accept the Terms of Use and agree to receive text messages about new openings",
      "Newsletter: I agree",
      "Job alerts: I agree and consent"
    ]) {
      expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "marketing" });
    }
  });

  it("never accepts terms bundled with a statement of fact", () => {
    expect(standingStatementDecision("I agree to the terms and conditions and confirm that I am authorized to work in the United States", BOTH))
      .toEqual({ verdict: "fact" });
    expect(standingStatementDecision("I accept the Terms of Use and certify that I am a U.S. citizen", BOTH)).toEqual({ verdict: "fact" });
  });

  it("leaves a bare agreement, employment terms, and clipped labels alone", () => {
    expect(standingStatementDecision("I agree and consent", BOTH)).toEqual({ verdict: "none" });
    expect(standingStatementDecision("I agree to the terms and conditions of employment", BOTH)).toEqual({ verdict: "none" });
    expect(standingStatementDecision("I accept the terms of the offer", BOTH)).toEqual({ verdict: "none" });
    expect(standingStatementDecision("I agree to the Terms of Use of the Fixture Robotics career site and the related …", BOTH)).toEqual({ verdict: "none" });
    expect(standingStatementDecision("Work Schedule: I agree", BOTH)).toEqual({ verdict: "none" });
  });

  it("classifies the heading form only for a bare agreement after the heading", () => {
    expect(classifyStandingStatement("Terms of Use: I agree").groups).toEqual(["terms-of-use"]);
    expect(classifyStandingStatement("Terms of Use: please read them carefully").groups).toEqual([]);
  });
});

describe("terms never ride on text consent", () => {
  const texting = [
    "By checking this box I agree to the Terms of Use and consent to texting about my application.",
    "I agree to the Terms of Use and to receive texts about new job openings."
  ];

  it.each(texting)("keeps %s out of the terms group, and never accepts it", (statement) => {
    expect(classifyStandingStatement(statement).groups).not.toContain("terms-of-use");
    expect(standingStatementDecision(statement, DATA_ONLY).verdict).not.toBe("accept");
    expect(standingStatementDecision(statement, BOTH).verdict).not.toBe("accept");
  });

  it("never accepts terms bundled with SMS about the application", () => {
    expect(standingStatementDecision("I accept the Terms and Conditions and agree to receive SMS about my application", DATA_ONLY).verdict).not.toBe("accept");
  });
});
