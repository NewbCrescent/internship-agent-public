import { describe, expect, it } from "vitest";

import {
  allowsChannelScope,
  applicationChannelFor,
  candidateFactSchema,
  factDefinitions,
  mentionsCompany,
  mentionsCompanyLead,
  mentionsSiteTenant,
  normalizeCompanyName,
  parseFactAnswer,
  scopeKey,
  selfIdentificationKeys
} from "@internship-agent/domain";

describe("candidate fact contracts", () => {
  it("parses reviewed boolean answers and normalizes scopes", () => {
    expect(parseFactAnswer("willing_to_relocate", "YES")).toBe(true);
    expect(parseFactAnswer("requires_sponsorship", "no")).toBe(false);
    expect(scopeKey({ kind: "location", name: " Seattle, WA " })).toBe("location:seattle, wa");
    expect(scopeKey({ kind: "country", code: "us" })).toBe("country:US");
  });

  it("rejects a wrong value type and unsupported evidence source", () => {
    const base = {
      id: "fact-1",
      candidateId: "candidate-1",
      key: "authorized_to_work" as const,
      scope: { kind: "country" as const, code: "US" },
      valueType: "boolean" as const,
      confidence: 1,
      sensitivity: "sensitive" as const,
      reusePolicy: "auto" as const,
      rememberedAt: "2026-09-22T12:00:00.000Z",
      createdAt: "2026-09-22T12:00:00.000Z",
      supersededAt: null,
      supersededById: null,
      revokedAt: null
    };
    expect(candidateFactSchema.safeParse({
      ...base,
      value: "yes",
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Authorized to work in the US?" }
    }).success).toBe(false);
    expect(candidateFactSchema.safeParse({
      ...base,
      value: true,
      source: "verified_evidence",
      sourceDetail: { kind: "verified_evidence", evidenceId: "readme" }
    }).success).toBe(false);
  });

  it("accepts a country scope for relocation and rejects a company scope", () => {
    const relocation = {
      id: "fact-2",
      candidateId: "candidate-1",
      key: "willing_to_relocate",
      value: true,
      valueType: "boolean",
      source: "user",
      sourceDetail: { kind: "remembered_answer", question: "Relocate?" },
      confidence: 1,
      sensitivity: "standard",
      reusePolicy: "auto",
      rememberedAt: "2026-09-22T12:00:00.000Z",
      createdAt: "2026-09-22T12:00:00.000Z",
      supersededAt: null,
      supersededById: null,
      revokedAt: null
    };
    expect(candidateFactSchema.safeParse({ ...relocation, scope: { kind: "country", code: "US" } }).success).toBe(true);
    expect(candidateFactSchema.safeParse({ ...relocation, scope: { kind: "company", name: "Acme" } }).success).toBe(false);
  });
});

