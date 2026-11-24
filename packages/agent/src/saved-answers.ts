import type { DatabaseSync } from "node:sqlite";

import { getCurrentFact } from "@internship-agent/db";
import {
  selfIdentificationKeys,
  type JobLocation,
  type JobPosting,
  type QuestionContext,
  type SelfIdentificationAnswers
} from "@internship-agent/domain";
import { readPlace } from "@internship-agent/jobs";

/**
 * The posting's employer, its one stated country, and its stated pay, for
 * company- and country-scoped answers and the salary rule. A location's
 * country is its stored code, else the one country its region or location
 * text names ("Fixture City, FL" is US). A posting in several countries, or
 * none known, gives no country, so authorization and sponsorship questions
 * without a country keep pausing.
 */
export function postingQuestionContext(
  posting: Pick<JobPosting, "companyName" | "locations"> & Partial<Pick<JobPosting, "compensation">> | null | undefined
): QuestionContext {
  if (!posting) return {};
  const countries = [...new Set(posting.locations.map(locationCountry).filter((code): code is string => Boolean(code)))];
  const pay = posting.compensation;
  return {
    companyName: posting.companyName,
    ...(countries.length === 1 ? { postingCountryCode: countries[0]! } : {}),
    ...(pay ? { postingPay: { minimum: pay.minimum, maximum: pay.maximum, currency: pay.currency, period: pay.period } } : {})
  };
}

/** A location's country: the stored code, else the single country its region or text names; null otherwise. */
function locationCountry(location: Pick<JobLocation, "countryCode" | "region" | "raw">): string | null {
  if (location.countryCode) return location.countryCode.toUpperCase();
  const codes = new Set<string>();
  const pieces = [location.region ?? "", ...location.raw.split(/,|\s+-\s+|\s+\|\s+/)];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const reading = readPlace(piece);
    if (reading?.kind === "us-state") codes.add("US");
    else if (reading?.kind === "ca-province") codes.add("CA");
    else if (reading?.kind === "country") codes.add(reading.code);
  }
  return codes.size === 1 ? [...codes][0]! : null;
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
