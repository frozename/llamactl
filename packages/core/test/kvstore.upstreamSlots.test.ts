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

test('save success returns ok + tokensSaved + sends filename in JSON body', async () => {
  let sentFilename: string | null = null;
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
  let sentFilename: string | null = null;
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
    expect(result).toEqual({ ok: true, tokensRestored: 456 });
    expect(sentFilename).toBe('slot-c.bin');
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
  const upstream = await startTestServer(async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    json(res, 200, { n_saved: 1 });
  });
  try {
    const client = new UpstreamSlotClient(upstream.baseUrl);
    const result = await client.save(1, 'slot-timeout.bin');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected save timeout');
    expect(result.reason).toBe('network');
  } finally {
    await upstream.close();
  }
}, 20_000);

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
