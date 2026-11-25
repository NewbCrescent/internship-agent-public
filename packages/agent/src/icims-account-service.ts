import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { z } from "zod";

import { getJobPosting, logApplicationEvent, resolveProfileDataDirectory } from "@internship-agent/db";
import { icimsHostOf, resolveDataDir, type IcimsAccountSteps, type IcimsStepResult, type IcimsWaitOptions } from "@internship-agent/browser";
import { DATA_CONSENT_GROUPS, manualOnly, standingStatementDecision, type WorkspaceProfile } from "@internship-agent/domain";

import { gmailMailboxFactory } from "./gmail-mailbox";
import { getIcimsAccount, icimsAccountsFile, IcimsAccountsFileError, putIcimsAccount, type IcimsAccountEntry, type IcimsAccountHoldKind } from "./icims-account-store";
import { pollIcimsVerificationLink } from "./icims-verification-mail";
import { IcimsAccountHeld } from "./run-errors";
import { generateWorkdayPassword } from "./workday-account-store";
import { MailboxUnavailable, type VerificationMailboxFactory } from "./workday-verification-mail";

/**
 * iCIMS candidate accounts created and signed in to by the agent, at the
 * candidate's request (INTERNSHIP_AGENT_ICIMS_ACCOUNTS=1 with the account
 * email INTERNSHIP_AGENT_ACCOUNT_EMAIL, else
 * INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL), mirroring the Workday account
 * service. Each iCIMS host gets one random password, saved before it is typed
 * anywhere. The email step's data-consent box is ticked only under the
 * standing data-consent setting, and an attestation box (a privacy-notice
 * acknowledgment) only under the standing attestation setting. CAPTCHAs, existing accounts without a saved
 * password, refused passwords, codes, and unknown screens hold the host for
 * the candidate; nothing is solved, bypassed, or reset. No event, error, or
 * return value carries the password or the email.
 */
export type IcimsAccountSettings = {
  email: string;
  file: string | null;
  mailbox: VerificationMailboxFactory | null;
  mailPollMs?: number;
  mailTimeoutMs?: number;
};

export type IcimsAccountRuntime = {
  email: string;
  file: string;
  mailbox: VerificationMailboxFactory | null;
  mailPollMs?: number;
  mailTimeoutMs?: number;
  now?: () => Date;
  /** How long a step waits for iCIMS's answer to a submit; tests only (production uses the defaults). */
  accountWait?: IcimsWaitOptions;
};

export type ResolvedIcimsAccounts = { runtime: IcimsAccountRuntime } | { disabled: string };

const MISMATCH = "iCIMS accounts: your profile email does not match the account email (INTERNSHIP_AGENT_ACCOUNT_EMAIL, else INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL), so no iCIMS account step ran.";
const UNREADABLE = "iCIMS accounts: the accounts file cannot be read; fix or move it, then run again.";

/** On only with INTERNSHIP_AGENT_ICIMS_ACCOUNTS=1, a valid account email, auto-apply on, and manual checklist mode off. */
export function icimsAccountSettings(env: Record<string, string | undefined> = process.env): IcimsAccountSettings | null {
  if (env.INTERNSHIP_AGENT_ICIMS_ACCOUNTS?.trim() !== "1") return null;
  if (env.INTERNSHIP_AGENT_AUTO_APPLY?.trim() !== "1" || manualOnly(env)) return null;
  const raw = env.INTERNSHIP_AGENT_ACCOUNT_EMAIL?.trim() || env.INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL?.trim() || "";
  if (!raw || !z.email().safeParse(raw).success) return null;
  const file = env.INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE?.trim();
  return { email: raw.toLocaleLowerCase("en-US"), file: file ? resolve(file) : null, mailbox: gmailMailboxFactory(env) };
}

