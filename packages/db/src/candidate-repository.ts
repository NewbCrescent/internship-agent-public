import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  candidateFactSchema,
  candidatePreferenceInputSchema,
  candidatePreferenceSchema,
  candidateProfileInputSchema,
  candidateSchema,
  COURSEWORK_FACT_KEY,
  factDefinitions,
  scopeKey,
  type Candidate,
  type CandidateFact,
  type CandidateFactKey,
  type CandidateFactValue,
  type CandidatePreference,
  type CandidatePreferenceInput,
  type CandidateProfileInput,
  type FactScope
} from "@internship-agent/domain";

type CandidateRow = {
  id: string;
  full_name: string;
  preferred_name: string | null;
  email: string | null;
  phone: string | null;
  school: string | null;
  degree: string | null;
  graduation_date: string | null;
  gpa: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  legal_first_name: string | null;
  legal_last_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_region: string | null;
  address_postal_code: string | null;
  address_country: string | null;
  phone_type: string | null;
  field_of_study: string | null;
  education_start_month: string | null;
  high_school_name: string | null;
  high_school_start_year: string | null;
  high_school_end_year: string | null;
  created_at: string;
  updated_at: string;
};

type PreferenceRow = {
  candidate_id: string;
  role_types_json: string;
  locations_json: string;
  work_modes_json: string;
  industries_json: string;
  exclude_graduate_only_internships: number;
  updated_at: string;
};

type FactRow = {
  id: string;
  candidate_id: string;
  key: CandidateFactKey;
  scope_json: string;
  value_json: string;
  value_type: "boolean" | "date" | "text";
  source: "user" | "verified_evidence";
  source_detail_json: string;
  confidence: number;
  sensitivity: "standard" | "sensitive" | "protected";
  reuse_policy: "auto" | "confirm" | "never";
  remembered_at: string | null;
  created_at: string;
  superseded_at: string | null;
  superseded_by_id: string | null;
  revoked_at: string | null;
};

export function getCandidate(database: DatabaseSync, candidateId: string): Candidate | null {
  const row = database.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  return row ? candidateSchema.parse(mapCandidate(row)) : null;
}

