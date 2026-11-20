import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { discordSettings } from "../src/discord-notify";
import { gmailSettings } from "../src/gmail-mailbox";
import { mailWatchLabel, mailWatchLaunchdPlist, mailWatchSystemdService } from "../src/mail-schedule";
import { MAIL_SETUP_MESSAGE } from "../src/mail-watch";

/**
 * Installs, removes, or reports the OS service that keeps the Gmail watcher
 * (`pnpm mail:watch`) running: a systemd user service on Linux, a launchd
 * KeepAlive agent on macOS.
 *
 *   pnpm mail:schedule install|remove|status [--profile real|demo]
 */
const args = process.argv.slice(2);
const action = args[0];
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
const repository = resolve(import.meta.dirname, "../../..");
const logDirectory = join(resolveProfileDataDirectory(profile), "mail-logs");
const label = mailWatchLabel(profile);

if (!["install", "remove", "status"].includes(action ?? "")) {
  console.error("Usage: pnpm mail:schedule install|remove|status [--profile real|demo]");
  process.exit(2);
}
if (action === "install" && (!gmailSettings() || !discordSettings())) {
  // Restart=always would otherwise restart a watcher that exits at once, every 30 s.
  console.error(MAIL_SETUP_MESSAGE);
  process.exit(1);
}

const run = (command: string, commandArgs: string[], quiet = false) => {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (quiet) return null;
    throw error;
  }
};

if (platform() === "darwin") {
  const plist = join(homedir(), "Library", "LaunchAgents", label + ".plist");
  const domain = "gui/" + userInfo().uid;
  if (action === "install") {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    run("launchctl", ["bootout", domain, plist], true);
    writeFileSync(plist, mailWatchLaunchdPlist({ repository, profile, logDirectory }));
    run("launchctl", ["bootstrap", domain, plist]);
    console.log(`Installed ${label}: watches Gmail continuously (restarted if it stops). Log: ${logDirectory}`);
  } else if (action === "remove") {
    run("launchctl", ["bootout", domain, plist], true);
    if (existsSync(plist)) rmSync(plist);
    console.log(`Removed ${label}.`);
  } else {
    const printed = run("launchctl", ["print", `${domain}/${label}`], true);
    console.log(printed ? printed.split("\n").filter((line) => /state =|last exit|runs =|pid =/.test(line)).join("\n") || "Loaded." : "Not installed.");
  }
} else if (platform() === "linux") {
  const directory = join(homedir(), ".config", "systemd", "user");
  const service = join(directory, label + ".service");
  if (action === "install") {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: true });
    writeFileSync(service, mailWatchSystemdService({ repository, profile }));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", label + ".service"]);
    console.log(`Installed ${label}.service (Restart=always; starts at login). Log: ${logDirectory}`);
  } else if (action === "remove") {
    run("systemctl", ["--user", "disable", "--now", label + ".service"], true);
    if (existsSync(service)) rmSync(service);
    run("systemctl", ["--user", "daemon-reload"], true);
    console.log(`Removed ${label}.`);
  } else {
    const printed = run("systemctl", ["--user", "status", label + ".service", "--no-pager"], true);
    console.log(printed ?? (existsSync(service) ? "Installed but not running." : "Not installed."));
  }
} else {
  console.error("The Gmail watcher service is supported on macOS (launchd) and Linux (systemd user services).");
  process.exit(2);
}
