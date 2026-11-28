import { createHash } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";

import type {
  EngineAdapter,
  EngineBootEnv,
  ModelHostHostedModel,
  ModelHostSpecForEngine,
  NativeModelActivity,
  NativeModelResidency,
  NativeModelStatusObservation,
} from "./types.js";

import { resolveEnv } from "../env.js";
import { atomicWriteFile } from "../fsAtomic.js";
import { defaultOmlxMemoryGiBForProfile } from "../profile.js";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "../safe-fs.js";
import { ensureWorkloadRuntimeDir } from "../workloadRuntime.js";
import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";
import {
  mergeOmlxModelSettings,
  OMLX_MODEL_SETTINGS_FILE,
  OMLX_MODEL_SETTINGS_VERSION,
  parseOmlxModelSettings,
  renderOmlxModelSettings,
} from "./omlx-model-settings.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

// jundot/omlx server.py list_models_status — pinned native status contract.
export const OMLX_MODELS_STATUS_PATH = "/v1/models/status";
export const OMLX_NATIVE_STATUS_REVISION = "feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b";
export const OMLX_ACTIVITY_PATH = "/api/status";

export function omlxModelActionPath(action: "load" | "unload", modelId: string): string {
  return `/v1/models/${encodeURIComponent(modelId)}/${action}`;
}

export function parseOmlxActivity(body: unknown): NativeModelActivity | null {
  if (!isRecord(body)) {
    return null;
  }
  const activeRequests = body["active_requests"];
  const waitingRequests = body["waiting_requests"];
  if (
    typeof activeRequests !== "number" ||
    !Number.isInteger(activeRequests) ||
    activeRequests < 0
  ) {
    return null;
  }
  if (
    typeof waitingRequests !== "number" ||
    !Number.isInteger(waitingRequests) ||
    waitingRequests < 0
  ) {
    return null;
  }
  return { activeRequests, waitingRequests };
}

function omxBasePath(env: EngineBootEnv, workloadName: string): string {
  if (env.LLAMACTL_RUNTIME_DIR) {
    return join(env.LLAMACTL_RUNTIME_DIR, "workloads", workloadName, ".omlx");
  }
  const resolved = resolveEnv();
  return join(ensureWorkloadRuntimeDir(resolved, { name: workloadName }), ".omlx");
}

function cacheModeBase(base: string, cacheEpoch: number | undefined): string {
  return cacheEpoch === undefined ? base : join(base, "managed-cache");
}

