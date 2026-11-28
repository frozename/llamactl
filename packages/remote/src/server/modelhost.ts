import type {
  EngineBootEnv,
  ModelHostReadiness,
  ModelHostSpecForEngine,
} from "@llamactl/core/engines/types";
import type {
  LlamacppSleepController,
  SleepResidency,
} from "@llamactl/core/residency/llamacpp-sleep";

import { resolveSecret } from "@llamactl/core/config/secret";
import { type EngineName, ENGINES, formatHostForUrl } from "@llamactl/core/engines";
import {
  type ModelHostRuntimeStatus,
  readModelHostRuntimeStatus,
} from "@llamactl/core/engines/conditions";
import {
  awaitScopeExec,
  buildScopeArgv,
  describeScopeOutcome,
  type EngineScopeLauncher,
  getEngineScopeLauncher,
  isScopeFallback,
  type ScopeOutcome,
  type ScopeResolveResult,
  scopeStopNames,
  scopeUnitBase,
  scopeWrapperExpectation,
  shapeScopeEnv,
  writeScopeStop,
} from "@llamactl/core/engines/scope";
import {
  computeModelHostSpecHash,
  modelhostPidFile,
  modelhostStartingFile,
  type ModelHostState,
  modelhostStateFile,
  readModelHostStarting,
  readModelHostState,
  removeModelHostStarting,
  removeModelHostState,
  writeModelHostStarting,
  writeModelHostState,
} from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import {
  defaultReadProcessCommand,
  parseSlotSavePathFromCommand,
  resolveSlotSavePathArgs,
} from "@llamactl/core/kvstore";
import { omitUndefined } from "@llamactl/core/object";
import {
  isRecordedPidGone,
  type PidIdentityDeps,
  type SignalIdentity,
  verifyPidFile,
} from "@llamactl/core/pidIdentity";
import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { managedRuntimeRefusesMutation } from "@llamactl/core/residency/managed-runtime";
import { currentSessionRefcounts } from "@llamactl/core/residency/sessions";
import { type WorkloadKey, workloadRuntimeDir } from "@llamactl/core/workloadRuntime";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { StopFenceRefusal } from "../residency/stop-fence.js";

import {
  getNodeLlamacppSleepController,
  matchesLlamacppSleepGeneration,
  readLlamacppSleepResidency,
} from "../residency/llamacpp-sleep-status.js";
import { managedNativeLaunch } from "../residency/managed-launch-admission.js";
import { connectOmlxOwnerSocket } from "../residency/omlx-owner-socket.js";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "../safe-fs.js";
import {
  externalManagerOf,
  MANAGED_BY_LABEL,
  modelHostBindRefusal,
  modelHostExternalBindHost,
  type ModelHostManifest,
  ModelHostManifestSchema,
  normalizeReadiness,
  specForEngine,
  specForHash,
} from "../workload/modelhost-schema.js";
import { listModelHosts, loadModelHostByName, saveModelHost } from "../workload/modelhost-store.js";
import {
  loadInitiallyOwnedOmlx,
  type OmlxCacheLaunch,
  prepareOmlxCacheLaunch,
  prepareOmlxOwnerLaunch,
} from "./omlx-cache-launch.js";
import { currentNativeOmlxOwner } from "./omlx-native-owner.js";

/**
 * Label marking ModelHosts that share exclusive memory on a node (#557 S5):
 * at most one host per group value may hold the group's memory at a time,
 * so startModelHost refuses a same-group start while a peer is Running,
 * Starting, or unverifiable (Unknown).
 */
export const RESIDENCY_GROUP_LABEL = "llamactl.io/residency-group";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ModelHostSpawnResult {
  pid: number | null;
}

export interface StartModelHostOptions {
  key: WorkloadKey;
  timeoutSeconds?: number;
  manifest?: unknown;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  commitReadiness?: (pid: number) => string | undefined;
  checkSpawn?: () => string | undefined;
  workloadsDir?: string;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Identity resolver seams for tests; production uses the defaults. */
  identity?: PidIdentityDeps;
  spawn?: typeof nodeSpawn;
  probeReady?: (
    endpoint: { host: string; port: number },
    timeoutMs: number,
    readiness?: ModelHostReadiness,
  ) => Promise<{ ready: boolean; modelIds: string[] }>;
  /**
   * Discover the pid of the process currently listening on an endpoint.
   * Used to ADOPT a live host that was (re)launched out-of-band (e.g. a
   * manual restart) so routing recovers without spawning a competitor.
   * Injectable for tests; defaults to an `lsof`-based lookup.
   */
  findListenerPid?: (endpoint: { host: string; port: number }) => Promise<number | null>;
  readProcessCommand?: (pid: number) => Promise<string | null> | string | null;
  /** Sink for the external-bind warning; injectable for tests. Defaults to
   *  writing the message plus a newline to process.stderr. */
  warn?: (message: string) => void;
  /** #806 phase 2: skip the unchanged-spec adopt (both the state-sidecar and
   *  the starting-record paths) and force the teardown + respawn. Mirrors
   *  StartServerOptions.restart on the ModelRun path; set by callers that
   *  know the running engine must be replaced (e.g. after a health loss). */
  restart?: boolean;
  /** #806 phase 3: engine-scope launcher for Linux scoped launches. `undefined`
   *  means the process-wide launcher (`getEngineScopeLauncher()`); an explicit
   *  null, or a launcher whose resolve fails, keeps the direct spawn. */
  engineScope?: EngineScopeLauncher | null;
}

export interface StartModelHostResult {
  ok: boolean;
  pid: number | null;
  error?: string;
  /** The pid of a child that was spawned and then failed or was torn down.
   *  Admission authorities need it as generation evidence to prove the
   *  process is gone before releasing memory; `pid` stays null because a
   *  failure is never a running host. */
  spawnedPid?: number;
  preDispatchRefusal?: string;
  /** Present when the residency-group guard refused the start: the shared
   *  group, the conflicting peer's name, and the state it was observed in. */
  residencyConflict?: {
    group: string;
    host: string;
    state: "Running" | "Starting" | "Unknown";
  };
  /** Present only when the residency lease or session registry refused the
   *  stop-before-start teardown of a live prior host (Part of #520);
   *  never set on success. */
  refused?: StopFenceRefusal;
  /** Present and true only when a live, healthy engine with an unchanged spec
   *  hash was adopted instead of torn down and respawned (#806 phase 2); a
   *  fresh or drifted start leaves it absent. */
  adopted?: boolean;
}

export interface StopModelHostOptions {
  key: WorkloadKey;
  graceSeconds?: number;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  teardown?: (pid: number, graceSeconds?: number) => Promise<void>;
  /** Identity resolver seams for tests; production uses the defaults. */
  identity?: PidIdentityDeps;
}

export interface StopModelHostResult {
  ok: boolean;
  pid: number | null;
  error?: string;
}

export interface StatusModelHostOptions {
  key: WorkloadKey;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Identity resolver seams for tests; production uses the defaults. */
  identity?: PidIdentityDeps;
  /** Test seam; undefined reads the node's published llama.cpp sleep controller (#283). */
  sleepController?: LlamacppSleepController | null;
  probeOrigin?: string;
}

export interface StatusModelHostResult {
  state: "Running" | "Stopped";
  pid?: number | null;
  specHash?: string;
  /** Present and true when the recorded pid's identity could not be
   *  established — callers must not sweep, restart over, or report the
   *  record as cleanly stopped. */
  identityUnknown?: boolean;
  /** Persistent conditions (reconcile errors, OOM kills) and restart count,
   *  recorded by the controller on this node; absent until one is recorded. */
  runtime?: ModelHostRuntimeStatus;
  /** #283: present only for a live llama.cpp host its node's sleep controller
   *  records as sleeping or sleep-pending; recorded state, never a live probe. */
  sleep?: SleepResidency;
  /** Recorded sleep bound to the requested probe origin and tracked process generation. */
  probeSleep?: SleepResidency;
  /** Positive durable native park proof for this live oMLX generation and requested origin. */
  probeParked?: true;
}

export type OmlxParkedProbeIdentity = Readonly<{
  workload: string;
  pid: number;
  startedAt: string;
  specHash: string;
  endpoint: Readonly<{ host: string; port: number }>;
}>;

/** The owner proves the durable parked claim and the exact live process birth and listener. */
export type VerifyParkedOmlxProbe = (
  identity: OmlxParkedProbeIdentity,
  signal: AbortSignal,
) => Promise<boolean>;

function toRuntimeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env;
}

// Command-line corroboration for a recorded ModelHost pid: the process must
// still present one of the engine's argv0 basenames (`llama-server` for
// llamacpp, `strata-server` for strata; for oMLX both the `omlx` launcher
// shim and `omlx-server`, the process title the running server sets for
// itself, #357). A record's binaryNames (#516) replaces the engine default —
// the record is the authority because stop and status never see the
// manifest. A fresh-recorded impostor fails this even when the start-time
// check cannot see the recycling.
const ENGINE_BINARY_BASENAMES: Record<EngineName, readonly string[]> = {
  llamacpp: ["llama-server"],
  libosmos: ["osmos-api"],
  omlx: ["omlx", "omlx-server"],
  strata: ["strata-server"],
  kapitsa: ["kapitsa"],
};

function hostIdentityDeps(
  engine: EngineName,
  deps?: PidIdentityDeps,
  binaryNames?: readonly string[],
): PidIdentityDeps {
  return {
    ...deps,
    expectCommand: { binaries: binaryNames ?? ENGINE_BINARY_BASENAMES[engine] },
  };
}

// #806 phase 3: a starting record that names a scope unit may still be holding
// the systemd-run wrapper (pre-exec), so the starting-record verify sites also
// accept the wrapper argv. State-sidecar sites keep engine-only identity, so a
// wrapper pid can never be promoted into modelhost.state.
function startingIdentityDeps(
  record: { engine: EngineName; scopeUnit?: string },
  deps: PidIdentityDeps | undefined,
  binaryNames: readonly string[] | undefined,
): PidIdentityDeps {
  const identity = hostIdentityDeps(record.engine, deps, binaryNames);
  if (record.scopeUnit === undefined) return identity;
  return {
    ...identity,
    expectCommand: {
      ...identity.expectCommand,
      alternatives: [scopeWrapperExpectation(record.scopeUnit)],
    },
  };
}

// Reap-path argv0 names (#516). The record's `binaryNames` are used
// exclusively when present; the manifest's declared names are unioned with
// the engine default only when the record predates #516 and carries none —
// one apply can then reap the fork, with identity still anchored to the
// pid-file mtime and the process start time. Recovering a legacy fork
// whose record lacks names requires an explicit `llamactl apply` once
// binaryNames is added, because the reconciler deliberately skips
// identityUnknown hosts.
function reapBinaryNames(
  engine: EngineName,
  recorded: readonly string[] | undefined,
  declared: readonly string[] | undefined,
): readonly string[] | undefined {
  if (recorded !== undefined) {
    return recorded;
  }
  if (declared !== undefined) {
    return [...new Set([...ENGINE_BINARY_BASENAMES[engine], ...declared])];
  }
  return undefined;
}

// Separate-token `--alias`/`-a` values — mirrors aliasesFromArgs in
// core/server.ts (remote/residency/catalog.ts keeps the same copy): core's
// exports map does not expose that module, so the adoption ownership checks
// keep their own copy (#806). llama.cpp advertises the alias, not the model
// rel, on /v1/models.
function aliasesFromExtraArgs(extraArgs: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  for (const arg of extraArgs) {
    const next = extraArgs[index + 1];
    index += 1;
    if ((arg === "--alias" || arg === "-a") && next !== undefined) {
      out.push(next);
    }
  }
  return out;
}

