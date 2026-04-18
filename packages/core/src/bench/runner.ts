import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBuildId } from '../build.js';
import { ctxForModel } from '../ctx.js';
import { resolveEnv } from '../env.js';
import { findLocalMmproj } from '../mmproj.js';
import { resolveTarget } from '../target.js';
import type { ResolvedEnv } from '../types.js';
import { defaultModeForRel, machineLabel } from './mode.js';
import { benchProfileArgs, serverProfileArgs } from './launchArgs.js';
import { benchHistoryFile, benchProfileFile, benchVisionFile } from './store.js';
import type { BenchMode } from '../types.js';

const DEFAULT_PROFILES = ['default', 'throughput', 'conservative'] as const;
const DEFAULT_PROMPT = 'Describe the image in one sentence.';
const REFERENCE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgGAWDHAAAEAABSsRJZwAAAABJRU5ErkJggg==';

/** Lifecycle event emitted from bench runs. Mirrors `pull.PullEvent`. */
export type BenchEvent =
  | { type: 'start'; command: string; args: string[] }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number }
  | { type: 'profile-start'; profile: string }
  | { type: 'profile-done'; profile: string; gen_ts: string; prompt_ts: string }
  | { type: 'profile-fail'; profile: string; code: number };

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable runner for `llama-bench` / `llama-mtmd-cli`. Tests swap in
 * a fake to assert argv assembly and exercise the parser without a
 * real llama.cpp binary on PATH. When a caller passes a `signal`, the
 * default runner SIGTERMs the child on abort.
 */
export type RunCli = (
  bin: string,
  args: string[],
  onEvent?: (e: BenchEvent) => void,
  signal?: AbortSignal,
) => Promise<SpawnResult>;

function drainLines(buf: string, onLine: (line: string) => void): string {
  let remaining = buf;
  while (true) {
    const nl = remaining.indexOf('\n');
    const cr = remaining.indexOf('\r');
    let idx: number;
    if (nl === -1 && cr === -1) break;
    else if (nl === -1) idx = cr;
    else if (cr === -1) idx = nl;
    else idx = Math.min(nl, cr);
    const line = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 1);
    if (line.length > 0) onLine(line);
  }
  return remaining;
}

export const defaultRunCli: RunCli = (bin, args, onEvent, signal) => {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const attach = (
      stream: NodeJS.ReadableStream,
      kind: 'stdout' | 'stderr',
      bucket: (chunk: string) => void,
    ) => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        bucket(text);
        buf += text;
        buf = drainLines(buf, (line) => onEvent?.({ type: kind, line }));
      });
      stream.on('end', () => {
        if (buf.length > 0) onEvent?.({ type: kind, line: buf });
      });
    };
    if (child.stdout) attach(child.stdout, 'stdout', (t) => { stdout += t; });
    if (child.stderr) attach(child.stderr, 'stderr', (t) => { stderr += t; });
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be gone
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const c = code ?? 1;
      onEvent?.({ type: 'exit', code: c });
      resolve({ code: c, stdout, stderr });
    });
  });
};

// ---- context helpers ---------------------------------------------------

/**
 * Format a timestamp in the shape the shell uses:
 * `YYYY-MM-DDTHH:MM:SS±HHMM`, local time, no colon in the offset.
 */
export function formatBenchTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

// ---- JSONL / mtmd-cli parsers ----------------------------------------

/**
 * Parse a `llama-bench -o jsonl` transcript into `(gen_ts, prompt_ts)`.
 * Mirrors the shell's two-line jq idiom:
 *   gen_ts     = first row where n_gen > 0, avg_ts
 *   prompt_ts  = first row where n_prompt > 0 && n_gen == 0, avg_ts
 * Returns `'-1'` for missing metrics so the shell's comparator idiom
 * (`-gt` on printf %.0f) stays wire-compatible.
 */
export function parseBenchJsonlStats(output: string): {
  gen_ts: string;
  prompt_ts: string;
} {
  let gen: number | null = null;
  let prompt: number | null = null;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: { n_gen?: number; n_prompt?: number; avg_ts?: number };
    try {
      row = JSON.parse(trimmed) as typeof row;
    } catch {
      continue;
    }
    const nGen = row.n_gen ?? 0;
    const nPrompt = row.n_prompt ?? 0;
    const avg = row.avg_ts;
    if (avg === undefined) continue;
    if (gen === null && nGen > 0) gen = avg;
    if (prompt === null && nPrompt > 0 && nGen === 0) prompt = avg;
  }
  return {
    gen_ts: gen === null ? '-1' : String(gen),
    prompt_ts: prompt === null ? '-1' : String(prompt),
  };
}

