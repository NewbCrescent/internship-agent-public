import type { DatabaseSync } from "node:sqlite";

import {
  baseResumeSchema,
  browserSessionSchema,
  candidateDocumentSchema,
  type BaseResume,
  type BaseResumeChannel,
  type CandidateDocument,
  type CandidateDocumentKind,
  type BrowserSession,
  type BrowserSessionSite
} from "@internship-agent/domain";

type BaseResumeRow = {
  id: string;
  candidate_id: string;
  channel: BaseResumeChannel;
  label: string;
  file_name: string;
  original_name: string;
  sha256: string;
  byte_size: number;
  created_at: string;
  superseded_at: string | null;
};

function parseBaseResume(row: BaseResumeRow): BaseResume {
  return baseResumeSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    channel: row.channel,
    label: row.label,
    fileName: row.file_name,
    originalName: row.original_name,
    sha256: row.sha256,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    supersededAt: row.superseded_at
  });
}

/** Records a base resume and supersedes the channel's previous one atomically. */
export function saveBaseResume(database: DatabaseSync, resume: BaseResume): BaseResume {
  const parsed = baseResumeSchema.parse({ ...resume, supersededAt: null });
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare(`
      UPDATE base_resumes SET superseded_at = ?
      WHERE candidate_id = ? AND channel = ? AND superseded_at IS NULL
    `).run(parsed.createdAt, parsed.candidateId, parsed.channel);
    database.prepare(`
      INSERT INTO base_resumes (
        id, candidate_id, channel, label, file_name, original_name, sha256, byte_size, created_at, superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      parsed.id, parsed.candidateId, parsed.channel, parsed.label, parsed.fileName,
      parsed.originalName, parsed.sha256, parsed.byteSize, parsed.createdAt
    );
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return parsed;
}

export function getBaseResume(database: DatabaseSync, id: string): BaseResume | null {
  const row = database.prepare("SELECT * FROM base_resumes WHERE id = ?").get(id) as BaseResumeRow | undefined;
  return row ? parseBaseResume(row) : null;
}

export function getCurrentBaseResume(
  database: DatabaseSync,
  candidateId: string,
  channel: BaseResumeChannel
): BaseResume | null {
  const row = database.prepare(`
    SELECT * FROM base_resumes
    WHERE candidate_id = ? AND channel = ? AND superseded_at IS NULL
  `).get(candidateId, channel) as BaseResumeRow | undefined;
  return row ? parseBaseResume(row) : null;
}

export function listCurrentBaseResumes(database: DatabaseSync, candidateId: string): BaseResume[] {
  const rows = database.prepare(`
    SELECT * FROM base_resumes
    WHERE candidate_id = ? AND superseded_at IS NULL
    ORDER BY channel
  `).all(candidateId) as BaseResumeRow[];
  return rows.map(parseBaseResume);
}

type DocumentRow = {
  id: string;
  candidate_id: string;
  kind: CandidateDocumentKind;
  label: string;
  file_name: string;
  original_name: string;
  sha256: string;
  byte_size: number;
  created_at: string;
  superseded_at: string | null;
};

function parseDocument(row: DocumentRow): CandidateDocument {
  return candidateDocumentSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    kind: row.kind,
    label: row.label,
    fileName: row.file_name,
    originalName: row.original_name,
    sha256: row.sha256,
    byteSize: row.byte_size,
    createdAt: row.created_at,
    supersededAt: row.superseded_at
  });
}

/** Records a document and supersedes the kind's previous one atomically. */
export function saveCandidateDocument(database: DatabaseSync, document: CandidateDocument): CandidateDocument {
  const parsed = candidateDocumentSchema.parse({ ...document, supersededAt: null });
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare(`
      UPDATE candidate_documents SET superseded_at = ?
      WHERE candidate_id = ? AND kind = ? AND superseded_at IS NULL
    `).run(parsed.createdAt, parsed.candidateId, parsed.kind);
    database.prepare(`
      INSERT INTO candidate_documents (
        id, candidate_id, kind, label, file_name, original_name, sha256, byte_size, created_at, superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      parsed.id, parsed.candidateId, parsed.kind, parsed.label, parsed.fileName,
      parsed.originalName, parsed.sha256, parsed.byteSize, parsed.createdAt
    );
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return parsed;
}

export function getCandidateDocument(database: DatabaseSync, id: string): CandidateDocument | null {
  const row = database.prepare("SELECT * FROM candidate_documents WHERE id = ?").get(id) as DocumentRow | undefined;
  return row ? parseDocument(row) : null;
}

export function getCurrentCandidateDocument(
  database: DatabaseSync,
  candidateId: string,
  kind: CandidateDocumentKind
): CandidateDocument | null {
  const row = database.prepare(`
    SELECT * FROM candidate_documents WHERE candidate_id = ? AND kind = ? AND superseded_at IS NULL
  `).get(candidateId, kind) as DocumentRow | undefined;
  return row ? parseDocument(row) : null;
}

export function listCurrentCandidateDocuments(database: DatabaseSync, candidateId: string): CandidateDocument[] {
  const rows = database.prepare(`
    SELECT * FROM candidate_documents WHERE candidate_id = ? AND superseded_at IS NULL ORDER BY kind
  `).all(candidateId) as DocumentRow[];
  return rows.map(parseDocument);
}

export function saveBrowserSession(database: DatabaseSync, session: BrowserSession): BrowserSession {
  const parsed = browserSessionSchema.parse(session);
  database.prepare(`
    INSERT INTO browser_sessions (site, status, detail, checked_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(site) DO UPDATE SET
      status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at
  `).run(parsed.site, parsed.status, parsed.detail, parsed.checkedAt);
  return parsed;
}

export function getBrowserSession(database: DatabaseSync, site: BrowserSessionSite): BrowserSession | null {
  const row = database.prepare("SELECT * FROM browser_sessions WHERE site = ?").get(site) as
    { site: BrowserSessionSite; status: BrowserSession["status"]; detail: string; checked_at: string } | undefined;
  return row
    ? browserSessionSchema.parse({ site: row.site, status: row.status, detail: row.detail, checkedAt: row.checked_at })
    : null;
}
