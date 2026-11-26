import type { DatabaseSync } from "node:sqlite";

import { getCurrentFact, getCurrentFacts } from "@internship-agent/db";
import {
  candidateFactSchema,
  exportControlCategory,
  factDefinitions,
  formatFactValue,
  mentionsCompany,
  postingPayAnswer,
  restrictiveCovenantActive,
  SAN_FRANCISCO,
  scopeKey,
  type CandidateFact,
  type CandidateFactKey,
  type CandidateFactValue,
  type ExportControlCategory,
  type FactScope,
  type MappedQuestion,
  type QuestionContext,
  type QuestionResolution,
  type StandardAnswersFile
} from "@internship-agent/domain";

import type { FactFile } from "./profile-facts";

/**
 * Resolve-time rules for the candidate's standard legal and background
 * answers: the six answers built from saved facts (U.S. person, U.S. citizen
 * or national, U.S. citizen or permanent resident, F-1 OPT (only ever No, from
 * a saved U.S. citizenship or citizen/national or permanent-resident status),
 * the unrestricted right to work in the United States (Yes from a saved U.S.
 * citizenship or citizen/national or permanent-resident status, No from a saved
 * No to U.S. work authorization, never from work authorization alone), and the
 * salary rule), the
 * non-solicitation agreement's end date (after it, the agreement answers No
 * and its explanation is not used), and the guard that never lets the
 * explanation name a former employer. Every answer comes from the
 * candidate's saved facts; a missing one asks the candidate. Reasons never
 * contain saved values or employer names.
 */

const NOTE = "Standard legal and background answers given by the candidate (pnpm profile:facts).";

type Lookup = {
  question: string;
  mapping: MappedQuestion;
};

function needs(lookup: Lookup, reason: string): QuestionResolution {
  return { status: "NEEDS_INPUT", question: lookup.question, mapping: lookup.mapping, reason };
}

function resolved(lookup: Lookup, fact: CandidateFact): QuestionResolution {
  return { status: "RESOLVED", question: lookup.question, mapping: lookup.mapping, fact, displayAnswer: formatFactValue(fact.value) };
}

function withValue(fact: CandidateFact, value: CandidateFactValue): CandidateFact {
  return candidateFactSchema.parse({ ...fact, value });
}

/** A schema-valid fact built from saved facts; never a candidate_facts row. */
function derived(candidateId: string, key: CandidateFactKey, value: CandidateFactValue, base: CandidateFact, note: string): CandidateFact {
  const definition = factDefinitions[key];
  return candidateFactSchema.parse({
    id: `derived:${key}`,
    candidateId,
    key,
    scope: { kind: "global" },
    value,
    valueType: definition.valueType,
    source: "user",
    sourceDetail: { kind: "profile", question: note },
    confidence: 1,
    sensitivity: definition.sensitivity,
    reusePolicy: definition.reusePolicy,
    rememberedAt: base.rememberedAt,
    createdAt: base.createdAt,
    supersededAt: null,
    supersededById: null,
    revokedAt: null
  });
}

/** True when the text names a company a current saved fact says the candidate worked at. */
export function formerEmployerNamed(database: DatabaseSync, candidateId: string, text: string): boolean {
  return getCurrentFacts(database, candidateId).some((fact) =>
    fact.key === "previously_worked_here" && fact.value === true && fact.scope.kind === "company" && mentionsCompany(text, fact.scope.name)
  );
}

/**
 * The answer for a standard key that needs a rule beyond the saved fact's own
 * value, or null for keys the normal lookup answers.
 */
export function resolveStandardAnswer(
  database: DatabaseSync,
  candidateId: string,
  question: string,
  mapping: MappedQuestion,
  context: QuestionContext,
  today: string
): QuestionResolution | null {
  const lookup: Lookup = { question, mapping };
  const read = new Map<string, CandidateFact | null>();
  const get = (key: CandidateFactKey, scope: FactScope = { kind: "global" }): CandidateFact | null => {
    const id = `${key}|${scopeKey(scope)}`;
    if (!read.has(id)) read.set(id, getCurrentFact(database, candidateId, key, scope));
    return read.get(id) ?? null;
  };
  const result = resolveRule(database, candidateId, lookup, context, today, get);
  if (!result) return null;
  // Mirrors the normal lookup: a fact whose reuse policy is not "auto" is confirmed directly.
  const confirm = [...read.values()].find((fact) => fact && fact.reusePolicy !== "auto");
  if (confirm) {
    return {
      status: "REQUIRES_CONFIRMATION",
      question,
      reason: "This fact's reuse policy requires direct confirmation.",
      policy: "fact_policy",
      fact: confirm
    };
  }
  return result;
}