function seedManagedSettings(legacy: string, managed: string): void {
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  if (!lstatSync(managed).isDirectory())
    throw new Error("oMLX managed cache base must be a directory");
  for (const name of ["settings.json", OMLX_MODEL_SETTINGS_FILE]) {
    try {
      copyFileSync(join(legacy, name), join(managed, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "EEXIST")
      )
        throw error;
    }
  }
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
function isolatedModelDir(basePath: string, managedRel?: string): string {
  if (managedRel === undefined) return join(basePath, "models");
  const key = createHash("sha256").update(managedRel).digest("hex");
  return join(basePath, "cache-models", key);
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

function usesWorkloadSettings(
  model: ModelHostHostedModel,
  extraArgs: readonly string[],
  workload: string | undefined,
): boolean {
  if (model.omlx === undefined && model.dflash?.enabled !== true) return false;
  if (!workload) throw new Error("oMLX model settings require a workload name");
  if (extraArgs.some((arg) => arg === "--base-path" || arg.startsWith("--base-path="))) {
    throw new Error("oMLX model settings require the workload's --base-path");
  }
  return true;
}

function dflashSettings(dflash: ModelHostHostedModel["dflash"]): Record<string, unknown> {
  if (dflash?.enabled !== true) return { dflash_enabled: false };
  const { enabled: _enabled, ...settings } = dflash;
  return { ...settings, dflash_enabled: settings.dflash_enabled ?? true };
}

function readSettingsFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function prepareModelSettings(path: string, model: ModelHostHostedModel): string | undefined {
  const existing = readSettingsFile(path);
  const parsed = existing === undefined ? null : parseOmlxModelSettings(existing);
  if (parsed?.ok === false) throw new Error(`oMLX model settings refused: ${parsed.reason}`);
  const document = parsed?.document ?? { version: OMLX_MODEL_SETTINGS_VERSION, models: {} };

  const modelId = basename(model.rel);
  const current = Object.hasOwn(document.models, modelId) ? document.models[modelId] : undefined;
  // The manifest owns dflash_* separately from the ordinary oMLX settings.
  // Retaining a prior DFlash flag can invalidate a new MTP declaration.
  const retained = Object.fromEntries(
    Object.entries(current ?? {}).filter(([key]) => !key.startsWith("dflash_")),
  );
  const models = {
    ...document.models,
    [modelId]: { ...dflashSettings(model.dflash), ...retained },
  };
  const merged = mergeOmlxModelSettings({ ...document, models }, modelId, { ...model.omlx });
  if (!merged.ok) {
    throw new Error(
      `oMLX model settings refused: ${merged.reason} (${merged.conflicts.join(", ")})`,
    );
  }
  const rendered = renderOmlxModelSettings(merged.document);
  return rendered === existing ? undefined : rendered;
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
    const managesSettings = usesWorkloadSettings(hostedModel, spec.extraArgs, workloadName);
    if (workloadName) {
      const legacyBase = omxBasePath(env, workloadName);
      const basePath = cacheModeBase(legacyBase, spec.omlxCacheEpoch);
      if (basePath !== legacyBase) seedManagedSettings(legacyBase, basePath);
      const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS;
      if (!modelsDir) {
        throw new Error(
          "omlx prepareLaunch requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS in the boot env — otherwise the per-workload isolated symlink targets a path that does not exist and oMLX serves /v1/models=[] forever",
        );
      }
      const path = join(basePath, OMLX_MODEL_SETTINGS_FILE);
      const settings = managesSettings ? prepareModelSettings(path, hostedModel) : undefined;
      const modelDir = isolatedModelDir(
        basePath,
        spec.omlxCacheEpoch === undefined ? undefined : hostedModel.rel,
      );
      ensureIsolatedModelSymlink(modelDir, modelsDir, hostedModel.rel);
      if (settings !== undefined) atomicWriteFile(path, settings);
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
    const managesSettings = usesWorkloadSettings(hostedModel, spec.extraArgs, workloadName);
    const basePath = workloadName
      ? cacheModeBase(omxBasePath(env, workloadName), spec.omlxCacheEpoch)
      : undefined;
    const managedCache = spec.omlxCacheEpoch !== undefined;
    if (managedCache && basePath === undefined)
      throw new Error("oMLX cache epoch requires a workload name");
    const modelDirArg =
      basePath === undefined
        ? modelsDir
        : isolatedModelDir(basePath, managedCache ? hostedModel.rel : undefined);
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
    // oMLX replaced --max-model-memory with --memory-guard-gb (a bare GB number,
    // mapped to settings.memory.memory_guard_custom_ceiling_gb). Passing the old
    // flag makes `omlx serve` exit with "unrecognized arguments" and the workload
    // never boots.
    args.push("--memory-guard-gb", String(maxModelMemoryGiB));
    if ((managesSettings || managedCache) && basePath !== undefined)
      args.push("--base-path", basePath);
    args.push(...spec.extraArgs);
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs, readiness) {
    return await pollUntilModelIds(endpoint, timeoutMs, readiness);
  },

  async teardown(pid, identity) {
    await gracefulShutdown(pid, undefined, identity);
  },
};

export function matchHostedModel(rel: string, ids: string[]): boolean {
  return ids.includes(rel) || ids.includes(basename(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

type SizeField = { ok: true; value: number | null } | { ok: false };

function readSize(value: unknown): SizeField {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return { ok: true, value };
  }
  return { ok: false };
}

function findHostedEntry(
  models: unknown[],
  hostedRel: string,
  exactId: string | undefined,
): { entry: Record<string, unknown>; id: string } | "ambiguous" | null {
  let match: { entry: Record<string, unknown>; id: string } | null = null;
  for (const element of models) {
    if (!isRecord(element)) {
      continue;
    }
    const id = element["id"];
    if (
      typeof id !== "string" ||
      (exactId === undefined ? !matchHostedModel(hostedRel, [id]) : id !== exactId)
    ) {
      continue;
    }
    // An exact ID and its basename can both match, even when the IDs are distinct.
    if (match !== null) return "ambiguous";
    match = { entry: element, id };
  }
  return match;
}

function observeEntry(entry: Record<string, unknown>, id: string): NativeModelStatusObservation {
  const loaded = entry["loaded"];
  const isLoading = entry["is_loading"];
  if (typeof loaded !== "boolean" || typeof isLoading !== "boolean") {
    return { state: "failed", reason: "MalformedStatus" };
  }
  const engineType = entry["engine_type"];
  const engineTypeValue = typeof engineType === "string" ? engineType : null;
  if (isLoading) {
    return engineTypeValue !== null
      ? { state: "loading", modelId: id, engineType: engineTypeValue }
      : { state: "loading", modelId: id };
  }
  if (!loaded) {
    return engineTypeValue !== null
      ? { state: "discovered", modelId: id, engineType: engineTypeValue }
      : { state: "discovered", modelId: id };
  }
  const actualSize = readSize(entry["actual_size"]);
  if (!actualSize.ok) {
    return { state: "failed", reason: "MalformedStatus" };
  }
  const residentEstimatedSize = readSize(entry["resident_estimated_size"]);
  if (!residentEstimatedSize.ok) {
    return { state: "failed", reason: "MalformedStatus" };
  }
  return engineTypeValue !== null
    ? {
        state: "loaded",
        modelId: id,
        actualSize: actualSize.value,
        residentEstimatedSize: residentEstimatedSize.value,
        engineType: engineTypeValue,
      }
    : {
        state: "loaded",
        modelId: id,
        actualSize: actualSize.value,
        residentEstimatedSize: residentEstimatedSize.value,
      };
}

// oMLX lists every model it knows about, not just the hosted one, so sibling
// entries are skipped without validation — only the matched entry is observed.
export function parseOmlxModelsStatus(
  body: unknown,
  hostedRel: string,
  exact?: { modelId: string; modelPath: string },
): NativeModelStatusObservation {
  if (!isRecord(body)) {
    return { state: "failed", reason: "MalformedStatus" };
  }
  const models = body["models"];
  if (!isUnknownArray(models)) {
    return { state: "failed", reason: "MalformedStatus" };
  }
  const found = findHostedEntry(models, hostedRel, exact?.modelId);
  if (found === "ambiguous") {
    return {
      state: "failed",
      reason: exact === undefined ? "MalformedStatus" : "IdentityUnverified",
    };
  }
  if (found === null) {
    return {
      state: "failed",
      reason: exact === undefined ? "ModelNotListed" : "IdentityUnverified",
    };
  }
  if (exact !== undefined && found.entry["model_path"] !== exact.modelPath) {
    return { state: "failed", reason: "IdentityUnverified" };
  }
  return observeEntry(found.entry, found.id);
}

export function deriveOmlxResidency(
  observation: NativeModelStatusObservation,
  readinessOk: boolean | undefined,
): NativeModelResidency {
  if (observation.state !== "loaded") {
    return observation;
  }
  return {
    state: readinessOk === false ? "resident" : "ready",
    modelId: observation.modelId,
    actualSize: observation.actualSize,
    residentEstimatedSize: observation.residentEstimatedSize,
  };
}
