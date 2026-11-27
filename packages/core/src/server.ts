import type { ChildProcess } from "node:child_process";
import type { BigIntStats } from "node:fs";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

import type { ModelHostReadiness } from "./engines/types.js";
import type { ResolvedEnv } from "./types.js";
import type { WorkloadKey } from "./workloadRuntime.js";

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
import { resolveDraftModelPathArgs } from "./engines/llamacpp.js";
import {
  awaitScopeExec,
  buildScopeArgv,
  describeScopeOutcome,
  type EngineScopeLauncher,
  getEngineScopeLauncher,
  isScopeFallback,
  isScopeUnit,
  readScopePending,
  removeScopePendingIfOwned,
  scopeStopNames,
  scopeUnitBase,
  scopeWrapperExpectation,
  shapeScopeEnv,
  writeScopePending,
  writeScopeStop,
} from "./engines/scope.js";
import { isModelHostReadiness } from "./engines/state.js";
import { resolveEnv } from "./env.js";
import { atomicWriteFile } from "./fsAtomic.js";
import {
  defaultReadProcessCommand,
  parseSlotSavePathFromCommand,
  resolveSlotSavePathArgs,
} from "./kvstore/index.js";
import { omitUndefined } from "./object.js";
import {
  type CommandExpectation,
  isRecordedPidGone,
  type PidIdentityDeps,
  terminateVerifiedPid,
  verifyPidFile,
} from "./pidIdentity.js";
import { findTcpListenerPid, probeHealthEndpoint } from "./probe.js";
import {
  type DrainToken,
  getResidencyLeaseRegistry,
  type ResidencyLeases,
  withReopenAfterLoad,
} from "./residency/leases.js";
import { managedRuntimeRefusesMutation } from "./residency/managed-runtime.js";
import { currentSessionRefcounts, type SessionRefcounts } from "./residency/sessions.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "./safe-fs.js";
import { resolveTarget } from "./target.js";
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
    const flag = profileArgs[i];
    if (flag === undefined) continue;
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
  return `http://${host}:${String(port)}`;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

/**
 * Turn a bind host into something a remote caller can actually dial.
 * Wildcards ("any interface") are never dialable, so they collapse
 * to the advertised host, then the configured host, then loopback.
 */
export function dialableHost(host: string, resolved: ResolvedEnv): string {
  if (!isWildcardHost(host)) return host;
  if (resolved.LLAMA_CPP_ADVERTISED_HOST) return resolved.LLAMA_CPP_ADVERTISED_HOST;
  if (!isWildcardHost(resolved.LLAMA_CPP_HOST)) return resolved.LLAMA_CPP_HOST;
  return "127.0.0.1";
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
  /* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Empty string means "fall back to bind host" for advertised host. */
  const host =
    resolved.LLAMA_CPP_ADVERTISED_HOST ||
    dialableHost(override?.host || resolved.LLAMA_CPP_HOST, resolved);
  /* eslint-enable @typescript-eslint/prefer-nullish-coalescing */
  const port = override?.port ?? resolved.LLAMA_CPP_PORT;
  return `http://${host}:${String(port)}`;
}

function useTunedArgsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["LLAMA_CPP_USE_TUNED_ARGS"] ?? "true";
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
  writeFileSync(pidFile(resolved, key), `${String(pid)}\n`);
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
  /**
   * Declared serving probe copied from ModelRun spec.readiness (#220) and
   * consumed by listLocalRoutes to gate the route's listing and routing.
   * Absent keeps today's behaviour.
   */
  readiness?: ModelHostReadiness;
  /**
   * Hash of the launch-affecting fields at the time the sidecar was written
   * (#806 phase 2). A re-start with an unchanged hash adopts the live engine
   * instead of restarting it; a legacy sidecar without it restarts.
   */
  specHash?: string;
  /** Keep crash/stop evidence without advertising a generation that is still pending admission. */
  publicationPending?: true;
  /**
   * Transient systemd user-scope unit a scoped ModelRun launch recorded
   * (#806 phase 3). Informational: status and stop act on the pid. Absent on
   * direct (macOS, unpublished launcher, or fallback) launches.
   */
  scopeUnit?: string;
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
   * pid of the process actually holding the port that answered /health,
   * resolved via lsof. null when no endpoint answered or the listener
   * could not be identified.
   */
  listenerPid: number | null;
  /**
   * True when an HTTP endpoint answers on this workload's recorded (or
   * default) port but the pid bound there is not the recorded live pid —
   * i.e. a process llamactl did not start is squatting the port.
   * `listLocalRoutes` drops such a workload from routing, so callers must
   * surface this as a distinct state (e.g. phase "Foreign") rather than a
   * misleading Running or a silent Stopped.
   */
  foreign: boolean;
  /**
   * True when a pid record exists but its identity cannot be proven (the
   * 'unknown' verdict): pid is null and state may read 'down', but the
   * process may still be resident, so callers must not treat it as stopped.
   */
  identityUnknown?: boolean;
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
 * Whether a sidecar `port` value parses to a finite number. Ports are
 * persisted as numeric strings (`ServerState.port: string`), but tolerate a
 * JSON number too — the downstream consumer already does
 * `Number.parseInt(sidecar.port, 10)`, which coerces both. Rejects undefined,
 * non-numeric strings, and any other shape so a corrupt sidecar fails closed.
 */
function portParsesFinite(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  return Number.isFinite(Number.parseInt(String(value), 10));
}

/**
 * Validate the load-bearing sidecar fields. Each element of `extraArgs` must be
 * a string (consumers call `startsWith` on them); `port` may be a string or a
 * JSON number but must parse to a finite number (the consumer runs
 * `Number.parseInt`), so a corrupt sidecar fails closed rather than flowing a
 * NaN into the health-probe URL.
 */
