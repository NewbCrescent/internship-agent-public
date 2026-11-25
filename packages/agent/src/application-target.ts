import type { DatabaseSync } from "node:sqlite";

import { getJobPosting, getSemanticFit } from "@internship-agent/db";
import { judgeFit, judgeTargetPosting, parseTargetTerm, type TargetDecision, type TargetTerm } from "@internship-agent/domain";
import { isHandshakeHost } from "@internship-agent/jobs";

/** INTERNSHIP_AGENT_TARGET_TERM (for example summer-2027); unset, nothing is narrowed. */
export function targetTerm(env: Record<string, string | undefined> = process.env): TargetTerm | null {
  return parseTargetTerm(env.INTERNSHIP_AGENT_TARGET_TERM);
}

/** The text-only target steps (source, term, role, location, pay) for a stored posting. */
export function postingTargetDecision(database: DatabaseSync, jobId: string, term: TargetTerm): TargetDecision {
  const posting = getJobPosting(database, jobId);
  if (!posting) return { outcome: "skip", reasons: ["The posting is unknown."] };
  return judgeTargetPosting({
    title: posting.title,
    text: posting.snapshot.normalizedText,
    employmentType: posting.employmentType,
    countryCodes: posting.locations.map((location) => location.countryCode).filter((code): code is string => Boolean(code)),
    compensation: posting.compensation,
    onHandshake: posting.source.applicationType === "HANDSHAKE_INTERNAL" ||
      [posting.source.sourceUrl, posting.source.externalApplicationUrl].some((url) => url !== null && isHandshakeHost(url))
  }, term);
}

/** The AI step over the current (never stale) assessment. */
export function fitTargetDecision(database: DatabaseSync, jobId: string, minFit: number): TargetDecision {
  const cached = getSemanticFit(database, jobId);
  return judgeFit(cached && !cached.stale ? cached.assessment : null, minFit);
}
