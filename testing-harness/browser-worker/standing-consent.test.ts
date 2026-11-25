import { describe, expect, it } from "vitest";

import type { BrowserField, RecognizedForm } from "@internship-agent/domain";
import {
  applicationWallKind,
  applicationWallReason,
  chooseResidenceOption,
  CONSENT_QUESTION,
  icimsHostOf,
  MARKETING_QUESTION,
  planAutofill,
  SIGNATURE_QUESTION,
  TEXT_MESSAGE_QUESTION,
  type FieldResolution,
  type StandingInputs
} from "@internship-agent/browser";

/** Fictional labels and names; Fixture Robotics is not a real employer. */
const VARIANT_ID = "11111111-1111-4111-8111-111111111111";
const CLO = "Fixture Robotics has my consent to retain my data for the purpose of considering me for employment and for up to 3 years thereafter.";
const DATA_ON: StandingInputs = { acceptDataConsent: true, signAttestations: false };
const ATTEST_ON: StandingInputs = { acceptDataConsent: false, signAttestations: true, signatureName: "Jordan Rivera", today: "2026-11-20" };
const BOTH_ON: StandingInputs = { acceptDataConsent: true, signAttestations: true, signatureName: "Jordan Rivera", today: "2026-11-20" };
const ALL_OFF: StandingInputs = { acceptDataConsent: false, signAttestations: false };

const box = (id: string, label: string, required = true): BrowserField => ({ id, label, kind: "checkbox", required });
const text = (id: string, label: string, required = true): BrowserField => ({ id, label, kind: "text", required });
const form = (...fields: BrowserField[]): RecognizedForm => ({ url: "https://careers.fixturerobotics.com/jobs/1003/apply", title: "Apply", fields });
const plan = (shape: RecognizedForm, standing?: StandingInputs, resolutions: Map<string, FieldResolution> = new Map()) =>
  planAutofill(shape, { profile: { fullName: "Jordan Rivera" }, resolutions, packageAnswers: [], variantId: VARIANT_ID, standing });
const decisionOf = (shape: RecognizedForm, id: string, standing?: StandingInputs, resolutions?: Map<string, FieldResolution>) =>
  plan(shape, standing, resolutions).decisions.find((decision) => decision.fieldId === id)!;

describe("standing data consent in the planner", () => {
  it("checks a CLO-style data-retention box under the data-consent setting, with its basis", () => {
    const decision = decisionOf(form(box("retain", CLO)), "retain", DATA_ON);
    expect(decision).toMatchObject({ action: "check", value: "true", basis: { kind: "standing_consent", setting: "accept_data_consent", group: "data-retention", statement: CLO } });
  });

  it("pauses the same box without the setting, as today", () => {
    for (const standing of [undefined, ALL_OFF, ATTEST_ON]) {
      const result = plan(form(box("retain", CLO)), standing);
      expect(result.decisions[0]).toMatchObject({ action: "pause", pause: { question: CONSENT_QUESTION } });
      expect(result.pauses.map((pause) => pause.fieldId)).toEqual(["retain"]);
    }
  });

  it("chooses Yes on a privacy-policy list under the setting, and leaves it to the usual rules without", () => {
    const list: BrowserField = { id: "privacy", label: "I have read and agree to the Privacy Policy", kind: "select", required: true, options: ["Yes", "No"] };
    expect(decisionOf(form(list), "privacy", DATA_ON)).toMatchObject({ action: "choose", value: "Yes", basis: { kind: "standing_consent", group: "privacy-policy" } });
    expect(decisionOf(form(list), "privacy", ALL_OFF).action).toBe("pause");
  });
});

