// libosmos engine adapter for osmos-api (mrsirg97-rgb/libosmos v0.5.5
// @934b51b9). The llamactl proxy does NOT sanitise sampling params yet:
// osmos-api decodes greedily only and returns a 400 for temperature != 0
// or top_p != 1 (tools/api/request.c); stop and n are constrained too, so
// clients and the bench harness must send greedy requests. The endpoint
// host must be exactly 127.0.0.1: osmos-api binds IPv4 via inet_pton, and
// llamactl's state validator and bind gate accept no other IPv4 loopback.

import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type {
  EngineAdapter,
  EngineBootEnv,
  ModelHostReadiness,
  ModelHostSpecForEngine,
} from "./types.js";

import { resolveEnv } from "../env.js";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "../safe-fs.js";
import { ensureWorkloadRuntimeDir } from "../workloadRuntime.js";
import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";

const OWNED_FLAGS = new Set(["--config", "--host", "--port", "--engine"]);
const OS_FLAGS = new Set([
  "--picks",
  "--dspark",
  "--budget",
  "--max-context",
  "--parallel",
  "--max-tokens",
  "--no-guess",
]);
const OS_FLAG_PREFIX = "--";
const OS_ID_PREFIX = "osmos-";
const INT_FLAG_RE = /^[1-9]\d*$/;
const INT_MAX = 10_000_000;
const PACK_MAX_BYTES = 63;
const OS_READINESS: ModelHostReadiness = {
  path: "/health",
  expectStatus: 200,
  expectJson: { status: "ok" },
};

interface ParsedOsArgs {
  picks?: string;
  dspark?: string;
  budget?: string;
  maxContext?: string;
  parallel?: string;
  maxTokens?: string;
  noGuess?: boolean;
}

type ParseStep = { ok: true; consumed: boolean } | { ok: false; message: string };
type ParseOutcome = { ok: true; args: ParsedOsArgs } | { ok: false; message: string };

function runtimeHome(env: EngineBootEnv): string {
  if (env.workloadName) {
    const runtime = env.LLAMACTL_RUNTIME_DIR
      ? join(env.LLAMACTL_RUNTIME_DIR, "workloads", env.workloadName)
      : ensureWorkloadRuntimeDir(resolveEnv(), { name: env.workloadName });
    return join(runtime, ".osmos");
  }
  return join(env.LLAMACTL_RUNTIME_DIR ?? resolveEnv().LOCAL_AI_RUNTIME_DIR, ".osmos");
}

function splitToken(raw: string): { token: string; hasInline: boolean; inline: string } {
  const eq = raw.indexOf("=");
  if (eq === -1) return { token: raw, hasInline: false, inline: "" };
  return { token: raw.slice(0, eq), hasInline: true, inline: raw.slice(eq + 1) };
}

function refusalKind(token: string): "owned" | "unsanctioned" | null {
  if (OWNED_FLAGS.has(token)) return "owned";
  if (
    token === "--overlay" ||
    token === "-m" ||
    token.startsWith("--model") ||
    token.startsWith("--eos") ||
    token.startsWith("--temperature")
  ) {
    return "unsanctioned";
  }
  return null;
}

function assignOsValue(parsed: ParsedOsArgs, name: string, value: string): void {
  switch (name) {
    case "picks":
      parsed.picks = value;
      break;
    case "dspark":
      parsed.dspark = value;
      break;
    case "budget":
      parsed.budget = value;
      break;
    case "max-context":
      parsed.maxContext = value;
      break;
    case "parallel":
      parsed.parallel = value;
      break;
    case "max-tokens":
      parsed.maxTokens = value;
      break;
  }
}

function applyOsFlag(
  token: string,
  name: string,
  hasInline: boolean,
  inline: string,
  next: string | undefined,
  parsed: ParsedOsArgs,
): ParseStep {
  if (name === "no-guess") {
    if (hasInline) return { ok: false, message: `malformed flag: ${token}` };
    parsed.noGuess = true;
    return { ok: true, consumed: false };
  }
  const value = hasInline ? inline : next;
  if (value === undefined) return { ok: false, message: `malformed flag: ${token}` };
  assignOsValue(parsed, name, value);
  return { ok: true, consumed: !hasInline };
}

