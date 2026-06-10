import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  benchProfileFile,
  defaultModeForRel,
  findLatestProfile,
  machineLabel,
  readBenchProfiles,
  serverProfileArgs,
} from "./bench/index.js";
import { resolveBuildId } from "./build.js";
import { ctxForModel } from "./ctx.js";
import { resolveEnv } from "./env.js";
import {
  defaultReadProcessCommand,
  parseSlotSavePathFromCommand,
  resolveSlotSavePathArgs,
} from "./kvstore/index.js";
import { resolveTarget } from "./target.js";
import type { ResolvedEnv } from "./types.js";
import type { WorkloadKey } from "./workloadRuntime.js";
import { ensureWorkloadRuntimeDir, workloadRuntimeDir } from "./workloadRuntime.js";

/**
 * Lifecycle events emitted during `startServer`. Forwarded to the CLI
 * (stderr) and any Electron subscription so the renderer can show a
 * live start-up log.
 */
export type ServerEvent =
  | { type: "launch"; pid: number; command: string; args: string[] }
  | { type: "waiting"; attempt: number; httpCode: string | null }
  | { type: "ready"; pid: number; endpoint: string }
  | { type: "retry"; reason: string }
  | { type: "timeout"; pid: number }
  | { type: "exited"; code: number | null };

function pidFile(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "llama-server.pid");
}

function serverLog(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "llama-server.log");
}

/**
 * Return true if `args` already contains any of the given flag tokens.
 * Used to skip prepending daemon defaults the user already specified
 * in `spec.extraArgs`. Matches exact tokens and `flag=value` forms;
 * positional-value awareness isn't needed because the caller always
 * passes the flag itself, never a value.
 */
export function hasFlag(args: readonly string[], ...flags: string[]): boolean {
  return args.some((tok) => flags.some((f) => tok === f || tok.startsWith(f + "=")));
}

/**
 * Take a flat profile-args string like `-fa on -b 2048 -ub 512` and
 * drop any flag+value pair that collides with the user's extraArgs.
 * Aliases (`-fa` ↔ `--flash-attn`, `-b` ↔ `--batch-size`,
 * `-ub` ↔ `--ubatch-size`) are treated as equivalent.
 *
 * Profile args from `serverProfileArgs()` are always flag+value pairs,
 * so the iterator can assume a 2-token stride.
 */
export function filterProfileArgs(
  profileArgs: readonly string[],
  userArgs: readonly string[],
): string[] {
  const aliasGroups: Record<string, string[]> = {
    "-fa": ["-fa", "--flash-attn"],
    "-b": ["-b", "--batch-size"],
    "-ub": ["-ub", "--ubatch-size"],
  };
  const out: string[] = [];
  for (let i = 0; i < profileArgs.length; i += 2) {
    const flag = profileArgs[i]!;
    const value = profileArgs[i + 1];
    const conflicts = aliasGroups[flag] ?? [flag];
    if (hasFlag(userArgs, ...conflicts)) continue;
    out.push(flag);
    if (value !== undefined) out.push(value);
  }
  return out;
}

function serverStateFile(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), "llama-server.state");
}

export function endpoint(
  resolved: ResolvedEnv = resolveEnv(),
  override?: { host?: string; port?: number | string },
): string {
  const host = override?.host ?? resolved.LLAMA_CPP_HOST;
  const port = override?.port ?? resolved.LLAMA_CPP_PORT;
  return `http://${host}:${port}`;
}

/**
 * URL external callers should use to reach llama-server. Falls back to
 * the bind endpoint when LLAMA_CPP_ADVERTISED_HOST is unset, which
 * preserves the pre-existing single-machine UX. When it's set (e.g.
 * on a LAN-exposed Mac mini), this is the URL to hand to an
 * orchestrator so a 0.0.0.0 bind doesn't leak into the status output.
 */
export function advertisedEndpoint(
  resolved: ResolvedEnv = resolveEnv(),
  override?: { host?: string; port?: number | string },
): string {
  const host = resolved.LLAMA_CPP_ADVERTISED_HOST || override?.host || resolved.LLAMA_CPP_HOST;
  const port = override?.port ?? resolved.LLAMA_CPP_PORT;
  return `http://${host}:${port}`;
}

function useTunedArgsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LLAMA_CPP_USE_TUNED_ARGS ?? "true";
  switch (raw) {
    case "0":
    case "false":
    case "FALSE":
    case "no":
    case "NO":
    case "off":
    case "OFF":
      return false;
    default:
      return true;
  }
}

function safeRetryArgs(): string[] {
  return [
    "--flash-attn",
    "off",
    "--no-cache-prompt",
    "--parallel",
    "1",
    "--no-cont-batching",
    "--no-mmproj-offload",
    "--no-warmup",
  ];
}

function hasMmprojArg(args: readonly string[]): boolean {
  return args.some(
    (a) => a === "--mmproj" || a === "-mm" || a === "--mmproj-url" || a === "--mmproj-auto",
  );
}

// ---- PID helpers -------------------------------------------------------

/**
 * Read the stored llama-server PID. Returns null when the file is
 * absent or malformed. The caller should then verify the PID is alive
 * (kill -0) before trusting it — stale files linger after crashes.
 */
export function readServerPid(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): number | null {
  const file = pidFile(resolved, key);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeServerPid(resolved: ResolvedEnv, key: WorkloadKey, pid: number): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(pidFile(resolved, key), `${pid}\n`);
}

function removeServerPid(resolved: ResolvedEnv, key: WorkloadKey): void {
  try {
    unlinkSync(pidFile(resolved, key));
  } catch {
    // no-op
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- status ------------------------------------------------------------

export interface ServerState {
  rel: string;
  extraArgs: string[];
  slotSavePath?: string | null;
  host: string;
  port: string;
  binary: string;
  pid: number;
  startedAt: string; // ISO 8601
  tunedProfile: string | null;
}

export interface ServerStatus {
  state: "up" | "down";
  /** URL the local process uses to poll /health. Always derived from
   *  the bind host, so it works even when the server is on loopback. */
  endpoint: string;
  /** URL external callers should use. Same as `endpoint` on a stock
   *  install; differs when LLAMA_CPP_ADVERTISED_HOST is set. */
  advertisedEndpoint: string;
  pid: number | null;
  health: {
    httpCode: number | null;
    reachable: boolean;
  };
  /**
   * Metadata about the currently-tracked llama-server process. Populated
   * from the `llama-server.state` sidecar written at startServer time so
   * downstream reconcilers can diff desired vs observed without needing
   * to parse /proc/<pid>/cmdline. Null when no server is tracked.
   */
  rel: string | null;
  extraArgs: string[];
  startedAt: string | null;
  host: string | null;
  port: number | null;
  binary: string | null;
  tunedProfile: string | null;
}

/**
 * Read the sidecar state file written at startServer time. Returns
 * null when absent or malformed — callers should treat that as "no
 * live server metadata available", which is the same user experience
 * as the pre-D.0 ServerStatus shape.
 */
export function readServerState(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): ServerState | null {
  const file = serverStateFile(resolved, key);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ServerState;
    if (
      typeof parsed.rel === "string" &&
      Array.isArray(parsed.extraArgs) &&
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string"
    ) {
      if (typeof parsed.binary !== "string") parsed.binary = "";
      parsed.slotSavePath = typeof parsed.slotSavePath === "string" ? parsed.slotSavePath : null;
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeServerState(resolved: ResolvedEnv, key: WorkloadKey, state: ServerState): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(serverStateFile(resolved, key), JSON.stringify(state, null, 2));
}

function removeServerState(resolved: ResolvedEnv, key: WorkloadKey): void {
  try {
    unlinkSync(serverStateFile(resolved, key));
  } catch {
    // no-op
  }
}

/**
 * Report whether a local llama-server is reachable. Combines the stored
 * PID (if any, and alive) with a live `GET /health` probe so the status
 * reflects reality even when the PID file went stale from an unclean
 * shutdown.
 */
export async function serverStatus(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
): Promise<ServerStatus> {
  const pidRaw = readServerPid(key, resolved);
  const pid = pidRaw && isProcessAlive(pidRaw) ? pidRaw : null;
  if (pidRaw && !pid) removeServerPid(resolved, key);
  const sidecar = readServerState(key, resolved);
  // Only trust the sidecar when its PID matches the live one; if the
  // PIDs diverge, the state file is from a previous launch that
  // exited uncleanly. Clean up in that case.
  const validSidecar = sidecar && sidecar.pid === pid;
  const endpointOverride = validSidecar ? { host: sidecar.host, port: sidecar.port } : undefined;
  const healthUrl = `${endpoint(resolved, endpointOverride)}/health`;
  let httpCode: number | null = null;
  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
    httpCode = res.status;
  } catch {
    httpCode = null;
  }

  const reachable = httpCode === 200;
  const state: ServerStatus["state"] = reachable || pid !== null ? "up" : "down";

  if (sidecar && !validSidecar && state === "down") {
    removeServerState(resolved, key);
  }

  return {
    state,
    endpoint: endpoint(resolved, endpointOverride),
    advertisedEndpoint: advertisedEndpoint(resolved, endpointOverride),
    pid,
    health: { httpCode, reachable },
    rel: validSidecar ? sidecar.rel : null,
    extraArgs: validSidecar ? sidecar.extraArgs : [],
    startedAt: validSidecar ? sidecar.startedAt : null,
    host: validSidecar ? sidecar.host : null,
    port: validSidecar ? Number.parseInt(sidecar.port, 10) || null : null,
    binary: validSidecar ? sidecar.binary || null : null,
    tunedProfile: validSidecar ? sidecar.tunedProfile : null,
  };
}

// ---- start/stop --------------------------------------------------------

export interface StartServerOptions {
  key: WorkloadKey;
  target: string;
  /** Additional arguments appended to the llama-server invocation. */
  extraArgs?: string[];
  allowExternalBind?: boolean;
  /** Optional endpoint override from the workload manifest. */
  endpoint?: { host?: string; port?: number };
  /** Optional absolute path to the llama-server binary. */
  binary?: string;
  /** How long to wait for /health to return 200 before giving up. */
  timeoutSeconds?: number;
  /** Skip tuned-profile arg lookup even when LLAMA_CPP_USE_TUNED_ARGS is on. */
  skipTuned?: boolean;
  onEvent?: (e: ServerEvent) => void;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, aborts an in-flight start: SIGTERMs the detached
   * llama-server child (tracked via PID) and short-circuits the
   * readiness polling with `aborted` outcome.
   */
  signal?: AbortSignal;
}

export interface StartServerResult {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  /** See ServerStatus.advertisedEndpoint. Falls back to `endpoint`
   *  when LLAMA_CPP_ADVERTISED_HOST is unset — existing callers that
   *  only read `endpoint` continue to work unchanged. */
  advertisedEndpoint: string;
  tunedProfile: string | null;
  retried: boolean;
  error?: string;
}

/**
 * Quick pre-flight: dial the configured llama-server endpoint after
 * we've torn down our own previous instance. If something answers
 * within ~500ms, another process is bound to the port — return a
 * human-readable hint so startServer can surface it before spawning
 * a doomed llama-server. Returns null when the port looks clear.
 */
async function detectPortConflict(endpointUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${endpointUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(500),
    });
    // Anything that answers means the port is taken. 200 = a stale
    // llama-server somehow survived our stopServer; everything else
    // = a foreign listener (Docker forwards, etc.).
    return (
      `port ${endpointUrl.replace(/^https?:\/\//, "")} is already bound ` +
      `(HTTP ${res.status} on /health) \u2014 stop the foreign process ` +
      `(try: lsof -P -iTCP:PORT) or set LLAMA_CPP_PORT to a free port`
    );
  } catch {
    // Connection refused / timeout = port is free.
    return null;
  }
}

