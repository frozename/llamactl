import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetTestSeams,
  __setTestSeams,
  getNodeClient,
  getNodeClientByName,
  EMPTY_GLOBALS,
} from '../src/dispatcher.js';
import { tls, type Config } from '@llamactl/remote';
import type { FetchLike } from '../src/tunnel-dispatch.js';

// Slice C (I.3.7) — pin fields are now required to reach the relay
// unless `--insecure-tunnel-relay` is set. These tests exercise the
// happy pinned path, so we generate a real self-signed cert upfront
// and feed both the PEM + fingerprint into the kubeconfig stub.
let pinPem: string;
let pinFingerprint: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'llamactl-dispatcher-tunnel-'));
  const cert = await tls.generateSelfSignedCert({ dir, commonName: '127.0.0.1' });
  pinPem = cert.certPem;
  pinFingerprint = cert.fingerprint;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * I.3.3 — dispatcher routes tRPC calls through the reverse tunnel
 * when the kubeconfig node has `tunnelPreferred: true`. These tests
 * stub the HTTP fetch used by `buildTunnelSend` via the
 * `DispatcherTestSeams` pattern so no real sockets are opened.
 */

function baseConfig(overrides: {
  tunnelPreferred?: boolean;
  tunnelCentralUrl?: string | undefined;
  /** When true, populate `tunnelCentralCertificate` +
   *  `tunnelCentralFingerprint` so `callViaTunnelRelay` can satisfy
   *  its fail-closed pin check. Default: true when a tunnelCentralUrl
   *  is set, so existing tests exercise the pinned path naturally. */
  withPinFields?: boolean;
} = {}): Config {
  const ctx: Config['contexts'][number] = {
    name: 'default',
    cluster: 'home',
    user: 'me',
    defaultNode: 'gpu1',
  };
  if (overrides.tunnelCentralUrl !== undefined) {
    ctx.tunnelCentralUrl = overrides.tunnelCentralUrl;
  }
  const pinDefault = overrides.tunnelCentralUrl !== undefined;
  const pin = overrides.withPinFields ?? pinDefault;
  if (pin) {
    ctx.tunnelCentralCertificate = pinPem;
    ctx.tunnelCentralFingerprint = pinFingerprint;
  }
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Config',
    currentContext: 'default',
    contexts: [ctx],
    clusters: [
      {
        name: 'home',
        nodes: [
          {
            name: 'gpu1',
            endpoint: 'https://gpu1.lan:7843',
            kind: 'agent',
            certificateFingerprint: 'sha256:aaaaaaaa',
            ...(overrides.tunnelPreferred !== undefined
              ? { tunnelPreferred: overrides.tunnelPreferred }
              : {}),
          },
        ],
      },
    ],
    users: [{ name: 'me', token: 'local-bearer-token' }],
  };
}

describe('dispatcher — tunnelPreferred routing', () => {
  afterEach(() => {
    __resetTestSeams();
  });

  test('tunnelPreferred=true routes queries via /tunnel-relay/<nodeId>', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          type: 'res',
          id: 'relay-id-1',
          result: { ok: true, hello: 'from-tunnel' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    __setTestSeams({
      config: baseConfig({
        tunnelPreferred: true,
        tunnelCentralUrl: 'https://127.0.0.1:7843',
      }),
      fetchImpl,
    });
    const client = getNodeClientByName('gpu1', {
      ...EMPTY_GLOBALS,
      nodeName: 'gpu1',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).env.query({ x: 1 });
    expect(result).toEqual({ ok: true, hello: 'from-tunnel' });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://127.0.0.1:7843/tunnel-relay/gpu1');
    const init = captured[0]!.init!;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer local-bearer-token');
    const body = JSON.parse(init.body as string) as {
      method: string;
      type: string;
      input: unknown;
    };
    expect(body.method).toBe('env');
    expect(body.type).toBe('query');
    expect(body.input).toEqual({ x: 1 });
  });

  test('tunnelPreferred=true without tunnelCentralUrl throws a clear error', () => {
    __setTestSeams({
      config: baseConfig({ tunnelPreferred: true }),
    });
    expect(() =>
      getNodeClientByName('gpu1', { ...EMPTY_GLOBALS, nodeName: 'gpu1' }),
    ).toThrow(/tunnelCentralUrl/);
  });

  test('tunnelPreferred unset uses direct HTTPS (regression guard — no fetch)', () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response('never', { status: 200 });
    };
    __setTestSeams({
      config: baseConfig({}),
      fetchImpl,
    });
    const client = getNodeClient({
      ...EMPTY_GLOBALS,
      nodeName: 'gpu1',
    });
    // The client is built — tunnel path was not taken, so no fetch
    // to the relay happened during construction. A real `.query()`
    // would try the pinned-TLS tRPC httpBatchLink at gpu1.lan:7843;
    // we don't fire one here (no upstream to hit). The regression
    // guard is: the tunnel-relay fetch stub never ran.
    expect(client).toBeDefined();
    expect(calls).toBe(0);
  });

  test('relay returns error envelope → dispatcher throws with code + message', async () => {
    const fetchImpl: FetchLike = async () => {
      return new Response(
        JSON.stringify({
          type: 'res',
          id: 'x',
          error: {
            code: 'downstream-threw',
            message: 'node handler exploded',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    __setTestSeams({
      config: baseConfig({
        tunnelPreferred: true,
        tunnelCentralUrl: 'https://127.0.0.1:7843',
      }),
      fetchImpl,
    });
    const client = getNodeClientByName('gpu1', {
      ...EMPTY_GLOBALS,
      nodeName: 'gpu1',
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).whatever.query(null);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e.message).toContain('node handler exploded');
      expect(e.code).toBe('downstream-threw');
    }
  });
});
