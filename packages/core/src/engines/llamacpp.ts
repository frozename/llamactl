import { isAbsolute, resolve, sep } from "node:path";

import type { EngineAdapter, EngineBootEnv, ModelHostSpecForEngine } from "./types.js";

import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

// These flags take a model-file path resolved against the models dir, like -m and --lora.
const DRAFT_MODEL_PATH_FLAGS: ReadonlySet<string> = new Set([
  "-md",
  "--model-draft",
  "--spec-draft-model",
  "--dspark",
]);

const IDLE_SLEEP_FLAG = "--sleep-idle-seconds";

export function hasUnmanagedLlamacppIdleSleep(args: readonly string[]): boolean {
  return args.some((argument, index) => {
    const token = argument.replaceAll("_", "-");
    if (token === IDLE_SLEEP_FLAG) return args[index + 1] !== "-1";
    return token.startsWith(IDLE_SLEEP_FLAG + "=") && token !== IDLE_SLEEP_FLAG + "=-1";
  });
}

export function hasLeadingLlamacppIdleSleepOverride(args: readonly string[]): boolean {
  return args[0]?.replaceAll("_", "-") === IDLE_SLEEP_FLAG && args[1] === "-1";
}

export function hasDraftModelPathArg(args: readonly string[]): boolean {
  return args.some((token) => {
    const [flag = ""] = token.split("=", 1);
    return DRAFT_MODEL_PATH_FLAGS.has(flag);
  });
}

// Absolute draft paths pass through on purpose, matching the issue's "relative" wording.
// Both the separate and the `--flag=value` forms are resolved.
function resolveInlineDraftFlag(
  token: string,
  resolveInModelsDir: (rel: string, label: string) => string,
): string | undefined {
  const eq = token.indexOf("=");
  if (eq === -1) return undefined;
  const name = token.slice(0, eq);
  const value = token.slice(eq + 1);
  if (!DRAFT_MODEL_PATH_FLAGS.has(name) || value === "" || isAbsolute(value)) return undefined;
  return `${name}=${resolveInModelsDir(value, `${name} path`)}`;
}

function resolveDraftModelArgs(
  extraArgs: readonly string[],
  resolveInModelsDir: (rel: string, label: string) => string,
): string[] {
  const out: string[] = [];
  let prev: string | undefined;
  for (const token of extraArgs) {
    if (prev !== undefined && DRAFT_MODEL_PATH_FLAGS.has(prev) && !isAbsolute(token)) {
      out.push(resolveInModelsDir(token, `${prev} path`));
    } else {
      out.push(resolveInlineDraftFlag(token, resolveInModelsDir) ?? token);
    }
    prev = token;
  }
  return out;
}

function modelsDirResolver(modelsDir: string): (rel: string, label: string) => string {
  return (rel: string, label: string): string => {
    const full = resolve(modelsDir, rel);
    if (!full.startsWith(`${resolve(modelsDir)}${sep}`)) {
      throw new Error(`${label} escapes models dir: ${rel}`);
    }
    return full;
  };
}

/**
 * Resolve relative draft-model paths (-md/--model-draft/--spec-draft-model/
 * --dspark, separate or `=` form) against `modelsDir`, refusing escapes.
 * Shared with `startServer` so a manifest path resolves the same way `-m`
 * does (#516).
 */
export function resolveDraftModelPathArgs(
  extraArgs: readonly string[],
  modelsDir: string,
): string[] {
  return resolveDraftModelArgs(extraArgs, modelsDirResolver(modelsDir));
}

export const llamacppEngine: EngineAdapter = {
  name: "llamacpp",

  validateSpec(spec) {
    if (!spec.binary || spec.binary.trim() === "") {
      return { ok: false, error: "llamacpp engine requires spec.binary" };
    }
    if (typeof spec.endpoint.port !== "number") {
      return { ok: false, error: "llamacpp engine requires spec.endpoint.port" };
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

  async prepareLaunch() {
    // No pre-launch preparation required for llama.cpp.
  },

  buildBootCommand(spec: ModelHostSpecForEngine, env: EngineBootEnv) {
    const hostedModel = spec.hostedModels[0];
    if (!hostedModel) {
      throw new Error("hostedModels must have exactly one entry");
    }
    const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS ?? "/tmp/models";
    const resolveInModelsDir = modelsDirResolver(modelsDir);
    const fullModelPath = resolveInModelsDir(hostedModel.rel, "hostedModel rel");
    const args: string[] = [
      "--host",
      spec.endpoint.host,
      "--port",
      String(spec.endpoint.port),
      "-m",
      fullModelPath,
    ];
    if (hostedModel.lora_path) {
      args.push("--lora", resolveInModelsDir(hostedModel.lora_path, "hostedModel lora_path"));
    }
    args.push(...resolveDraftModelArgs(spec.extraArgs, resolveInModelsDir));
    return { binary: spec.binary, args };
  },

  async probeReady(endpoint, timeoutMs, readiness) {
    return await pollUntilModelIds(endpoint, timeoutMs, readiness);
  },

  async teardown(pid, identity) {
    await gracefulShutdown(pid, undefined, identity);
  },
};