describe("standing attestations in the planner", () => {
  const cases: Array<[string, string]> = [
    ["accuracy certification", "I certify that the information in this application is true and complete, and I understand that false statements may result in disqualification."],
    ["background check", "I authorize Fixture Robotics to conduct a background check, including criminal history."],
    ["at-will acknowledgment", "I understand that employment with Fixture Robotics is at-will."],
    ["arbitration agreement", "I agree to resolve any employment dispute with Fixture Robotics through binding arbitration."]
  ];

  it.each(cases)("checks a required %s only under the attestation setting", (_name, label) => {
    expect(decisionOf(form(box("statement", label)), "statement", ATTEST_ON)).toMatchObject({
      action: "check", basis: { kind: "standing_consent", setting: "sign_attestations", statement: label }
    });
    for (const standing of [undefined, ALL_OFF, DATA_ON]) {
      expect(decisionOf(form(box("statement", label)), "statement", standing).action).toBe("pause");
    }
  });

  it("signs an electronic signature with the legal name and dates it, only under the setting", () => {
    const shape = form(text("signature", "Electronic Signature (type your full legal name)"), text("signed-on", "Date (MM/DD/YYYY)"));
    const signed = plan(shape, ATTEST_ON);
    expect(signed.decisions[0]).toMatchObject({ action: "fill", value: "Jordan Rivera", basis: { kind: "standing_consent", group: "e-signature" } });
    expect(signed.decisions[1]).toMatchObject({ action: "fill", value: "11/20/2026", basis: { kind: "standing_consent", group: "signature-date" } });
    expect(signed.pauses).toEqual([]);
    for (const standing of [undefined, ALL_OFF, DATA_ON]) {
      const held = plan(shape, standing);
      expect(held.decisions[0]).toMatchObject({ action: "pause", pause: { question: SIGNATURE_QUESTION } });
      expect(held.decisions[1]!.action).toBe("pause");
    }
  });

  it("holds a signature when no name is saved", () => {
    const decision = decisionOf(form(text("signature", "Signature")), "signature", { acceptDataConsent: false, signAttestations: true, today: "2026-11-20" });
    expect(decision.action).toBe("pause");
    expect(decision.pause?.question).toMatch(/legal first and last name/);
  });

  it("never dates a lone Date box that has no signature beside it", () => {
    expect(decisionOf(form(text("when", "Date")), "when", BOTH_ON).action).toBe("pause");
  });

  it("checks an equal-opportunity acknowledgment box but never answers a sensitive list", () => {
    const eeo = box("eeo-read", "I have read the Equal Employment Opportunity statement");
    expect(decisionOf(form(eeo), "eeo-read", ATTEST_ON)).toMatchObject({ action: "check", basis: { kind: "standing_consent", group: "acknowledgment" } });
    const veteran: BrowserField = { id: "veteran", label: "Are you a protected veteran?", kind: "select", required: true, options: ["Yes", "No"] };
    const result = plan(form(veteran), BOTH_ON);
    expect(result.decisions[0]).toMatchObject({ action: "pause" });
    expect(result.decisions[0]!.pause?.question).toMatch(/demographic or equal-opportunity question/);
    expect(result.pauses[0]!.sensitive).toBe(true);
  });
});

describe("statements of fact with both settings on", () => {
  const facts = [
    "I certify that I am a U.S. person under U.S. export-control regulations.",
    "I certify that I am a U.S. citizen.",
    "I certify that I hold an active security clearance.",
    "I certify that I have never been debarred by the FDA.",
    "I certify that I have no conflict of interest with Fixture Robotics.",
    "I certify that I have never been convicted of a felony.",
    "I certify that I have never previously worked for Fixture Robotics.",
    "I certify that I am not bound by a non-compete agreement.",
    "I certify that I am eligible to work on Department of Defense programs."
  ];

  it.each(facts)("plans %s exactly as without the settings", (label) => {
    const shape = form(box("fact", label));
    const withSettings = plan(shape, BOTH_ON);
    expect(withSettings.decisions[0]!.action).toBe("pause");
    expect(withSettings.decisions[0]!.basis).toBe(null);
    expect(withSettings).toEqual(plan(shape, undefined));
  });

  it("checks a certification about the information the candidate is providing only under the attestation setting", () => {
    const label = "I certify that the information I am providing is true and complete.";
    expect(decisionOf(form(box("providing", label)), "providing", ATTEST_ON)).toMatchObject({
      action: "check", basis: { kind: "standing_consent", setting: "sign_attestations", group: "accuracy-certification", statement: label }
    });
    for (const standing of [undefined, ALL_OFF, DATA_ON]) {
      expect(decisionOf(form(box("providing", label)), "providing", standing).action).toBe("pause");
    }
  });

  it("keeps a single self-identification box paused with both settings on", () => {
    const shape = form(box("veteran-box", "I am a protected veteran"));
    const withSettings = plan(shape, BOTH_ON);
    expect(withSettings.decisions[0]!.action).toBe("pause");
    expect(withSettings.decisions[0]!.basis).toBe(null);
    expect(withSettings).toEqual(plan(shape, undefined));
  });

  it("still fills a fact statement from a saved answer exactly as today", () => {
    const shape = form(box("person", "I certify that I am a U.S. person under U.S. export-control regulations."));
    const resolutions = new Map<string, FieldResolution>([["person", { status: "REMEMBERED_ANSWER", answerId: "22222222-2222-4222-8222-222222222222", answer: "Yes", answerKey: "us-person", answerKind: "text" }]]);
    const decision = decisionOf(shape, "person", BOTH_ON, resolutions);
    expect(decision).toMatchObject({ action: "check", basis: { kind: "question_answer" } });
    expect(decision).toEqual(decisionOf(shape, "person", undefined, resolutions));
  });
});

describe("marketing opt-ins", () => {
  it("leaves an optional marketing box unchecked under a setting, and pauses a required one", () => {
    expect(decisionOf(form(box("news", "Send me marketing emails and job alerts.", false)), "news", BOTH_ON)).toMatchObject({ action: "skip" });
    expect(decisionOf(form(box("news", "Send me marketing emails and job alerts.", true)), "news", BOTH_ON)).toMatchObject({
      action: "pause", pause: { question: MARKETING_QUESTION }
    });
    expect(decisionOf(form(box("news", "Send me marketing emails and job alerts.", false)), "news", undefined).action).toBe("skip");
  });
});