// #806 phase 3: a scoped launch additionally hands the engine the two systemd
// user-bus locators (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS) after exec —
// non-secret socket paths under the owner-only /run/user/<uid>, granting the
// same-uid engine no new authority. They are deliberately NOT allowlisted
// here: only shapeScopeEnv adds them, so direct and macOS children keep this
// exact list. An env/sh shim that stripped them would add a third argv0
// window to the pid-identity checks.
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "LLAMACTL_MODELS_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
  // Apple Metal GPU context-store timeout relaxation — workaround for
  // MLX issue #2670 (uncatchable abort() on Metal command-buffer errors
  // under high concurrency / multi-model load). Set to "1" in the host's
  // launchd plist to enable; harmless when unset.
  "AGX_RELAX_CDM_CTXSTORE_TIMEOUT",
  // MLX back-pressure gate: caps in-flight Metal command buffers per
  // stream. Set to a positive integer (e.g. "1") to enable the gate.
  // Unset means INT_MAX (gate disabled, single mutex acquisition fast
  // path). Tied to the per-stream gate added on top of issue #2670.
  "MLX_METAL_MAX_INFLIGHT_PER_STREAM",
  "MLX_METAL_BACKPRESSURE_TIMEOUT_SECS",
];

// Merge order: parent allowlist → engineOverrides → specEnv → apiKey.
// spec.env wins on conflict so manifests can declaratively override
// both inherited host vars and engine-level boot overrides.
// apiKey (resolved from spec.apiKeyRef) is applied LAST as LLAMA_API_KEY
// so it cannot be overwritten by spec.env — the ref always wins.
function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv,
  engineOverrides: Record<string, string> | undefined,
  specEnv: Record<string, string> | undefined,
  apiKey?: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  if (engineOverrides) {
    for (const [key, value] of Object.entries(engineOverrides)) out[key] = value;
  }
  if (specEnv) {
    for (const [key, value] of Object.entries(specEnv)) out[key] = value;
  }
  if (apiKey !== undefined) out["LLAMA_API_KEY"] = apiKey;
  return out;
}

function withRuntimeDir(env: NodeJS.ProcessEnv, runtimeDir?: string): NodeJS.ProcessEnv {
  if (!runtimeDir) return env;
  return { ...env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
}

function buildModelHostSpec(manifest: ModelHostManifest): ModelHostSpecForEngine {
  return specForEngine(manifest.spec);
}

// Short probe window for adoption: a process already bound to the endpoint
// answers quickly, so we should not wait the full launch timeout to confirm.
const ADOPT_PROBE_TIMEOUT_MS = 3000;
// Hard cap on the listener-pid lookup. The reconcile host loop is serial, so
// a wedged lsof (stuck mount, fd contention) must never hang the whole pass.
const FIND_LISTENER_TIMEOUT_MS = 2000;

// Resolve lsof by absolute path: macOS ships it in /usr/sbin, which is NOT on
// the controller's launchd PATH — a bare `lsof` would ENOENT there and silently
// disable adoption in production. Fall back to a bare name only if neither
// canonical location exists (e.g. an unusual Linux layout on PATH).
function resolveLsofPath(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "lsof";
}

function defaultFindListenerPid(
  endpoint: { host: string; port: number },
  signal?: AbortSignal,
  requireUnique = false,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | null = null;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // The listener probe process may have already exited.
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, FIND_LISTENER_TIMEOUT_MS);
    try {
      // Constrain to the exact bind address so a process listening on a
      // different address of the same port (e.g. 0.0.0.0 / ::1) is not matched.
      child = nodeSpawn(
        resolveLsofPath(),
        [
          "-nP",
          `-iTCP@${formatHostForUrl(endpoint.host)}:${String(endpoint.port)}`,
          "-sTCP:LISTEN",
          "-t",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      child.stdout?.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => {
        finish(null);
      });
      child.on("close", () => {
        const pids = out
          .split(/\s+/)
          .map((token) => Number.parseInt(token, 10))
          .filter((value) => Number.isInteger(value) && value > 0);
        finish(requireUnique && new Set(pids).size !== 1 ? null : (pids[0] ?? null));
      });
    } catch {
      finish(null);
    }
    if (signal) {
      if (signal.aborted) finish(null);
      else
        signal.addEventListener(
          "abort",
          () => {
            finish(null);
          },
          { once: true },
        );
    }
  });
}

// #516: the pid records carry spec.binaryNames verbatim; the conditional
// spread keeps the key absent — never an explicit undefined — when the spec
// omits it, so pre-#516 consumers see a byte-identical record.
function binaryNamesField(binaryNames: readonly string[] | undefined): { binaryNames?: string[] } {
  return binaryNames === undefined ? {} : { binaryNames: [...binaryNames] };
}

// #220: absent key, never explicit undefined, so pre-#220 sidecars stay byte-identical.
function readinessField(readiness: ModelHostReadiness | undefined): {
  readiness?: ModelHostReadiness;
} {
  return readiness === undefined ? {} : { readiness };
}

// #806 phase 3: absent key, never explicit undefined, so unscoped records stay
// byte-identical to pre-phase-3 sidecars.
function scopeUnitField(scopeUnit: string | undefined): { scopeUnit?: string } {
  return scopeUnit === undefined ? {} : { scopeUnit };
}

function restartFenceRefusal(workload: string, refusal: StopFenceRefusal): StartModelHostResult {
  const sessionBound = refusal.reason === "SessionsActive" || refusal.reason === "SessionsUnknown";
  const tail = sessionBound
    ? "while a session is bound to its running instance"
    : "while residency leases are held";
  return {
    ok: false,
    pid: null,
    error: `${refusal.reason}: ${refusal.active.join(", ")} — refusing to restart ModelHost ${workload} ${tail}`,
    refused: refusal,
  };
}

function restartSessionRefusal(workload: string): StopFenceRefusal | null {
  const sessions = currentSessionRefcounts();
  if (sessions === null) return null;
  try {
    const check = sessions.checkUnload(workload);
    if (check.ok) return null;
    return { reason: "SessionsActive", active: [...check.sessions] };
  } catch {
    return { reason: "SessionsUnknown", active: [] };
  }
}

/**
 * #520, mirroring core's #734 startServer fence: run a live prior host's
 * teardown under the DF-05 drain. LeasesActive keeps precedence over a
 * bound session; a foreign drain refuses DrainInProgress without touching
 * its token; an unloaded workload runs unfenced, as core does. The session
 * check runs in the same synchronous tick as the drain — SessionsActive
 * while a session is bound, SessionsUnknown when the registry throws — and
 * the drain is cancelled on every refusal so the workload returns to open.
 * The fence never releases sessions; the override is
 * `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`.
 * Both call sites reach this only after liveness is established — a
 * verified-alive recorded pid, or a live adopted listener confirmed as ours —
 * matching core's trackedInstanceLive gating.
 */
async function fencePriorHostTeardown<T>(
  workload: string,
  run: () => Promise<T>,
): Promise<T | StartModelHostResult> {
  const registry = getResidencyLeaseRegistry();
  if (registry === null) return await run();
  const drain = registry.beginDrain(workload);
  if (!drain.ok) {
    if (drain.reason === "AlreadyDraining") {
      return restartFenceRefusal(workload, {
        reason: "DrainInProgress",
        active: registry.active(workload),
      });
    }
    return await run();
  }
  if (drain.active.length > 0) {
    registry.cancelDrain(drain.token);
    return restartFenceRefusal(workload, { reason: "LeasesActive", active: drain.active });
  }
  const sessionRefusal = restartSessionRefusal(workload);
  if (sessionRefusal !== null) {
    registry.cancelDrain(drain.token);
    return restartFenceRefusal(workload, sessionRefusal);
  }
  try {
    return await run();
  } finally {
    registry.cancelDrain(drain.token);
  }
}

// Given a live process (`livePid`) already bound to the endpoint, adopt it iff
// it is serving OUR model: re-record its pid so the proxy route recovers,
// rather than spawning a competitor that could not bind the held port. Returns
// null when the live process is not (yet) confirmable as ours — the caller then
// DEFERS rather than spawning, since a spawn cannot win a held port.
async function tryAdoptLiveHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  probeReady: NonNullable<StartModelHostOptions["probeReady"]>,
  livePid: number,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
  priorSpecHash: string | undefined,
): Promise<StartModelHostResult | "relaunch" | null> {
  if (manifest.spec.omlxCacheEpoch !== undefined) return null;
  const endpoint = manifest.spec.endpoint;
  const declaredReadiness = normalizeReadiness(manifest.spec.readiness);
  const readiness = await probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS, declaredReadiness).catch(
    () => ({
      ready: false,
      modelIds: [] as string[],
    }),
  );
  if (!readiness.ready) return null;
  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) return null;
  const rel = firstHostedModel.rel;
  const aliases = new Set([rel, basename(rel), ...aliasesFromExtraArgs(manifest.spec.extraArgs)]);
  // Only adopt a process that advertises OUR model. Empty modelIds means we
  // cannot confirm ownership — refuse (the caller defers) rather than adopt an
  // unrelated squatter that happened to grab the freed port.
  if (
    readiness.modelIds.length === 0 ||
    !readiness.modelIds.some((id) => aliases.has(id) || aliases.has(basename(id)))
  ) {
    return null;
  }
  // TOCTOU: the listener may have exited between discovery and now.
  if (!isProcessAlive(livePid)) return null;
  // The live process is ours, but the applied spec differs from the recorded
  // launch spec — it predates the change and is running a stale launch. Adopting
  // it would stamp a convergence hash onto the old spec and silently drop the
  // applied change (e.g. a resources bump), so tear it down and let the caller
  // respawn with the applied spec. A same-spec respawn is still adopted.
  if (priorSpecHash !== computeModelHostSpecHash(specForHash(manifest.spec))) {
    // The live listener has no record anchor to re-verify, so liveness itself
    // is the only available proof of release. A resolved teardown is not
    // proof the port was freed: respawn only once the pid is actually gone,
    // otherwise the replacement cannot bind and we defer the restart.
    return await fencePriorHostTeardown(
      opts.key.name,
      async (): Promise<StartModelHostResult | "relaunch"> => {
        try {
          await engine.teardown(livePid);
        } catch {
          // A thrown teardown is not proof either way; the liveness re-check below
          // decides.
        }
        if (isProcessAlive(livePid)) {
          return {
            ok: false,
            pid: null,
            error: `live pid ${String(livePid)} survived teardown on spec drift; deferring restart`,
          };
        }
        return "relaunch";
      },
    );
  }
  const readProcessCommand = opts.readProcessCommand ?? defaultReadProcessCommand;
  const cmdline = await Promise.resolve(readProcessCommand(livePid)).catch(() => null);
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: manifest.spec.engine,
      pid: livePid,
      host: endpoint.host,
      port: endpoint.port,
      modelAliases: Array.from(aliases),
      startedAt: new Date().toISOString(),
      slotSavePath: typeof cmdline === "string" ? parseSlotSavePathFromCommand(cmdline) : null,
      specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
      ...binaryNamesField(manifest.spec.binaryNames),
      ...readinessField(declaredReadiness),
    },
    opts.key,
    resolved,
  );
  return { ok: true, pid: livePid };
}

/** SignalIdentity for an engine teardown: the pid-file anchor plus the
 *  caller's identity deps and the engine argv0 expectation, omitting
 *  undefined optionals so strict exactOptionalPropertyTypes holds. */
function teardownIdentity(
  recordPath: string,
  deps: PidIdentityDeps | undefined,
  expectCommand: PidIdentityDeps["expectCommand"],
): SignalIdentity {
  return {
    recordPath,
    ...(deps !== undefined ? { deps } : {}),
    ...(expectCommand !== undefined ? { expectCommand } : {}),
  };
}

// #595: a resolved teardown is not proof the process is gone. Await it in a
// try/catch (a thrown teardown is not proof either way), then re-verify the
// recorded identity; only a confirmed-gone verdict lets the restart proceed.
// Mirrors the authoritative post-teardown re-check in stopModelHost /
// stopStartingRecord. Returns null when the pid is confirmed gone, or a
// deferral result naming why the restart cannot proceed.
async function confirmRecordedTeardown(
  teardown: () => Promise<void>,
  recordPath: string,
  pid: number,
  identity: PidIdentityDeps,
): Promise<StartModelHostResult | null> {
  try {
    await teardown();
  } catch {
    // A resolved or thrown teardown is not proof of release; the identity
    // re-check below is authoritative.
  }
  const released = verifyPidFile(recordPath, pid, identity);
  if (isRecordedPidGone(released)) return null;
  return {
    ok: false,
    pid: null,
    error:
      released === "alive"
        ? "process still alive after teardown; deferring restart"
        : "pid identity unknown after teardown; deferring restart",
  };
}

