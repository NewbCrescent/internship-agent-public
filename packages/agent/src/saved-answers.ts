import type { DatabaseSync } from "node:sqlite";

import { getCurrentFact } from "@internship-agent/db";
import {
  selfIdentificationKeys,
  type JobPosting,
  type QuestionContext,
  type SelfIdentificationAnswers
} from "@internship-agent/domain";

/** The posting's employer and its one stated country, for company- and country-scoped answers. */
export function postingQuestionContext(posting: Pick<JobPosting, "companyName" | "locations"> | null | undefined): QuestionContext {
  if (!posting) return {};
  const countries = [...new Set(posting.locations.map((location) => location.countryCode).filter((code): code is string => Boolean(code)))];
  return {
    companyName: posting.companyName,
    ...(countries.length === 1 ? { postingCountryCode: countries[0]!.toUpperCase() } : {})
  };
}

/**
 * The candidate's saved voluntary self-identification answers; only the EEO
 * option matcher reads them. Never logged, never sent to a model.
 */
export function savedSelfIdentification(database: DatabaseSync, candidateId: string): SelfIdentificationAnswers {
  const answers: SelfIdentificationAnswers = {};
  for (const key of selfIdentificationKeys) {
    const fact = getCurrentFact(database, candidateId, key, { kind: "global" });
    if (fact && fact.source === "user" && fact.reusePolicy === "auto" && typeof fact.value === "string") answers[key] = fact.value;
  }
  return answers;
}
