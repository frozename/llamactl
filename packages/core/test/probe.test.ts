import { describe, expect, it } from 'bun:test';
import { formatEndpoint, probeHealthEndpoint } from '../src/probe.js';

describe('formatEndpoint', () => {
  it('normalizes 0.0.0.0 to 127.0.0.1', () => {
    expect(formatEndpoint('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080');
  });
  it('passes loopback IPv4 through', () => {
    expect(formatEndpoint('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
  });
  it('passes hostname through', () => {
    expect(formatEndpoint('localhost', 8080)).toBe('http://localhost:8080');
  });
  it('bracket-wraps IPv6 literals', () => {
    expect(formatEndpoint('::1', 8080)).toBe('http://[::1]:8080');
  });
  it('does not double-wrap already-bracketed IPv6', () => {
    expect(formatEndpoint('[::1]', 8080)).toBe('http://[::1]:8080');
  });
});

describe('probeHealthEndpoint', () => {
  function makeFetch(handler: (url: string) => Response | Promise<Response>): typeof globalThis.fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }) as typeof globalThis.fetch;
  }

  it('returns reachable=true when /healthz returns 200', async () => {
    const probe = await probeHealthEndpoint('127.0.0.1', 8080, {
      fetch: makeFetch(() => new Response('ok', { status: 200 })),
    });
    expect(probe.reachable).toBe(true);
  });

  it('falls back to /health when /healthz returns 404', async () => {
    const calls: string[] = [];
    const probe = await probeHealthEndpoint('127.0.0.1', 8080, {
      fetch: makeFetch((url) => {
        calls.push(url);
        return new Response('', { status: url.endsWith('/healthz') ? 404 : 200 });
      }),
    });
    expect(probe.reachable).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:8080/healthz', 'http://127.0.0.1:8080/health']);
  });

  it('returns reachable=false on connection error', async () => {
    const probe = await probeHealthEndpoint('127.0.0.1', 8080, {
      fetch: makeFetch(() => { throw new Error('ECONNREFUSED'); }),
    });
    expect(probe.reachable).toBe(false);
  });

  it('normalizes 0.0.0.0 to 127.0.0.1 in the probe URL', async () => {
    let urlSeen = '';
    await probeHealthEndpoint('0.0.0.0', 9999, {
      fetch: makeFetch((url) => { urlSeen = url; return new Response('', { status: 200 }); }),
    });
    expect(urlSeen).toBe('http://127.0.0.1:9999/healthz');
  });

  it('bracket-wraps IPv6 in the probe URL', async () => {
    let urlSeen = '';
    await probeHealthEndpoint('::1', 9999, {
      fetch: makeFetch((url) => { urlSeen = url; return new Response('', { status: 200 }); }),
    });
    expect(urlSeen).toBe('http://[::1]:9999/healthz');
  });
});