/**
 * Parse the stderr of `llama-mtmd-cli` for the four timing metrics the
 * vision bench records. Keeps the awk-style "first match wins" behaviour
 * of the shell helper so re-runs inside a single stderr don't clobber
 * earlier values.
 */
export function parseMtmdCliStats(stderr: string): {
  load_ms: string;
  image_encode_ms: string;
  prompt_tps: string;
  gen_tps: string;
} {
  let load: string | null = null;
  let encode: string | null = null;
  let prompt: string | null = null;
  let gen: string | null = null;
  for (const raw of stderr.split('\n')) {
    if (load === null && /load time =/.test(raw)) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s+ms/.exec(raw);
      if (m?.[1]) load = m[1];
    }
    if (encode === null && /image slice encoded in/.test(raw)) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s+ms/.exec(raw);
      if (m?.[1]) encode = m[1];
    }
    if (prompt === null && /prompt eval time =/.test(raw)) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s+tokens per second/.exec(raw);
      if (m?.[1]) prompt = m[1];
    }
    if (gen === null && !/prompt/.test(raw) && /eval time =/.test(raw)) {
      const m = /([0-9]+(?:\.[0-9]+)?)\s+tokens per second/.exec(raw);
      if (m?.[1]) gen = m[1];
    }
  }
  return {
    load_ms: load ?? '0',
    image_encode_ms: encode ?? '0',
    prompt_tps: prompt ?? '',
    gen_tps: gen ?? '',
  };
}

// ---- writers -----------------------------------------------------------

function atomicRewrite(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, body);
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmp, file);
}

interface BenchProfileWrite {
  machine: string;
  rel: string;
  mode: BenchMode;
  ctx: string;
  build: string;
  profile: string;
  gen_ts: string;
  prompt_ts: string;
}

/**
 * Upsert a tuned bench-profile row (keyed by machine+rel+mode+ctx+build),
 * rewriting the file atomically. Also appends a matching bench-history
 * row so the history file remains a strict log of every benchmark run.
 */
export function writeBenchProfile(
  row: BenchProfileWrite,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  const profileFile = benchProfileFile(resolved);
  const updated = formatBenchTimestamp();
  const kept: string[] = [];
  if (existsSync(profileFile)) {
    const raw = readFileSync(profileFile, 'utf8');
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const cols = line.split('\t');
      const drop =
        cols.length >= 9 &&
        cols[0] === row.machine &&
        cols[1] === row.rel &&
        cols[2] === row.mode &&
        cols[3] === row.ctx &&
        cols[4] === row.build;
      if (!drop) kept.push(line);
    }
  }
  kept.push(
    [
      row.machine,
      row.rel,
      row.mode,
      row.ctx,
      row.build,
      row.profile,
      row.gen_ts,
      row.prompt_ts,
      updated,
    ].join('\t'),
  );
  atomicRewrite(profileFile, `${kept.join('\n')}\n`);

  const historyFile = benchHistoryFile(resolved);
  mkdirSync(dirname(historyFile), { recursive: true });
  const historyLine = [
    updated,
    row.machine,
    row.rel,
    row.mode,
    row.ctx,
    row.build,
    row.profile,
    row.gen_ts,
    row.prompt_ts,
    serverProfileArgs(row.profile),
  ].join('\t');
  appendFileSync(historyFile, `${historyLine}\n`);
}

interface BenchVisionWrite {
  machine: string;
  rel: string;
  ctx: string;
  build: string;
  load_ms: string;
  image_encode_ms: string;
  prompt_tps: string;
  gen_tps: string;
}

/**
 * Upsert a vision bench row keyed by machine+rel+build. Unlike the text
 * tuning file, vision records don't carry a `mode` column — the file's
 * existence is the signal that the row represents a real vision-path
 * bench rather than a text throughput bucket.
 */
export function writeBenchVision(
  row: BenchVisionWrite,
  resolved: ResolvedEnv = resolveEnv(),
): void {
  const file = benchVisionFile(resolved);
  const updated = formatBenchTimestamp();
  const kept: string[] = [];
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const cols = line.split('\t');
      const drop =
        cols.length >= 9 &&
        cols[0] === row.machine &&
        cols[1] === row.rel &&
        cols[3] === row.build;
      if (!drop) kept.push(line);
    }
  }
  kept.push(
    [
      row.machine,
      row.rel,
      row.ctx,
      row.build,
      row.load_ms,
      row.image_encode_ms,
      row.prompt_tps,
      row.gen_tps,
      updated,
    ].join('\t'),
  );
  atomicRewrite(file, `${kept.join('\n')}\n`);
}

