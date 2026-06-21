import { basename, dirname, join, resolve, sep } from "node:path";

import type { EngineAdapter, EngineBootEnv, ModelHostSpecForEngine } from "./types.js";

import { resolveEnv } from "../env.js";
import { defaultOmlxMemoryGiBForProfile } from "../profile.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "../safe-fs.js";
import { ensureWorkloadRuntimeDir } from "../workloadRuntime.js";
import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

function omxBasePath(env: EngineBootEnv, workloadName: string): string {
  if (env.LLAMACTL_RUNTIME_DIR) {
    return join(env.LLAMACTL_RUNTIME_DIR, "workloads", workloadName, ".omlx");
  }
  const resolved = resolveEnv();
  return join(ensureWorkloadRuntimeDir(resolved, { name: workloadName }), ".omlx");
}

// Per-workload isolated model dir: contains a single symlink pointing at the
// declared hostedModel. Used as oMLX's `--model-dir` so each ModelHost process
// only sees its own model on the Metal command queue.
//
// Background: oMLX's batched engine fuses concurrent requests into single
// forward passes. When ONE oMLX process serves MULTIPLE models, the Metal
// command buffers encode work that crosses model boundaries and exceeds
// Apple's GPU watchdog (~5 s) on small GPUs (validated on mac-mini M4 base
// 2026-05-21: 3 hot 8B-class MLX models, mcr=1 was the only safe setting).
// Splitting into N processes — one per model — eliminates the cross-model
// context switching at the OS level and unlocks mcr=4 with zero errors.
//
// The schema already constrains hostedModels to exactly one entry, so this
// matches the intended single-model-per-ModelHost contract.
function isolatedModelDir(basePath: string): string {
  return join(basePath, "models");
}

function ensureIsolatedModelSymlink(
  isolatedDir: string,
  modelsDir: string,
  hostedRel: string,
): void {
  const sourceModelsDir = resolve(modelsDir);
  const source = resolve(sourceModelsDir, hostedRel);
  if (!source.startsWith(`${sourceModelsDir}${sep}`)) {
    throw new Error(`hostedModel rel escapes models dir: ${hostedRel}`);
  }
  mkdirSync(isolatedDir, { recursive: true });
  const target = join(isolatedDir, basename(hostedRel));
  // Re-create the symlink each time to recover from a stale or broken link.
  try {
    lstatSync(target);
    unlinkSync(target);
  } catch {
    /* not present — fine */
  }
  symlinkSync(source, target);
}

function writeAtomicJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function buildDflashModelSettings(spec: ModelHostSpecForEngine): Record<string, unknown> | null {
  const hostedModel = spec.hostedModels[0];
  const dflash = hostedModel?.dflash;
  if (dflash?.enabled !== true) return null;
  const settings: Record<string, unknown> = { dflash_enabled: dflash.dflash_enabled ?? true };
  for (const [key, value] of Object.entries(dflash)) {
    if (key === "enabled") continue;
    settings[key] = value;
  }
  return settings;
}

export const omlxEngine: EngineAdapter = {
  name: "omlx",

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === "") {
      return { ok: false, error: "omlx engine requires spec.binary (no PATH fallback)" };
    }
    if (!existsSync(spec.binary)) {
      return {
        ok: false,
        error: `omlx binary not found at ${spec.binary}; run tools/install-omlx-from-source.sh`,
      };
    }
    if (typeof spec.endpoint.port !== "number") {
      return { ok: false, error: "omlx engine requires spec.endpoint.port" };
    }
    if (!LOOPBACK.has(spec.endpoint.host)) {
      return {
        ok: false,
        error: `endpoint.host must be loopback or 0.0.0.0; got ${spec.endpoint.host}`,
      };
    }
    if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
      return { ok: false, error: "hostedModels must have exactly one entry" };
    }
    return { ok: true };
  },

  // eslint-disable-next-line @typescript-eslint/require-await -- EngineAdapter prepare hook is async; oMLX setup is synchronous today.
  async prepareLaunch(spec: ModelHostSpecForEngine, env: EngineBootEnv) {
    const hostedModel = spec.hostedModels[0];
    if (!hostedModel) {
      throw new Error("hostedModels must have exactly one entry");
    }
    const workloadName = env.workloadName;
    if (workloadName) {
      const basePath = omxBasePath(env, workloadName);
      const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS;
      if (!modelsDir) {
        throw new Error(
          "omlx prepareLaunch requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS in the boot env — otherwise the per-workload isolated symlink targets a path that does not exist and oMLX serves /v1/models=[] forever",
        );
      }
      ensureIsolatedModelSymlink(isolatedModelDir(basePath), modelsDir, hostedModel.rel);
      const modelSettings = buildDflashModelSettings(spec);
      if (modelSettings) {
        writeAtomicJson(join(basePath, "model_settings.json"), {
          version: 1,
          models: {
            [basename(hostedModel.rel)]: modelSettings,
          },
        });
      }
    }
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: EngineBootEnv) {
    const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS;
    if (!modelsDir) {
      throw new Error(
        "omlx prepareLaunch/buildBootCommand requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS in the boot env — otherwise the per-workload isolated symlink targets a path that does not exist and oMLX serves /v1/models=[] forever",
      );
    }
    const hostedModel = spec.hostedModels[0];
    if (!hostedModel) {
      throw new Error("hostedModels must have exactly one entry");
    }
    const sanitizedModelRel = hostedModel.rel;
    const normalizedModelPath = resolve(modelsDir, sanitizedModelRel);
    if (!normalizedModelPath.startsWith(`${resolve(modelsDir)}${sep}`)) {
      throw new Error(`hostedModel rel escapes models dir: ${sanitizedModelRel}`);
    }
    const workloadName = env.workloadName;
    // Default to the per-workload isolated dir created by prepareLaunch so
    // oMLX only sees the declared hostedModel. Without `workloadName` (e.g.
    // a unit test invoking buildBootCommand without going through the
    // workload runtime) we fall back to the full models dir for back-compat.
    const modelDirArg = workloadName ? isolatedModelDir(omxBasePath(env, workloadName)) : modelsDir;
    const args: string[] = [
      "serve",
      "--model-dir",
      modelDirArg,
      "--host",
      spec.endpoint.host,
      "--port",
      String(spec.endpoint.port),
    ];
    const maxModelMemoryGiB =
      spec.resources?.expectedMemoryGiB ??
      defaultOmlxMemoryGiBForProfile(env.machineProfile ?? "macbook-pro-48g");
    args.push("--max-model-memory", `${String(maxModelMemoryGiB)}GB`);
    const modelSettings = workloadName ? buildDflashModelSettings(spec) : null;
    if (workloadName && modelSettings) {
      const basePath = omxBasePath(env, workloadName);
      args.push("--base-path", basePath);
    }
    args.push(...spec.extraArgs);
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs) {
    return await pollUntilModelIds(endpoint, timeoutMs);
  },

  async teardown(pid) {
    await gracefulShutdown(pid);
  },
};

export function matchHostedModel(rel: string, ids: string[]): boolean {
  return ids.includes(rel) || ids.includes(basename(rel));
}
