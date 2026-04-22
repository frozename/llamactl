import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgent } from '../src/commands/agent.js';

/**
 * CLI-side coverage for `llamactl agent cli doctor`. Runs against an
 * isolated `LLAMACTL_CONFIG` tmpdir so we can exercise
 * cluster/node assembly without polluting the operator's real
 * kubeconfig. The actual subprocess-probe path is exercised via
 * preset commands that don't exist in PATH — healthCheck then
 * reports `unhealthy` with a spawn-error message, which is what we
 * assert.
 */

let tmp = '';
let cfgPath = '';
const originalEnv = { ...process.env };

function captureStdio<T>(fn: () => Promise<T>): Promise<{
  result: T;
  out: string;
  err: string;
}> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string | Uint8Array): boolean => {
    out += typeof s === 'string' ? s : String(s);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string | Uint8Array): boolean => {
    err += typeof s === 'string' ? s : String(s);
    return true;
  };
  return fn()
    .then((result) => ({ result, out, err }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = origOut;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = origErr;
    });
}

function writeConfig(yaml: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.writeFileSync(cfgPath, yaml, 'utf8');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-cli-doctor-'));
  cfgPath = join(tmp, 'config');
  process.env = { ...originalEnv, LLAMACTL_CONFIG: cfgPath };
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('llamactl agent cli doctor', () => {
  test('help subcommand prints USAGE with exit 0', async () => {
    const { result, out } = await captureStdio(() => runAgent(['cli', '-h']));
    expect(result).toBe(0);
    expect(out).toContain('Usage: llamactl agent cli');
  });

  test('unknown cli subcommand exits 1', async () => {
    const { result, err } = await captureStdio(() => runAgent(['cli', 'bogus']));
    expect(result).toBe(1);
    expect(err).toContain('Unknown agent cli subcommand');
  });

  test('doctor with no current-context exits 1', async () => {
    writeConfig('apiVersion: llamactl/v1\nkind: Config\ncurrentContext: \ncontexts: []\nclusters: []\nusers: []\n');
    const { result, err } = await captureStdio(() =>
      runAgent(['cli', 'doctor']),
    );
    // no current context triggers the non-zero exit; the exact
    // message depends on whether loadConfig or the subsequent
    // context check fires first.
    expect(result).toBe(1);
    expect(err.length).toBeGreaterThan(0);
  });

  test('doctor reports unhealthy for a preset whose binary is missing', async () => {
    // Register an agent with a claude-preset binding pointing at a
    // non-existent command so `healthCheck` surfaces the spawn
    // failure. We override `command` to something we know isn't in
    // PATH — 'this-binary-does-not-exist-abc123' — so the probe
    // always fails cleanly.
    writeConfig(`apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
  - name: default
    cluster: home
    user: me
clusters:
  - name: home
    nodes:
      - name: mac-mini
        endpoint: https://mac-mini.lan:7843
        kind: agent
        cli:
          - name: missing-probe
            preset: custom
            command: this-binary-does-not-exist-abc123
            args: ["-p", "{{prompt}}"]
users:
  - name: me
    token: t
`);
    const { result, out } = await captureStdio(() =>
      runAgent(['cli', 'doctor', '--json']),
    );
    expect(result).toBe(2);
    const parsed = JSON.parse(out.trim());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].state).toBe('unhealthy');
    expect(parsed.results[0].agent).toBe('mac-mini');
    expect(parsed.results[0].binding).toBe('missing-probe');
  });

  test('--node filter restricts the probe to a single agent', async () => {
    writeConfig(`apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
  - name: default
    cluster: home
    user: me
clusters:
  - name: home
    nodes:
      - name: mac-mini
        endpoint: https://mac-mini.lan:7843
        kind: agent
        cli:
          - name: binding-a
            preset: custom
            command: this-binary-does-not-exist-abc123
            args: ["-p", "{{prompt}}"]
      - name: laptop
        endpoint: https://laptop.lan:7843
        kind: agent
        cli:
          - name: binding-b
            preset: custom
            command: this-binary-does-not-exist-abc123
            args: ["-p", "{{prompt}}"]
users:
  - name: me
    token: t
`);
    const { out } = await captureStdio(() =>
      runAgent(['cli', 'doctor', '--node=laptop', '--json']),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].agent).toBe('laptop');
    expect(parsed.results[0].binding).toBe('binding-b');
  });

  test('no agents + no bindings renders a clean empty result (exit 0)', async () => {
    writeConfig(`apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
  - name: default
    cluster: home
    user: me
clusters:
  - name: home
    nodes:
      - name: lonely
        endpoint: https://lonely.lan:7843
        kind: agent
users:
  - name: me
    token: t
`);
    const { result, out } = await captureStdio(() =>
      runAgent(['cli', 'doctor']),
    );
    expect(result).toBe(0);
    expect(out).toContain('no CLI bindings declared');
  });
});
