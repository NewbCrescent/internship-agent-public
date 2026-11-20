import { parseWorkdayUrl, workspaceProfileSchema } from "@internship-agent/domain";

import { gmailMailboxFactory } from "../src/gmail-mailbox";
import { getWorkdayAccount, listWorkdayAccounts, workdayAccountsFile, WorkdayAccountsFileError } from "../src/workday-account-store";
import { MailboxUnavailable, relevantWorkdayHeader } from "../src/workday-verification-mail";

/**
 * The Workday accounts the agent created. Without options it lists hosts and
 * their state (no emails or passwords). `--site <host or Workday URL>` prints
 * that one host's email and password for you to sign in yourself.
 * `--check-mail` checks that the Gmail app password opens the mailbox
 * (read-only) and counts recent messages that mention Workday.
 *
 * Usage: pnpm workday:account [--profile real|demo] [--site <host>] [--check-mail]
 */
const WORKDAY_HOST = /^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/;
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

async function main(): Promise<number> {
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  if (args.includes("--check-mail")) {
    const factory = gmailMailboxFactory(process.env);
    if (!factory) { console.log("Gmail is not configured."); return 1; }
    try {
      const mailbox = await factory();
      try {
        const messages = await mailbox.messagesSince(new Date(Date.now() - 86_400_000), relevantWorkdayHeader({ host: "", tenant: "workday", company: "" }));
        console.log(`Mailbox ok: ${messages.length} recent messages mention Workday.`);
      } finally {
        await mailbox.close();
      }
      return 0;
    } catch (error) {
      console.log(error instanceof MailboxUnavailable ? `Mailbox unavailable: ${error.message}.` : "Mailbox unavailable: the check failed.");
      return 1;
    }
  }
  const file = workdayAccountsFile(profile, process.env);
  if (!file) {
    console.log("Workday accounts: set INTERNSHIP_AGENT_WORKDAY_ACCOUNTS_FILE when INTERNSHIP_AGENT_DATA_DIR is set.");
    return 1;
  }
  try {
    const site = value("--site");
    if (args.includes("--site")) {
      const raw = (site ?? "").trim();
      const host = raw.startsWith("https://") ? parseWorkdayUrl(raw)?.host : raw.toLocaleLowerCase("en-US");
      if (!host || !WORKDAY_HOST.test(host)) { console.log("Give a Workday host like acme.wd1.myworkdayjobs.com or a Workday job URL."); return 1; }
      const entry = getWorkdayAccount(file, host);
      if (!entry?.password) { console.log(`No saved account for ${host}.`); return 1; }
      console.log(`email: ${entry.email}`);
      console.log(`password: ${entry.password}`);
      return 0;
    }
    console.log(`Accounts file: ${file}`);
    const accounts = listWorkdayAccounts(file);
    if (accounts.length === 0) console.log("No Workday accounts saved yet.");
    for (const entry of accounts) {
      console.log(`${entry.host}  account=${entry.account ?? "none"}  hold=${entry.hold ?? "none"}  updated=${entry.updatedAt}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof WorkdayAccountsFileError) { console.log(error.message); return 1; }
    throw error;
  }
}

process.exitCode = await main();
