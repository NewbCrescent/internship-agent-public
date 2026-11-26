import type { DatabaseSync } from "node:sqlite";

import {
  getCandidate,
  getCandidatePreferences,
  getCurrentFacts,
  getDatabase,
  getJobMatch,
  getSemanticFit,
  getSemanticFitFailure,
  replaceJobFit,
  getJobPosting,
  getRequirementLabelHold,
  listProjectEvidenceProfiles,
  listResumeEntries,
  LOCAL_CANDIDATE_ID,
  saveJobMatch
} from "@internship-agent/db";
import { extractDeterministically, normalizePostingText, RequirementLabelsPendingError } from "@internship-agent/jobs";
import { canonicalSkillKey, evaluateJobMatch } from "@internship-agent/matching";
import type { JobMatchReport } from "@internship-agent/domain";

export const DEFAULT_CANDIDATE_ID = LOCAL_CANDIDATE_ID;

export type MatchEvaluation = {
  report: JobMatchReport;
  /** Normalized technology keys with ALLOWED + CURRENT claim backing. */
  evidencedTechnologies: string[];
  /** Skills the candidate's approved resume entries name. */
  resumeSkills: string[];
  allowedClaimCount: number;
};

/**
 * Skills the Resume tab states: every item of an approved skills line
 * ("AWS (EC2, ECS, S3)" gives AWS, EC2, ECS, S3; "Linux/Unix" gives both),
 * plus the technologies an approved role or bullet names, read with the same
 * dictionary postings use. Library-only entries count (they are still the
 * candidate's own approved content); pending and archived entries do not.
 */
export function resumeSkillsFor(database: DatabaseSync, candidateId: string): string[] {
  const skills = new Map<string, string>();
  const add = (skill: string) => {
    const trimmed = skill.trim();
    if (trimmed && trimmed.length <= 40) skills.set(trimmed.toLocaleLowerCase("en-US"), trimmed);
  };
  for (const entry of listResumeEntries(database, candidateId)) {
    if (entry.archivedAt || entry.current.reviewStatus !== "APPROVED") continue;
    if (entry.section === "skills") {
      for (const item of entry.current.bullets) item.split(/[()/,]/).forEach(add);
      continue;
    }
    const prose = [entry.current.role, ...entry.current.bullets].filter(Boolean).join("\n");
    for (const technology of extractDeterministically(normalizePostingText(prose)).technologies) add(technology.label);
  }
  return [...skills.values()];
}

/**
 * The evaluation evaluateAndPersistMatch saves, without writing anything;
 * `pnpm matches:reevaluate` reads through it (Track 56). Only ALLOWED +
 * CURRENT claims back skill matching, so questioned or stale evidence never
 * inflates a score.
 */
export function evaluateMatch(
  jobId: string,
  options: { database?: DatabaseSync; candidateId?: string } = {}
): MatchEvaluation {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? DEFAULT_CANDIDATE_ID;
  const posting = getJobPosting(database, jobId);
  if (!posting) throw new Error("The posting is unknown; ingest it before analyzing fit.");
  // A posting waiting for AI requirement labels has none stored; analyzing it
  // would judge eligibility on nothing.
  const hold = getRequirementLabelHold(database, jobId);
  if (hold) throw new RequirementLabelsPendingError(hold.reason);

  const facts = getCurrentFacts(database, candidateId);
  const preferences = getCandidatePreferences(database, candidateId);
  const candidate = getCandidate(database, candidateId);
  const candidateDegree = candidate?.degree ?? null;
  const candidateField = candidate?.fieldOfStudy ?? null;
  const candidateSchool = candidate?.school ?? null;
  const profiles = listProjectEvidenceProfiles(database, candidateId);
  const evidenced = new Set<string>();
  let allowedClaimCount = 0;
  for (const profile of profiles) {
    for (const claim of profile.claims) {
      if (claim.reviewStatus !== "ALLOWED" || claim.freshness !== "CURRENT") continue;
      allowedClaimCount += 1;
      if (claim.kind === "technology" || claim.kind === "skill") {
        evidenced.add(canonicalSkillKey(claim.normalizedKey));
      }
    }
  }
  // Only technology/skill claims count toward technology overlap. Project and
  // metric claims support the application narrative (Milestone 5) but never
  // inflate a skill score on their own.
  const evidencedTechnologies = [...evidenced];
  // The candidate chose to let their resume meet hard skill requirements.
  const resumeSkills = resumeSkillsFor(database, candidateId);

  const report = evaluateJobMatch(
    posting,
    { facts, preferences, candidateDegree, candidateField, candidateSchool, evidencedTechnologies, resumeSkills, allowedClaimCount }
  );
  return { report, evidencedTechnologies, resumeSkills, allowedClaimCount };
}

/**
 * The Milestone 4 orchestration seam: the dashboard action calls here. It
 * saves evaluateMatch's report (only the fit with fitOnly).
 */
export function evaluateAndPersistMatch(
  jobId: string,
  options: { database?: DatabaseSync; candidateId?: string; fitOnly?: boolean } = {}
): MatchEvaluation {
  const database = options.database ?? getDatabase();
  const evaluation = evaluateMatch(jobId, { database, candidateId: options.candidateId });
  if (options.fitOnly) replaceJobFit(database, evaluation.report);
  else saveJobMatch(database, evaluation.report);
  return evaluation;
}

export function getMatchReport(
  jobId: string,
  database: DatabaseSync = getDatabase()
) {
  const match = getJobMatch(database, jobId);
  if (!match) return null;
  const semantic = getSemanticFit(database, jobId);
  return { ...match, semantic, aiFailure: getSemanticFitFailure(database, jobId), heuristicFitScore: match.fitScore, fitScore: semantic && !semantic.stale ? semantic.assessment.score : match.fitScore, displayFitScore: semantic && !semantic.stale ? semantic.assessment.score : match.fitScore };
}
