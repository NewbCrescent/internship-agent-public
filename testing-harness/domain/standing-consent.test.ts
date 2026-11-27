import { describe, expect, it } from "vitest";

import {
  affirmativeOption,
  classifyStandingStatement,
  factGroupsOf,
  type FactGroup,
  isPrivacyReadQuestion,
  isSignatureDateLabel,
  isSignatureLabel,
  privacyReadStatement,
  signatureDateValue,
  singleOptionStatement,
  standingConsentSettings,
  standingStatementDecision,
  textMessageTopic
} from "@internship-agent/domain";

/** Fictional statements; Fixture Robotics is not a real employer. */
const BOTH = { acceptDataConsent: true, signAttestations: true };
const DATA_ONLY = { acceptDataConsent: true, signAttestations: false };
const ATTESTATIONS_ONLY = { acceptDataConsent: false, signAttestations: true };
const NONE = { acceptDataConsent: false, signAttestations: false };

describe("standing consent settings", () => {
  it("turns each setting on only for an exact 1, and manual checklist mode turns both off", () => {
    expect(standingConsentSettings({})).toEqual(NONE);
    expect(standingConsentSettings({ INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT: "0", INTERNSHIP_AGENT_SIGN_ATTESTATIONS: "yes" })).toEqual(NONE);
    expect(standingConsentSettings({ INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT: " 1 " })).toEqual(DATA_ONLY);
    expect(standingConsentSettings({ INTERNSHIP_AGENT_SIGN_ATTESTATIONS: "1" })).toEqual(ATTESTATIONS_ONLY);
    expect(standingConsentSettings({ INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT: "1", INTERNSHIP_AGENT_SIGN_ATTESTATIONS: "1" })).toEqual(BOTH);
    expect(standingConsentSettings({
      INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT: "1", INTERNSHIP_AGENT_SIGN_ATTESTATIONS: "1", INTERNSHIP_AGENT_MANUAL_ONLY: "1"
    })).toEqual(NONE);
  });
});

describe("the standing whitelist", () => {
  const dataExamples: Array<[string, string]> = [
    ["data-retention", "Fixture Robotics has my consent to retain my data for the purpose of considering me for employment and for up to 3 years thereafter."],
    ["data-processing", "I consent to Fixture Robotics collecting and processing my personal information to evaluate my application."],
    ["privacy-policy", "I have read and agree to the Privacy Policy"]
  ];
  const attestationExamples: Array<[string, string]> = [
    ["accuracy-certification", "I certify that the information in this application is true and complete."],
    ["accuracy-certification", "I understand that false statements may result in disqualification or dismissal."],
    ["acknowledgment", "I understand that employment with Fixture Robotics is at-will."],
    ["acknowledgment", "I acknowledge that I have read the Applicant Privacy Notice"],
    ["acknowledgment", "I understand that this internship is temporary and is not a guarantee of full-time employment."],
    ["acknowledgment", "I have read the Equal Employment Opportunity statement"],
    ["authorization", "I authorize Fixture Robotics to conduct a background check, including criminal history."],
    ["authorization", "I consent to a pre-employment drug test."],
    ["authorization", "I authorize Fixture Robotics to contact my references."],
    ["authorization", "I agree to resolve any employment dispute through binding arbitration."]
  ];

  it.each(dataExamples)("accepts a %s statement only under the data-consent setting", (group, statement) => {
    const accepted = standingStatementDecision(statement, DATA_ONLY);
    expect(accepted).toMatchObject({ verdict: "accept", setting: "accept_data_consent" });
    expect(accepted.verdict === "accept" && accepted.groups.includes(group as never)).toBe(true);
    expect(standingStatementDecision(statement, ATTESTATIONS_ONLY).verdict).toBe("needs-setting");
    expect(standingStatementDecision(statement, NONE).verdict).toBe("needs-setting");
  });

  it.each(attestationExamples)("signs a %s statement only under the attestation setting", (group, statement) => {
    const accepted = standingStatementDecision(statement, ATTESTATIONS_ONLY);
    expect(accepted).toMatchObject({ verdict: "accept", setting: "sign_attestations" });
    expect(accepted.verdict === "accept" && accepted.groups.includes(group as never)).toBe(true);
    expect(standingStatementDecision(statement, DATA_ONLY).verdict).toBe("needs-setting");
    expect(standingStatementDecision(statement, NONE).verdict).toBe("needs-setting");
  });

  it("keeps a privacy-policy agreement a data consent and a privacy-notice acknowledgment an attestation", () => {
    expect(classifyStandingStatement("I have read and agree to the Privacy Policy").groups).toEqual(["privacy-policy"]);
    expect(classifyStandingStatement("I acknowledge that I have read the Applicant Privacy Notice").groups).toEqual(["acknowledgment"]);
  });

  it("accepts personal data related to the application (relatives veto is not a bare 'related to')", () => {
    expect(standingStatementDecision("I consent to Fixture Robotics processing personal data related to my application", DATA_ONLY))
      .toMatchObject({ verdict: "accept", setting: "accept_data_consent", groups: ["data-processing"] });
  });

  it("needs both settings for a statement that is both a data consent and an authorization", () => {
    const mixed = "I authorize Fixture Robotics to process my personal data and to conduct a background check.";
    expect(standingStatementDecision(mixed, DATA_ONLY).verdict).toBe("needs-setting");
    expect(standingStatementDecision(mixed, ATTESTATIONS_ONLY).verdict).toBe("needs-setting");
    expect(standingStatementDecision(mixed, BOTH)).toMatchObject({ verdict: "accept", setting: "both" });
  });

  it("still accepts a background-check authorization that mentions criminal history", () => {
    const statement = "I authorize a background check, including my criminal history and consumer reports.";
    expect(classifyStandingStatement(statement).fact).toBe(false);
    expect(standingStatementDecision(statement, ATTESTATIONS_ONLY).verdict).toBe("accept");
  });

  it("never accepts a label recognition clipped", () => {
    expect(standingStatementDecision("I certify that the information in this application is true and complete, and…", BOTH)).toEqual({ verdict: "none" });
  });

  it("leaves consent that is not about application data alone", () => {
    expect(standingStatementDecision("I consent to receive phone calls", BOTH)).toEqual({ verdict: "none" });
    // Terms of use are accepted under the data-consent setting since 2026-11-24 (terms-consent.test.ts).
    expect(standingStatementDecision("I agree to the terms of use", BOTH)).toEqual({ verdict: "accept", setting: "accept_data_consent", groups: ["terms-of-use"] });
  });
});

