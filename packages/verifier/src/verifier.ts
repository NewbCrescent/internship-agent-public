import type { DatabaseSync } from "node:sqlite";

import { getDatabase, getJobPosting, getResumeEntry, LOCAL_CANDIDATE_ID } from "@internship-agent/db";
import type {
  ApplicationPackage,
  ClaimCheck,
  VerificationReport
} from "@internship-agent/domain";
import { resumeEntryHeading, resumeSkillsLine, verificationReportSchema } from "@internship-agent/domain";

/**
 * The independent verification pass. It re-reads evidence, facts, and the
 * posting from the database rather than trusting the writer's inputs, so a
 * stale package (superseded fact, changed evidence, revised posting) cannot
 * slip through on the writer's word alone.
 *
 * - SUPPORTED: the basis is current and the numbers line up.
 * - CONTESTED: the basis moved under the package, or a number in the claim
 *   has no match in its basis (the `15x` versus evidenced `~10x` rule).
 * - UNSUPPORTED: the basis is gone, was never allowed, or a "presentation"
 *   sentence smuggles a number.
 *
 * Any CONTESTED or UNSUPPORTED check blocks READY_FOR_REVIEW.
 */
export function verifyApplicationPackage(
  package_: ApplicationPackage,
  options: { database?: DatabaseSync; candidateId?: string; verifiedAt?: string } = {}
): VerificationReport {
  const database = options.database ?? getDatabase();
  const candidateId = options.candidateId ?? LOCAL_CANDIDATE_ID;
  const verifiedAt = options.verifiedAt ?? new Date().toISOString();
  const posting = getJobPosting(database, package_.jobId);
  const checks: ClaimCheck[] = package_.claims.map((claim) =>
    checkClaim(database, package_, candidateId, claim, posting?.snapshot.normalizedText ?? null, {
      title: posting?.title ?? null,
      companyName: posting?.companyName ?? null
    })
  );
  const blocked = checks.some((check) => check.verdict !== "SUPPORTED");
  return verificationReportSchema.parse({
    packageId: package_.id,
    jobId: package_.jobId,
    verifiedAt,
    checks,
    blocked
  });
}

type Claim = ApplicationPackage["claims"][number];

function checkClaim(
  database: DatabaseSync,
  package_: ApplicationPackage,
  candidateId: string,
  claim: Claim,
  snapshotText: string | null,
  postingMeta: { title: string | null; companyName: string | null }
): ClaimCheck {
  const fail = (reason: string): ClaimCheck => ({ claimId: claim.id, verdict: "UNSUPPORTED", reason });
  const contest = (reason: string): ClaimCheck => ({ claimId: claim.id, verdict: "CONTESTED", reason });
  const pass = (reason: string): ClaimCheck => ({ claimId: claim.id, verdict: "SUPPORTED", reason });

  if (claim.basis.kind === "presentation") {
    if (claimNumbers(claim.text).length > 0) {
      return fail("A presentation sentence must not carry numbers; this one smuggles a factual assertion.");
    }
    return pass("Presentation carries no factual assertion.");
  }

  if (claim.basis.kind === "posting") {
    if (!snapshotText) return fail("The posting is gone, so its quotation cannot be checked.");
    const excerpt = claim.basis.excerpt;
    if (excerpt === postingMeta.title || excerpt === postingMeta.companyName) {
      return pass("The quotation matches current ingestion metadata exactly.");
    }
    if (!snapshotText.includes(excerpt)) {
      return fail("The posting no longer contains this quotation; it was revised after the package was built.");
    }
    return pass("The quotation is present in the current posting snapshot.");
  }

  if (claim.basis.kind === "resume_entry") {
    const entry = getResumeEntry(database, claim.basis.entryId);
    if (!entry || entry.candidateId !== candidateId) return fail("The resume entry behind this line no longer exists.");
    if (entry.archivedAt !== null) return fail("The resume entry behind this line was archived.");
    if (entry.current.id !== claim.basis.revisionId) {
      return contest("The resume entry was edited after this package was built; rebuild before review.");
    }
    if (entry.current.reviewStatus !== "APPROVED") return fail("The resume entry is still pending the candidate's approval.");
    const lines = entry.section === "skills"
      ? [resumeSkillsLine(entry.current)]
      : [resumeEntryHeading({ section: entry.section, ...entry.current }), ...entry.current.bullets];
    if (!lines.includes(claim.text)) return contest("The line no longer matches the candidate's resume entry text.");
    return pass("The line is the candidate's approved resume entry text, verbatim.");
  }

  if (claim.basis.kind === "fact") {
    const row = database.prepare(`
      SELECT value_json, created_at FROM candidate_facts
      WHERE candidate_id = ? AND key = ? AND scope_key = ?
        AND superseded_at IS NULL AND revoked_at IS NULL
    `).get(candidateId, claim.basis.key, claim.basis.scope) as
      { value_json: string; created_at: string } | undefined;
    if (!row) return fail("The candidate fact behind this assertion is missing or was revoked.");
    if (row.created_at > package_.createdAt) {
      return contest("The candidate fact was updated after this package was built; rebuild before review.");
    }
    return pass("The candidate fact is current and user-supplied.");
  }

  // Evidence basis: the CURRENT revision must still be ALLOWED + CURRENT.
  const revision = database.prepare(`
    SELECT cr.text, cr.review_status, cr.freshness, cr.updated_at
    FROM claims c
    JOIN claim_revisions cr ON cr.claim_id = c.id AND cr.superseded_at IS NULL
    WHERE c.id = ?
  `).get(claim.basis.claimId) as
    { text: string; review_status: string; freshness: string; updated_at: string } | undefined;
  if (!revision) return fail("The evidence claim behind this assertion no longer exists.");
  if (revision.review_status !== "ALLOWED" || revision.freshness !== "CURRENT") {
    return fail(`The evidence claim is ${revision.review_status.toLocaleLowerCase("en-US")} and ${revision.freshness.toLocaleLowerCase("en-US")}; only allowed, current evidence grounds writing.`);
  }
  if (revision.updated_at > package_.createdAt) {
    return contest("The evidence claim changed after this package was built; rebuild before review.");
  }
  const basisTexts = [revision.text, ...listEvidenceExcerpts(database, claim.basis.claimId)];
  const stray = claimNumbers(claim.text).filter((number) => !basisTexts.some((basis) =>
    claimNumbers(basis).includes(number)
  ));
  if (stray.length > 0) {
    return contest(
      `The assertion uses ${stray.join(", ")}, which no supporting evidence states; generated metrics must match evidence exactly.`
    );
  }
  return pass("Allowed, current evidence states every number the assertion uses.");
}

function listEvidenceExcerpts(database: DatabaseSync, claimId: string): string[] {
  const rows = database.prepare(`
    SELECT e.excerpt FROM evidence_items e
    JOIN claim_evidence ce ON ce.evidence_id = e.id
    JOIN claim_revisions cr ON cr.id = ce.claim_revision_id
    WHERE cr.claim_id = ? AND cr.superseded_at IS NULL
  `).all(claimId) as Array<{ excerpt: string }>;
  return rows.map((row) => row.excerpt);
}

/** Normalized numeric tokens: `~10x`, `10%`, and `10,000` all reduce to digits. */
export function claimNumbers(text: string): string[] {
  const matches = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((match) => match.replace(/,/g, ""));
}
