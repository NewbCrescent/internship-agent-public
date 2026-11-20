import { ATS_KIND_LABELS, atsKindNeedsApproval } from "./ats";

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
  /** Automatic submissions per local calendar day. */
  dailyCap: number;
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
  return {
    minFit: whole(env.INTERNSHIP_AGENT_AUTO_SUBMIT_MIN_FIT, AUTO_SUBMIT_DEFAULT_MIN_FIT, AUTO_SUBMIT_MIN_FIT_FLOOR, 100),
    dailyCap: whole(env.INTERNSHIP_AGENT_AUTO_SUBMIT_DAILY_CAP, 10, 1, 50)
  };
}

/** The timeline marker of an automatic approval; the daily cap counts these. */
export const AUTO_SUBMIT_EVENT = "Submission approved automatically by your auto-submit policy";

type RunForAutoSubmit = {
  status: string;
  atsConfirmed: boolean;
  /** The kind the classifier suggested when the run was not confirmed automatically. */
  suggestedAtsKind?: string | null;
  pauses: ReadonlyArray<{ safeguard: boolean }>;
  decisions: ReadonlyArray<{ action: string; basis: { kind: string } | null }>;
};

/**
 * Why a filled run may not be submitted without the candidate. Any pause
 * (even one answered later), a safeguard, a site type the classifier did not
 * recognize on its own, an answer drafted in the candidate's voice, or an
 * attachment the site already held keeps the run for the candidate.
 */
export function autoSubmitBlockers(run: RunForAutoSubmit): string[] {
  const blockers: string[] = [];
  if (run.status !== "awaiting-approval") blockers.push(`The run is ${run.status}, not waiting at the submit step.`);
  if (run.pauses.some((pause) => pause.safeguard)) blockers.push("The site showed a safeguard challenge.");
  if (run.pauses.length > 0) blockers.push("The form asked something the agent could not answer on its own.");
  if (!run.atsConfirmed) {
    const suggested = run.suggestedAtsKind;
    if (atsKindNeedsApproval(suggested)) {
      const label = ATS_KIND_LABELS[suggested as keyof typeof ATS_KIND_LABELS];
      blockers.push(`${label} application sites are recognized, but the agent has no adapter that walks their application, so you approve each one.`);
    } else {
      blockers.push("The application site type was not recognized automatically.");
    }
  }
  if (run.decisions.some((decision) => decision.basis?.kind === "voice_draft")) blockers.push("An answer was drafted in your voice; you review those.");
  if (run.decisions.some((decision) => decision.action === "keep")) blockers.push("The site kept an attachment you need to confirm.");
  return blockers;
}
