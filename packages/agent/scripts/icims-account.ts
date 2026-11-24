import { workspaceProfileSchema } from "@internship-agent/domain";

import { clearIcimsAccountHold, getIcimsAccount, icimsAccountsFile, IcimsAccountsFileError, listIcimsAccounts } from "../src/icims-account-store";

/**
 * The iCIMS accounts the agent created or signed in to. Without options it
 * lists hosts and their state (no emails or passwords). `--site <host or
 * iCIMS URL>` prints that one host's email and password for you to sign in
 * yourself; with `--clear-hold` it clears the host's hold instead (the
 * password stays), so the next pass retries it.
 *
 * Usage: pnpm icims:account [--profile real|demo] [--site <host> [--clear-hold]]
 */
const ICIMS_HOST = /^[a-z0-9-]+\.icims\.com$/;
const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function hostFrom(raw: string): string | null {
  const text = raw.trim();
  if (text.startsWith("https://")) {
    try {
      return new URL(text).hostname.toLocaleLowerCase("en-US");
    } catch {
      return null;
    }
  }
  return text.toLocaleLowerCase("en-US");
}

async function main(): Promise<number> {
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  const file = icimsAccountsFile(profile, process.env);
  if (!file) {
    console.log("iCIMS accounts: set INTERNSHIP_AGENT_ICIMS_ACCOUNTS_FILE when INTERNSHIP_AGENT_DATA_DIR is set.");
    return 1;
  }
  try {
    if (args.includes("--site")) {
      const host = hostFrom(value("--site") ?? "");
      if (!host || !ICIMS_HOST.test(host)) { console.log("Give an iCIMS host like careers-acme.icims.com or an iCIMS job URL."); return 1; }
      if (args.includes("--clear-hold")) {
        if (!clearIcimsAccountHold(file, host)) { console.log(`No saved account for ${host}.`); return 1; }
        console.log(`Cleared the hold for ${host}; the next pipeline pass retries it.`);
        return 0;
      }
      const entry = getIcimsAccount(file, host);
      if (!entry?.password) { console.log(`No saved password for ${host}.`); return 1; }
      console.log(`email: ${entry.email}`);
      console.log(`password: ${entry.password}`);
      return 0;
    }
    console.log(`Accounts file: ${file}`);
    const accounts = listIcimsAccounts(file);
    if (accounts.length === 0) console.log("No iCIMS accounts saved yet.");
    for (const entry of accounts) {
      console.log(`${entry.host}  account=${entry.account ?? "none"}  hold=${entry.hold ?? "none"}  updated=${entry.updatedAt}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof IcimsAccountsFileError) { console.log(error.message); return 1; }
    throw error;
  }
}

process.exitCode = await main();
