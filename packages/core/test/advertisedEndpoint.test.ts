import { afterEach, describe, expect, test } from 'bun:test';
import { advertisedEndpoint, endpoint } from '../src/server.js';
import { resolveEnv } from '../src/env.js';
import { collectNodeFacts } from '../src/nodeFacts.js';

const origEnv = { ...process.env };

afterEach(() => {
  process.env = { ...origEnv };
});

describe('advertisedEndpoint', () => {
  test('falls back to bind endpoint when LLAMA_CPP_ADVERTISED_HOST is unset', () => {
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '8080';
    delete process.env.LLAMA_CPP_ADVERTISED_HOST;
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe('http://127.0.0.1:8080');
    expect(advertisedEndpoint(resolved)).toBe('http://127.0.0.1:8080');
  });

  test('overrides the host when LLAMA_CPP_ADVERTISED_HOST is set', () => {
    process.env.LLAMA_CPP_HOST = '0.0.0.0';
    process.env.LLAMA_CPP_PORT = '8080';
    process.env.LLAMA_CPP_ADVERTISED_HOST = 'mac-mini.local';
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe('http://0.0.0.0:8080');
    expect(advertisedEndpoint(resolved)).toBe('http://mac-mini.local:8080');
  });

  test('keeps bind endpoint unchanged when override matches bind', () => {
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '8080';
    process.env.LLAMA_CPP_ADVERTISED_HOST = '127.0.0.1';
    const resolved = resolveEnv();
    expect(endpoint(resolved)).toBe('http://127.0.0.1:8080');
    expect(advertisedEndpoint(resolved)).toBe('http://127.0.0.1:8080');
  });
});

describe('nodeFacts.advertisedEndpoint', () => {
  test('populated from the env override', () => {
    const facts = collectNodeFacts({
      ...process.env,
      LLAMA_CPP_HOST: '0.0.0.0',
      LLAMA_CPP_PORT: '8080',
      LLAMA_CPP_ADVERTISED_HOST: 'gpu-mini.lan',
    });
    expect(facts.advertisedEndpoint).toBe('http://gpu-mini.lan:8080');
  });

  test('populated from the bind host when no advertised host is set', () => {
    const facts = collectNodeFacts({
      ...process.env,
      LLAMA_CPP_HOST: '127.0.0.1',
      LLAMA_CPP_PORT: '8080',
      LLAMA_CPP_ADVERTISED_HOST: '',
    });
    expect(facts.advertisedEndpoint).toBe('http://127.0.0.1:8080');
  });
});