// --- Adoption of an already-bound healthy server -------------------------
// When `detectPortConflict` finds a server already answering on our endpoint,
// it may be one WE want (an externally-started llama-server, or one a prior
// process left running) rather than a foreign squatter. If it serves OUR
// model, adopt it — record its pid + state so listLocalRoutes/the proxy route
// recover — instead of failing or spawning a competitor that cannot bind the
// held port. This is what makes remote-node servers (where direct spawn is
// unreliable) routable + managed. Mirrors modelhost.ts `tryAdoptLiveHost`.

const ADOPT_PROBE_TIMEOUT_MS = 3000;
const FIND_LISTENER_TIMEOUT_MS = 2000;

// Resolve lsof by absolute path: macOS ships it in /usr/sbin, which is NOT on
// the launchd PATH — a bare `lsof` would ENOENT there and silently disable
// adoption in production.
function resolveLsofPath(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "lsof";
}

function lsofListenerPid(filter: string): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), FIND_LISTENER_TIMEOUT_MS);
    try {
      child = spawn(resolveLsofPath(), ["-nP", filter, "-sTCP:LISTEN", "-t"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => finish(null));
      child.on("close", () => {
        const pid = out
          .split(/\s+/)
          .map((token) => Number.parseInt(token, 10))
          .find((value) => Number.isInteger(value) && value > 0);
        finish(pid ?? null);
      });
    } catch {
      finish(null);
    }
  });
}

