import { expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpstreamSlotClient } from '../src/kvstore/index.js';

interface TestServer {
  baseUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>,
): Promise<TestServer> {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handler(req, res, url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
}

async function acquireClosedLocalPort(): Promise<number> {
  const server = createServer((_req, res) => res.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to get local test port');
  const port = (address as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

test('omlx engine: save sends model in payload + probes /v1/slots/capabilities', async () => {
  let saveBody = null as { filename?: string; model?: string } | null;
  let capsPath = null as string | null;
  const upstream = await startTestServer(async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/slots/capabilities') {
      capsPath = url.pathname;
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/slots/0') {
      let body = '';
      for await (const chunk of req) body += chunk;
      saveBody = JSON.parse(body) as { filename?: string; model?: string };
      json(res, 200, { n_saved: 7 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { engine: 'omlx' });
    const saved = await client.save(0, 'abc.kvslot', { model: 'Qwen3-Coder-Next-mlx-2Bit' });
    expect(saved.ok).toBe(true);
    expect(saveBody?.filename).toBe('abc.kvslot');
    expect(saveBody?.model).toBe('Qwen3-Coder-Next-mlx-2Bit');
    expect(await client.supportsRequestHandle()).toBe(true);
    expect(capsPath).toBe('/v1/slots/capabilities');
  } finally {
    await upstream.close();
  }
});

test('default (llamacpp) engine: save omits model + probes /props', async () => {
  let saveBody = null as { filename?: string; model?: string } | null;
  let propsPath = null as string | null;
  const upstream = await startTestServer(async (req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      propsPath = url.pathname;
      json(res, 200, { slots: { api_version: 0 } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/slots/0') {
      let body = '';
      for await (const chunk of req) body += chunk;
      saveBody = JSON.parse(body) as { filename?: string; model?: string };
      json(res, 200, { n_saved: 3 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const saved = await client.save(0, 'x.kvslot');
    expect(saved.ok).toBe(true);
    expect(saveBody?.filename).toBe('x.kvslot');
    expect(saveBody !== null && 'model' in saveBody).toBe(false);
    expect(await client.supportsRequestHandle()).toBe(false);
    expect(propsPath).toBe('/props');
  } finally {
    await upstream.close();
  }
});

test('save success returns ok + tokensSaved + sends filename in JSON body', async () => {
  let sentFilename: string | null = null as string | null;
  const upstream = await startTestServer(async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/slots/3') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body) as { filename?: string };
      sentFilename = parsed.filename ?? null;
    } catch {
      sentFilename = null;
    }
    json(res, 200, {
      action: url.searchParams.get('action'),
      filename: sentFilename,
      n_saved: 123,
    });
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.save(3, 'slot-a.bin');
    expect(result).toEqual({ ok: true, tokensSaved: 123 });
    expect(sentFilename).toBe('slot-a.bin');
  } finally {
    await upstream.close();
  }
});

test('save http error returns http_error + status', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.save(7, 'slot-b.bin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected save failure');
    expect(result.reason).toBe('http_error');
    expect(result.status).toBe(500);
  } finally {
    await upstream.close();
  }
});

test('restore success returns ok + tokensRestored + sends filename in JSON body', async () => {
  let sentFilename: string | null = null as string | null;
  const upstream = await startTestServer(async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/slots/9') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body) as { filename?: string };
      sentFilename = parsed.filename ?? null;
    } catch {
      sentFilename = null;
    }
    json(res, 200, {
      action: url.searchParams.get('action'),
      filename: sentFilename,
      n_restored: 456,
    });
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.restore(9, 'slot-c.bin');
    expect(result).toEqual({ ok: true, tokensRestored: 456, restore_epoch: null });
    expect(sentFilename).toBe('slot-c.bin');
  } finally {
    await upstream.close();
  }
});

test('restore returns null restore_epoch when server omits the field', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/slots/4') {
      json(res, 200, { n_restored: 42 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.restore(4, 'slot-no-epoch.bin');
    expect(result).toMatchObject({ ok: true, tokensRestored: 42 });
    expect((result as any).restore_epoch).toBeNull();
  } finally {
    await upstream.close();
  }
});

test('restore returns restore_epoch string when server provides it', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'POST' && url.pathname === '/slots/5') {
      json(res, 200, { n_restored: 42, restore_epoch: 'epoch-xyz' });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.restore(5, 'slot-with-epoch.bin');
    expect(result).toMatchObject({ ok: true, tokensRestored: 42 });
    expect((result as any).restore_epoch).toBe('epoch-xyz');
  } finally {
    await upstream.close();
  }
});

test('restore 404 returns not_found', async () => {
  const upstream = await startTestServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.restore(2, 'missing.bin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected restore failure');
    expect(result.reason).toBe('not_found');
    expect(result.status).toBe(404);
  } finally {
    await upstream.close();
  }
});

test('network failure returns network', async () => {
  const port = await acquireClosedLocalPort();
  const client = new UpstreamSlotClient(`http://127.0.0.1:${port}`);
  const result = await client.save(1, 'slot-d.bin');
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected save failure');
  expect(result.reason).toBe('network');
});

test('timeout returns network', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: Request | URL | string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as typeof fetch;
  try {
    const client = new UpstreamSlotClient('http://127.0.0.1:1');
    const result = await client.save(1, 'slot-timeout.bin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected save timeout');
    expect(result.reason).toBe('network');
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 35_000);

test('supportsSlots re-probes after invalidateCapabilityCache', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { n_slots: 8 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsSlots()).toBe(true);
    client.invalidateCapabilityCache();
    expect(await client.supportsSlots()).toBe(true);
    expect(upstream.requestCount()).toBe(2);
  } finally {
    await upstream.close();
  }
});

test('supportsSlots caches probe result per client', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { n_slots: 8 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsSlots()).toBe(true);
    expect(await client.supportsSlots()).toBe(true);
    expect(upstream.requestCount()).toBe(1);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns true when slots.supports_request_handle === true and api_version >= 2', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(true);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns false when slots.supports_request_handle absent', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2 } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(false);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns false when slots.supports_request_handle === true but api_version === 1', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 1, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(false);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns false when slots block absent entirely', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { n_slots: 8 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(false);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns false on fetch failure (network error)', async () => {
  const port = await acquireClosedLocalPort();
  const client = new UpstreamSlotClient(`http://127.0.0.1:${port}`);
  expect(await client.supportsRequestHandle()).toBe(false);
});

test('supportsRequestHandle returns false on malformed JSON', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(false);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle returns cached value within TTL window', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(true);
    expect(await client.supportsRequestHandle()).toBe(true);
    expect(upstream.requestCount()).toBe(1);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle re-probes after TTL expiry', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  let requests = 0;
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      requests += 1;
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 50 });
    expect(await client.supportsRequestHandle()).toBe(true);
    now += 25;
    expect(await client.supportsRequestHandle()).toBe(true);
    now += 26;
    expect(await client.supportsRequestHandle()).toBe(true);
    expect(requests).toBe(2);
  } finally {
    Date.now = originalNow;
    await upstream.close();
  }
});