// Ownership gate for the starting-record promote: the engine must advertise
// the hosted model by rel, basename, or a declared --alias (#806) — the same
// gate adoptUnchangedHost applies to a state-sidecar host.
function servesHostedModel(manifest: ModelHostManifest, modelIds: readonly string[]): boolean {
  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) return false;
  const aliases = new Set([
    firstHostedModel.rel,
    basename(firstHostedModel.rel),
    ...aliasesFromExtraArgs(manifest.spec.extraArgs),
  ]);
  return modelIds.length > 0 && modelIds.some((id) => aliases.has(id) || aliases.has(basename(id)));
}

// #806 phase 2: an engine caught mid-load (only its starting record exists,
// because the prior agent died before readiness) must survive an unchanged
// re-apply instead of being bounced. When the record's hash matches the
// applied spec: promote it to a full state sidecar once readiness passes and
// it serves our model; while it is still loading (the probe refuses), defer
// rather than kill — the load needs its full timeout budget. A record older
// than that budget is a failed start, and a live process on a same-hash
// record that answers with a different model is a squatter; both fall through
// to the reap path below. Returns null to fall through.
async function adoptOrDeferStartingHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
  starting: NonNullable<ReturnType<typeof readModelHostStarting>>,
): Promise<StartModelHostResult | null> {
  // A published residency registry that is not open must not get an adopted
  // engine back: a promote would hand withReopenAfterLoad an "unchanged" result
  // for a workload whose admission is closed. Decline so the start falls
  // through to the fenced teardown/respawn, mirroring core's adoptTrackedServer.
  const residency = getResidencyLeaseRegistry();
  if (residency !== null && residency.snapshot(opts.key.name).phase !== "open") return null;
  if (opts.restart === true) return null;
  const currentHash = computeModelHostSpecHash(specForHash(manifest.spec));
  if (starting.specHash === undefined || starting.specHash !== currentHash) return null;
  const endpoint = manifest.spec.endpoint;
  const declaredReadiness = normalizeReadiness(manifest.spec.readiness);
  const readiness = await (
    opts.probeReady !== undefined
      ? opts.probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS, declaredReadiness)
      : engine.probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS, declaredReadiness)
  ).catch(() => ({ ready: false, modelIds: [] as string[] }));
  // #806 phase 3: the caller's verify accepted the wrapper argv for a scoped
  // record, but the promote requires ENGINE-only identity — a systemd-run
  // wrapper that has not exec'd yet defers within the budget and is reaped
  // after it; it is never promoted into modelhost.state.
  const engineIdentity = hostIdentityDeps(
    starting.engine,
    opts.identity,
    reapBinaryNames(starting.engine, starting.binaryNames, manifest.spec.binaryNames),
  );
  const engineVerified =
    starting.scopeUnit === undefined ||
    verifyPidFile(modelhostStartingFile(resolved, opts.key), starting.pid, engineIdentity) ===
      "alive";
  if (engineVerified && readiness.ready && servesHostedModel(manifest, readiness.modelIds)) {
    // writeModelHostState refreshes the modelhost.pid anchor to now, which is
    // after the promoted process started — a valid anchor for later identity
    // checks; the starting record's own mtime must not leak into the state.
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: starting.engine,
        pid: starting.pid,
        host: endpoint.host,
        port: endpoint.port,
        modelAliases: resolveModelAliases(manifest),
        startedAt: starting.startedAt,
        slotSavePath:
          manifest.spec.omlxCacheEpoch !== undefined
            ? (starting.slotSavePath ?? null)
            : resolveSlotSavePathArgs(
                manifest.spec.extraArgs,
                resolved.LOCAL_AI_RUNTIME_DIR,
                opts.key.name,
              ).slotSavePath,
        specHash: currentHash,
        ...binaryNamesField(starting.binaryNames),
        ...readinessField(declaredReadiness),
        ...scopeUnitField(starting.scopeUnit),
      },
      opts.key,
      resolved,
    );
    removeModelHostStarting(opts.key, resolved);
    return { ok: true, pid: starting.pid, adopted: true };
  }
  if (engineVerified && readiness.ready) return null;
  const budgetMs = (opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000;
  if (Date.now() - Date.parse(starting.startedAt) >= budgetMs) return null;
  return {
    ok: false,
    pid: null,
    error: `engine pid ${String(starting.pid)} from the starting record is still loading; deferring restart`,
  };
}

// #317: a child spawned by a previous agent that died before readiness leaves
// only its starting record. Verify its identity against the record (the mtime
// anchor plus the engine argv0), reap it when it is provably ours, and defer
// the whole start when it is not — spawning over an unverifiable live pid is
// how #317 got a second engine on one port. An alive, same-hash record is
// first offered to the promote/defer path (#806) so a reload of an unchanged
// spec never kills an engine that is merely still loading.
async function reapStartingOrphan(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
): Promise<StartModelHostResult | null> {
  const starting = readModelHostStarting(opts.key, resolved);
  if (!starting) return null;
  const recordPath = modelhostStartingFile(resolved, opts.key);
  const identity = startingIdentityDeps(
    starting,
    opts.identity,
    reapBinaryNames(starting.engine, starting.binaryNames, manifest.spec.binaryNames),
  );
  const verdict = verifyPidFile(recordPath, starting.pid, identity);
  if (verdict === "unknown") {
    return { ok: false, pid: null, error: "pid identity unknown; deferring restart" };
  }
  if (verdict === "alive") {
    const adopted = await adoptOrDeferStartingHost(manifest, opts, resolved, engine, starting);
    if (adopted !== null) return adopted;
    // #806 phase 3: tombstone the scope unit before teardown so an in-flight
    // scoped launch whose wrapper exits here can never fall back to a direct
    // spawn behind this reap's back.
    if (starting.scopeUnit !== undefined) {
      writeScopeStop(workloadRuntimeDir(resolved, opts.key), "modelhost", starting.scopeUnit);
    }
    const failure = await confirmRecordedTeardown(
      () =>
        engine.teardown(
          starting.pid,
          teardownIdentity(recordPath, opts.identity, identity.expectCommand),
        ),
      recordPath,
      starting.pid,
      identity,
    );
    if (failure !== null) return failure;
  }
  clearStartingRecordIfOwned(opts.key, resolved, starting.pid);
  return null;
}

// The starting record is only ours while it names the pid we spawned; a
// concurrent lifecycle transition that replaced it must survive our cleanup.
function clearStartingRecordIfOwned(
  key: WorkloadKey,
  resolved: ReturnType<typeof resolveEnv>,
  pid: number,
): void {
  const current = readModelHostStarting(key, resolved);
  if (current !== null && current.pid === pid) {
    removeModelHostStarting(key, resolved);
  }
}

// llama.cpp advertises the model under its --alias name when the spec
// declares one; fold declared aliases back onto the hosted rel so the
// ownership check sees our model and an aliased engine is not bounced on
// every unchanged re-apply (#806).
function foldDeclaredAliases(
  extraArgs: readonly string[],
  readiness: { ready: boolean; modelIds: string[] },
  hostedRel: string,
): void {
  const declared = aliasesFromExtraArgs(extraArgs);
  if (declared.length === 0) return;
  readiness.modelIds = readiness.modelIds.map((id) =>
    declared.some((alias) => alias === id || basename(alias) === basename(id)) ? hostedRel : id,
  );
}

// #806 phase 2: a live, identity-verified prior host whose recorded spec hash
// matches the applied spec is adopted rather than torn down and respawned. The
// engine must also answer its readiness probe now (a same-hash-but-crashed-into
// a zombie, or an OOM-parked process, is replaced), and it must still advertise
// our model — the same ownership gate `tryAdoptLiveHost` applies to an
// out-of-band listener, so an unrelated process that grabbed a freed port is
// never adopted. Out-of-hash fields (the readiness probe, the binaryNames) are
// refreshed onto the sidecar; the launch-affecting fields, the recorded pid and
// startedAt are left exactly as they are, and the pid file is never rewritten
// (its mtime is the identity anchor). Returns null to fall through to the
// teardown/restart path: a missing hash (legacy record), a drifted hash, a
// failed probe, a model mismatch, or a pid that died between discovery and now.
async function adoptUnchangedHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
  priorState: ModelHostState,
): Promise<StartModelHostResult | null> {
  // A published residency registry that is not open must not get an adopted
  // engine back: adoption would hand withReopenAfterLoad an "unchanged" result
  // for a workload whose admission is closed. Decline so the start falls
  // through to the fenced teardown/respawn, mirroring core's adoptTrackedServer.
  const residency = getResidencyLeaseRegistry();
  if (residency !== null && residency.snapshot(opts.key.name).phase !== "open") return null;
  if (opts.restart === true) return null;
  const currentHash = computeModelHostSpecHash(specForHash(manifest.spec));
  if (priorState.specHash === undefined || priorState.specHash !== currentHash) return null;
  const endpoint = manifest.spec.endpoint;
  const declaredReadiness = normalizeReadiness(manifest.spec.readiness);
  const readiness = await (
    opts.probeReady !== undefined
      ? opts.probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS, declaredReadiness)
      : engine.probeReady(endpoint, ADOPT_PROBE_TIMEOUT_MS, declaredReadiness)
  ).catch(() => ({ ready: false, modelIds: [] as string[] }));
  if (!readiness.ready) return null;
  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) return null;
  foldDeclaredAliases(manifest.spec.extraArgs, readiness, firstHostedModel.rel);
  const aliases = new Set([firstHostedModel.rel, basename(firstHostedModel.rel)]);
  if (
    readiness.modelIds.length === 0 ||
    !readiness.modelIds.some((id) => aliases.has(id) || aliases.has(basename(id)))
  ) {
    return null;
  }
  if (!isProcessAlive(priorState.pid)) return null;
  const refreshed: ModelHostState = {
    kind: "ModelHost",
    engine: priorState.engine,
    pid: priorState.pid,
    host: priorState.host,
    port: priorState.port,
    modelAliases: priorState.modelAliases,
    startedAt: priorState.startedAt,
    slotSavePath: priorState.slotSavePath ?? null,
    specHash: priorState.specHash,
    // Legacy records predate binaryNames; an adopt must fold the manifest's
    // declared names in, or status/stop re-derive engine defaults and the
    // real argv0 fails identity (#806).
    ...binaryNamesField(
      reapBinaryNames(priorState.engine, priorState.binaryNames, manifest.spec.binaryNames),
    ),
    ...readinessField(declaredReadiness),
    ...scopeUnitField(priorState.scopeUnit),
  };
  // Only rewrite the sidecar when an out-of-hash field actually changed, so a
  // same-spec adopt leaves the state file byte-for-byte untouched.
  if (JSON.stringify(refreshed) !== JSON.stringify(priorState)) {
    writeFileSync(modelhostStateFile(resolved, opts.key), JSON.stringify(refreshed, null, 2));
  }
  return { ok: true, pid: priorState.pid, adopted: true };
}

