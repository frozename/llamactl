import { describe, expect, test } from 'bun:test';
import { ctxForModel } from '../src/ctx.js';
import { resolveEnv } from '../src/env.js';

describe('ctxForModel', () => {
  const env = resolveEnv({
    LLAMA_CPP_GEMMA_CTX_SIZE: '32768',
    LLAMA_CPP_QWEN_CTX_SIZE: '65536',
    LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
  } as NodeJS.ProcessEnv);

  test('Qwen 3.6 35B-A3B uses Qwen ctx', () => {
    expect(
      ctxForModel('Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', env),
    ).toBe('65536');
  });
  test('Qwen 3.5 27B uses Qwen ctx', () => {
    expect(ctxForModel('Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf', env)).toBe('65536');
  });
  test('Gemma uses Gemma ctx', () => {
    expect(
      ctxForModel('gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf', env),
    ).toBe('32768');
  });
  test('unknown family falls back to Gemma ctx', () => {
    expect(ctxForModel('foo/bar-UD-Q4_K_XL.gguf', env)).toBe('32768');
  });
});