describe("company scope, text facts, and saved self-identification keys", () => {
  const fact = (key: string, scope: unknown, value: boolean | string) => {
    const definition = factDefinitions[key as keyof typeof factDefinitions];
    return candidateFactSchema.safeParse({
      id: "fact-3",
      candidateId: "candidate-1",
      key,
      scope,
      value,
      valueType: definition.valueType,
      source: "user",
      sourceDetail: { kind: "profile" },
      confidence: 1,
      sensitivity: definition.sensitivity,
      reusePolicy: definition.reusePolicy,
      rememberedAt: "2026-11-19T12:00:00.000Z",
      createdAt: "2026-11-19T12:00:00.000Z",
      supersededAt: null,
      supersededById: null,
      revokedAt: null
    });
  };

  it("keys a company by its exact normalized name, never fuzzily", () => {
    expect(scopeKey({ kind: "company", name: "Vandelay, Inc." })).toBe("company:vandelay");
    expect(scopeKey({ kind: "company", name: "VANDELAY" })).toBe("company:vandelay");
    expect(scopeKey({ kind: "company", name: "Vandelay Labs" })).not.toBe("company:vandelay");
    expect(scopeKey({ kind: "company", name: "The Vandelay, Inc." })).toBe("company:vandelay");
    expect(normalizeCompanyName("Vandelay Inc.")).toBe("vandelay");
    // One rule with the company policy: symbols and accents dropped, a leading "the" removed.
    expect(normalizeCompanyName("Ben & Jerry's Co.")).toBe("ben jerry s");
    expect(normalizeCompanyName("Café Labs LLC")).toBe("cafe labs");
    expect(normalizeCompanyName("The Trade Desk")).toBe("trade desk");
    for (const name of ["Vandelay, Inc.", "Acme Robotics LLC", "Ben & Jerry's Co."]) {
      expect(normalizeCompanyName(normalizeCompanyName(name))).toBe(normalizeCompanyName(name));
    }
    // A name made only of a legal suffix keeps it rather than becoming empty.
    expect(normalizeCompanyName("Company")).toBe("company");
  });

  it("finds a company named only as whole words", () => {
    expect(mentionsCompany("Have you worked for Vandelay before?", "Vandelay Inc.")).toBe(true);
    expect(mentionsCompany("Have you worked for Vandelayly before?", "Vandelay")).toBe(false);
    expect(mentionsCompany("Have you worked here?", "")).toBe(false);
    expect(mentionsCompany("Have you worked at The Trade Desk?", "The Trade Desk")).toBe(true);
  });

  it("finds a Workday tenant spelled by consecutive whole words, never part of a word", () => {
    expect(mentionsSiteTenant("Have you ever been employed by Fixture Health, Example Network?", "fixturehealth")).toBe(true);
    expect(mentionsSiteTenant("Have you previously been employed by any Fixturetron company?", "fixturetron")).toBe(true);
    expect(mentionsSiteTenant("Have you ever been employed by Fixture Healthcare?", "fixturehealth")).toBe(false);
    expect(mentionsSiteTenant("Have you ever been employed by ab?", "ab")).toBe(false);
    expect(mentionsSiteTenant("Fixture Health", "FIXTUREHEALTH")).toBe(true);
  });

  it("finds a company named by its leading word or words after for, at, by, or with, never another company (Track 32)", () => {
    expect(mentionsCompanyLead("Have you worked for Fixturelux before?", "Fixturelux Brands")).toBe(true);
    expect(mentionsCompanyLead("Have you previously been employed by Fixturelux? CURRENT EMPLOYEES: apply internally.", "Fixturelux Brands")).toBe(true);
    expect(mentionsCompanyLead("Have you worked at the Fixturelux Group before?", "Fixturelux Group Holdings")).toBe(true);
    // Another company sharing the first word, a lower-case word, no preposition, a one-word name, a short lead, or the whole name.
    expect(mentionsCompanyLead("Have you worked for Fixturelux Energy before?", "Fixturelux Brands")).toBe(false);
    expect(mentionsCompanyLead("Have you worked for fixturelux before?", "Fixturelux Brands")).toBe(false);
    expect(mentionsCompanyLead("Fixturelux employees: have you worked here?", "Fixturelux Brands")).toBe(false);
    expect(mentionsCompanyLead("Have you worked for Fixturelux before?", "Fixturelux")).toBe(false);
    expect(mentionsCompanyLead("Have you worked for Abc before?", "Abc Brands")).toBe(false);
    expect(mentionsCompanyLead("Have you worked for Fixturelux Brands before?", "Fixturelux Brands")).toBe(false);
  });

  it("allows a Yes for previous employment or relatives only for a named company", () => {
    for (const key of ["previously_worked_here", "relatives_at_company"]) {
      expect(fact(key, { kind: "global" }, true).success).toBe(false);
      expect(fact(key, { kind: "company", name: "Vandelay" }, true).success).toBe(true);
      expect(fact(key, { kind: "global" }, false).success).toBe(true);
      expect(fact(key, { kind: "company", name: "Acme" }, false).success).toBe(true);
    }
    expect(fact("previously_worked_here", { kind: "company", name: " , " }, false).success).toBe(false);
  });

  it("marks saved self-identification answers protected and accepts only their listed values", () => {
    expect(selfIdentificationKeys).toEqual([
      "eeo_gender", "eeo_race_ethnicity", "eeo_veteran_status", "eeo_disability_status", "eeo_sexual_orientation", "eeo_transgender"
    ]);
    for (const key of selfIdentificationKeys) {
      expect(factDefinitions[key].sensitivity).toBe("protected");
      expect(factDefinitions[key].valueType).toBe("text");
      expect(fact(key, { kind: "global" }, "not-a-listed-value").success).toBe(false);
    }
    expect(fact("eeo_gender", { kind: "global" }, "non_binary").success).toBe(true);
    expect(fact("eeo_race_ethnicity", { kind: "global" }, "two_or_more_races").success).toBe(true);
    expect(fact("eeo_veteran_status", { kind: "global" }, "veteran_not_protected").success).toBe(true);
    expect(fact("eeo_disability_status", { kind: "global" }, "has_disability").success).toBe(true);
    expect(fact("eeo_gender", { kind: "country", code: "US" }, "female").success).toBe(false);
  });

  it("adds sexual orientation and transgender identity as protected global self-identification facts (2026-11-24)", () => {
    for (const key of ["eeo_sexual_orientation", "eeo_transgender"] as const) {
      expect(factDefinitions[key].sensitivity).toBe("protected");
      expect(factDefinitions[key].reusePolicy).toBe("auto");
      expect(factDefinitions[key].explicitUserSourceRequired).toBe(true);
      expect(factDefinitions[key].allowedScopes).toEqual(["global"]);
    }
    for (const value of ["heterosexual", "gay", "lesbian", "bisexual", "pansexual", "asexual", "queer"]) {
      expect(fact("eeo_sexual_orientation", { kind: "global" }, value).success).toBe(true);
    }
    expect(fact("eeo_sexual_orientation", { kind: "global" }, "fictional-unlisted").success).toBe(false);
    expect(fact("eeo_sexual_orientation", { kind: "country", code: "US" }, "queer").success).toBe(false);
    expect(fact("eeo_transgender", { kind: "global" }, "transgender").success).toBe(true);
    expect(fact("eeo_transgender", { kind: "global" }, "not_transgender").success).toBe(true);
    expect(fact("eeo_transgender", { kind: "global" }, "yes").success).toBe(false);
  });

  it("adds background-check willingness and own-expense relocation as boolean facts (2026-11-24)", () => {
    expect(factDefinitions.willing_background_check.sensitivity).toBe("standard");
    expect(fact("willing_background_check", { kind: "global" }, true).success).toBe(true);
    expect(fact("willing_background_check", { kind: "global" }, "yes").success).toBe(false);
    expect(fact("willing_background_check", { kind: "country", code: "US" }, true).success).toBe(false);
    expect(fact("willing_to_relocate_at_own_expense", { kind: "country", code: "US" }, true).success).toBe(true);
    expect(fact("willing_to_relocate_at_own_expense", { kind: "location", name: "Fixture City" }, false).success).toBe(true);
    expect(fact("willing_to_relocate_at_own_expense", { kind: "global" }, true).success).toBe(true);
    expect(fact("willing_to_relocate_at_own_expense", { kind: "company", name: "Fixture Robotics" }, true).success).toBe(false);
  });

  it("parses text and date answers", () => {
    expect(parseFactAnswer("how_heard", "  Company website  ")).toBe("Company website");
    expect(parseFactAnswer("pronouns", "they/them")).toBe("they/them");
    expect(parseFactAnswer("available_end_date", "2030-08-15")).toBe("2030-08-15");
    expect(() => parseFactAnswer("available_end_date", "mid August")).toThrow();
    expect(parseFactAnswer("age_18_or_older", "yes")).toBe(true);
    expect(parseFactAnswer("age_16_or_older", "yes")).toBe(true);
    expect(factDefinitions.age_16_or_older).toMatchObject({ sensitivity: "standard", allowedScopes: ["global"], reusePolicy: "auto" });
  });
});