// Reap a prior live ModelHost for this workload before spawning a new one.
// Without this, applying over a still-running host leaves the old process
// holding the endpoint port: the new omlx fails to bind and exits, yet
// probeReady is satisfied by the OLD listener, so we would record the new
// child's already-dead pid — which listLocalRoutes then drops from routing.
// Returns a terminal result (adopted or deferred) or null to proceed with a
// normal spawn.
async function reapOrAdoptPriorHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
): Promise<StartModelHostResult | null> {
  if (opts.commitReadiness !== undefined) return null;
  const priorState = readModelHostState(opts.key, resolved);
  if (!priorState) {
    return await reapStartingOrphan(manifest, opts, resolved, engine);
  }
  // The recorded pid is verified against the pid file it was recorded in
  // (written before the sidecar, so its mtime is the right identity anchor)
  // and corroborated by the engine's argv0. A recycled pid is not ours and
  // falls through to the dead-pid adopt/spawn path; an unverifiable one
  // defers the whole restart so the tracking files survive for a later
  // reconcile.
  const recordPath = modelhostPidFile(resolved, opts.key);
  const identity = hostIdentityDeps(
    priorState.engine,
    opts.identity,
    reapBinaryNames(priorState.engine, priorState.binaryNames, manifest.spec.binaryNames),
  );
  const priorVerdict = verifyPidFile(recordPath, priorState.pid, identity);
  if (priorVerdict === "alive") {
    // #806 phase 2: before disturbing a verified-alive host, check whether it
    // can be adopted (unchanged spec hash, healthy probe, still our model). A
    // live adopt never touches the residency/session fence — the running engine
    // is not being torn down — so it runs ahead of `fencePriorHostTeardown`.
    const adopted = await adoptUnchangedHost(manifest, opts, resolved, engine, priorState);
    if (adopted !== null) return adopted;
    // A resolved teardown is not proof the prior host released the port; only
    // a confirmed-gone re-check lets the replacement spawn. On failure the
    // state sidecar and recorded pid are left intact for a later reconcile.
    return await fencePriorHostTeardown(opts.key.name, () =>
      confirmRecordedTeardown(
        () =>
          engine.teardown(
            priorState.pid,
            teardownIdentity(recordPath, opts.identity, identity.expectCommand),
          ),
        recordPath,
        priorState.pid,
        identity,
      ),
    );
  }
  if (priorVerdict === "unknown") {
    return { ok: false, pid: null, error: "pid identity unknown; deferring restart" };
  }
  // Recorded pid is dead but a sidecar exists. Decide adopt-vs-spawn on
  // listener PRESENCE, not on the short readiness window: if a live process
  // already owns the endpoint (an out-of-band relaunch — manual restart, or
  // a crash + external respawn), a fresh spawn cannot bind the held port, so
  // we must never fall through to it.
  const findListenerPid =
    opts.findListenerPid ??
    ((endpoint): Promise<number | null> => defaultFindListenerPid(endpoint, opts.signal));
  const livePid = await findListenerPid(manifest.spec.endpoint).catch(() => null);
  if (livePid !== null && isProcessAlive(livePid)) {
    const adopted = await tryAdoptLiveHost(
      manifest,
      opts,
      resolved,
      opts.probeReady ??
        ((endpoint, timeoutMs): Promise<{ ready: boolean; modelIds: string[] }> =>
          engine.probeReady(endpoint, timeoutMs, normalizeReadiness(manifest.spec.readiness))),
      livePid,
      engine,
      priorState.specHash,
    );
    if (adopted === "relaunch") return null;
    if (adopted) return adopted;
    // A live process owns the port but is not (yet) confirmable as ours
    // (still loading, or an unrelated process). Defer to the next reconcile
    // tick rather than spawn a competitor that would only fail to bind.
    return {
      ok: false,
      pid: null,
      error: `endpoint ${manifest.spec.endpoint.host}:${String(manifest.spec.endpoint.port)} is held by live pid ${String(livePid)} that is not yet adoptable (readiness/model unconfirmed); deferring restart`,
    };
  }
  // No live listener — the port is free; fall through to a normal spawn,
  // after reaping any starting orphan a crashed agent left for this workload.
  return await reapStartingOrphan(manifest, opts, resolved, engine);
}

/**
 * Detach from the parent's reference count so subscription
 * teardown / generator cleanup cannot propagate a signal back
 * to the engine process. Mirrors core/src/server.ts:startServer
 * which uses the same detached + unref pattern for llama-server.
 */
function detachChild(child: ChildProcess): void {
  const maybeUnref = (child as { unref?: () => void }).unref;
  if (maybeUnref) maybeUnref.call(child);
}

/**
 * The readiness probe can be satisfied by a DIFFERENT process already bound
 * to this endpoint (e.g. a prior omlx we did not reap). If our spawned child
 * has already exited, refuse to record its dead pid — recording it would make
 * listLocalRoutes drop the ModelHost from routing. exitCode is null while the
 * child runs and a number once it exits (undefined for test stubs → running).
 */
function ensureSpawnedChildStillRunning(
  child: ChildProcess,
  pid: number,
  endpoint: { host: string; port: number },
): void {
  if (typeof child.exitCode === "number") {
    throw new Error(
      `modelhost child pid ${String(pid)} exited before readiness (endpoint ${endpoint.host}:${String(endpoint.port)} likely served by another process); refusing to record a stale pid`,
    );
  }
}

function resolveModelAliases(manifest: ModelHostManifest): string[] {
  const firstHostedModel = manifest.spec.hostedModels[0];
  if (!firstHostedModel) {
    throw new Error(`ModelHost ${manifest.metadata.name} has no hosted models`);
  }
  return Array.from(new Set([firstHostedModel.rel, basename(firstHostedModel.rel)]));
}

/**
 * Open a write-only append fd for the per-workload boot log, returning
 * "ignore" if the path escapes the runtime tree or opening fails. Boot
 * logging must never break a launch, and the workload name (which feeds
 * the path) ultimately comes from a user-supplied manifest.
 */
function modelHostBootLogPath(runtimeDir: string, workloadName: string): string {
  return resolve(runtimeDir, "workloads", workloadName, "modelhost.boot.log");
}

function openBootLogFd(workloadName: string, runtimeDir: string): "ignore" | number {
  const baseDir = resolve(runtimeDir, "workloads");
  const bootLogPath = modelHostBootLogPath(runtimeDir, workloadName);
  const allowedPrefix = `${baseDir}${sep}`;
  if (bootLogPath !== baseDir && !bootLogPath.startsWith(allowedPrefix)) {
    // Escaped the runtime tree; degrade to no boot log rather than fail.
    return "ignore";
  }
  try {
    // #333: a never-seen workload has no <runtime>/workloads/<name>/ yet and
    // openSync does not create it, so the first launch logged nothing.
    mkdirSync(dirname(bootLogPath), { recursive: true });
    return openSync(bootLogPath, "a");
  } catch {
    // never let logging break a launch
    return "ignore";
  }
}

function closeBootLogFd(fd: "ignore" | number): void {
  if (fd === "ignore") return;
  try {
    closeSync(fd);
  } catch {
    // Closing the parent's log copy cannot change the launch outcome.
  }
}

function teardownChildSilently(
  child: ChildProcess | null,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
): Promise<void> {
  if (child === null) return Promise.resolve();
  const pid = child.pid ?? null;
  // An exited child's pid may already be recycled; never signal it.
  if (pid === null || typeof child.exitCode === "number" || typeof child.signalCode === "string") {
    return Promise.resolve();
  }
  return engine.teardown(pid).catch(() => undefined);
}

// #318: the caller's AbortSignal must be able to settle a start while the
// readiness probe is still polling a full timeout budget. The abandoned probe
// is not cancelled — the owner turns this sentinel into a failure whose catch
// tears the spawned child down, so a wedged probe can never record or keep
// alive a process the caller walked away from. A joined caller only detaches.
const MODEL_HOST_ABORT_MESSAGE = "modelHostStart aborted";
const MODEL_HOST_ABORTED = Symbol(MODEL_HOST_ABORT_MESSAGE);

async function raceModelHostAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof MODEL_HOST_ABORTED> {
  if (!signal) return await work;
  if (signal.aborted) return MODEL_HOST_ABORTED;
  return await new Promise<T | typeof MODEL_HOST_ABORTED>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(MODEL_HOST_ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// #806 phase 3: a scoped engine can die during the readiness wait; racing the
// probe against the child's exit settles the wait immediately instead of
// polling out the full budget. Never rejects.
function watchChildExit(
  child: ChildProcess,
): Promise<{ exited: true; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
      resolve({
        exited: true,
        code: child.exitCode ?? null,
        signal: child.signalCode ?? null,
      });
      return;
    }
    child.once("exit", (code, signal) => {
      resolve({ exited: true, code, signal });
    });
  });
}

// The engine-exited outcome gets the same message the readiness race throws,
// so a scoped engine that dies before readiness reads identically either way.
function scopeLaunchErrorMessage(outcome: ScopeOutcome, pid: number, scopeUnit: string): string {
  if (outcome.kind === "engine-exited") {
    return `engine pid ${String(pid)} exited before readiness (code ${String(outcome.code)}, signal ${String(outcome.signal)}) in scope ${scopeUnit}`;
  }
  return describeScopeOutcome(outcome, scopeUnit);
}

/**
 * A pushed inline manifest (e.g. from the central controller's apply) must
 * not erase a managed-by marker already on disk for the same name. A label
 * present on the pushed manifest wins; a missing/malformed on-disk copy is
 * ignored.
 */
function mergeDiskManagedByLabel(
  manifest: ModelHostManifest,
  workloadsDir?: string,
): ModelHostManifest {
  if (externalManagerOf(manifest) !== null) return manifest;
  let diskManager: string | null = null;
  try {
    diskManager = externalManagerOf(loadModelHostByName(manifest.metadata.name, workloadsDir));
  } catch {
    return manifest;
  }
  if (diskManager === null) return manifest;
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      labels: { ...manifest.metadata.labels, [MANAGED_BY_LABEL]: diskManager },
    },
  };
}

// Loud stderr line on every launch that knowingly exposes an engine past
// loopback — the opt-in is per-workload, so the operator running the agent
// should still see it in the agent log.  When spec.apiKeyRef is present the
// child is authenticated but the operator still needs to see the warning:
// the key lives in a secret store, not on this node.
function modelHostWarn(opts: StartModelHostOptions): (message: string) => void {
  return (
    opts.warn ??
    ((message: string): void => {
      process.stderr.write(`${message}\n`);
    })
  );
}

function warnExternalBind(manifest: ModelHostManifest, opts: StartModelHostOptions): void {
  const externalHost = modelHostExternalBindHost(manifest.spec);
  if (externalHost === null || manifest.spec.allowExternalBind !== true) return;
  const warn = modelHostWarn(opts);
  const endpoint = `${externalHost}:${String(manifest.spec.endpoint.port)}`;
  const prefix = `[agent] WARNING: ModelHost ${manifest.metadata.name} (${manifest.spec.engine})`;
  warn(
    manifest.spec.apiKeyRef !== undefined
      ? `${prefix} is binding an engine authenticated by spec.apiKeyRef to ${endpoint} (spec.allowExternalBind: true)`
      : `${prefix} is binding an unauthenticated engine to ${endpoint} (spec.allowExternalBind: true)`,
  );
}

// #318: at most one start per ModelHost in flight in this agent process. A
// second startModelHost for the same workload (the CLI's in-process apply
// racing the controller's tick) joins the running start instead of spawning a
// competing engine: the pid sidecar is only written after readiness, so the
// second call's reapOrAdoptPriorHost cannot see the first child.
interface InFlightModelHostStart {
  specHash: string;
  promise: Promise<StartModelHostResult>;
}
const inFlightModelHostStarts = new Map<string, InFlightModelHostStart>();

// A joined caller's abort only detaches that caller: the owning start keeps
// running and is torn down solely by the owner's signal.
async function joinInFlightModelHostStart(
  inFlight: InFlightModelHostStart,
  specHash: string,
  name: string,
  signal: AbortSignal | undefined,
): Promise<StartModelHostResult> {
  if (inFlight.specHash !== specHash) {
    return {
      ok: false,
      pid: null,
      error: `modelHostStart already in progress for ${name} with a different spec`,
    };
  }
  const settled = await raceModelHostAbort(inFlight.promise, signal);
  if (settled === MODEL_HOST_ABORTED) {
    return { ok: false, pid: null, error: MODEL_HOST_ABORT_MESSAGE };
  }
  return settled;
}

