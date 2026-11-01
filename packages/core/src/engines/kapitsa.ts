import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { EngineAdapter, EngineBootEnv } from "./types.js";

import { resolveEnv } from "../env.js";
import { existsSync, mkdirSync, statSync } from "../safe-fs.js";
import { ensureWorkloadRuntimeDir } from "../workloadRuntime.js";
import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);
const LAUNCH_FLAGS = new Set([
  "--model",
  "-m",
  "--model-id",
  "--host",
  "--port",
  "--engine",
  "--allow-switch",
  "--split",
]);

function runtimeHome(env: EngineBootEnv): string {
  if (env.workloadName) {
    const runtime = env.LLAMACTL_RUNTIME_DIR
      ? join(env.LLAMACTL_RUNTIME_DIR, "workloads", env.workloadName)
      : ensureWorkloadRuntimeDir(resolveEnv(), { name: env.workloadName });
    return join(runtime, ".kapitsa");
  }
  return join(env.LLAMACTL_RUNTIME_DIR ?? resolveEnv().LOCAL_AI_RUNTIME_DIR, ".kapitsa");
}

export const kapitsaEngine: EngineAdapter = {
  name: "kapitsa",

  validateSpec(spec) {
    if (
      !isAbsolute(spec.binary) ||
      basename(spec.binary) !== "kapitsa" ||
      !existsSync(spec.binary)
    ) {
      return {
        ok: false,
        error: "kapitsa engine requires an existing absolute binary named kapitsa",
      };
    }
    if (typeof spec.endpoint.port !== "number" || !LOOPBACK.has(spec.endpoint.host)) {
      return { ok: false, error: "kapitsa requires a loopback or 0.0.0.0 endpoint with a port" };
    }
    if (spec.hostedModels.length !== 1) {
      return { ok: false, error: "kapitsa hostedModels must have exactly one entry" };
    }
    if (spec.extraArgs.some((arg) => LAUNCH_FLAGS.has(arg.split("=", 1)[0] ?? arg))) {
      return {
        ok: false,
        error:
          "kapitsa extraArgs cannot override the ModelHost model, endpoint, backend, or model switching",
      };
    }
    const model = spec.hostedModels[0];
    if (model?.lora_path || model?.dflash) {
      return {
        ok: false,
        error:
          "kapitsa uses native extraArgs for drafting; hosted LoRA and oMLX dflash settings are unsupported",
      };
    }
    return { ok: true };
  },

  prepareLaunch(_spec, env) {
    // The launcher only exports KAPITSA_HOME; the adapter owns creating it.
    // Kapitsa writes state and caches here during boot, so keep it private.
    mkdirSync(runtimeHome(env), { recursive: true, mode: 0o700 });
    return Promise.resolve();
  },

  buildBootCommand(spec, env) {
    const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS;
    if (!modelsDir) throw new Error("kapitsa requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS");
    const model = spec.hostedModels[0];
    if (!model) throw new Error("hostedModels must have exactly one entry");
    const fullPath = resolve(modelsDir, model.rel);
    if (!fullPath.startsWith(`${resolve(modelsDir)}${sep}`)) {
      throw new Error(`hostedModel rel escapes models dir: ${model.rel}`);
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isDirectory()) {
      throw new Error(`kapitsa requires an existing preconverted model directory: ${model.rel}`);
    }
    return {
      binary: spec.binary,
      args: [
        "serve",
        "--model",
        fullPath,
        "--model-id",
        basename(model.rel),
        "--local",
        "--host",
        spec.endpoint.host,
        "--port",
        String(spec.endpoint.port),
        ...spec.extraArgs,
      ],
      envOverrides: {
        KAPITSA_NO_AUTO_UPDATE: "1",
        KAPITSA_HOME: runtimeHome(env),
      },
    };
  },

  async probeReady(endpoint, timeoutMs, readiness) {
    return await pollUntilModelIds(endpoint, timeoutMs, readiness);
  },

  async teardown(pid, identity) {
    await gracefulShutdown(pid, undefined, identity);
  },
};