function exportCategoryOf(fact: CandidateFact | null): ExportControlCategory | null {
  return fact && typeof fact.value === "string" ? exportControlCategory(fact.value) : null;
}

function resolveRule(
  database: DatabaseSync,
  candidateId: string,
  lookup: Lookup,
  context: QuestionContext,
  today: string,
  get: (key: CandidateFactKey, scope?: FactScope) => CandidateFact | null
): QuestionResolution | null {
  const key = lookup.mapping.key;
  const make = (value: CandidateFactValue, base: CandidateFact, note: string) => resolved(lookup, derived(candidateId, key, value, base, note));
  const noExport = "No export-control status is saved; the candidate adds it with pnpm profile:facts.";

  if (key === "us_person") {
    const status = get("us_person_export_controls");
    const category = exportCategoryOf(status);
    if (!status || !category) return needs(lookup, noExport);
    return make(category !== "none", status, "Built from your saved export-control status.");
  }

  if (key === "us_citizen_or_national") {
    const citizen = get("us_citizen");
    if (citizen?.value === true) return make(true, citizen, "Built from your saved U.S. citizenship answer.");
    const status = get("us_person_export_controls");
    const category = exportCategoryOf(status);
    if (!status || !category) return needs(lookup, noExport);
    return make(category === "citizen_or_national", status, "Built from your saved export-control status.");
  }

  if (key === "us_citizen_or_permanent_resident") {
    const citizen = get("us_citizen");
    if (citizen?.value === true) return make(true, citizen, "Built from your saved U.S. citizenship answer.");
    const status = get("us_person_export_controls");
    const category = exportCategoryOf(status);
    if (!status || !category) return needs(lookup, noExport);
    if (category === "permanent_resident") return make(true, status, "Built from your saved export-control status.");
    if (category === "citizen_or_national") {
      // A U.S. national who is not a citizen is neither; without the citizenship answer it is unknown.
      if (citizen?.value === false) return make(false, status, "Built from your saved citizenship answer and export-control status.");
      return needs(lookup, "No U.S. citizenship answer is saved; the candidate adds it with pnpm profile:facts.");
    }
    return make(false, status, "Built from your saved export-control status.");
  }

  if (key === "f1_optional_practical_training") {
    // OPT and its STEM extension exist only for F-1 students; a U.S. citizen, national, or permanent resident has neither.
    const citizen = get("us_citizen");
    if (citizen?.value === true) return make(false, citizen, "Built from your saved U.S. citizenship answer (OPT is for F-1 students).");
    const status = get("us_person_export_controls");
    const category = exportCategoryOf(status);
    if (status && (category === "citizen_or_national" || category === "permanent_resident")) {
      return make(false, status, "Built from your saved export-control status (OPT is for F-1 students).");
    }
    return needs(lookup, "Your saved answers do not say whether you are on or eligible for F-1 OPT; answer it directly.");
  }

  if (key === "unrestricted_us_work_authorization") {
    // Citizens, nationals, and permanent residents may work in the United States without restriction; a saved No to U.S. work authorization is a No.
    const citizen = get("us_citizen");
    const status = get("us_person_export_controls");
    const category = exportCategoryOf(status);
    const unrestricted = citizen?.value === true ? citizen
      : status && (category === "citizen_or_national" || category === "permanent_resident") ? status : null;
    const authorized = get("authorized_to_work", { kind: "country", code: "US" });
    if (authorized?.value === false) {
      return unrestricted
        ? needs(lookup, "Your saved answers disagree about working in the United States; answer it directly.")
        : make(false, authorized, "Built from your saved U.S. work authorization answer.");
    }
    if (unrestricted) {
      return make(true, unrestricted, unrestricted === citizen ? "Built from your saved U.S. citizenship answer." : "Built from your saved export-control status.");
    }
    return needs(lookup, "Your saved answers do not say whether your right to work in the United States is unrestricted; answer it directly.");
  }

  if (key === "salary_expectation") {
    const rule = get("salary_expectation_rule");
    if (!rule) return needs(lookup, "No salary rule is saved.");
    const answer = postingPayAnswer(context.postingPay, { fieldKind: context.fieldKind, question: lookup.question });
    if (answer.kind === "hold") return needs(lookup, answer.reason);
    return make(answer.text, rule, "Your salary rule: the posting's stated pay as an hourly figure.");
  }

  if (key === "non_solicitation") {
    const agreement = get("non_solicitation");
    if (!agreement) return needs(lookup, "No non-solicitation answer is saved.");
    if (agreement.value !== true) return resolved(lookup, agreement);
    const ends = get("non_solicitation_ends");
    if (!ends || typeof ends.value !== "string") return needs(lookup, "The non-solicitation agreement's end date is not saved.");
    return resolved(lookup, restrictiveCovenantActive(ends.value, today) ? agreement : withValue(agreement, false));
  }

  if (key === "non_solicitation_explanation") {
    const agreement = get("non_solicitation");
    const ends = get("non_solicitation_ends");
    const active = agreement?.value === true && typeof ends?.value === "string" && restrictiveCovenantActive(ends.value, today);
    if (!active) return needs(lookup, "The saved non-solicitation agreement has ended or is not saved; its explanation is not used.");
    const explanation = get("non_solicitation_explanation");
    if (!explanation || typeof explanation.value !== "string") return needs(lookup, "No non-solicitation explanation is saved.");
    if (formerEmployerNamed(database, candidateId, explanation.value)) {
      return needs(lookup, "The saved explanation names a former employer; answer it directly.");
    }
    return resolved(lookup, explanation);
  }

  if (key === "non_compete_or_non_solicitation") {
    const agreement = get("non_solicitation");
    const combined = get("non_compete_or_non_solicitation");
    if (agreement?.value === true) {
      const ends = get("non_solicitation_ends");
      if (!ends || typeof ends.value !== "string") return needs(lookup, "The non-solicitation agreement's end date is not saved.");
      if (restrictiveCovenantActive(ends.value, today)) {
        return combined ? resolved(lookup, combined) : needs(lookup, "No answer for a combined non-compete or non-solicitation question is saved.");
      }
      // After the end date only the non-compete answer is left.
      const nonCompete = get("non_compete");
      return nonCompete ? resolved(lookup, nonCompete) : needs(lookup, "No non-compete answer is saved.");
    }
    return combined ? resolved(lookup, combined) : needs(lookup, "No answer for a combined non-compete or non-solicitation question is saved.");
  }

  if (key === "non_solicitation_restricts_this_job") {
    const agreement = get("non_solicitation");
    if (!agreement) return needs(lookup, "No non-solicitation answer is saved.");
    const restricts = get("non_solicitation_restricts_this_job");
    if (agreement.value === true) {
      const ends = get("non_solicitation_ends");
      if (!ends || typeof ends.value !== "string") return needs(lookup, "The non-solicitation agreement's end date is not saved.");
      if (restrictiveCovenantActive(ends.value, today)) {
        return restricts ? resolved(lookup, restricts) : needs(lookup, "No answer to whether the agreement restricts this role is saved.");
      }
      return resolved(lookup, withValue(restricts ?? agreement, false));
    }
    return resolved(lookup, restricts ?? withValue(agreement, false));
  }

  return null;
}

