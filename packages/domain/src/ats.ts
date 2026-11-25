import { z } from "zod";

/**
 * Milestone 8 external ATS abstraction. Deterministic classification picks
 * the adapter; confidence thresholds decide whether the run proceeds, asks
 * the candidate to confirm, or falls back to the generic flow. Candidate
 * corrections are logged as events and never silently applied. Dover
 * (app.dover.io) and Rippling (ats.rippling.com) were added from read-only
 * captures of 2026-11-20, Paylocity (recruiting.paylocity.com) from one of
 * 2026-11-24.
 */

export const atsKindSchema = z.enum(["greenhouse", "lever", "workday", "handshake", "oracle", "smartrecruiters", "ashby", "jobvite", "icims", "dover", "rippling", "paylocity", "unknown"]);

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
  rippling: "Rippling",
  paylocity: "Paylocity"
};

/**
 * Recognized for display; the agent has no adapter that walks their
 * application, so the candidate approves each run. The agent takes Oracle
 * Candidate Experience's email and one-time-code step (packages/agent
 * oracle-email-step.ts), but no adapter walks its several-section form
 * (/apply/section/<n>, Next per section, Submit on the last), and the
 * post-submit code step (/apply/confirm) and the /my-profile landing are not
 * recognized as an outcome, so Oracle stays approval-needed. A
 * SmartRecruiters posting page sits in front of a separate application page:
 * the generic single-page filler would fill and submit the wrong page. Jobvite's Apply opens a data-consent step (residence and
 * language, then accept or decline its policy) before any form, and iCIMS's
 * Apply lands on an email-first account step. Jobvite's consent step is
 * accepted only under INTERNSHIP_AGENT_ACCEPT_DATA_CONSENT and iCIMS accounts
 * are created only under INTERNSHIP_AGENT_ICIMS_ACCOUNTS, but the agent walks
 * neither application, so both stay approval-needed. Rippling's application page
 * (<posting>/apply, behind an "Apply now" button) shows a progress bar, and
 * its success text was not found in the page's own bundles (only a
 * translation key), so a submitted run could not be told from a stalled one.
 * Paylocity's application page (/Recruiting/Jobs/Apply/<id>, behind the
 * posting's Apply) is a form of five steps ("Step 1 of 5", a "Next Step"
 * button and no submit on the first), and no success text was found in its
 * own scripts, so it stays approval-needed until an adapter walks it. Dover
 * proceeds like Greenhouse: one page with the form, one Apply submit, and a
 * "Thanks for applying!" the confirmation pattern already reads.
 */
export const ATS_KINDS_NEEDING_APPROVAL: ReadonlySet<string> = new Set(["oracle", "smartrecruiters", "jobvite", "icims", "rippling", "paylocity"]);

export function atsKindNeedsApproval(kind: string | null | undefined): boolean {
  return typeof kind === "string" && ATS_KINDS_NEEDING_APPROVAL.has(kind);
}