interface ModelHostLaunchContext {
  env: NodeJS.ProcessEnv;
  runtimeEnv: NodeJS.ProcessEnv;
  resolved: ReturnType<typeof resolveEnv>;
  engine: (typeof ENGINES)[keyof typeof ENGINES];
  spec: ModelHostSpecForEngine;
  apiKey?: string;
}

// #806 phase 3: everything a scoped ModelHost launch needs, resolved before
// the wrapper spawn. `scopeUnit` is fixed here so the starting record, the
// exec handshake and the fallback gate all name the same unit.
interface ModelHostScopeLaunch {
  launcher: EngineScopeLauncher;
  plan: {
    systemdRunPath: string;
    base: string;
    env: NodeJS.ProcessEnv;
    bootFd: number;
  };
  scopeUnit: string;
}

// Every precondition failure — no boot-log evidence channel, an explicit null
// launcher, an env conflict, a failed capability resolve — returns null and
// the caller takes the byte-identical direct spawn.
type ModelHostCommand = OmlxCacheLaunch & {
  envOverrides?: Record<string, string>;
  beforeDispatch?: () => void;
};

async function resolveModelHostScopePlan(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  launch: ModelHostCommand,
  childEnv: NodeJS.ProcessEnv,
  runtimeEnv: NodeJS.ProcessEnv,
  bootStdio: "ignore" | number,
): Promise<ModelHostScopeLaunch | null> {
  if (bootStdio === "ignore") return null;
  const launcher = opts.engineScope !== undefined ? opts.engineScope : getEngineScopeLauncher();
  if (launcher === null) return null;
  const declaredKeys = [
    ...Object.keys(launch.envOverrides ?? {}),
    ...Object.keys(manifest.spec.env ?? {}),
  ];
  const shaped = shapeScopeEnv(childEnv, runtimeEnv, declaredKeys);
  if ("conflict" in shaped) {
    modelHostWarn(opts)(
      `ModelHost ${opts.key.name}: engine scope env-conflict (${shaped.conflict}); spawning directly`,
    );
    return null;
  }
  let resolution: ScopeResolveResult;
  try {
    resolution = await launcher.resolve(runtimeEnv);
  } catch {
    // A throwing resolve is a failed capability probe: stay direct.
    resolution = { ok: false, reason: "probe-failed" };
  }
  if (!resolution.ok) return null;
  const base = scopeUnitBase(opts.key.name, launcher.unitSuffix());
  return {
    launcher,
    plan: {
      systemdRunPath: resolution.systemdRunPath,
      base,
      env: shaped.env,
      bootFd: bootStdio,
    },
    scopeUnit: `${base}.scope`,
  };
}

// Scheme prefixes resolveSecret routes on (mirrors its classify()). A ref
// with none of them is a legacy bare file path — or a key pasted where a
// ref belongs — so it is never echoed into an error.
const SECRET_REF_SCHEME_PREFIXES = ["env:", "$", "keychain:", "file:"] as const;
const REDACTED_UNPREFIXED_REF = "<redacted: ref has no env:/$/file:/keychain: prefix>";

function hasSecretRefSchemePrefix(ref: string): boolean {
  const trimmed = ref.trim();
  return SECRET_REF_SCHEME_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// #214: resolve spec.apiKeyRef to the LLAMA_API_KEY value. An absent ref
// resolves to no key; a ref that throws or yields "" is a refusal whose
// reason is resolveSecret's redaction-safe message, never the value.
// `refLabel` is the ref as it may appear in an error: verbatim when it
// carries a scheme prefix, redacted otherwise. For an unprefixed ref the
// thrown reason is replaced too, since resolveSecret's legacy-file-path
// message echoes the path (which is the ref itself).
function resolveModelHostApiKey(
  apiKeyRef: string | undefined,
  runtimeEnv: NodeJS.ProcessEnv,
): { ok: true; apiKey: string | undefined } | { ok: false; refLabel: string; reason: string } {
  if (apiKeyRef === undefined) return { ok: true, apiKey: undefined };
  const prefixed = hasSecretRefSchemePrefix(apiKeyRef);
  const refLabel = prefixed ? apiKeyRef : REDACTED_UNPREFIXED_REF;
  try {
    const value = resolveSecret(apiKeyRef, runtimeEnv);
    if (value === "") return { ok: false, refLabel, reason: "resolved to an empty string" };
    return { ok: true, apiKey: value };
  } catch (error) {
    const reason = prefixed
      ? error instanceof Error
        ? error.message
        : String(error)
      : "unprefixed ref did not resolve as a legacy file path";
    return { ok: false, refLabel, reason };
  }
}

// #806 phase 3: the scoped half of a ModelHost spawn — plan, wrapper spawn,
// starting record and the exec handshake — without the fallback decision, so
// launchModelHost stays inside the function-size lint budget. "pre-exec"
// covers every non-established, non-aborted outcome; the caller's gate decides
// whether it may fall back to a direct spawn.
type ScopedSpawnAttempt =
  | { kind: "established"; child: ChildProcess; pid: number; scope: ModelHostScopeLaunch }
  | {
      kind: "pre-exec";
      child: ChildProcess;
      pid: number;
      scope: ModelHostScopeLaunch;
      outcome: ScopeOutcome;
    }
  | { kind: "aborted"; child: ChildProcess; pid: number; scope: ModelHostScopeLaunch }
  | { kind: "none" };

function enforceManagedHostSpawn(
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
): void {
  if (opts.checkSpawn === undefined) return;
  if (managedRuntimeRefusesMutation(resolved.LOCAL_AI_RUNTIME_DIR)) {
    throw new Error("ManagedOwnerRequired");
  }
  const refusal = opts.checkSpawn();
  if (refusal !== undefined) throw new Error(refusal);
}

async function attemptScopedModelHostSpawn(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  launch: ModelHostCommand,
  childEnv: NodeJS.ProcessEnv,
  runtimeEnv: NodeJS.ProcessEnv,
  bootStdio: "ignore" | number,
  resolved: ReturnType<typeof resolveEnv>,
  startSpecHash: string,
  onSpawned?: (child: ChildProcess, pid: number, scope: ModelHostScopeLaunch) => void,
): Promise<ScopedSpawnAttempt> {
  const spawn = opts.spawn ?? nodeSpawn;
  const scoped = await resolveModelHostScopePlan(
    opts,
    manifest,
    launch,
    childEnv,
    runtimeEnv,
    bootStdio,
  );
  if (scoped === null) return { kind: "none" };
  const offset = fstatSync(scoped.plan.bootFd).size;
  enforceManagedHostSpawn(opts, resolved);
  launch.beforeDispatch?.();
  const child = spawn(
    scoped.plan.systemdRunPath,
    buildScopeArgv(scoped.plan.base, opts.key.name, launch.binary, launch.args),
    {
      detached: true,
      stdio: ["ignore", scoped.plan.bootFd, scoped.plan.bootFd],
      env: scoped.plan.env,
    },
  );
  const pid = child.pid ?? null;
  if (pid === null) {
    // No process exists to handshake; the capability just proved flaky.
    scoped.launcher.noteFailure();
    return { kind: "none" };
  }
  detachChild(child);
  onSpawned?.(child, pid, scoped);
  // #317: track the child at spawn, before readiness. An agent that dies
  // during the wait below must leave a record a restarted agent can reap.
  writeModelHostStarting(
    {
      kind: "ModelHostStarting",
      engine: manifest.spec.engine,
      pid,
      startedAt: new Date().toISOString(),
      specHash: startSpecHash,
      ...(manifest.spec.omlxCacheEpoch !== undefined
        ? omitUndefined({ slotSavePath: launch.slotSavePath })
        : {}),
      ...binaryNamesField(manifest.spec.binaryNames),
      ...scopeUnitField(scoped.scopeUnit),
    },
    opts.key,
    resolved,
  );
  const outcome = await awaitScopeExec({
    child,
    pid,
    logPath: modelHostBootLogPath(resolved.LOCAL_AI_RUNTIME_DIR, opts.key.name),
    offset,
    base: scoped.plan.base,
    timeoutMs: scoped.launcher.establishTimeoutMs,
    ...omitUndefined({ signal: opts.signal }),
  });
  if (outcome.kind === "aborted") {
    return { kind: "aborted", child, pid, scope: scoped };
  }
  if (outcome.kind === "established") {
    return { kind: "established", child, pid, scope: scoped };
  }
  return { kind: "pre-exec", child, pid, scope: scoped, outcome };
}

// The direct spawn — also the scoped path's single fallback target. Writes the
// same starting record minus scopeUnit so pre-#806 records stay byte-identical.
function spawnDirectModelHostChild(
  launch: ModelHostCommand,
  childEnv: NodeJS.ProcessEnv,
  bootStdio: "ignore" | number,
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  resolved: ReturnType<typeof resolveEnv>,
  startSpecHash: string,
  onSpawned?: (child: ChildProcess, pid: number) => void,
): { child: ChildProcess; pid: number } {
  const spawn = opts.spawn ?? nodeSpawn;
  enforceManagedHostSpawn(opts, resolved);
  launch.beforeDispatch?.();
  const child = spawn(launch.binary, launch.args, {
    detached: true,
    stdio: bootStdio === "ignore" ? "ignore" : ["ignore", bootStdio, bootStdio],
    env: childEnv,
  });
  const pid = child.pid ?? null;
  if (pid === null) {
    throw new Error("failed to spawn modelhost process");
  }
  detachChild(child);
  onSpawned?.(child, pid);

  // #317: track the child at spawn, before readiness. An agent that dies
  // during the wait below must leave a record a restarted agent can reap.
  writeModelHostStarting(
    {
      kind: "ModelHostStarting",
      engine: manifest.spec.engine,
      pid,
      startedAt: new Date().toISOString(),
      specHash: startSpecHash,
      ...(manifest.spec.omlxCacheEpoch !== undefined
        ? omitUndefined({ slotSavePath: launch.slotSavePath })
        : {}),
      ...binaryNamesField(manifest.spec.binaryNames),
    },
    opts.key,
    resolved,
  );
  return { child, pid };
}

// #318: the readiness wait is where a slow start outlives its caller. Racing
// the signal here means an abort lands on the child we just spawned (torn
// down by the caller's catch, starting record included), not after the
// probe's full timeout budget. #806 phase 3: a scoped engine can die during
// the wait; the probe races the child's exit so the failure surfaces
// immediately with the scope named.
async function awaitModelHostReadiness(
  opts: StartModelHostOptions,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
  manifest: ModelHostManifest,
  spec: ModelHostSpecForEngine,
  child: ChildProcess,
  pid: number,
  scoped: ModelHostScopeLaunch | null,
): Promise<void> {
  const endpoint = manifest.spec.endpoint;
  const exitWatch = scoped === null ? null : watchChildExit(child);
  const readinessWork = (opts.probeReady ?? engine.probeReady)(
    endpoint,
    (opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000,
    spec.readiness,
  );
  const readiness = await raceModelHostAbort(
    exitWatch === null ? readinessWork : Promise.race([readinessWork, exitWatch]),
    opts.signal,
  );
  if (readiness === MODEL_HOST_ABORTED) {
    throw new Error(MODEL_HOST_ABORT_MESSAGE);
  }
  if ("exited" in readiness) {
    // exitWatch is armed only for a scoped launch, so scoped is set here.
    const scopeUnit = scoped?.scopeUnit ?? "unknown";
    throw new Error(
      `engine pid ${String(pid)} exited before readiness (code ${String(readiness.code)}, signal ${String(readiness.signal)}) in scope ${scopeUnit}`,
    );
  }
  if (!readiness.ready) {
    throw new Error("modelhost failed readiness probe");
  }
}

// The single direct-spawn fallback gate (#806 phase 3): allowed only for a
// fallback-eligible outcome while OUR starting record still names this unit
// and no stop tombstone does — a mid-handshake stop must never be
// double-booted by a direct spawn. Throws the scope outcome's message when
// the gate refuses; otherwise clears the record, notes the capability failure
// and warns before the caller re-spawns directly.
function scopedLaunchFallback(
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  scoped: ModelHostScopeLaunch,
  outcome: ScopeOutcome,
  pid: number,
): void {
  const workloadDir = workloadRuntimeDir(resolved, opts.key);
  const mayFallback =
    isScopeFallback(outcome) &&
    readModelHostStarting(opts.key, resolved)?.scopeUnit === scoped.scopeUnit &&
    !scopeStopNames(workloadDir, "modelhost", scoped.scopeUnit) &&
    opts.signal?.aborted !== true;
  if (!mayFallback) {
    throw new Error(scopeLaunchErrorMessage(outcome, pid, scoped.scopeUnit));
  }
  clearStartingRecordIfOwned(opts.key, resolved, pid);
  scoped.launcher.noteFailure();
  modelHostWarn(opts)(
    `ModelHost ${opts.key.name}: engine scope ${scoped.scopeUnit} ${describeScopeOutcome(outcome)}; falling back to direct spawn`,
  );
}

// Kapitsa keeps KAPITSA_HOME and libosmos its .osmos/osmos.json beside the
// workload's pid/state/boot log, so their boot envs always see the resolved
// launch root. Other engines keep an operator-set LLAMACTL_RUNTIME_DIR (it
// still redirects e.g. oMLX's .omlx) and otherwise fall back to the resolved
// runtime dir, never to a bare resolveEnv() inside the engine: an injected
// runtimeDir (tests, scoped agents) must reroot their boot writes too.
function modelHostBootEnv(
  env: NodeJS.ProcessEnv,
  resolved: ReturnType<typeof resolveEnv>,
  spec: ModelHostSpecForEngine,
  workloadName: string,
): EngineBootEnv {
  return {
    ...omitUndefined({
      LLAMACTL_MODELS_DIR: env["LLAMACTL_MODELS_DIR"],
      LLAMA_CPP_MODELS: env["LLAMA_CPP_MODELS"],
      LLAMACTL_RUNTIME_DIR:
        spec.engine === "kapitsa" || spec.engine === "libosmos"
          ? resolved.LOCAL_AI_RUNTIME_DIR
          : (env["LLAMACTL_RUNTIME_DIR"] ?? resolved.LOCAL_AI_RUNTIME_DIR),
    }),
    workloadName,
    machineProfile: resolved.LLAMA_CPP_MACHINE_PROFILE,
  };
}

function publishReadyModelHost(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  ctx: ModelHostLaunchContext,
  runtime: { child: ChildProcess; pid: number; scoped: ModelHostScopeLaunch | null },
  launch: { specHash: string; slotSavePath: string | null; publish(): void },
): void {
  const { resolved, spec } = ctx;
  const { child, pid, scoped } = runtime;
  ensureSpawnedChildStillRunning(child, pid, manifest.spec.endpoint);
  const refusal = opts.commitReadiness?.(pid);
  if (refusal !== undefined) throw new Error(refusal);
  if (opts.commitReadiness !== undefined && opts.manifest !== undefined) {
    saveModelHost(mergeDiskManagedByLabel(manifest, opts.workloadsDir), opts.workloadsDir);
  }
  const endpoint = manifest.spec.endpoint;
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: manifest.spec.engine,
      pid,
      host: endpoint.host,
      port: endpoint.port,
      modelAliases: resolveModelAliases(manifest),
      startedAt: new Date().toISOString(),
      slotSavePath: launch.slotSavePath,
      specHash: launch.specHash,
      ...binaryNamesField(manifest.spec.binaryNames),
      ...(manifest.spec.omlxNativeResidency === undefined
        ? readinessField(spec.readiness)
        : { requiresOwnerTransport: true, readiness: ownedOmlxReadiness(manifest) }),
      ...scopeUnitField(scoped?.scopeUnit),
    },
    opts.key,
    resolved,
  );
  launch.publish();
  clearStartingRecordIfOwned(opts.key, resolved, pid);
}

