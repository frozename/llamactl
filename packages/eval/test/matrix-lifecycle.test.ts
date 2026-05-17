import { describe, expect, test } from 'bun:test';
import { ensureModelServing, teardownIfOwned, type ModelSpec } from '../src/index.js';

function baseModel(overrides: Partial<ModelSpec>): ModelSpec {
  return {
    name: 'test',
    gguf_path: '/tmp/none.gguf',
    quant: 'Q4',
    family: 'test',
    size_params: '1b',
    host: '127.0.0.1',
    port: 65501,
    extra_args: [],
    ...overrides,
  };
}

describe('ensureModelServing', () => {
  test('returns owned=false when server already responds to /health', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('ok', { status: 200 });
    try {
      const boot = await ensureModelServing(baseModel({ managed: true, binary: '/nonexistent' }));
      expect(boot.owned).toBe(false);
      expect(boot.proc).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('throws when managed=false and /health is unreachable', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      await expect(ensureModelServing(baseModel({ managed: false }))).rejects.toThrow(/not reachable/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('throws when managed=true but binary path does not exist', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      await expect(
        ensureModelServing(baseModel({ managed: true, binary: '/nonexistent-binary' })),
      ).rejects.toThrow(/binary not found/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('teardownIfOwned', () => {
  test('no-op when owned=false', async () => {
    await teardownIfOwned({ owned: false, proc: null });
  });

  test('no-op when proc already exited', async () => {
    await teardownIfOwned({ owned: true, proc: { exitCode: 0, kill: () => false } as any });
  });
});
