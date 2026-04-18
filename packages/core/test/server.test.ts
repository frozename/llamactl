import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  endpoint,
  readServerPid,
  serverStatus,
  startServer,
  stopServer,
} from '../src/server.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('server.endpoint', () => {
  test('builds an http URL from host + port', () => {
    expect(endpoint({ LLAMA_CPP_HOST: '127.0.0.1', LLAMA_CPP_PORT: '9876' } as any))
      .toBe('http://127.0.0.1:9876');
  });
});

describe('server.readServerPid', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('returns null when the file is missing', () => {
    expect(readServerPid()).toBeNull();
  });

  test('parses a valid PID file', () => {
    writeFileSync(join(temp.runtimeDir, 'llama-server.pid'), '42\n');
    expect(readServerPid()).toBe(42);
  });

  test('returns null for a malformed PID file', () => {
    writeFileSync(join(temp.runtimeDir, 'llama-server.pid'), 'not-a-number');
    expect(readServerPid()).toBeNull();
  });
});

describe('server.serverStatus', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    // Point host/port at an address that will refuse connections so the
    // health probe deterministically reports unreachable.
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '1';
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('reports down when no PID and endpoint is unreachable', async () => {
    const status = await serverStatus();
    expect(status.state).toBe('down');
    expect(status.pid).toBeNull();
    expect(status.health.reachable).toBe(false);
  });

  test('clears a stale PID file when the process is not alive', async () => {
    writeFileSync(join(temp.runtimeDir, 'llama-server.pid'), '999999\n');
    const status = await serverStatus();
    expect(status.pid).toBeNull();
    // Stale file should have been removed.
    expect(readServerPid()).toBeNull();
  });
});

describe('server.startServer (error paths)', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    process.env.LLAMA_CPP_BIN = join(temp.devStorage, 'nonexistent-bin');
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('errors when the target does not resolve', async () => {
    const result = await startServer({ target: 'not-a-real-alias' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown target/);
  });

  test('errors when the model file is missing on disk', async () => {
    // resolveTarget accepts rel-style strings verbatim.
    const result = await startServer({ target: 'Demo/demo.gguf' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Model file not found/);
  });

  test('errors when llama-server binary is missing', async () => {
    // Stand up the model so we get past the model check.
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const result = await startServer({ target: 'Demo/demo.gguf' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/llama-server binary not found/);
  });
});

describe('server.stopServer', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
    mkdirSync(temp.runtimeDir, { recursive: true });
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('no-op when there is nothing to stop', async () => {
    const result = await stopServer();
    expect(result.stopped).toBe(true);
    expect(result.killed).toBe(false);
  });

  test('clears a stale PID file when the process is gone', async () => {
    writeFileSync(join(temp.runtimeDir, 'llama-server.pid'), '999999\n');
    const result = await stopServer();
    expect(result.stopped).toBe(true);
    expect(readServerPid()).toBeNull();
  });
});
