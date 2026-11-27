import type { DatabaseSync } from "node:sqlite";

import { getJobPosting, logApplicationEvent } from "@internship-agent/db";
import {
  hasOracleSteps,
  isOracleCandidateExperienceUrl,
  OracleApplyStepError,
  recognizeCurrentForm,
  siteWallReason,
  type BrowserPage,
  type OracleApplyScreen,
  type OracleWaitOptions
} from "@internship-agent/browser";
import { standingStatementDecision, type RecognizedForm, type StandingBasisSetting, type StandingConsentSettings } from "@internship-agent/domain";

import { gmailMailboxFactory, gmailSettings } from "./gmail-mailbox";
import { companyMailDomains, ORACLE_CODE_TIMEOUT_MS, pollOracleVerificationCode, type OracleCodeResult } from "./oracle-verification-mail";
import { MailboxUnavailable, type VerificationMailboxFactory } from "./workday-verification-mail";

/**
 * Oracle Cloud HCM Candidate Experience's email step, taken in start,
 * continue, and submit: the saved email is typed, the terms box is accepted
 * only under the standing settings (logged with its exact text), and a
 * one-time code Oracle emails is read from the candidate's own mailbox
 * (oracle-verification-mail.ts) and typed once, never resent. Every stop
 * names what happened in a fixed sentence carrying only the host, the terms
 * statement, a fixed mailbox phrase, or a path; never the email or the code.
 * Nothing here writes to the console. An application section page
 * (`/apply/section/N`) is read only once Oracle has drawn its form
 * (`oracle.formReady`), whether the email step led there or the run opened
 * it (Track 63: Oracle draws its blocks after the page loads).
 */
export type OracleEmailStepSettings = {
  mailbox: VerificationMailboxFactory | null;
  /** The address the mailbox reads (INTERNSHIP_AGENT_GMAIL_ADDRESS). */
  mailboxAddress: string | null;
  codeWait?: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
  stepWait?: OracleWaitOptions;
};

/** The Gmail mailbox from INTERNSHIP_AGENT_GMAIL_* and its address (both null when unset). */
export function oracleEmailStepSettings(env: Record<string, string | undefined> = process.env): OracleEmailStepSettings {
  return { mailbox: gmailMailboxFactory(env), mailboxAddress: gmailSettings(env)?.address ?? null };
}

export type OracleEmailStepOutcome = { kind: "not-shown" } | { kind: "passed"; form: RecognizedForm } | { kind: "stopped"; reason: string };

const SETTING_WORDS: Record<StandingBasisSetting, string> = {
  accept_data_consent: "Accepted data consent",
  sign_attestations: "Accepted attestation",
  both: "Accepted data consent and attestation"
};

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return "the Oracle site"; }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return "an unreadable address"; }
}

/**
 * Takes Oracle's email step when the page shows it (siteWallReason) and has
 * Oracle's steps. Resolves not-shown otherwise (the caller's email-step stop
 * stays), passed with the form behind the step, or stopped with the reason.
 */
