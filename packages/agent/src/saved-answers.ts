import type { DatabaseSync } from "node:sqlite";

import { getCurrentFact } from "@internship-agent/db";
import {
  selfIdentificationKeys,
  type CandidateFact,
  type JobLocation,
  type JobPosting,
  type QuestionContext,
  type SelfIdentificationAnswers
} from "@internship-agent/domain";
import { readPlace } from "@internship-agent/jobs";

/**
 * The posting's employer, its one stated country, its cities with their
 * countries, and its stated pay, for company- and country-scoped answers,
 * U.S.-wide relocation (Track 62: a named city is inside the United States
 * only when the posting's place of that name is), and the salary rule. A
 * location's country is its stored code, else the one country its region or
 * location text names ("Fixture City, FL" is US). A posting in several
 * countries, or none known, gives no country, so authorization and
 * sponsorship questions without a country keep pausing.
 */
export function postingQuestionContext(
  posting: Pick<JobPosting, "companyName" | "locations"> & Partial<Pick<JobPosting, "compensation">> | null | undefined
): QuestionContext {
  if (!posting) return {};
  const countries = [...new Set(posting.locations.map(locationCountry).filter((code): code is string => Boolean(code)))];
  const pay = posting.compensation;
  const places = posting.locations.flatMap((location) => {
    const city = location.city?.trim();
    const countryCode = locationCountry(location);
    return city && countryCode ? [{ city, countryCode }] : [];
  }).slice(0, 50);
  return {
    companyName: posting.companyName,
    ...(countries.length === 1 ? { postingCountryCode: countries[0]! } : {}),
    ...(places.length > 0 ? { postingPlaces: places } : {}),
    ...(pay ? { postingPay: { minimum: pay.minimum, maximum: pay.maximum, currency: pay.currency, period: pay.period } } : {})
  };
}

/** The posting's places as "City, Region" (else the stated text), for "are you located in or near the city" options. */
export function postingLocationNames(posting: Pick<JobPosting, "locations"> | null | undefined): string[] {
  return (posting?.locations ?? []).map((location) => location.city && location.region ? `${location.city}, ${location.region}` : location.raw);
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

/**
 * Whether the candidate's saved U.S. citizenship settles a work-authorization Yes (Track 62; the candidate's
 * statement, 2026-11-27: "I am a citizen"): the fact is a Yes to U.S. work authorization (or the derived unrestricted
 * U.S. right to work), and the current global `us_citizen` fact is a Yes the candidate saved for automatic reuse.
 * Only then may the planner pick the one option citizenship makes true.
 */
export function usCitizenSettles(database: DatabaseSync, candidateId: string, fact: CandidateFact): boolean {
  if (fact.value !== true) return false;
  const authorization = (fact.key === "authorized_to_work" && fact.scope.kind === "country" && fact.scope.code.toUpperCase() === "US")
    || fact.key === "unrestricted_us_work_authorization";
  if (!authorization) return false;
  const citizen = getCurrentFact(database, candidateId, "us_citizen", { kind: "global" });
  return citizen !== null && citizen.value === true && citizen.source === "user" && citizen.reusePolicy === "auto";
}