/** The standard answers file as profile:facts entries (source "user", provenance notes); preferred_first_name goes to the profile instead. */
export function standardAnswerFactFile(file: StandardAnswersFile): FactFile {
  const nonSolicitation = file.non_solicitation;
  const agreementNote = `${NOTE} Confirmed: ${nonSolicitation.confirmed}`.slice(0, 500);
  const global = { kind: "global" } as const;
  const fact = (key: FactFile["facts"][number]["key"], value: CandidateFactValue, note = NOTE) => ({ key, scope: global, value, note });
  return {
    facts: [
      fact("us_citizen", file.us_citizen),
      fact("us_person_export_controls", file.us_person_export_controls),
      fact("security_clearance_eligible", file.security_clearance_eligible),
      fact("holds_security_clearance", file.holds_security_clearance),
      fact("criminal_conviction", file.criminal_conviction),
      fact("government_debarment_or_exclusion", file.government_debarment_or_exclusion),
      fact("non_compete", file.non_compete),
      fact("non_solicitation", nonSolicitation.answer, agreementNote),
      ...(nonSolicitation.answer
        ? [
          fact("non_solicitation_ends", nonSolicitation.ends, agreementNote),
          fact("non_solicitation_explanation", nonSolicitation.explanation, agreementNote),
          fact("non_solicitation_restricts_this_job", nonSolicitation.agreement_restricts_this_job, agreementNote)
        ]
        : []),
      fact("non_compete_or_non_solicitation", nonSolicitation.combined_non_compete_or_non_solicit_question, agreementNote),
      fact("conflict_of_interest", file.conflict_of_interest),
      fact("relative_government_official", file.relative_government_official),
      fact("immediate_family_health_care_professional", file.immediate_family_health_care_professional),
      { key: "lives_within_50_miles", scope: { kind: "location", name: SAN_FRANCISCO }, value: file.lives_within_50_miles_of_san_francisco, note: NOTE },
      fact("salary_expectation_rule", "posting_pay_hourly"),
      fact("concerns_working_on_dod_projects", file.concerns_working_on_dod_projects)
    ],
    revoke: []
  };
}