async function findListenerPid(host: string, port: number): Promise<number | null> {
  // Prefer the exact bind address so an unrelated process on a different
  // address of the same port isn't mis-matched. Fall back to any address on
  // the port: a server launched with `--host 0.0.0.0` (LAN-reachable) binds
  // 0.0.0.0:<port>, which the loopback-scoped `-iTCP@host:port` filter misses
  // even though detectPortConflict reached it via 127.0.0.1. Ownership is
  // already confirmed by the /v1/models probe in the caller, so the
  // port-only fallback is safe.
  const exact = await lsofListenerPid(`-iTCP@${host}:${port}`);
  if (exact !== null) return exact;
  return lsofListenerPid(`-iTCP:${port}`);
}

async function probeServerModelIds(endpointUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const res = await fetch(`${endpointUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id : ""))
      .filter((id): id is string => id.length > 0);
  } catch {
    return [];
  }
}

/** Extract `--alias <name>` values from llama-server extraArgs. llama.cpp
 *  advertises the alias (not the model rel) on /v1/models, so adoption must
 *  match against it. */
export function aliasesFromArgs(extraArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < extraArgs.length; i += 1) {
    if (extraArgs[i] === "--alias" || extraArgs[i] === "-a") out.push(extraArgs[i + 1]!);
  }
  return out;
}

export interface AdoptDeps {
  findListenerPid: (host: string, port: number) => Promise<number | null>;
  probeModelIds: (endpointUrl: string, timeoutMs: number) => Promise<string[]>;
  readProcessCommand?: (pid: number) => Promise<string | null> | string | null;
}

/**
 * A healthy server is already bound to our endpoint. Adopt it iff it serves
 * OUR model — by rel, basename(rel), or a configured `--alias`. On success,
 * record its pid + sidecar state and return the adopted pid; return null when
 * ownership cannot be confirmed (empty model list, mismatch, or the listener
 * vanished). `deps` is injectable for tests; production uses lsof + a real
 * /v1/models probe.
 */
export async function tryAdoptExistingServer(args: {
  resolved: ResolvedEnv;
  key: WorkloadKey;
  endpointUrl: string;
  host: string;
  port: number;
  rel: string;
  extraArgs: string[];
  binary: string;
  deps?: Partial<AdoptDeps>;
}): Promise<number | null> {
  const probe = args.deps?.probeModelIds ?? probeServerModelIds;
  const find = args.deps?.findListenerPid ?? findListenerPid;
  const readProcessCommand = args.deps?.readProcessCommand ?? defaultReadProcessCommand;
  const modelIds = await probe(args.endpointUrl, ADOPT_PROBE_TIMEOUT_MS);
  const aliases = new Set<string>([
    args.rel,
    basename(args.rel),
    ...aliasesFromArgs(args.extraArgs),
  ]);
  // Only adopt a server advertising OUR model. Empty ids = unconfirmable →
  // refuse rather than adopt an unrelated squatter on the freed port.
  if (
    modelIds.length === 0 ||
    !modelIds.some((id) => aliases.has(id) || aliases.has(basename(id)))
  ) {
    return null;
  }
  const pid = await find(args.host, args.port);
  // TOCTOU: the listener may have exited between probe and now.
  if (pid === null || !isProcessAlive(pid)) return null;
  const cmdline = await Promise.resolve(readProcessCommand(pid)).catch(() => null);
  writeServerPid(args.resolved, args.key, pid);
  writeServerState(args.resolved, args.key, {
    rel: args.rel,
    extraArgs: args.extraArgs,
    slotSavePath: typeof cmdline === "string" ? parseSlotSavePathFromCommand(cmdline) : null,
    host: args.host,
    port: String(args.port),
    binary: args.binary,
    pid,
    startedAt: new Date().toISOString(),
    tunedProfile: null,
  });
  return pid;
}

interface PollReadyResult {
  outcome: "ready" | "exited" | "timeout" | "aborted";
  /** Last HTTP status code the probe saw on the health endpoint, if
   *  any. When `outcome === 'timeout'` and this is a non-503 code
   *  (e.g. 401, 404), another process is almost certainly bound to
   *  the port — startServer surfaces it in the error message so
   *  operators don't have to guess. */
  lastHttpCode?: string;
  /** True when the majority of probe attempts returned the same
   *  non-503 HTTP status — classic port-collision signature. */
  portConflict?: boolean;
}

async function pollReady(
  pid: number,
  healthUrl: string,
  timeoutSeconds: number,
  onEvent?: (e: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<PollReadyResult> {
  let lastHttpCode: string | null = null;
  let nonLoadingHttpCount = 0;
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    if (signal?.aborted) return { outcome: "aborted" };
    let httpCode: string | null = null;
    try {
      const res = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      httpCode = String(res.status);
      lastHttpCode = httpCode;
      if (res.status === 200) return { outcome: "ready", lastHttpCode: httpCode };
      // 503 is the documented "loading" code llama-server emits
      // while loading the model. Any other non-200 (401/403/404)
      // almost always means *something else* is bound to the same
      // port and we're polling the wrong process.
      if (res.status === 503) {
        onEvent?.({ type: "waiting", attempt, httpCode });
      } else {
        nonLoadingHttpCount += 1;
        if (!isProcessAlive(pid)) return { outcome: "exited", lastHttpCode: httpCode };
        onEvent?.({ type: "waiting", attempt, httpCode });
      }
    } catch {
      if (!isProcessAlive(pid))
        return { outcome: "exited", lastHttpCode: lastHttpCode ?? undefined };
      onEvent?.({ type: "waiting", attempt, httpCode });
    }
    // Interruptible sleep so SIGTERM + abort react within ~1s.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
  if (signal?.aborted) return { outcome: "aborted" };
  const alive = isProcessAlive(pid);
  const portConflict = nonLoadingHttpCount >= Math.max(3, timeoutSeconds - 1);
  const result: PollReadyResult = {
    outcome: alive ? "timeout" : "exited",
  };
  if (lastHttpCode !== null) result.lastHttpCode = lastHttpCode;
  if (portConflict) result.portConflict = true;
  return result;
}

/**
 * Start llama-server in the background. Mirrors the shell `llama-start`:
 *
 *   1. Resolve the target to a rel + model path; fail if missing.
 *   2. Stop any previous instance, then spawn llama-server detached,
 *      redirecting stdout/stderr to `$LLAMA_CPP_LOGS/server.log`.
 *   3. Apply tuned launch args from bench-profiles.tsv when a record
 *      exists for (machine, rel, mode, ctx, build); otherwise use the
 *      `default` profile args.
 *   4. Poll `/health` until 200 or timeout; retry once with safe-flag
 *      mmproj args if the first attempt didn't come up and mmproj was
 *      in the arg set.
 *
 * Returns a structured result; non-null `error` indicates a hard
 * failure the caller should surface.
 */
export async function startServer(opts: StartServerOptions): Promise<StartServerResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const key = opts.key;
  const launchEndpoint = opts.endpoint;
  const launchHost = launchEndpoint?.host ?? resolved.LLAMA_CPP_HOST;
  const launchPort = launchEndpoint?.port ?? resolved.LLAMA_CPP_PORT;
  const rel = resolveTarget(opts.target, env);
  if (!rel) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile: null,
      retried: false,
      error: `Unknown target: ${opts.target}`,
    };
  }
  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (!existsSync(modelPath)) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile: null,
      retried: false,
      error: `Model file not found: ${modelPath}`,
    };
  }
  const bin = opts.binary ?? join(resolved.LLAMA_CPP_BIN, "llama-server");
  if (!existsSync(bin)) {
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile: null,
      retried: false,
      error: `llama-server binary not found: ${bin}`,
    };
  }

  // Stop any existing instance — best effort.
  await stopServer({ key, resolved });

  // Pre-flight port-collision check. After our own stopServer, the
  // configured port should be free. If something still answers on
  // /health, it's a foreign process (Colima docker forwards, an old
  // Ollama, a stray docker container) and llama-server's bind would
  // either fail silently or land on a duplicate port that the
  // readiness probe would never resolve correctly. Fail fast with
  // the offending HTTP code so the operator knows what to kill.
  const portConflictHint = await detectPortConflict(endpoint(resolved, launchEndpoint));
  if (portConflictHint) {
    // Something already answers on our endpoint. If it's serving OUR model,
    // adopt it (record pid + state so it's managed + routable) instead of
    // failing — a spawn could not win the held port anyway. Only a genuine
    // foreign listener falls through to the error.
    const adoptedPid = await tryAdoptExistingServer({
      resolved,
      key,
      endpointUrl: endpoint(resolved, launchEndpoint),
      host: launchHost,
      port: Number(launchPort),
      rel,
      extraArgs: opts.extraArgs ?? [],
      binary: bin,
    });
    if (adoptedPid !== null) {
      opts.onEvent?.({
        type: "ready",
        pid: adoptedPid,
        endpoint: endpoint(resolved, launchEndpoint),
      });
      return {
        ok: true,
        pid: adoptedPid,
        endpoint: endpoint(resolved, launchEndpoint),
        advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
        tunedProfile: null,
        retried: false,
      };
    }
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile: null,
      retried: false,
      error: portConflictHint,
    };
  }

  mkdirSync(resolved.LLAMA_CPP_MODELS, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_CACHE, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });

  // Tuned-profile lookup. Profile args are skipped when the user has
  // already specified the same flag in extraArgs, so a manifest that
  // sets e.g. `-ub 1024` isn't doubled up with the profile's `-ub 512`.
  let tunedProfile: string | null = null;
  const extra = opts.extraArgs ?? [];
  const slotPathResolved = resolveSlotSavePathArgs(extra, resolved.LOCAL_AI_RUNTIME_DIR, key.name);
  if (slotPathResolved.slotSavePath !== null) {
    mkdirSync(slotPathResolved.slotSavePath, { recursive: true });
  }
  const launchArgs: string[] = [];
  let profileArgs: string[] = [];
  if (!opts.skipTuned && useTunedArgsEnabled(env)) {
    const mode = hasMmprojArg(extra) ? "vision" : defaultModeForRel(rel, resolved);
    const ctx = ctxForModel(rel, resolved);
    const build = resolveBuildId(resolved);
    const machine = machineLabel(resolved);
    const rows = readBenchProfiles(benchProfileFile(resolved));
    const hit = findLatestProfile(rows, { machine, rel, mode, ctx, build });
    if (hit) {
      tunedProfile = hit.profile;
      profileArgs = serverProfileArgs(hit.profile).split(/\s+/).filter(Boolean);
    } else {
      profileArgs = serverProfileArgs("default").split(/\s+/).filter(Boolean);
    }
  } else {
    profileArgs = serverProfileArgs("default").split(/\s+/).filter(Boolean);
  }
  launchArgs.push(...filterProfileArgs(profileArgs, slotPathResolved.args));
  launchArgs.push(...slotPathResolved.args);

  validateHostBind(launchArgs, opts.allowExternalBind);
  const pid = await launchBackground({
    bin,
    modelPath,
    args: launchArgs,
    resolved,
    key,
    allowExternalBind: opts.allowExternalBind,
    host: launchHost,
    port: launchPort,
    onEvent: opts.onEvent,
  });
  writeServerPid(resolved, key, pid);
  writeServerState(resolved, key, {
    rel,
    extraArgs: extra,
    slotSavePath: slotPathResolved.slotSavePath,
    host: launchHost,
    port: String(launchPort),
    binary: bin,
    pid,
    startedAt: new Date().toISOString(),
    tunedProfile,
  });

  // Wire the caller's abort signal to SIGTERM the detached child so
  // a tRPC unsubscribe or Ctrl-C doesn't leave an orphan server.
  const killOnAbort = () => {
    try {
      if (isProcessAlive(pid)) process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) killOnAbort();
    else opts.signal.addEventListener("abort", killOnAbort, { once: true });
  }

  const timeoutSeconds = opts.timeoutSeconds ?? 60;
  const healthUrl = `${endpoint(resolved, launchEndpoint)}/health`;
  let readyResult = await pollReady(pid, healthUrl, timeoutSeconds, opts.onEvent, opts.signal);
  let outcome = readyResult.outcome;
  if (outcome === "aborted") {
    opts.signal?.removeEventListener("abort", killOnAbort);
    killOnAbort();
    removeServerPid(resolved, key);
    return {
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile,
      retried: false,
      error: "Start aborted by caller",
    };
  }
  if (outcome === "ready") {
    opts.signal?.removeEventListener("abort", killOnAbort);
    opts.onEvent?.({ type: "ready", pid, endpoint: endpoint(resolved, launchEndpoint) });
    return {
      ok: true,
      pid,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile,
      retried: false,
    };
  }

  // Retry path: mmproj-safe flags.
  let retried = false;
  if (hasMmprojArg(launchArgs)) {
    opts.onEvent?.({ type: "retry", reason: "mmproj safe-flag retry" });
    await stopServer({ key, resolved });
    const retryArgs = [...launchArgs, ...safeRetryArgs()];
    const retryPid = await launchBackground({
      bin,
      modelPath,
      args: retryArgs,
      resolved,
      key,
      allowExternalBind: opts.allowExternalBind,
      host: launchHost,
      port: launchPort,
      onEvent: opts.onEvent,
    });
    writeServerPid(resolved, key, retryPid);
    readyResult = await pollReady(retryPid, healthUrl, timeoutSeconds, opts.onEvent, opts.signal);
    outcome = readyResult.outcome;
    retried = true;
    if (outcome === "aborted") {
      try {
        if (isProcessAlive(retryPid)) process.kill(retryPid, "SIGTERM");
      } catch {
        // already gone
      }
      removeServerPid(resolved, key);
      opts.signal?.removeEventListener("abort", killOnAbort);
      return {
        ok: false,
        pid: null,
        endpoint: endpoint(resolved, launchEndpoint),
        advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
        tunedProfile,
        retried: true,
        error: "Start aborted by caller",
      };
    }
    if (outcome === "ready") {
      opts.signal?.removeEventListener("abort", killOnAbort);
      opts.onEvent?.({
        type: "ready",
        pid: retryPid,
        endpoint: endpoint(resolved, launchEndpoint),
      });
      return {
        ok: true,
        pid: retryPid,
        endpoint: endpoint(resolved, launchEndpoint),
        advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
        tunedProfile,
        retried: true,
      };
    }
  }

  opts.signal?.removeEventListener("abort", killOnAbort);

  if (outcome === "timeout") {
    opts.onEvent?.({ type: "timeout", pid });
    // Port-collision hint: when the probe kept seeing a non-503 HTTP
    // status on the health endpoint, something else is bound to the
    // port and llama-server is answering nobody. Name the status
    // code so operators can lsof / pkill the right process.
    const conflictHint =
      readyResult.portConflict && readyResult.lastHttpCode
        ? ` \u2014 health endpoint returned HTTP ${readyResult.lastHttpCode} repeatedly; another process is likely bound to this port (try: lsof -P -iTCP:PORT)`
        : "";
    return {
      ok: false,
      pid,
      endpoint: endpoint(resolved, launchEndpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
      tunedProfile,
      retried,
      error: `llama-server readiness check timed out after ${timeoutSeconds}s${conflictHint}`,
    };
  }

  opts.onEvent?.({ type: "exited", code: null });
  return {
    ok: false,
    pid: null,
    endpoint: endpoint(resolved, launchEndpoint),
    advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
    tunedProfile,
    retried,
    error: "llama-server exited before becoming ready",
  };
}

interface LaunchArgs {
  bin: string;
  modelPath: string;
  args: string[];
  resolved: ResolvedEnv;
  key: WorkloadKey;
  allowExternalBind?: boolean;
  host?: string;
  port?: number | string;
  binary?: string;
  onEvent?: (e: ServerEvent) => void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function findArgValue(args: readonly string[], flag: string): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok === flag) return args[i + 1] ?? null;
    if (tok.startsWith(flag + "=")) return tok.slice(flag.length + 1);
  }
  return null;
}

function validateHostBind(args: readonly string[], allowExternalBind: boolean | undefined): void {
  const host = findArgValue(args, "--host");
  if (host === null || LOOPBACK_HOSTS.has(host)) return;
  if (allowExternalBind === true) return;
  throw new Error(
    `refusing to bind llama-server to ${host} without \`allowExternalBind: true\` in the workload spec`,
  );
}

