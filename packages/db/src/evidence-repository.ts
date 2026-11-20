import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  claimReviewInputSchema,
  evidenceClaimSchema,
  evidenceItemSchema,
  projectEvidenceProfileSchema,
  type ClaimKind,
  type ClaimReviewInput,
  type EvidenceItem,
  type EvidenceKind,
  type ProjectEvidenceProfile
} from "@internship-agent/domain";

export type ExtractedEvidenceInput = {
  kind: EvidenceKind;
  commitSha: string;
  path: string;
  startLine: number;
  endLine: number;
  sourceUrl: string;
  excerpt: string;
  excerptHash: string;
};

export type ExtractedClaimInput = {
  kind: ClaimKind;
  normalizedKey: string;
  text: string;
  evidenceFingerprint: string;
  evidence: ExtractedEvidenceInput[];
};

export type ReconcileProjectInput = {
  candidateId: string;
  repositoryId: string;
  name: string;
  summary: string | null;
  claims: ExtractedClaimInput[];
  fullSnapshot: boolean;
  affectedPaths: string[];
};

type ProjectRow = {
  id: string;
  candidate_id: string;
  repository_id: string;
  name: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimRow = {
  claim_id: string;
  revision_id: string;
  project_id: string;
  kind: ClaimKind;
  normalized_key: string;
  text: string;
  review_status: "PENDING" | "ALLOWED" | "QUESTIONED" | "REJECTED";
  freshness: "CURRENT" | "STALE";
  evidence_fingerprint: string;
  created_at: string;
  updated_at: string;
};

type EvidenceRow = {
  id: string;
  repository_id: string;
  kind: EvidenceKind;
  commit_sha: string;
  path: string;
  start_line: number;
  end_line: number;
  source_url: string;
  excerpt: string;
  excerpt_hash: string;
  created_at: string;
};

export function reconcileProjectEvidence(database: DatabaseSync, input: ReconcileProjectInput): string {
  const projectId = upsertProject(database, input);
  const seenClaimIds = new Set<string>();

  if (!input.fullSnapshot && input.affectedPaths.length > 0) {
    const placeholders = input.affectedPaths.map(() => "?").join(", ");
    database.prepare(`
      UPDATE claim_revisions
      SET freshness = 'STALE', updated_at = ?
      WHERE superseded_at IS NULL AND claim_id IN (
        SELECT DISTINCT c.id
        FROM claims c
        JOIN claim_revisions current_revision
          ON current_revision.claim_id = c.id AND current_revision.superseded_at IS NULL
        JOIN claim_evidence ce ON ce.claim_revision_id = current_revision.id
        JOIN evidence_items e ON e.id = ce.evidence_id
        WHERE c.project_id = ? AND e.path IN (${placeholders})
      )
    `).run(new Date().toISOString(), projectId, ...input.affectedPaths);
  }

  for (const candidate of input.claims) {
    let claim = database.prepare(`
      SELECT id FROM claims WHERE project_id = ? AND kind = ? AND normalized_key = ?
    `).get(projectId, candidate.kind, candidate.normalizedKey) as { id: string } | undefined;
    if (!claim) {
      claim = { id: randomUUID() };
      database.prepare(`
        INSERT INTO claims (id, project_id, kind, normalized_key, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(claim.id, projectId, candidate.kind, candidate.normalizedKey, new Date().toISOString());
    }
    seenClaimIds.add(claim.id);

    const current = currentRevision(database, claim.id);
    const now = new Date().toISOString();
    if (current?.evidence_fingerprint === candidate.evidenceFingerprint) {
      database.prepare(`
        UPDATE claim_revisions SET freshness = 'CURRENT', updated_at = ? WHERE id = ?
      `).run(now, current.revision_id);
      continue;
    }

    if (current) {
      database.prepare(`
        UPDATE claim_revisions SET superseded_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, current.revision_id);
    }

    const revisionId = randomUUID();
    database.prepare(`
      INSERT INTO claim_revisions (
        id, claim_id, text, review_status, freshness, evidence_fingerprint,
        created_at, updated_at, superseded_at
      ) VALUES (?, ?, ?, 'PENDING', 'CURRENT', ?, ?, ?, NULL)
    `).run(revisionId, claim.id, candidate.text, candidate.evidenceFingerprint, now, now);

    for (const item of candidate.evidence) {
      const evidenceId = randomUUID();
      database.prepare(`
        INSERT INTO evidence_items (
          id, repository_id, kind, commit_sha, path, start_line, end_line,
          source_url, excerpt, excerpt_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidenceId,
        input.repositoryId,
        item.kind,
        item.commitSha,
        item.path,
        item.startLine,
        item.endLine,
        item.sourceUrl,
        item.excerpt,
        item.excerptHash,
        now
      );
      database.prepare(`
        INSERT INTO claim_evidence (claim_revision_id, evidence_id) VALUES (?, ?)
      `).run(revisionId, evidenceId);
    }
  }

  const currentClaims = database.prepare(`
    SELECT c.id AS claim_id, cr.id AS revision_id
    FROM claims c
    JOIN claim_revisions cr ON cr.claim_id = c.id AND cr.superseded_at IS NULL
    WHERE c.project_id = ?
  `).all(projectId) as Array<{ claim_id: string; revision_id: string }>;
  if (input.fullSnapshot) {
    const staleAt = new Date().toISOString();
    for (const current of currentClaims) {
      if (!seenClaimIds.has(current.claim_id)) {
        database.prepare(`
          UPDATE claim_revisions SET freshness = 'STALE', updated_at = ? WHERE id = ?
        `).run(staleAt, current.revision_id);
      }
    }
  }

  return projectId;
}

export function listProjectEvidenceProfiles(
  database: DatabaseSync,
  candidateId: string
): ProjectEvidenceProfile[] {
  const projects = database.prepare(`
    SELECT * FROM projects WHERE candidate_id = ? ORDER BY updated_at DESC
  `).all(candidateId) as ProjectRow[];
  return projects.map((project) => projectEvidenceProfileSchema.parse({
    id: project.id,
    candidateId: project.candidate_id,
    repositoryId: project.repository_id,
    name: project.name,
    summary: project.summary,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    claims: listProjectClaims(database, project.id)
  }));
}

export function reviewEvidenceClaim(database: DatabaseSync, input: ClaimReviewInput): boolean {
  const review = claimReviewInputSchema.parse(input);
  const current = currentRevision(database, review.claimId);
  if (!current || current.freshness !== "CURRENT") return false;
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = database.prepare(`
      UPDATE claim_revisions SET review_status = ?, updated_at = ?
      WHERE id = ? AND superseded_at IS NULL AND freshness = 'CURRENT'
    `).run(review.decision, now, current.revision_id);
    if (Number(result.changes) !== 1) {
      database.exec("ROLLBACK;");
      return false;
    }
    database.prepare(`
      INSERT INTO claim_review_events (id, claim_revision_id, decision, note, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), current.revision_id, review.decision, review.note ?? null, now);
    database.exec("COMMIT;");
    return true;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

function upsertProject(database: DatabaseSync, input: ReconcileProjectInput): string {
  const existing = database.prepare("SELECT id FROM projects WHERE repository_id = ?")
    .get(input.repositoryId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO projects (id, candidate_id, repository_id, name, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET
      name = excluded.name,
      summary = excluded.summary,
      updated_at = excluded.updated_at
  `).run(id, input.candidateId, input.repositoryId, input.name, input.summary, now, now);
  return id;
}

function currentRevision(database: DatabaseSync, claimId: string): ClaimRow | null {
  const row = database.prepare(`
    SELECT c.id AS claim_id, cr.id AS revision_id, c.project_id, c.kind,
      c.normalized_key, cr.text, cr.review_status, cr.freshness,
      cr.evidence_fingerprint, cr.created_at, cr.updated_at
    FROM claims c
    JOIN claim_revisions cr ON cr.claim_id = c.id AND cr.superseded_at IS NULL
    WHERE c.id = ?
  `).get(claimId) as ClaimRow | undefined;
  return row ?? null;
}

function listProjectClaims(database: DatabaseSync, projectId: string) {
  const rows = database.prepare(`
    SELECT c.id AS claim_id, cr.id AS revision_id, c.project_id, c.kind,
      c.normalized_key, cr.text, cr.review_status, cr.freshness,
      cr.evidence_fingerprint, cr.created_at, cr.updated_at
    FROM claims c
    JOIN claim_revisions cr ON cr.claim_id = c.id AND cr.superseded_at IS NULL
    WHERE c.project_id = ?
    ORDER BY CASE c.kind
      WHEN 'project' THEN 1 WHEN 'metric' THEN 2 WHEN 'technology' THEN 3 ELSE 4 END,
      c.normalized_key
  `).all(projectId) as ClaimRow[];
  return rows.map((row) => evidenceClaimSchema.parse({
    id: row.claim_id,
    projectId: row.project_id,
    kind: row.kind,
    normalizedKey: row.normalized_key,
    text: row.text,
    reviewStatus: row.review_status,
    freshness: row.freshness,
    evidence: listRevisionEvidence(database, row.revision_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function listRevisionEvidence(database: DatabaseSync, revisionId: string): EvidenceItem[] {
  const rows = database.prepare(`
    SELECT e.* FROM evidence_items e
    JOIN claim_evidence ce ON ce.evidence_id = e.id
    WHERE ce.claim_revision_id = ? ORDER BY e.path, e.start_line
  `).all(revisionId) as EvidenceRow[];
  return rows.map((row) => evidenceItemSchema.parse({
    id: row.id,
    repositoryId: row.repository_id,
    kind: row.kind,
    locator: {
      repositoryUrl: repositoryUrl(database, row.repository_id),
      commitSha: row.commit_sha,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      sourceUrl: row.source_url
    },
    excerpt: row.excerpt,
    excerptHash: row.excerpt_hash,
    createdAt: row.created_at
  }));
}

function repositoryUrl(database: DatabaseSync, repositoryId: string): string {
  const row = database.prepare("SELECT url FROM github_repositories WHERE id = ?")
    .get(repositoryId) as { url: string } | undefined;
  if (!row) throw new Error("Evidence references a missing repository.");
  return row.url;
}