// ---- reference image -------------------------------------------------

/**
 * Produce a path to a reference image usable by llama-mtmd-cli. When
 * LOCAL_AI_BENCH_IMAGE points at an existing file we trust the user's
 * choice; otherwise we materialise a 1×1 PNG next to the runtime dir
 * so the bench has something valid to encode.
 */
export function resolveReferenceImage(
  resolved: ResolvedEnv = resolveEnv(),
): string {
  const override = resolved.LOCAL_AI_BENCH_IMAGE;
  if (override && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(`LOCAL_AI_BENCH_IMAGE=${override}: file not found`);
    }
    return override;
  }
  const imagePath = join(
    resolved.LOCAL_AI_RUNTIME_DIR,
    'bench-assets',
    'reference-1x1.png',
  );
  if (!existsSync(imagePath)) {
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, Buffer.from(REFERENCE_IMAGE_BASE64, 'base64'));
  }
  return imagePath;
}

// ---- orchestration: bench preset --------------------------------------

export interface BenchPresetOptions {
  target: string;
  mode?: 'auto' | BenchMode;
  onEvent?: (e: BenchEvent) => void;
  runCli?: RunCli;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
}

export interface BenchPresetAttempt {
  profile: string;
  gen_ts: string;
  prompt_ts: string;
  code: number;
  success: boolean;
}

export interface BenchPresetResult {
  rel: string;
  machine: string;
  mode: BenchMode;
  ctx: string;
  build: string;
  bestProfile: string;
  gen_ts: string;
  prompt_ts: string;
  attempts: BenchPresetAttempt[];
}

function compareNumericStrings(a: string, b: string): number {
  const x = Math.round(Number.parseFloat(a));
  const y = Math.round(Number.parseFloat(b));
  if (!Number.isFinite(x) && !Number.isFinite(y)) return 0;
  if (!Number.isFinite(x)) return -1;
  if (!Number.isFinite(y)) return 1;
  return x - y;
}

/**
 * Run `llama-bench` across the three canonical profiles (default,
 * throughput, conservative) for a given rel, pick the fastest by
 * gen_ts (tie-breaking on prompt_ts), and upsert the tuned record.
 * Returns a structured summary with the per-profile attempts so CLI
 * consumers can print a table and Electron can render it.
 */
export async function benchPreset(
  opts: BenchPresetOptions,
): Promise<BenchPresetResult | { error: string }> {
  const resolved = opts.resolved ?? resolveEnv();
  const rel = resolveTarget(opts.target);
  if (!rel) return { error: `Unknown bench target: ${opts.target}` };

  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (!existsSync(modelPath)) {
    return { error: `Model file not found: ${modelPath}` };
  }

  const bin = join(resolved.LLAMA_CPP_BIN, 'llama-bench');
  if (!existsSync(bin)) {
    return { error: `llama-bench binary not found: ${bin}` };
  }

  const modeArg = opts.mode ?? 'auto';
  let mode: BenchMode;
  if (modeArg === 'auto') mode = defaultModeForRel(rel, resolved);
  else if (modeArg === 'text' || modeArg === 'vision') mode = modeArg;
  else return { error: `Unknown bench mode: ${String(modeArg)}` };

  const ctx = ctxForModel(rel, resolved);
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);
  const run = opts.runCli ?? defaultRunCli;

  const attempts: BenchPresetAttempt[] = [];
  let best: BenchPresetAttempt | null = null;

  for (const profile of DEFAULT_PROFILES) {
    opts.onEvent?.({ type: 'profile-start', profile });
    const extra = benchProfileArgs(profile).split(/\s+/).filter(Boolean);
    const args = [
      '-m', modelPath,
      '-pg', '256,64',
      '-r', '1',
      '-ngl', '999',
      ...extra,
      '-o', 'jsonl',
    ];
    opts.onEvent?.({ type: 'start', command: bin, args });
    if (opts.signal?.aborted) {
      return { error: 'Bench preset aborted' };
    }
    const result = await run(bin, args, opts.onEvent, opts.signal);
    if (result.code !== 0) {
      attempts.push({ profile, gen_ts: '-1', prompt_ts: '-1', code: result.code, success: false });
      opts.onEvent?.({ type: 'profile-fail', profile, code: result.code });
      continue;
    }
    const { gen_ts, prompt_ts } = parseBenchJsonlStats(result.stdout);
    const attempt: BenchPresetAttempt = {
      profile,
      gen_ts,
      prompt_ts,
      code: 0,
      success: true,
    };
    attempts.push(attempt);
    opts.onEvent?.({ type: 'profile-done', profile, gen_ts, prompt_ts });

    if (!best) {
      best = attempt;
    } else {
      const genCmp = compareNumericStrings(attempt.gen_ts, best.gen_ts);
      if (genCmp > 0) best = attempt;
      else if (genCmp === 0) {
        const promptCmp = compareNumericStrings(attempt.prompt_ts, best.prompt_ts);
        if (promptCmp > 0) best = attempt;
      }
    }
  }

  if (!best) return { error: `No successful benchmark profiles for ${rel}` };

  writeBenchProfile(
    {
      machine,
      rel,
      mode,
      ctx,
      build,
      profile: best.profile,
      gen_ts: best.gen_ts,
      prompt_ts: best.prompt_ts,
    },
    resolved,
  );

  return {
    rel,
    machine,
    mode,
    ctx,
    build,
    bestProfile: best.profile,
    gen_ts: best.gen_ts,
    prompt_ts: best.prompt_ts,
    attempts,
  };
}

