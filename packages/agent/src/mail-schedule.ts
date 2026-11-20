import { shellQuote } from "./pipeline-schedule";

/**
 * The OS service that keeps the Gmail watcher (`pnpm mail:watch`) running:
 * a systemd user service on Linux (Restart=always, started at login) and a
 * launchd KeepAlive agent on macOS. Each runs the watcher from a login shell
 * so node and pnpm are on PATH. It is a long-running service, not a timer.
 */
export type MailWatchServiceOptions = { repository: string; profile: "real" | "demo" };

export function mailWatchLabel(profile: string): string {
  return "com.internship-agent.mail." + profile;
}

function mailWatchCommand(options: MailWatchServiceOptions): string {
  return `cd ${shellQuote(options.repository)} && exec pnpm mail:watch --profile ${options.profile}`;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function mailWatchSystemdService(options: MailWatchServiceOptions): string {
  const command = mailWatchCommand(options).replace(/%/g, "%%");
  return `[Unit]
Description=Internship agent Gmail watcher (${options.profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash -lc ${JSON.stringify(command)}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function mailWatchLaunchdPlist(options: MailWatchServiceOptions & { logDirectory: string }): string {
  const log = xml(options.logDirectory.replace(/\/$/, "") + "/launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(mailWatchLabel(options.profile))}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${xml(mailWatchCommand(options))}</string></array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}
