import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { z } from "zod";

import { getJobPosting, logApplicationEvent, resolveProfileDataDirectory, saveBrowserSession } from "@internship-agent/db";
import { resolveDataDir, type WorkdayAccountOutcome, type WorkdayPage, type WorkdaySettleOptions } from "@internship-agent/browser";
import { manualOnly, parseWorkdayUrl, workdaySiteKey, type WorkspaceProfile } from "@internship-agent/domain";

import { gmailMailboxFactory } from "./gmail-mailbox";
import { WorkdayAccountHeld } from "./run-errors";
import {
  generateWorkdayPassword,
  getWorkdayAccount,
  putWorkdayAccount,
  workdayAccountsFile,
  WorkdayAccountsFileError,
  type WorkdayAccountEntry,
  type WorkdayAccountHoldKind
} from "./workday-account-store";
import { MailboxUnavailable, pollVerificationLink, type VerificationMailboxFactory } from "./workday-verification-mail";

/**
 * Workday candidate accounts created and signed in by the agent, at the
 * candidate's request (INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL). Each Workday
 * host gets one random password, saved before it is typed anywhere. CAPTCHAs,
 * existing accounts, refused passwords, and unknown screens hold the host for
 * the candidate; nothing is solved, bypassed, or reset. No event, session
 * detail, error, or return value carries the password or the email.
 */
export type WorkdayAccountSettings = {
  email: string;
  file: string | null;
  mailbox: VerificationMailboxFactory | null;
  /** Mail polling interval and window; tests shorten them. */
  mailPollMs?: number;
  mailTimeoutMs?: number;
};

export type WorkdayAccountRuntime = {
  email: string;
  file: string;
  mailbox: VerificationMailboxFactory | null;
  mailPollMs?: number;
  mailTimeoutMs?: number;
  now?: () => Date;
  /** How long the account step waits for Workday's answer to a submit; tests only (production uses the defaults). */
  accountWait?: WorkdaySettleOptions;
};

export type ResolvedWorkdayAccounts = { runtime: WorkdayAccountRuntime } | { disabled: string };

const MISMATCH = "Workday accounts: your profile email does not match INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL, so no account was created.";
const UNREADABLE = "Workday accounts: the accounts file cannot be read; fix or move it, then run again.";
const YOURSELF = "Sign in yourself with Open sign-in on the Workday accounts page.";

/** On only with a valid account email, auto-apply on, and manual checklist mode off. */
export function workdayAccountSettings(env: Record<string, string | undefined> = process.env): WorkdayAccountSettings | null {
  const raw = env.INTERNSHIP_AGENT_WORKDAY_ACCOUNT_EMAIL?.trim() ?? "";
  if (!raw || !z.email().safeParse(raw).success) return null;
  if (env.INTERNSHIP_AGENT_AUTO_APPLY?.trim() !== "1" || manualOnly(env)) return null;
  const file = env.INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE?.trim();
  return { email: raw.toLocaleLowerCase("en-US"), file: file ? resolve(file) : null, mailbox: gmailMailboxFactory(env) };
}

/** Picks the accounts file; a data directory that is neither profile's needs an explicit file. */
export function resolveWorkdayAccounts(
  settings: WorkdayAccountSettings,
  dataDir?: string,
  env: Record<string, string | undefined> = process.env
): ResolvedWorkdayAccounts {
  const runtime = (file: string): ResolvedWorkdayAccounts => ({
    runtime: { email: settings.email, file, mailbox: settings.mailbox, mailPollMs: settings.mailPollMs, mailTimeoutMs: settings.mailTimeoutMs }
  });
  if (settings.file) return runtime(settings.file);
  if (env.INTERNSHIP_AGENT_DATA_DIR?.trim()) {
    return { disabled: "Workday accounts: set INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE when INTERNSHIP_AGENT_DATA_DIR is set." };
  }
  const current = resolve(resolveDataDir(dataDir));
  const profile = (["real", "demo"] as WorkspaceProfile[]).find((entry) => resolve(resolveProfileDataDirectory(entry)) === current);
  const file = profile ? workdayAccountsFile(profile, env) : null;
  if (!file) return { disabled: "Workday accounts: this data directory has no default accounts file; set INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE." };
  return runtime(file);
}

const emailMatches = (candidateEmail: string | null | undefined, email: string) =>
  Boolean(candidateEmail) && candidateEmail!.trim().toLocaleLowerCase("en-US") === email.trim().toLocaleLowerCase("en-US");

