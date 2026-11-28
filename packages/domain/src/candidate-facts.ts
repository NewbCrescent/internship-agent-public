import { z } from "zod";

import { normalizeCompanyName } from "./company-name";
import { exportControlCategory } from "./export-control";

/**
 * Application channels that can carry their own answer for a fact. The one
 * channel, `handshake_internal`, is the candidate's alternate application
 * profile: it applies to Handshake-native applications (Quick Apply / Apply
 * inside Handshake) and to any application whose form asks for a transcript.
 * Everything else, including Handshake postings that redirect to an employer
 * site, uses the global answer.
 */
export const applicationChannelSchema = z.enum(["handshake_internal"]);

export const factScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("application_channel"), channel: applicationChannelSchema }),
  z.object({ kind: z.literal("country"), code: z.string().trim().min(2).max(3).transform((value) => value.toUpperCase()) }),
  z.object({ kind: z.literal("location"), name: z.string().trim().min(2).max(120) }),
  // One employer, stored normalized (normalizeCompanyName); matched exactly, never fuzzily.
  z.object({
    kind: z.literal("company"),
    name: z.string().trim().min(1).max(120).transform(normalizeCompanyName).refine((value) => value.length > 0, "Company name is empty")
  })
]);

export const factSourceSchema = z.enum(["user", "verified_evidence"]);
export const factSensitivitySchema = z.enum(["standard", "sensitive", "protected"]);
export const factReusePolicySchema = z.enum(["auto", "confirm", "never"]);

export type FactScope = z.infer<typeof factScopeSchema>;
export type ApplicationChannel = z.infer<typeof applicationChannelSchema>;
export type FactSource = z.infer<typeof factSourceSchema>;
export type FactSensitivity = z.infer<typeof factSensitivitySchema>;
export type FactReusePolicy = z.infer<typeof factReusePolicySchema>;

type FactDefinition = {
  label: string;
  valueType: "boolean" | "date" | "text";
  valueSchema: z.ZodType<boolean | string>;
  allowedScopes: FactScope["kind"][];
  sensitivity: FactSensitivity;
  reusePolicy: FactReusePolicy;
  explicitUserSourceRequired: boolean;
};

export const selfIdentificationKeys = ["eeo_gender", "eeo_race_ethnicity", "eeo_veteran_status", "eeo_disability_status", "eeo_sexual_orientation", "eeo_transgender"] as const;
export type SelfIdentificationKey = (typeof selfIdentificationKeys)[number];
/** Saved voluntary self-identification answers by key; only browser runs' EEO matching reads these. */
export type SelfIdentificationAnswers = Partial<Record<SelfIdentificationKey, string>>;
export const eeoGenderSchema = z.enum(["male", "female", "non_binary"]);
export const eeoRaceEthnicitySchema = z.enum([
  "hispanic_or_latino",
  "white",
  "black_or_african_american",
  "asian",
  "american_indian_or_alaska_native",
  "native_hawaiian_or_pacific_islander",
  "two_or_more_races"
]);
export const eeoVeteranStatusSchema = z.enum(["not_veteran", "veteran_not_protected", "protected_veteran"]);
export const eeoDisabilityStatusSchema = z.enum(["no_disability", "has_disability"]);
export const eeoSexualOrientationSchema = z.enum(["heterosexual", "gay", "lesbian", "bisexual", "pansexual", "asexual", "queer"]);
export const eeoTransgenderSchema = z.enum(["transgender", "not_transgender"]);

