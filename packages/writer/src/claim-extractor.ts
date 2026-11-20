import { randomUUID } from "node:crypto";

import type {
  ClaimBasis,
  ExtractedClaim,
  JobPosting,
  ResumeBullet,
  ResumeEntry,
  TailoredAnswer
} from "@internship-agent/domain";
import { resumeEntryHeading, scopeKey } from "@internship-agent/domain";

import type { PackageInputs, ResumeBulletOrigin, UsableClaim } from "./package-builder";

export type ClaimSources = {
  packageId: string;
  summary: string;
  answers: TailoredAnswer[];
  bullets: ResumeBullet[];
  /** Each bullet's source entry revision. */
  origins: Map<string, ResumeBulletOrigin>;
  /** Approved entries whose heading lines the resume asserts. */
  resumeEntries: ResumeEntry[];
  posting: JobPosting;
  inputs: PackageInputs;
  relevant: UsableClaim[];
};

export type ClaimLedger = {
  claims: ExtractedClaim[];
  answerClaims: Map<string, string[]>;
  bulletClaims: Map<string, string[]>;
};

/**
 * Claim extraction for the deterministic writer. Because the writer assembles
 * every factual sentence from a known source, extraction records that source
 * instead of guessing it: each resume line maps to its entry revision, each
 * authorization sentence to its fact, each posting quotation to its excerpt.
 * A future model-backed writer implements the same interface with real NLP.
 */
export function extractClaims(sources: ClaimSources): ClaimLedger {
  const claims: ExtractedClaim[] = [];
  const answerClaims = new Map<string, string[]>();
  const bulletClaims = new Map<string, string[]>();

  const claimByUsableId = new Map<string, ExtractedClaim>();
  for (const usable of sources.relevant) {
    const claim: ExtractedClaim = {
      id: randomUUID(),
      text: usable.text.slice(0, 500),
      basis: { kind: "evidence", claimId: usable.id },
      sourceField: "evidence"
    };
    claims.push(claim);
    claimByUsableId.set(usable.id, claim);
  }

  for (const entry of sources.resumeEntries) {
    if (entry.section === "skills") continue;
    addClaim(claims, {
      text: resumeEntryHeading({ section: entry.section, ...entry.current }).slice(0, 500),
      basis: { kind: "resume_entry", entryId: entry.id, revisionId: entry.current.id },
      sourceField: `resume:${entry.id}`
    });
  }
  for (const bullet of sources.bullets) {
    const origin = sources.origins.get(bullet.id);
    if (!origin) continue;
    bulletClaims.set(bullet.id, [addClaim(claims, {
      text: bullet.text,
      basis: { kind: "resume_entry", entryId: origin.entryId, revisionId: origin.revisionId },
      sourceField: `bullet:${bullet.id}`
    })]);
  }

  for (const answer of sources.answers) {
    const ids: string[] = [];
    if (answer.prompt === "Describe your most relevant experience.") {
      for (const usable of sources.relevant.slice(0, 3)) {
        if (answer.text.includes(usable.text.slice(0, 200))) {
          const claim = claimByUsableId.get(usable.id);
          if (claim) ids.push(claim.id);
        }
      }
    } else if (answer.prompt === "What is your work authorization and availability?") {
      for (const fact of sources.inputs.facts) {
        if (fact.key === "authorized_to_work" || fact.key === "requires_sponsorship" || fact.key === "available_start_date") {
          ids.push(addClaim(claims, {
            text: authorizationClaimText(fact.key, fact.value),
            basis: { kind: "fact", key: fact.key, scope: scopeKey(fact.scope) },
            sourceField: `answer:${answer.id}`
          }));
        }
      }
    } else if (answer.prompt === "Why are you interested in this role?") {
      // Title and company are ingestion metadata, verified by exact field
      // match; only span-backed excerpts are checked against snapshot text.
      ids.push(addClaim(claims, {
        text: `The posting title is ${sources.posting.title}.`,
        basis: { kind: "posting", excerpt: sources.posting.title.trim().slice(0, 600) },
        sourceField: `answer:${answer.id}`
      }));
      ids.push(addClaim(claims, {
        text: `The posting company is ${sources.posting.companyName}.`,
        basis: { kind: "posting", excerpt: sources.posting.companyName.trim().slice(0, 600) },
        sourceField: `answer:${answer.id}`
      }));
      const location = sources.posting.locations[0];
      if (location && answer.text.includes(location.raw)) {
        ids.push(addClaim(claims, {
          text: `The posting location is ${location.raw}.`,
          basis: { kind: "posting", excerpt: location.raw.slice(0, 600) },
          sourceField: `answer:${answer.id}`
        }));
      }
      for (const technology of sources.posting.technologies.slice(0, 4)) {
        if (answer.text.includes(technology.label)) {
          ids.push(addClaim(claims, {
            text: `The posting names ${technology.label}.`,
            basis: { kind: "posting", excerpt: technology.span.excerpt.slice(0, 600) },
            sourceField: `answer:${answer.id}`
          }));
        }
      }
    }
    if (ids.length === 0) {
      ids.push(addClaim(claims, {
        text: answer.text.slice(0, 500),
        basis: { kind: "presentation" },
        sourceField: `answer:${answer.id}`
      }));
    }
    answerClaims.set(answer.id, ids);
  }

  return { claims, answerClaims, bulletClaims };
}

function authorizationClaimText(key: string, value: unknown): string {
  if (key === "authorized_to_work") return `Authorized to work: ${value === true ? "yes" : "no"}.`;
  if (key === "requires_sponsorship") return `Requires sponsorship: ${value === true ? "yes" : "no"}.`;
  return `Available start date: ${String(value)}.`;
}

function addClaim(
  claims: ExtractedClaim[],
  init: { text: string; basis: ClaimBasis; sourceField: string }
): string {
  const claim: ExtractedClaim = { id: randomUUID(), ...init };
  claims.push(claim);
  return claim.id;
}