/** Picks the accounts file; a data directory that is neither profile's needs an explicit file. */
export function resolveIcimsAccounts(
  settings: IcimsAccountSettings,
  dataDir?: string,
  env: Record<string, string | undefined> = process.env
): ResolvedIcimsAccounts {
  const runtime = (file: string): ResolvedIcimsAccounts => ({
    runtime: { email: settings.email, file, mailbox: settings.mailbox, mailPollMs: settings.mailPollMs, mailTimeoutMs: settings.mailTimeoutMs }
  });
  if (settings.file) return runtime(settings.file);
  if (env.INTERNSHIP_AGENT_DATA_DIR?.trim()) {
    return { disabled: "iCIMS accounts: set INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE when INTERNSHIP_AGENT_DATA_DIR is set." };
  }
  const current = resolve(resolveDataDir(dataDir));
  const profile = (["real", "demo"] as WorkspaceProfile[]).find((entry) => resolve(resolveProfileDataDirectory(entry)) === current);
  const file = profile ? icimsAccountsFile(profile, env) : null;
  if (!file) return { disabled: "iCIMS accounts: this data directory has no default accounts file; set INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE." };
  return runtime(file);
}

const emailMatches = (candidateEmail: string | null | undefined, email: string) =>
  Boolean(candidateEmail) && candidateEmail!.trim().toLocaleLowerCase("en-US") === email.trim().toLocaleLowerCase("en-US");

/** Retried email-verification holds wait 1 h, doubling per attempt, at most 24 h. */
function verifyDue(at: string, attempts: number, now: Date): boolean {
  const wait = Math.min(86_400_000, 3_600_000 * 2 ** (attempts - 1));
  return now.getTime() - Date.parse(at) >= wait;
}

/** Why the pipeline must not open this iCIMS host yet, or null when it may. */
export function icimsAccountWait(
  resolved: ResolvedIcimsAccounts,
  host: string,
  candidateEmail: string | null | undefined,
  now: Date = new Date(),
  acceptDataConsent = false,
  signAttestations = false
): string | null {
  if ("disabled" in resolved) return resolved.disabled;
  if (!emailMatches(candidateEmail, resolved.runtime.email)) return MISMATCH;
  let entry: IcimsAccountEntry | null;
  try {
    entry = getIcimsAccount(resolved.runtime.file, host);
  } catch (error) {
    if (error instanceof IcimsAccountsFileError) return UNREADABLE;
    throw error;
  }
  const hold = entry?.hold;
  if (!hold) return null;
  if (hold.kind === "verify-email") return verifyDue(hold.at, hold.attempts, now) ? null : hold.reason;
  if (hold.kind === "consent-setting") return acceptDataConsent ? null : hold.reason;
  if (hold.kind === "attestation-setting") return signAttestations ? null : hold.reason;
  return hold.reason;
}

/** Kinds that leave nothing the agent may try again on its own. */
const NO_RETRY: IcimsAccountHoldKind[] = ["wrong-password", "interrupted", "locked", "exists-no-password", "exists", "password-refused"];

export type IcimsAccountInput = {
  database: DatabaseSync;
  jobId: string;
  /** The account step's address; the agent comes back to it after opening a verification link. */
  applicationUrl: string;
  company: string;
  candidate: { email?: string | null; legalFirstName?: string | null; legalLastName?: string | null; phone?: string | null };
  runtime: IcimsAccountRuntime;
  /** The candidate's standing data-consent setting: the email step's data-consent box is ticked only when it is on. */
  acceptDataConsent: boolean;
  /** The candidate's standing attestation setting: privacy-notice acknowledgments and other attestations are ticked only when it is on. */
  signAttestations?: boolean;
};

/**
 * Takes iCIMS's account step for this host: enters the account email, creates
 * the profile (the password saved before it is typed) or signs in with the
 * saved password, and verifies the email through the mailbox when iCIMS asks.
 * Resolves once iCIMS shows the application; throws `IcimsAccountHeld` for
 * every hold.
 */