describe("statements of fact about the candidate", () => {
  const facts: Array<[string, string]> = [
    ["U.S. citizen", "I certify that I am a U.S. citizen."],
    ["U.S. person", "I confirm that I am a U.S. person as defined by U.S. export regulations."],
    ["export control", "I certify that I am eligible to access export-controlled technology."],
    ["ITAR", "I confirm that I meet the ITAR requirements for this position."],
    ["DoD eligibility", "I certify that I am eligible to work on Department of Defense programs."],
    ["government eligibility", "I attest that I am not a current government employee."],
    ["security clearance", "I confirm that I hold an active security clearance."],
    ["FDA debarment", "I certify that I have never been debarred by the FDA."],
    ["OIG exclusion", "I certify that I am not on the OIG exclusion list."],
    ["conflict of interest", "I certify that I have no conflict of interest with Fixture Robotics."],
    ["criminal history", "I certify that I have never been convicted of a felony."],
    ["criminal history (no conviction)", "I confirm that I have not been convicted of any crime and the information is true."],
    ["prior employment", "I certify that I have never previously worked for Fixture Robotics."],
    ["former employee", "I confirm that I am not a former employee of Fixture Robotics."],
    ["non-compete", "I certify that I am not bound by a non-compete agreement."],
    ["relatives", "I certify that I have no relatives employed by Fixture Robotics."],
    ["work authorization", "I certify that I am authorized to work in the United States and the information is true."],
    ["sponsorship", "I confirm that I will not require visa sponsorship."],
    ["18 or older", "I certify that I am at least 18 years old."]
  ];

  it.each(facts)("never accepts a %s statement, even with both settings on", (_name, statement) => {
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "fact" });
  });
});

describe("statements matching the standard legal and background answers (2026-11-20)", () => {
  it.each([
    ["residence", "I certify that I live within 50 miles of San Francisco and that this information is true."],
    ["relatives", "I certify that no member of my immediate family is a health care professional."],
    ["non-compete", "I certify that I am not subject to a non-solicitation agreement."],
    ["government-clearance", "I certify that I have no concerns working on Department of Defense projects."]
  ] as Array<[FactGroup, string]>)("vetoes the %s statement %s, even with both settings on", (group, statement) => {
    const classified = classifyStandingStatement(statement);
    expect(classified.fact).toBe(true);
    expect(classified.factGroups).toContain(group);
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "fact" });
  });
});