export async function passOracleEmailStep(
  database: DatabaseSync,
  page: BrowserPage,
  form: RecognizedForm,
  input: {
    jobId: string;
    company: string;
    candidateEmail: string | null | undefined;
    standing: StandingConsentSettings;
    settings: OracleEmailStepSettings | null | undefined;
    /** The posting's own URLs (its careers page): their domains may send the code (companyMailDomains). */
    companySites?: ReadonlyArray<string | null | undefined>;
  }
): Promise<OracleEmailStepOutcome> {
  // Already at a section page (a signed-in Oracle session skips the email step): its form is read once drawn.
  if (hasOracleSteps(page) && isOracleCandidateExperienceUrl(page.url()) && /\/apply\/section\/\d+(?:\/|$)/.test(pathOf(page.url()))) {
    await page.oracle.formReady(input.settings?.stepWait);
    return { kind: "passed", form: await recognizeCurrentForm(page) };
  }
  if (siteWallReason(page.url(), form.fields) === null || !hasOracleSteps(page) || input.settings === null) return { kind: "not-shown" };
  const settings = input.settings ?? oracleEmailStepSettings(process.env);
  const host = hostOf(page.url());
  const stopped = (reason: string): OracleEmailStepOutcome => ({ kind: "stopped", reason });
  const email = input.candidateEmail?.trim() ?? "";
  if (!email) {
    return stopped(`Oracle Cloud HCM at ${host} asks for your email first, and your profile has no email. Add it on the profile page, then start the run again.`);
  }
  if (!settings.mailbox || !settings.mailboxAddress) {
    return stopped(`Oracle Cloud HCM at ${host} asks for your email and may email you a one-time code, and the agent has no mailbox to read it from (INTERNSHIP_AGENT_GMAIL_ADDRESS and INTERNSHIP_AGENT_GMAIL_APP_PASSWORD). Nothing was typed. Apply in your own browser, or set up the mailbox.`);
  }
  if (settings.mailboxAddress.trim().toLowerCase() !== email.toLowerCase()) {
    return stopped(`Oracle Cloud HCM at ${host} would email its one-time code to your profile email, which is not the mailbox the agent reads (INTERNSHIP_AGENT_GMAIL_ADDRESS). Nothing was typed. Apply in your own browser.`);
  }

  // The setting that covered the terms statement, for the timeline entry.
  const covered: { setting: StandingBasisSetting | null } = { setting: null };
  const accept = (statement: string): boolean => {
    const decision = standingStatementDecision(statement, input.standing);
    if (decision.verdict === "accept") {
      covered.setting = decision.setting;
      return true;
    }
    return false;
  };
  let result: Awaited<ReturnType<typeof page.oracle.submitEmail>>;
  try {
    result = await page.oracle.submitEmail(email, accept, settings.stepWait);
  } catch (error) {
    if (error instanceof OracleApplyStepError) return stopped(`Oracle Cloud HCM at ${host}: ${error.message}; nothing was submitted. Apply in your own browser.`);
    return stopped(`Oracle Cloud HCM at ${host}: its email step could not be completed; nothing was submitted. Apply in your own browser.`);
  }
  if (result.result === "terms-declined") {
    return stopped(`Oracle Cloud HCM at ${host} asks you to accept "${result.statement || "its terms box"}" before applying, and your standing data-consent setting does not cover it, so nothing was typed. Apply in your own browser.`);
  }
  if (result.result === "captcha") {
    return stopped(`Oracle Cloud HCM at ${host} shows a CAPTCHA on its email step; the agent never solves CAPTCHAs, so nothing was typed. Apply in your own browser.`);
  }
  if (result.result === "unexpected") {
    return stopped(`Oracle Cloud HCM at ${host}: its email step did not show the expected email box and Next button, so nothing was typed. Apply in your own browser.`);
  }
  if (result.accepted !== null && covered.setting !== null) {
    const status = getJobPosting(database, input.jobId)?.status ?? "READY_FOR_REVIEW";
    logApplicationEvent(database, {
      jobId: input.jobId, fromStatus: status, toStatus: status,
      detail: `${SETTING_WORDS[covered.setting]}: '${result.accepted}' (Oracle Cloud HCM email step at ${host})`.slice(0, 1_000)
    });
  }
  if (result.result === "stuck") {
    return stopped(`Oracle Cloud HCM at ${host} did not move past its email step after Next${result.detail ? ` ("${result.detail}")` : ""}; nothing else was entered. Apply in your own browser.`);
  }

  const afterStep = async (screen: OracleApplyScreen): Promise<OracleEmailStepOutcome> => {
    switch (screen) {
      case "form":
        await page.oracle.formReady(settings.stepWait);
        return { kind: "passed", form: await recognizeCurrentForm(page) };
      case "identity":
        return stopped(`Oracle Cloud HCM at ${host} asks you to confirm your identity for this email (last name, date of birth, email, or phone) before the application; the agent does not answer that step. Apply in your own browser.`);
      case "already-applied":
        return stopped(`Oracle Cloud HCM at ${host} says you already applied to this job; nothing was submitted. Check the application on the site.`);
      case "captcha":
        return stopped(`Oracle Cloud HCM at ${host} showed a CAPTCHA after its email step; the agent never solves CAPTCHAs. Apply in your own browser.`);
      default:
        return stopped(`Oracle Cloud HCM at ${host} showed a step after its email step that the agent does not recognize (at ${pathOf(page.url())}); nothing else was entered. Apply in your own browser.`);
    }
  };

  if (result.screen !== "pin") return afterStep(result.screen);

  let found: OracleCodeResult;
  try {
    found = await pollOracleVerificationCode(settings.mailbox, { host, company: input.company, companyDomains: companyMailDomains(input.companySites ?? []), since: result.clickedAt }, settings.codeWait ?? {});
  } catch (error) {
    const phrase = error instanceof MailboxUnavailable ? error.message : "the mailbox could not be read";
    return stopped(`Oracle Cloud HCM at ${host} emailed you a one-time code, and the mailbox could not be read (${phrase}), so none was entered. Start the run again later, or apply in your own browser.`);
  }
  if (found.kind === "none") {
    const minutes = Math.max(1, Math.round((settings.codeWait?.timeoutMs ?? ORACLE_CODE_TIMEOUT_MS) / 60_000));
    return stopped(`Oracle Cloud HCM at ${host} emailed you a one-time code, and none arrived in your mailbox within ${minutes} minutes, so none was entered. Start the run again later, or apply in your own browser.`);
  }
  if (found.kind === "ambiguous") {
    return stopped(`Oracle Cloud HCM at ${host} emailed you a one-time code, and more than one code arrived, so none was entered. Apply in your own browser.`);
  }
  const entered = await page.oracle.enterCode(found.code, settings.stepWait);
  switch (entered.result) {
    case "wrong-code":
      return stopped(`Oracle Cloud HCM at ${host} did not accept the emailed code. The agent does not try again (Oracle locks the email after repeated wrong codes); apply in your own browser.`);
    case "not-entered":
      return stopped(`Oracle Cloud HCM at ${host}: its code boxes did not take the emailed code, so nothing was verified. Apply in your own browser.`);
    case "stuck":
      return stopped(`Oracle Cloud HCM at ${host} did not move past its code step after Verify; nothing else was entered. Apply in your own browser.`);
    default:
      return afterStep(entered.screen);
  }
}
