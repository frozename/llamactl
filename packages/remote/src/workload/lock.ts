import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * File-based mutex using exclusive-create. The pidfile's contents are
 * the current PID; on acquire, if a stale lock exists whose PID is no
 * longer alive, the lock is stolen transparently. This is "good
 * enough" for a single-machine controller — two machines running
 * controllers against the same workloads directory would need a real
 * fencing token, but that's beyond Phase D's scope.
 */

export interface LockHandle {
  path: string;
  fd: number;
  pid: number;
}

export function lockFilePath(workloadsDir: string): string {
  return join(workloadsDir, '.controller.lock');
}

export function acquireLock(workloadsDir: string): LockHandle | { error: string } {
  mkdirSync(workloadsDir, { recursive: true });
  const path = lockFilePath(workloadsDir);
  if (existsSync(path)) {
    const holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isFinite(holder) && holder > 0 && isProcessAlive(holder)) {
      return { error: `lock held by pid=${holder} (${path})` };
    }
    // Stale lock — previous controller crashed without releasing.
    try { unlinkSync(path); } catch {}
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, String(process.pid));
    return { path, fd, pid: process.pid };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') {
      return { error: `lock acquired concurrently at ${path}` };
    }
    throw e;
  }
}

export function releaseLock(handle: LockHandle): void {
  try { closeSync(handle.fd); } catch {}
  try { unlinkSync(handle.path); } catch {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exposed for tests that need to simulate a stale lock from a
 *  non-existent PID without shelling out to spawn a dummy process. */
export function writeStaleLock(workloadsDir: string, pid: number): void {
  mkdirSync(workloadsDir, { recursive: true });
  writeFileSync(lockFilePath(workloadsDir), String(pid));
}