describe("certifications that mention the candidate providing information", () => {
  it.each([
    "I certify that the information I am providing is true and complete.",
    "I understand that the information I am submitting must be accurate, and that false statements may result in disqualification."
  ])("signs %s under the attestation setting only (no fact veto)", (statement) => {
    expect(factGroupsOf(statement)).toEqual([]);
    expect(standingStatementDecision(statement, ATTESTATIONS_ONLY)).toMatchObject({ verdict: "accept", setting: "sign_attestations", groups: ["accuracy-certification"] });
    expect(standingStatementDecision(statement, DATA_ONLY)).toEqual({ verdict: "needs-setting", groups: ["accuracy-certification"] });
    expect(standingStatementDecision(statement, NONE).verdict).toBe("needs-setting");
  });
});

describe("the demographic and first-person-fact vetoes", () => {
  it.each([
    "I am a protected veteran.",
    "I identify as Hispanic or Latino.",
    "I am female.",
    "Please self-identify your disability status."
  ])("vetoes the self-identification %s as demographic, even with both settings on", (statement) => {
    expect(factGroupsOf(statement)).toContain("demographic");
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "fact" });
  });

  it.each([
    "I certify that I am able to work onsite five days a week and that the information is true.",
    "I certify that I'm available to start in May 2027."
  ])("vetoes the first-person assertion %s, even with both settings on", (statement) => {
    const groups = factGroupsOf(statement);
    expect(groups).toContain("first-person-fact");
    expect(groups).not.toContain("demographic");
    expect(classifyStandingStatement(statement).factGroups).toEqual(groups);
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "fact" });
  });
});

describe("each fact group's own pattern", () => {
  const examples: Array<[FactGroup, string]> = [
    ["citizenship-export", "I certify that I am a U.S. citizen."],
    ["citizenship-export", "I confirm that I am a U.S. person as defined by U.S. export regulations."],
    ["citizenship-export", "I certify that I am eligible to access export-controlled technology."],
    ["government-clearance", "I certify that I am eligible to work on Department of Defense programs."],
    ["government-clearance", "I attest that I am not a current government employee."],
    ["debarment", "I certify that I am not on the OIG exclusion list."],
    ["conflict-of-interest", "I certify that I have no conflict of interest with Fixture Robotics."],
    ["criminal-history", "I confirm that I have not been convicted of any crime and the information is true."],
    ["prior-employment", "I confirm that I am not a former employee of Fixture Robotics."],
    ["non-compete", "I certify that I am not bound by a non-compete agreement."],
    ["relatives", "I certify that I have no relatives employed by Fixture Robotics."],
    ["work-authorization", "I certify that I am authorized to work in the United States and the information is true."],
    ["age", "I certify that I am at least 18 years old."],
    ["age", "I confirm I am 18 or older"],
    ["enrollment", "I certify that I am currently enrolled in a degree program."],
    ["demographic", "I identify as Hispanic or Latino."],
    ["demographic", "I am a protected veteran."],
    ["first-person-fact", "I certify that I'm available to start in May 2027."]
  ];
  const withoutFirstPerson: Array<[FactGroup, string]> = [
    ["citizenship-export", "I confirm that I meet the ITAR requirements for this position."],
    ["government-clearance", "I confirm I hold an active security clearance."],
    ["debarment", "I certify that I have never been debarred by the FDA."],
    ["conflict-of-interest", "I certify that no conflict of interest exists with Fixture Robotics."],
    ["criminal-history", "I certify that I have never been convicted of a felony."],
    ["prior-employment", "I certify that I have never previously worked for Fixture Robotics."],
    ["non-compete", "I certify that no non-compete agreement restricts my work."],
    ["relatives", "I certify that no relatives work at Fixture Robotics."],
    ["work-authorization", "I confirm that I will not require visa sponsorship."],
    ["age", "I certify that my age is 18 years or older."],
    ["enrollment", "I confirm that my GPA is accurate."],
    ["residence", "I certify that I live within 50 miles of San Francisco and that this information is true."],
    ["relatives", "I certify that no member of my immediate family is a health care professional."]
  ];

  it("covers every fact group", () => {
    const covered = new Set([...examples, ...withoutFirstPerson].map(([group]) => group));
    expect(covered.size).toBe(14);
  });

  it.each(examples)("matches %s on its own pattern: %s", (group, statement) => {
    expect(factGroupsOf(statement)).toContain(group);
  });

  it.each(withoutFirstPerson)("matches %s without the first-person or demographic veto: %s", (group, statement) => {
    const groups = factGroupsOf(statement);
    expect(groups).toContain(group);
    expect(groups).not.toContain("first-person-fact");
    expect(groups).not.toContain("demographic");
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "fact" });
  });
});

