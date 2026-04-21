import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNode } from '../src/commands/node.js';
import { resetGlobals, setGlobals, EMPTY_GLOBALS } from '../src/dispatcher.js';

/**
 * `llamactl node add-cloud` registers a gateway/cloud-kind node via
 * the tRPC `nodeAddCloud` procedure. Tests ride the local-caller
 * proxy (fresh kubeconfig → `local` in-process node), so the
 * procedure runs in-process and we only need to stub the /v1/models
 * probe by overriding `globalThis.fetch`.
 */

let tmp = '';
let configPath = '';
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-node-add-cloud-'));
  configPath = join(tmp, 'config');
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: tmp,
    LLAMACTL_CONFIG: configPath,
  });
  setGlobals(EMPTY_GLOBALS);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  resetGlobals();
  globalThis.fetch = originalFetch;
});

async function capture(fn: () => Promise<number>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let stdout = '';
  let stderr = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = (chunk: unknown) => {
    stdout += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = (chunk: unknown) => {
    stderr += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/**
 * Install a fake `/v1/models`-style probe that returns an OpenAI-
 * shaped empty-list response (200). Records the URL hit so tests
 * can assert the probe did (or did not) run.
 */
function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (input as any)?.url ?? String(input);
}

function installHealthyFetch(): { calls: string[] } {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any, _init?: unknown) => {
    calls.push(urlOf(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { calls };
}

function installUnreachableFetch(): { calls: string[] } {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async (input: any): Promise<Response> => {
    calls.push(urlOf(input));
    throw new Error('fetch failed: ECONNREFUSED');
  }) as typeof globalThis.fetch;
  return { calls };
}

describe('node add-cloud — happy path', () => {
  test('valid flags → tRPC mutation persists gateway node', async () => {
    installHealthyFetch();
    process.env.SIRIUS_API_KEY = 'sk-test-fake';
    const { code, stdout, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'sirius-main',
        '--provider',
        'sirius',
        '--base-url',
        'http://localhost:3000/v1',
        '--api-key-ref',
        'env:SIRIUS_API_KEY',
        '--display-name',
        'Sirius Primary',
      ]),
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain("added cloud node 'sirius-main'");
    expect(stdout).toContain('sirius @ http://localhost:3000/v1');
    expect(stdout).toContain('env:SIRIUS_API_KEY');
    expect(stdout).toContain('Sirius Primary');

    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('name: sirius-main');
    expect(yaml).toContain('kind: gateway');
    expect(yaml).toContain('provider: sirius');
    expect(yaml).toContain('baseUrl: http://localhost:3000/v1');
    expect(yaml).toContain('apiKeyRef: env:SIRIUS_API_KEY');
    expect(yaml).toContain('displayName: Sirius Primary');
  });

  test('anonymous binding (no --api-key-ref) persists without apiKeyRef', async () => {
    installHealthyFetch();
    const { code, stdout } = await capture(() =>
      runNode([
        'add-cloud',
        'sirius-local',
        '--provider',
        'sirius',
        '--base-url',
        'http://127.0.0.1:3000/v1',
      ]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('(anonymous');

    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('name: sirius-local');
    expect(yaml).not.toContain('apiKeyRef:');
  });
});

describe('node add-cloud — flag pass-through', () => {
  test('--api-key-ref env:FOO passes through unchanged to the binding', async () => {
    installHealthyFetch();
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const { code } = await capture(() =>
      runNode([
        'add-cloud',
        'openai-main',
        '--provider',
        'openai',
        '--base-url',
        'https://api.openai.com/v1',
        '--api-key-ref',
        'env:OPENAI_API_KEY',
      ]),
    );
    expect(code).toBe(0);
    const yaml = readFileSync(configPath, 'utf8');
    // The CLI must NOT resolve the ref — the raw `env:OPENAI_API_KEY`
    // string lands verbatim in the persisted binding.
    expect(yaml).toContain('apiKeyRef: env:OPENAI_API_KEY');
    expect(yaml).not.toContain('apiKeyRef: sk-'); // no resolution leak
  });

  test('--force + --api-key-ref keychain ref passes through without touching the keychain', async () => {
    // `--force` bypasses the probe, so the keychain resolver never
    // runs. The CLI still ships the raw ref through to the mutation
    // so the binding round-trips unchanged.
    const { calls } = installUnreachableFetch();
    const { code } = await capture(() =>
      runNode([
        'add-cloud',
        'anthropic-prod',
        '--provider',
        'anthropic',
        '--base-url',
        'https://api.anthropic.com/v1',
        '--api-key-ref',
        'keychain:llamactl/anthropic',
        '--force',
      ]),
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('apiKeyRef: keychain:llamactl/anthropic');
  });
});

describe('node add-cloud — --force skips probe', () => {
  test('--force skips the /v1/models probe even when upstream is unreachable', async () => {
    const { calls } = installUnreachableFetch();
    const { code, stdout } = await capture(() =>
      runNode([
        'add-cloud',
        'embersynth-staging',
        '--provider',
        'embersynth',
        '--base-url',
        'http://offline.local:4000/v1',
        '--force',
      ]),
    );
    expect(code).toBe(0);
    expect(stdout).toContain("added cloud node 'embersynth-staging'");
    expect(stdout).toContain('unverified');
    // Probe MUST NOT have been made — skipProbe short-circuits before
    // the adapter calls fetch.
    expect(calls).toHaveLength(0);

    const yaml = readFileSync(configPath, 'utf8');
    expect(yaml).toContain('name: embersynth-staging');
    expect(yaml).toContain('provider: embersynth');
  });
});

describe('node add-cloud — reachability failure without --force', () => {
  test('unreachable upstream → exit 1 with hint to pass --force', async () => {
    installUnreachableFetch();
    const { code, stdout, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'dead-gateway',
        '--provider',
        'sirius',
        '--base-url',
        'http://127.0.0.1:1/v1',
      ]),
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('node add-cloud:');
    expect(stderr).toContain('--force');
    // Kubeconfig must NOT have been mutated — the router throws
    // before `kubecfg.saveConfig`.
    let persisted = '';
    try { persisted = readFileSync(configPath, 'utf8'); } catch { /* file may be absent */ }
    expect(persisted).not.toContain('name: dead-gateway');
  });
});

describe('node add-cloud — validation', () => {
  test('missing <name> rejects', async () => {
    const { code, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        '--provider',
        'sirius',
        '--base-url',
        'http://localhost:3000/v1',
      ]),
    );
    expect(code).toBe(1);
    // The first `--provider` is taken as a flag (starts with `-`), so
    // no positional name is consumed.
    expect(stderr).toContain('missing <name>');
  });

  test('missing --provider rejects', async () => {
    const { code, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'gw',
        '--base-url',
        'http://localhost:3000/v1',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--provider is required');
  });

  test('missing --base-url rejects', async () => {
    const { code, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'gw',
        '--provider',
        'sirius',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--base-url is required');
  });

  test('invalid --provider value rejects with list of options', async () => {
    const { code, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'gw',
        '--provider',
        'cohere',
        '--base-url',
        'http://x/v1',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('--provider must be one of');
    expect(stderr).toContain('sirius');
    expect(stderr).toContain('embersynth');
  });

  test('unknown flag rejects', async () => {
    const { code, stderr } = await capture(() =>
      runNode([
        'add-cloud',
        'gw',
        '--provider',
        'sirius',
        '--base-url',
        'http://x/v1',
        '--fortune-cookie',
      ]),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('unknown flag --fortune-cookie');
  });
});
