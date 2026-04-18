import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteNodeClient } from '../src/client/node-client.js';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-serve-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startAgentServer (plain HTTP, for test isolation)', () => {
  let server: RunningAgent;
  const { token, hash } = generateToken();

  beforeEach(() => {
    server = startAgentServer({ tokenHash: hash });
  });
  afterEach(async () => {
    await server.stop();
  });

  test('/healthz responds 200 without auth', async () => {
    const resp = await fetch(`${server.url}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('ok');
  });

  test('unknown path responds 404', async () => {
    const resp = await fetch(`${server.url}/nowhere`);
    expect(resp.status).toBe(404);
  });

  test('missing bearer → 401', async () => {
    const resp = await fetch(`${server.url}/trpc/env`);
    expect(resp.status).toBe(401);
    expect(resp.headers.get('www-authenticate')).toContain('Bearer');
  });

  test('bad bearer → 401', async () => {
    const resp = await fetch(`${server.url}/trpc/env`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(resp.status).toBe(401);
  });

  test('good bearer returns tRPC response for env query', async () => {
    const client = createRemoteNodeClient({ url: server.url, token });
    const env = await client.env.query();
    // env is a POJO with a LOCAL_AI_RUNTIME_DIR field. Existence is
    // the contract; value depends on the test runner's process env.
    expect(env).toBeDefined();
    expect(typeof env.LOCAL_AI_RUNTIME_DIR).toBe('string');
  });
});

describe('startAgentServer (TLS, pinned cert)', () => {
  let server: RunningAgent;
  let certPath: string;
  let keyPath: string;
  let certPem: string;
  let fingerprint: string;
  const { token, hash } = generateToken();

  beforeEach(async () => {
    const gen = await generateSelfSignedCert({
      dir,
      commonName: '127.0.0.1',
      hostnames: ['127.0.0.1', 'localhost'],
    });
    certPath = gen.certPath;
    keyPath = gen.keyPath;
    certPem = gen.certPem;
    fingerprint = gen.fingerprint;
    server = startAgentServer({
      tokenHash: hash,
      tls: { certPath, keyPath },
      advertiseMdns: false,
    });
  });
  afterEach(async () => {
    await server.stop();
  });

  test('agent URL uses https', () => {
    expect(server.url.startsWith('https://')).toBe(true);
    expect(server.fingerprint).toBe(fingerprint);
  });

  test('client with pinned cert + good token round-trips env query', async () => {
    const client = createRemoteNodeClient({
      url: server.url,
      token,
      certificate: certPem,
      certificateFingerprint: fingerprint,
    });
    const env = await client.env.query();
    expect(env).toBeDefined();
  });

  test('client with tampered stored fingerprint fails construction', () => {
    const bad = fingerprint.slice(0, -1) + (fingerprint.endsWith('0') ? '1' : '0');
    expect(() =>
      createRemoteNodeClient({
        url: server.url,
        token,
        certificate: certPem,
        certificateFingerprint: bad,
      }),
    ).toThrow(/certificate fingerprint mismatch/);
  });

  test('client without CA fails TLS (self-signed cert not trusted)', async () => {
    const client = createRemoteNodeClient({ url: server.url, token });
    await expect(client.env.query()).rejects.toThrow();
  });

  test('valid CA + bad token → UNAUTHORIZED', async () => {
    const { hash: wrongHash } = generateToken();
    // Fresh server with a different expected token
    const srv2 = startAgentServer({
      tokenHash: wrongHash,
      tls: { certPath, keyPath },
      advertiseMdns: false,
    });
    try {
      const client = createRemoteNodeClient({
        url: srv2.url,
        token,          // mismatched
        certificate: certPem,
        certificateFingerprint: fingerprint,
      });
      // tRPC client surfaces the 401 as a generic failure (the body is
      // "unauthorized" plain text, not a tRPC error envelope). We just
      // assert the call rejects — the 401 is validated by direct fetch
      // tests above.
      await expect(client.env.query()).rejects.toThrow();
    } finally {
      await srv2.stop();
    }
  });
});