// #806 phase 3: a scoped child that never exited (hung-unreaped) may still be
// alive inside its scope; keep the starting record so a later reap can find
// it. Every other failure clears the record as before.
async function teardownFailedModelHostLaunch(
  child: ChildProcess | null,
  engine: (typeof ENGINES)[keyof typeof ENGINES],
  scoped: ModelHostScopeLaunch | null,
  startingPid: number | null,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
  nativeBoot: OwnedOmlxBoot | undefined,
): Promise<void> {
  if (nativeBoot !== undefined) {
    if (child === null || startingPid === null) return;
    const exited = (): boolean =>
      typeof child.exitCode === "number" || typeof child.signalCode === "string";
    const verifyGeneration: NonNullable<PidIdentityDeps["verifyGeneration"]> = (pid) => {
      if (pid !== startingPid) return "unknown";
      if (exited()) return "dead";
      return nativeBoot.ticket?.processCurrent() === true ? "alive" : "unknown";
    };
    if (verifyGeneration(startingPid) === "alive") {
      await engine
        .teardown(startingPid, {
          recordPath: modelhostStartingFile(resolved, opts.key),
          deps: { verifyGeneration },
        })
        .catch(() => undefined);
    }
    if (exited()) clearStartingRecordIfOwned(opts.key, resolved, startingPid);
    return;
  }
  await teardownChildSilently(child, engine);
  const keepStartingRecord =
    scoped !== null && child !== null && child.exitCode === null && child.signalCode === null;
  if (startingPid !== null && !keepStartingRecord) {
    clearStartingRecordIfOwned(opts.key, resolved, startingPid);
  }
}

function nativeOmlxOwnerRefusal(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
): StartModelHostResult | undefined {
  if (manifest.spec.omlxNativeResidency === undefined) return undefined;
  if (
    currentNativeOmlxOwner()?.canServe(manifest.spec.endpoint.port) === true &&
    managedNativeLaunch(opts.key.name) !== undefined
  )
    return undefined;
  return failedModelHostStart(
    new Error("ManagedNativeOmlxOwnerUnavailable"),
    undefined,
    opts.commitReadiness !== undefined,
  );
}

type OwnedOmlxBoot = {
  auth: ReturnType<typeof prepareOmlxOwnerLaunch>;
  bind: NonNullable<ReturnType<typeof managedNativeLaunch>>;
  ticket?: NonNullable<ReturnType<OwnedOmlxBoot["bind"]>>;
  owner: NonNullable<ReturnType<typeof currentNativeOmlxOwner>>;
};

function prepareOwnedOmlxBoot(
  manifest: ModelHostManifest,
  launch: ModelHostCommand,
  childEnv: NodeJS.ProcessEnv,
): OwnedOmlxBoot | undefined {
  if (manifest.spec.omlxNativeResidency === undefined) return undefined;
  const workload = manifest.metadata.name;
  const owner = currentNativeOmlxOwner();
  const bind = managedNativeLaunch(workload);
  const model = manifest.spec.hostedModels[0];
  if (owner === undefined || bind === undefined || model === undefined) {
    throw new Error("ManagedNativeOmlxOwnerUnavailable");
  }
  const auth = prepareOmlxOwnerLaunch(launch, childEnv, model.rel);
  owner.protect(workload);
  return { auth, bind, owner };
}

function ownedOmlxReadiness(manifest: ModelHostManifest): ModelHostReadiness {
  return normalizeReadiness(manifest.spec.readiness) ?? { path: "/health" };
}

async function awaitOwnedOmlxReadiness(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  boot: OwnedOmlxBoot,
  pid: number,
  resolved: ReturnType<typeof resolveEnv>,
): Promise<() => void> {
  const ticket = boot.bind(pid);
  if (ticket === undefined) throw new Error("ManagedNativeOmlxGenerationUnverified");
  boot.ticket = ticket;
  const { endpoint } = manifest.spec;
  const { auth, owner } = boot;
  const signal = AbortSignal.any([
    AbortSignal.timeout((opts.timeoutSeconds ?? manifest.spec.timeoutSeconds) * 1000),
    ...(opts.signal === undefined ? [] : [opts.signal]),
  ]);
  while (
    !signal.aborted &&
    ticket.current() &&
    (await defaultFindListenerPid(endpoint, signal, true)) !== pid
  ) {
    await Bun.sleep(100);
  }
  signal.throwIfAborted();
  const readiness = ownedOmlxReadiness(manifest);
  const connect = connectOmlxOwnerSocket(endpoint, pid, ticket.processCurrent);
  const currentLaunch = (): boolean => ticket.current() && auth.verifyLaunchInputs();
  const bootReady = await loadInitiallyOwnedOmlx({
    binding: {
      endpoint,
      modelId: auth.modelId,
      modelPath: auth.modelPath,
      artifactRevision: auth.artifactRevision,
      runtimeGeneration: ticket.runtime.birthId,
      stillCurrent: ticket.processCurrent,
    },
    apiKey: auth.apiKey,
    readiness,
    verifyReservation: currentLaunch,
    connect: connectOmlxOwnerSocket(endpoint, pid, currentLaunch),
    admitLoad: () => opts.checkSpawn?.() === undefined && currentLaunch(),
    signal,
  });
  if (!bootReady) throw new Error("ManagedNativeOmlxReadinessUnverified");
  const specHash = computeModelHostSpecHash(specForHash(manifest.spec));
  return (): void => {
    owner.register(manifest.metadata.name, endpoint, auth.apiKey, readiness.path, connect, () => {
      const state = readModelHostState(opts.key, resolved);
      return (
        state?.pid === pid &&
        state.requiresOwnerTransport === true &&
        state.specHash === specHash &&
        state.host === endpoint.host &&
        state.port === endpoint.port &&
        auth.verify() &&
        ticket.processCurrent()
      );
    });
  };
}

async function prepareModelHostCommand(
  manifest: ModelHostManifest,
  workload: string,
  ctx: ModelHostLaunchContext,
  dispatch: { attempted: boolean },
): Promise<{
  launch: ModelHostCommand;
  childEnv: NodeJS.ProcessEnv;
  nativeBoot: OwnedOmlxBoot | undefined;
}> {
  const { env, runtimeEnv, resolved, engine, spec, apiKey } = ctx;
  const boot = modelHostBootEnv(env, resolved, spec, workload);
  const slots = resolveSlotSavePathArgs(
    manifest.spec.extraArgs,
    resolved.LOCAL_AI_RUNTIME_DIR,
    workload,
  );
  spec.extraArgs = slots.args;
  await engine.prepareLaunch?.(spec, boot);
  const command = engine.buildBootCommand(spec, boot);
  const childEnv = sanitizeChildEnv(runtimeEnv, command.envOverrides, manifest.spec.env, apiKey);
  const cacheEpoch = spec.omlxCacheEpoch;
  const launch =
    cacheEpoch === undefined
      ? { ...command, slotSavePath: slots.slotSavePath }
      : {
          ...command,
          ...prepareOmlxCacheLaunch(
            command,
            childEnv,
            manifest.spec.hostedModels[0]?.rel ?? "",
            cacheEpoch,
          ),
        };
  const nativeBoot = prepareOwnedOmlxBoot(manifest, launch, childEnv);
  return {
    launch: {
      ...launch,
      beforeDispatch(): void {
        launch.verifyCacheInputs?.();
        if (nativeBoot !== undefined && !nativeBoot.auth.verifyLaunchInputs())
          throw new Error("ManagedNativeOmlxInputsChanged");
        dispatch.attempted = true;
      },
    },
    childEnv: nativeBoot?.auth.env ?? childEnv,
    nativeBoot,
  };
}

function failedModelHostStart(
  error: unknown,
  spawnedPid: number | undefined,
  cacheBeforeDispatch: boolean,
): StartModelHostResult {
  const message = error instanceof Error ? error.message : "modelhost start failed";
  return {
    ok: false,
    pid: null,
    error: message,
    ...omitUndefined({ spawnedPid, preDispatchRefusal: cacheBeforeDispatch ? message : undefined }),
  };
}