function parseArg(
  extraArgs: readonly string[],
  index: number,
  parsed: ParsedOsArgs,
  seen: Set<string>,
): ParseStep {
  const raw = extraArgs[index];
  if (raw === undefined) return { ok: true, consumed: false };
  const { token, hasInline, inline } = splitToken(raw);
  const refusal = refusalKind(token);
  if (refusal === "owned") return { ok: false, message: `refused flag: ${token}` };
  if (refusal === "unsanctioned") {
    return { ok: false, message: `not an osmos-api setting: ${token}` };
  }
  if (!token.startsWith(OS_FLAG_PREFIX)) {
    return { ok: false, message: `not an osmos-api setting: ${raw}` };
  }
  if (!OS_FLAGS.has(token)) {
    return { ok: false, message: `not an osmos-api setting: ${token}` };
  }
  const name = token.slice(OS_FLAG_PREFIX.length);
  if (seen.has(name)) return { ok: false, message: `duplicate flag: ${token}` };
  seen.add(name);
  return applyOsFlag(token, name, hasInline, inline, extraArgs[index + 1], parsed);
}

function parseExtraArgs(extraArgs: readonly string[]): ParseOutcome {
  const parsed: ParsedOsArgs = {};
  const seen = new Set<string>();
  let skipNext = false;
  for (const index of extraArgs.keys()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const step = parseArg(extraArgs, index, parsed, seen);
    if (!step.ok) return { ok: false, message: step.message };
    skipNext = step.consumed;
  }
  return { ok: true, args: parsed };
}

function osIntError(flag: string, value: string): string | null {
  if (!INT_FLAG_RE.test(value) || Number(value) > INT_MAX) {
    return `${flag} value must be an integer between 1 and ${String(INT_MAX)}`;
  }
  return null;
}

function budgetError(value: string | undefined): string | null {
  if (value === undefined || value === "auto") return null;
  const gib = Number(value);
  return Number.isFinite(gib) && gib > 0
    ? null
    : '--budget value must be a positive number or "auto"';
}

function validateOsValues(args: ParsedOsArgs): string | null {
  if (args.maxContext === undefined) return "--max-context is required";
  const ints: [string, string | undefined][] = [
    ["--max-context", args.maxContext],
    ["--parallel", args.parallel],
    ["--max-tokens", args.maxTokens],
  ];
  for (const [flag, value] of ints) {
    if (value !== undefined) {
      const error = osIntError(flag, value);
      if (error !== null) return error;
    }
  }
  return budgetError(args.budget);
}

function parseAndValidate(extraArgs: readonly string[]): ParseOutcome {
  const outcome = parseExtraArgs(extraArgs);
  if (!outcome.ok) return outcome;
  const error = validateOsValues(outcome.args);
  return error === null ? outcome : { ok: false, message: error };
}

function resolveAssetPath(modelsDir: string, value: string, flag: string): string {
  if (isAbsolute(value)) return value;
  const root = resolve(modelsDir);
  const resolved = resolve(root, value);
  if (!resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`${flag} path escapes models dir: ${value}`);
  }
  return resolved;
}

function resolveModelFile(modelsDir: string, rel: string): string {
  const root = resolve(modelsDir);
  const fullPath = resolve(root, rel);
  if (!fullPath.startsWith(`${root}${sep}`)) {
    throw new Error(`hostedModel rel escapes models dir: ${rel}`);
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new Error(`libosmos requires an existing model file: ${rel}`);
  }
  return fullPath;
}

function budgetKey(args: ParsedOsArgs): [string, number] | null {
  if (args.budget === undefined || args.budget === "auto") return null;
  const gib = Number(args.budget);
  return [args.dspark !== undefined ? "drafted_budget_gib" : "budget_gib", gib];
}

