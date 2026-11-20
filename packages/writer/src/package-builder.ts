import { randomUUID } from "node:crypto";

import type {
  ApplicationPackage,
  CandidateFact,
  CandidatePreference,
  CandidateProfileInput,
  JobPosting,
  ResumeBullet,
  ResumeEntry,
  TailoredAnswer
} from "@internship-agent/domain";
import { applicationPackageSchema, resumeSkillsLine } from "@internship-agent/domain";

import { extractClaims } from "./claim-extractor";

/** An ALLOWED + CURRENT evidence claim, as handed to the writer. */
export type UsableClaim = {
  id: string;
  kind: "project" | "technology" | "skill" | "metric";
  normalizedKey: string;
  text: string;
};

export type PackageInputs = {
  facts: CandidateFact[];
  preferences: CandidatePreference | null;
  profile: CandidateProfileInput & { id: string };
  /** Only ALLOWED + CURRENT claims; anything else is dropped, never used. */
  evidenceClaims: UsableClaim[];
  /**
   * The candidate's resume entries in display order. Only active entries
   * whose current revision is APPROVED become resume bullets.
   */
  resumeEntries: ResumeEntry[];
};

/** Where a resume bullet came from: an entry's exact revision. */
export type ResumeBulletOrigin = { entryId: string; revisionId: string };

export type PackageDraft = {
  package: ApplicationPackage;
  /** Fact keys the package wanted but the candidate has not recorded. */
  missingFacts: string[];
};

const MAX_RELEVANT_CLAIMS = 8;

/**
 * Deterministic application assembly. Every factual sentence is built from
 * an explicit fact, an allowed evidence claim, or a posting quotation, and
 * the claim ledger records which. The writer never paraphrases a metric and
 * never invents experience, credentials, dates, or authorization status.
 */
export function buildApplicationPackage(
  posting: JobPosting,
  inputs: PackageInputs,
  createdAt = new Date().toISOString()
): PackageDraft {
  const packageId = randomUUID();
  const evidenceClaims = inputs.evidenceClaims;
  const relevant = selectRelevantClaims(posting, evidenceClaims);
  const resumeEntries = approvedEntries(inputs.resumeEntries);
  const { bullets, origins } = buildBullets(resumeEntries);
  const { answers, missingFacts } = buildAnswers(posting, inputs, relevant);
  const summary = buildSummary(posting, inputs, relevant);
  const ledger = extractClaims({ packageId, summary, answers, bullets, origins, resumeEntries, posting, inputs, relevant });
  for (const answer of answers) {
    answer.claimIds = ledger.answerClaims.get(answer.id) ?? [];
  }
  for (const bullet of bullets) {
    bullet.claimIds = ledger.bulletClaims.get(bullet.id) ?? [];
  }

  const draft = { package: applicationPackageSchema.parse({
    id: packageId,
    jobId: posting.id,
    createdAt,
    summary,
    answers,
    bullets,
    claims: ledger.claims
  }), missingFacts };
  return draft;
}

function selectRelevantClaims(posting: JobPosting, claims: UsableClaim[]): UsableClaim[] {
  const techKeys = posting.technologies.map((technology) =>
    technology.normalizedKey.toLocaleLowerCase("en-US")
  );
  const scored = claims.map((claim) => {
    const haystack = `${claim.normalizedKey} ${claim.text}`.toLocaleLowerCase("en-US");
    const overlap = techKeys.filter((key) => haystack.includes(key.replace(/-/g, " "))).length;
    const metricBoost = claim.kind === "metric" ? 0.5 : 0;
    return { claim, score: overlap * 2 + metricBoost };
  });
  scored.sort((a, b) => b.score - a.score || a.claim.text.localeCompare(b.claim.text));
  const relevant = scored.filter((entry) => entry.score > 0).map((entry) => entry.claim);
  const fallback = scored.filter((entry) => entry.score === 0).map((entry) => entry.claim);
  return [...relevant, ...fallback].slice(0, MAX_RELEVANT_CLAIMS);
}