export const factDefinitions = {
  willing_to_relocate: {
    label: "Willing to relocate",
    valueType: "boolean",
    valueSchema: z.boolean(),
    // Recorded per country (or a named place); global stays only so older rows still parse.
    allowedScopes: ["global", "country", "location"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  authorized_to_work: {
    label: "Authorized to work",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["country"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  requires_sponsorship: {
    label: "Requires employment sponsorship",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["country"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  available_start_date: {
    label: "Available start date",
    valueType: "date",
    valueSchema: z.iso.date(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  graduation_date: {
    label: "Graduation date",
    valueType: "date",
    valueSchema: z.iso.date(),
    allowedScopes: ["global", "application_channel"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  enrolled_full_time: {
    label: "Enrolled full-time",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  how_heard: {
    label: "How you heard about the job",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(120),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  previously_worked_here: {
    label: "Previously worked or interned at the company",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global", "company"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  age_18_or_older: {
    label: "18 or older",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  age_16_or_older: {
    label: "16 or older",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  pronouns: {
    label: "Pronouns",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(40),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  relatives_at_company: {
    label: "Relatives working at the company",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global", "company"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  available_end_date: {
    label: "Latest internship end date",
    valueType: "date",
    valueSchema: z.iso.date(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // (Track 83) Full-time (40 h/week) work availability; answers a dated question only inside the saved start..end window.
  available_full_time: {
    label: "Available to work full-time (40 h/week) for the saved internship window",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  work_arrangement: {
    label: "Open to on-site and hybrid work",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // Willingness only; never the criminal_conviction fact or the attestation setting's background-check authorization.
  willing_background_check: {
    label: "Willing to undergo a background check",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // A separate key from willing_to_relocate, which does not say who pays for the move.
  willing_to_relocate_at_own_expense: {
    label: "Willing to relocate at own expense",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global", "country", "location"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // Built from candidate_coursework at resolve time (pnpm profile:coursework); never stored as a fact.
  relevant_coursework: {
    label: "Relevant coursework",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(10_000),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_gender: {
    label: "Gender (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoGenderSchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_race_ethnicity: {
    label: "Race or ethnicity (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoRaceEthnicitySchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_veteran_status: {
    label: "Veteran status (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoVeteranStatusSchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_disability_status: {
    label: "Disability status (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoDisabilityStatusSchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_sexual_orientation: {
    label: "Sexual orientation (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoSexualOrientationSchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  eeo_transgender: {
    label: "Transgender identity (voluntary self-identification)",
    valueType: "text",
    valueSchema: eeoTransgenderSchema,
    allowedScopes: ["global"],
    sensitivity: "protected",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // The candidate's standard legal and background answers (pnpm profile:facts, 2026-11-20).
  us_citizen: {
    label: "U.S. citizen",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  us_person_export_controls: {
    label: "U.S. person status (export controls)",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(200).refine((value) => exportControlCategory(value) !== null, "Not a recognized export-control status"),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  security_clearance_eligible: {
    label: "Eligible for a security clearance",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  holds_security_clearance: {
    label: "Holds an active security clearance",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  criminal_conviction: {
    label: "Criminal conviction",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  government_debarment_or_exclusion: {
    label: "Government debarment or exclusion",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_compete: {
    label: "Subject to a non-compete agreement",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_solicitation: {
    label: "Subject to a non-solicitation agreement",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_solicitation_ends: {
    label: "Non-solicitation agreement end date",
    valueType: "date",
    valueSchema: z.iso.date(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_solicitation_explanation: {
    label: "Non-solicitation agreement explanation",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(2_000),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_compete_or_non_solicitation: {
    label: "Subject to a non-compete or non-solicitation agreement",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  non_solicitation_restricts_this_job: {
    label: "Non-solicitation agreement restricts the role",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  conflict_of_interest: {
    label: "Conflict of interest",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  relative_government_official: {
    label: "Relative who is a government official",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  immediate_family_health_care_professional: {
    label: "Immediate family member who is a health care professional",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // Scoped to one named place only; a San Francisco answer never answers another city.
  lives_within_50_miles: {
    label: "Lives within 50 miles",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["location"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // (Track 83) The county of the current address; county lists match it exactly once (with the profile's state when listed).
  county: {
    label: "County of the current address",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(80),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // A rule, not a value: the posting's stated pay as an hourly figure (standard-answers.ts).
  salary_expectation_rule: {
    label: "Salary expectation rule",
    valueType: "text",
    valueSchema: z.enum(["posting_pay_hourly"]),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  concerns_working_on_dod_projects: {
    label: "Concerns about working on Department of Defense projects",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // Built from the saved answers above at resolve time (standard-answers.ts); never stored as facts.
  us_person: {
    label: "U.S. person (ITAR/EAR)",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  us_citizen_or_national: {
    label: "U.S. citizen or national",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  us_citizen_or_permanent_resident: {
    label: "U.S. citizen or permanent resident",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  f1_optional_practical_training: {
    label: "On or eligible for F-1 Optional Practical Training (OPT)",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  unrestricted_us_work_authorization: {
    label: "Unrestricted right to work in the United States",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "sensitive",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // (Track 79) Canonical test scores, saved only from the candidate's own answer (pnpm profile:answers --promote).
  sat_score: {
    label: "SAT total score",
    valueType: "text",
    valueSchema: z.string().trim().regex(/^\d{3,4}$/).refine((value) => Number(value) >= 400 && Number(value) <= 1600, "An SAT total score is 400 to 1600"),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  act_score: {
    label: "ACT composite score",
    valueType: "text",
    valueSchema: z.string().trim().regex(/^\d{1,2}$/).refine((value) => Number(value) >= 1 && Number(value) <= 36, "An ACT composite score is 1 to 36"),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  // (Track 83) Whether the candidate took the ACT; a saved No picks a list's one "did not take" option, never a score.
  act_taken: {
    label: "Took the ACT",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  },
  salary_expectation: {
    label: "Salary expectation",
    valueType: "text",
    valueSchema: z.string().trim().min(1).max(200),
    allowedScopes: ["global"],
    sensitivity: "standard",
    reusePolicy: "auto",
    explicitUserSourceRequired: true
  }
} satisfies Record<string, FactDefinition>;

export const candidateFactKeySchema = z.enum([
  "willing_to_relocate",
  "authorized_to_work",
  "requires_sponsorship",
  "available_start_date",
  "graduation_date",
  "enrolled_full_time",
  "how_heard",
  "previously_worked_here",
  "age_18_or_older",
  "age_16_or_older",
  "pronouns",
  "relatives_at_company",
  "available_end_date",
  "available_full_time",
  "work_arrangement",
  "willing_background_check",
  "willing_to_relocate_at_own_expense",
  "relevant_coursework",
  "eeo_gender",
  "eeo_race_ethnicity",
  "eeo_veteran_status",
  "eeo_disability_status",
  "eeo_sexual_orientation",
  "eeo_transgender",
  "us_citizen",
  "us_person_export_controls",
  "security_clearance_eligible",
  "holds_security_clearance",
  "criminal_conviction",
  "government_debarment_or_exclusion",
  "non_compete",
  "non_solicitation",
  "non_solicitation_ends",
  "non_solicitation_explanation",
  "non_compete_or_non_solicitation",
  "non_solicitation_restricts_this_job",
  "conflict_of_interest",
  "relative_government_official",
  "immediate_family_health_care_professional",
  "lives_within_50_miles",
  "county",
  "salary_expectation_rule",
  "concerns_working_on_dod_projects",
  "us_person",
  "us_citizen_or_national",
  "us_citizen_or_permanent_resident",
  "f1_optional_practical_training",
  "unrestricted_us_work_authorization",
  "salary_expectation",
  "sat_score",
  "act_score",
  "act_taken"
]);

export type CandidateFactKey = z.infer<typeof candidateFactKeySchema>;
export type CandidateFactValue = boolean | string;

export const factSourceDetailSchema = z.object({
  kind: z.enum(["profile", "remembered_answer", "verified_evidence"]),
  question: z.string().trim().min(1).max(1_000).optional(),
  evidenceId: z.string().min(1).optional()
});

export const candidateFactSchema = z.object({
  id: z.string().min(1),
  candidateId: z.string().min(1),
  key: candidateFactKeySchema,
  scope: factScopeSchema,
  value: z.union([z.boolean(), z.string()]),
  valueType: z.enum(["boolean", "date", "text"]),
  source: factSourceSchema,
  sourceDetail: factSourceDetailSchema,
  confidence: z.number().min(0).max(1),
  sensitivity: factSensitivitySchema,
  reusePolicy: factReusePolicySchema,
  rememberedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable(),
  supersededById: z.string().nullable(),
  revokedAt: z.iso.datetime().nullable()
}).superRefine((fact, context) => {
  const definition = factDefinitions[fact.key];
  const valueResult = definition.valueSchema.safeParse(fact.value);
  if (!valueResult.success) {
    context.addIssue({ code: "custom", path: ["value"], message: `Invalid value for ${fact.key}` });
  }
  if (fact.valueType !== definition.valueType) {
    context.addIssue({ code: "custom", path: ["valueType"], message: `Expected ${definition.valueType}` });
  }
  if (!(definition.allowedScopes as FactScope["kind"][]).includes(fact.scope.kind)) {
    context.addIssue({ code: "custom", path: ["scope"], message: `Scope ${fact.scope.kind} is not allowed for ${fact.key}` });
  }
  if (definition.explicitUserSourceRequired && fact.source !== "user") {
    context.addIssue({ code: "custom", path: ["source"], message: `${fact.key} requires an explicit user source` });
  }
  if ((fact.key === "previously_worked_here" || fact.key === "relatives_at_company") && fact.value === true && fact.scope.kind !== "company") {
    context.addIssue({ code: "custom", path: ["value"], message: `A Yes for ${fact.key} must name the company (company scope).` });
  }
});

export type CandidateFact = z.infer<typeof candidateFactSchema>;

export function scopeKey(scope: FactScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "country") return `country:${scope.code.toUpperCase()}`;
  if (scope.kind === "application_channel") return `channel:${scope.channel}`;
  if (scope.kind === "company") return `company:${normalizeCompanyName(scope.name)}`;
  return `location:${scope.name.trim().toLocaleLowerCase("en-US")}`;
}

/** The channel a posting's application type belongs to, if any. */
export function applicationChannelFor(applicationType: string | null | undefined): ApplicationChannel | null {
  return applicationType === "HANDSHAKE_INTERNAL" ? "handshake_internal" : null;
}

/** True when a fact key may carry a channel-specific answer. */
export function allowsChannelScope(key: CandidateFactKey): boolean {
  return (factDefinitions[key].allowedScopes as FactScope["kind"][]).includes("application_channel");
}

export function parseFactAnswer(key: CandidateFactKey, input: string): CandidateFactValue {
  const definition = factDefinitions[key];
  const trimmed = input.trim();
  const candidateValue = definition.valueType === "boolean"
    ? parseBooleanAnswer(trimmed)
    : trimmed;
  return definition.valueSchema.parse(candidateValue);
}

function parseBooleanAnswer(input: string): boolean {
  const normalized = input.toLocaleLowerCase("en-US");
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error("Answer with yes or no.");
}

export function formatFactValue(value: CandidateFactValue): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

/** (Track 79) Keys a saved question-memory answer may be promoted to (pnpm profile:answers --promote). */
export const PROMOTABLE_FACT_KEYS: ReadonlySet<CandidateFactKey> = new Set<CandidateFactKey>(["sat_score", "act_score"]);

const PROMOTABLE_SCORE = /^\s*(\d{1,4})\s*(?:\((sat|act)\))?\s*$/i;

/**
 * (Track 79) The canonical fact value a saved question-memory answer gives a promotable key, or why it does not:
 * "1234" or "1234 (SAT)" for sat_score, "30" or "30 (ACT)" for act_score. A tag must name the key's test; without one
 * the saved question must name only that test. The value must pass the key's schema. Reasons never contain the value.
 */
export function promotableFactValue(key: CandidateFactKey, question: string, answer: string): { value: string } | { reason: string } {
  if (!PROMOTABLE_FACT_KEYS.has(key)) return { reason: `${key} is not a key a saved answer can be promoted to.` };
  const test = key === "sat_score" ? "sat" : "act";
  const other = test === "sat" ? "act" : "sat";
  const match = PROMOTABLE_SCORE.exec(answer);
  if (!match) return { reason: "The saved answer is not a single score." };
  const tag = match[2]?.toLocaleLowerCase("en-US");
  if (tag && tag !== test) return { reason: `The saved answer is tagged as another test, not ${test.toUpperCase()}.` };
  if (!tag) {
    const asked = question.toLocaleLowerCase("en-US");
    if (!new RegExp(`\\b${test}\\b`).test(asked) || new RegExp(`\\b${other}\\b`).test(asked)) {
      return { reason: `The saved answer has no test tag, and its question does not name only the ${test.toUpperCase()}.` };
    }
  }
  const parsed = factDefinitions[key].valueSchema.safeParse(match[1]);
  if (!parsed.success) return { reason: `The saved answer is not a valid ${factDefinitions[key].label}.` };
  return { value: String(parsed.data) };
}
