import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join, resolve } from "node:path";

import { resolveProfileDataDirectory } from "@internship-agent/db";
import { workspaceProfileSchema } from "@internship-agent/domain";

import { launchdPlist, scheduleLabel, systemdUnits } from "../src/pipeline-schedule";

/**
 * Installs, removes, or reports the OS timer that rings the list doorbell.
 *
 *   pnpm pipeline:schedule install|remove|status [--profile real|demo] [--interval 300]
 */
const args = process.argv.slice(2);
const action = args[0];
const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const profile = workspaceProfileSchema.parse(value("--profile") ?? "real");
const intervalSeconds = Math.max(60, Number.parseInt(value("--interval") ?? "300", 10) || 300);
const repository = resolve(import.meta.dirname, "../../..");
const logDirectory = join(resolveProfileDataDirectory(profile), "pipeline-logs");
// Timed runs need a screen for the visible browser: Xvfb's virtual one when
// installed (Linux only), otherwise the terminal's own display.
const virtualDisplay = platform() === "linux" ? ["/usr/bin/xvfb-run", "/usr/local/bin/xvfb-run"].find((path) => existsSync(path)) ?? null : null;
const options = { repository, profile, intervalSeconds, logDirectory, virtualDisplay, display: { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } };
const label = scheduleLabel(profile);

if (!["install", "remove", "status"].includes(action ?? "")) {
  console.error("Usage: pnpm pipeline:schedule install|remove|status [--profile real|demo] [--interval 300]");
  process.exit(2);
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
    writeFileSync(plist, launchdPlist(options));
    run("launchctl", ["bootstrap", domain, plist]);
    console.log(`Installed ${label}: rings the list doorbell every ${intervalSeconds} s (and on login or wake). Log: ${logDirectory}`);
  } else if (action === "remove") {
    run("launchctl", ["bootout", domain, plist], true);
    if (existsSync(plist)) rmSync(plist);
    console.log(`Removed ${label}.`);
  } else {
    const printed = run("launchctl", ["print", `${domain}/${label}`], true);
    console.log(printed ? printed.split("\n").filter((line) => /state =|last exit|run interval|runs =/.test(line)).join("\n") || "Loaded." : "Not installed.");
  }
} else if (platform() === "linux") {
  const directory = join(homedir(), ".config", "systemd", "user");
  const service = join(directory, label + ".service");
  const timer = join(directory, label + ".timer");
  if (action === "install") {
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(directory, { recursive: true });
    const units = systemdUnits(options);
    writeFileSync(service, units.service);
    writeFileSync(timer, units.timer);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", label + ".timer"]);
    console.log(`Installed ${label}.timer (every ${intervalSeconds} s; browser on ${virtualDisplay ? "an Xvfb virtual screen" : "display " + (process.env.DISPLAY ?? "none")}). WSL only runs it while WSL is running.`);
  } else if (action === "remove") {
    run("systemctl", ["--user", "disable", "--now", label + ".timer"], true);
    for (const file of [service, timer]) if (existsSync(file)) rmSync(file);
    run("systemctl", ["--user", "daemon-reload"], true);
    console.log(`Removed ${label}.`);
  } else {
    console.log(run("systemctl", ["--user", "list-timers", label + ".timer", "--no-pager"], true) ?? "Not installed.");
  }
} else {
  console.error("Scheduling is supported on macOS (launchd) and Linux (systemd user timers).");
  process.exit(2);
}
