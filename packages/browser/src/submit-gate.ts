import { ATS_KIND_LABELS, atsKindOwnsUrl, type FillDecision, type PauseRecord } from "@internship-agent/domain";
import type { StepButtons } from "./site-navigation";

/**
 * Track 38: the last checks before a submit click. The click goes only to the form's own submit control on its last
 * step, and under the auto-submit policy only on the recognized ATS kind's own site; otherwise the run is held for the
 * candidate with nothing clicked. Messages name only the host, never page text or candidate values.
 */

export const SUBMIT_TARGET_FIELD = "submit-target";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase() || url;
  } catch {
    return url;
  }
}

/**
 * Why the submit click is not made (Track 38), or null: the page still shows a step's "Next" and no submit control
 * (not its last step), or no submit control of the form's own was found. A page that cannot report either (null) is
 * not held for it. Pure.
 */
export function submitTargetHoldReason(input: { url: string; submitShown: boolean | null; stepButtons: StepButtons | null }): string | null {
  const host = hostOf(input.url);
  if (input.stepButtons && !input.stepButtons.submit && input.stepButtons.next) {
    return `The application at ${host} still shows a "${input.stepButtons.next}" button and no submit control, so it is not at its last step; nothing was clicked, and the application is held for you. Finish it in your own browser.`;
  }
  if (input.submitShown === false) {
    return `No submit control of the application form itself was found at ${host} (a cookie banner's button or a step's "Next" is never clicked as submit); nothing was clicked, and the application is held for you. Finish it in your own browser.`;
  }
  return null;
}

/**
 * Under the auto-submit policy, why a run is held because neither the page nor the run's recorded address is on the
 * claimed ATS kind's own site (Track 38), or null (unknown kinds are not checked here). Pure.
 */
export function claimedSiteHoldReason(input: { atsKind: string; pageUrl: string; runUrl: string }): string | null {
  if (!input.atsKind || input.atsKind === "unknown") return null;
  if (atsKindOwnsUrl(input.atsKind, input.pageUrl) || atsKindOwnsUrl(input.atsKind, input.runUrl)) return null;
  const label = (ATS_KIND_LABELS as Record<string, string>)[input.atsKind] ?? input.atsKind;
  const host = hostOf(input.pageUrl);
  return `The application page at ${host} is not on ${label}'s own site, though this run was recognized as ${label}, so the auto-submit policy does not submit it; nothing was typed or clicked, and the application is held for you.`;
}

/** The safeguard pause that holds a run before the submit click; nothing is clicked. Modeled on formChangedPause. */
export function submitTargetPause(reason: string): { decision: FillDecision; pause: PauseRecord } {
  const question = reason.slice(0, 500);
  return {
    decision: { fieldId: SUBMIT_TARGET_FIELD, action: "pause", value: null, basis: null, reason: question, pause: { question, key: null, scope: null, safeguard: true } },
    pause: {
      fieldId: SUBMIT_TARGET_FIELD, label: "Submit button", question, suggestedKey: null, suggestedScope: null,
      safeguard: true, sensitive: false, upload: false, status: "open", answer: null, draft: null
    }
  };
}
