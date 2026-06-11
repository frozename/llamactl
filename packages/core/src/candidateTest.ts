import { existsSync } from "node:fs";
import { join } from "node:path";

import type { BenchCompareRow } from "./bench/compare.js";
import type { BenchMode, ResolvedEnv } from "./types.js";

import { autoVisionBenchEnabled } from "./autotune.js";
import {
  benchCompare,
  benchHistoryFile,
  benchProfileFile,
  benchVisionFile,
  defaultModeForRel,
  findLatestProfile,
  findLatestVision,
  machineLabel,
  readBenchProfiles,
  readBenchVision,
} from "./bench/index.js";
import {
  type BenchEvent,
  benchPreset,
  type BenchPresetResult,
  benchVision,
  type BenchVisionResult,
  type RunCli,
} from "./bench/runner.js";
import { resolveBuildId } from "./build.js";
import { findByRel, relFromRepoAndFile } from "./catalog.js";
import { addCurated } from "./catalogWriter.js";
import { ctxForModel } from "./ctx.js";
import { resolveEnv } from "./env.js";
import { findLocalMmprojForRel } from "./mmproj.js";
import {
  pickCandidateFile,
  type PullEvent,
  type PullFileResult,
  pullRepoFile,
  type RunHf,
} from "./pull.js";

export type CandidateTestEvent = PullEvent | BenchEvent;

