/**
 * Service-file templates for the Sprint I-α install flow. The install
 * script writes one of these to the target host so the agent
 * launches on boot (+ restarts on crash) without the operator
 * hand-editing plists / units.
 *
 * Scope:
 *   * macOS: ~/Library/LaunchAgents/com.llamactl.agent.plist.
 *     `launchctl load` wires it in; `KeepAlive` restarts on exit.
 *   * Linux: ~/.config/systemd/user/llamactl-agent.service.
 *     `systemctl --user enable --now` wires it in; `Restart=always`
 *     handles crashes. Requires `loginctl enable-linger <user>` for
 *     headless hosts that want the service alive without a logged-in
 *     session — documented in the script output.
 *
 * Both forms pin stderr to a predictable log file so troubleshooting
 * works without `journalctl --user` expertise.
 *
 * Root-level installs (/Library/LaunchDaemons, /etc/systemd/system)
 * are deferred to --system mode in a later slice.
 */

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ServiceTemplateOptions {
  /** Absolute path to the llamactl-agent binary. */
  binaryPath: string;
  /** Absolute path to the agent's state dir (~/.llamactl-style). */
  agentDir: string;
  /** Absolute path to a writable log dir. */
  logDir: string;
}

export const LAUNCHD_LABEL = 'com.llamactl.agent';
export const LAUNCHD_PLIST_PATH_DEFAULT = '~/Library/LaunchAgents/com.llamactl.agent.plist';
export const SYSTEMD_UNIT_PATH_DEFAULT = '~/.config/systemd/user/llamactl-agent.service';

/**
 * macOS LaunchAgent plist. The user-scoped install (`~/Library/
 * LaunchAgents`) runs on login; headless Macs running agents 24/7
 * should run this as the primary user with auto-login enabled OR
 * switch to a LaunchDaemon (--system in a later slice).
 */
export function generateLaunchdPlist(opts: ServiceTemplateOptions): string {
  const binaryPath = xmlEscape(opts.binaryPath);
  const agentDir = xmlEscape(opts.agentDir);
  const logDir = xmlEscape(opts.logDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${binaryPath}</string>
      <string>agent</string>
      <string>serve</string>
      <string>--dir=${agentDir}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${logDir}/llamactl-agent.log</string>
    <key>StandardErrorPath</key>
    <string>${logDir}/llamactl-agent.err</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>LLAMACTL_AGENT_DIR</key>
      <string>${agentDir}</string>
    </dict>
</dict>
</plist>
`;
}

/**
 * Linux systemd user unit. Requires `loginctl enable-linger <user>`
 * on headless hosts so the unit survives logout (and runs at boot).
 * Prints that hint alongside the write.
 */
export function generateSystemdUnit(opts: ServiceTemplateOptions): string {
  return `[Unit]
Description=llamactl agent
Documentation=https://github.com/frozename/llamactl
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${opts.binaryPath} agent serve --dir=${opts.agentDir}
Restart=always
RestartSec=3
Environment=LLAMACTL_AGENT_DIR=${opts.agentDir}
StandardOutput=append:${opts.logDir}/llamactl-agent.log
StandardError=append:${opts.logDir}/llamactl-agent.err

[Install]
WantedBy=default.target
`;
}
