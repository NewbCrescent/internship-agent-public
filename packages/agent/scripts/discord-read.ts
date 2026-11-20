import { runDiscordRead } from "../src/discord-read";

/**
 * `pnpm discord:read [--limit 20] [--since <ISO or 2h/1d>] [--json]`: prints
 * the bot's DM thread with the candidate, oldest first. Read-only.
 */
async function main() {
  process.exitCode = await runDiscordRead(process.argv.slice(2), process.env, {
    log: (line) => console.log(line),
    error: (line) => console.error(line)
  });
}

void main();
