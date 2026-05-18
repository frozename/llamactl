import { describe, expect, test } from 'bun:test';
import { ENGINES } from '../../src/engines/index.js';
import type { ModelHostSpecForEngine } from '../../src/engines/types.js';

const baseSpec: ModelHostSpecForEngine = {
  engine: 'llamacpp',
  binary: '/some/path/llama-server',
  endpoint: { host: '127.0.0.1', port: 8090 },
  hostedModels: [{ rel: 'granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf' }],
  resources: { expectedMemoryGiB: 5 },
  extraArgs: ['--jinja'],
  timeoutSeconds: 60,
};

describe('llamacpp engine adapter', () => {
  test('validateSpec passes a well-formed spec', () => {
    const result = ENGINES.llamacpp.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test('validateSpec rejects missing binary', () => {
    const bad = { ...baseSpec, binary: '' };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test('validateSpec rejects zero hosted models', () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hostedModels/);
  });

  test('buildBootCommand includes --port and the hosted model rel', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.binary).toBe('/some/path/llama-server');
    expect(built.args).toContain('--port');
    expect(built.args).toContain('8090');
    const joined = built.args.join(' ');
    expect(joined).toMatch(/granite-4\.1-3b/);
  });

  test('buildBootCommand appends extraArgs verbatim after engine defaults', () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: '/tmp/models',
    } as any);
    expect(built.args).toContain('--jinja');
    const portIdx = built.args.indexOf('--port');
    const jinjaIdx = built.args.indexOf('--jinja');
    expect(jinjaIdx).toBeGreaterThan(portIdx);
  });
});
