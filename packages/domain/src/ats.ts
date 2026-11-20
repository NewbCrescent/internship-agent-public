import { z } from "zod";

/**
 * Milestone 8 external ATS abstraction. Deterministic classification picks
 * the adapter; confidence thresholds decide whether the run proceeds, asks
 * the candidate to confirm, or falls back to the generic flow. Candidate
 * corrections are logged as events and never silently applied. Dover
 * (app.dover.io) and Rippling (ats.rippling.com) were added from read-only
 * captures of 2026-11-20.
 */

export const atsKindSchema = z.enum(["greenhouse", "lever", "workday", "handshake", "oracle", "smartrecruiters", "ashby", "jobvite", "icims", "dover", "rippling", "unknown"]);

export const atsSignalSchema = z.object({
  source: z.enum(["url", "title", "body"]),
  pattern: z.string().min(1).max(200),
  weight: z.number().min(0).max(1)
});

export const atsClassificationSchema = z.object({
  kind: atsKindSchema,
  confidence: z.number().min(0).max(1),
  signals: z.array(atsSignalSchema)
});

/** Semantic role of a form field. `eeo` is sensitive and never autofilled. */
export const fieldRoleSchema = z.enum([
  "name",
  "email",
  "phone",
  "location",
  "work-auth",
  "sponsorship",
  "start-date",
  "resume",
  "transcript",
  "cover",
  /** Any other upload (writing sample, portfolio file): always the candidate's call. */
  "document",
  "linkedin",
  "github",
  "portfolio",
  "eeo",
  "custom",
  "unknown"
]);

export type AtsKind = z.infer<typeof atsKindSchema>;
export type AtsSignal = z.infer<typeof atsSignalSchema>;
export type AtsClassification = z.infer<typeof atsClassificationSchema>;
export type FieldRole = z.infer<typeof fieldRoleSchema>;

export const ATS_KIND_LABELS: Record<Exclude<AtsKind, "unknown">, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  workday: "Workday",
  handshake: "Handshake",
  oracle: "Oracle Cloud HCM",
  smartrecruiters: "SmartRecruiters",
  ashby: "Ashby",
  jobvite: "Jobvite",
  icims: "iCIMS",
  dover: "Dover",
  rippling: "Rippling"
};

/**
 * Recognized for display; the agent has no adapter that walks their
 * application, so the candidate approves each run. Oracle Candidate
 * Experience puts an email and one-time-code step in front of a multi-step
 * form, and a SmartRecruiters posting page sits in front of a separate
 * application page: the generic single-page filler would fill and submit the
 * wrong page. Jobvite's Apply opens a data-consent step (residence and
 * language, then accept or decline its policy) before any form, and iCIMS's
 * Apply lands on an email-first account step; the agent never gives consent
 * or creates accounts for the candidate. Rippling's application page
 * (<posting>/apply, behind an "Apply now" button) shows a progress bar, and
 * its success text was not found in the page's own bundles (only a
 * translation key), so a submitted run could not be told from a stalled one.
 * Dover proceeds like Greenhouse: one page with the form, one Apply submit,
 * and a "Thanks for applying!" the confirmation pattern already reads.
 */
export const ATS_KINDS_NEEDING_APPROVAL: ReadonlySet<string> = new Set(["oracle", "smartrecruiters", "jobvite", "icims", "rippling"]);

export function atsKindNeedsApproval(kind: string | null | undefined): boolean {
  return typeof kind === "string" && ATS_KINDS_NEEDING_APPROVAL.has(kind);
}
