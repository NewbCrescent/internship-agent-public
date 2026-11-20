import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  getBaseResume,
  getCandidateDocument,
  getCurrentBaseResume,
  getCurrentCandidateDocument,
  getDatabase,
  listCurrentBaseResumes,
  listCurrentCandidateDocuments,
  LOCAL_CANDIDATE_ID,
  saveBaseResume,
  saveCandidateDocument
} from "@internship-agent/db";
import {
  baseResumeFilePath,
  baseResumeUploadPath,
  candidateDocumentFilePath,
  isPdfBytes,
  resolveDataDir
} from "@internship-agent/browser";
import {
  BASE_RESUME_MAX_BYTES,
  baseResumeChannelForProfile,
  baseResumeChannelSchema,
  candidateDocumentKindSchema,
  resumeSourceSetting,
  type ApplicationProfile,
  type BaseResume,
  type BaseResumeChannel,
  type CandidateDocument,
  type CandidateDocumentKind
} from "@internship-agent/domain";

export type StoreBaseResumeInput = {
  channel: BaseResumeChannel;
  label: string;
  originalName: string;
  bytes: Uint8Array;
};

/**
 * Stores a candidate-supplied PDF in the profile's local data directory and
 * records its checksum. The file is copied byte for byte; nothing is parsed
 * or rewritten, and nothing about its contents becomes a candidate fact.
 */
export function storeBaseResume(
  input: StoreBaseResumeInput,
  options: { database?: DatabaseSync; dataDir?: string; candidateId?: string } = {}
): BaseResume {
  const database = options.database ?? getDatabase();
  const dataDir = resolveDataDir(options.dataDir);
  const channel = baseResumeChannelSchema.parse(input.channel);
  assertStorablePdf(input.bytes, "Base resumes");

  const id = randomUUID();
  const fileName = `${id}.pdf`;
  writePrivateFile(baseResumeFilePath(dataDir, fileName), input.bytes);

  return saveBaseResume(database, {
    id,
    candidateId: options.candidateId ?? LOCAL_CANDIDATE_ID,
    channel,
    label: input.label.trim() || (channel === "handshake_internal" ? "Handshake resume" : "Default resume"),
    fileName,
    originalName: input.originalName.trim().slice(0, 255) || fileName,
    sha256: sha256(input.bytes),
    byteSize: input.bytes.length,
    createdAt: new Date().toISOString(),
    supersededAt: null
  });
}

/**
 * Stores another candidate-supplied PDF (the transcript) byte for byte with
 * its checksum. Nothing is read out of it.
 */
export function storeCandidateDocument(
  input: { kind: CandidateDocumentKind; label: string; originalName: string; bytes: Uint8Array },
  options: { database?: DatabaseSync; dataDir?: string; candidateId?: string } = {}
): CandidateDocument {
  const database = options.database ?? getDatabase();
  const dataDir = resolveDataDir(options.dataDir);
  const kind = candidateDocumentKindSchema.parse(input.kind);
  assertStorablePdf(input.bytes, "Transcripts");

  const id = randomUUID();
  const fileName = `${id}.pdf`;
  writePrivateFile(candidateDocumentFilePath(dataDir, fileName), input.bytes);
  return saveCandidateDocument(database, {
    id,
    candidateId: options.candidateId ?? LOCAL_CANDIDATE_ID,
    kind,
    label: input.label.trim() || "Transcript",
    fileName,
    originalName: input.originalName.trim().slice(0, 255) || fileName,
    sha256: sha256(input.bytes),
    byteSize: input.bytes.length,
    createdAt: new Date().toISOString(),
    supersededAt: null
  });
}

export function listCandidateDocuments(database: DatabaseSync = getDatabase(), candidateId = LOCAL_CANDIDATE_ID): CandidateDocument[] {
  return listCurrentCandidateDocuments(database, candidateId);
}

export function currentCandidateDocument(
  kind: CandidateDocumentKind,
  database: DatabaseSync = getDatabase(),
  candidateId = LOCAL_CANDIDATE_ID
): CandidateDocument | null {
  return getCurrentCandidateDocument(database, candidateId, kind);
}

