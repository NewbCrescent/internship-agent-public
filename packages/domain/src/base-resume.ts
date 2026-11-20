import { z } from "zod";

/**
 * Candidate-supplied base resumes. The file bytes stay in the profile's local
 * data directory; the database keeps the channel, checksum, and size so an
 * upload can prove it sent exactly the file the candidate provided.
 *
 * - `default`: sent byte for byte on default-profile (2028) applications.
 * - `handshake_internal`: sent on alternate (2029) profile applications
 *   (Handshake Quick Apply / Apply, a form asking for a transcript, or a
 *   company pinned to the transcript profile).
 */
export const baseResumeChannelSchema = z.enum(["default", "handshake_internal"]);

export const BASE_RESUME_MAX_BYTES = 5 * 1024 * 1024;

export const baseResumeSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  channel: baseResumeChannelSchema,
  label: z.string().trim().min(1).max(120),
  fileName: z.string().regex(/^[0-9a-f-]{36}\.pdf$/),
  originalName: z.string().trim().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().positive().max(BASE_RESUME_MAX_BYTES),
  createdAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable()
});

/**
 * Other candidate-supplied documents, stored like base resumes. A transcript
 * is uploaded only into a field that asks for a transcript; nothing is read
 * out of it (no student ID, grades, or courses become facts). The relevant
 * courses in candidate_coursework were entered by the candidate with
 * pnpm profile:coursework, not read from this file.
 */
export const candidateDocumentKindSchema = z.enum(["transcript"]);

export const candidateDocumentSchema = z.object({
  id: z.string().uuid(),
  candidateId: z.string().min(1),
  kind: candidateDocumentKindSchema,
  label: z.string().trim().min(1).max(120),
  fileName: z.string().regex(/^[0-9a-f-]{36}\.pdf$/),
  originalName: z.string().trim().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().positive().max(BASE_RESUME_MAX_BYTES),
  createdAt: z.iso.datetime(),
  supersededAt: z.iso.datetime().nullable()
});

/** Handshake, or one Workday career site (`workday:{host}/{site}`); each keeps its own sign-in. */
export const browserSessionSiteSchema = z.union([
  z.literal("handshake"),
  z.string().regex(/^workday:[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com\/[A-Za-z0-9_-]+$/)
]);
export const browserSessionStatusSchema = z.enum(["connected", "signed_out", "unknown"]);

/** The last observed sign-in state of the candidate's own browser profile. */
export const browserSessionSchema = z.object({
  site: browserSessionSiteSchema,
  status: browserSessionStatusSchema,
  detail: z.string().min(1).max(500),
  checkedAt: z.iso.datetime()
});

export type BaseResumeChannel = z.infer<typeof baseResumeChannelSchema>;
export type BaseResume = z.infer<typeof baseResumeSchema>;
export type CandidateDocumentKind = z.infer<typeof candidateDocumentKindSchema>;
export type CandidateDocument = z.infer<typeof candidateDocumentSchema>;
export type BrowserSessionSite = z.infer<typeof browserSessionSiteSchema>;
export type BrowserSessionStatus = z.infer<typeof browserSessionStatusSchema>;
export type BrowserSession = z.infer<typeof browserSessionSchema>;

export const resumeSourceSettingSchema = z.enum(["uploaded", "generated"]);
export type ResumeSourceSetting = z.infer<typeof resumeSourceSettingSchema>;

/** INTERNSHIP_AGENT_RESUME_SOURCE: only "generated" opts out of sending the candidate's uploaded resume. */
export function resumeSourceSetting(env: Record<string, string | undefined> = process.env): ResumeSourceSetting {
  return env.INTERNSHIP_AGENT_RESUME_SOURCE?.trim().toLowerCase() === "generated" ? "generated" : "uploaded";
}

/** The base-resume channel each application profile sends. */
export function baseResumeChannelForProfile(profile: "default" | "transcript"): BaseResumeChannel {
  return profile === "transcript" ? "handshake_internal" : "default";
}
