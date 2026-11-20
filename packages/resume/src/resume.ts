import { randomUUID } from "node:crypto";

import type { ResumeBullet, ResumeDocument, ResumeVariant } from "@internship-agent/domain";
import { resumeVariantSchema } from "@internship-agent/domain";

/**
 * Resume variants freeze the candidate's approved entries: the bullets carry
 * their claim ledger ids, and the structured document is exactly what a
 * submission prints. Variants never author new factual sentences.
 */
export function buildResumeVariant(
  candidateId: string,
  jobId: string | null,
  label: string,
  bullets: ResumeBullet[],
  document: ResumeDocument | null = null,
  createdAt = new Date().toISOString()
): ResumeVariant {
  return resumeVariantSchema.parse({
    id: randomUUID(),
    candidateId,
    jobId,
    label: label.trim().slice(0, 120) || "Untitled variant",
    bullets,
    document,
    createdAt
  });
}