function buildOsmosConfig(
  args: ParsedOsArgs,
  modelsDir: string,
  modelRel: string,
  fullPath: string,
): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    pack: basename(modelRel, ".gguf"),
    model: fullPath,
  };
  if (args.picks !== undefined) {
    cfg["picks"] = resolveAssetPath(modelsDir, args.picks, "--picks");
  }
  if (args.dspark !== undefined) {
    cfg["drafter"] = resolveAssetPath(modelsDir, args.dspark, "--dspark");
  }
  const budget = budgetKey(args);
  if (budget !== null) {
    const [key, gib] = budget;
    cfg[key] = gib;
  }
  cfg["max_context"] = Number(args.maxContext);
  if (args.parallel !== undefined) cfg["parallel"] = Number(args.parallel);
  if (args.maxTokens !== undefined) cfg["max_tokens"] = Number(args.maxTokens);
  if (args.noGuess === true) cfg["no_guess"] = true;
  return cfg;
}

function writeOsmosJson(spec: ModelHostSpecForEngine, bootEnv: EngineBootEnv): void {
  const modelsDir = bootEnv.LLAMACTL_MODELS_DIR ?? bootEnv.LLAMA_CPP_MODELS;
  if (!modelsDir) {
    throw new Error("libosmos requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS");
  }
  const parsed = parseAndValidate(spec.extraArgs);
  if (!parsed.ok) throw new Error(`libosmos: ${parsed.message}`);

  const model = spec.hostedModels[0];
  if (model === undefined) throw new Error("hostedModels must have exactly one entry");
  const fullPath = resolveModelFile(modelsDir, model.rel);

  const home = runtimeHome(bootEnv);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);

  const cfg = buildOsmosConfig(parsed.args, modelsDir, model.rel, fullPath);
  const configPath = join(home, "osmos.json");
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

export const libosmosEngine: EngineAdapter = {
  name: "libosmos",

  validateSpec(spec) {
    if (
      !isAbsolute(spec.binary) ||
      basename(spec.binary) !== "osmos-api" ||
      !existsSync(spec.binary)
    ) {
      return {
        ok: false,
        error: "libosmos engine requires an existing absolute binary named osmos-api",
      };
    }
    if (spec.endpoint.host !== "127.0.0.1") {
      return { ok: false, error: "libosmos requires 127.0.0.1 endpoint" };
    }
    if (!Number.isFinite(spec.endpoint.port)) {
      return { ok: false, error: "libosmos requires a numeric endpoint port" };
    }
    if (spec.hostedModels.length !== 1) {
      return { ok: false, error: "libosmos hostedModels must have exactly one entry" };
    }
    const model = spec.hostedModels[0];
    if (model === undefined) {
      return { ok: false, error: "libosmos requires a hosted model" };
    }
    if (model.lora_path || model.dflash) {
      return {
        ok: false,
        error: "libosmos does not support LoRA or dflash settings",
      };
    }
    const base = basename(model.rel);
    if (!base.endsWith(".gguf")) {
      return { ok: false, error: "libosmos requires a .gguf model" };
    }
    const pack = base.slice(0, base.length - ".gguf".length);
    if (pack === "" || Buffer.byteLength(pack, "utf8") > PACK_MAX_BYTES) {
      return { ok: false, error: "libosmos model pack must be 1-63 bytes" };
    }
    const parsed = parseAndValidate(spec.extraArgs);
    if (!parsed.ok) return { ok: false, error: parsed.message };
    return { ok: true };
  },

  prepareLaunch(spec, env) {
    return Promise.resolve().then(() => {
      writeOsmosJson(spec, env);
    });
  },

  buildBootCommand(spec, env) {
    return {
      binary: spec.binary,
      args: [
        "--config",
        join(runtimeHome(env), "osmos.json"),
        "--host",
        spec.endpoint.host,
        "--port",
        String(spec.endpoint.port),
      ],
    };
  },

  async probeReady(endpoint, timeoutMs, readiness) {
    const result = await pollUntilModelIds(endpoint, timeoutMs, readiness ?? OS_READINESS);
    return {
      ready: result.ready,
      modelIds: result.modelIds.map((id) =>
        id.startsWith(OS_ID_PREFIX) ? `${id.slice(OS_ID_PREFIX.length)}.gguf` : id,
      ),
    };
  },

  async teardown(pid, identity) {
    await gracefulShutdown(pid, undefined, identity);
  },
};
