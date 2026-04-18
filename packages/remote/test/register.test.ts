import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { handleRegister } from '../src/server/register.js';
import { encodeBootstrap } from '../src/config/agent-config.js';
import { generateBootstrapToken } from '../src/config/bootstrap-tokens.js';
import { loadConfig } from '../src/config/kubeconfig.js';

/**
 * Unit tests for the /register HTTP handler. We invoke the handler
 * directly with a Request instance — no Bun.serve round-trip needed
 * — and assert status codes + kubeconfig state after each call.
 * Tempdirs isolate both the bootstrap-tokens directory and the
 * kubeconfig file; no test touches ~/.llamactl.
 */

let runtimeDir = '';
let tokensDir = '';
let kubeconfigPath = '';

function seedKubeconfig(path: string): void {
  writeFileSync(
    path,
    stringifyYaml({
      apiVersion: 'llamactl/v1',
      kind: 'Config',
      currentContext: 'default',
      contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
      clusters: [
        {
          name: 'home',
          nodes: [{ name: 'local', endpoint: 'inproc://local' }],
        },
      ],
      users: [{ name: 'me', token: 'initial-operator-token' }],
    }),
  );
}

function makeBlob(): string {
  return encodeBootstrap({
    url: 'https://gpu1.lan:7843',
    fingerprint: 'sha256:' + 'a'.repeat(64),
    token: 'node-minted-token',
    certificate: '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n',
  });
}

async function callRegister(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request('http://agent/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handleRegister(req, {
    bootstrapTokensDir: tokensDir,
    kubeconfigPath,
  });
  const parsed = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'llamactl-register-'));
  tokensDir = join(runtimeDir, 'bootstrap-tokens');
  kubeconfigPath = join(runtimeDir, 'config');
  seedKubeconfig(kubeconfigPath);
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe('handleRegister', () => {
  test('happy path: mints a token, registers the node, writes kubeconfig', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://central.lan:7843',
      dir: tokensDir,
    });
    const { status, body } = await callRegister({
      bootstrapToken: token,
      blob: makeBlob(),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.nodeName).toBe('gpu1');
    expect(body.cluster).toBe('home');
    expect(body.context).toBe('default');

    const cfg = loadConfig(kubeconfigPath);
    const cluster = cfg.clusters.find((c) => c.name === 'home')!;
    expect(cluster.nodes.map((n) => n.name).sort()).toEqual(['gpu1', 'local']);
    const gpu = cluster.nodes.find((n) => n.name === 'gpu1')!;
    expect(gpu.endpoint).toBe('https://gpu1.lan:7843');
    expect(gpu.certificateFingerprint).toBe('sha256:' + 'a'.repeat(64));
    expect(gpu.certificate).toContain('BEGIN CERTIFICATE');
    // The operator's token field gets overwritten with the node's token
    // so central can reach the new node immediately.
    const operator = cfg.users.find((u) => u.name === 'me')!;
    expect(operator.token).toBe('node-minted-token');
  });

  test('nodeName override wins over the token record', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'original',
      centralUrl: 'https://central.lan:7843',
      dir: tokensDir,
    });
    const { status, body } = await callRegister({
      bootstrapToken: token,
      blob: makeBlob(),
      nodeName: 'override-name',
    });
    expect(status).toBe(200);
    expect(body.nodeName).toBe('override-name');
    const cfg = loadConfig(kubeconfigPath);
    expect(cfg.clusters[0]!.nodes.some((n) => n.name === 'override-name')).toBe(true);
  });

  test('token reuse rejected with 409 already-used', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://c.lan',
      dir: tokensDir,
    });
    await callRegister({ bootstrapToken: token, blob: makeBlob() });
    const second = await callRegister({ bootstrapToken: token, blob: makeBlob() });
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(String(second.body.error)).toMatch(/already-used/);
  });

  test('expired token rejected with 410', async () => {
    const fixedNow = new Date('2026-04-18T12:00:00Z');
    const { token } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://c.lan',
      ttlMs: 1,
      dir: tokensDir,
      now: () => fixedNow,
    });
    // Handler consults its own `now`, so we need it to see "after expiry".
    const req = new Request('http://agent/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: token, blob: makeBlob() }),
    });
    const later = new Date('2026-04-18T12:05:00Z');
    const res = await handleRegister(req, {
      bootstrapTokensDir: tokensDir,
      kubeconfigPath,
      now: () => later,
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/expired/);
  });

  test('unknown token rejected with 401', async () => {
    const { status, body } = await callRegister({
      bootstrapToken: 'nope',
      blob: makeBlob(),
    });
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/not-found/);
  });

  test('malformed blob rejected with 400', async () => {
    const { token } = generateBootstrapToken({
      nodeName: 'gpu1',
      centralUrl: 'https://c.lan',
      dir: tokensDir,
    });
    const { status, body } = await callRegister({
      bootstrapToken: token,
      blob: 'not-base64',
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/bootstrap blob invalid/);
  });

  test('GET rejected with 405', async () => {
    const req = new Request('http://agent/register', { method: 'GET' });
    const res = await handleRegister(req, { bootstrapTokensDir: tokensDir, kubeconfigPath });
    expect(res.status).toBe(405);
  });

  test('missing bootstrapToken rejected with 400', async () => {
    const { status, body } = await callRegister({ blob: makeBlob() });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/bootstrapToken is required/);
  });
});
