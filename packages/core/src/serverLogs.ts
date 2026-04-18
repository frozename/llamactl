import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveEnv } from './env.js';
import type { ResolvedEnv } from './types.js';

/** Absolute path to the llama-server stdout/stderr capture file. */
export function serverLogFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LLAMA_CPP_LOGS, 'server.log');
}

export type LogLineEvent = { type: 'line'; line: string };

export interface TailOptions {
  /** How many existing lines from the tail of the file to emit first.
   *  Default 50. Pass 0 to start in follow mode without any backfill. */
  lines?: number;
  /** When true, keep polling for appends after the backfill drains.
   *  The function returns only when opts.signal aborts. Default false. */
  follow?: boolean;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
  onLine: (e: LogLineEvent) => void;
  /** Polling interval in ms for follow mode. Default 200. */
  intervalMs?: number;
}

/**
 * Emits the last N lines of the server log to `onLine`, then (when
 * `follow` is set) keeps polling the file for appends and yields each
 * new full line. Terminates cleanly when the abort signal fires.
 *
 * Uses polling + size comparison rather than fs.watch because the
 * latter's semantics diverge across platforms (notably on macOS the
 * fsevents backend buffers writes) and the tail-f UX tolerates a
 * 200 ms lag fine.
 */
export async function tailServerLog(opts: TailOptions): Promise<void> {
  const resolved = opts.resolved ?? resolveEnv();
  const file = serverLogFile(resolved);
  const follow = opts.follow ?? false;
  const maxBackfill = opts.lines ?? 50;
  const interval = opts.intervalMs ?? 200;

  if (!existsSync(file)) {
    if (!follow) return;
    while (!existsSync(file)) {
      if (opts.signal?.aborted) return;
      await sleep(interval);
    }
  }

  // Backfill.
  const initial = await stat(file);
  let position = 0;
  if (maxBackfill > 0) {
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n');
    // readFile on a file ending in '\n' leaves a trailing empty entry
    // we don't want to surface as a blank line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const slice = lines.length > maxBackfill ? lines.slice(-maxBackfill) : lines;
    for (const line of slice) {
      if (opts.signal?.aborted) return;
      opts.onLine({ type: 'line', line });
    }
  }
  position = initial.size;

  if (!follow) return;

  let tail = '';
  while (!opts.signal?.aborted) {
    let current: Awaited<ReturnType<typeof stat>>;
    try {
      current = await stat(file);
    } catch {
      // File disappeared (rotated or removed); wait and retry.
      await sleep(interval);
      continue;
    }
    if (current.size < position) {
      // Log was truncated or rotated; reset.
      position = 0;
      tail = '';
    }
    if (current.size > position) {
      const stream = createReadStream(file, {
        start: position,
        end: current.size - 1,
        encoding: 'utf8',
      });
      for await (const chunk of stream) {
        if (opts.signal?.aborted) return;
        tail += chunk;
        const parts = tail.split('\n');
        tail = parts.pop() ?? '';
        for (const line of parts) {
          opts.onLine({ type: 'line', line });
        }
      }
      position = current.size;
    }
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
