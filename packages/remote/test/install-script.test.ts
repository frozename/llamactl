import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateInstallScript,
  handleInstallScript,
} from '../src/server/install-script.js';
import { generateBootstrapToken } from '../src/config/bootstrap-tokens.js';

let tokensDir = '';

beforeEach(() => {
  tokensDir = mkdtempSync(join(tmpdir(), 'llamactl-install-script-'));
});
afterEach(() => {
  rmSync(tokensDir, { recursive: true, force: true });
});

describe('generateInstallScript', () => {
  test('renders a POSIX sh script with token + central + node embedded', () => {
    const script = generateInstallScript({
      token: 'abc123',
      centralUrl: 'https://control.lan:7843',
      nodeName: 'gpu1',
    });
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain("TOKEN='abc123'");
    expect(script).toContain("CENTRAL_URL='https://control.lan:7843'");
    expect(script).toContain("NODE_NAME='gpu1'");
    // Uses set -eu for safety.
    expect(script).toMatch(/^set -eu$/m);
    // Platform detection covers every supported target.
    expect(script).toContain('Darwin arm64');
    expect(script).toContain('Darwin x86_64');
    expect(script).toContain('Linux x86_64');
    expect(script).toContain('Linux aarch64');
    // Downloads from /artifacts, POSTs to /register.
    expect(script).toContain('/artifacts/agent/');
    expect(script).toContain('/register');
    // Embeds the --json flag so the script captures stdout cleanly.
    expect(script).toContain('agent init --dir=');
    expect(script).toContain('--json');
    // Shell-extract the blob without jq — sed with a double-escaped
    // regex. The literal in the script starts with `sed -n 's/.*` so
    // verify the escaped backslashes land in the rendered output.
    expect(script).toContain('sed -n');
    expect(script).toContain('"blob"');
  });

  test('includes embedded launchd plist + systemd unit heredocs', () => {
    const script = generateInstallScript({
      token: 't',
      centralUrl: 'https://c.lan',
      nodeName: 'gpu1',
    });
    // Launchd branch for Darwin.
    expect(script).toContain('Darwin)');
    expect(script).toContain('com.llamactl.agent.plist');
    expect(script).toContain('__LLAMACTL_PLIST_EOF__');
    // The plist body shows up with __BIN__/__DIR__/__LOG__ placeholders
    // so the script can sed-substitute per-host at install time.
    expect(script).toContain('<key>Label</key>');
    expect(script).toContain('__BIN__');
    expect(script).toContain('__DIR__');
    expect(script).toContain('__LOG__');
    expect(script).toContain('launchctl load');
    // Systemd branch for Linux.
    expect(script).toContain('Linux)');
    expect(script).toContain('llamactl-agent.service');
    expect(script).toContain('__LLAMACTL_UNIT_EOF__');
    expect(script).toContain('ExecStart=__BIN__ agent serve --dir=__DIR__');
    expect(script).toContain('Restart=always');
    expect(script).toContain('systemctl --user enable --now llamactl-agent.service');
    expect(script).toContain('loginctl enable-linger');
    // Unsupported OS surfaces a helpful fallback.
    expect(script).toContain('unsupported OS');
  });

  test('strips trailing slash from centralUrl', () => {
    const script = generateInstallScript({
      token: 't',
      centralUrl: 'https://c.lan/',
      nodeName: 'n',
    });
    expect(script).toContain("CENTRAL_URL='https://c.lan'");
  });

  test('rejects values containing single quotes (shell injection guard)', () => {
    expect(() =>
      generateInstallScript({
        token: "abc'; rm -rf / #",
        centralUrl: 'https://c.lan',
        nodeName: 'n',
      }),
    ).toThrow(/single quotes/);
    expect(() =>
      generateInstallScript({
        token: 't',
        centralUrl: 'https://c.lan',
        nodeName: "gpu'1",
      }),
    ).toThrow(/single quotes/);
  });

  test('rejects values containing newlines', () => {
    expect(() =>
      generateInstallScript({
        token: 't\nrm -rf /',
        centralUrl: 'https://c.lan',
        nodeName: 'n',
      }),
    ).toThrow(/newlines/);
  });
});

describe('handleInstallScript', () => {
  async function call(token: string | null): Promise<{ status: number; body: string; contentType: string }> {
    const url = token === null
      ? 'http://agent/install-agent.sh'
      : `http://agent/install-agent.sh?token=${encodeURIComponent(token)}`;
    const req = new Request(url, { method: 'GET' });
    const res = await handleInstallScript(req, { bootstrapTokensDir: tokensDir });
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get('content-type') ?? '',
    };
  }

  test('happy path: returns a script whose token + central + node match the record', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://control.lan:7843',
      dir: tokensDir,
    });
    const { status, body, contentType } = await call(token);
    expect(status).toBe(200);
    expect(contentType).toContain('text/x-shellscript');
    expect(body).toContain(`TOKEN='${token}'`);
    expect(body).toContain("CENTRAL_URL='https://control.lan:7843'");
    expect(body).toContain("NODE_NAME='gpu1'");
  });

  test('no token query param → 400 + a short shell-echo-exit-1 body', async () => {
    const { status, body, contentType } = await call(null);
    expect(status).toBe(400);
    expect(contentType).toContain('text/x-shellscript');
    expect(body).toContain('exit 1');
    expect(body).toContain('?token=<t>');
  });

  test('unknown token → 401 + shell-echo-exit-1 body', async () => {
    const { status, body } = await call('not-a-real-token');
    expect(status).toBe(401);
    expect(body).toContain('exit 1');
    expect(body).toContain('unknown');
  });

  test('POST → 405', async () => {
    const req = new Request('http://agent/install-agent.sh?token=x', { method: 'POST' });
    const res = await handleInstallScript(req, { bootstrapTokensDir: tokensDir });
    expect(res.status).toBe(405);
  });

  test('cache-control: no-store on the rendered script', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      dir: tokensDir,
    });
    const req = new Request(
      `http://agent/install-agent.sh?token=${encodeURIComponent(token)}`,
      { method: 'GET' },
    );
    const res = await handleInstallScript(req, { bootstrapTokensDir: tokensDir });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('expired-but-still-recognizable token still serves the script', async () => {
    // The handler deliberately does NOT validate expiry. Operators
    // who want to inspect a script for a long-minted token can still
    // fetch it; /register rejects the actual consumption.
    const fixedNow = new Date('2026-04-18T12:00:00Z');
    const { token } = generateBootstrapToken({
      nodeName: 'n',
      centralUrl: 'https://c.lan',
      ttlMs: 1,
      dir: tokensDir,
      now: () => fixedNow,
    });
    const { status } = await call(token);
    expect(status).toBe(200);
  });
});