function serverStateShapeOk(parsed: ServerState): boolean {
  return (
    typeof parsed.rel === "string" &&
    Array.isArray(parsed.extraArgs) &&
    parsed.extraArgs.every((a) => typeof a === "string") &&
    typeof parsed.pid === "number" &&
    typeof parsed.startedAt === "string" &&
    typeof parsed.host === "string" &&
    parsed.host.length > 0 &&
    portParsesFinite(parsed.port)
  );
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
    if (!serverStateShapeOk(parsed)) return null;
    if (typeof parsed.binary !== "string") parsed.binary = "";
    parsed.slotSavePath = typeof parsed.slotSavePath === "string" ? parsed.slotSavePath : null;
    if (parsed.readiness !== undefined && !isModelHostReadiness(parsed.readiness)) {
      delete parsed.readiness;
    }
    if (!isScopeUnit(parsed.scopeUnit)) {
      delete parsed.scopeUnit;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeServerState(resolved: ResolvedEnv, key: WorkloadKey, state: ServerState): void {
  ensureWorkloadRuntimeDir(resolved, key);
  const write = state.publicationPending === true ? atomicWriteFile : writeFileSync;
  write(serverStateFile(resolved, key), JSON.stringify(state, null, 2));
}

function removeServerState(resolved: ResolvedEnv, key: WorkloadKey): void {
  try {
    unlinkSync(serverStateFile(resolved, key));
  } catch {
    // no-op
  }
}

/**
 * Which endpoint answered /health, if any: the primary probe target, or
 * — when it missed — the recorded sidecar endpoint. The fallback matters
 * because a dead recorded pid makes the primary probe fall back to the
 * env-default endpoint, which can miss a squatter bound to the port the
 * workload itself last used. Returns null when nothing answers.
 */
async function resolveAnsweredEndpoint(args: {
  reachable: boolean;
  probedHost: string;
  probedPort: number;
  sidecar: ServerState | null;
}): Promise<{ host: string; port: number } | null> {
  if (args.reachable) return { host: args.probedHost, port: args.probedPort };
  const { sidecar } = args;
  if (sidecar === null) return null;
  const sidecarPort = Number.parseInt(sidecar.port, 10);
  if (!Number.isFinite(sidecarPort)) return null;
  if (sidecar.host === args.probedHost && sidecarPort === args.probedPort) return null;
  const probe = await probeHealthEndpoint(sidecar.host, sidecarPort, { timeoutMs: 1500 });
  return probe.reachable ? { host: sidecar.host, port: sidecarPort } : null;
}

type SidecarStatusFields = Pick<
  ServerStatus,
  "binary" | "extraArgs" | "host" | "port" | "rel" | "startedAt" | "tunedProfile"
>;

/** Status fields derived from a trusted sidecar; empty defaults otherwise. */
function sidecarStatusFields(sidecar: ServerState | null, valid: boolean): SidecarStatusFields {
  if (!valid || sidecar === null) {
    return {
      rel: null,
      extraArgs: [],
      startedAt: null,
      host: null,
      port: null,
      binary: null,
      tunedProfile: null,
    };
  }
  return {
    rel: sidecar.rel,
    extraArgs: sidecar.extraArgs,
    startedAt: sidecar.startedAt,
    host: sidecar.host,
    port: Number.parseInt(sidecar.port, 10) || null,
    binary: sidecar.binary || null,
    tunedProfile: sidecar.tunedProfile,
  };
}

/**
 * Report whether a local llama-server is reachable. Combines the stored
 * PID (if any, and alive) with a live `GET /health` probe so the status
 * reflects reality even when the PID file went stale from an unclean
 * shutdown.
 */
/**
 * Read the recorded server pid and verify it still names the process it was
 * recorded for. A provably-gone record (dead or recycled pid) is reaped; an
 * unverifiable one ("unknown") is kept — it may still be ours.
 */
function resolveTrackedServerPid(
  resolved: ResolvedEnv,
  key: WorkloadKey,
  identity?: PidIdentityDeps,
): { pid: number | null; identityUnknown: boolean } {
  const recorded = readServerPid(key, resolved);
  if (recorded === null) return { pid: null, identityUnknown: false };
  const verdict = verifyPidFile(pidFile(resolved, key), recorded, identity);
  if (isRecordedPidGone(verdict)) {
    removeServerPid(resolved, key);
    return { pid: null, identityUnknown: false };
  }
  if (verdict === "unknown") return { pid: null, identityUnknown: true };
  return { pid: recorded, identityUnknown: false };
}

export async function serverStatus(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
  identity?: PidIdentityDeps,
): Promise<ServerStatus> {
  const { pid, identityUnknown } = resolveTrackedServerPid(resolved, key, identity);
  const sidecar = readServerState(key, resolved);
  // Only trust the sidecar when its PID matches the live one; if the
  // PIDs diverge, the state file is from a previous launch that
  // exited uncleanly. Clean up in that case.
  const validSidecar = sidecar?.pid === pid;
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

  // An unverifiable record keeps its sidecar too: "unknown" must never reach
  // a delete, because the record may still belong to our process.
  if (sidecar && !validSidecar && state === "down" && !identityUnknown) {
    removeServerState(resolved, key);
  }

  // Squatter detection: a 200 on /health only proves *something* answers.
  // listLocalRoutes routes by the recorded pid, so whenever an endpoint
  // answers we resolve which pid actually holds the port — a listener
  // that isn't the recorded live pid means a foreign process owns the
  // endpoint.
  const answered = await resolveAnsweredEndpoint({
    reachable,
    probedHost: endpointOverride?.host ?? resolved.LLAMA_CPP_HOST,
    probedPort: Number.parseInt(endpointOverride?.port ?? resolved.LLAMA_CPP_PORT, 10),
    sidecar,
  });
  const listenerPid = answered ? await findTcpListenerPid(answered.host, answered.port) : null;
  // A null listenerPid is inconclusive (the listener may have exited
  // between the probe and the lsof lookup, or lsof may be unavailable):
  // only flag foreign when we positively resolved a different pid, or
  // when we recorded no live pid at all — then anything answering is
  // not ours by definition. While the tracked pid's identity is unknown
  // the endpoint may simply belong to our own unverifiable process, so
  // "foreign" stays inconclusive too.
  const foreign =
    answered !== null &&
    !identityUnknown &&
    (pid === null || (listenerPid !== null && listenerPid !== pid));

  return {
    state,
    endpoint: endpoint(resolved, endpointOverride),
    advertisedEndpoint: advertisedEndpoint(resolved, endpointOverride),
    pid,
    health: { httpCode, reachable },
    listenerPid,
    foreign,
    identityUnknown,
    ...sidecarStatusFields(sidecar, validSidecar),
  };
}

// ---- start/stop --------------------------------------------------------

export interface StartServerOptions {
  key: WorkloadKey;
  target: string;
  identity?: PidIdentityDeps;
  /**
   * Additional arguments appended to the llama-server invocation.
   * Relative `-md`/`--model-draft`/`--spec-draft-model`/`--dspark` values
   * (separate or `=` form) are resolved against `LLAMA_CPP_MODELS`, as `-m`
   * is; absolute paths pass through. Escapes are refused before any stop.
   */
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
  /**
   * Declared serving probe (#220) persisted into the sidecar for
   * readiness-gated listing and routing; startServer itself still waits
   * on /health.
   */
  readiness?: ModelHostReadiness;
  onEvent?: (e: ServerEvent) => void;
  /** A returned reason refuses publication of the freshly started process. */
  commitReadiness?: (pid: number) => string | undefined;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  /**
   * When set, aborts an in-flight start: SIGTERMs the first pid during its poll, nothing while the
   * mmproj retry is stopping it, and the retry pid during its poll, without waiting for exit. An
   * aborted start removes both tracking files and returns `pid: null`; a refused retry stop keeps
   * both files and its refused result even when aborted. The listener is removed before resolving.
   */
  signal?: AbortSignal;
  /**
   * Force a replacement even when a live, healthy engine with a matching spec
   * hash could be adopted (#806 phase 2). Set by the keepAlive worker on the
   * iteration after it saw the engine's health drop, so a process that answers
   * /health again before the restart is still replaced rather than adopted.
   */
  restart?: boolean;
  /**
   * Spawn seam for the engine (or the systemd-run wrapper). Defaults to
   * `node:child_process.spawn`. Tests inject a spy to observe the argv.
   */
  spawn?: typeof spawn;
  /**
   * Engine-scope launcher for Linux scoped launches (#806 phase 3). `undefined`
   * means the process-wide launcher (`getEngineScopeLauncher()`); an explicit
   * `null` forces a direct spawn.
   */
  engineScope?: EngineScopeLauncher | null;
}

interface ArtifactGeneration {
  readonly evidence: "filesystem-metadata";
  readonly generationDigest: string;
}

interface ModelRunArtifacts {
  readonly model: ArtifactGeneration;
  readonly binary: ArtifactGeneration;
}

interface PinnedModelRunStart {
  target: ResolvedLaunchTarget;
  prepared: PreparedLaunchArgs;
  childProcess: { env: NodeJS.ProcessEnv; cwd: string };
  artifacts: ModelRunArtifacts;
}

type ServerStartExecutionOptions = StartServerOptions & {
  pinned?: PinnedModelRunStart;
  checkSpawn?: () => string | undefined;
};

export interface PreparedManagedServerStart {
  readonly launch: {
    readonly rel: string;
    readonly modelPath: string;
    readonly binary: string;
    readonly args: readonly string[];
    readonly tunedProfile: string | null;
    readonly artifacts: ModelRunArtifacts;
  };
  readonly effectiveSpecDigest: string;
  artifactRefusal: () => string | undefined;
  /** Recheck owner policy synchronously at every spawn attempt, including retries and fallback. */
  start: (
    commitReadiness: NonNullable<StartServerOptions["commitReadiness"]>,
    checkSpawn?: () => string | undefined,
  ) => Promise<StartServerResult>;
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
  /**
   * Set only when the stop-before-start was refused: by a published
   * residency lease registry — `LeasesActive` while a lease is held,
   * `DrainInProgress` when a foreign drain already owns the workload
   * (Part of #278) — or by a published session refcount registry —
   * `SessionsActive` while a session is bound to the tracked running
   * instance, `SessionsUnknown` when the session registry could not
   * answer (Part of #520). `startServer` never reopens a workload whose
   * unload has been committed; reopening is the router's job.
   */
  refused?: StartResidencyRefusal;
  /**
   * Present and true only when a live, healthy engine with an unchanged spec
   * hash was adopted instead of stopped and respawned (#806 phase 2); a fresh
   * or drifted start leaves it absent.
   */
  adopted?: boolean;
}

/**
 * A residency refusal raised during stop-before-start by a published lease
 * registry (`LeasesActive` / `DrainInProgress`, Part of #278) or by a
 * published session refcount registry (`SessionsActive` while a session is
 * bound to the tracked running instance, `SessionsUnknown` when the session
 * check threw; Part of #520).
 */
export interface StartResidencyRefusal {
  reason: "LeasesActive" | "DrainInProgress" | "SessionsActive" | "SessionsUnknown";
  active: string[];
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
      `(HTTP ${String(res.status)} on /health) \u2014 stop the foreign process ` +
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

async function probeServerModelIds(endpointUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const res = await fetch(`${endpointUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : ""))
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
    const value = extraArgs[i + 1];
    if ((extraArgs[i] === "--alias" || extraArgs[i] === "-a") && value !== undefined) {
      out.push(value);
    }
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
  tunedProfile?: string | null;
  specHash?: string;
  /**
   * The argv tail (`assembleServerLaunchArgs`, everything after the binary) a
   * fresh launch of THIS spec would spawn. When supplied, `specHash` is stamped
   * only if the adopted listener's own command line matches it: a foreign engine
   * already bound to the port with different argv is recorded WITHOUT a
   * convergence hash, so the next same-manifest start replaces it instead of
   * adopting the stale launch (#806). Omit to stamp `specHash` unconditionally.
   */
  expectedLaunchArgs?: readonly string[];
  readiness?: ModelHostReadiness;
  deps?: Partial<AdoptDeps>;
}): Promise<number | null> {
  const probe = args.deps?.probeModelIds ?? probeServerModelIds;
  const find = args.deps?.findListenerPid ?? findTcpListenerPid;
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
  const argvMatches =
    args.expectedLaunchArgs === undefined ||
    launchArgvMatchesLaunchArgs(cmdline, args.expectedLaunchArgs);
  const adoptedSpecHash = args.specHash !== undefined && argvMatches ? args.specHash : undefined;
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
    tunedProfile: args.tunedProfile ?? null,
    ...(adoptedSpecHash !== undefined ? { specHash: adoptedSpecHash } : {}),
    ...(args.readiness !== undefined ? { readiness: args.readiness } : {}),
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

type HealthProbeOutcome =
  | { kind: "ready"; httpCode: string }
  | { kind: "exited"; httpCode: string | null }
  | { kind: "waiting"; httpCode: string | null; nonLoading: boolean };

/** One /health probe attempt. Emits the `waiting` event for non-terminal outcomes. */
async function probeHealthOnce(
  pid: number,
  healthUrl: string,
  attempt: number,
  onEvent?: (e: ServerEvent) => void,
): Promise<HealthProbeOutcome> {
  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    const httpCode = String(res.status);
    if (res.status === 200) return { kind: "ready", httpCode };
    // 503 is the documented "loading" code llama-server emits
    // while loading the model. Any other non-200 (401/403/404)
    // almost always means *something else* is bound to the same
    // port and we're polling the wrong process.
    if (res.status === 503) {
      onEvent?.({ type: "waiting", attempt, httpCode });
      return { kind: "waiting", httpCode, nonLoading: false };
    }
    if (!isProcessAlive(pid)) return { kind: "exited", httpCode };
    onEvent?.({ type: "waiting", attempt, httpCode });
    return { kind: "waiting", httpCode, nonLoading: true };
  } catch {
    if (!isProcessAlive(pid)) return { kind: "exited", httpCode: null };
    onEvent?.({ type: "waiting", attempt, httpCode: null });
    return { kind: "waiting", httpCode: null, nonLoading: false };
  }
}

/**
 * Interruptible sleep so SIGTERM + abort react within ~1s.
 *
 * pollReady loops over one long-lived signal, so the abort listener must
 * detach on EVERY resolve path (timer or abort), not just the abort path —
 * {once:true} only auto-detaches when abort fires, so the common timer path
 * would otherwise retain a listener per call (MaxListenersExceededWarning +
 * unbounded growth). Mirrors sleepWithAbort in keepAlive.ts.
 *
 * Exported as a test seam so the listener-balance can be asserted directly.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function pollTimedOutResult(
  pid: number,
  lastHttpCode: string | null,
  nonLoadingHttpCount: number,
  timeoutSeconds: number,
): PollReadyResult {
  const alive = isProcessAlive(pid);
  const portConflict = nonLoadingHttpCount >= Math.max(3, timeoutSeconds - 1);
  const result: PollReadyResult = {
    outcome: alive ? "timeout" : "exited",
  };
  if (lastHttpCode !== null) result.lastHttpCode = lastHttpCode;
  if (portConflict) result.portConflict = true;
  return result;
}

function exitedResult(lastHttpCode: string | null): PollReadyResult {
  return { outcome: "exited", ...(lastHttpCode !== null ? { lastHttpCode } : {}) };
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
    const probe = await probeHealthOnce(pid, healthUrl, attempt, onEvent);
    lastHttpCode = probe.httpCode ?? lastHttpCode;
    if (probe.kind === "ready") return { outcome: "ready", lastHttpCode: probe.httpCode };
    if (probe.kind === "exited") return exitedResult(lastHttpCode);
    if (probe.nonLoading) nonLoadingHttpCount += 1;
    await abortableSleep(1000, signal);
  }
  if (signal?.aborted) return { outcome: "aborted" };
  return pollTimedOutResult(pid, lastHttpCode, nonLoadingHttpCount, timeoutSeconds);
}

/** Build the success result for `startServer`, emitting the `ready` event. */
function startServerSuccess(
  resolved: ResolvedEnv,
  launchEndpoint: StartServerOptions["endpoint"],
  tunedProfile: string | null,
  retried: boolean,
  pid: number,
  onEvent?: (e: ServerEvent) => void,
): StartServerResult {
  onEvent?.({ type: "ready", pid, endpoint: endpoint(resolved, launchEndpoint) });
  return {
    ok: true,
    pid,
    endpoint: endpoint(resolved, launchEndpoint),
    advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
    tunedProfile,
    retried,
  };
}

/** Build a failure result for `startServer`. */
function startServerError(
  resolved: ResolvedEnv,
  launchEndpoint: StartServerOptions["endpoint"],
  tunedProfile: string | null,
  retried: boolean,
  error: string,
  pid: number | null = null,
  refused?: StartResidencyRefusal,
): StartServerResult {
  return {
    ok: false,
    pid,
    endpoint: endpoint(resolved, launchEndpoint),
    advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
    tunedProfile,
    retried,
    error,
    ...(refused !== undefined ? { refused } : {}),
  };
}

/** Build the success result for an adopted (#806 phase 2) `startServer`. */
function startServerAdopted(
  resolved: ResolvedEnv,
  launchEndpoint: StartServerOptions["endpoint"],
  tunedProfile: string | null,
  pid: number,
  onEvent?: (e: ServerEvent) => void,
): StartServerResult {
  onEvent?.({ type: "ready", pid, endpoint: endpoint(resolved, launchEndpoint) });
  return {
    ok: true,
    pid,
    endpoint: endpoint(resolved, launchEndpoint),
    advertisedEndpoint: advertisedEndpoint(resolved, launchEndpoint),
    tunedProfile,
    retried: false,
    adopted: true,
  };
}

interface ResolvedLaunchTarget {
  rel: string;
  modelPath: string;
  bin: string;
  draftResolvedExtraArgs: string[];
}

/**
 * Resolve the start target to a rel + model path + binary, failing
 * fast (as a ready-to-return `StartServerResult`) when any of them
 * is missing on disk or the host bind is refused.
 */
function resolveAndValidateTarget(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  launchEndpoint: StartServerOptions["endpoint"],
  env: NodeJS.ProcessEnv,
  launchHost: string,
): ResolvedLaunchTarget | { result: StartServerResult } {
  const rel = resolveTarget(opts.target, env);
  if (!rel) {
    return {
      result: startServerError(
        resolved,
        launchEndpoint,
        null,
        false,
        `Unknown target: ${opts.target}`,
      ),
    };
  }
  const modelPath = join(resolved.LLAMA_CPP_MODELS, rel);
  if (!existsSync(modelPath)) {
    return {
      result: startServerError(
        resolved,
        launchEndpoint,
        null,
        false,
        `Model file not found: ${modelPath}`,
      ),
    };
  }
  const bin = opts.binary ?? join(resolved.LLAMA_CPP_BIN, "llama-server");
  if (!existsSync(bin)) {
    return {
      result: startServerError(
        resolved,
        launchEndpoint,
        null,
        false,
        `llama-server binary not found: ${bin}`,
      ),
    };
  }
  // Refuse before stopServer or the port probe: a refused start must not stop the running instance, and the refusal must not depend on what answers on the port.
  const bindRefusal = hostBindRefusal(opts.extraArgs ?? [], launchHost, opts.allowExternalBind);
  if (bindRefusal !== null) {
    return { result: startServerError(resolved, launchEndpoint, null, false, bindRefusal) };
  }
  // Same pre-stop guarantee as the bind refusal (#516): a relative draft-model
  // path that escapes the models dir is refused before stopServer and the port
  // probe, so a bad manifest never disturbs the running instance.
  try {
    const draftResolvedExtraArgs = resolveDraftModelPathArgs(
      opts.extraArgs ?? [],
      resolved.LLAMA_CPP_MODELS,
    );
    return { rel, modelPath, bin, draftResolvedExtraArgs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: startServerError(resolved, launchEndpoint, null, false, message) };
  }
}

interface PreparedLaunchArgs {
  launchArgs: string[];
  tunedProfile: string | null;
  slotPathResolved: { args: string[]; slotSavePath: string | null };
}

/**
 * The bench-profile name a launch would resolve, or null when tuned args are
 * skipped/disabled or no row matches. Shared by `buildLaunchArgs` (which turns
 * it into argv) and the spec-hash inputs (which hash the resolved name, not
 * the request), so launch and adoption always agree on the profile.
 */
function resolvedTunedProfile(
  opts: StartServerOptions,
  rel: string,
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv,
  draftResolvedExtraArgs: readonly string[],
): string | null {
  if (opts.skipTuned || !useTunedArgsEnabled(env)) return null;
  const mode = hasMmprojArg(draftResolvedExtraArgs) ? "vision" : defaultModeForRel(rel, resolved);
  const ctx = ctxForModel(rel, resolved);
  const build = resolveBuildId(resolved);
  const machine = machineLabel(resolved);
  const rows = readBenchProfiles(benchProfileFile(resolved));
  const hit = findLatestProfile(rows, { machine, rel, mode, ctx, build });
  return hit === null ? null : hit.profile;
}

/**
 * Pure launch-args assembly: profile args (filtered against the user's
 * extraArgs), then the slot-save-path-resolved extraArgs. No filesystem
 * writes — `prepareLaunchArgs` adds the slot-dir mkdir on top.
 */
function buildLaunchArgs(
  opts: StartServerOptions,
  rel: string,
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv,
  key: WorkloadKey,
  draftResolvedExtraArgs: readonly string[],
): PreparedLaunchArgs {
  const tunedProfile = resolvedTunedProfile(opts, rel, resolved, env, draftResolvedExtraArgs);
  const slotPathResolved = resolveSlotSavePathArgs(
    draftResolvedExtraArgs,
    resolved.LOCAL_AI_RUNTIME_DIR,
    key.name,
  );
  const profileArgs = serverProfileArgs(tunedProfile ?? "default")
    .split(/\s+/)
    .filter(Boolean);
  const launchArgs: string[] = [];
  launchArgs.push(...filterProfileArgs(profileArgs, slotPathResolved.args));
  launchArgs.push(...slotPathResolved.args);
  return { launchArgs, tunedProfile, slotPathResolved };
}

/**
 * Tuned-profile lookup. Profile args are skipped when the user has
 * already specified the same flag in extraArgs, so a manifest that
 * sets e.g. `-ub 1024` isn't doubled up with the profile's `-ub 512`.
 */
function prepareLaunchArgs(prepared: PreparedLaunchArgs): PreparedLaunchArgs {
  if (prepared.slotPathResolved.slotSavePath !== null) {
    mkdirSync(prepared.slotPathResolved.slotSavePath, { recursive: true });
  }
  return prepared;
}

interface MmprojRetryContext {
  target: ResolvedLaunchTarget;
  prepared: PreparedLaunchArgs;
  resolved: ResolvedEnv;
  key: WorkloadKey;
  launchEndpoint: StartServerOptions["endpoint"];
  launchHost: string;
  launchPort: number | string;
  healthUrl: string;
  timeoutSeconds: number;
  abortKiller: AbortKiller;
  firstPid: number;
}

type MmprojRetryOutcome =
  | {
      /** Final ready, aborted (during the retry poll or before relaunch), or refused result. */
      result: StartServerResult;
      readyResult: PollReadyResult;
    }
  | { result: null; readyResult: PollReadyResult; retryPid: number };

interface AbortKiller {
  targetPid: number | null;
  kill: () => void;
}

/**
 * Per-start abort handler. `kill` SIGTERMs `targetPid` if it is still alive. A null target
 * (disarmed, a launch pid <= 0, or a scope child already reaped) signals nothing.
 * startServer re-points `targetPid` as
 * ownership moves from the first launch to the retry.
 */
function createAbortKiller(pid: number | null): AbortKiller {
  const killer: AbortKiller = {
    targetPid: pid !== null && pid > 0 ? pid : null,
    kill: (): void => {
      const targetPid = killer.targetPid;
      if (targetPid === null) return;
      try {
        if (isProcessAlive(targetPid)) process.kill(targetPid, "SIGTERM");
      } catch {
        // already gone
      }
    },
  };
  return killer;
}

function abortedStartResult(
  opts: StartServerOptions,
  ctx: Pick<MmprojRetryContext, "resolved" | "key" | "launchEndpoint" | "prepared" | "abortKiller">,
  retried: boolean,
  pid: number | null,
): StartServerResult {
  opts.signal?.removeEventListener("abort", ctx.abortKiller.kill);
  ctx.abortKiller.targetPid = null;
  try {
    if (pid !== null && pid > 0 && isProcessAlive(pid)) process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  removeServerPid(ctx.resolved, ctx.key);
  removeServerState(ctx.resolved, ctx.key);
  return startServerError(
    ctx.resolved,
    ctx.launchEndpoint,
    ctx.prepared.tunedProfile,
    retried,
    "Start aborted by caller",
  );
}

/**
 * ServerState sidecar for a launch startServer performed. Shared by the first launch
 * and the mmproj retry so a new sidecar field is set in exactly one place.
 */
/**
 * Hash of the launch-affecting ModelRun fields (#806 phase 2), computed the same
 * way at launch (`launchedServerState`), at re-start (`adoptTrackedServer`) and
 * at port-conflict adoption (`handlePortConflict`) so a re-start can tell an
 * unchanged launch from a drifted one. Covers every input that moves the spawned
 * argv: the rel, the absolute model path, skipTuned, the resolved tuned profile,
 * the alias launchBackground injects when extraArgs has none, the raw
 * extraArgs, the bind host/port and the binary. Deliberately excludes the
 * readiness probe (out-of-hash, like ModelHost) and env/apiKeyRef, which the
 * sidecar does not fully capture. Consumers compare the string; they never
 * inspect its shape.
 */
interface ServerSpecHashInput {
  rel: string;
  modelPath: string;
  skipTuned: boolean;
  tunedProfile: string | null;
  alias: string | null;
  extraArgs: readonly string[];
  host: string;
  port: string;
  binary: string;
}

function computeServerSpecHash(spec: ServerSpecHashInput): string {
  return JSON.stringify({
    rel: spec.rel,
    modelPath: spec.modelPath,
    skipTuned: spec.skipTuned,
    tunedProfile: spec.tunedProfile,
    alias: spec.alias,
    extraArgs: [...spec.extraArgs],
    host: spec.host,
    port: spec.port,
    binary: spec.binary,
  });
}

/**
 * Every hash input except `rel`, shared by the launch sidecar write and the
 * adoption/port-conflict hash so the three sites can never drift apart. `alias`
 * mirrors launchBackground: the configured alias is injected only when the
 * final argv carries no --alias/-a of its own.
 */
function launchSpecHashFields(
  opts: StartServerOptions,
  target: ResolvedLaunchTarget,
  prepared: PreparedLaunchArgs,
  resolved: ResolvedEnv,
  launchHost: string,
  launchPort: number | string,
): Omit<ServerSpecHashInput, "rel"> {
  return {
    modelPath: target.modelPath,
    skipTuned: opts.skipTuned === true,
    tunedProfile: prepared.tunedProfile,
    alias: hasFlag(prepared.launchArgs, "--alias", "-a") ? null : resolved.LLAMA_CPP_SERVER_ALIAS,
    extraArgs: opts.extraArgs ?? [],
    host: launchHost,
    port: String(launchPort),
    binary: target.bin,
  };
}

/**
 * The spec hash plus the resolved tuned profile for a launch shape, computed
 * without the slot-dir mkdir side effect of `prepareLaunchArgs`. Used by the
 * adoption check and the port-conflict adopt, which run before (and instead
 * of) a real launch.
 */
function launchSpecParts(
  opts: StartServerOptions,
  target: ResolvedLaunchTarget,
  resolved: ResolvedEnv,
  env: NodeJS.ProcessEnv,
  key: WorkloadKey,
  launchHost: string,
  launchPort: number | string,
): { specHash: string; tunedProfile: string | null; launchArgs: string[] } {
  const prepared = buildLaunchArgs(
    opts,
    target.rel,
    resolved,
    env,
    key,
    target.draftResolvedExtraArgs,
  );
  const specHash = computeServerSpecHash({
    rel: target.rel,
    ...launchSpecHashFields(opts, target, prepared, resolved, launchHost, launchPort),
  });
  return { specHash, tunedProfile: prepared.tunedProfile, launchArgs: prepared.launchArgs };
}

function launchedServerState(
  opts: StartServerOptions,
  target: ResolvedLaunchTarget,
  prepared: PreparedLaunchArgs,
  resolved: ResolvedEnv,
  launchHost: string,
  launchPort: number | string,
  pid: number,
  scopeUnit?: string,
): ServerState {
  return {
    rel: target.rel,
    extraArgs: opts.extraArgs ?? [],
    slotSavePath: prepared.slotPathResolved.slotSavePath,
    host: launchHost,
    port: String(launchPort),
    binary: target.bin,
    pid,
    startedAt: new Date().toISOString(),
    tunedProfile: prepared.tunedProfile,
    ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
    ...(opts.commitReadiness === undefined ? {} : { publicationPending: true }),
    specHash: computeServerSpecHash({
      rel: target.rel,
      ...launchSpecHashFields(opts, target, prepared, resolved, launchHost, launchPort),
    }),
    ...(scopeUnit !== undefined ? { scopeUnit } : {}),
  };
}

/**
 * Decide how a residency registry fences a stop-before-start (Part of #278).
 * A drain that finds held leases is refused and immediately cancelled so the
 * running instance is never disturbed; a foreign drain already in progress is
 * refused without touching its token; an unloaded workload is unfenced.
 */
type StartDrainDecision =
  | { kind: "refused"; refused: StartResidencyRefusal }
  | { kind: "drained"; token: DrainToken }
  | { kind: "unfenced" };

function beginStartDrain(registry: ResidencyLeases, workload: string): StartDrainDecision {
  const drain = registry.beginDrain(workload);
  if (drain.ok) {
    if (drain.active.length > 0) {
      registry.cancelDrain(drain.token);
      return { kind: "refused", refused: { reason: "LeasesActive", active: drain.active } };
    }
    return { kind: "drained", token: drain.token };
  }
  if (drain.reason === "AlreadyDraining") {
    return {
      kind: "refused",
      refused: { reason: "DrainInProgress", active: registry.active(workload) },
    };
  }
  return { kind: "unfenced" };
}

type FencedStopResult =
  | { refused: StartResidencyRefusal }
  | { refused: null; stopResult: StopServerResult };

/**
 * Whether the tracked instance is still worth protecting: "alive" and
 * "unknown" count as live (fail closed), while "dead" and "reused" do not.
 * A crashed or recycled instance has nothing to unload, so a session bound
 * to it must not block a restart.
 */
function trackedInstanceLive(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
): boolean {
  const pid = readServerPid(key, resolved);
  if (pid === null) return false;
  const verdict = verifyPidFile(
    pidFile(resolved, key),
    pid,
    trackedStopIdentity(resolved, key, opts.identity),
  );
  return !isRecordedPidGone(verdict);
}

/**
 * Read-only identity proof that a tracked ModelRun is down: a workload with no
 * recorded pid file, or whose recorded pid verifies `dead` or `reused` against
 * its pid file, is proven down. A live pid, or one whose identity cannot be
 * verified (`unknown`), fails closed. The predicate never deletes tracking
 * files, so it is safe to call outside a transaction and from boot recovery.
 */
export function isServerProvenDown(
  key: WorkloadKey,
  resolved: ResolvedEnv = resolveEnv(),
  identity?: PidIdentityDeps,
): boolean {
  const pid = readServerPid(key, resolved);
  if (pid === null) return true;
  return isRecordedPidGone(
    verifyPidFile(pidFile(resolved, key), pid, trackedStopIdentity(resolved, key, identity)),
  );
}

/**
 * Consult the session refcount registry under the DF-05 drain: a session
 * bound to the running instance refuses the restart, and a registry that
 * throws fails closed. Never passes `force` and never releases a session.
 * When no sessions are bound the refusal is skipped before any liveness
 * probe; when sessions are bound the objection is returned only while the
 * tracked instance is live, so a crashed instance never waits out the idle
 * window (Part of #520).
 */
function checkStartSessions(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
): StartResidencyRefusal | null {
  const sessions: SessionRefcounts | null = currentSessionRefcounts();
  if (sessions === null) return null;
  let objection: StartResidencyRefusal;
  try {
    const check = sessions.checkUnload(key.name);
    if (check.ok) return null;
    objection = { reason: "SessionsActive", active: [...check.sessions] };
  } catch {
    objection = { reason: "SessionsUnknown", active: [] };
  }
  return trackedInstanceLive(opts, resolved, key) ? objection : null;
}

/**
 * Run `stopServer` under the residency fence: with no registry, or for an
 * unfenced (unloaded) workload, stop as before; otherwise hold a drain for the
 * stop's duration and reopen admission in a finally, before the port probe and
 * launch. A refusal stops nothing.
 */
async function fencedStop(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
  registry: ResidencyLeases | null,
): Promise<FencedStopResult> {
  const stop = async (): Promise<StopServerResult> =>
    await stopServer({ key, resolved, ...omitUndefined({ identity: opts.identity }) });
  if (registry === null) return { refused: null, stopResult: await stop() };
  const decision = beginStartDrain(registry, key.name);
  if (decision.kind === "refused") return { refused: decision.refused };
  if (decision.kind === "unfenced") return { refused: null, stopResult: await stop() };
  // Session fence (#520): consulted in the same synchronous tick the drain was
  // acquired, so a bound session cannot slip in between the drain and the stop.
  const sessionRefusal = checkStartSessions(opts, resolved, key);
  if (sessionRefusal !== null) {
    registry.cancelDrain(decision.token);
    return { refused: sessionRefusal };
  }
  try {
    return { refused: null, stopResult: await stop() };
  } finally {
    registry.cancelDrain(decision.token);
  }
}

/**
 * Stop-before-start: bring down any previous instance under the residency
 * fence. Returns a refusal result when a published lease registry declined the
 * drain (`LeasesActive` / `DrainInProgress`), when a published session
 * refcount registry objected under that drain (`SessionsActive` while a session
 * is bound to the live tracked instance, `SessionsUnknown` when its check
 * threw; Part of #520), the existing identity-unknown refusal when the tracked
 * pid could not be verified, or null to proceed with the start.
 */
async function stopBeforeStart(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
  launchEndpoint: StartServerOptions["endpoint"],
): Promise<StartServerResult | null> {
  const fenced = await fencedStop(opts, resolved, key, getResidencyLeaseRegistry());
  if (fenced.refused !== null) {
    const sessionBound =
      fenced.refused.reason === "SessionsActive" || fenced.refused.reason === "SessionsUnknown";
    const tail = sessionBound
      ? "while a session is bound to its running instance"
      : "while residency leases are held";
    return startServerError(
      resolved,
      launchEndpoint,
      null,
      false,
      `${fenced.refused.reason}: ${fenced.refused.active.join(", ")} — refusing to start ${key.name} ${tail}`,
      null,
      fenced.refused,
    );
  }
  if (!fenced.stopResult.stopped) {
    return startServerError(
      resolved,
      launchEndpoint,
      null,
      false,
      `pid identity unknown for tracked pid ${String(fenced.stopResult.pid)} in ${pidFile(resolved, key)} — refusing to start over an unverifiable process`,
    );
  }
  return null;
}

/**
 * Fence the mmproj retry's stop. A refusal (before the retry event fires)
 * de-arms the abort killer, leaves both tracking files and the first pid in
 * place, and returns the refused result. Otherwise this emits the `retry`
 * event, runs the fenced stop, and reports whether the stop verified: null
 * means the caller proceeds, a StartServerResult is the identity-unknown
 * refusal for the retry path.
 */
async function stopForMmprojRetry(
  opts: StartServerOptions,
  ctx: MmprojRetryContext,
): Promise<MmprojRetryOutcome | { stopOk: boolean }> {
  const { resolved, key, launchEndpoint, prepared, abortKiller } = ctx;
  const registry = getResidencyLeaseRegistry();
  const decision: StartDrainDecision =
    registry === null ? { kind: "unfenced" } : beginStartDrain(registry, key.name);
  if (decision.kind === "refused") {
    abortKiller.targetPid = null;
    opts.signal?.removeEventListener("abort", abortKiller.kill);
    return {
      result: startServerError(
        resolved,
        launchEndpoint,
        prepared.tunedProfile,
        false,
        `${decision.refused.reason}: ${decision.refused.active.join(", ")} — refusing mmproj retry for ${key.name} while residency leases are held`,
        ctx.firstPid,
        decision.refused,
      ),
      readyResult: { outcome: "timeout" },
    };
  }
  abortKiller.targetPid = null;
  opts.onEvent?.({ type: "retry", reason: "mmproj safe-flag retry" });
  const stopResult =
    decision.kind === "drained" && registry !== null
      ? await fencedStopDrained(opts, resolved, key, registry, decision.token)
      : await stopServer({ key, resolved, ...omitUndefined({ identity: opts.identity }) });
  if (!stopResult.stopped) {
    opts.signal?.removeEventListener("abort", abortKiller.kill);
    return { stopOk: false };
  }
  return { stopOk: true };
}

async function fencedStopDrained(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
  registry: ResidencyLeases,
  token: DrainToken,
): Promise<StopServerResult> {
  try {
    return await stopServer({ key, resolved, ...omitUndefined({ identity: opts.identity }) });
  } finally {
    registry.cancelDrain(token);
  }
}

/**
 * Retry path: disarm the first pid, stop it, relaunch with mmproj-safe flags, restore both tracking
 * files and arm the retry pid, then poll again. Returns a final result for ready, aborted and refused
 * outcomes; timeout and exited fall through with the retry pid and updated readiness result.
 */
async function retryWithMmprojSafeFlags(
  opts: ServerStartExecutionOptions,
  ctx: MmprojRetryContext,
): Promise<MmprojRetryOutcome> {
  const { resolved, key, launchEndpoint, target, prepared } = ctx;
  const stopGate = await stopForMmprojRetry(opts, ctx);
  if ("result" in stopGate) return stopGate;
  if (!stopGate.stopOk) {
    return {
      result: startServerError(
        resolved,
        launchEndpoint,
        prepared.tunedProfile,
        true,
        `pid identity unknown for ${pidFile(resolved, key)} — refusing mmproj retry over an unverifiable process`,
      ),
      readyResult: { outcome: "timeout" },
    };
  }
  if (opts.signal?.aborted) {
    return {
      result: abortedStartResult(opts, ctx, true, null),
      readyResult: { outcome: "aborted" },
    };
  }
  const retryArgs = [...prepared.launchArgs, ...safeRetryArgs()];
  const retryLaunch = await launchAndRecordServer(
    opts,
    resolved,
    target,
    prepared,
    ctx.launchHost,
    ctx.launchPort,
    retryArgs,
  );
  const retryPid = retryLaunch.pid;
  ctx.abortKiller.targetPid = signalableLaunchPid(retryLaunch);
  const readyResult = await pollReady(
    retryPid,
    ctx.healthUrl,
    ctx.timeoutSeconds,
    opts.onEvent,
    opts.signal,
  );
  if (readyResult.outcome === "aborted") {
    return {
      result: abortedStartResult(opts, ctx, true, signalableLaunchPid(retryLaunch)),
      readyResult,
    };
  }
  if (readyResult.outcome === "ready") {
    opts.signal?.removeEventListener("abort", ctx.abortKiller.kill);
    return {
      result: startServerSuccess(
        resolved,
        launchEndpoint,
        prepared.tunedProfile,
        true,
        retryPid,
        opts.onEvent,
      ),
      readyResult,
    };
  }
  return { result: null, readyResult, retryPid };
}

/**
 * #806 phase 2: adopt the tracked ModelRun instead of restarting it. A re-start
 * whose desired launch matches the recorded spec hash, whose tracked pid verifies
 * `alive` against its pid file, and whose /health answers 200 leaves the running
 * engine untouched: same pid, the pid and sidecar files left byte-for-byte
 * intact, `adopted: true`. Ownership is proven by the pid identity check (the
 * recorded pid must match our binary and rel on argv, so a foreign squatter on
 * the port is never adopted) rather than an HTTP model probe, which can lag the
 * launch spec. Returns null to fall through to the normal stop-then-spawn path
 * on any of: an explicit `restart: true`, a missing sidecar, a legacy sidecar
 * without a hash, a drifted hash, a pid that is dead or whose identity cannot be
 * proven (fail closed), or a /health miss (the G8 unhealthy case). Mirrors
 * ModelHost `adoptUnchangedHost`.
 */
async function adoptTrackedServer(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
  launchEndpoint: StartServerOptions["endpoint"],
  target: ResolvedLaunchTarget,
  launchHost: string,
  launchPort: number | string,
): Promise<StartServerResult | null> {
  if (opts.restart === true) return null;
  // A published registry that is not open (draining or committed-unloaded)
  // must not get an adopted engine back: adoption would hand
  // withReopenAfterLoad an "unchanged" result for a workload whose admission
  // is closed. Decline so the start falls through to the fenced stop/start,
  // which reopens admission only through a real load.
  const registry = getResidencyLeaseRegistry();
  if (registry !== null && registry.snapshot(key.name).phase !== "open") return null;
  const sidecar = readServerState(key, resolved);
  if (sidecar === null) return null;
  const { specHash: currentHash } = launchSpecParts(
    opts,
    target,
    resolved,
    opts.env ?? process.env,
    key,
    launchHost,
    launchPort,
  );
  if (sidecar.specHash === undefined || sidecar.specHash !== currentHash) return null;
  const verdict = verifyPidFile(
    pidFile(resolved, key),
    sidecar.pid,
    trackedStopIdentity(resolved, key, opts.identity),
  );
  if (verdict !== "alive") return null;
  const health = await probeHealthEndpoint(launchHost, Number(launchPort), {
    timeoutMs: ADOPT_PROBE_TIMEOUT_MS,
  });
  if (!health.reachable) return null;
  if (!isProcessAlive(sidecar.pid)) return null;
  return startServerAdopted(
    resolved,
    launchEndpoint,
    sidecar.tunedProfile,
    sidecar.pid,
    opts.onEvent,
  );
}

/**
 * Pre-start gate: adopt the tracked engine when its spec is unchanged and it is
 * healthy (#806 phase 2), otherwise stop any prior instance under the residency
 * lease fence. Returns a result the caller returns verbatim (an adopted result,
 * or a stop refusal) or null to proceed to spawn.
 */
async function stopOrAdoptBeforeStart(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  key: WorkloadKey,
  launchEndpoint: StartServerOptions["endpoint"],
  target: ResolvedLaunchTarget,
  launchHost: string,
  launchPort: number | string,
): Promise<StartServerResult | null> {
  if (opts.commitReadiness !== undefined) {
    return isServerProvenDown(key, resolved, opts.identity)
      ? null
      : startServerError(resolved, launchEndpoint, null, false, "ManagedRestartUnavailable");
  }
  const adopted = await adoptTrackedServer(
    opts,
    resolved,
    key,
    launchEndpoint,
    target,
    launchHost,
    launchPort,
  );
  if (adopted !== null) return adopted;
  return await stopBeforeStart(opts, resolved, key, launchEndpoint);
}

/**
 * Pre-flight port-collision check. After our own stopServer, the
 * configured port should be free. If something still answers on
 * /health, it's a foreign process (Colima docker forwards, an old
 * Ollama, a stray docker container) and llama-server's bind would
 * either fail silently or land on a duplicate port that the
 * readiness probe would never resolve correctly. Fail fast with
 * the offending HTTP code so the operator knows what to kill.
 * Returns null when the port is clear and the start should proceed.
 */
async function handlePortConflict(
  opts: StartServerOptions,
  resolved: ResolvedEnv,
  launchEndpoint: StartServerOptions["endpoint"],
  target: ResolvedLaunchTarget,
  launchHost: string,
  launchPort: number | string,
): Promise<StartServerResult | null> {
  const portConflictHint = await detectPortConflict(endpoint(resolved, launchEndpoint));
  if (!portConflictHint) return null;
  if (opts.commitReadiness !== undefined) {
    return startServerError(resolved, launchEndpoint, null, false, portConflictHint);
  }
  // Something already answers on our endpoint. If it's serving OUR model,
  // adopt it (record pid + state so it's managed + routable) instead of
  // failing — a spawn could not win the held port anyway. Only a genuine
  // foreign listener falls through to the error. The sidecar must carry the
  // same specHash a fresh launch would write, or the next same-spec start
  // would bounce this engine instead of adopting it.
  const specParts = launchSpecParts(
    opts,
    target,
    resolved,
    opts.env ?? process.env,
    opts.key,
    launchHost,
    launchPort,
  );
  const expectedLaunchArgs = assembleServerLaunchArgs(
    target.modelPath,
    resolved,
    specParts.launchArgs,
    launchHost,
    launchPort,
  );
  const adoptedPid = await tryAdoptExistingServer({
    resolved,
    key: opts.key,
    endpointUrl: endpoint(resolved, launchEndpoint),
    host: launchHost,
    port: Number(launchPort),
    rel: target.rel,
    extraArgs: opts.extraArgs ?? [],
    binary: target.bin,
    tunedProfile: specParts.tunedProfile,
    specHash: specParts.specHash,
    expectedLaunchArgs,
    ...(opts.readiness !== undefined ? { readiness: opts.readiness } : {}),
  });
  if (adoptedPid !== null) {
    return startServerSuccess(resolved, launchEndpoint, null, false, adoptedPid, opts.onEvent);
  }
  return startServerError(resolved, launchEndpoint, null, false, portConflictHint);
}

/** Remove the pid, state and pending records only if `pid` is still the tracked one. */
function removeServerRecordIfOwned(resolved: ResolvedEnv, key: WorkloadKey, pid: number): void {
  if (readServerPid(key, resolved) !== pid) return;
  removeServerPid(resolved, key);
  removeServerState(resolved, key);
  try {
    unlinkSync(join(workloadRuntimeDir(resolved, key), "llama-server.scope-pending"));
  } catch {
    // no-op
  }
}

interface ScopePlan {
  systemdRunPath: string;
  base: string;
  env: NodeJS.ProcessEnv;
}

// Resolve whether this ModelRun launch runs in its own systemd user scope. A
// null launcher, a null override, an env-conflict, or a failed capability
// resolve all mean a direct spawn; the direct argv stays byte-identical.
async function resolveScopePlan(
  opts: ServerStartExecutionOptions,
  forceDirect: boolean,
): Promise<{ launcher: EngineScopeLauncher; plan: ScopePlan } | null> {
  if (forceDirect) return null;
  const launcher = opts.engineScope !== undefined ? opts.engineScope : getEngineScopeLauncher();
  if (launcher === null) return null;
  const env = opts.pinned?.childProcess.env ?? process.env;
  const shaped = shapeScopeEnv({ ...env }, env, []);
  if ("conflict" in shaped) {
    opts.onEvent?.({
      type: "retry",
      reason: `engine scope env-conflict (${shaped.conflict}); spawning directly`,
    });
    return null;
  }
  const resolved = await launcher.resolve(env);
  if (!resolved.ok) return null;
  return {
    launcher,
    plan: {
      systemdRunPath: resolved.systemdRunPath,
      base: scopeUnitBase(opts.key.name, launcher.unitSuffix()),
      env: shaped.env,
    },
  };
}

interface RecordedServerLaunch {
  pid: number;
  /** True once the child has been reaped, so its pid must never be signalled. */
  reaped: boolean;
}

function signalableLaunchPid(launch: RecordedServerLaunch): number | null {
  if (launch.reaped || launch.pid <= 0) return null;
  return launch.pid;
}

/** Spawn llama-server detached and record the pid + state sidecars. */
async function launchAndRecordServer(
  opts: ServerStartExecutionOptions,
  resolved: ResolvedEnv,
  target: ResolvedLaunchTarget,
  prepared: PreparedLaunchArgs,
  launchHost: string,
  launchPort: number | string,
  args: string[],
  forceDirect = false,
): Promise<RecordedServerLaunch> {
  const scoped = await resolveScopePlan(opts, forceDirect);
  const launched = await launchBackground({
    bin: target.bin,
    modelPath: target.modelPath,
    args,
    resolved,
    key: opts.key,
    ...omitUndefined({ allowExternalBind: opts.allowExternalBind }),
    host: launchHost,
    port: launchPort,
    ...omitUndefined({ onEvent: opts.onEvent }),
    ...omitUndefined({ spawn: opts.spawn, pinned: opts.pinned, checkSpawn: opts.checkSpawn }),
    scope: scoped?.plan ?? null,
  });
  if (scoped === null || launched.scope === null) {
    writeServerPid(resolved, opts.key, launched.pid);
    writeServerState(
      resolved,
      opts.key,
      launchedServerState(opts, target, prepared, resolved, launchHost, launchPort, launched.pid),
    );
    return { pid: launched.pid, reaped: false };
  }
  return await recordScopedLaunch(
    opts,
    resolved,
    target,
    prepared,
    launchHost,
    launchPort,
    args,
    launched,
    scoped,
  );
}

// Scoped launch: write pid + state + pending, run the exec handshake, then the
// gated direct fallback (once) or return the wrapper pid. A non-established
// outcome that is not fallback-eligible leaves the (dead) pid recorded so
// pollReady reports the exit.
async function recordScopedLaunch(
  opts: ServerStartExecutionOptions,
  resolved: ResolvedEnv,
  target: ResolvedLaunchTarget,
  prepared: PreparedLaunchArgs,
  launchHost: string,
  launchPort: number | string,
  args: string[],
  launched: LaunchResult,
  scoped: { launcher: EngineScopeLauncher; plan: ScopePlan },
): Promise<RecordedServerLaunch> {
  const dir = workloadRuntimeDir(resolved, opts.key);
  const scopeUnit = launched.scope?.scopeUnit ?? "";
  if (launched.pid <= 0) {
    scoped.launcher.noteFailure();
    return await launchAndRecordServer(
      opts,
      resolved,
      target,
      prepared,
      launchHost,
      launchPort,
      args,
      true,
    );
  }
  writeServerPid(resolved, opts.key, launched.pid);
  writeServerState(
    resolved,
    opts.key,
    launchedServerState(
      opts,
      target,
      prepared,
      resolved,
      launchHost,
      launchPort,
      launched.pid,
      scopeUnit,
    ),
  );
  writeScopePending(dir, "llama-server", launched.pid, scopeUnit);
  const outcome = await awaitScopeExec({
    child: launched.child,
    pid: launched.pid,
    logPath: serverLog(resolved, opts.key),
    offset: launched.scope?.offset ?? 0,
    base: launched.scope?.base ?? "",
    timeoutMs: scoped.launcher.establishTimeoutMs,
    ...omitUndefined({ signal: opts.signal }),
  });
  removeScopePendingIfOwned(dir, "llama-server", launched.pid);
  const mayFallback =
    isScopeFallback(outcome) &&
    readServerPid(opts.key, resolved) === launched.pid &&
    !scopeStopNames(dir, "llama-server", scopeUnit) &&
    opts.signal?.aborted !== true;
  if (!mayFallback) {
    return {
      pid: launched.pid,
      reaped: launched.child.exitCode !== null || launched.child.signalCode !== null,
    };
  }
  removeServerRecordIfOwned(resolved, opts.key, launched.pid);
  scoped.launcher.noteFailure();
  opts.onEvent?.({
    type: "retry",
    reason: `engine scope ${scopeUnit} ${describeScopeOutcome(outcome)}; falling back to direct spawn`,
  });
  return await launchAndRecordServer(
    opts,
    resolved,
    target,
    prepared,
    launchHost,
    launchPort,
    args,
    true,
  );
}

/**
 * Run `killOnAbort` once when the signal fires, or immediately if it is already aborted.
 * startServer passes `createAbortKiller(pid).kill`, which signals the killer's current
 * `targetPid` when it fires.
 */
function wireAbortToKill(signal: AbortSignal | undefined, killOnAbort: () => void): void {
  if (!signal) return;
  if (signal.aborted) killOnAbort();
  else signal.addEventListener("abort", killOnAbort, { once: true });
}

/**
 * Start llama-server in the background. Mirrors the shell `llama-start`:
 *
 *   1. Resolve the target to a rel + model path; fail if missing.
 *   2. Stop any previous instance under the residency lease fence, then
 *      spawn llama-server detached, redirecting stdout/stderr to
 *      `$LLAMA_CPP_LOGS/server.log`. When a registry is published, refuse
 *      with `LeasesActive`/`DrainInProgress` while leases are held, and
 *      never reopen a workload whose unload has been committed.
 *   3. Apply tuned launch args from bench-profiles.tsv when a record
 *      exists for (machine, rel, mode, ctx, build); otherwise use the
 *      `default` profile args.
 *   4. Poll `/health` until 200 or timeout; retry once with safe-flag
 *      mmproj args if the first attempt didn't come up and mmproj was
 *      in the arg set.
 *
 * Returns a structured result; non-null `error` indicates a hard
 * failure the caller should surface.
 *
 * Part of #278 DF-05: a successful start reopens residency admission for the
 * workload through `withReopenAfterLoad`, so a keepAlive restart (or any other
 * start path) lifts a verified-stopped workload back to open. Inert without a
 * published registry; a failed start never reopens.
 */
export function startServer(opts: StartServerOptions): Promise<StartServerResult> {
  return executeServerStart(opts);
}

function executeServerStart(opts: ServerStartExecutionOptions): Promise<StartServerResult> {
  const resolved = opts.resolved ?? resolveEnv(opts.env);
  if (managedRuntimeRefusesMutation(resolved.LOCAL_AI_RUNTIME_DIR)) {
    return Promise.resolve({
      ok: false,
      pid: null,
      endpoint: endpoint(resolved, opts.endpoint),
      advertisedEndpoint: advertisedEndpoint(resolved, opts.endpoint),
      tunedProfile: null,
      retried: false,
      error: "ManagedOwnerRequired",
    });
  }
  return withReopenAfterLoad(
    opts.key.name,
    () =>
      opts.commitReadiness === undefined
        ? startServerUnwrapped(opts)
        : startServerWithPublicationBarrier(opts, opts.commitReadiness),
    (r) => r.ok,
  );
}

class ManagedSpawnRefusedError extends Error {}

/** An inode generation tags observed metadata, without claiming validation of file contents. */
export function modelRunArtifactGenerationDigest(
  stat: Pick<BigIntStats, "dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs">,
): string {
  const fields = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs];
  return createHash("sha256").update(fields.map(String).join(":")).digest("hex");
}

function artifactGeneration(path: string): ArtifactGeneration | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) return undefined;
    return Object.freeze({
      evidence: "filesystem-metadata",
      generationDigest: modelRunArtifactGenerationDigest(stat),
    });
  } catch {
    return undefined;
  }
}

function readModelRunArtifacts(
  target: ResolvedLaunchTarget,
): ModelRunArtifacts | "model" | "binary" {
  const model = artifactGeneration(target.modelPath);
  if (model === undefined) return "model";
  const binary = artifactGeneration(target.bin);
  return binary === undefined ? "binary" : Object.freeze({ model, binary });
}

function managedArtifactRefusal(pinned: PinnedModelRunStart | undefined): string | undefined {
  if (pinned === undefined) return undefined;
  if (
    artifactGeneration(pinned.target.modelPath)?.generationDigest !==
    pinned.artifacts.model.generationDigest
  ) {
    return "ManagedArtifactChanged: model";
  }
  if (
    artifactGeneration(pinned.target.bin)?.generationDigest !==
    pinned.artifacts.binary.generationDigest
  ) {
    return "ManagedArtifactChanged: binary";
  }
  return undefined;
}

export function prepareManagedServerStart(
  input: StartServerOptions,
): PreparedManagedServerStart | { result: StartServerResult } {
  const env = { ...(input.env ?? process.env) };
  const resolved = { ...(input.resolved ?? resolveEnv(env)) };
  const opts: StartServerOptions = {
    ...input,
    key: { ...input.key },
    ...omitUndefined({
      endpoint: input.endpoint === undefined ? undefined : { ...input.endpoint },
      extraArgs: input.extraArgs === undefined ? undefined : [...input.extraArgs],
      readiness: input.readiness === undefined ? undefined : { ...input.readiness },
    }),
    env,
    resolved,
    engineScope: input.engineScope === undefined ? getEngineScopeLauncher() : input.engineScope,
  };
  const launchHost = opts.endpoint?.host ?? resolved.LLAMA_CPP_HOST;
  const launchPort = opts.endpoint?.port ?? resolved.LLAMA_CPP_PORT;
  if (hasFlag(opts.extraArgs ?? [], "-m", "--model")) {
    return {
      result: startServerError(
        resolved,
        opts.endpoint,
        null,
        false,
        "ManagedModelOverrideUnavailable",
      ),
    };
  }
  const validated = resolveAndValidateTarget(opts, resolved, opts.endpoint, env, launchHost);
  if ("result" in validated) return validated;
  const cwd = process.cwd();
  const target = {
    ...validated,
    bin: resolve(cwd, validated.bin),
    modelPath: resolve(cwd, validated.modelPath),
  };
  const artifacts = readModelRunArtifacts(target);
  if (typeof artifacts === "string") {
    return {
      result: startServerError(
        resolved,
        opts.endpoint,
        null,
        false,
        `ManagedArtifactUnverified: ${artifacts}`,
      ),
    };
  }
  const prepared = buildLaunchArgs(
    opts,
    target.rel,
    resolved,
    env,
    opts.key,
    target.draftResolvedExtraArgs,
  );
  const args = assembleServerLaunchArgs(
    target.modelPath,
    resolved,
    prepared.launchArgs,
    launchHost,
    launchPort,
  );
  const childProcess = { env: Object.freeze({ ...process.env }), cwd };
  const effectiveSpecDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        artifacts,
        specHash: computeServerSpecHash({
          rel: target.rel,
          ...launchSpecHashFields(opts, target, prepared, resolved, launchHost, launchPort),
        }),
        args,
        retryArgs: hasMmprojArg(prepared.launchArgs) ? safeRetryArgs() : [],
        childEnv: Object.entries(childProcess.env).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        cwd,
        workload: opts.key.name,
        runtimeDir: resolved.LOCAL_AI_RUNTIME_DIR,
        cacheDir: resolved.LLAMA_CPP_CACHE,
        logsDir: resolved.LLAMA_CPP_LOGS,
        engineScope: opts.engineScope !== null,
        slotSavePath: prepared.slotPathResolved.slotSavePath,
      }),
    )
    .digest("hex");
  const launch = Object.freeze({
    rel: target.rel,
    modelPath: target.modelPath,
    binary: target.bin,
    args: Object.freeze(args),
    tunedProfile: prepared.tunedProfile,
    artifacts,
  });
  const pinned = { target, prepared, childProcess, artifacts };
  return Object.freeze({
    effectiveSpecDigest,
    launch,
    artifactRefusal: (): string | undefined => managedArtifactRefusal(pinned),
    start: (
      commitReadiness: NonNullable<StartServerOptions["commitReadiness"]>,
      checkSpawn?: () => string | undefined,
    ): Promise<StartServerResult> =>
      executeServerStart({ ...opts, commitReadiness, pinned, ...omitUndefined({ checkSpawn }) }),
  });
}

async function startServerWithPublicationBarrier(
  opts: ServerStartExecutionOptions,
  commitReadiness: NonNullable<StartServerOptions["commitReadiness"]>,
): Promise<StartServerResult> {
  const resolved = opts.resolved ?? resolveEnv(opts.env ?? process.env);
  const earlyRefusal = managedArtifactRefusal(opts.pinned);
  if (earlyRefusal !== undefined)
    return startServerError(resolved, opts.endpoint, null, false, earlyRefusal);
  const result = await startServerUnwrapped({
    ...opts,
    resolved,
    onEvent: (event) => {
      if (event.type !== "ready") opts.onEvent?.(event);
    },
  }).catch((error: unknown): StartServerResult => {
    if (!(error instanceof ManagedSpawnRefusedError)) throw error;
    return startServerError(resolved, opts.endpoint, null, false, error.message);
  });
  if (!result.ok || result.pid === null) return result;
  const readyRefusal = managedArtifactRefusal(opts.pinned);
  if (readyRefusal !== undefined) return { ...result, ok: false, error: readyRefusal };

  const pid = result.pid;
  const state = readServerState(opts.key, resolved);
  if (state?.publicationPending !== true || state.pid !== pid) {
    return { ...result, ok: false, error: "ManagedGenerationUnverified" };
  }
  const refusal = commitReadiness(pid);
  if (refusal !== undefined) return { ...result, ok: false, error: refusal };

  delete state.publicationPending;
  atomicWriteFile(serverStateFile(resolved, opts.key), JSON.stringify(state, null, 2));
  opts.onEvent?.({ type: "ready", pid, endpoint: result.endpoint });
  return result;
}

async function startServerUnwrapped(opts: ServerStartExecutionOptions): Promise<StartServerResult> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const key = opts.key;
  const launchEndpoint = opts.endpoint;
  const launchHost = launchEndpoint?.host ?? resolved.LLAMA_CPP_HOST;
  const launchPort = launchEndpoint?.port ?? resolved.LLAMA_CPP_PORT;
  const validation =
    opts.pinned?.target ??
    resolveAndValidateTarget(opts, resolved, launchEndpoint, env, launchHost);
  if ("result" in validation) return validation.result;
  const { rel } = validation;

  // #806 phase 2: try to adopt a live, healthy, same-spec tracked engine before
  // any teardown, then fall through to the lease-fenced stop (see stopBeforeStart).
  const preflight = await stopOrAdoptBeforeStart(
    opts,
    resolved,
    key,
    launchEndpoint,
    validation,
    launchHost,
    launchPort,
  );
  if (preflight !== null) return preflight;

  const conflictResult = await handlePortConflict(
    opts,
    resolved,
    launchEndpoint,
    validation,
    launchHost,
    launchPort,
  );
  if (conflictResult) return conflictResult;

  mkdirSync(resolved.LLAMA_CPP_MODELS, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_CACHE, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });

  const prepared = prepareLaunchArgs(
    opts.pinned?.prepared ??
      buildLaunchArgs(opts, rel, resolved, env, key, validation.draftResolvedExtraArgs),
  );
  const { launchArgs, tunedProfile } = prepared;

  const launch = await launchAndRecordServer(
    opts,
    resolved,
    validation,
    prepared,
    launchHost,
    launchPort,
    launchArgs,
  );
  const pid = launch.pid;

  // The per-call target follows ownership: first pid, no pid while stopping, then retry pid.
  const abortKiller = createAbortKiller(signalableLaunchPid(launch));
  wireAbortToKill(opts.signal, abortKiller.kill);

  const timeoutSeconds = opts.timeoutSeconds ?? 60;
  const healthUrl = `${endpoint(resolved, launchEndpoint)}/health`;
  let readyResult = await pollReady(pid, healthUrl, timeoutSeconds, opts.onEvent, opts.signal);
  let outcome = readyResult.outcome;
  if (outcome === "aborted") {
    return abortedStartResult(
      opts,
      { resolved, key, launchEndpoint, prepared, abortKiller },
      false,
      signalableLaunchPid(launch),
    );
  }
  if (outcome === "ready") {
    opts.signal?.removeEventListener("abort", abortKiller.kill);
    return startServerSuccess(resolved, launchEndpoint, tunedProfile, false, pid, opts.onEvent);
  }

  // Retry path: mmproj-safe flags.
  let retried = false;
  let activePid = pid;
  if (hasMmprojArg(launchArgs)) {
    const retry = await retryWithMmprojSafeFlags(opts, {
      target: validation,
      prepared,
      resolved,
      key,
      launchEndpoint,
      launchHost,
      launchPort,
      healthUrl,
      timeoutSeconds,
      abortKiller,
      firstPid: pid,
    }).catch((error: unknown): never => {
      opts.signal?.removeEventListener("abort", abortKiller.kill);
      throw error;
    });
    if (retry.result) return retry.result;
    readyResult = retry.readyResult;
    outcome = readyResult.outcome;
    activePid = retry.retryPid;
    retried = true;
  }

  opts.signal?.removeEventListener("abort", abortKiller.kill);

  if (outcome === "timeout") {
    opts.onEvent?.({ type: "timeout", pid: activePid });
    // Port-collision hint: when the probe kept seeing a non-503 HTTP
    // status on the health endpoint, something else is bound to the
    // port and llama-server is answering nobody. Name the status
    // code so operators can lsof / pkill the right process.
    const conflictHint =
      readyResult.portConflict && readyResult.lastHttpCode
        ? ` \u2014 health endpoint returned HTTP ${readyResult.lastHttpCode} repeatedly; another process is likely bound to this port (try: lsof -P -iTCP:PORT)`
        : "";
    return startServerError(
      resolved,
      launchEndpoint,
      tunedProfile,
      retried,
      `llama-server readiness check timed out after ${String(timeoutSeconds)}s${conflictHint}`,
      activePid,
    );
  }

  opts.onEvent?.({ type: "exited", code: null });
  return startServerError(
    resolved,
    launchEndpoint,
    tunedProfile,
    retried,
    "llama-server exited before becoming ready",
  );
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
  spawn?: typeof spawn;
  pinned?: PinnedModelRunStart;
  checkSpawn?: () => string | undefined;
  scope?: { systemdRunPath: string; base: string; env: NodeJS.ProcessEnv } | null;
}

interface LaunchResult {
  pid: number;
  child: ChildProcess;
  scope: { base: string; scopeUnit: string; offset: number } | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function findArgValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i];
    if (tok === undefined) continue;
    if (tok === flag) {
      const value = args[i + 1];
      if (value !== undefined) values.push(value);
    } else if (tok.startsWith(flag + "=")) {
      values.push(tok.slice(flag.length + 1));
    }
  }
  return values;
}

function refuseHostBind(
  args: readonly string[],
  allowExternalBind: boolean | undefined,
): string | null {
  // llama-server applies a repeated --host in order (last wins), so any non-loopback occurrence may be the bind it ends up using.
  const host = findArgValues(args, "--host").find((value) => !LOOPBACK_HOSTS.has(value));
  if (host === undefined) return null;
  if (allowExternalBind === true) return null;
  return `refusing to bind llama-server to ${host} without \`allowExternalBind: true\` in the workload spec`;
}

function validateHostBind(args: readonly string[], allowExternalBind: boolean | undefined): void {
  const refusal = refuseHostBind(args, allowExternalBind);
  if (refusal !== null) throw new Error(refusal);
}

function hostBindArgs(extraArgs: readonly string[], fallbackHost: string): readonly string[] {
  return hasFlag(extraArgs, "--host") ? extraArgs : ["--host", fallbackHost];
}

/**
 * The refusal message when `extraArgs` (or `fallbackHost`, which binds only when they carry no
 * --host) would put llama-server on a non-loopback host without `allowExternalBind`, else null.
 * Callers that cannot know the node's fallback host pass undefined and check `extraArgs` alone.
 */
export function hostBindRefusal(
  extraArgs: readonly string[],
  fallbackHost: string | undefined,
  allowExternalBind: boolean | undefined,
): string | null {
  const args = fallbackHost === undefined ? extraArgs : hostBindArgs(extraArgs, fallbackHost);
  return refuseHostBind(args, allowExternalBind);
}

// Daemon-injected defaults: only prepended when the caller's args don't already
// specify them, so a manifest's `--host 0.0.0.0` overrides the env-default
// `--host 127.0.0.1` instead of producing a duplicate that some llama-server
// versions reject. `-m` is always set from the resolved model path; user-side
// overrides for the model path aren't a supported pattern. Extracted so the
// port-conflict adopt can reproduce the exact argv a fresh launch would spawn.
function assembleServerLaunchArgs(
  modelPath: string,
  resolved: ResolvedEnv,
  args: readonly string[],
  host: string | undefined,
  port: string | number | undefined,
): string[] {
  return [
    "-m",
    modelPath,
    ...(hasFlag(args, "--alias", "-a") ? [] : ["--alias", resolved.LLAMA_CPP_SERVER_ALIAS]),
    ...(hasFlag(args, "--host") ? [] : ["--host", host ?? resolved.LLAMA_CPP_HOST]),
    ...(hasFlag(args, "--port") ? [] : ["--port", String(port ?? resolved.LLAMA_CPP_PORT)]),
    ...(hasFlag(args, "-ngl", "--n-gpu-layers", "--gpu-layers") ? [] : ["-ngl", "999"]),
    ...args,
  ];
}

// True when a live listener's command line is the tail of the argv a fresh
// launch of THIS spec would spawn. The engine is exec'd through a wrapper (argv0
// `llama-server` + the resolved script path), so the desired token sequence only
// has to match a trailing window of the reported command line, not its prefix.
function launchArgvMatchesLaunchArgs(
  cmdline: string | null | undefined,
  expectedArgs: readonly string[],
): boolean {
  if (typeof cmdline !== "string") return false;
  const normalized = cmdline.split(/\s+/).join(" ").trim();
  const expected = expectedArgs.join(" ");
  if (normalized === expected) return true;
  if (!normalized.endsWith(" " + expected)) return false;
  // Only a wrapper prefix (argv0, a script path) may precede the daemon argv. A
  // flag token there would change the launch, so the listener is not ours.
  const prefix = normalized.slice(0, normalized.length - expected.length - 1).split(" ");
  return !prefix.some((token) => token.startsWith("-"));
}

async function launchBackground(opts: LaunchArgs): Promise<LaunchResult> {
  const { openSync, closeSync, fstatSync } = await import("node:fs");
  ensureWorkloadRuntimeDir(opts.resolved, opts.key);
  const logPath = serverLog(opts.resolved, opts.key);
  const logFd = openSync(logPath, "a");
  const offset = fstatSync(logFd).size;
  const fullArgs = assembleServerLaunchArgs(
    opts.modelPath,
    opts.resolved,
    opts.args,
    opts.host,
    opts.port,
  );
  validateHostBind(fullArgs, opts.allowExternalBind);
  const doSpawn = opts.spawn ?? spawn;
  const scoped = opts.scope ?? null;
  let child: ChildProcess;
  try {
    if (
      opts.pinned !== undefined &&
      managedRuntimeRefusesMutation(opts.resolved.LOCAL_AI_RUNTIME_DIR)
    ) {
      throw new ManagedSpawnRefusedError("ManagedOwnerRequired");
    }
    const refusal = opts.checkSpawn?.() ?? managedArtifactRefusal(opts.pinned);
    if (refusal !== undefined) throw new ManagedSpawnRefusedError(refusal);
    child =
      scoped === null
        ? doSpawn(opts.bin, fullArgs, {
            stdio: ["ignore", logFd, logFd],
            detached: true,
            ...opts.pinned?.childProcess,
          })
        : doSpawn(
            scoped.systemdRunPath,
            buildScopeArgv(scoped.base, opts.key.name, opts.bin, fullArgs),
            {
              stdio: ["ignore", logFd, logFd],
              detached: true,
              ...omitUndefined({ cwd: opts.pinned?.childProcess.cwd }),
              env: scoped.env,
            },
          );
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const pid = child.pid ?? 0;
  opts.onEvent?.({ type: "launch", pid, command: opts.bin, args: fullArgs });
  return {
    pid,
    child,
    scope:
      scoped === null ? null : { base: scoped.base, scopeUnit: `${scoped.base}.scope`, offset },
  };
}

// ---- stop --------------------------------------------------------------

export interface StopServerOptions {
  key: WorkloadKey;
  resolved?: ResolvedEnv;
  /**
   * Maximum seconds to wait after SIGTERM (default 5; values below 1 are raised to 1; polled in
   * 1 s steps). SIGKILL follows only if the identity re-verification then returns "alive".
   */
  graceSeconds?: number;
  /** Managed stop binds the exact generation in addition to normal PID checks. */
  identity?: PidIdentityDeps;
}

/**
 * Result returned unchanged by `serverStop`. A `stopped: false` result means the PID identity was
 * "unknown" before signalling or after the grace wait, so tracking files remain for a later stop
 * attempt. SIGKILL is only issued after a fresh "alive" identity re-verification.
 */
export interface StopServerResult {
  /**
   * Whether the record was cleared or the verified stop path completed; `stopped: false` leaves
   * tracking files in place because identity was "unknown".
   */
  stopped: boolean;
  /** PID read from the tracking file, or null when there was no readable record. */
  pid: number | null;
  /**
   * Whether SIGKILL was issued after an "alive" re-verification; false does not mean SIGTERM was
   * not sent.
   */
  killed: boolean;
  managedRefusal?:
    | "ManagedStopIntentRequired"
    | "ManagedStopGenerationUnverified"
    | "ManagedStopReleaseUnverified";
  /**
   * Set only by the node-side residency fence (#278 leases, #520 sessions),
   * never by `stopServer` itself: which registry refusal blocked the stop
   * and the lease or session ids that were active at refusal time.
   */
  refused?: {
    reason: "LeasesActive" | "DrainInProgress" | "SessionsActive" | "SessionsUnknown";
    active: string[];
  };
}

function unconfirmedServerStop(
  pid: number | null,
  identity: PidIdentityDeps | undefined,
  killed = false,
): StopServerResult {
  return {
    stopped: false,
    pid,
    killed,
    ...(identity?.verifyGeneration === undefined
      ? {}
      : { managedRefusal: "ManagedStopGenerationUnverified" }),
  };
}

/**
 * Build the pid-identity expectation for stopping the tracked instance: the
 * sidecar's binary/rel (or the default `llama-server` name) merged over the
 * caller-supplied identity deps. Shared by the verified stop and the
 * session-fence liveness probe so both agree on what "our instance" means.
 */
function trackedStopIdentity(
  resolved: ResolvedEnv,
  key: WorkloadKey,
  identity: PidIdentityDeps | undefined,
  acceptScopeWrapper = false,
): PidIdentityDeps {
  const sidecar = readServerState(key, resolved);
  const expectCommand: CommandExpectation = {
    binary: sidecar !== null && sidecar.binary !== "" ? basename(sidecar.binary) : "llama-server",
    ...(sidecar !== null && sidecar.binary !== "" ? { path: sidecar.binary } : {}),
    ...(sidecar !== null ? { args: [sidecar.rel] } : {}),
  };
  if (acceptScopeWrapper) {
    const pending = readScopePending(workloadRuntimeDir(resolved, key), "llama-server");
    if (
      pending !== null &&
      pending.pid === readServerPid(key, resolved) &&
      sidecar?.scopeUnit === pending.scopeUnit
    ) {
      expectCommand.alternatives = [scopeWrapperExpectation(pending.scopeUnit)];
    }
  }
  return { ...identity, expectCommand };
}

/**
 * Stop a tracked llama-server and return a `StopServerResult`. No readable record, or a "dead" or
 * "reused" record, is cleared without signalling. An "unknown" record returns `stopped: false`
 * with tracking files retained. An "alive" record receives SIGTERM; SIGKILL follows only if its
 * identity re-verification is "alive" after the grace wait. If that re-verification is "unknown",
 * the result is also `stopped: false` with tracking files retained, although SIGTERM was already
 * sent. Tracking files are removed only for a completed stop result.
 */
export async function stopServer(opts: StopServerOptions): Promise<StopServerResult> {
  const resolved = opts.resolved ?? resolveEnv();
  if (managedRuntimeRefusesMutation(resolved.LOCAL_AI_RUNTIME_DIR)) {
    return { stopped: false, pid: null, killed: false };
  }
  const key = opts.key;
  const grace = Math.max(1, opts.graceSeconds ?? 5);
  const pid = readServerPid(key, resolved);
  if (pid === null) {
    if (opts.identity?.verifyGeneration !== undefined) {
      return unconfirmedServerStop(pid, opts.identity);
    }
    removeServerPid(resolved, key);
    removeServerState(resolved, key);
    return { stopped: true, pid, killed: false };
  }
  const recordPath = pidFile(resolved, key);
  // A live pid is not enough to signal: the command line must still be the
  // llama-server this record describes — its binary (from the sidecar, or the
  // default name) and the model it was launched with. A scoped launch whose
  // wrapper has not exec'd yet presents as systemd-run, so only the verified
  // stop accepts the wrapper expectation (via the pending record).
  const identity = trackedStopIdentity(resolved, key, opts.identity, true);
  const verdict = verifyPidFile(recordPath, pid, identity);
  if (isRecordedPidGone(verdict)) {
    removeServerRecordIfOwned(resolved, key, pid);
    return { stopped: true, pid, killed: false };
  }
  // Only positive identity authorizes signalling; unknown and future verdicts
  // keep the tracking files so a later attempt can still find the process.
  if (verdict !== "alive") return unconfirmedServerStop(pid, identity);

  // A stop during the pre-exec handshake must tombstone the unit first, so the
  // in-flight scoped launch sees it and never falls back to a direct spawn.
  const pending = readScopePending(workloadRuntimeDir(resolved, key), "llama-server");
  if (pending !== null && pending.pid === pid) {
    writeScopeStop(workloadRuntimeDir(resolved, key), "llama-server", pending.scopeUnit);
  }
  const terminated = await terminateVerifiedPid(recordPath, pid, identity, grace);
  if (!terminated.stopped) return unconfirmedServerStop(pid, identity, terminated.killed);
  removeServerRecordIfOwned(resolved, key, pid);
  return { stopped: true, pid, killed: terminated.killed };
}