export function saveCandidate(
  database: DatabaseSync,
  candidateId: string,
  input: CandidateProfileInput
): Candidate {
  const candidate = candidateProfileInputSchema.parse(input);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO candidates (
      id, full_name, preferred_name, email, phone, school, degree, graduation_date, gpa,
      linkedin_url, github_url, portfolio_url,
      legal_first_name, legal_last_name, address_line1, address_line2, address_city,
      address_region, address_postal_code, address_country, phone_type, field_of_study,
      education_start_month, high_school_name, high_school_start_year, high_school_end_year, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      full_name = excluded.full_name,
      preferred_name = excluded.preferred_name,
      email = excluded.email,
      phone = excluded.phone,
      school = excluded.school,
      degree = excluded.degree,
      graduation_date = excluded.graduation_date,
      gpa = excluded.gpa,
      linkedin_url = excluded.linkedin_url,
      github_url = excluded.github_url,
      portfolio_url = excluded.portfolio_url,
      legal_first_name = excluded.legal_first_name,
      legal_last_name = excluded.legal_last_name,
      address_line1 = excluded.address_line1,
      address_line2 = excluded.address_line2,
      address_city = excluded.address_city,
      address_region = excluded.address_region,
      address_postal_code = excluded.address_postal_code,
      address_country = excluded.address_country,
      phone_type = excluded.phone_type,
      field_of_study = excluded.field_of_study,
      education_start_month = excluded.education_start_month,
      high_school_name = excluded.high_school_name,
      high_school_start_year = excluded.high_school_start_year,
      high_school_end_year = excluded.high_school_end_year,
      updated_at = excluded.updated_at
  `).run(
    candidateId,
    candidate.fullName,
    candidate.preferredName ?? null,
    candidate.email ?? null,
    candidate.phone ?? null,
    candidate.school ?? null,
    candidate.degree ?? null,
    candidate.graduationDate ?? null,
    candidate.gpa ?? null,
    candidate.linkedinUrl ?? null,
    candidate.githubUrl ?? null,
    candidate.portfolioUrl ?? null,
    candidate.legalFirstName ?? null,
    candidate.legalLastName ?? null,
    candidate.addressLine1 ?? null,
    candidate.addressLine2 ?? null,
    candidate.addressCity ?? null,
    candidate.addressRegion ?? null,
    candidate.addressPostalCode ?? null,
    candidate.addressCountry ?? null,
    candidate.phoneType ?? null,
    candidate.fieldOfStudy ?? null,
    candidate.educationStartMonth ?? null,
    candidate.highSchoolName ?? null,
    candidate.highSchoolStartYear ?? null,
    candidate.highSchoolEndYear ?? null,
    now,
    now
  );
  const saved = getCandidate(database, candidateId);
  if (!saved) throw new Error("Candidate was not persisted.");
  return saved;
}

export function getCandidatePreferences(database: DatabaseSync, candidateId: string): CandidatePreference | null {
  const row = database.prepare("SELECT * FROM candidate_preferences WHERE candidate_id = ?")
    .get(candidateId) as PreferenceRow | undefined;
  if (!row) return null;
  return candidatePreferenceSchema.parse({
    candidateId: row.candidate_id,
    roleTypes: JSON.parse(row.role_types_json),
    locations: JSON.parse(row.locations_json),
    workModes: JSON.parse(row.work_modes_json),
    industries: JSON.parse(row.industries_json),
    excludeGraduateOnlyInternships: row.exclude_graduate_only_internships === 1,
    updatedAt: row.updated_at
  });
}

export function saveCandidatePreferences(
  database: DatabaseSync,
  candidateId: string,
  input: CandidatePreferenceInput
): CandidatePreference {
  const preferences = candidatePreferenceInputSchema.parse(input);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO candidate_preferences (
      candidate_id, role_types_json, locations_json, work_modes_json, industries_json,
      exclude_graduate_only_internships, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      role_types_json = excluded.role_types_json,
      locations_json = excluded.locations_json,
      work_modes_json = excluded.work_modes_json,
      industries_json = excluded.industries_json,
      exclude_graduate_only_internships = excluded.exclude_graduate_only_internships,
      updated_at = excluded.updated_at
  `).run(
    candidateId,
    JSON.stringify(preferences.roleTypes),
    JSON.stringify(preferences.locations),
    JSON.stringify(preferences.workModes),
    JSON.stringify(preferences.industries),
    preferences.excludeGraduateOnlyInternships ? 1 : 0,
    now
  );
  const saved = getCandidatePreferences(database, candidateId);
  if (!saved) throw new Error("Candidate preferences were not persisted.");
  return saved;
}

