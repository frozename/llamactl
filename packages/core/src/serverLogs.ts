import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedEnv } from "./types.js";
import type { WorkloadKey } from "./workloadRuntime.js";

import { resolveEnv } from "./env.js";
import { workloadRuntimeDir } from "./workloadRuntime.js";

/** Absolute path to the llama-server stdout/stderr capture file. */
export function serverLogFile(resolved: ResolvedEnv = resolveEnv(), key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "llama-server.log");
}

export type LogLineEvent = { type: "line"; line: string };

export interface TailOptions {
  key: WorkloadKey;
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

/** Poll until the log file exists. Returns false when aborted first. */
async function waitForLogFile(
  file: string,
  interval: number,
  signal?: AbortSignal,
): Promise<boolean> {
  while (!existsSync(file)) {
    if (signal?.aborted) return false;
    await sleep(interval);
  }
  return true;
}

/** Emit the last `maxBackfill` lines of the file. */
async function emitBackfillLines(
  file: string,
  maxBackfill: number,
  opts: TailOptions,
): Promise<"done" | "aborted"> {
  const raw = await readFile(file, "utf8");
  const lines = raw.split("\n");
  // readFile on a file ending in '\n' leaves a trailing empty entry
  // we don't want to surface as a blank line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const slice = lines.length > maxBackfill ? lines.slice(-maxBackfill) : lines;
  for (const line of slice) {
    if (opts.signal?.aborted) return "aborted";
    opts.onLine({ type: "line", line });
  }
  return "done";
}

interface FollowState {
  position: number;
  tail: string;
}

/** Stream bytes appended since `state.position`, emitting each completed line. */
async function emitAppendedLines(
  file: string,
  size: number,
  state: FollowState,
  opts: TailOptions,
): Promise<"continue" | "aborted"> {
  const stream = createReadStream(file, {
    start: state.position,
    end: size - 1,
    encoding: "utf8",
  });
  for await (const chunk of stream) {
    if (opts.signal?.aborted) return "aborted";
    state.tail += String(chunk);
    const parts = state.tail.split("\n");
    state.tail = parts.pop() ?? "";
    for (const line of parts) {
      opts.onLine({ type: "line", line });
    }
  }
  state.position = size;
  return "continue";
}

/** Poll the file for appends, emitting new lines until the signal aborts. */
async function followLogAppends(
  file: string,
  startPosition: number,
  interval: number,
  opts: TailOptions,
): Promise<void> {
  const state: FollowState = { position: startPosition, tail: "" };
  while (!opts.signal?.aborted) {
    let current: Awaited<ReturnType<typeof stat>>;
    try {
      current = await stat(file);
    } catch {
      // File disappeared (rotated or removed); wait and retry.
      await sleep(interval);
      continue;
    }
    if (current.size < state.position) {
      // Log was truncated or rotated; reset.
      state.position = 0;
      state.tail = "";
    }
    if (current.size > state.position) {
      const status = await emitAppendedLines(file, current.size, state, opts);
      if (status === "aborted") return;
    }
    await sleep(interval);
  }
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
  const file = serverLogFile(resolved, opts.key);
  const follow = opts.follow ?? false;
  const maxBackfill = opts.lines ?? 50;
  const interval = opts.intervalMs ?? 200;

  if (!existsSync(file)) {
    if (!follow) return;
    const appeared = await waitForLogFile(file, interval, opts.signal);
    if (!appeared) return;
  }

  // Backfill.
  const initial = await stat(file);
  if (maxBackfill > 0) {
    const backfill = await emitBackfillLines(file, maxBackfill, opts);
    if (backfill === "aborted") return;
  }

  if (!follow) return;

  await followLogAppends(file, initial.size, interval, opts);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