describe("the text-message rule in the planner", () => {
  const CONSENT = "Check Yes or No to indicate your agreement to receive text message updates from Fixture Robotics Inc. regarding your job application. Frequency may vary. Message and data rates may apply. Reply STOP to opt out of future messaging.";
  const YES = "Yes - I consent to receiving text messages";
  const NO = "No - I do not consent to receiving text messages";
  const radio = (label: string): BrowserField => ({ id: "communicationConsent", label, kind: "radio", required: false, options: [YES, NO] });

  it("chooses Yes for texts about this application, whatever the standing settings", () => {
    for (const standing of [undefined, ALL_OFF, BOTH_ON]) {
      const result = plan(form(radio(CONSENT)), standing);
      expect(result.decisions.find((decision) => decision.fieldId === "communicationConsent")).toMatchObject({ action: "choose", value: YES, basis: null });
      expect(result.pauses).toEqual([]);
    }
  });

  it("chooses No for job-alert texts", () => {
    const label = "Check Yes or No to indicate your agreement to receive text messages from Fixture Robotics Inc. about job alerts and future openings.";
    expect(decisionOf(form(radio(label)), "communicationConsent")).toMatchObject({ action: "choose", value: NO });
  });

  it("pauses a mixed question with its readable label", () => {
    const label = "Check Yes or No to indicate your agreement to receive text messages from Fixture Robotics Inc. about your application and future job opportunities.";
    const result = plan(form(radio(label)));
    expect(result.decisions[0]).toMatchObject({ action: "pause", pause: { question: TEXT_MESSAGE_QUESTION } });
    expect(result.pauses[0]!.label).toBe(label);
  });

  it("never answers Yes for a radio set read only by its name", () => {
    expect(decisionOf(form(radio("communicationConsent")), "communicationConsent")).toMatchObject({ action: "pause", pause: { question: TEXT_MESSAGE_QUESTION } });
  });

  it("checks a single box for texts about this application, without standing settings", () => {
    expect(decisionOf(form(box("texts", "I agree to receive text messages about my application", false)), "texts")).toMatchObject({ action: "check", value: "true" });
  });

  it("leaves an optional marketing-texts box unchecked and pauses a required one", () => {
    const label = "I agree to receive texts about future openings at Fixture Robotics";
    expect(decisionOf(form(box("texts", label, false)), "texts")).toMatchObject({ action: "skip" });
    expect(decisionOf(form(box("texts", label, true)), "texts")).toMatchObject({ action: "pause", pause: { question: MARKETING_QUESTION } });
  });
});

describe("Jobvite residence and the application walls", () => {
  const offered = ["Select your location of residence and language", "US Based Applicants (English)", "Other (English)"];

  it("chooses the residence naming the profile country", () => {
    for (const country of ["US", "USA", "U.S.", "United States", "united states of america"]) {
      expect(chooseResidenceOption(country, offered)).toBe("US Based Applicants (English)");
    }
    expect(chooseResidenceOption("United States", ["United States - English", "United States - Spanish"])).toBe("United States - English");
    expect(chooseResidenceOption("United States", ["Non-US Applicants", "US Applicants"])).toBe("US Applicants");
    expect(chooseResidenceOption("Canada", ["Canada - English", "Other (English)"])).toBe("Canada - English");
  });

  it("chooses nothing without a country, without a match, or with several", () => {
    expect(chooseResidenceOption(null, offered)).toBe(null);
    expect(chooseResidenceOption("  ", offered)).toBe(null);
    expect(chooseResidenceOption("Canada", offered)).toBe(null);
    expect(chooseResidenceOption("United States", ["US Applicants (French)", "USA Applicants (German)"])).toBe(null);
  });

  it("names the iCIMS account and Jobvite consent steps and keeps their stop texts", () => {
    const icims = "https://careers-fixture.icims.com/jobs/9001/intern/login?in_iframe=1";
    const jobvite = "https://jobs.jobvite.com/fixturerobotics/job/oFixture1/apply";
    expect(applicationWallKind(icims, "")).toBe("icims-account");
    expect(applicationWallKind(jobvite, "Data Consent\nAccept")).toBe("jobvite-consent");
    expect(applicationWallKind(jobvite, "Apply for this job")).toBe(null);
    expect(applicationWallKind("https://careers-fixture.icims.com/jobs/9001/job", "")).toBe(null);
    expect(applicationWallReason(icims, "")).toMatch(/^iCIMS needs an account at careers-fixture\.icims\.com/);
    expect(applicationWallReason(jobvite, "Data Consent")).toMatch(/^Jobvite asks you to accept its data-consent policy at jobs\.jobvite\.com/);
  });

  it("reads the iCIMS tenant host", () => {
    expect(icimsHostOf("https://Careers-Fixture.icims.com/jobs/9001/job")).toBe("careers-fixture.icims.com");
    expect(icimsHostOf("https://icims.com.example.test/jobs")).toBe(null);
    expect(icimsHostOf("not a url")).toBe(null);
  });
});
