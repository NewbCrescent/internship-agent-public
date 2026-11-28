import { z } from "zod";

/**
 * Milestone 8 external ATS abstraction. Deterministic classification picks
 * the adapter; confidence thresholds decide whether the run proceeds, asks
 * the candidate to confirm, or falls back to the generic flow. Candidate
 * corrections are logged as events and never silently applied. Dover
 * (app.dover.io) and Rippling (ats.rippling.com) were added from read-only
 * captures of 2026-11-20, Paylocity (recruiting.paylocity.com) from one of
 * 2026-11-24, Workable (apply.workable.com) from one of 2026-11-27 (Track
 * 77). A kind is confirmed automatically, and submitted under the
 * auto-submit policy, only on its own site (atsKindOwnsUrl, Track 38).
 */

export const atsKindSchema = z.enum(["greenhouse", "lever", "workday", "handshake", "oracle", "smartrecruiters", "ashby", "jobvite", "icims", "dover", "rippling", "paylocity", "workable", "unknown"]);

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
  paylocity: "Paylocity",
  workable: "Workable"
};

/**
 * Recognized for display; no adapter of the agent's own walks their
 * application, so their runs are filled in the confirm band: the candidate
 * confirms the kind on runs they approve, and under the auto-submit policy
 * `approveRunSubmissionAutomatically` confirms it (Track 80). The agent takes Oracle
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
 * "Thanks for applying!" the confirmation pattern already reads. Workable
 * proceeds like Dover: one page, one "Submit application" submit, and a
 * "Your application has been submitted successfully." the confirmation
 * pattern already reads.
 */
export const ATS_KINDS_NEEDING_APPROVAL: ReadonlySet<string> = new Set(["oracle", "smartrecruiters", "jobvite", "icims", "rippling", "paylocity"]);

export function atsKindNeedsApproval(kind: string | null | undefined): boolean {
  return typeof kind === "string" && ATS_KINDS_NEEDING_APPROVAL.has(kind);
}

/**
 * Track 80: kinds whose confirmation page (or submit answer) the agent has seen and reads, so a recognized
 * confirmation there marks a submit as submitted. On any other kind, an unrecognized site, or a several-page form
 * walked without an adapter, a submit under the auto-submit policy is held as a possible submission until a receipt
 * check. A kind joins only with a captured confirmation page and a regression.
 */
export const ATS_KINDS_WITH_CAPTURED_CONFIRMATION: ReadonlySet<string> = new Set(["greenhouse", "lever", "workday", "handshake", "ashby", "dover"]);

export function atsConfirmationCaptured(kind: string | null | undefined): boolean {
  return typeof kind === "string" && ATS_KINDS_WITH_CAPTURED_CONFIRMATION.has(kind);
}

/**
 * Track 80: the one kind the auto-submit policy still never submits. A SmartRecruiters posting page sits in front of
 * a separate application page the agent does not read (its one-click fields are not read, and its pages showed
 * DataDome to the agent's browser), so the candidate approves each run.
 */
export const ATS_KINDS_NEVER_AUTO_SUBMITTED: ReadonlySet<string> = new Set(["smartrecruiters"]);

/**
 * The hosts each kind's own application pages are served from (Track 38): a kind is confirmed
 * automatically, and submitted under the auto-submit policy, only on its own site. An employer page
 * embedding Greenhouse (gh_jid) or Ashby (ashby_jid), or an Oracle Candidate Experience path, carries
 * that ATS's own marker. MITRE's Phenom apply page mentions Workday and is not Workday.
 */
const ATS_OWN_HOSTS: Record<Exclude<AtsKind, "unknown">, RegExp> = {
  greenhouse: /(?:^|\.)greenhouse\.io$/,
  lever: /(?:^|\.)lever\.co$/,
  workday: /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/,
  handshake: /(?:^|\.)joinhandshake\.com$/,
  oracle: /(?:^|\.)oraclecloud\.com$/,
  smartrecruiters: /(?:^|\.)smartrecruiters\.com$/,
  ashby: /(?:^|\.)ashbyhq\.com$/,
  jobvite: /(?:^|\.)jobvite\.com$/,
  icims: /(?:^|\.)icims\.com$/,
  dover: /^(?:app\.dover\.io|jobs\.dover\.com)$/,
  rippling: /(?:^|\.)rippling\.com$/,
  paylocity: /(?:^|\.)paylocity\.com$/,
  workable: /(?:^|\.)workable\.com$/
};

/** Whether `url` is on `kind`'s own site or carries its embed marker; false for unknown kinds and unparseable or non-http(s) URLs. Pure. */
export function atsKindOwnsUrl(kind: string | null | undefined, url: string | null | undefined): boolean {
  if (!kind || !url || !Object.prototype.hasOwnProperty.call(ATS_OWN_HOSTS, kind)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (ATS_OWN_HOSTS[kind as keyof typeof ATS_OWN_HOSTS].test(parsed.hostname.toLowerCase())) return true;
  if (kind === "greenhouse") return parsed.searchParams.has("gh_jid");
  if (kind === "ashby") return parsed.searchParams.has("ashby_jid");
  if (kind === "oracle") return /\/hcmUI\/CandidateExperience\//i.test(parsed.pathname);
  return false;
}