async function launchBackground(opts: LaunchArgs): Promise<number> {
  const { openSync, closeSync } = await import("node:fs");
  ensureWorkloadRuntimeDir(opts.resolved, opts.key);
  const logFd = openSync(serverLog(opts.resolved, opts.key), "a");
  // Daemon-injected defaults: only prepended when the user's args don't
  // already specify them, so a manifest's `--host 0.0.0.0` overrides the
  // env-default `--host 127.0.0.1` instead of producing a duplicate that
  // some llama-server versions reject. `-m` is always set from the
  // resolved model path; user-side overrides for the model path aren't
  // a supported pattern.
  const fullArgs: string[] = [
    "-m",
    opts.modelPath,
    ...(hasFlag(opts.args, "--alias", "-a")
      ? []
      : ["--alias", opts.resolved.LLAMA_CPP_SERVER_ALIAS]),
    ...(hasFlag(opts.args, "--host") ? [] : ["--host", opts.host ?? opts.resolved.LLAMA_CPP_HOST]),
    ...(hasFlag(opts.args, "--port")
      ? []
      : ["--port", String(opts.port ?? opts.resolved.LLAMA_CPP_PORT)]),
    ...(hasFlag(opts.args, "-ngl", "--n-gpu-layers", "--gpu-layers") ? [] : ["-ngl", "999"]),
    ...opts.args,
  ];
  validateHostBind(fullArgs, opts.allowExternalBind);
  const child = spawn(opts.bin, fullArgs, {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  closeSync(logFd);
  const pid = child.pid ?? 0;
  opts.onEvent?.({ type: "launch", pid, command: opts.bin, args: fullArgs });
  return pid;
}

// ---- stop --------------------------------------------------------------

export interface StopServerOptions {
  key: WorkloadKey;
  resolved?: ResolvedEnv;
  /** Max seconds to wait for SIGTERM to take effect before SIGKILL. */
  graceSeconds?: number;
}

export interface StopServerResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

/**
 * Stop the tracked llama-server. First tries SIGTERM against the PID
 * in the PID file, then escalates to SIGKILL if the process is still
 * alive after the grace period. Clears the PID file on exit.
 */
export async function stopServer(opts: StopServerOptions): Promise<StopServerResult> {
  const resolved = opts.resolved ?? resolveEnv();
  const key = opts.key;
  const grace = Math.max(1, opts.graceSeconds ?? 5);
  const pid = readServerPid(key, resolved);
  if (pid === null || !isProcessAlive(pid)) {
    removeServerPid(resolved, key);
    removeServerState(resolved, key);
    return { stopped: true, pid, killed: false };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removeServerPid(resolved, key);
    removeServerState(resolved, key);
    return { stopped: true, pid, killed: false };
  }

  for (let i = 0; i < grace; i += 1) {
    if (!isProcessAlive(pid)) {
      removeServerPid(resolved, key);
      removeServerState(resolved, key);
      return { stopped: true, pid, killed: false };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // process already gone
  }
  removeServerPid(resolved, key);
  removeServerState(resolved, key);
  return { stopped: true, pid, killed: true };
}