/** Retried email-verification holds wait 1 h, doubling per attempt, at most 24 h. */
function verifyDue(at: string, attempts: number, now: Date): boolean {
  const wait = Math.min(86_400_000, 3_600_000 * 2 ** (attempts - 1));
  return now.getTime() - Date.parse(at) >= wait;
}

/** Why the pipeline must not open a signed-out Workday host yet, or null when it may. */
export function workdayAccountWait(
  resolved: ResolvedWorkdayAccounts,
  host: string,
  candidateEmail: string | null | undefined,
  now: Date = new Date()
): string | null {
  if ("disabled" in resolved) return resolved.disabled;
  if (!emailMatches(candidateEmail, resolved.runtime.email)) return MISMATCH;
  let entry: WorkdayAccountEntry | null;
  try {
    entry = getWorkdayAccount(resolved.runtime.file, host);
  } catch (error) {
    if (error instanceof WorkdayAccountsFileError) return UNREADABLE;
    throw error;
  }
  const hold = entry?.hold;
  if (!hold) return null;
  if (hold.kind !== "verify-email") return hold.reason;
  return verifyDue(hold.at, hold.attempts, now) ? null : hold.reason;
}

/** Kinds that leave no password the agent may type again. */
const NO_RETRY: WorkdayAccountHoldKind[] = ["wrong-password", "interrupted", "locked"];

/**
 * Signs in with the saved account for this Workday host, or (mode `create`)
 * creates one, verifying the email through the mailbox when Workday asks.
 * Throws `WorkdayAccountHeld` for every hold.
 */