describe("application-channel scope", () => {
  const channelFact = {
    id: "fact-2",
    candidateId: "candidate-1",
    scope: { kind: "application_channel" as const, channel: "handshake_internal" as const },
    valueType: "date" as const,
    value: "2029-05-15",
    source: "user" as const,
    sourceDetail: { kind: "remembered_answer" as const, question: "Expected graduation date?" },
    confidence: 1,
    sensitivity: "standard" as const,
    reusePolicy: "auto" as const,
    rememberedAt: "2026-09-22T12:00:00.000Z",
    createdAt: "2026-09-22T12:00:00.000Z",
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  };

  it("keys channel facts separately from the global answer", () => {
    expect(scopeKey({ kind: "application_channel", channel: "handshake_internal" })).toBe("channel:handshake_internal");
    expect(scopeKey({ kind: "global" })).toBe("global");
  });

  it("allows a channel answer only for graduation date", () => {
    expect(candidateFactSchema.safeParse({ ...channelFact, key: "graduation_date" }).success).toBe(true);
    expect(candidateFactSchema.safeParse({
      ...channelFact,
      key: "willing_to_relocate",
      valueType: "boolean",
      value: true
    }).success).toBe(false);
    expect(allowsChannelScope("graduation_date")).toBe(true);
    expect(allowsChannelScope("available_start_date")).toBe(false);
  });

  it("treats only Handshake-internal applications as the Handshake channel", () => {
    expect(applicationChannelFor("HANDSHAKE_INTERNAL")).toBe("handshake_internal");
    expect(applicationChannelFor("EXTERNAL_ATS")).toBe(null);
    expect(applicationChannelFor("EMPLOYER_SITE")).toBe(null);
    expect(applicationChannelFor("UNKNOWN")).toBe(null);
    expect(applicationChannelFor(undefined)).toBe(null);
  });
});
