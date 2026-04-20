import { describe, expect, test } from 'bun:test';
import { formatEvalScript, resolveEnv } from '../src/env.js';

describe('env.resolveEnv', () => {
  test('derives sensible defaults from just DEV_STORAGE', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);

    expect(resolved.HF_HOME).toBe('/tmp/ds/cache/huggingface');
    expect(resolved.HUGGINGFACE_HUB_CACHE).toBe('/tmp/ds/cache/huggingface/hub');
    expect(resolved.OLLAMA_MODELS).toBe('/tmp/ds/ai-models/ollama');
    expect(resolved.LLAMA_CPP_ROOT).toBe('/tmp/ds/ai-models/llama.cpp');
    expect(resolved.LLAMA_CPP_MODELS).toBe('/tmp/ds/ai-models/llama.cpp/models');
    expect(resolved.LOCAL_AI_RUNTIME_DIR).toBe('/tmp/ds/ai-models/local-ai');
    expect(resolved.LLAMA_CPP_MACHINE_PROFILE).toBe('macbook-pro-48g');
    expect(resolved.LLAMA_CPP_GEMMA_CTX_SIZE).toBe('32768');
    expect(resolved.LLAMA_CPP_QWEN_CTX_SIZE).toBe('65536');
  });

  test('mac-mini profile drops context sizes', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'mac-mini-16g',
    } as NodeJS.ProcessEnv);
    expect(resolved.LLAMA_CPP_GEMMA_CTX_SIZE).toBe('16384');
    expect(resolved.LLAMA_CPP_QWEN_CTX_SIZE).toBe('16384');
  });

  test('provider=lmstudio rewires provider URL + api key', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
      LOCAL_AI_PROVIDER: 'lmstudio',
      LM_API_TOKEN: 'secret',
    } as NodeJS.ProcessEnv);
    expect(resolved.LOCAL_AI_PROVIDER).toBe('lmstudio');
    expect(resolved.LOCAL_AI_PROVIDER_URL).toBe('http://127.0.0.1:1234/v1');
    expect(resolved.LOCAL_AI_API_KEY).toBe('secret');
    expect(resolved.OPENAI_BASE_URL).toBe('http://127.0.0.1:1234/v1');
  });

  test('LOCAL_AI_MODEL honours explicit override', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
      LOCAL_AI_MODEL: 'custom-id',
    } as NodeJS.ProcessEnv);
    expect(resolved.LOCAL_AI_MODEL).toBe('custom-id');
  });
});