/** Resolves a recorded document to its file and proves the bytes still match. */
export function verifiedCandidateDocumentPath(database: DatabaseSync, dataDir: string, documentId: string): string {
  const document = getCandidateDocument(database, documentId);
  if (!document) throw new Error("The recorded document no longer exists.");
  return verifiedFile(candidateDocumentFilePath(dataDir, document.fileName), document.label, document.sha256);
}

export function listBaseResumes(database: DatabaseSync = getDatabase(), candidateId = LOCAL_CANDIDATE_ID): BaseResume[] {
  return listCurrentBaseResumes(database, candidateId);
}

export function currentBaseResume(
  channel: BaseResumeChannel,
  database: DatabaseSync = getDatabase(),
  candidateId = LOCAL_CANDIDATE_ID
): BaseResume | null {
  return getCurrentBaseResume(database, candidateId, channel);
}

/**
 * Resolves a recorded base resume to its file and proves the bytes still
 * match the recorded checksum. A missing or changed file stops the run
 * rather than uploading something the candidate did not provide.
 */
export function verifiedBaseResumePath(database: DatabaseSync, dataDir: string, baseResumeId: string): string {
  const resume = getBaseResume(database, baseResumeId);
  if (!resume) throw new Error("The recorded base resume no longer exists.");
  return verifiedFile(baseResumeFilePath(dataDir, resume.fileName), resume.label, resume.sha256);
}

/**
 * The candidate's current uploaded resume for an application profile
 * (`default`, or `handshake_internal` for the 2029 profile), or null when
 * none is stored or INTERNSHIP_AGENT_RESUME_SOURCE=generated opts out.
 */
export function uploadedResumeFor(
  profile: ApplicationProfile,
  database: DatabaseSync = getDatabase(),
  candidateId = LOCAL_CANDIDATE_ID,
  env: Record<string, string | undefined> = process.env
): BaseResume | null {
  if (resumeSourceSetting(env) === "generated") return null;
  return getCurrentBaseResume(database, candidateId, baseResumeChannelForProfile(profile));
}

/**
 * Copies a recorded base resume, byte for byte and under the candidate's own
 * file name, to the job's upload folder and returns that path. The resume
 * must still be its channel's current upload and match its checksum; a
 * replaced, missing, or changed file stops the run.
 */
export function stageBaseResumeForUpload(database: DatabaseSync, dataDir: string, jobId: string, baseResumeId: string): string {
  const resume = getBaseResume(database, baseResumeId);
  if (!resume) throw new Error("The recorded base resume no longer exists.");
  if (resume.supersededAt) {
    throw new Error(
      `"${resume.label}" was replaced by a newer upload after this run was planned. Cancel this run and start a new one so it sends the current file.`
    );
  }
  const bytes = verifiedBytes(baseResumeFilePath(dataDir, resume.fileName), resume.label, resume.sha256);
  const path = baseResumeUploadPath(dataDir, jobId, resume.id, resume.originalName);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return verifiedFile(path, resume.label, resume.sha256);
}

function verifiedFile(path: string, label: string, expectedSha256: string): string {
  verifiedBytes(path, label, expectedSha256);
  return path;
}

function verifiedBytes(path: string, label: string, expectedSha256: string): Buffer {
  if (!existsSync(path)) {
    throw new Error(`"${label}" is missing from this profile's data directory; upload it again.`);
  }
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedSha256) {
    throw new Error(`"${label}" changed on disk since it was uploaded; upload it again.`);
  }
  return bytes;
}

export function assertStorablePdf(bytes: Uint8Array, what: string): void {
  if (bytes.length === 0) throw new Error("The file is empty.");
  if (bytes.length > BASE_RESUME_MAX_BYTES) {
    throw new Error(`Files are limited to ${Math.floor(BASE_RESUME_MAX_BYTES / 1024 / 1024)} MB.`);
  }
  if (!isPdfBytes(bytes)) throw new Error(`${what} must be PDF files.`);
}

function writePrivateFile(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
