import { execFileSync } from "node:child_process";
import { basename, resolve, sep } from "node:path";

import type { PidIdentityDeps, PidVerdict, SignalIdentity } from "../pidIdentity.js";
import type {
  EngineAdapter,
  EngineBootEnv,
  ModelHostHostedModel,
  ModelHostSpecForEngine,
} from "./types.js";

import {
  isProcessAlive,
  processCommand as realProcessCommand,
  verifyPidFile,
} from "../pidIdentity.js";
import { existsSync, readFileSync } from "../safe-fs.js";
import { gracefulShutdown, pollUntilModelIds } from "./lifecycle.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

const ENGINE_GRACE_MS = 60_000;
const ENGINE_EXIT_TIMEOUT_MS = 180_000;
const ENGINE_POLL_MS = 1_000;

// The Strata server is launched via a symlink named strata-server pointing at
// a Python interpreter; llamactl identifies a running host by argv0 basename,
// so the symlink name is the only handle we get.
const BINARY_BASENAME = "strata-server";
const SERVE_TOKEN = "--serve";

interface ValidationResult {
  ok: true;
}

interface ValidationFailure {
  ok: false;
  error: string;
}

type Validation = ValidationResult | ValidationFailure;

function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

function flagValue(args: readonly string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx === -1 ? null : (args[idx + 1] ?? null);
}

function hasEngineFlagPair(args: readonly string[]): boolean {
  const idx = args.indexOf("--engine");
  return idx !== -1 && args[idx + 1] === "strata";
}

// A child belongs to the engine only if `--serve` is a standalone argv token;
// a substring match would also capture `--server`, `--server-foo`, and a path
// that happens to embed `--serve`.
function hasServeToken(cmd: string | null): boolean {
  if (cmd === null) return false;
  return cmd.split(/\s+/).some((token) => token === SERVE_TOKEN);
}

function defaultListChildren(pid: number): number[] {
  let out: string | null = null;
  try {
    out = execFileSync("/bin/ps", ["-o", "pid=", "--ppid", String(pid)], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"], LC_ALL: "C" },
      timeout: 500,
    });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const value = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(value) && value > 0) pids.push(value);
  }
  return pids;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort: the engine may already be gone between poll and signal.
  }
}

export interface StrataEngineDeps {
  listChildren: (pid: number) => number[];
  processCommand: (pid: number) => string | null;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  shutdown: (pid: number, graceMs: number, identity?: SignalIdentity) => Promise<void>;
  verify: (recordPath: string, pid: number, deps?: PidIdentityDeps) => PidVerdict;
}

function validateStrataSpec(spec: ModelHostSpecForEngine): Validation {
  if (!spec.binary || spec.binary.trim() === "") {
    return { ok: false, error: "strata engine requires spec.binary (no PATH fallback)" };
  }
  if (!existsSync(spec.binary)) {
    return { ok: false, error: `strata binary not found at ${spec.binary}` };
  }
  if (basename(spec.binary) !== BINARY_BASENAME) {
    return {
      ok: false,
      error: `strata binary must be a symlink named ${BINARY_BASENAME}; got ${basename(spec.binary)}`,
    };
  }
  if (typeof spec.endpoint.port !== "number") {
    return { ok: false, error: "strata engine requires spec.endpoint.port" };
  }
  if (!isLoopbackHost(spec.endpoint.host)) {
    return {
      ok: false,
      error: `endpoint.host must be loopback or 0.0.0.0; got ${spec.endpoint.host}`,
    };
  }
  if (!Array.isArray(spec.hostedModels) || spec.hostedModels.length !== 1) {
    return { ok: false, error: "hostedModels must have exactly one entry" };
  }
  const entrypoint = spec.extraArgs[0] ?? "";
  if (!entrypoint.endsWith("serve/server.py")) {
    return {
      ok: false,
      error: "strata extraArgs[0] must be the server entrypoint ending in serve/server.py",
    };
  }
  if (!hasEngineFlagPair(spec.extraArgs)) {
    return { ok: false, error: 'strata extraArgs must include "--engine strata"' };
  }
  const config = flagValue(spec.extraArgs, "--config");
  if (config === null || config === "") {
    return { ok: false, error: 'strata extraArgs must include "--config <file>"' };
  }
  if (!existsSync(config)) {
    return { ok: false, error: `strata --config file not found: ${config}` };
  }
  if (spec.extraArgs.includes("--host") || spec.extraArgs.includes("--port")) {
    return {
      ok: false,
      error: "strata extraArgs must not set --host or --port (adapter owns them)",
    };
  }
  return { ok: true };
}

function parseStrataRunConfig(configPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`strata run-config not readable: ${configPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`strata run-config is not valid JSON: ${configPath}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`strata run-config is not a JSON object: ${configPath}`);
  }
  return parsed as Record<string, unknown>;
}

function assertNativeMatches(
  argsStr: string[],
  env: EngineBootEnv,
  hostedModel: ModelHostHostedModel,
  configPath: string,
): void {
  const modelsDir = env.LLAMACTL_MODELS_DIR ?? env.LLAMA_CPP_MODELS;
  if (!modelsDir) {
    throw new Error(
      "strata prepareLaunch requires LLAMACTL_MODELS_DIR or LLAMA_CPP_MODELS in the boot env",
    );
  }
  const resolvedModelsDir = resolve(modelsDir);
  const expectedNative = resolve(resolvedModelsDir, hostedModel.rel);
  if (!expectedNative.startsWith(`${resolvedModelsDir}${sep}`)) {
    throw new Error(`hostedModel rel escapes models dir: ${hostedModel.rel}`);
  }
  const nativeIdx = argsStr.indexOf("--native");
  const nativeValue = nativeIdx === -1 ? null : (argsStr[nativeIdx + 1] ?? null);
  // Two settings name the model and must move together: the manifest's rel
  // and the run-config's --native. Name both so the fix is obvious from the log.
  if (nativeValue !== expectedNative) {
    throw new Error(
      `strata run-config ${configPath} --native must be ${expectedNative} (models dir + ModelHost spec.hostedModels[0].rel "${hostedModel.rel}"); got ${String(nativeValue)}. Update the run-config --native and the manifest rel together.`,
    );
  }
  if (!existsSync(expectedNative)) {
    throw new Error(`strata native model file does not exist: ${expectedNative}`);
  }
}

