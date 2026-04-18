import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  lockFilePath,
  releaseLock,
  writeStaleLock,
} from '../src/workload/lock.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('acquireLock / releaseLock', () => {
  test('acquires then releases cleanly', () => {
    const handle = acquireLock(dir);
    expect('error' in handle).toBe(false);
    if ('error' in handle) return;
    expect(existsSync(handle.path)).toBe(true);
    expect(Number.parseInt(readFileSync(handle.path, 'utf8'), 10)).toBe(process.pid);
    releaseLock(handle);
    expect(existsSync(handle.path)).toBe(false);
  });

  test('fails when the lock is held by a live PID', () => {
    const first = acquireLock(dir);
    expect('error' in first).toBe(false);
    try {
      const second = acquireLock(dir);
      expect('error' in second).toBe(true);
    } finally {
      if (!('error' in first)) releaseLock(first);
    }
  });

  test('steals a stale lock whose PID is gone', () => {
    // PID 1 exists, but pick a PID that almost certainly does not
    // (max pid on macOS is 99999; 4294967290 is out of range).
    const stalePid = 4_294_967_290;
    writeStaleLock(dir, stalePid);
    expect(existsSync(lockFilePath(dir))).toBe(true);
    const handle = acquireLock(dir);
    expect('error' in handle).toBe(false);
    if (!('error' in handle)) {
      expect(handle.pid).toBe(process.pid);
      releaseLock(handle);
    }
  });

  test('lockFilePath is stable within a workloads dir', () => {
    expect(lockFilePath(dir)).toBe(join(dir, '.controller.lock'));
  });
});
