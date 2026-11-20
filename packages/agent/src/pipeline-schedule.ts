/**
 * The OS job that rings the list doorbell: a launchd agent on macOS, a
 * systemd user timer on Linux. Each tick runs `pnpm pipeline:watch --once`
 * from a login shell (so Homebrew's node and pnpm are on PATH), which exits
 * at once when no list changed or another pass still holds the lock. A Mac
 * asleep at a tick runs it on wake.
 */
export type ScheduleOptions = {
  repository: string;
  profile: "real" | "demo";
  intervalSeconds: number;
  logDirectory: string;
  /**
   * The installer's display, so the timer's runs can open a visible browser.
   * A systemd user service does not inherit it (WSLg sets it only in
   * terminals); launchd agents already run in the logged-in GUI session.
   */
  display?: DisplayEnvironment;
  /**
   * Absolute path of `xvfb-run`, when installed. The systemd service then
   * runs each pass on its own virtual X screen, so the browser stays in its
   * normal visible mode without depending on a desktop session (WSLg's
   * display can stop answering, which hangs a visible launch). It replaces
   * `display`.
   */
  virtualDisplay?: string | null;
};

export type DisplayEnvironment = { DISPLAY?: string | undefined; WAYLAND_DISPLAY?: string | undefined };

/** Display variables worth writing into a unit: set, and plain (":0", "wayland-0"). */
export function displayEnvironment(env: DisplayEnvironment): Array<[string, string]> {
  return (["DISPLAY", "WAYLAND_DISPLAY"] as const)
    .map((name) => [name, env[name]?.trim() ?? ""] as [string, string])
    .filter(([, value]) => /^[A-Za-z0-9:._/-]+$/.test(value));
}

export function scheduleLabel(profile: string): string {
  return "com.internship-agent.watch." + profile;
}

function watchCommand(options: ScheduleOptions): string {
  return `cd ${shellQuote(options.repository)} && exec pnpm pipeline:watch --once --profile ${options.profile}`;
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, `'\\''`) + "'";
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(options: ScheduleOptions): string {
  const log = xml(options.logDirectory.replace(/\/$/, "") + "/launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(scheduleLabel(options.profile))}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xml(watchCommand(options))}</string></array>
  <key>StartInterval</key><integer>${Math.round(options.intervalSeconds)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnits(options: ScheduleOptions): { service: string; timer: string } {
  const command = watchCommand(options).replace(/%/g, "%%");
  const virtual = options.virtualDisplay && /^\/[A-Za-z0-9._/-]+$/.test(options.virtualDisplay) ? options.virtualDisplay : null;
  // On the virtual screen no desktop display is passed: WAYLAND_DISPLAY would steer Chromium back to it.
  const environment = virtual ? "" : displayEnvironment(options.display ?? {}).map(([name, value]) => `Environment=${name}=${value}\n`).join("");
  const launcher = virtual ? `${virtual} -a ` : "";
  return {
    service: `[Unit]
Description=Internship agent list doorbell (${options.profile})

[Service]
Type=oneshot
${environment}ExecStart=${launcher}/bin/bash -lc ${JSON.stringify(command)}
`,
    timer: `[Unit]
Description=Ring the internship list doorbell every ${Math.round(options.intervalSeconds)} seconds

[Timer]
OnBootSec=120
OnUnitActiveSec=${Math.round(options.intervalSeconds)}
Persistent=true

[Install]
WantedBy=timers.target
`
  };
}
