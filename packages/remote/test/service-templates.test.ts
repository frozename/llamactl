import { describe, expect, test } from 'bun:test';
import {
  generateLaunchdPlist,
  generateSystemdUnit,
  LAUNCHD_LABEL,
} from '../src/server/service-templates.js';

/**
 * Shape + content assertions for the service templates. The install
 * script writes these verbatim (after __BIN__ / __DIR__ / __LOG__
 * substitution); end-to-end validation — does launchctl / systemctl
 * actually accept them — lives in a manual smoke test on a real
 * host, not in unit tests.
 */

const OPTS = {
  binaryPath: '/home/me/.llamactl/bin/llamactl-agent',
  agentDir: '/home/me/.llamactl',
  logDir: '/home/me/.llamactl/logs',
};

describe('generateLaunchdPlist', () => {
  test('emits a valid plist structure with the llamactl label + KeepAlive + RunAtLoad', () => {
    const plist = generateLaunchdPlist(OPTS);
    expect(plist.startsWith('<?xml version="1.0"')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    // ProgramArguments invoke the binary with the right argv.
    expect(plist).toContain('<string>/home/me/.llamactl/bin/llamactl-agent</string>');
    expect(plist).toContain('<string>agent</string>');
    expect(plist).toContain('<string>serve</string>');
    expect(plist).toContain('<string>--dir=/home/me/.llamactl</string>');
    // Crash + boot handling.
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    // Log paths go where the env var says.
    expect(plist).toContain('/home/me/.llamactl/logs/llamactl-agent.log');
    expect(plist).toContain('/home/me/.llamactl/logs/llamactl-agent.err');
    // Env var for the agent dir is threaded through.
    expect(plist).toContain('<key>LLAMACTL_AGENT_DIR</key>');
    expect(plist).toContain('<string>/home/me/.llamactl</string>');
  });

  test('XML-escapes metacharacters in paths', () => {
    const plist = generateLaunchdPlist({
      binaryPath: '/weird/<path>&more/llamactl-agent',
      agentDir: '/weird/<path>&more',
      logDir: '/weird/<path>&more/logs',
    });
    // Raw < > & never appear inside <string> values; they're escaped.
    expect(plist).not.toContain('/weird/<path>&more');
    expect(plist).toContain('/weird/&lt;path&gt;&amp;more');
  });
});

describe('generateSystemdUnit', () => {
  test('emits a valid [Unit]/[Service]/[Install] file with restart-always', () => {
    const unit = generateSystemdUnit(OPTS);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=llamactl agent');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain(
      'ExecStart=/home/me/.llamactl/bin/llamactl-agent agent serve --dir=/home/me/.llamactl',
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment=LLAMACTL_AGENT_DIR=/home/me/.llamactl');
    expect(unit).toContain('StandardOutput=append:/home/me/.llamactl/logs/llamactl-agent.log');
    expect(unit).toContain('StandardError=append:/home/me/.llamactl/logs/llamactl-agent.err');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });
});
