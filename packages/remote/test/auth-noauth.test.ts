import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateToken } from '../src/server/auth.js';
import { startAgentServer, type RunningAgent } from '../src/server/serve.js';
import { generateSelfSignedCert } from '../src/server/tls.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-auth-noauth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startAgentServer no-auth bypass', () => {
  let server: RunningAgent;
  const { hash } = generateToken();
  let certPath: string;
  let keyPath: string;

  beforeEach(async () => {
    const cert = await generateSelfSignedCert({
      dir,
      commonName: '127.0.0.1',
      hostnames: ['127.0.0.1', 'localhost'],
    });
    certPath = cert.certPath;
    keyPath = cert.keyPath;
    server = startAgentServer({
      tokenHash: hash,
      noAuth: true,
      tls: { certPath, keyPath },
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  test('accepts localhost request without bearer', async () => {
    const resp = await server.handleRequest!(
      new Request('http://x/v1/models'),
      { address: '127.0.0.1', port: 12345, family: 'IPv4' },
    );
    expect(resp.status).toBe(200);
  });

  test('serves plain HTTP on loopback even when tls is configured', async () => {
    expect(server.url.startsWith('http://')).toBe(true);
    expect(server.fingerprint).toBeNull();
    const resp = await fetch(`${server.url}/v1/models`);
    expect(resp.status).toBe(200);
  });

  test('rejects non-loopback source even when no-auth is enabled', async () => {
    const resp = await server.handleRequest!(new Request('http://x/v1/models'), {
      address: '192.168.1.50',
      port: 12345,
      family: 'IPv4',
    });
    expect(resp.status).toBe(401);
  });

  test('accepts bearer-authenticated localhost request', async () => {
    const resp = await server.handleRequest!(new Request('http://x/v1/models', {
      headers: { authorization: `Bearer ll_agt_test-token` },
    }), {
      address: '127.0.0.1',
      port: 12345,
      family: 'IPv4',
    });
    expect(resp.status).not.toBe(401);
  });

  test('logs the first unauthenticated request and suppresses the next 98', async () => {
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await server.handleRequest!(new Request('http://x/v1/models'), {
        address: '127.0.0.1',
        port: 12345,
        family: 'IPv4',
      });
      await server.handleRequest!(new Request('http://x/v1/models'), {
        address: '127.0.0.1',
        port: 12345,
        family: 'IPv4',
      });
      expect(writes.filter((line) => line.includes('serving unauthenticated request'))).toHaveLength(1);
      expect(writes[0]).toContain('127.0.0.1:12345');
      expect(writes[0]).toContain('GET /v1/models');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
