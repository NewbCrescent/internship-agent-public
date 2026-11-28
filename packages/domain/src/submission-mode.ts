import { ATS_KIND_LABELS, ATS_KINDS_NEVER_AUTO_SUBMITTED, atsConfirmationCaptured } from "./ats";
import { isSteppedRun } from "./stepped-form";

/**
 * Manual checklist mode. When on, the AI submission flow (package approval,
 * browser runs, submit approvals) is hidden from the UI and refused at its
 * entry seams, without removing any of it. Unset the flag to restore it.
 */
export function manualOnly(env: Record<string, string | undefined> = process.env): boolean {
  return env.INTERNSHIP_AGENT_MANUAL_ONLY?.trim() === "1";
}

/**
 * The automatic-submission AI bar: default 50, never below 40 (user,
 * 2026-11-19: "let's defo have the bar lower like 50+").
 */
export const AUTO_SUBMIT_DEFAULT_MIN_FIT = 50;
export const AUTO_SUBMIT_MIN_FIT_FLOOR = 40;

export type AutoSubmitSettings = {
  /** Lowest current AI score an automatic submission accepts. */
  minFit: number;
  /** Automatic submissions per local calendar day, or null for no daily cap. */
  dailyCap: number | null;
};

/**
 * Opt-in automatic submission (INTERNSHIP_AGENT_AUTO_SUBMIT=1, which also
 * needs auto-apply). It replaces the candidate's submit approval only for
 * runs that pass autoSubmitBlockers and a target decision of "apply";
 * manual checklist mode always wins. Defaults: AI score 50 (at least 40), 10 per day.
 */
export function autoSubmitSettings(env: Record<string, string | undefined> = process.env): AutoSubmitSettings | null {
  if (env.INTERNSHIP_AGENT_AUTO_SUBMIT?.trim() !== "1" || env.INTERNSHIP_AGENT_AUTO_APPLY?.trim() !== "1" || manualOnly(env)) return null;
  const whole = (raw: string | undefined, fallback: number, min: number, max: number) => {
    const value = raw?.trim();
    return value && /^\d+$/.test(value) ? Math.min(max, Math.max(min, Number.parseInt(value, 10))) : fallback;
  };
  const dailyCap = env.INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP?.trim();
  return {
    minFit: whole(env.INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT, AUTO_SUBMIT_DEFAULT_MIN_FIT, AUTO_SUBMIT_MIN_FIT_FLOOR, 100),
    dailyCap: dailyCap === "unlimited" ? null : whole(dailyCap, 10, 1, 50)
  };
}

/** The timeline marker of an automatic approval; the daily cap counts these. */
export const AUTO_SUBMIT_EVENT = "Submission approved automatically by your auto-submit policy";

/**
 * The planner's reason for leaving a value a form field (never a file field)
 * already shows when no saved answer of the candidate's applies to the
 * question. It does not hold an automatic submission.
 */
export const SITE_VALUE_KEPT_REASON = "The site already shows this value, and nothing you saved says otherwise.";

/**
 * The same on a question the catalog recognized but no saved answer settles
 * (a fact with no saved answer, one needing confirmation, an ambiguous one,
 * or a saved answer that is not one of the field's options). It holds an
 * automatic submission as unconfirmed.
 */
export const UNCONFIRMED_SITE_VALUE_REASON = "The site already shows this value; none of your saved answers confirms it.";

/** Runs planned before 2026-11-25 used this for every shown value, so it stays held as unconfirmed. */
const LEGACY_SITE_VALUE_REASON = "The site already shows this value.";

type RunForAutoSubmit = {
  status: string;
  atsConfirmed: boolean;
  atsKind?: string;
  /** The kind the classifier suggested when the run was not confirmed automatically. */
  suggestedAtsKind?: string | null;
  pauses: ReadonlyArray<{ safeguard: boolean; status?: string; draft?: { source?: string } | null }>;
  decisions: ReadonlyArray<{ fieldId?: string; action: string; basis: { kind: string; field?: string } | null; reason?: string }>;
};

/** Track 80: the reason a run whose form shows no application content is never submitted automatically. */
export const NO_APPLICATION_CONTENT_BLOCKER = "The form the agent filled has no application content (no resume and not your name with your email), so it may be a newsletter or sign-up box; it is never submitted automatically.";

const NAME_FIELDS: ReadonlySet<string> = new Set(["fullName", "legalFirstName", "legalLastName", "preferredName"]);
const DOCUMENT_BASES: ReadonlySet<string> = new Set(["variant", "base_resume", "candidate_document"]);

/**
 * Track 80 (the manager, after Track 77 found newsletter boxes captured as "the form" on unknown sites): whether a
 * run's own decisions hold application content: an uploaded resume or document, or the candidate's name and email
 * from the profile. A lone email box (a newsletter or sign-up) has none. Pure.
 */
export function hasApplicationContent(decisions: ReadonlyArray<{ action: string; basis: { kind: string; field?: string } | null }>): boolean {
  const acted = decisions.filter((decision) => decision.action === "fill" || decision.action === "choose" || decision.action === "check" || decision.action === "upload");
  if (acted.some((decision) => decision.action === "upload" && decision.basis !== null && DOCUMENT_BASES.has(decision.basis.kind))) return true;
  const profile = (field: (value: string) => boolean) => acted.some((decision) =>
    decision.action !== "upload" && decision.basis?.kind === "profile" && typeof decision.basis.field === "string" && field(decision.basis.field));
  return profile((value) => NAME_FIELDS.has(value)) && profile((value) => value === "email");
}