async function modelHostLaunchReadiness(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  ctx: ModelHostLaunchContext,
  runtime: { child: ChildProcess; pid: number; scoped: ModelHostScopeLaunch | null },
  native?: OwnedOmlxBoot,
): Promise<() => void> {
  if (native !== undefined)
    return await awaitOwnedOmlxReadiness(opts, manifest, native, runtime.pid, ctx.resolved);
  await awaitModelHostReadiness(
    opts,
    ctx.engine,
    manifest,
    ctx.spec,
    runtime.child,
    runtime.pid,
    runtime.scoped,
  );
  return (): void => {
    currentNativeOmlxOwner()?.clear(opts.key.name);
  };
}

async function finishModelHostLaunch(
  opts: StartModelHostOptions,
  manifest: ModelHostManifest,
  ctx: ModelHostLaunchContext,
  runtime: { child: ChildProcess; pid: number; scoped: ModelHostScopeLaunch | null },
  launch: { specHash: string; slotSavePath: string | null; nativeBoot: OwnedOmlxBoot | undefined },
): Promise<void> {
  const { specHash, slotSavePath, nativeBoot } = launch;
  const publish = await modelHostLaunchReadiness(opts, manifest, ctx, runtime, nativeBoot);
  if (nativeBoot !== undefined && !nativeBoot.auth.verifyLaunchInputs()) {
    throw new Error("ManagedNativeOmlxInputsChanged");
  }
  publishReadyModelHost(opts, manifest, ctx, runtime, { specHash, slotSavePath, publish });
}

async function launchModelHost(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  ctx: ModelHostLaunchContext,
): Promise<StartModelHostResult> {
  const { runtimeEnv, resolved, engine, spec } = ctx;
  if (opts.signal?.aborted) {
    const result = { ok: false, pid: null, error: MODEL_HOST_ABORT_MESSAGE };
    opts.onEvent?.({ type: "done", result });
    return result;
  }
  const early = await reapOrAdoptPriorHost(manifest, opts, resolved, engine);
  if (early) {
    opts.onEvent?.({ type: "done", result: early });
    return early;
  }

  warnExternalBind(manifest, opts);

  let child: ChildProcess | null = null;
  let startingPid: number | null = null;
  let scoped: ModelHostScopeLaunch | null = null;
  const dispatch = { attempted: false };
  let nativeBoot: OwnedOmlxBoot | undefined;
  let bootStdio: "ignore" | number = "ignore";
  const startSpecHash = computeModelHostSpecHash(specForHash(manifest.spec));
  try {
    const prepared = await prepareModelHostCommand(manifest, opts.key.name, ctx, dispatch);
    const { launch, childEnv } = prepared;
    nativeBoot = prepared.nativeBoot;
    bootStdio = openBootLogFd(opts.key.name, resolved.LOCAL_AI_RUNTIME_DIR);
    // #806 phase 3: with a published launcher (Linux agents), try the scoped
    // launch first; every precondition failure falls through to the direct
    // spawn below unchanged.
    const attempt = await attemptScopedModelHostSpawn(
      // Scoped launchers may serialize the child environment into their argv.
      nativeBoot === undefined ? opts : { ...opts, engineScope: null },
      manifest,
      launch,
      childEnv,
      runtimeEnv,
      bootStdio,
      resolved,
      startSpecHash,
      (spawnedChild, spawnedPid, scope) => {
        child = spawnedChild;
        startingPid = spawnedPid;
        scoped = scope;
      },
    );
    if (attempt.kind === "established") {
      child = attempt.child;
      startingPid = attempt.pid;
      scoped = attempt.scope;
    } else if (attempt.kind === "aborted") {
      child = attempt.child;
      startingPid = attempt.pid;
      scoped = attempt.scope;
      throw new Error(MODEL_HOST_ABORT_MESSAGE);
    } else if (attempt.kind === "pre-exec") {
      child = attempt.child;
      startingPid = attempt.pid;
      scoped = attempt.scope;
      scopedLaunchFallback(opts, resolved, scoped, attempt.outcome, attempt.pid);
      child = null;
      scoped = null;
      startingPid = null;
    }
    if (child === null) {
      const direct = spawnDirectModelHostChild(
        launch,
        childEnv,
        bootStdio,
        opts,
        manifest,
        resolved,
        startSpecHash,
        (spawnedChild, spawnedPid) => {
          child = spawnedChild;
          startingPid = spawnedPid;
        },
      );
      child = direct.child;
      startingPid = direct.pid;
    }

    const pid = startingPid;
    if (pid === null) {
      throw new Error("failed to spawn modelhost process");
    }
    await finishModelHostLaunch(
      opts,
      manifest,
      ctx,
      { child, pid, scoped },
      {
        specHash: startSpecHash,
        slotSavePath: launch.slotSavePath,
        nativeBoot,
      },
    );
    const result = { ok: true, pid };
    opts.onEvent?.({ type: "done", result });
    return result;
  } catch (error) {
    const spawnedPid = child?.pid;
    await teardownFailedModelHostLaunch(
      child,
      engine,
      scoped,
      startingPid,
      opts,
      resolved,
      nativeBoot,
    );
    const result = failedModelHostStart(
      error,
      spawnedPid,
      spec.omlxCacheEpoch !== undefined && !dispatch.attempted,
    );
    opts.onEvent?.({ type: "done", result });
    return result;
  } finally {
    closeBootLogFd(bootStdio);
  }
}

// #557 S5: the residency state a same-group peer is observed in, or null
// when it holds nothing. Ordered cheapest-first: an in-flight registration
// or a live/unverifiable starting record means Starting; otherwise the
// recorded sidecar decides Running vs Unknown, failing closed on an
// unverifiable pid exactly like the #317 reap paths.
function residencyPeerState(
  peerKey: WorkloadKey,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
): "Running" | "Starting" | "Unknown" | null {
  if (inFlightModelHostStarts.has(`${resolved.LOCAL_AI_RUNTIME_DIR}\0${peerKey.name}`)) {
    return "Starting";
  }
  const starting = readModelHostStarting(peerKey, resolved);
  if (starting !== null) {
    const verdict = verifyPidFile(
      modelhostStartingFile(resolved, peerKey),
      starting.pid,
      startingIdentityDeps(starting, opts.identity, starting.binaryNames),
    );
    if (verdict === "alive" || verdict === "unknown") return "Starting";
  }
  const status = statusModelHost({
    key: peerKey,
    ...omitUndefined({
      runtimeDir: opts.runtimeDir,
      env: opts.env,
      identity: opts.identity,
    }),
  });
  if (status.state === "Running") return "Running";
  if (status.identityUnknown === true) return "Unknown";
  return null;
}

// #557 S5: ModelHosts carrying the same residency-group label share
// exclusive memory on the node, so at most one may hold the group at a
// time. The guard runs before the manifest is persisted and before any
// reap/spawn, so a refused start leaves no desired state behind. The scope
// is this agent's store and runtime dir — that IS the node, so spec.node
// is deliberately not consulted. In-process starts are race-free because
// in-flight registration is synchronous; two separate agent processes
// (e.g. a CLI in-process apply and the daemon) starting different group
// members at the same instant can both pass, because a peer's starting
// record is written only after prepareLaunch and spawn — a known limit; a
// per-group lock file under the runtime dir is out of scope.
function residencyGroupConflict(
  manifest: ModelHostManifest,
  opts: StartModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
): { group: string; host: string; state: "Running" | "Starting" | "Unknown" } | null {
  const group = manifest.metadata.labels?.[RESIDENCY_GROUP_LABEL];
  if (group === undefined || group === "") return null;
  for (const peer of listModelHosts(opts.workloadsDir)) {
    if (peer.metadata.name === manifest.metadata.name) continue;
    if (peer.metadata.labels?.[RESIDENCY_GROUP_LABEL] !== group) continue;
    const state = residencyPeerState({ name: peer.metadata.name }, opts, resolved);
    if (state !== null) {
      return { group, host: peer.metadata.name, state };
    }
  }
  return null;
}

export interface PinnedModelHostStartup {
  manifest: ModelHostManifest;
  env: NodeJS.ProcessEnv;
  effectiveSpecDigest: string;
  effectiveLaunch: Readonly<Record<string, unknown>>;
}

export function pinModelHostStartup(input: ModelHostManifest): PinnedModelHostStartup {
  const manifest = ModelHostManifestSchema.parse(input);
  const env = { ...process.env };
  const resolved = resolveEnv(env);
  const boot = modelHostBootEnv(
    env,
    resolved,
    buildModelHostSpec(manifest),
    manifest.metadata.name,
  );
  const effective = {
    name: manifest.metadata.name,
    labels: manifest.metadata.labels,
    spec: manifest.spec,
    boot,
    modelsDir: resolved.LLAMA_CPP_MODELS,
    runtimeDir: resolved.LOCAL_AI_RUNTIME_DIR,
    childEnv: sanitizeChildEnv(env, undefined, manifest.spec.env),
  };
  const canonical = JSON.stringify(effective, (_key: string, value: unknown): unknown =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, Reflect.get(value, key)]),
        )
      : value,
  );
  const effectiveLaunch = structuredClone({
    engine: manifest.spec.engine,
    binary: manifest.spec.binary,
    endpoint: manifest.spec.endpoint,
    hostedModels: manifest.spec.hostedModels,
    extraArgs: manifest.spec.extraArgs,
    modelsDir: resolved.LLAMA_CPP_MODELS,
    runtimeDir: resolved.LOCAL_AI_RUNTIME_DIR,
  });
  return {
    manifest,
    env,
    effectiveSpecDigest: createHash("sha256").update(canonical).digest("hex"),
    effectiveLaunch,
  };
}

/** Resolve the same local inputs the supported engines use at spawn. */
export function modelHostCalibrationLaunch(pinned: PinnedModelHostStartup):
  | {
      engine: "llamacpp" | "kapitsa";
      binary: string;
      args: readonly string[];
      env: NodeJS.ProcessEnv;
    }
  | undefined {
  const { manifest, env } = pinned;
  const engine = manifest.spec.engine;
  if (engine !== "llamacpp" && engine !== "kapitsa") return undefined;
  const spec = buildModelHostSpec(manifest);
  if (!ENGINES[engine].validateSpec(spec).ok || !isAbsolute(spec.binary)) return undefined;
  const resolved = resolveEnv(env);
  spec.extraArgs = resolveSlotSavePathArgs(
    manifest.spec.extraArgs,
    resolved.LOCAL_AI_RUNTIME_DIR,
    manifest.metadata.name,
  ).args;
  const boot = modelHostBootEnv(env, resolved, spec, manifest.metadata.name);
  const launch = ENGINES[engine].buildBootCommand(spec, boot);
  return {
    engine,
    binary: launch.binary,
    args: launch.args,
    env: sanitizeChildEnv(env, launch.envOverrides, manifest.spec.env),
  };
}

