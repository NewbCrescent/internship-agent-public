import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { candidateDeliveryRecipient } from "../src/application-holds";
import { buildDigest, digestSince, readDigestState, sendDailyDigest, workspaceDigestReader } from "../src/daily-digest";
import { discordSettings } from "../src/discord-notify";

/**
 * `pnpm digest:preview [--send] [--profile real|demo]`: prints today's daily
 * digest without sending it, or with --send sends it now (ignoring the 09:00
 * gate) and records it as today's digest.
 */
async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  const profile = workspaceProfileSchema.parse(index >= 0 ? args[index + 1] : "real");
  const dataDir = resolveProfileDataDirectory(profile);
  const now = new Date();
  const settings = discordSettings();
  if (!args.includes("--send")) {
    const read = workspaceDigestReader(profile, { dataDir, recipient: settings ? candidateDeliveryRecipient(settings.userId) : null });
    const digest = buildDigest(read(digestSince(readDigestState(dataDir), now)), now);
    const text = digest?.text ?? "Nothing to report today.";
    console.log(settings ? text.split(settings.token).join("[redacted]") : text);
    return;
  }
  if (!settings) {
    console.error("Set INTERNSHIP_AGENT_DISCORD_BOT_TOKEN and INTERNSHIP_AGENT_DISCORD_USER_ID in the root .env first.");
    process.exitCode = 1;
    return;
  }
  const outcome = await sendDailyDigest({ dataDir, settings, now, read: workspaceDigestReader(profile), profile, force: true, log: (line) => console.log(line) });
  if (outcome === "nothing") console.log("Nothing to report today; nothing sent.");
  if (outcome === "failed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