export function getCurrentFacts(database: DatabaseSync, candidateId: string): CandidateFact[] {
  const rows = database.prepare(`
    SELECT * FROM candidate_facts
    WHERE candidate_id = ? AND superseded_at IS NULL AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(candidateId) as FactRow[];
  return rows.map(mapFact);
}

export function getCurrentFact(
  database: DatabaseSync,
  candidateId: string,
  key: CandidateFactKey,
  scope: FactScope
): CandidateFact | null {
  const row = database.prepare(`
    SELECT * FROM candidate_facts
    WHERE candidate_id = ? AND key = ? AND scope_key = ?
      AND superseded_at IS NULL AND revoked_at IS NULL
  `).get(candidateId, key, scopeKey(scope)) as FactRow | undefined;
  return row ? mapFact(row) : null;
}

export type SaveCandidateFactInput = {
  candidateId: string;
  key: CandidateFactKey;
  scope: FactScope;
  value: CandidateFactValue;
  source: "user" | "verified_evidence";
  sourceDetail: CandidateFact["sourceDetail"];
  confidence: number;
  rememberedAt: string | null;
};

export function saveCandidateFact(database: DatabaseSync, input: SaveCandidateFactInput): CandidateFact {
  if (input.key === COURSEWORK_FACT_KEY) {
    throw new Error("Relevant coursework is built from the candidate's saved courses (pnpm profile:coursework) and is never stored as a fact.");
  }
  const definition = factDefinitions[input.key];
  const id = randomUUID();
  const now = new Date().toISOString();
  const fact = candidateFactSchema.parse({
    id,
    candidateId: input.candidateId,
    key: input.key,
    scope: input.scope,
    value: input.value,
    valueType: definition.valueType,
    source: input.source,
    sourceDetail: input.sourceDetail,
    confidence: input.confidence,
    sensitivity: definition.sensitivity,
    reusePolicy: definition.reusePolicy,
    rememberedAt: input.rememberedAt,
    createdAt: now,
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  });

  database.exec("BEGIN IMMEDIATE;");
  try {
    const previous = database.prepare(`
      SELECT id FROM candidate_facts
      WHERE candidate_id = ? AND key = ? AND scope_key = ?
        AND superseded_at IS NULL AND revoked_at IS NULL
    `).get(input.candidateId, input.key, scopeKey(input.scope)) as { id: string } | undefined;
    database.prepare(`
      UPDATE candidate_facts
      SET superseded_at = ?
      WHERE id = ?
    `).run(now, previous?.id ?? "");
    database.prepare(`
      INSERT INTO candidate_facts (
        id, candidate_id, key, scope_json, scope_key, value_json, value_type,
        source, source_detail_json, confidence, sensitivity, reuse_policy,
        remembered_at, created_at, superseded_at, superseded_by_id, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      fact.id,
      fact.candidateId,
      fact.key,
      JSON.stringify(fact.scope),
      scopeKey(fact.scope),
      JSON.stringify(fact.value),
      fact.valueType,
      fact.source,
      JSON.stringify(fact.sourceDetail),
      fact.confidence,
      fact.sensitivity,
      fact.reusePolicy,
      fact.rememberedAt,
      fact.createdAt
    );
    if (previous) {
      database.prepare("UPDATE candidate_facts SET superseded_by_id = ? WHERE id = ?")
        .run(id, previous.id);
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return fact;
}

export function revokeCandidateFact(database: DatabaseSync, candidateId: string, factId: string): boolean {
  const result = database.prepare(`
    UPDATE candidate_facts SET revoked_at = ?
    WHERE id = ? AND candidate_id = ? AND superseded_at IS NULL AND revoked_at IS NULL
  `).run(new Date().toISOString(), factId, candidateId);
  return Number(result.changes) === 1;
}

/** Marks a current fact superseded by a fact under another scope (a country answer replacing the old global one), keeping the provenance chain. */
export function supersedeCandidateFact(database: DatabaseSync, candidateId: string, factId: string, supersededById: string): boolean {
  const result = database.prepare(`
    UPDATE candidate_facts SET superseded_at = ?, superseded_by_id = ?
    WHERE id = ? AND candidate_id = ? AND superseded_at IS NULL AND revoked_at IS NULL
  `).run(new Date().toISOString(), supersededById, factId, candidateId);
  return Number(result.changes) === 1;
}

function mapCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    fullName: row.full_name,
    preferredName: row.preferred_name ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    school: row.school ?? undefined,
    degree: row.degree ?? undefined,
    graduationDate: row.graduation_date ?? undefined,
    gpa: row.gpa ?? undefined,
    linkedinUrl: row.linkedin_url ?? undefined,
    githubUrl: row.github_url ?? undefined,
    portfolioUrl: row.portfolio_url ?? undefined,
    legalFirstName: row.legal_first_name ?? undefined,
    legalLastName: row.legal_last_name ?? undefined,
    addressLine1: row.address_line1 ?? undefined,
    addressLine2: row.address_line2 ?? undefined,
    addressCity: row.address_city ?? undefined,
    addressRegion: row.address_region ?? undefined,
    addressPostalCode: row.address_postal_code ?? undefined,
    addressCountry: row.address_country ?? undefined,
    phoneType: row.phone_type ?? undefined,
    fieldOfStudy: row.field_of_study ?? undefined,
    educationStartMonth: row.education_start_month ?? undefined,
    highSchoolName: row.high_school_name ?? undefined,
    highSchoolStartYear: row.high_school_start_year ?? undefined,
    highSchoolEndYear: row.high_school_end_year ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFact(row: FactRow): CandidateFact {
  return candidateFactSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    key: row.key,
    scope: JSON.parse(row.scope_json),
    value: JSON.parse(row.value_json),
    valueType: row.value_type,
    source: row.source,
    sourceDetail: JSON.parse(row.source_detail_json),
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    reusePolicy: row.reuse_policy,
    rememberedAt: row.remembered_at,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
    supersededById: row.superseded_by_id,
    revokedAt: row.revoked_at
  });
}