describe("marketing opt-ins", () => {
  it.each([
    "Send me the Fixture Robotics newsletter",
    "Sign me up for job alerts",
    "Join our talent community",
    "I agree to receive text messages about my application",
    "I consent to Fixture Robotics storing my data to contact me about future opportunities"
  ])("never accepts %s", (statement) => {
    expect(standingStatementDecision(statement, BOTH)).toEqual({ verdict: "marketing" });
  });
});

describe("the candidate's text-message rule (textMessageTopic)", () => {
  const CONSENT = "Check Yes or No to indicate your agreement to receive text message updates from Fixture Robotics Inc. regarding your job application. Frequency may vary. Message and data rates may apply. Reply STOP to opt out of future messaging.";
  const YES = "Yes - I consent to receiving text messages";
  const NO = "No - I do not consent to receiving text messages";

  it.each<[string, string[]]>([
    [CONSENT, [YES, NO]],
    ["Can we text you about the status of your application?", ["Yes", "No"]],
    ["I agree to receive text messages about my application", []]
  ])("reads %s as texts about this application", (question, options) => {
    expect(textMessageTopic(question, options)).toBe("application");
  });

  it.each([
    "I agree to receive text messages about future job opportunities at Fixture Robotics",
    "Sign me up for SMS job alerts"
  ])("reads %s as marketing texts", (question) => {
    expect(textMessageTopic(question)).toBe("marketing");
  });

  it.each<[string, string[]]>([
    ["I agree to receive text messages about my application and future job opportunities", []],
    ["Check Yes or No to indicate your agreement to receive text message updates via SMS and/or WhatsApp from Fixture Robotics Inc. regarding your job application. Frequency may vary. Message and data rates may apply.", [YES, NO]],
    ["May we send you text messages?", ["Yes", "No"]],
    ["I consent to calls and text messages about my application", []],
    ["I agree to receive text messages about my applic…", []],
    ["communicationConsent", [YES, NO]]
  ])("reads %s as unclear", (question, options) => {
    expect(textMessageTopic(question, options)).toBe("unclear");
  });

  it.each<[string, string[]]>([
    ["Phone number", []],
    ["Do you have experience with SMS gateways?", ["Yes", "No"]],
    ["Send me marketing emails and job alerts.", []]
  ])("leaves %s alone", (question, options) => {
    expect(textMessageTopic(question, options)).toBe(null);
  });
});

describe("electronic signatures", () => {
  it("recognizes signature boxes and not ordinary name boxes", () => {
    expect(isSignatureLabel("Electronic Signature (type your full legal name)")).toBe(true);
    expect(isSignatureLabel("Signature:")).toBe(true);
    expect(isSignatureLabel("Applicant's Signature")).toBe(true);
    expect(isSignatureLabel("e-Signature")).toBe(true);
    expect(isSignatureLabel("Please type your full name below to sign this application")).toBe(true);
    expect(isSignatureLabel("Sign here")).toBe(true);
    expect(isSignatureLabel("Full legal name")).toBe(false);
    expect(isSignatureLabel("Signature date")).toBe(false);
  });

  it("recognizes the date box beside a signature", () => {
    expect(isSignatureDateLabel("Date")).toBe(true);
    expect(isSignatureDateLabel("Date (MM/DD/YYYY)")).toBe(true);
    expect(isSignatureDateLabel("Today's date:")).toBe(true);
    expect(isSignatureDateLabel("Date signed")).toBe(true);
    expect(isSignatureDateLabel("Start date")).toBe(false);
    expect(isSignatureDateLabel("Date of birth")).toBe(false);
  });

  it("writes today's date in the box's format", () => {
    expect(signatureDateValue("2026-11-20", "text", "Date (MM/DD/YYYY)")).toBe("11/20/2026");
    expect(signatureDateValue("2026-11-20", "text", "Date (DD/MM/YYYY)")).toBe("20/11/2026");
    expect(signatureDateValue("2026-11-20", "text", "Date (YYYY-MM-DD)")).toBe("2026-11-20");
    expect(signatureDateValue("2026-11-20", "date", "Date")).toBe("2026-11-20");
    expect(signatureDateValue("2026-11-20", "text", "Date")).toBe("11/20/2026");
  });

  it("chooses the one affirmative option of a consent list", () => {
    expect(affirmativeOption(["Yes", "No"])).toBe("Yes");
    expect(affirmativeOption(["I agree", "I do not agree"])).toBe("I agree");
    expect(affirmativeOption(["Select...", "Acknowledged"])).toBe("Acknowledged");
    expect(affirmativeOption(["Yes", "Yes, with conditions"])).toBe(null);
    expect(affirmativeOption(["No", "Decline"])).toBe(null);
  });
});