test('supportsRequestHandle caches a reachable "no capability" result within TTL', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { n_slots: 8 });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(false);
    expect(await client.supportsRequestHandle()).toBe(false);
    // A definitive "no capability" from a reachable server is cached: one probe only.
    expect(upstream.requestCount()).toBe(1);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle does NOT cache a transient network-error result (re-probes)', async () => {
  const originalFetch = globalThis.fetch;
  let probes = 0;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/props') {
      probes += 1;
      throw new TypeError('network down');
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  try {
    const client = new UpstreamSlotClient('http://127.0.0.1:9', { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(false);
    expect(await client.supportsRequestHandle()).toBe(false);
    // Unreachable is transient, not a verdict — re-probe so we recover at the next request.
    expect(probes).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('supportsSaveHandle caches a reachable "no capability" result within TTL (omlx)', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/slots/capabilities') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true, supports_save_handle: false } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { engine: 'omlx', supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsSaveHandle()).toBe(false);
    expect(await client.supportsSaveHandle()).toBe(false);
    expect(upstream.requestCount()).toBe(1);
  } finally {
    await upstream.close();
  }
});

test('supportsSaveHandle caches true within TTL (omlx)', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/v1/slots/capabilities') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true, supports_save_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { engine: 'omlx', supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsSaveHandle()).toBe(true);
    expect(await client.supportsSaveHandle()).toBe(true);
    expect(upstream.requestCount()).toBe(1);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle invalidates cache on save() fetch failure', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(true);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (init?.method === 'POST' && url.pathname.startsWith('/slots/')) {
          throw new TypeError('network down');
        }
        return originalFetch(input as Parameters<typeof fetch>[0], init);
      }) as typeof fetch;
      const result = await client.save(1, 'slot-failure.bin');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected save failure');
      expect(await client.supportsRequestHandle()).toBe(true);
      expect(upstream.requestCount()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle invalidates cache on restore() fetch failure', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(true);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (init?.method === 'POST' && url.pathname.startsWith('/slots/')) {
          throw new TypeError('network down');
        }
        return originalFetch(input as Parameters<typeof fetch>[0], init);
      }) as typeof fetch;
      const result = await client.restore(1, 'slot-failure.bin');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected restore failure');
      expect(await client.supportsRequestHandle()).toBe(true);
      expect(upstream.requestCount()).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle invalidateCapabilityCache() forces next call to re-probe', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl, { supportsRequestHandleTtlMs: 60_000 });
    expect(await client.supportsRequestHandle()).toBe(true);
    client.invalidateCapabilityCache();
    expect(await client.supportsRequestHandle()).toBe(true);
    expect(upstream.requestCount()).toBe(2);
  } finally {
    await upstream.close();
  }
});

test('supportsRequestHandle still returns true when capability present', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsRequestHandle()).toBe(true);
  } finally {
    await upstream.close();
  }
});

test('supportsSlots still returns true when slots block present', async () => {
  const upstream = await startTestServer((req, res, url) => {
    if (req.method === 'GET' && url.pathname === '/props') {
      json(res, 200, { slots: { api_version: 2, supports_request_handle: true } });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    expect(await client.supportsSlots()).toBe(true);
  } finally {
    await upstream.close();
  }
});
