import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  benchHistoryFile,
  benchProfileFile,
  benchVisionFile,
  defaultModeForRel,
  findLatestProfile,
  findLatestVision,
  machineLabel,
  readBenchProfiles,
  readBenchVision,
} from './bench/index.js';
import {
  benchPreset,
  benchVision,
  type BenchEvent,
  type BenchPresetResult,
  type BenchVisionResult,
  type RunCli,
} from './bench/runner.js';
import { resolveBuildId } from './build.js';
import { findByRel } from './catalog.js';
import { ctxForModel } from './ctx.js';
import { resolveEnv } from './env.js';
import { findLocalMmprojForRel } from './mmproj.js';
import type { ResolvedEnv } from './types.js';

function envFlagEnabled(raw: string | undefined, defaultOn: boolean): boolean {
  const value = raw ?? (defaultOn ? 'true' : 'false');
  switch (value) {
    case '0':
    case 'false':
    case 'FALSE':
    case 'no':
    case 'NO':
    case 'off':
    case 'OFF':
      return false;
    default:
      return true;
  }
}

/** Whether auto-tune after pull is enabled (LLAMA_CPP_AUTO_TUNE_ON_PULL). */
export function autoTuneEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envFlagEnabled(env.LLAMA_CPP_AUTO_TUNE_ON_PULL, true);
}

/** Whether auto vision bench after pull is enabled (LLAMA_CPP_AUTO_BENCH_VISION). */
export function autoVisionBenchEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envFlagEnabled(env.LLAMA_CPP_AUTO_BENCH_VISION, true);
}

export interface MaybeTuneAfterPullOptions {
  rel: string;
  /** Only run when the model was absent before the pull. */
  wasMissing: boolean;
  onEvent?: (e: BenchEvent) => void;
  runCli?: RunCli;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface MaybeTuneSkipReason {
  kind:
    | 'not-missing'
    | 'auto-tune-disabled'
    | 'bench-binary-missing'
    | 'profile-exists'
    | 'error';
  message: string;
}

export interface MaybeVisionSkipReason {
  kind:
    | 'auto-vision-disabled'
    | 'mtmd-binary-missing'
    | 'not-multimodal'
    | 'no-mmproj'
    | 'record-exists'
    | 'error';
  message: string;
}

export interface MaybeTuneAfterPullResult {
  preset:
    | { ran: true; result: BenchPresetResult }
    | { ran: false; reason: MaybeTuneSkipReason };
  vision:
    | { ran: true; result: BenchVisionResult }
    | { ran: false; reason: MaybeVisionSkipReason };
}

/**
 * Orchestrate the post-pull auto-tune flow that used to live in zsh
 * (`_llama_maybe_tune_after_pull` + `_llama_maybe_vision_bench_after_pull`):
 *
 *   1. Skip when the model was already on disk before the pull.
 *   2. Skip when `LLAMA_CPP_AUTO_TUNE_ON_PULL` is disabled.
 *   3. Skip when `llama-bench` is missing.
 *   4. Skip when a tuned record already exists for (machine, rel, mode,
 *      ctx, build).
 *   5. Otherwise run `benchPreset` and, when the model is multimodal
 *      with a local mmproj and `llama-mtmd-cli` is available, run
 *      `benchVision` too (unless auto-vision is disabled or a record
 *      already exists).
 *
 * Returns a structured report so both the CLI and Electron UI can
 * surface exactly what ran, or why it didn't.
 */
export async function maybeTuneAfterPull(
  opts: MaybeTuneAfterPullOptions,
): Promise<MaybeTuneAfterPullResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);

  if (!opts.wasMissing) {
    return {
      preset: { ran: false, reason: { kind: 'not-missing', message: 'Model was already on disk' } },
      vision: { ran: false, reason: { kind: 'auto-vision-disabled', message: 'Not evaluated (preset skipped)' } },
    };
  }

  if (!autoTuneEnabled(env)) {
    return {
      preset: {
        ran: false,
        reason: { kind: 'auto-tune-disabled', message: 'LLAMA_CPP_AUTO_TUNE_ON_PULL=off' },
      },
      vision: { ran: false, reason: { kind: 'auto-vision-disabled', message: 'Not evaluated' } },
    };
  }

  const benchBin = join(resolved.LLAMA_CPP_BIN, 'llama-bench');
  if (!existsSync(benchBin)) {
    return {
      preset: {
        ran: false,
        reason: {
          kind: 'bench-binary-missing',
          message: `llama-bench binary not found: ${benchBin}`,
        },
      },
      vision: { ran: false, reason: { kind: 'auto-vision-disabled', message: 'Not evaluated' } },
    };
  }

  const mode = defaultModeForRel(opts.rel, resolved);
  const ctx = ctxForModel(opts.rel, resolved);
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);

  const profileRows = readBenchProfiles(benchProfileFile(resolved));
  const existing = findLatestProfile(profileRows, {
    machine,
    rel: opts.rel,
    mode,
    ctx,
    build,
  });
  if (existing) {
    return {
      preset: {
        ran: false,
        reason: {
          kind: 'profile-exists',
          message: `Tuned launch profile already exists for ${opts.rel} (mode=${mode} ctx=${ctx} build=${build})`,
        },
      },
      vision: { ran: false, reason: { kind: 'auto-vision-disabled', message: 'Not evaluated' } },
    };
  }

  const presetOut = await benchPreset({
    target: opts.rel,
    mode,
    onEvent: opts.onEvent,
    runCli: opts.runCli,
    resolved,
    signal: opts.signal,
  });
  if ('error' in presetOut) {
    return {
      preset: {
        ran: false,
        reason: {
          kind: 'error',
          message: presetOut.error,
        },
      },
      vision: { ran: false, reason: { kind: 'auto-vision-disabled', message: 'Not evaluated' } },
    };
  }

  // Preset succeeded; now consider vision.
  const vision = await maybeVisionBenchAfterPull({
    rel: opts.rel,
    machine,
    build,
    onEvent: opts.onEvent,
    runCli: opts.runCli,
    resolved,
    env,
    signal: opts.signal,
  });

  return {
    preset: { ran: true, result: presetOut },
    vision,
  };
}

