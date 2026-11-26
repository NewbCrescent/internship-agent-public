import type { DatabaseSync } from "node:sqlite";

import { getJobPosting, logApplicationEvent } from "@internship-agent/db";
import {
  chooseResidenceOption,
  STANDING_DIALOG_LEAVE_TEXT,
  type BrowserPage,
  type JobviteConsentOutcome,
  type StandingDialogAcceptance,
  type StandingDialogLeaveReason,
  type StandingInputs
} from "@internship-agent/browser";
import type { FillDecision, StandingConsentSettings } from "@internship-agent/domain";

/**
 * The orchestrator's side of the candidate's standing consent and
 * attestation settings (packages/domain standing-consent.ts): the planner
 * inputs for a run, the timeline entries for every statement accepted or
 * signed, and Jobvite's Data Consent step. A modal dialog over the form
 * agreed to under the same settings, or left to the candidate, is logged here
 * too (Track 40). The legal name a signature types
 * appears only in local SQLite rows (events and run decisions), never in
 * console output, errors, reports, or notices.
 */

/** Today's local calendar date, YYYY-MM-DD. */
function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function standingPlannerInputs(
  candidate: { legalFirstName?: string | null; legalLastName?: string | null; fullName?: string | null } | null,
  settings: StandingConsentSettings,
  now: Date = new Date()
): StandingInputs {
  const first = candidate?.legalFirstName?.trim();
  const last = candidate?.legalLastName?.trim();
  const full = candidate?.fullName?.trim();
  const signatureName = first && last ? `${first} ${last}` : full || undefined;
  return { ...settings, signatureName, today: localDate(now) };
}

const SETTING_WORDS = {
  accept_data_consent: "Accepted data consent",
  sign_attestations: "Accepted attestation",
  both: "Accepted data consent and attestation"
} as const;

function eventText(decision: FillDecision): string | null {
  const basis = decision.basis;
  if (basis?.kind !== "standing_consent") return null;
  if (!["fill", "check", "choose"].includes(decision.action)) return null;
  if (basis.group === "e-signature") return `Signed attestation: '${basis.statement}' — signed as ${decision.value ?? ""}`;
  if (basis.group === "signature-date") return `Dated the signature: '${basis.statement}' as ${decision.value ?? ""}`;
  return `${SETTING_WORDS[basis.setting]}: '${basis.statement}'`;
}

/**
 * One timeline event per statement accepted or signed under the standing
 * settings (status unchanged). Decisions already in `earlier` (the same field
 * and statement) are not logged again.
 */
export function logStandingAcceptances(database: DatabaseSync, jobId: string, decisions: FillDecision[], earlier: FillDecision[] = []): void {
  const seen = new Set(earlier.filter((decision) => eventText(decision) !== null).map((decision) => {
    const basis = decision.basis as Extract<NonNullable<FillDecision["basis"]>, { kind: "standing_consent" }>;
    return `${decision.fieldId}\u0000${basis.group}\u0000${basis.statement}`;
  }));
  for (const decision of decisions) {
    const text = eventText(decision);
    if (!text) continue;
    const basis = decision.basis as Extract<NonNullable<FillDecision["basis"]>, { kind: "standing_consent" }>;
    const key = `${decision.fieldId}\u0000${basis.group}\u0000${basis.statement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = getJobPosting(database, jobId)?.status ?? "APPLYING";
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: text.slice(0, 1_000) });
  }
}

/** The timeline text for a click on a dialog's agree button under the standing settings (Track 40). */
export function standingDialogEventText(acceptance: StandingDialogAcceptance): string {
  const where = acceptance.label ? `the dialog "${acceptance.label}"` : "a dialog";
  const stayed = acceptance.outcome === "still-shown" ? " The dialog was still shown after the click." : "";
  return `${SETTING_WORDS[acceptance.setting]}: '${acceptance.statements.join(" ")}' — clicked "${acceptance.button}" on ${where} over the form. Dialog text: '${acceptance.text}'.${stayed}`;
}

/** One timeline event (status unchanged) for a dialog agreed to under the standing settings, with its exact text (Track 40). */
export function logStandingDialogAcceptance(database: DatabaseSync, jobId: string, acceptance: StandingDialogAcceptance): void {
  const status = getJobPosting(database, jobId)?.status ?? "APPLYING";
  logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: standingDialogEventText(acceptance) });
}

/** One timeline event (status unchanged) for a covering dialog left to the candidate, and why (Track 40). */
export function logStandingDialogLeft(database: DatabaseSync, jobId: string, left: { label: string; reason: StandingDialogLeaveReason }): void {
  const status = getJobPosting(database, jobId)?.status ?? "APPLYING";
  const where = left.label ? `the dialog "${left.label}"` : "a dialog";
  logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: `Left ${where} over the form for you: ${STANDING_DIALOG_LEAVE_TEXT[left.reason]}.` });
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return "jobs.jobvite.com"; }
}

/**
 * Jobvite's Data Consent step under the standing data-consent setting: the
 * residence matching the profile country, then Accept, logged with the
 * policy text. Resolves null once accepted, else the candidate-facing reason
 * the run stops.
 */
export async function acceptJobviteConsentStep(
  database: DatabaseSync,
  page: BrowserPage & { jobviteConsent(choose: (options: string[]) => string | null): Promise<JobviteConsentOutcome> },
  input: { jobId: string; country: string | null | undefined }
): Promise<string | null> {
  const host = hostOf(page.url());
  const country = input.country?.trim();
  if (!country) {
    return `Jobvite at ${host} asks for your location of residence, and your profile has no country. Add it on the profile page, then start the run again.`;
  }
  const outcome = await page.jobviteConsent((options) => chooseResidenceOption(country, options));
  switch (outcome.result) {
    case "accepted": {
      const text = outcome.policyText ? outcome.policyText.slice(0, 700) : outcome.acceptText;
      const status = getJobPosting(database, input.jobId)?.status ?? "READY_FOR_REVIEW";
      logApplicationEvent(database, {
        jobId: input.jobId, fromStatus: status, toStatus: status,
        detail: `Accepted data consent: '${text}' (Jobvite Data Consent at ${host}; residence "${outcome.residence}")`.slice(0, 1_000)
      });
      return null;
    }
    case "no-residence":
      return `Jobvite at ${host} offers no residence option that matches your profile country (${country}). Choose it in the agent's browser, then start the run yourself.`;
    case "captcha":
      return `Jobvite at ${host} shows a CAPTCHA on its data-consent step; the agent never solves CAPTCHAs.`;
    case "still-shown":
      return `Jobvite at ${host}: the data-consent step could not be completed (the step was still shown after Accept).`;
    default:
      return `Jobvite at ${host}: the data-consent step could not be completed (${outcome.detail}).`;
  }
}
