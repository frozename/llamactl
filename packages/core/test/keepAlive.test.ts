import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  keepAliveLogFile,
  keepAlivePidFile,
  keepAliveStateFile,
  keepAliveStatus,
  keepAliveStopFile,
  readKeepAlivePid,
  readKeepAliveState,
  stopKeepAlive,
} from '../src/keepAlive.js';
import { envForTemp, makeTempRuntime } from './helpers.js';

describe('keepAlive path helpers', () => {
  let temp: ReturnType<typeof makeTempRuntime>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    temp = makeTempRuntime();
    originalEnv = { ...process.env };
    for (const [k, v] of Object.entries(envForTemp(temp))) {
      if (v !== undefined) process.env[k] = v;
    }
  });
  afterEach(() => {
    process.env = originalEnv;
    temp.cleanup();
  });

  test('paths land under runtime dir', () => {
    expect(keepAlivePidFile()).toBe(join(temp.runtimeDir, 'llama-keep-alive.pid'));
    expect(keepAliveStopFile()).toBe(join(temp.runtimeDir, 'llama-keep-alive.stop'));
    expect(keepAliveStateFile()).toBe(join(temp.runtimeDir, 'llama-keep-alive.state'));
  });

  test('log file lives under $LLAMA_CPP_LOGS', () => {
    expect(keepAliveLogFile()).toContain('keep-alive.log');
  });
});

describe('keepAlive state parsing', () => {
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

  test('readKeepAliveState returns null when the file is absent', () => {
    expect(readKeepAliveState()).toBeNull();
  });

  test('parses the shell-compat state-file key=value format', () => {
    writeFileSync(
      keepAliveStateFile(),
      [
        'updated_at=2026-04-17T12:00:00-0300',
        'target=current',
        'model=Demo/demo.gguf',
        'state=ready',
        'restarts=2',
        'backoff_seconds=4',
        'log=/var/log/keep-alive.log',
      ].join('\n'),
    );
    const state = readKeepAliveState();
    expect(state?.state).toBe('ready');
    expect(state?.restarts).toBe(2);
    expect(state?.model).toBe('Demo/demo.gguf');
  });
});

describe('keepAliveStatus', () => {
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

  test('reports not running when no pid file exists', () => {
    const status = keepAliveStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  test('clears a stale pid file referencing a dead process', () => {
    writeFileSync(keepAlivePidFile(), '999999\n');
    const status = keepAliveStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(existsSync(keepAlivePidFile())).toBe(false);
  });
});

describe('stopKeepAlive', () => {
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

  test('no-op when there is nothing running', async () => {
    const result = await stopKeepAlive();
    expect(result.stopped).toBe(true);
    expect(result.killed).toBe(false);
    expect(existsSync(keepAliveStopFile())).toBe(false);
  });

  test('cleans stale pid files without a running process', async () => {
    writeFileSync(keepAlivePidFile(), '999999\n');
    const result = await stopKeepAlive();
    expect(result.stopped).toBe(true);
    expect(readKeepAlivePid()).toBeNull();
  });
});