describe('env.resolveEnv — LLAMACTL_TEST_PROFILE', () => {
  test('reroots every ai-model / cache / runtime path under the profile', () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: '/tmp/hermetic',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);

    expect(resolved.DEV_STORAGE).toBe('/tmp/hermetic');
    expect(resolved.LOCAL_AI_RUNTIME_DIR).toBe('/tmp/hermetic/ai-models/local-ai');
    expect(resolved.LLAMA_CPP_ROOT).toBe('/tmp/hermetic/ai-models/llama.cpp');
    expect(resolved.LLAMA_CPP_MODELS).toBe('/tmp/hermetic/ai-models/llama.cpp/models');
    expect(resolved.LLAMA_CPP_CACHE).toBe('/tmp/hermetic/ai-models/llama.cpp/.cache');
    expect(resolved.LLAMA_CPP_LOGS).toBe('/tmp/hermetic/logs/llama.cpp');
    expect(resolved.LLAMA_CPP_BIN).toBe('/tmp/hermetic/bin');
    expect(resolved.HF_HOME).toBe('/tmp/hermetic/cache/huggingface');
    expect(resolved.HUGGINGFACE_HUB_CACHE).toBe('/tmp/hermetic/cache/huggingface/hub');
    expect(resolved.OLLAMA_MODELS).toBe('/tmp/hermetic/ai-models/ollama');
  });

  test('pins host to 127.0.0.1 and port to 65534 (sentinel)', () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: '/tmp/hermetic',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);

    expect(resolved.LLAMA_CPP_HOST).toBe('127.0.0.1');
    expect(resolved.LLAMA_CPP_PORT).toBe('65534');
    // Derived URLs pick up the sentinel automatically.
    expect(resolved.LOCAL_AI_LLAMA_CPP_BASE_URL).toBe('http://127.0.0.1:65534/v1');
    expect(resolved.LOCAL_AI_PROVIDER_URL).toBe('http://127.0.0.1:65534/v1');
    expect(resolved.OPENAI_BASE_URL).toBe('http://127.0.0.1:65534/v1');
  });

  test('individual env var wins over test-profile default', () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: '/tmp/hermetic',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
      LLAMA_CPP_BIN: '/my/real/bin',
      LLAMA_CPP_PORT: '8081',
    } as NodeJS.ProcessEnv);

    expect(resolved.LLAMA_CPP_BIN).toBe('/my/real/bin');
    expect(resolved.LLAMA_CPP_PORT).toBe('8081');
    // Other paths still under the test profile.
    expect(resolved.LLAMA_CPP_ROOT).toBe('/tmp/hermetic/ai-models/llama.cpp');
    expect(resolved.HF_HOME).toBe('/tmp/hermetic/cache/huggingface');
    expect(resolved.LLAMA_CPP_HOST).toBe('127.0.0.1');
  });

  test('empty LLAMACTL_TEST_PROFILE behaves as unset', () => {
    const resolved = resolveEnv({
      LLAMACTL_TEST_PROFILE: '',
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);

    // Production cascade still drives derivation — $DEV_STORAGE wins.
    expect(resolved.DEV_STORAGE).toBe('/tmp/ds');
    expect(resolved.LLAMA_CPP_ROOT).toBe('/tmp/ds/ai-models/llama.cpp');
    expect(resolved.LLAMA_CPP_PORT).toBe('8080');
    expect(resolved.LLAMA_CPP_BIN).toBe('/tmp/ds/src/llama.cpp/build/bin');
  });

  test('without LLAMACTL_TEST_PROFILE, behaviour is unchanged', () => {
    // Baseline snapshot: production defaults keyed off $DEV_STORAGE.
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);

    expect(resolved.DEV_STORAGE).toBe('/tmp/ds');
    expect(resolved.LLAMA_CPP_ROOT).toBe('/tmp/ds/ai-models/llama.cpp');
    expect(resolved.LLAMA_CPP_BIN).toBe('/tmp/ds/src/llama.cpp/build/bin');
    expect(resolved.LLAMA_CPP_PORT).toBe('8080');
    expect(resolved.LLAMA_CPP_HOST).toBe('127.0.0.1');
    expect(resolved.HF_HOME).toBe('/tmp/ds/cache/huggingface');
    expect(resolved.OLLAMA_MODELS).toBe('/tmp/ds/ai-models/ollama');
  });

  test('does not mutate the caller env map', () => {
    const caller: NodeJS.ProcessEnv = {
      LLAMACTL_TEST_PROFILE: '/tmp/hermetic',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    };
    const snapshot = { ...caller };
    resolveEnv(caller);
    expect(caller).toEqual(snapshot);
  });
});

describe('env.formatEvalScript', () => {
  test('emits export lines + mkdir + PATH tweak', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
    } as NodeJS.ProcessEnv);
    const script = formatEvalScript(resolved);

    expect(script).toContain('export DEV_STORAGE=/tmp/ds');
    expect(script).toContain('export LLAMA_CPP_MACHINE_PROFILE=macbook-pro-48g');
    expect(script).toContain('export OPENAI_BASE_URL=');
    expect(script).toMatch(/mkdir -p .* 2>\/dev\/null \|\| true/);
    // PATH tweak only fires when the bin dir exists; in a hermetic test
    // env the bin won't exist so the `if [ -d ... ]` guard is in place.
    expect(script).toContain('if [ -d');
  });

  test('escapes values with shell metacharacters', () => {
    const resolved = resolveEnv({
      DEV_STORAGE: '/tmp/ds',
      LLAMA_CPP_MACHINE_PROFILE: 'macbook-pro-48g',
      LLAMA_CPP_SERVER_ALIAS: "name with 'quotes'",
    } as NodeJS.ProcessEnv);
    const script = formatEvalScript(resolved);
    expect(script).toContain(`export LLAMA_CPP_SERVER_ALIAS='name with '\\''quotes'\\'''`);
  });
});