/** Entries printed on the resume, so package bullets always match the PDF sent. */
export function approvedEntries(entries: ResumeEntry[]): ResumeEntry[] {
  return entries.filter((entry) => entry.archivedAt === null && entry.onResume !== false && entry.current.reviewStatus === "APPROVED");
}

/**
 * Resume bullets are the candidate's approved entry lines, verbatim and in
 * the candidate's order: every experience and project bullet, and one line
 * per skills group. Evidence claims never become resume bullets.
 */
function buildBullets(entries: ResumeEntry[]): { bullets: ResumeBullet[]; origins: Map<string, ResumeBulletOrigin> } {
  const bullets: ResumeBullet[] = [];
  const origins = new Map<string, ResumeBulletOrigin>();
  for (const entry of entries) {
    const lines = entry.section === "skills" ? [resumeSkillsLine(entry.current)] : entry.current.bullets;
    for (const text of lines) {
      const bullet: ResumeBullet = { id: randomUUID(), text, claimIds: [] };
      bullets.push(bullet);
      origins.set(bullet.id, { entryId: entry.id, revisionId: entry.current.id });
    }
  }
  return { bullets, origins };
}

function buildAnswers(
  posting: JobPosting,
  inputs: PackageInputs,
  relevant: UsableClaim[]
): { answers: TailoredAnswer[]; missingFacts: string[] } {
  const answers: TailoredAnswer[] = [];
  const missingFacts: string[] = [];

  const location = posting.locations[0];
  const stack = posting.technologies.slice(0, 4).map((technology) => technology.label).join(", ");
  const top = relevant.slice(0, 3);
  // Only point at experience that the package actually describes.
  const posted = location ? `The ${location.raw} posting` : "The posting";
  const stackSentence = stack
    ? `${posted} names ${stack}${top.length > 0 ? ", which matches the experience described below" : ""}.`
    : null;
  answers.push({
    id: randomUUID(),
    prompt: "Why are you interested in this role?",
    text: [`I am applying for the ${posting.title} role at ${posting.companyName}.`, stackSentence]
      .filter((sentence): sentence is string => Boolean(sentence))
      .join(" "),
    claimIds: []
  });

  if (top.length > 0) {
    answers.push({
      id: randomUUID(),
      prompt: "Describe your most relevant experience.",
      text: `Relevant experience: ${top.map((claim) => claim.text.slice(0, 200)).join(" ")}`,
      claimIds: []
    });
  }

  const auth = findFact(inputs.facts, "authorized_to_work");
  const sponsorship = findFact(inputs.facts, "requires_sponsorship");
  const start = findFact(inputs.facts, "available_start_date");
  const missing = [
    auth ? null : "authorized_to_work",
    sponsorship ? null : "requires_sponsorship",
    start ? null : "available_start_date"
  ].filter((key): key is string => key !== null);
  missingFacts.push(...missing);
  if (missing.length === 0 && auth && sponsorship && start) {
    answers.push({
      id: randomUUID(),
      prompt: "What is your work authorization and availability?",
      text: [
        `I am ${auth.value === true ? "" : "not "}authorized to work`,
        `and ${sponsorship.value === true ? "require" : "do not require"} employment sponsorship.`,
        `I am available to start ${String(start.value)}.`
      ].join(" ").replace("  ", " "),
      claimIds: []
    });
  }

  return { answers, missingFacts };
}

function buildSummary(
  posting: JobPosting,
  inputs: PackageInputs,
  relevant: UsableClaim[]
): string {
  const evidenced = relevant.filter((claim) => claim.kind === "technology" || claim.kind === "skill").length;
  const role = inputs.preferences?.roleTypes[0];
  return [
    `Application for ${posting.title} at ${posting.companyName}.`,
    evidenced > 0
      ? `${evidenced} evidenced ${evidenced === 1 ? "strength" : "strengths"} overlap the posting's stack.`
      : "No posting technology is backed by verified evidence yet.",
    role ? `The posting title fits the candidate's ${role} preference.` : "Role fit was not compared to a preference."
  ].join(" ");
}

function findFact(facts: CandidateFact[], key: string): CandidateFact | undefined {
  return facts.find((fact) => fact.key === key);
}
