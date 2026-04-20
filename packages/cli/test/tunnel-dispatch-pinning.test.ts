import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tls } from '@llamactl/remote';
import {
  __resetInsecureTunnelWarning,
  callViaTunnelRelay,
  type FetchLike,
  type TunnelRelayCallOptions,
} from '../src/tunnel-dispatch.js';

/**
 * Slice C (I.3.7) — the `/tunnel-relay` POST must pin against the
 * local central agent's TLS cert or fail closed. These tests cover
 * the four branches:
 *   - no pin fields, insecure unset → throw (fail closed)
 *   - pin fields present but mismatch → throw (fingerprint guard)
 *   - pin fields present + match → fetch proceeds with tls.ca set
 *   - insecure=true → fetch proceeds without tls.ca, stderr WARN once
 */

let certPem: string;
let fingerprint: string;

beforeAll(async () => {
  // Use a real self-signed cert so `computeFingerprint(pem)` produces
  // a value that actually matches what we hand to the pin check.
  // Leaner than hardcoding a fixture PEM string.
  const dir = mkdtempSync(join(tmpdir(), 'llamactl-tunnel-pin-'));
  const cert = await tls.generateSelfSignedCert({ dir, commonName: '127.0.0.1' });
  certPem = cert.certPem;
  fingerprint = cert.fingerprint;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  __resetInsecureTunnelWarning();
});

function envelopeFetch(): {
  fetchImpl: FetchLike;
  captured: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    captured.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        type: 'res',
        id: 'relay-id-1',
        result: { ok: true },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, captured };
}

function baseOpts(): Omit<TunnelRelayCallOptions, 'fetchImpl'> {
  return {
    centralUrl: 'https://127.0.0.1:7843',
    nodeName: 'gpu1',
    method: 'env',
    input: { x: 1 },
    bearer: 'bearer-abc',
    type: 'query',
  };
}

describe('tunnel-dispatch — fingerprint pinning', () => {
  test('fails closed when fingerprint fields are missing', async () => {
    const { fetchImpl, captured } = envelopeFetch();
    const err = await callViaTunnelRelay({
      ...baseOpts(),
      fetchImpl,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('tunnelCentralFingerprint');
    expect(err?.message).toContain('tunnelCentralCertificate');
    // Fetch must not have been called — the check is pre-fetch.
    expect(captured).toHaveLength(0);
  });

  test('fingerprint mismatch throws with both hashes in the message', async () => {
    const { fetchImpl, captured } = envelopeFetch();
    const bogus = 'sha256:deadbeef' + 'ff'.repeat(28);
    const err = await callViaTunnelRelay({
      ...baseOpts(),
      pinnedCa: certPem,
      expectedFingerprint: bogus,
      fetchImpl,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('fingerprint mismatch');
    expect(err?.message).toContain(bogus);
    expect(err?.message).toContain(fingerprint);
    expect(captured).toHaveLength(0);
  });

  test('matching pin proceeds to fetch with tls.ca in init', async () => {
    const { fetchImpl, captured } = envelopeFetch();
    const result = await callViaTunnelRelay({
      ...baseOpts(),
      pinnedCa: certPem,
      expectedFingerprint: fingerprint,
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    const init = captured[0]!.init as RequestInit & { tls?: { ca?: string } };
    expect(init.method).toBe('POST');
    // tls.ca is the Bun-specific extension — our whole pinning story
    // hinges on it landing in the init object exactly like links.ts
    // does for the direct HTTPS path.
    expect(init.tls).toBeDefined();
    expect(init.tls?.ca).toBe(certPem);
  });

  test('insecure=true bypasses pin, warns exactly once across calls', async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    };
    try {
      const { fetchImpl, captured } = envelopeFetch();
      await callViaTunnelRelay({
        ...baseOpts(),
        insecure: true,
        fetchImpl,
      });
      await callViaTunnelRelay({
        ...baseOpts(),
        insecure: true,
        fetchImpl,
      });
      expect(captured).toHaveLength(2);
      // No `tls` field should be set when bypassing the pin — the
      // fetch falls back to the runtime's default CA trust.
      for (const c of captured) {
        const init = c.init as RequestInit & { tls?: unknown };
        expect(init.tls).toBeUndefined();
      }
      const warnLines = stderrWrites.filter((s) =>
        s.includes('tunnel-relay fingerprint check bypassed'),
      );
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain('--insecure-tunnel-relay');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = originalWrite;
    }
  });
});

afterEach(() => {
  __resetInsecureTunnelWarning();
});
