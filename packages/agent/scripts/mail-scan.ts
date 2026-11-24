import { closeProfileDatabase, findBrowserRunIds, getProfileDatabase, resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { discordSettings } from "../src/discord-notify";
import { gmailMailSessionFactory, gmailSettings } from "../src/gmail-mailbox";
import { MAIL_SETUP_MESSAGE, MailAuthFailed, parseMailSince, scanUids, workspaceMailStore, type MailSession } from "../src/mail-watch";
import { catchUpSubmissionReceipt, workspaceReceiptStore } from "../src/submission-receipts";
import { MailboxUnavailable } from "../src/workday-verification-mail";

/**
 * Manual catch-up and debugging for the Gmail outcome watcher, with the same
 * rules: reads the INBOX read-only for mail since --since and DMs matched
 * application outcomes (or, with --dry-run, prints the DM it would send and
 * records nothing). It never moves the watcher's UID position.
 *
 *   pnpm mail:scan [--profile real|demo] [--since 7d] [--dry-run]
 *   pnpm mail:scan [--profile real|demo] --receipt <run reference>
 */
async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
  const dryRun = args.includes("--dry-run");
  const dataDir = resolveProfileDataDirectory(profile);
  if (args.includes("--receipt")) {
    const reference = value("--receipt");
    if (!reference || dryRun || args.includes("--since") || args.filter((arg) => arg === "--receipt").length !== 1) {
      throw new Error("--receipt requires one run reference and cannot be combined with --since or --dry-run.");
    }
    let runs: string[];
    try { runs = findBrowserRunIds(getProfileDatabase(profile), reference); }
    finally { closeProfileDatabase(profile); }
    if (runs.length !== 1) throw new Error("Give one unambiguous run reference.");
    const result = await catchUpSubmissionReceipt({ runId: runs[0]!, store: workspaceReceiptStore(profile, dataDir), connect: gmailMailSessionFactory() });
    console.log(result ? `Receipt check: ${result}.` : "No pending submission hold for that run.");
    return;
  }
  const since = parseMailSince(value("--since") ?? "7d");
  if (!since) {
    console.error("--since takes 1d to 14d, or 1h to 336h.");
    process.exit(1);
  }
  const gmail = gmailSettings();
  const connect = gmailMailSessionFactory();
  const discord = discordSettings();
  if (!gmail || !connect || (!dryRun && !discord)) {
    console.error(MAIL_SETUP_MESSAGE);
    process.exit(1);
  }

  let session: MailSession | null = null;
  try {
    session = await connect();
    const uids = (await session.uidsAfter(0, { since })).slice(-300);
    const result = await scanUids(session, uids, {
      dataDir,
      log: (line) => console.log(line),
      discord,
      candidateAddress: gmail.address,
      secrets: [discord?.token ?? "", gmail.appPassword],
      store: workspaceMailStore(profile)
    }, { dryRun, since, print: (text) => console.log(text) });
    console.log(`Checked ${result.checked} message(s); ${result.items.length} update(s).`);
    if (!result.delivered) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof MailAuthFailed || error instanceof MailboxUnavailable ? error.message : "the scan failed");
    process.exitCode = 1;
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The mailbox scan failed.");
  process.exitCode = 1;
});