export async function ensureIcimsAccount(page: { url(): string; icims: IcimsAccountSteps }, input: IcimsAccountInput): Promise<"signed-in" | "created"> {
  const { database, jobId, applicationUrl, company, candidate, runtime, acceptDataConsent, signAttestations = false } = input;
  const now = runtime.now ?? (() => new Date());
  const host = icimsHostOf(page.url());
  if (!host) throw new IcimsAccountHeld("iCIMS: the page is not an iCIMS site, so no account step ran.");
  const yourself = `Finish the step at ${host} yourself.`;

  const event = (detail: string) => {
    const status = getJobPosting(database, jobId)?.status ?? "READY_FOR_REVIEW";
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: detail.slice(0, 1_000) });
  };

  if (!emailMatches(candidate.email, runtime.email)) throw new IcimsAccountHeld(MISMATCH);

  let current: IcimsAccountEntry | null;
  try {
    current = getIcimsAccount(runtime.file, host);
  } catch (error) {
    if (error instanceof IcimsAccountsFileError) throw new IcimsAccountHeld(UNREADABLE);
    throw error;
  }

  const save = (changes: Partial<IcimsAccountEntry>) => {
    const stamp = now().toISOString();
    const next: IcimsAccountEntry = {
      host,
      email: current?.email ?? runtime.email,
      password: current?.password ?? null,
      account: current?.account ?? null,
      hold: current?.hold ?? null,
      createdAt: current?.createdAt ?? stamp,
      ...changes,
      updatedAt: stamp
    };
    putIcimsAccount(runtime.file, next);
    current = next;
  };
  const hold = (kind: IcimsAccountHoldKind, reason: string, changes: Partial<IcimsAccountEntry> = {}): never => {
    const previous = current?.hold;
    const text = reason.slice(0, 500);
    save({ ...changes, hold: { kind, reason: text, at: now().toISOString(), attempts: previous?.kind === kind ? previous.attempts + 1 : 1 } });
    throw new IcimsAccountHeld(text);
  };
  const unexpected = (detail: string | undefined): never =>
    hold("unexpected", `iCIMS ${host}: the account step stopped (${detail ?? "a page the agent does not recognize"}). ${yourself}`);
  const redact = (text: string) => {
    let result = text;
    for (const secret of [current?.password, current?.email, runtime.email]) {
      if (!secret) continue;
      result = result.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
    }
    return result;
  };
  const safely = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (error instanceof IcimsAccountHeld) throw error;
      const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
      return hold("unexpected", `iCIMS ${host}: the account step failed in the browser (${redact(first).slice(0, 150)}).`);
    }
  };
  const captcha = (): never =>
    hold("captcha", `iCIMS ${host}: iCIMS shows a CAPTCHA, and the agent never solves CAPTCHAs. Finish the step at ${host} yourself.`);
  const siteError = (after: string, outcome: Extract<IcimsStepResult, { result: "error" }>): never =>
    hold("unexpected", `iCIMS ${host}: iCIMS showed an error after ${after}: "${redact(outcome.message).slice(0, 300)}". ${yourself}`);

  // Never type a password iCIMS refused, never retry a lockout, and never guess an existing account's password.
  if (current && (current.account === "refused" || (current.hold && NO_RETRY.includes(current.hold.kind)))) {
    throw new IcimsAccountHeld(current.hold?.reason ?? `iCIMS ${host}: iCIMS refused the saved account. ${yourself}`);
  }

  // Only a statement the candidate's standing settings cover (data consent, attestations), and only while that setting is on.
  const settings = { acceptDataConsent, signAttestations };
  const decide = (statement: string) => standingStatementDecision(statement, settings);
  const accept = (statement: string) => decide(statement).verdict === "accept";
  const ACCEPTED_WORDS = { accept_data_consent: "Accepted data consent", sign_attestations: "Accepted attestation", both: "Accepted data consent and attestation" } as const;
  const logged = new Set<string>();
  const logAccepted = (statements: string[], step: string) => {
    for (const statement of statements) {
      if (logged.has(statement)) continue;
      logged.add(statement);
      const decision = decide(statement);
      const words = decision.verdict === "accept" ? ACCEPTED_WORDS[decision.setting] : "Accepted data consent";
      event(`${words}: '${statement}' (iCIMS ${step} at ${host})`);
    }
  };
  const consentHold = (statement: string, step: string): never => {
    const quoted = statement.slice(0, 200);
    const decision = decide(statement);
    if (decision.verdict === "needs-setting") {
      const needsData = decision.groups.some((group) => DATA_CONSENT_GROUPS.has(group));
      if (needsData && !acceptDataConsent) {
        return hold("consent-setting", `iCIMS ${host}: the ${step} asks you to agree to "${quoted}"; the agent accepts it only under your standing data-consent setting.`);
      }
      return hold("attestation-setting", `iCIMS ${host}: the ${step} asks you to agree to "${quoted}"; the agent accepts it only under your standing attestation setting.`);
    }
    return hold("consent-unknown", `iCIMS ${host}: the ${step} asks you to agree to "${quoted}", which is not a data-processing consent the agent may accept. ${yourself}`);
  };

  let created = false;
  let signedIn = false;
  let verified = false;
  for (let screens = 0; screens < 8; screens += 1) {
    const screen = await safely(() => page.icims.screen());
    switch (screen) {
      case "captcha":
        return captcha();
      case "application": {
        if (created) {
          save({ account: "created", hold: null });
          event(`iCIMS ${host}: account created with your email; the password is saved locally.`);
          return "created";
        }
        if (signedIn) {
          // Signing in proves the account exists (an earlier create that never confirmed included).
          save({ account: "created", hold: null });
          event(`iCIMS ${host}: signed in with the saved account.`);
        }
        return "signed-in";
      }
      case "email": {
        const outcome = await safely(() => page.icims.submitEmail(runtime.email, accept, runtime.accountWait));
        logAccepted(outcome.accepted, "email step");
        if (outcome.result === "next") continue;
        if (outcome.result === "consent-needed") return consentHold(outcome.statement, "email step");
        if (outcome.result === "error") return outcome.kind === "captcha" ? captcha() : siteError("the email step", outcome);
        if (outcome.result === "no-answer") return unexpected("iCIMS did not answer the email step");
        return unexpected(outcome.detail);
      }
      case "create": {
        const firstName = candidate.legalFirstName?.trim();
        const lastName = candidate.legalLastName?.trim();
        if (!firstName || !lastName) {
          return hold("profile", `iCIMS ${host}: the create-profile form needs your legal first and last name; add them on the profile page.`);
        }
        let password: string;
        if (current?.password && (current.account === null || current.account === "pending")) {
          // A create that never finished: the same password again.
          password = current.password;
        } else {
          // The password is saved before anything is typed.
          password = generateWorkdayPassword();
          save({ email: runtime.email, password, account: null, hold: null, createdAt: now().toISOString() });
        }
        const outcome = await safely(() => page.icims.createProfile(
          { email: runtime.email, password, firstName, lastName, phone: candidate.phone?.trim() || undefined },
          accept,
          () => save({ account: "pending" }),
          runtime.accountWait
        ));
        logAccepted(outcome.accepted, "create-profile step");
        if (outcome.result === "next") {
          created = true;
          continue;
        }
        if (outcome.result === "consent-needed") return consentHold(outcome.statement, "create-profile step");
        if (outcome.result === "other") {
          if (outcome.detail.startsWith("the create-profile form asks for")) {
            return hold("profile", `iCIMS ${host}: ${outcome.detail}, which the agent does not fill. ${yourself}`);
          }
          return unexpected(outcome.detail);
        }
        if (outcome.result === "error") {
          if (outcome.kind === "exists") {
            return hold("exists", `iCIMS ${host}: iCIMS says an account already exists for this email; the agent never resets passwords. ${yourself}`, { account: "refused" });
          }
          if (outcome.kind === "password-refused") {
            return hold("password-refused", `iCIMS ${host}: iCIMS refused the generated password; the agent does not try another. ${yourself}`, { account: "refused" });
          }
          if (outcome.kind === "captcha") return captcha();
          return siteError("the create-profile submit", outcome);
        }
        return hold("interrupted", `iCIMS ${host}: iCIMS did not answer the create-profile submit, so the account may not exist; the agent does not submit it again. ${yourself}`);
      }
      case "sign-in": {
        const entry = current;
        if (!entry?.password || entry.account === "refused") {
          return hold("exists-no-password", `iCIMS ${host}: an iCIMS account exists for your email at ${host} but no password is saved. Sign in at ${host} yourself, then start the run yourself.`);
        }
        if (signedIn) return unexpected("the sign-in screen came back after signing in");
        const password = entry.password;
        const outcome = await safely(() => page.icims.signIn({ email: entry.email, password }, runtime.accountWait));
        if (outcome.result === "next") {
          signedIn = true;
          continue;
        }
        if (outcome.result === "error") {
          if (outcome.kind === "wrong-password" || outcome.kind === "no-account") {
            if (entry.account === "pending") {
              return hold("interrupted", `iCIMS ${host}: an earlier account creation did not finish, and iCIMS does not accept the saved password. ${yourself}`);
            }
            return hold("wrong-password", `iCIMS ${host}: iCIMS refused the saved password; the agent does not try it again. ${yourself}`);
          }
          if (outcome.kind === "locked") return hold("locked", `iCIMS ${host}: iCIMS says the account is locked or disabled; the agent does not try again. ${yourself}`);
          if (outcome.kind === "captcha") return captcha();
          return siteError("the sign-in", outcome);
        }
        if (outcome.result === "no-answer") return unexpected("iCIMS did not answer the sign-in");
        return unexpected(outcome.result === "other" ? outcome.detail : undefined);
      }
      case "verify-email": {
        if (created) save({ account: "created" });
        if (!current?.password) {
          return hold("verify-email", `iCIMS ${host}: iCIMS asks to verify an account email, and no password is saved for it. ${yourself}`);
        }
        if (verified) return hold("verify-email", `iCIMS ${host}: iCIMS still asks to verify the email after the link was opened.`);
        const mailbox = runtime.mailbox;
        if (!mailbox) return hold("verify-email", `iCIMS ${host}: verify the account email iCIMS sent you; the agent signs in again on a later pass.`);
        const timeoutMs = runtime.mailTimeoutMs ?? 180_000;
        let result: Awaited<ReturnType<typeof pollIcimsVerificationLink>>;
        try {
          result = await pollIcimsVerificationLink(mailbox, { host, company, since: new Date(current.createdAt) }, { pollMs: runtime.mailPollMs, timeoutMs });
        } catch (error) {
          if (error instanceof MailboxUnavailable) return hold("verify-email", `iCIMS ${host}: the verification email could not be read (${error.message}).`);
          throw error;
        }
        if (result.kind === "none") {
          const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
          return hold("verify-email", `iCIMS ${host}: verification email not found within ${minutes} minute${minutes === 1 ? "" : "s"}; the agent checks again on a later pass.`);
        }
        if (result.kind === "ambiguous") {
          return hold("verify-email", `iCIMS ${host}: several verification links arrived; open the newest one yourself, and the agent signs in on a later pass.`);
        }
        const link = result.link;
        await safely(() => page.icims.openInNewTab(link));
        event(`iCIMS ${host}: verification email found and opened.`);
        await safely(() => page.icims.goto(applicationUrl));
        verified = true;
        continue;
      }
      case "code":
        return hold("verify-email", `iCIMS ${host}: iCIMS asks for a code it emailed; the agent does not enter iCIMS codes yet. ${yourself}`);
      default:
        return hold("unexpected", `iCIMS ${host}: the account step stopped (a page the agent does not recognize). ${yourself}`);
    }
  }
  return unexpected("too many account screens");
}