interface MaybeVisionArgs {
  rel: string;
  machine: string;
  build: string;
  onEvent?: (e: BenchEvent) => void;
  runCli?: RunCli;
  resolved: ResolvedEnv;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

async function maybeVisionBenchAfterPull(
  args: MaybeVisionArgs,
): Promise<MaybeTuneAfterPullResult['vision']> {
  if (!autoVisionBenchEnabled(args.env)) {
    return {
      ran: false,
      reason: { kind: 'auto-vision-disabled', message: 'LLAMA_CPP_AUTO_BENCH_VISION=off' },
    };
  }
  const mtmdBin = join(args.resolved.LLAMA_CPP_BIN, 'llama-mtmd-cli');
  if (!existsSync(mtmdBin)) {
    return {
      ran: false,
      reason: {
        kind: 'mtmd-binary-missing',
        message: `llama-mtmd-cli binary not found: ${mtmdBin}`,
      },
    };
  }
  const entry = findByRel(args.rel);
  if (entry?.class !== 'multimodal') {
    return {
      ran: false,
      reason: {
        kind: 'not-multimodal',
        message: `Skipping vision bench: class is ${entry?.class ?? 'unknown'}`,
      },
    };
  }
  const mmproj = findLocalMmprojForRel(args.resolved.LLAMA_CPP_MODELS, args.rel);
  if (!mmproj) {
    return {
      ran: false,
      reason: {
        kind: 'no-mmproj',
        message: `No local mmproj sibling for ${args.rel}`,
      },
    };
  }
  const visionRows = readBenchVision(benchVisionFile(args.resolved));
  const existing = findLatestVision(visionRows, {
    machine: args.machine,
    rel: args.rel,
    build: args.build,
  });
  if (existing) {
    return {
      ran: false,
      reason: {
        kind: 'record-exists',
        message: `Vision bench record already exists for ${args.rel} (machine=${args.machine} build=${args.build})`,
      },
    };
  }

  const out = await benchVision({
    target: args.rel,
    onEvent: args.onEvent,
    runCli: args.runCli,
    resolved: args.resolved,
    signal: args.signal,
  });
  if ('error' in out) {
    return { ran: false, reason: { kind: 'error', message: out.error } };
  }
  return { ran: true, result: out };
}

// Keep the history file reachable for the callers who want to surface
// its path in the CLI summary without re-importing store.
export { benchHistoryFile };
