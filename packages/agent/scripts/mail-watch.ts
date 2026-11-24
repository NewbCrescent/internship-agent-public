import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { discordSettings } from "../src/discord-notify";
import { gmailMailSessionFactory, gmailSettings } from "../src/gmail-mailbox";
import { workspaceReceiptStore } from "../src/submission-receipts";
import { MAIL_SETUP_MESSAGE, parseMailSince, runMailWatch, workspaceMailStore } from "../src/mail-watch";

/**
 * The Gmail outcome watcher: holds one read-only IMAP IDLE connection to the
 * INBOX and DMs interview, assessment, offer, rejection, and recruiter emails
 * about the candidate's applications. Runs until SIGINT/SIGTERM; the OS
 * service from `pnpm mail:schedule install` keeps it running. Lines go to
 * stdout and <workspace data>/mail-logs/<date>.log (state only, never mail).
 *
 *   pnpm mail:watch [--profile real|demo] [--since 3d]
 */
async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  const sinceFlag = value("--since");
  const since = sinceFlag === undefined ? undefined : parseMailSince(sinceFlag);
  if (since === null) {
    console.error("--since takes 1d to 14d, or 1h to 336h.");
    process.exit(1);
  }
  const gmail = gmailSettings();
  const discord = discordSettings();
  const connect = gmailMailSessionFactory();
  if (!gmail || !discord || !connect) {
    console.error(MAIL_SETUP_MESSAGE);
    process.exit(1);
  }
  const dataDir = resolveProfileDataDirectory(profile);
  const logDirectory = join(dataDir, "mail-logs");
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    const day = new Date().toLocaleDateString("en-CA");
    appendFileSync(join(logDirectory, `${day}.log`), stamped + "\n", { mode: 0o600 });
  };

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  await runMailWatch({
    dataDir,
    log,
    discord,
    candidateAddress: gmail.address,
    secrets: [discord.token, gmail.appPassword],
    store: workspaceMailStore(profile),
    receipts: workspaceReceiptStore(profile, dataDir),
    connect,
    since,
    signal: controller.signal
  });
  log("Gmail: watcher stopped.");
  process.exit(0);
}

main().catch(() => {
  console.error("The Gmail watcher failed.");
  process.exit(1);
});
