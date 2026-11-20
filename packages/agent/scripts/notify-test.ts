import { discordFailureStatus, discordSettings, sendDiscordDm } from "../src/discord-notify";

/** `pnpm notify:test`: sends one DM so the candidate can check the Discord setup. */
async function main() {
  const settings = discordSettings();
  if (!settings) {
    console.error("Set INTERNSHIP_AGENT_DISCORD_BOT_TOKEN and INTERNSHIP_AGENT_DISCORD_USER_ID in the root .env first.");
    process.exitCode = 1;
    return;
  }
  try {
    await sendDiscordDm(settings, "Internship agent connected.");
    console.log("Sent a test DM. Check Discord.");
  } catch (error) {
    console.error(`Discord notify failed: ${discordFailureStatus(error)}`);
    process.exitCode = 1;
  }
}

void main();
