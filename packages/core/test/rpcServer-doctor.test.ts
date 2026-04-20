import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRpcServerAvailable } from '../src/rpcServer.js';

/**
 * Preflight doctor for the `rpc-server` binary that llama.cpp builds
 * only with `-DGGML_RPC=ON`. Each reason branch gets a direct test so
 * the `hint` text is grep-stable — apply-time preflight + the `agent
 * rpc-doctor` CLI rely on these strings to guide operators to fix.
 */

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rpc-doctor-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('checkRpcServerAvailable', () => {
  test('LLAMA_CPP_BIN unset → reason = LLAMA_CPP_BIN-unset', () => {
    const result = checkRpcServerAvailable({});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('LLAMA_CPP_BIN-unset');
    expect(result.hint).toContain('set $LLAMA_CPP_BIN');
    expect(result.path).toBeNull();
    expect(result.llamaCppBin).toBeNull();
  });

  test('LLAMA_CPP_BIN empty string (whitespace-only) is treated as unset', () => {
    const result = checkRpcServerAvailable({ LLAMA_CPP_BIN: '   ' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('LLAMA_CPP_BIN-unset');
  });

  test('LLAMA_CPP_BIN points to a nonexistent dir → reason = LLAMA_CPP_BIN-missing', () => {
    const bogus = join(tmp, 'does-not-exist');
    const result = checkRpcServerAvailable({ LLAMA_CPP_BIN: bogus });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('LLAMA_CPP_BIN-missing');
    expect(result.hint).toContain(bogus);
    expect(result.llamaCppBin).toBe(bogus);
    expect(result.path).toBeNull();
  });

  test('bin dir exists but lacks rpc-server → reason = rpc-server-missing + cmake hint', () => {
    const binDir = join(tmp, 'bin-no-rpc');
    mkdirSync(binDir, { recursive: true });
    const result = checkRpcServerAvailable({ LLAMA_CPP_BIN: binDir });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rpc-server-missing');
    // The cmake command must appear verbatim so operators can copy it.
    expect(result.hint).toContain('-DGGML_RPC=ON');
    expect(result.hint).toContain('cmake -B build -DGGML_RPC=ON');
    expect(result.hint).toContain('--target rpc-server');
    expect(result.llamaCppBin).toBe(binDir);
    expect(result.path).toBeNull();
  });

  test('rpc-server file exists but is not executable → reason = rpc-server-not-executable', () => {
    const binDir = join(tmp, 'bin-nonexec');
    mkdirSync(binDir, { recursive: true });
    const rpcPath = join(binDir, 'rpc-server');
    writeFileSync(rpcPath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    // Ensure mode is non-executable even if the umask or fs quirks
    // raised it. Skip gracefully on filesystems that don't enforce
    // the X bit (CI with certain mounts), since the test's purpose is
    // the error branch, not the chmod primitive.
    chmodSync(rpcPath, 0o644);
    const result = checkRpcServerAvailable({ LLAMA_CPP_BIN: binDir });
    if (result.ok) {
      // Filesystem ignored the non-exec bit — skip rather than fail.
      // (Common on some Windows/WSL mounts; harmless here.)
      return;
    }
    expect(result.reason).toBe('rpc-server-not-executable');
    expect(result.hint).toContain('chmod +x');
    expect(result.hint).toContain(rpcPath);
    expect(result.llamaCppBin).toBe(binDir);
    expect(result.path).toBe(rpcPath);
  });

  test('happy path: executable rpc-server present → ok, path echoed', () => {
    const binDir = join(tmp, 'bin-ok');
    mkdirSync(binDir, { recursive: true });
    const rpcPath = join(binDir, 'rpc-server');
    writeFileSync(rpcPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = checkRpcServerAvailable({ LLAMA_CPP_BIN: binDir });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(rpcPath);
    expect(result.llamaCppBin).toBe(binDir);
    expect(result.reason).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  test('default arg uses process.env when no env passed', () => {
    // Preserve + restore to avoid leaking across tests.
    const prior = process.env.LLAMA_CPP_BIN;
    try {
      delete process.env.LLAMA_CPP_BIN;
      const result = checkRpcServerAvailable();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('LLAMA_CPP_BIN-unset');
    } finally {
      if (prior === undefined) delete process.env.LLAMA_CPP_BIN;
      else process.env.LLAMA_CPP_BIN = prior;
    }
  });
});
