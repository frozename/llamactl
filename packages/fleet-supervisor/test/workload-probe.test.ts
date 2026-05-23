import { describe, it, expect } from 'bun:test';
import { probeWorkload } from '../src/workload-probe.js';

describe('probeWorkload', () => {
  it('healthy endpoint → reachable:true with latency and models', async () => {
    const fakeFetch = async (url: string) => {
      if (url.endsWith('/health')) return new Response('ok', { status: 200 });
      if (url.endsWith('/v1/models'))
        return new Response(JSON.stringify({ data: [{ id: 'Qwen3-8B' }] }), { status: 200 });
      return new Response('', { status: 404 });
    };
    const result = await probeWorkload(
      { name: 'qwen-host', endpoint: 'http://127.0.0.1:8090', kind: 'ModelHost' },
      { fetch: fakeFetch as unknown as typeof fetch, timeoutMs: 500 },
    );
    expect(result.reachable).toBe(true);
    expect(result.healthLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.models).toEqual(['Qwen3-8B']);
    expect(result.consecutiveErrors).toBe(0);
  });

  it('502 response → reachable:false, consecutiveErrors incremented', async () => {
    const fakeFetch = async () => new Response('Bad Gateway', { status: 502 });
    const result = await probeWorkload(
      { name: 'granite-mini-3b', endpoint: 'http://mac-mini.ai:8086', kind: 'ModelRun' },
      { fetch: fakeFetch as unknown as typeof fetch, timeoutMs: 500, priorConsecutiveErrors: 3 },
    );
    expect(result.reachable).toBe(false);
    expect(result.consecutiveErrors).toBe(4);
  });
});