export async function startModelHost(opts: StartModelHostOptions): Promise<StartModelHostResult> {
  const env = toRuntimeEnv(opts.env);
  const runtimeEnv = withRuntimeDir(env, opts.runtimeDir);
  const resolved = resolveEnv(runtimeEnv);
  if (managedRuntimeRefusesMutation(resolved.LOCAL_AI_RUNTIME_DIR)) {
    const result = { ok: false, pid: null, error: "ManagedOwnerRequired" };
    opts.onEvent?.({ type: "done", result });
    return result;
  }
  const manifest = opts.manifest
    ? ModelHostManifestSchema.parse(opts.manifest)
    : loadModelHostByName(opts.key.name, opts.workloadsDir);
  if (manifest.metadata.name !== opts.key.name) {
    const result = {
      ok: false,
      pid: null,
      error: `modelHostStart workload mismatch: expected ${opts.key.name}, got ${manifest.metadata.name}`,
    };
    opts.onEvent?.({ type: "done", result });
    return result;
  }
  const engine = ENGINES[manifest.spec.engine];
  const spec = buildModelHostSpec(manifest);
  const validation = engine.validateSpec(spec);
  if (!validation.ok) {
    const result = { ok: false, pid: null, error: validation.error };
    opts.onEvent?.({ type: "done", result });
    return result;
  }

  // Refuse an exposed bind BEFORE any teardown: reapOrAdoptPriorHost would
  // otherwise kill a live host to make room for a spawn we then deny.
  const bindRefusal = modelHostBindRefusal(manifest);
  const nativeRefusal = nativeOmlxOwnerRefusal(manifest, opts);
  if (nativeRefusal !== undefined || bindRefusal !== null) {
    const result = nativeRefusal ?? {
      ok: false,
      pid: null,
      error: bindRefusal ?? "ModelHostBindRefused",
    };
    opts.onEvent?.({ type: "done", result });
    return result;
  }

  // #214: resolve apiKeyRef after the bind gate — a refused start never
  // touches the secret store — and before residency/persist/launch, so an
  // unresolvable ref fails before any reap, save or spawn. The value
  // reaches the child only as LLAMA_API_KEY; it never appears in an
  // error, event or log (resolveSecret's failure messages are
  // redaction-safe).
  const apiKeyResolution = resolveModelHostApiKey(manifest.spec.apiKeyRef, runtimeEnv);
  if (!apiKeyResolution.ok) {
    const result = {
      ok: false,
      pid: null,
      error: `ModelHost ${opts.key.name}: unable to resolve spec.apiKeyRef (${apiKeyResolution.refLabel}): ${apiKeyResolution.reason}`,
    };
    opts.onEvent?.({ type: "done", result });
    return result;
  }
  const apiKey = apiKeyResolution.apiKey;

  // Same residency-group exclusion as the bind gate: refuse BEFORE the
  // manifest is saved and before reapOrAdoptPriorHost/spawn/teardown, so a
  // denied start cannot kill a live peer or persist desired state.
  const residency = residencyGroupConflict(manifest, opts, resolved);
  if (residency !== null) {
    const result = {
      ok: false,
      pid: null,
      error: `residency-group ${residency.group} already has ${residency.state} ModelHost ${residency.host} on this node; stop it before starting ${manifest.metadata.name}`,
      residencyConflict: residency,
    };
    opts.onEvent?.({ type: "done", result });
    return result;
  }

  if (opts.commitReadiness !== undefined && residencyPeerState(opts.key, opts, resolved) !== null) {
    const result = { ok: false, pid: null, error: "ManagedRestartUnavailable" };
    opts.onEvent?.({ type: "done", result });
    return result;
  }

  // Persist the accepted inline manifest only once validation and the bind
  // gate have passed: a refused start must not replace the previously saved
  // desired state with a manifest the controller will always refuse.
  if (opts.manifest !== undefined && opts.commitReadiness === undefined) {
    saveModelHost(mergeDiskManagedByLabel(manifest, opts.workloadsDir), opts.workloadsDir);
  }

  const startKey = `${resolved.LOCAL_AI_RUNTIME_DIR}\0${opts.key.name}`;
  const specHash = computeModelHostSpecHash(specForHash(manifest.spec));
  const inFlight = inFlightModelHostStarts.get(startKey);
  if (inFlight) {
    const joined = await joinInFlightModelHostStart(inFlight, specHash, opts.key.name, opts.signal);
    opts.onEvent?.({ type: "done", result: joined });
    return joined;
  }
  // Register synchronously, before the first await inside launchModelHost can
  // yield, so a start entering on the next tick always finds this one.
  const promise = launchModelHost(manifest, opts, {
    env,
    runtimeEnv,
    resolved,
    engine,
    spec,
    ...omitUndefined({ apiKey }),
  });
  inFlightModelHostStarts.set(startKey, { specHash, promise });
  try {
    return await promise;
  } finally {
    // Only the start that registered the entry reaches this line, and no other
    // start can register while it is present, so the delete is unconditional.
    inFlightModelHostStarts.delete(startKey);
  }
}

async function teardownStoppedHost(
  opts: StopModelHostOptions,
  recordPath: string,
  host: { pid: number; engine: EngineName },
  identity: PidIdentityDeps,
): Promise<string | undefined> {
  const teardown =
    opts.teardown ??
    ((pid: number): Promise<void> =>
      ENGINES[host.engine].teardown(
        pid,
        teardownIdentity(recordPath, opts.identity, identity.expectCommand),
      ));
  try {
    await teardown(host.pid, opts.graceSeconds);
  } catch {
    // A resolved or thrown teardown is not proof of release.
  }
  const verdict = verifyPidFile(recordPath, host.pid, identity);
  if (isRecordedPidGone(verdict)) return undefined;
  return verdict === "alive"
    ? "process still alive after teardown"
    : "pid identity unknown after teardown";
}

function modelHostStopIdentityError(identity: PidIdentityDeps): string {
  return identity.verifyGeneration === undefined
    ? "pid identity unknown"
    : "ManagedStopGenerationUnverified";
}

// #317: an engine orphaned by an agent restart during start-up has no state
// sidecar — the starting record written at spawn is the only track of it.
// Same identity contract as the sidecar path: alive means ours (teardown +
// remove the record), unknown means fail-closed (never signalled, record kept
// for a retry), gone means nothing to signal (remove the stale record).
async function stopStartingRecord(
  opts: StopModelHostOptions,
  resolved: ReturnType<typeof resolveEnv>,
): Promise<StopModelHostResult> {
  const starting = readModelHostStarting(opts.key, resolved);
  const managed = opts.identity?.verifyGeneration !== undefined;
  if (!starting) {
    return managed
      ? { ok: false, pid: null, error: "ManagedStopGenerationUnverified" }
      : { ok: true, pid: null };
  }
  const recordPath = modelhostStartingFile(resolved, opts.key);
  // #806 phase 3: tombstone the scope unit before verifying, so an in-flight
  // scoped launch that sees its wrapper exit cannot fall back to a direct
  // spawn behind this stop's back. A managed stop first verifies its claim.
  const tombstone = (): void => {
    if (starting.scopeUnit !== undefined) {
      writeScopeStop(workloadRuntimeDir(resolved, opts.key), "modelhost", starting.scopeUnit);
    }
  };
  if (!managed) tombstone();
  const identity = startingIdentityDeps(starting, opts.identity, starting.binaryNames);
  const verdict = verifyPidFile(recordPath, starting.pid, identity);
  if (verdict === "unknown") {
    return {
      ok: false,
      pid: starting.pid,
      error: modelHostStopIdentityError(identity),
    };
  }
  if (verdict === "alive") {
    if (managed) tombstone();
    const error = await teardownStoppedHost(opts, recordPath, starting, identity);
    if (error !== undefined) return { ok: false, pid: starting.pid, error };
  }
  clearStartingRecordIfOwned(opts.key, resolved, starting.pid);
  return { ok: true, pid: starting.pid };
}

export async function stopModelHost(opts: StopModelHostOptions): Promise<StopModelHostResult> {
  const resolved = resolveEnv(withRuntimeDir(toRuntimeEnv(opts.env), opts.runtimeDir));
  if (managedRuntimeRefusesMutation(resolved.LOCAL_AI_RUNTIME_DIR)) {
    return { ok: false, pid: null, error: "ManagedOwnerRequired" };
  }
  const state = readModelHostState(opts.key, resolved);
  if (!state) return await stopStartingRecord(opts, resolved);
  // Teardown signals the whole process group — the worst place to act on a
  // recycled pid — so the recorded pid is verified against its pid file
  // (the identity anchor, written before the sidecar) and corroborated by
  // the engine's argv0 first.
  const recordPath = modelhostPidFile(resolved, opts.key);
  const identity = hostIdentityDeps(state.engine, opts.identity, state.binaryNames);
  const verdict = verifyPidFile(recordPath, state.pid, identity);
  if (verdict === "unknown") {
    return {
      ok: false,
      pid: state.pid,
      error: modelHostStopIdentityError(identity),
    };
  }
  if (verdict === "alive") {
    const error = await teardownStoppedHost(opts, recordPath, state, identity);
    if (error !== undefined) return { ok: false, pid: state.pid, error };
  }
  removeModelHostState(opts.key, resolved);
  return { ok: true, pid: state.pid };
}

function matchesModelHostProbeOrigin(
  state: ModelHostState,
  probeOrigin: string | undefined,
): boolean {
  if (probeOrigin === undefined) return false;
  try {
    const origin = new URL(`http://${formatHostForUrl(state.host)}:${String(state.port)}`).origin;
    return probeOrigin === origin;
  } catch {
    return false;
  }
}

function modelHostSleepResidency(
  opts: StatusModelHostOptions,
  state: ModelHostState,
): SleepResidency | undefined {
  if (state.engine !== "llamacpp") return undefined;
  if (opts.sleepController !== undefined) {
    return readLlamacppSleepResidency(opts.sleepController, opts.key.name);
  }
  const recorded = readLlamacppSleepResidency(getNodeLlamacppSleepController(), opts.key.name);
  return recorded !== undefined && matchesLlamacppSleepGeneration(opts.key.name, state)
    ? recorded
    : undefined;
}

export function statusModelHost(opts: StatusModelHostOptions): StatusModelHostResult {
  const resolved = resolveEnv(withRuntimeDir(toRuntimeEnv(opts.env), opts.runtimeDir));
  const runtimeStatus = readModelHostRuntimeStatus(opts.key, resolved);
  const runtime = runtimeStatus ? { runtime: runtimeStatus } : {};
  const state = readModelHostState(opts.key, resolved);
  if (!state) return { state: "Stopped", ...runtime };
  // A sidecar whose recorded pid is no longer provably ours means the host
  // died or was replaced out-of-band. Report Stopped so the reconciler
  // re-acts on it — but keep the verdict visible: "unknown" is not proof the
  // pid is gone, and deletion paths must not act on it.
  // #317: corroborate the engine argv0 exactly as stopModelHost does, so
  // status never reports Running for a pid that stop would refuse.
  const verdict = verifyPidFile(
    modelhostPidFile(resolved, opts.key),
    state.pid,
    hostIdentityDeps(state.engine, opts.identity, state.binaryNames),
  );
  if (verdict !== "alive") {
    return {
      state: "Stopped",
      ...omitUndefined({ identityUnknown: verdict === "unknown" ? true : undefined }),
      ...runtime,
    };
  }
  const sleep = modelHostSleepResidency(opts, state);
  return {
    state: "Running",
    pid: state.pid,
    ...omitUndefined({
      specHash: state.specHash,
      sleep,
      probeSleep:
        sleep !== undefined &&
        opts.sleepController === undefined &&
        matchesModelHostProbeOrigin(state, opts.probeOrigin)
          ? sleep
          : undefined,
    }),
    ...runtime,
  };
}

function omlxParkedProbeIdentity(
  opts: StatusModelHostOptions,
  pid: StatusModelHostResult["pid"],
): OmlxParkedProbeIdentity | undefined {
  const resolved = resolveEnv(withRuntimeDir(toRuntimeEnv(opts.env), opts.runtimeDir));
  const state = readModelHostState(opts.key, resolved);
  if (
    state?.engine !== "omlx" ||
    state.pid !== pid ||
    !state.specHash ||
    !Number.isFinite(Date.parse(state.startedAt)) ||
    !matchesModelHostProbeOrigin(state, opts.probeOrigin)
  ) {
    return undefined;
  }
  return Object.freeze({
    workload: opts.key.name,
    pid: state.pid,
    startedAt: state.startedAt,
    specHash: state.specHash,
    endpoint: Object.freeze({ host: state.host, port: state.port }),
  });
}

export async function statusModelHostForProbe(
  opts: StatusModelHostOptions,
  verifyParkedOmlx?: VerifyParkedOmlxProbe,
): Promise<StatusModelHostResult> {
  const status = statusModelHost(opts);
  if (verifyParkedOmlx === undefined || status.state !== "Running") return status;
  const pinned = omlxParkedProbeIdentity(opts, status.pid);
  if (pinned === undefined) return status;
  try {
    const signal = AbortSignal.timeout(500);
    if (!(await verifyParkedOmlx(pinned, signal)) || signal.aborted) return status;
    const current = statusModelHost(opts);
    return current.state === "Running" &&
      isDeepStrictEqual(pinned, omlxParkedProbeIdentity(opts, current.pid))
      ? { ...current, probeParked: true }
      : current;
  } catch {
    return status;
  }
}
