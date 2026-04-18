import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverLogFile, tailServerLog } from '../src/serverLogs.js';
import { resolveEnv } from '../src/env.js';

let tmp: string;
let resolved: ReturnType<typeof resolveEnv>;
let logsDir: string;
let logPath: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'llamactl-logs-'));
  logsDir = join(tmp, 'logs', 'llama.cpp');
  mkdirSync(logsDir, { recursive: true });
  process.env.DEV_STORAGE = tmp;
  process.env.LLAMA_CPP_LOGS = logsDir;
  resolved = resolveEnv();
  logPath = serverLogFile(resolved);
});

afterEach(() => {
  process.env = { ...origEnv };
  rmSync(tmp, { recursive: true, force: true });
});

describe('tailServerLog', () => {
  test('backfills the last N lines from an existing log, then returns', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`);
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    const seen: string[] = [];
    await tailServerLog({
      lines: 5,
      follow: false,
      resolved,
      onLine: (e) => seen.push(e.line),
    });
    expect(seen).toEqual(['line-7', 'line-8', 'line-9', 'line-10', 'line-11']);
  });

  test('returns early without tailing when the file is absent and follow is off', async () => {
    const seen: string[] = [];
    await tailServerLog({
      resolved,
      follow: false,
      onLine: (e) => seen.push(e.line),
    });
    expect(seen).toEqual([]);
  });

  test('follow emits new appended lines until aborted', async () => {
    writeFileSync(logPath, 'seed\n', 'utf8');
    const seen: string[] = [];
    const ac = new AbortController();
    const task = tailServerLog({
      lines: 0,
      follow: true,
      resolved,
      intervalMs: 20,
      signal: ac.signal,
      onLine: (e) => {
        seen.push(e.line);
        if (seen.length >= 3) ac.abort();
      },
    });
    // Schedule appends after the tail loop starts.
    setTimeout(() => appendFileSync(logPath, 'alpha\n'), 30);
    setTimeout(() => appendFileSync(logPath, 'beta\n'), 60);
    setTimeout(() => appendFileSync(logPath, 'gamma\n'), 90);
    await task;
    expect(seen).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('abort signal from the outset terminates without emitting', async () => {
    writeFileSync(logPath, 'line1\nline2\nline3\n', 'utf8');
    const ac = new AbortController();
    ac.abort();
    const seen: string[] = [];
    await tailServerLog({
      lines: 10,
      follow: true,
      resolved,
      signal: ac.signal,
      onLine: (e) => seen.push(e.line),
    });
    expect(seen).toEqual([]);
  });

  test('handles partial tail fragments without emitting until a newline arrives', async () => {
    writeFileSync(logPath, '', 'utf8');
    const seen: string[] = [];
    const ac = new AbortController();
    const task = tailServerLog({
      lines: 0,
      follow: true,
      resolved,
      intervalMs: 20,
      signal: ac.signal,
      onLine: (e) => {
        seen.push(e.line);
        if (seen.length >= 1) ac.abort();
      },
    });
    setTimeout(() => appendFileSync(logPath, 'hel'), 30);
    setTimeout(() => appendFileSync(logPath, 'lo\n'), 80);
    await task;
    expect(seen).toEqual(['hello']);
  });
});