export interface CandidateTestOptions {
  repo: string;
  file?: string;
  profile?: string;
  onEvent?: (e: CandidateTestEvent) => void;
  runHf?: RunHf;
  runCli?: RunCli;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface CandidateTestStep<T> {
  ran: boolean;
  reason?: string;
  result?: T;
}

export interface CandidateTestResult {
  repo: string;
  file: string;
  rel: string;
  machine: string;
  mode: "text" | "vision";
  ctx: string;
  build: string;
  curatedAdded: boolean;
  pull: PullFileResult;
  preset: CandidateTestStep<BenchPresetResult>;
  vision: CandidateTestStep<BenchVisionResult>;
  compare: BenchCompareRow[];
}

interface BenchProfileKey {
  machine: string;
  rel: string;
  mode: BenchMode;
  ctx: string;
  build: string;
}

/**
 * Step 4 of `candidateTest`: run `benchPreset` unless the binary is
 * missing or a tuned record already covers the key. A bench failure
 * short-circuits the composite flow via the `error` shape.
 */
async function runPresetStep(
  opts: CandidateTestOptions,
  resolved: ResolvedEnv,
  key: BenchProfileKey,
): Promise<CandidateTestStep<BenchPresetResult> | { error: string }> {
  const benchBin = join(resolved.LLAMA_CPP_BIN, "llama-bench");
  if (!existsSync(benchBin)) {
    return { ran: false, reason: `llama-bench binary not found: ${benchBin}` };
  }

  const profileRows = readBenchProfiles(benchProfileFile(resolved));
  const existing = findLatestProfile(profileRows, key);
  if (existing) {
    return {
      ran: false,
      reason: `Reusing tuned profile for ${key.rel} (mode=${key.mode} ctx=${key.ctx} build=${key.build})`,
    };
  }

  const out = await benchPreset({
    target: key.rel,
    mode: key.mode,
    onEvent: opts.onEvent,
    runCli: opts.runCli,
    resolved,
    signal: opts.signal,
  });
  if ("error" in out) return { error: out.error };
  return { ran: true, result: out };
}

interface VisionStepContext {
  rel: string;
  machine: string;
  build: string;
  entryClass: "multimodal" | "reasoning" | "general" | "custom" | undefined;
  localMmproj: string | null;
}

/**
 * Step 5 of `candidateTest`: run `benchVision` when the rel is
 * multimodal, the binary + mmproj are present, vision-auto is on, and
 * no existing record covers (machine, rel, build). Vision errors are
 * reported as a skip reason rather than short-circuiting the flow.
 */
async function runVisionStep(
  opts: CandidateTestOptions,
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv,
  ctx: VisionStepContext,
): Promise<CandidateTestStep<BenchVisionResult>> {
  // Catalog class can lag the runtime signal: a freshly-pulled rel may
  // have its mmproj sibling on disk before the classifier knows it's
  // multimodal (e.g. HF model_info `pipeline_tag` empty for new
  // releases, or the qwen-→-reasoning heuristic firing on Qwen 3.6
  // before its multimodal status is reflected in HF metadata). Treat
  // presence of a local mmproj as authoritative — if the projector is
  // on disk, vision benches can run.
  const isMultimodal = ctx.entryClass === "multimodal" || ctx.localMmproj !== null;
  if (!isMultimodal) {
    return { ran: false, reason: `Not multimodal (class=${ctx.entryClass ?? "unknown"})` };
  }

  const mtmdBin = join(resolved.LLAMA_CPP_BIN, "llama-mtmd-cli");
  if (!existsSync(mtmdBin)) {
    return { ran: false, reason: `llama-mtmd-cli binary not found: ${mtmdBin}` };
  }
  if (!autoVisionBenchEnabled(env)) {
    return { ran: false, reason: "LLAMA_CPP_AUTO_BENCH_VISION=off" };
  }
  if (!ctx.localMmproj) {
    return { ran: false, reason: `No local mmproj sibling for ${ctx.rel}` };
  }

  const visionRows = readBenchVision(benchVisionFile(resolved));
  const existing = findLatestVision(visionRows, {
    machine: ctx.machine,
    rel: ctx.rel,
    build: ctx.build,
  });
  if (existing) {
    return { ran: false, reason: `Reusing vision bench record for ${ctx.rel}` };
  }

  const out = await benchVision({
    target: ctx.rel,
    onEvent: opts.onEvent,
    runCli: opts.runCli,
    resolved,
    signal: opts.signal,
  });
  if ("error" in out) {
    return { ran: false, reason: out.error };
  }
  return { ran: true, result: out };
}

/**
 * Composite flow that mirrors the shell `llama-candidate-test`:
 *
 *   1. Resolve the candidate file (HF picker or caller override).
 *   2. Ensure a curated catalog entry exists, marking new rels as
 *      `candidate` scope so future uninstalls don't need --force.
 *   3. Pull the file + mmproj sibling.
 *   4. If `llama-bench` is available and no tuned record exists for
 *      the (machine, rel, mode, ctx, build) key, run `benchPreset`.
 *   5. For multimodal rels with a local mmproj, `llama-mtmd-cli`, and
 *      vision-auto-enabled, run `benchVision` when no existing record
 *      covers (machine, rel, build).
 *   6. Return a compare table filtered to the rel's class so the
 *      caller can print a ranked view alongside the existing catalog.
 *
 * Errors from any step short-circuit and are returned in the `error`
 * shape. Individual sub-step skips (e.g. reused tuned record) are
 * surfaced via `reason` strings on the step objects.
 */
export async function candidateTest(
  opts: CandidateTestOptions,
): Promise<CandidateTestResult | { error: string }> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);

  const pick = await pickCandidateFile({
    repo: opts.repo,
    file: opts.file,
    profile: opts.profile,
    resolved,
  });
  if (!pick) return { error: `Unable to resolve a candidate file for ${opts.repo}` };

  const rel = relFromRepoAndFile(opts.repo, pick.file);
  let curatedAdded = false;
  if (!findByRel(rel)) {
    const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.gguf$/i, "");
    const addRes = await addCurated({
      repo: opts.repo,
      fileOrRel: pick.file,
      label: base,
      scope: "candidate",
    });
    if (!addRes.ok) return { error: addRes.error };
    curatedAdded = true;
  }

  const pulled = await pullRepoFile({
    repo: opts.repo,
    file: pick.file,
    onEvent: opts.onEvent,
    runHf: opts.runHf,
    resolved,
    signal: opts.signal,
  });
  if (pulled.code !== 0) {
    return { error: `Pull failed (code=${String(pulled.code)}) for ${rel}` };
  }

  const mode = defaultModeForRel(rel, resolved);
  const ctx = ctxForModel(rel, resolved);
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);

  // --- preset ------------------------------------------------------------
  const preset = await runPresetStep(opts, resolved, { machine, rel, mode, ctx, build });
  if ("error" in preset) return { error: preset.error };

  // --- vision ------------------------------------------------------------
  const entry = findByRel(rel);
  const localMmproj = findLocalMmprojForRel(resolved.LLAMA_CPP_MODELS, rel);
  const vision = await runVisionStep(opts, resolved, env, {
    rel,
    machine,
    build,
    entryClass: entry?.class,
    localMmproj,
  });

  const compare = benchCompare({ classFilter: entry?.class ?? "all", scopeFilter: "all" }, env);

  return {
    repo: opts.repo,
    file: pick.file,
    rel,
    machine,
    mode,
    ctx,
    build,
    curatedAdded,
    pull: pulled,
    preset,
    vision,
    compare,
  };
}

// Re-export for consumers who want to surface the history file path in
// their summary output (matches the pattern in autotune.ts).
export { benchHistoryFile };