describe("background-check and drug-screen notices (littelfuse.wd1, 2026-11-25)", () => {
  const BACKGROUND_NOTICE = "Subject to applicable federal and/or state law, you will be required at some point in the process to submit to a criminal background check, employment verification, and education verification. Please note that a criminal conviction will not necessarily disqualify you from employment.";
  const DRUG_NOTICE = "Subject to applicable federal and/or state law, and subject to your receipt of a conditional offer of employment, you will be required post interview process to submit to a post-offer drug screen.";

  it.each([["background check", BACKGROUND_NOTICE], ["drug screen", DRUG_NOTICE]])("signs the %s notice as an authorization only under the attestation setting", (_name, statement) => {
    const classified = classifyStandingStatement(statement);
    expect(classified.fact).toBe(false);
    expect(classified.groups).toEqual(["authorization"]);
    expect(standingStatementDecision(statement, ATTESTATIONS_ONLY)).toEqual({ verdict: "accept", setting: "sign_attestations", groups: ["authorization"] });
    expect(standingStatementDecision(statement, DATA_ONLY).verdict).toBe("needs-setting");
    expect(standingStatementDecision(statement, NONE).verdict).toBe("needs-setting");
  });

  it("never takes a question about a background check or drug screen", () => {
    for (const question of [
      "If required, will you submit to a background check and drug screen?",
      "You will be required to submit to a background check. Are you willing to do so?",
      "Are you willing to undergo a background check?"
    ]) expect(standingStatementDecision(question, BOTH).verdict).not.toBe("accept");
  });
});

describe("\"Have you read the privacy policy?\" lists (littelfuse.wd1, 2026-11-25; Track 32)", () => {
  const LABEL = "Have you read the Fixture Robotics Privacy Policy?https://example.com/privacy";
  const CONSENTING = "Yes, I have read and consent to the Global Privacy Policy";

  it("recognizes a privacy-policy read question and nothing else", () => {
    expect(isPrivacyReadQuestion(LABEL)).toBe(true);
    expect(isPrivacyReadQuestion("Did you review the Fixture Robotics Candidate Privacy Notice?")).toBe(true);
    expect(isPrivacyReadQuestion("Have you read the job description?")).toBe(false);
  });

  it("builds the statement from the question and its one affirmative option", () => {
    expect(privacyReadStatement(LABEL, ["Select One", CONSENTING, "No"])).toEqual({ option: CONSENTING, statement: `${LABEL} — ${CONSENTING}` });
    expect(privacyReadStatement("Have you read the Fixture Robotics Privacy Policy…", ["Select One", CONSENTING, "No"])).toBeNull();
    expect(privacyReadStatement(LABEL, ["Yes", "Yes, I agree", "No"])).toBeNull();
    expect(privacyReadStatement("Have you read the job description?", ["Yes", "No"])).toBeNull();
  });

  it("accepts a consenting option under the data-consent setting and a bare Yes as an acknowledgment", () => {
    const consent = privacyReadStatement(LABEL, ["Select One", CONSENTING, "No"])!.statement;
    const accepted = standingStatementDecision(consent, BOTH);
    expect(accepted).toMatchObject({ verdict: "accept", setting: "accept_data_consent" });
    expect(accepted.verdict === "accept" && accepted.groups).toContain("privacy-policy");
    expect(standingStatementDecision(consent, ATTESTATIONS_ONLY).verdict).toBe("needs-setting");
    const plain = privacyReadStatement(LABEL, ["Yes", "No"])!.statement;
    expect(standingStatementDecision(plain, BOTH)).toEqual({ verdict: "accept", setting: "sign_attestations", groups: ["acknowledgment"] });
    expect(standingStatementDecision(plain, DATA_ONLY).verdict).toBe("needs-setting");
    const fact = privacyReadStatement(LABEL, ["Yes, and I am a U.S. citizen", "No"])!.statement;
    expect(standingStatementDecision(fact, BOTH).verdict).toBe("fact");
  });
});

