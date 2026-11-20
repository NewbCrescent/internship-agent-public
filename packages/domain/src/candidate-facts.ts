import { z } from "zod";

import { normalizeCompanyName } from "./company-name";

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

export const selfIdentificationKeys = ["eeo_gender", "eeo_race_ethnicity", "eeo_veteran_status", "eeo_disability_status"] as const;
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
  work_arrangement: {
    label: "Open to on-site and hybrid work",
    valueType: "boolean",
    valueSchema: z.boolean(),
    allowedScopes: ["global"],
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
  "pronouns",
  "relatives_at_company",
  "available_end_date",
  "work_arrangement",
  "relevant_coursework",
  "eeo_gender",
  "eeo_race_ethnicity",
  "eeo_veteran_status",
  "eeo_disability_status"
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