// ---- orchestration: bench vision --------------------------------------

export interface BenchVisionOptions {
  target: string;
  onEvent?: (e: BenchEvent) => void;
  runCli?: RunCli;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
}

export interface BenchVisionResult {
  rel: string;
  machine: string;
  ctx: string;
  build: string;
  mmproj: string;
  image: string;
  load_ms: string;
  image_encode_ms: string;
  prompt_tps: string;
  gen_tps: string;
}

/**
 * Run the real multimodal bench via `llama-mtmd-cli`. Mirrors the
 * shell `llama-bench-vision`: find mmproj + reference image, run one
 * describe-the-image pass, parse timings from stderr, write record.
 * Returns an error shape rather than throwing so the CLI wrapper can
 * translate it into a clean rc=1 message.
 */
export async function benchVision(
  opts: BenchVisionOptions,
): Promise<BenchVisionResult | { error: string }> {
  const resolved = opts.resolved ?? resolveEnv();
  const rel = resolveTarget(opts.target);
  if (!rel) return { error: `Unknown bench target: ${opts.target}` };

  const bin = join(resolved.LLAMA_CPP_BIN, 'llama-mtmd-cli');
  if (!existsSync(bin)) {
    return { error: `llama-mtmd-cli binary not found: ${bin}` };
  }

  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (!existsSync(modelPath)) {
    return { error: `Model file not found: ${modelPath}` };
  }

  const sep = rel.lastIndexOf('/');
  if (sep < 0) return { error: `Invalid rel: ${rel}` };
  const modelDir = join(resolved.LLAMA_CPP_MODELS, rel.slice(0, sep));
  const mmproj = findLocalMmproj(modelDir);
  if (!mmproj) {
    return {
      error: `No mmproj sibling found for ${rel}; vision bench requires a multimodal projector`,
    };
  }

  let image: string;
  try {
    image = resolveReferenceImage(resolved);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const ctx = ctxForModel(rel, resolved);
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);
  const run = opts.runCli ?? defaultRunCli;

  const args = [
    '-m', modelPath,
    '--mmproj', mmproj,
    '--image', image,
    '-p', DEFAULT_PROMPT,
    '-n', '32',
    '-ngl', '999',
    '--no-warmup',
  ];
  opts.onEvent?.({ type: 'start', command: bin, args });
  if (opts.signal?.aborted) {
    return { error: 'Bench vision aborted' };
  }
  const result = await run(bin, args, opts.onEvent, opts.signal);
  if (result.code !== 0) {
    const tail = result.stderr.split('\n').slice(-20).join('\n');
    return { error: `llama-mtmd-cli failed (code=${result.code})\n${tail}` };
  }

  const parsed = parseMtmdCliStats(result.stderr);
  if (!parsed.prompt_tps || !parsed.gen_tps) {
    return {
      error: `Failed to parse timing from llama-mtmd-cli output`,
    };
  }

  writeBenchVision(
    {
      machine,
      rel,
      ctx,
      build,
      load_ms: parsed.load_ms,
      image_encode_ms: parsed.image_encode_ms,
      prompt_tps: parsed.prompt_tps,
      gen_tps: parsed.gen_tps,
    },
    resolved,
  );

  return {
    rel,
    machine,
    ctx,
    build,
    mmproj,
    image,
    load_ms: parsed.load_ms,
    image_encode_ms: parsed.image_encode_ms,
    prompt_tps: parsed.prompt_tps,
    gen_tps: parsed.gen_tps,
  };
}
