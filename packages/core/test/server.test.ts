import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import {
  advertisedEndpoint,
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

  test('detects port collision before spawn + names the foreign HTTP code', async () => {
    // Stand up everything past the binary check, then bind a fake
    // HTTP answer on the configured port so the pre-flight detector
    // sees a response and bails before launching llama-server.
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const binDir = join(temp.devStorage, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'llama-server'), '#!/bin/sh\nexit 0\n');
    process.env.LLAMA_CPP_BIN = binDir;
    const port = 29143;
    process.env.LLAMA_CPP_PORT = String(port);
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 401 }) as any,
    );
    try {
      const result = await startServer({ target: 'Demo/demo.gguf' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already bound/);
      expect(result.error).toMatch(/HTTP 401/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('uses a manifest endpoint override for launch args and readiness', async () => {
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const binDir = join(temp.devStorage, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'llama-server'), '#!/bin/sh\nexit 0\n');
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '8080';

    const spawnSpy = spyOn(childProcess, 'spawn')
      .mockImplementation((() =>
        ({
          pid: 12345,
          unref() {},
        }) as any));
    let fetchCalls = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error('connection refused');
      }
      return new Response('ok', { status: 200 }) as any;
    }) as any);

    try {
      const result = await startServer({
        target: 'Demo/demo.gguf',
        endpoint: { host: '127.0.0.1', port: 8181 },
      });
      expect(result.ok).toBe(true);
      expect(result.endpoint).toBe('http://127.0.0.1:8181');
      expect(spawnSpy).toHaveBeenCalled();
      const fullArgs = spawnSpy.mock.calls[0]?.[1] ?? [];
      expect(fullArgs).toContain('--host');
      expect(fullArgs).toContain('127.0.0.1');
      expect(fullArgs).toContain('--port');
      expect(fullArgs).toContain('8181');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8181/health',
        expect.objectContaining({ method: 'GET' }),
      );
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('reports the launched endpoint from serverStatus after a start with an endpoint override', async () => {
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const binDir = join(temp.devStorage, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'llama-server'), '#!/bin/sh\nexit 0\n');
    process.env.LLAMA_CPP_BIN = binDir;
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '8080';

    const spawnSpy = spyOn(childProcess, 'spawn')
      .mockImplementation((() =>
        ({
          pid: process.pid,
          unref() {},
        }) as any));
    let fetchCalls = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error('connection refused');
      }
      return new Response('ok', { status: 200 }) as any;
    }) as any);

    try {
      const result = await startServer({
        target: 'Demo/demo.gguf',
        endpoint: { host: '127.0.0.1', port: 8181 },
      });
      expect(result.ok).toBe(true);
      expect(result.endpoint).toBe('http://127.0.0.1:8181');
      expect(result.advertisedEndpoint).toBe('http://127.0.0.1:8181');

      const status = await serverStatus();
      expect(status.endpoint).toBe('http://127.0.0.1:8181');
      expect(status.advertisedEndpoint).toBe('http://127.0.0.1:8181');
      expect(status.port).toBe(8181);
      expect(status.rel).toBe('Demo/demo.gguf');
      expect(advertisedEndpoint({
        LLAMA_CPP_HOST: '127.0.0.1',
        LLAMA_CPP_PORT: '8080',
      } as any)).toBe('http://127.0.0.1:8080');
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test('uses a per-workload binary override instead of LLAMA_CPP_BIN', async () => {
    const modelDir = join(temp.modelsDir, 'Demo');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'demo.gguf'), '');
    const defaultBinDir = join(temp.devStorage, 'default-bin');
    const customBinDir = join(temp.devStorage, 'custom-bin');
    const customBin = join(customBinDir, 'llama-server');
    mkdirSync(defaultBinDir, { recursive: true });
    mkdirSync(customBinDir, { recursive: true });
    writeFileSync(join(defaultBinDir, 'llama-server'), '#!/bin/sh\nexit 0\n');
    writeFileSync(customBin, '#!/bin/sh\nexit 0\n');
    process.env.LLAMA_CPP_BIN = defaultBinDir;
    process.env.LLAMA_CPP_HOST = '127.0.0.1';
    process.env.LLAMA_CPP_PORT = '8080';

    const spawnSpy = spyOn(childProcess, 'spawn')
      .mockImplementation((() =>
        ({
          pid: process.pid,
          unref() {},
        }) as any));
    let fetchCalls = 0;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error('connection refused');
      }
      return new Response('ok', { status: 200 }) as any;
    }) as any);

    try {
      await startServer({
        target: 'Demo/demo.gguf',
        binary: customBin,
      } as any);
      expect(spawnSpy).toHaveBeenCalledWith(
        customBin,
        expect.arrayContaining(['--host', '127.0.0.1', '--port', '8080']),
        expect.objectContaining({ detached: true }),
      );
    } finally {
      spawnSpy.mockRestore();
      fetchSpy.mockRestore();
    }
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