describe("one-option lists (Track 67)", () => {
  const ACKNOWLEDGE = "I Acknowledge/Accept this Statement";

  it("reads an arbitration acknowledgment's heading and only option as an arbitration authorization", () => {
    const single = singleOptionStatement("Arbitration Acknowledgment:", [ACKNOWLEDGE]);
    expect(single).toEqual({ option: ACKNOWLEDGE, statement: `Arbitration Acknowledgment: ${ACKNOWLEDGE}` });
    const accepted = standingStatementDecision(single!.statement, BOTH);
    expect(accepted).toMatchObject({ verdict: "accept", setting: "sign_attestations" });
    expect(accepted.verdict === "accept" && accepted.groups).toContain("authorization");
    expect(standingStatementDecision(single!.statement, DATA_ONLY).verdict).toBe("needs-setting");
  });

  it("reads a GDPR acknowledgment with that option as privacy-policy consent", () => {
    const single = singleOptionStatement("GDPR Acknowledgement", [ACKNOWLEDGE]);
    expect(single).toEqual({ option: ACKNOWLEDGE, statement: `GDPR Acknowledgement: ${ACKNOWLEDGE}` });
    const accepted = standingStatementDecision(single!.statement, BOTH);
    expect(accepted).toMatchObject({ verdict: "accept", setting: "accept_data_consent" });
    expect(accepted.verdict === "accept" && accepted.groups).toContain("privacy-policy");
    expect(standingStatementDecision(single!.statement, ATTESTATIONS_ONLY).verdict).toBe("needs-setting");
  });

  it("reads a privacy-notice list whose only option is Yes or 'I have read' as an acknowledgment", () => {
    const LABEL = "By selecting yes to this question you confirm that you have read the Fixture Robotics Applicant Privacy Notice.";
    const yes = singleOptionStatement(LABEL, ["Yes"]);
    expect(yes).toEqual({ option: "Yes", statement: `${LABEL} — Yes` });
    expect(standingStatementDecision(yes!.statement, BOTH)).toMatchObject({ verdict: "accept", setting: "sign_attestations", groups: ["acknowledgment"] });
    const read = singleOptionStatement("Privacy Notice", ["I have read the Privacy Notice."]);
    expect(read).toEqual({ option: "I have read the Privacy Notice.", statement: "Privacy Notice: I have read the Privacy Notice." });
    expect(standingStatementDecision(read!.statement, BOTH)).toMatchObject({ verdict: "accept", setting: "sign_attestations", groups: ["acknowledgment"] });
    expect(singleOptionStatement("Privacy Notice", ["I have not read the Privacy Notice."])).toBeNull();
    const policy = singleOptionStatement("Fixture Robotics Candidate Privacy Policy", ["I acknowledge that I have read and understood the Fixture Robotics Candidate Privacy Policy."]);
    const decided = standingStatementDecision(policy!.statement, BOTH);
    expect(decided.verdict).toBe("accept");
    expect(decided.verdict === "accept" && decided.groups).toContain("acknowledgment");
  });

  it("never accepts an unknown heading, a fact the option asserts, a clipped label, several options, or marketing", () => {
    const usage = singleOptionStatement("Candidate AI Usage Attestation:", ["I agree"]);
    expect(standingStatementDecision(usage!.statement, BOTH).verdict).toBe("none");
    const REVIEW = "Please review the question again to confirm your response is correct.";
    const CONFIRMING = "Confirming my response to the US Persons question is correct.";
    expect(singleOptionStatement(REVIEW, [CONFIRMING])).toBeNull();
    expect(standingStatementDecision(`${REVIEW} — ${CONFIRMING}`, BOTH).verdict).toBe("fact");
    expect(singleOptionStatement("Arbitration Acknowledgment:", [ACKNOWLEDGE, "I do not accept"])).toBeNull();
    expect(singleOptionStatement("Arbitration Acknowledg…", [ACKNOWLEDGE])).toBeNull();
    const newsletter = singleOptionStatement("Newsletter", ["I agree"]);
    expect(standingStatementDecision(newsletter!.statement, BOTH).verdict).toBe("marketing");
  });

  it("leaves a statement that the candidate took an action with the candidate", () => {
    // It states an action the candidate took (marking a sender as safe), a fact the agent cannot know.
    expect(standingStatementDecision("I understand that next steps will be sent via email and I have marked the sender address above as safe.", BOTH).verdict).not.toBe("accept");
  });
});
