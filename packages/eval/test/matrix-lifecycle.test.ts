import { describe, expect, test } from 'bun:test';
import {
  __ownedProcsForTests,
  __seedOwnedProcForTests,
  buildBootCommandForModelSpec,
  ensureModelServing,
  probeInference,
  teardownIfOwned,
  type ModelSpec,
} from '../src/index.js';

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

describe('matrix lifecycle - engine dispatch', () => {
  test('omlx ModelSpec routes to ENGINES.omlx.buildBootCommand', () => {
    const spec: ModelSpec = {
      name: 'qwen3-8b-mlx-4bit',
      engine: 'omlx',
      gguf_path: '/tmp/unused.gguf',
      family: 'qwen-3',
      quant: 'MLX-4bit',
      size_params: '8B',
      host: '127.0.0.1',
      port: 8094,
      binary: '/usr/bin/true',
      mlx_model_dir: '/tmp/mlx',
      extra_args: ['--max-concurrent-requests', '1'],
      start_args: [],
    };
    const prevRuntimeDir = process.env.LLAMACTL_RUNTIME_DIR;
    process.env.LLAMACTL_RUNTIME_DIR = '/tmp/runtime';
    try {
      const built = buildBootCommandForModelSpec(spec);
      expect(built.args[0]).toBe('serve');
      expect(built.args).toContain('--model-dir');
      expect(built.args).toContain('/tmp/runtime/workloads/qwen3-8b-mlx-4bit/.omlx/models');
    } finally {
      if (prevRuntimeDir === undefined) delete process.env.LLAMACTL_RUNTIME_DIR;
      else process.env.LLAMACTL_RUNTIME_DIR = prevRuntimeDir;
    }
  });

  test('omlx ModelSpec without mlx_model_dir falls through to LLAMA_CPP_MODELS', () => {
    const spec: ModelSpec = {
      name: 'qwen3-8b-mlx-4bit',
      engine: 'omlx',
      gguf_path: '/tmp/unused.gguf',
      family: 'qwen-3',
      quant: 'MLX-4bit',
      size_params: '8B',
      host: '127.0.0.1',
      port: 8094,
      binary: '/usr/bin/true',
      extra_args: ['--max-concurrent-requests', '1'],
      start_args: [],
    };
    const prevModels = process.env.LLAMA_CPP_MODELS;
    process.env.LLAMA_CPP_MODELS = '/tmp/models';
    try {
      const built = buildBootCommandForModelSpec(spec);
      const modelDirIdx = built.args.indexOf('--model-dir');
      expect(modelDirIdx).toBeGreaterThan(-1);
      expect(built.args[modelDirIdx + 1]).not.toBe('');
    } finally {
      if (prevModels === undefined) delete process.env.LLAMA_CPP_MODELS;
      else process.env.LLAMA_CPP_MODELS = prevModels;
    }
  });

  test('default engine (undefined) routes to llama.cpp path (back-compat)', () => {
    const spec: ModelSpec = {
      name: 'granite-3b-Q8',
      family: 'granite',
      quant: 'Q8_0',
      size_params: '3B',
      host: '127.0.0.1',
      port: 8085,
      binary: '/usr/bin/true',
      gguf_path: '/tmp/granite-3b-Q8.gguf',
      extra_args: [],
      start_args: [],
    };
    const built = buildBootCommandForModelSpec(spec);
    expect(built.binary).toBe('/usr/bin/true');
    expect(built.args).toContain('--port');
  });
});

describe('ensureModelServing', () => {
  test('returns owned=false when server already responds to /health', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
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
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      await expect(ensureModelServing(baseModel({ managed: false }))).rejects.toThrow(/not reachable/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('throws when managed=true but binary path does not exist', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      await expect(
        ensureModelServing(baseModel({ managed: true, binary: '/nonexistent-binary' })),
      ).rejects.toThrow(/binary not found/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('throws when managed spawn passes /health but /v1 boot-probe fails', async () => {
    const origFetch = globalThis.fetch;
    let healthChecks = 0;
    globalThis.fetch = (async (input: Request | string | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error('ECONNREFUSED');
        return new Response('ok', { status: 200 });
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response('nope', { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;
    try {
      await expect(
        ensureModelServing(
          baseModel({ managed: true, binary: '/bin/sleep', start_args: ['1000'], port: 65502 }),
        ),
      ).rejects.toThrow(/\/v1 boot-probe failed/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('probeInference', () => {
  test('returns true when /v1 responds with valid JSON', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      await expect(probeInference('127.0.0.1', 65501, 1000)).resolves.toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('returns false when /v1 responds 500 or fetch throws', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
      await expect(probeInference('127.0.0.1', 65501, 1000)).resolves.toBe(false);

      globalThis.fetch = (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      await expect(probeInference('127.0.0.1', 65501, 1000)).resolves.toBe(false);
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

  test('removes owned proc from the tracked set', async () => {
    const proc = {
      exitCode: null,
      kill: () => {
        proc.exitCode = 0;
        return true;
      },
    } as any;
    __seedOwnedProcForTests(proc);
    expect(__ownedProcsForTests().has(proc)).toBe(true);
    await teardownIfOwned({ owned: true, proc });
    expect(__ownedProcsForTests().has(proc)).toBe(false);
  });
});