function assertAdvertisesModel(config: Record<string, unknown>, modelBase: string): void {
  const modelName = config["model_name"];
  const aliasesRaw = config["aliases"];
  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.map((a) => String(a)) : [];
  if (modelName !== modelBase && !aliases.includes(modelBase)) {
    throw new Error(`strata run-config must advertise ${modelBase} via model_name or aliases`);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- EngineAdapter prepare hook is async; strata setup is synchronous today.
async function prepareStrataLaunch(
  spec: ModelHostSpecForEngine,
  env: EngineBootEnv,
): Promise<void> {
  const hostedModel = spec.hostedModels[0];
  if (!hostedModel) {
    throw new Error("hostedModels must have exactly one entry");
  }
  const configPath = flagValue(spec.extraArgs, "--config");
  if (configPath === null || configPath === "") {
    throw new Error('strata prepareLaunch requires "--config <file>" in extraArgs');
  }
  const config = parseStrataRunConfig(configPath);
  const args = config["args"];
  if (!Array.isArray(args)) {
    throw new Error(`strata run-config has no args array: ${configPath}`);
  }
  const argsStr = args.map((a) => String(a));

  assertNativeMatches(argsStr, env, hostedModel, configPath);
  assertAdvertisesModel(config, basename(hostedModel.rel));

  const host = config["host"];
  if (typeof host === "string" && !isLoopbackHost(host)) {
    throw new Error(`strata run-config host must be loopback or 0.0.0.0; got ${host}`);
  }
}

function buildStrataBootCommand(spec: ModelHostSpecForEngine): { binary: string; args: string[] } {
  return {
    binary: spec.binary,
    args: [...spec.extraArgs, "--host", spec.endpoint.host, "--port", String(spec.endpoint.port)],
  };
}

async function reapEngineChildren(resolved: StrataEngineDeps, engines: number[]): Promise<void> {
  const deadline = resolved.now() + ENGINE_EXIT_TIMEOUT_MS;
  for (const enginePid of engines) {
    while (resolved.isAlive(enginePid) && resolved.now() < deadline) {
      await resolved.sleep(ENGINE_POLL_MS);
    }
    if (!resolved.isAlive(enginePid)) continue;
    if (hasServeToken(resolved.processCommand(enginePid))) {
      resolved.kill(enginePid, "SIGKILL");
    }
  }
}

export function createStrataEngine(deps?: Partial<StrataEngineDeps>): EngineAdapter {
  const resolved: StrataEngineDeps = {
    listChildren: deps?.listChildren ?? defaultListChildren,
    processCommand: deps?.processCommand ?? realProcessCommand,
    isAlive: deps?.isAlive ?? isProcessAlive,
    kill: deps?.kill ?? defaultKill,
    sleep:
      deps?.sleep ?? ((ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms))),
    now: deps?.now ?? ((): number => Date.now()),
    shutdown: deps?.shutdown ?? gracefulShutdown,
    verify: deps?.verify ?? verifyPidFile,
  };

  // The Strata HTTP server spawns its native engine as a direct child in the
  // server's own process group (a plain subprocess.Popen, no setsid), so a
  // group-wide signal reaches it only when the server leads that group
  // (llamactl's detached spawn); an adopted server that is not a group leader
  // gets only its own pid signalled. Either way gracefulShutdown waits for the
  // server pid alone, but the engine can outlive the server while it tears
  // down its mappings / GPU memory, so the adapter must wait for it too.
  // Collect the engine children (identified by a --serve argv token) before
  // anything is signalled, while their parent is still alive to parent them.
  const engineChildren = (pid: number): number[] => {
    return resolved.listChildren(pid).filter((child) => {
      return hasServeToken(resolved.processCommand(child));
    });
  };

  return {
    name: "strata",
    validateSpec: validateStrataSpec,
    prepareLaunch: prepareStrataLaunch,
    buildBootCommand: buildStrataBootCommand,
    probeReady: async (
      endpoint: { host: string; port: number },
      timeoutMs: number,
    ): Promise<{ ready: boolean; modelIds: string[] }> =>
      await pollUntilModelIds(endpoint, timeoutMs),
    async teardown(pid: number, identity?: SignalIdentity): Promise<void> {
      const engines = engineChildren(pid);
      // gracefulShutdown declines to signal an unverifiable pid — when a
      // command expectation is set it folds expectCommand into the verify
      // deps, so a live pid whose command no longer matches is left alone.
      // Mirror that exact decision here so a recycled or command-mismatched
      // server never takes its engine children down with it.
      if (identity?.recordPath !== undefined) {
        const verdict = resolved.verify(identity.recordPath, pid, {
          ...identity.deps,
          ...(identity.expectCommand !== undefined
            ? { expectCommand: identity.expectCommand }
            : {}),
        });
        if (verdict !== "alive") return;
      }
      await resolved.shutdown(pid, ENGINE_GRACE_MS, identity);
      await reapEngineChildren(resolved, engines);
    },
  };
}

export const strataEngine: EngineAdapter = createStrataEngine();