export async function ensureWorkdayAccount(
  page: WorkdayPage,
  input: {
    database: DatabaseSync;
    jobId: string;
    applicationUrl: string;
    company: string;
    candidateEmail: string | null | undefined;
    runtime: WorkdayAccountRuntime;
    mode: "create" | "sign-in";
  }
): Promise<"signed-in" | "created"> {
  const { database, jobId, applicationUrl, company, runtime, mode } = input;
  const now = runtime.now ?? (() => new Date());
  const location = parseWorkdayUrl(applicationUrl);
  if (!location) throw new WorkdayAccountHeld("Workday: the application link is not a Workday career site, so no account step ran.");
  const { host, tenant } = location;
  const siteKey = workdaySiteKey(location);

  const session = (status: "connected" | "signed_out", detail: string) => {
    saveBrowserSession(database, { site: siteKey, status, detail: detail.slice(0, 500), checkedAt: now().toISOString() });
  };
  const event = (detail: string) => {
    const status = getJobPosting(database, jobId)?.status ?? "READY_FOR_REVIEW";
    logApplicationEvent(database, { jobId, fromStatus: status, toStatus: status, detail: detail.slice(0, 1_000) });
  };

  if (!emailMatches(input.candidateEmail, runtime.email)) {
    session("signed_out", MISMATCH);
    throw new WorkdayAccountHeld(MISMATCH);
  }

  let current: WorkdayAccountEntry | null;
  try {
    current = getWorkdayAccount(runtime.file, host);
  } catch (error) {
    if (error instanceof WorkdayAccountsFileError) {
      session("signed_out", UNREADABLE);
      throw new WorkdayAccountHeld(UNREADABLE);
    }
    throw error;
  }

  const save = (changes: Partial<WorkdayAccountEntry>) => {
    const stamp = now().toISOString();
    const next: WorkdayAccountEntry = {
      host,
      email: current?.email ?? runtime.email,
      password: current?.password ?? null,
      account: current?.account ?? null,
      hold: current?.hold ?? null,
      createdAt: current?.createdAt ?? stamp,
      ...changes,
      updatedAt: stamp
    };
    putWorkdayAccount(runtime.file, next);
    current = next;
  };
  const hold = (kind: WorkdayAccountHoldKind, reason: string, changes: Partial<WorkdayAccountEntry> = {}): never => {
    const previous = current?.hold;
    const text = reason.slice(0, 500);
    save({ ...changes, hold: { kind, reason: text, at: now().toISOString(), attempts: previous?.kind === kind ? previous.attempts + 1 : 1 } });
    session("signed_out", text);
    throw new WorkdayAccountHeld(text);
  };
  const unexpected = (detail: string | undefined): never =>
    hold("unexpected", `Workday ${host}: the account step stopped (${detail ?? "a page the agent does not recognize"}). ${YOURSELF}`);
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
      if (error instanceof WorkdayAccountHeld) throw error;
      const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
      return hold("unexpected", `Workday ${host}: the account step failed in the browser (${redact(first).slice(0, 150)}).`);
    }
  };
  /** Workday's own error text, redacted, in an "unexpected" hold. */
  const workdayError = (after: string, outcome: WorkdayAccountOutcome): never =>
    hold("unexpected", `Workday ${host}: Workday showed an error after ${after}: "${redact(outcome.message ?? "").slice(0, 300)}". ${YOURSELF}`);
  const connected = (detail: string, eventText: string) => {
    save({ account: "created", hold: null });
    session("connected", detail);
    event(eventText);
  };

  const accountScreen = page.accountScreen?.bind(page);
  const signInToAccount = page.signInToAccount?.bind(page);
  const createAccount = page.createAccount?.bind(page);
  const openInNewTab = page.openInNewTab?.bind(page);
  const goto = page.goto?.bind(page);
  if (!accountScreen || !signInToAccount || !createAccount || !openInNewTab || !goto) {
    return unexpected("the browser page cannot run account steps");
  }

  // Never type a password Workday already refused, and never retry a lockout.
  if (current && (current.account === "refused" || (current.hold && NO_RETRY.includes(current.hold.kind)))) {
    const reason = current.hold?.reason ?? `Workday ${host}: Workday refused the saved account. ${YOURSELF}`;
    session("signed_out", reason);
    throw new WorkdayAccountHeld(reason);
  }

  const verifyFlow = async (): Promise<"signed-in"> => {
    if (!runtime.mailbox) {
      return hold("verify-email", `Workday ${host}: verify the account email Workday sent you; the agent signs in again on a later pass.`);
    }
    const timeoutMs = runtime.mailTimeoutMs ?? 180_000;
    let result: Awaited<ReturnType<typeof pollVerificationLink>>;
    try {
      result = await pollVerificationLink(runtime.mailbox, { host, tenant, company, since: new Date(current!.createdAt) }, {
        pollMs: runtime.mailPollMs, timeoutMs
      });
    } catch (error) {
      if (error instanceof MailboxUnavailable) return hold("verify-email", `Workday ${host}: the verification email could not be read (${error.message}).`);
      throw error;
    }
    if (result.kind === "none") {
      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      return hold("verify-email", `Workday ${host}: verification email not found within ${minutes} minute${minutes === 1 ? "" : "s"}; the agent checks again on a later pass.`);
    }
    if (result.kind === "ambiguous") {
      return hold("verify-email", `Workday ${host}: several verification links arrived; open the newest one yourself, and the agent signs in on a later pass.`);
    }
    const link = result.link;
    await safely(() => openInNewTab(link));
    event(`Workday ${host}: verification email found and opened.`);
    await safely(() => goto(applicationUrl));
    const entered = await safely(() => page.enterApplication());
    if (entered === "flow" && !(await safely(() => page.signInRequired()))) {
      connected(`The agent signed in to ${company}'s Workday with the saved account.`, `Workday ${host}: signed in with the saved account.`);
      return "signed-in";
    }
    return signInFlow(true);
  };

  /**
   * `afterCreate`: this call just created the account. A sign-in Workday does
   * not answer then may be one it ignores until the email is verified, so with
   * a mailbox the agent looks for the verification email instead of holding.
   */
  const signInFlow = async (afterVerify = false, afterCreate = false): Promise<"signed-in"> => {
    const entry = current!;
    const outcome: WorkdayAccountOutcome = await safely(() => signInToAccount({ email: entry.email, password: entry.password! }, host, runtime.accountWait));
    switch (outcome.result) {
      case "signed-in":
        connected(`The agent signed in to ${company}'s Workday with the saved account.`, `Workday ${host}: signed in with the saved account.`);
        return "signed-in";
      case "verify-email":
        if (afterVerify) return hold("verify-email", `Workday ${host}: Workday still asks to verify the email after the link was opened.`);
        return verifyFlow();
      case "wrong-password":
      case "no-account":
        if (entry.account === "pending") {
          return hold("interrupted", `Workday ${host}: an earlier account creation did not finish, and Workday does not accept the saved password. ${YOURSELF}`);
        }
        return hold("wrong-password", `Workday ${host}: Workday refused the saved password; the agent does not try it again. ${YOURSELF}`);
      case "locked":
        return hold("locked", `Workday ${host}: Workday says the account is locked or disabled; the agent does not try again. ${YOURSELF}`);
      case "captcha":
        return hold("captcha", `Workday ${host}: Workday shows a CAPTCHA, and the agent never solves CAPTCHAs. ${YOURSELF}`);
      case "error":
        return workdayError("the sign-in", outcome);
      default:
        if (afterCreate && outcome.result === "no-answer" && runtime.mailbox) {
          event(`Workday ${host}: Workday did not answer the sign-in after the account was created; the agent looks for the verification email.`);
          return verifyFlow();
        }
        return unexpected(outcome.detail);
    }
  };

  const screen = await safely(() => accountScreen());
  if (screen === "captcha") return hold("captcha", `Workday ${host}: Workday shows a CAPTCHA, and the agent never solves CAPTCHAs. ${YOURSELF}`);
  if (screen === "other-method") return unexpected("a text-message, app or other sign-in method");
  if (screen === "other") return unexpected("a page the agent does not recognize");
  // The application is already showing: there is nothing to sign in to, and nothing is recorded.
  if (screen === "application" || screen === "job") return "signed-in";
  if (screen === "verify-email") {
    if (current?.password) return verifyFlow();
    return hold("verify-email", `Workday ${host}: verify the account email Workday sent you; the agent signs in again on a later pass.`);
  }

  if (current?.password && (current.account === "pending" || current.account === "created")) return signInFlow();
  if (mode === "sign-in") return unexpected("no saved password for this Workday site");

  // Create: the password is saved before it is typed anywhere.
  const password = generateWorkdayPassword();
  const stamp = now().toISOString();
  save({ email: runtime.email, password, account: "pending", hold: null, createdAt: stamp });
  const { outcome, termsLabel } = await safely(() => createAccount({ email: runtime.email, password }, host, runtime.accountWait));
  if (termsLabel) {
    event(`Workday ${host}: checked "${termsLabel}" on the create-account form, as part of your request that the agent create the account.`);
  }
  const created = `Workday ${host}: account created with your email; the password is saved locally.`;
  // "Already exists" or no answer: the account may exist with the password
  // just saved, so the agent signs in once with it (it never resets a
  // password and never submits the create form again).
  const NO_ANSWER = "Workday did not answer the create-account submit within 60 seconds";
  const signInOnce = async (after: "exists" | "no-answer"): Promise<"signed-in" | "created"> => {
    const exists = after === "exists";
    const signedIn: WorkdayAccountOutcome = await safely(() => signInToAccount({ email: runtime.email, password }, host, runtime.accountWait));
    switch (signedIn.result) {
      case "signed-in":
        connected(`The agent signed in to ${company}'s Workday with the saved account.`, exists
          ? `Workday ${host}: Workday said an account already exists for your email; the agent signed in with the saved password.`
          : `Workday ${host}: ${NO_ANSWER}; the agent then signed in with the saved password, so the account exists.`);
        return "created";
      case "verify-email":
        save({ account: "created" });
        event(exists
          ? `Workday ${host}: Workday said an account already exists; signing in asks to verify the email.`
          : `Workday ${host}: ${NO_ANSWER}; signing in shows the account exists and asks to verify the email.`);
        return verifyFlow();
      case "wrong-password":
      case "no-account":
        if (exists) {
          return hold("exists", `Workday ${host}: Workday says an account already exists for this email, and signing in once with the saved password did not work; the agent never resets passwords. ${YOURSELF}`, { account: "refused" });
        }
        return hold("interrupted", `Workday ${host}: ${NO_ANSWER}, and signing in once with the saved password did not work, so the account was probably not created. ${YOURSELF}`);
      case "locked":
        return hold("locked", `Workday ${host}: Workday says the account is locked or disabled; the agent does not try again. ${YOURSELF}`);
      case "captcha":
        return hold("captcha", `Workday ${host}: Workday shows a CAPTCHA, and the agent never solves CAPTCHAs. ${YOURSELF}`);
      case "error":
        return workdayError("the sign-in", signedIn);
      default:
        return unexpected(`${exists ? "Workday said an account already exists" : NO_ANSWER}, and the sign-in after it stopped (${signedIn.detail ?? "a page the agent does not recognize"})`);
    }
  };
  switch (outcome.result) {
    case "signed-in":
      connected(`The agent created a Workday account for ${host} and signed in.`, created);
      return "created";
    case "created":
      save({ account: "created" });
      event(created);
      return signInFlow(false, true);
    case "verify-email":
      save({ account: "created" });
      event(`Workday ${host}: account created; Workday asks to verify the email.`);
      return verifyFlow();
    case "exists":
    case "no-answer":
      return signInOnce(outcome.result);
    case "error":
      return workdayError("the create-account submit", outcome);
    case "password-refused":
      return hold("password-refused", `Workday ${host}: Workday refused the generated password; the agent does not try another. Create the account yourself with Open sign-in on the Workday accounts page.`, { account: "refused" });
    case "captcha":
      return hold("captcha", `Workday ${host}: after the create-account submit Workday shows a CAPTCHA, and the agent never solves CAPTCHAs. ${YOURSELF}`);
    default:
      return unexpected(outcome.detail);
  }
}