/**
 * Why a filled run may not be submitted without the candidate. An unanswered
 * pause, a safeguard, an answer drafted in the candidate's voice, a draft the AI review suggested
 * for a question still unanswered, or an attachment the site already held
 * keeps the run for the candidate. An answer the AI review matched to a saved
 * answer after every deterministic guardrail passed does not hold the run (the
 * candidate's decision, 2026-11-26). A value a form field already showed
 * with nothing saved against it does not hold the run; a shown value on a
 * question only the candidate's saved answers may answer does.
 * The site type holds a run only on SmartRecruiters (Track 80, the candidate's decision of 2026-11-28); a recognized
 * kind without an adapter, an unrecognized site, and a several-page form walked step by step are submitted like any
 * other clean run, under the extra checks `uncapturedSiteRun` names.
 * On a site without a captured flow, a run whose decisions hold no application content (`hasApplicationContent`) is held.
 */
export function autoSubmitBlockers(run: RunForAutoSubmit): string[] {
  const blockers: string[] = [];
  if (run.status !== "awaiting-approval") blockers.push(`The run is ${run.status}, not waiting at the submit step.`);
  if (run.pauses.some((pause) => pause.safeguard)) blockers.push("The site showed a safeguard challenge.");
  if (run.pauses.some((pause) => pause.status === "open")) {
    blockers.push("The form has unanswered questions waiting for you.");
  }
  // Track 80 (the candidate, 2026-11-28): the site type no longer holds a run, except SmartRecruiters.
  const kind = run.atsConfirmed ? run.atsKind : run.suggestedAtsKind;
  if (kind && ATS_KINDS_NEVER_AUTO_SUBMITTED.has(kind)) {
    const label = ATS_KIND_LABELS[kind as keyof typeof ATS_KIND_LABELS] ?? kind;
    blockers.push(`${label} application sites are recognized, but their posting page sits in front of a separate application page the agent does not read, so you approve each one.`);
  }
  // Track 80: on a site without a captured flow, a form with no application content (a lone newsletter or sign-up email box) is never submitted.
  const guarded = !run.atsConfirmed || (run.atsKind !== undefined && !atsConfirmationCaptured(run.atsKind)) || isSteppedRun({ decisions: run.decisions });
  if (guarded && !hasApplicationContent(run.decisions)) blockers.push(NO_APPLICATION_CONTENT_BLOCKER);
  if (run.decisions.some((decision) => decision.basis?.kind === "voice_draft")) blockers.push("An answer was drafted in your voice; you review those.");
  // The AI review of a pause batch (pause-review.ts): a suggested draft holds the run while its question is unanswered;
  // once the candidate answers it (with the draft or their own text) it is the candidate's answer, as with voice drafts.
  if (run.pauses.some((pause) => pause.draft?.source === "pause_review" && pause.status === "open")) blockers.push("AI review suggested a draft; you review those.");
  const kept = run.decisions.filter((decision) => decision.action === "keep");
  const unconfirmed = (reason: string | undefined) => reason === UNCONFIRMED_SITE_VALUE_REASON || reason === LEGACY_SITE_VALUE_REASON;
  if (kept.some((decision) => unconfirmed(decision.reason))) blockers.push("The site already shows an answer that none of your saved answers confirms; you review those.");
  // Only a kept attachment (Handshake's attached resume, or any keep the planner did not mark as a field's shown value) holds the run as an attachment.
  if (kept.some((decision) => decision.reason !== SITE_VALUE_KEPT_REASON && !unconfirmed(decision.reason))) blockers.push("The site kept an attachment you need to confirm.");
  return blockers;
}

/**
 * Track 80: whether a run is on a site whose confirmation page the agent has not captured: a several-page form
 * walked without an adapter (Track 74), or a kind outside ATS_KINDS_WITH_CAPTURED_CONFIRMATION (an unrecognized
 * site included). Under the auto-submit policy such a run's click goes only to a control that reads as the final
 * submit, and its outcome waits for a receipt check. Pure.
 */
export function uncapturedSiteRun(run: { atsKind: string; decisions: ReadonlyArray<{ fieldId?: string }>; pauses?: ReadonlyArray<{ fieldId: string }> }): boolean {
  return isSteppedRun(run) || !atsConfirmationCaptured(run.atsKind);
}

/**
 * Track 85: the timeline note of a policy submit held as a possible submission (`SubmissionUnverified`) until a
 * receipt check. It is not a failure.
 */
export const POSSIBLE_SUBMISSION_NOTE = "Automatic submission held as a possible submission: ";

// Track 80 logged the same hold as a failure; every `unverifiedSubmission` message starts with this text.
const LEGACY_POSSIBLE_SUBMISSION_NOTE = /^Automatic submission failed: The auto-submit policy clicked the final submit of /;

/** Track 85: whether a timeline note records a policy submit held as a possible submission (either note form). Pure. */
export function isPossibleSubmissionNote(detail: string | null | undefined): boolean {
  if (typeof detail !== "string") return false;
  return detail.startsWith(POSSIBLE_SUBMISSION_NOTE) || LEGACY_POSSIBLE_SUBMISSION_NOTE.test(detail);
}
