import { join } from "node:path";

import type { ResolvedEnv } from "./types.js";
import type { WorkloadKey } from "./workloadRuntime.js";

import { formatBenchTimestamp } from "./bench/runner.js";
import { resolveEnv } from "./env.js";
import {
  type CommandExpectation,
  isProcessAlive,
  isRecordedPidGone,
  type PidIdentityDeps,
  type PidVerdict,
  signalRecordedPid,
  verifyPidFile,
} from "./pidIdentity.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "./safe-fs.js";
import { endpoint, readServerPid, startServer, stopServer } from "./server.js";
import { resolveTarget } from "./target.js";

export function keepAlivePidFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, "llama-keep-alive.pid");
}

export function keepAliveStopFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, "llama-keep-alive.stop");
}

export function keepAliveStateFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, "llama-keep-alive.state");
}

export function keepAliveLogFile(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LLAMA_CPP_LOGS, "keep-alive.log");
}

export type KeepAliveState =
  | "launching"
  | "resolve-failed"
  | "starting"
  | "ready"
  | "restart-pending"
  | "start-failed"
  | "stopped";

interface StateSnapshot {
  updated_at: string;
  target: string;
  model: string;
  state: KeepAliveState;
  restarts: number;
  backoff_seconds: number;
  log: string;
}

function writeState(
  resolved: ResolvedEnv,
  snapshot: Omit<StateSnapshot, "updated_at" | "log">,
): void {
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });
  const body =
    [
      `updated_at=${formatBenchTimestamp()}`,
      `target=${snapshot.target}`,
      `model=${snapshot.model}`,
      `state=${snapshot.state}`,
      `restarts=${String(snapshot.restarts)}`,
      `backoff_seconds=${String(snapshot.backoff_seconds)}`,
      `log=${keepAliveLogFile(resolved)}`,
    ].join("\n") + "\n";
  writeFileSync(keepAliveStateFile(resolved), body);
}

function parseState(raw: string): Partial<StateSnapshot> {
  const out: Partial<StateSnapshot> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case "updated_at":
        out.updated_at = value;
        break;
      case "target":
        out.target = value;
        break;
      case "model":
        out.model = value;
        break;
      case "state":
        out.state = value as KeepAliveState;
        break;
      case "restarts":
        out.restarts = Number.parseInt(value, 10) || 0;
        break;
      case "backoff_seconds":
        out.backoff_seconds = Number.parseInt(value, 10) || 0;
        break;
      case "log":
        out.log = value;
        break;
    }
  }
  return out;
}

export function readKeepAliveState(
  resolved: ResolvedEnv = resolveEnv(),
): Partial<StateSnapshot> | null {
  const file = keepAliveStateFile(resolved);
  if (!existsSync(file)) return null;
  try {
    return parseState(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readKeepAlivePidRaw(resolved: ResolvedEnv): number | null {
  const file = keepAlivePidFile(resolved);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// The supervisor's argv is `<bin> <entry> keep-alive worker <target>` —
// argv0 varies (bun vs the packaged binary), so identity is pinned to the
// argv tokens only the supervisor carries.
const KEEPALIVE_EXPECTATION: CommandExpectation = {
  args: ["keep-alive", "worker"],
};

/**
 * The recorded keep-alive pid plus its identity verdict against the pid file
 * it was read from. `verdict` is null only when there is no recorded pid.
 */
function keepAlivePidVerdict(
  resolved: ResolvedEnv,
  deps?: PidIdentityDeps,
): {
  pid: number | null;
  verdict: PidVerdict | null;
} {
  const pid = readKeepAlivePidRaw(resolved);
  return {
    pid,
    verdict:
      pid === null
        ? null
        : verifyPidFile(keepAlivePidFile(resolved), pid, {
            ...deps,
            expectCommand: KEEPALIVE_EXPECTATION,
          }),
  };
}

/**
 * Read the keep-alive record without collapsing identity: callers that gate
 * on more than "is it alive" (start/stop, duplicate detection) need the
 * verdict — "unknown" must not be treated as absent.
 */
export function readKeepAliveRecord(
  resolved: ResolvedEnv = resolveEnv(),
  deps?: PidIdentityDeps,
): { pid: number | null; verdict: PidVerdict | null } {
  return keepAlivePidVerdict(resolved, deps);
}

export function readKeepAlivePid(resolved: ResolvedEnv = resolveEnv()): number | null {
  const { pid, verdict } = keepAlivePidVerdict(resolved);
  return verdict === "alive" ? pid : null;
}

export interface KeepAliveStatus {
  running: boolean;
  pid: number | null;
  /** Identity verdict for the recorded pid — null when no pid is recorded. */
  verdict: PidVerdict | null;
  state: Partial<StateSnapshot> | null;
}

export function keepAliveStatus(resolved: ResolvedEnv = resolveEnv()): KeepAliveStatus {
  const { pid, verdict } = keepAlivePidVerdict(resolved);
  const state = readKeepAliveState(resolved);
  // The pid file is only reaped when the record is provably gone — an
  // unverifiable ("unknown") record is kept because it may still be ours.
  const fileGone = pid === null || (verdict !== null && isRecordedPidGone(verdict));
  if (fileGone && existsSync(keepAlivePidFile(resolved))) {
    try {
      unlinkSync(keepAlivePidFile(resolved));
    } catch {
      // no-op
    }
  }
  const live = verdict === "alive" ? pid : null;
  return { running: live !== null, pid: live, verdict, state };
}

export interface StopKeepAliveOptions {
  key: WorkloadKey;
  resolved?: ResolvedEnv;
  /**
   * Maximum seconds to wait for the supervisor after writing its stop file (default 10; values
   * below 1 are raised to 1; polled in 1 s steps). The supervisor never receives SIGKILL, though
   * the safety-net llama-server stop may issue it after its own "alive" identity re-verification.
   */
  graceSeconds?: number;
  /** Identity resolver seams for tests; production uses the defaults. */
  identity?: PidIdentityDeps;
}

/**
 * Result returned unchanged by `keepAliveStop`. A `stopped: false` result follows an initial or
 * post-grace "unknown" identity verdict and keeps tracking files. A third check may be "unknown"
 * after the post-grace check; that path still clears tracking files after running the safety net.
 */
export interface StopKeepAliveResult {
  /**
   * Whether no live record was found or the supervisor stop path ran; `stopped: false` retains
   * tracking files after an initial or post-grace "unknown" verdict and does not prove a worker
   * stopped when true.
   */
  stopped: boolean;
  /** PID from a live recorded supervisor, or null when no live record was found. */
  pid: number | null;
  /**
   * Whether SIGTERM was sent to the supervisor after its third identity check; it is not awaited
   * and says nothing about the llama-server.
   */
  killed: boolean;
}

/**
 * Stop a tracked supervisor and return a `StopKeepAliveResult`. No readable record, or a "dead"
 * or "reused" record, clears the PID and stop files without signalling. An initial "unknown"
 * verdict returns `stopped: false` with tracking files retained. For an "alive" record, this writes
 * the stop file, waits for the grace period, and returns `stopped: false` with tracking files kept
 * if the post-grace identity verdict is "unknown". Otherwise it attempts SIGTERM only after a
 * third "alive" check, runs `stopServer` as a safety net without using its result, and clears the
 * supervisor tracking files; a successful result does not establish that either process exited.
 */
export async function stopKeepAlive(opts: StopKeepAliveOptions): Promise<StopKeepAliveResult> {
  const resolved = opts.resolved ?? resolveEnv();
  const key = opts.key;
  const grace = Math.max(1, opts.graceSeconds ?? 10);
  const recordPath = keepAlivePidFile(resolved);
  const identity: PidIdentityDeps = {
    ...opts.identity,
    expectCommand: KEEPALIVE_EXPECTATION,
  };
  const { pid, verdict } = keepAlivePidVerdict(resolved, opts.identity);
  if (pid === null || verdict === null || isRecordedPidGone(verdict)) {
    try {
      unlinkSync(keepAlivePidFile(resolved));
    } catch {
      // no-op
    }
    try {
      unlinkSync(keepAliveStopFile(resolved));
    } catch {
      // no-op
    }
    return { stopped: true, pid: null, killed: false };
  }
  // Only positive identity authorizes the stop file and signal paths; unknown
  // and future verdicts keep the tracking files for a later attempt.
  if (verdict !== "alive") return { stopped: false, pid, killed: false };

  // Touch the stop file so the worker observes it at a subsequent loop check.
  mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, { recursive: true });
  writeFileSync(keepAliveStopFile(resolved), "");

  let waited = 0;
  while (waited < grace && isProcessAlive(pid)) {
    await new Promise((r) => setTimeout(r, 1000));
    waited += 1;
  }
  const lastVerdict = verifyPidFile(recordPath, pid, identity);
  if (lastVerdict === "unknown") return { stopped: false, pid, killed: false };
  const killed = signalRecordedPid(recordPath, pid, "SIGTERM", identity);
  await stopServer({ key, resolved });
  try {
    unlinkSync(keepAlivePidFile(resolved));
  } catch {
    // no-op
  }
  try {
    unlinkSync(keepAliveStopFile(resolved));
  } catch {
    // no-op
  }
  return { stopped: true, pid, killed };
}

export interface RunKeepAliveWorkerOptions {
  key: WorkloadKey;
  target: string;
  resolved?: ResolvedEnv;
  env?: NodeJS.ProcessEnv;
  /** Poll interval in seconds. Defaults to LLAMA_CPP_KEEP_ALIVE_INTERVAL or 5. */
  intervalSeconds?: number;
  /** Exponential backoff ceiling (seconds). */
  maxBackoff?: number;
  /** Cooperative abort handle — tests can trip this to break the loop. */
  signal?: AbortSignal;
}

function logLine(resolved: ResolvedEnv, line: string): void {
  mkdirSync(resolved.LLAMA_CPP_LOGS, { recursive: true });
  appendFileSync(keepAliveLogFile(resolved), `[${formatBenchTimestamp()}] ${line}\n`);
}

/**
 * Supervisor loop. Runs until the stop file appears, the abort signal
 * fires, or the process is killed. Mirrors the shell
 * `_llama_keep_alive_worker`:
 *
 *   - Resolve target → rel. On failure, record state + exp-backoff.
 *   - Ensure llama-server is up (start if not). On failure, backoff.
 *   - Poll /health every interval seconds. If it drops, restart with
 *     exponential backoff capped by `maxBackoff`.
 *
 * Writes the current state snapshot after every meaningful transition
 * so `keep-alive status` can show "ready / restart-pending / …"
 * without running commands itself.
 */
/**
 * Sleep for `s` seconds, resolving early if `signal` aborts.
 *
 * Exported as a test seam: callers loop over a long-lived signal, so the
 * abort listener must detach on EVERY resolve path (timer or abort), not
 * just the abort path — otherwise the signal's listener list grows without
 * bound (MaxListenersExceededWarning + memory growth).
 */
export function sleepWithAbort(s: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, s * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function shouldStop(resolved: ResolvedEnv, signal?: AbortSignal): boolean {
  return signal?.aborted === true || existsSync(keepAliveStopFile(resolved));
}

async function pollHealthUntilDown(
  resolved: ResolvedEnv,
  key: WorkloadKey,
  intervalSeconds: number,
  signal: AbortSignal | undefined,
  rel: string,
): Promise<void> {
  while (!shouldStop(resolved, signal)) {
    await sleepWithAbort(intervalSeconds, signal);
    if (shouldStop(resolved, signal)) break;
    let ok = false;
    try {
      const res = await fetch(`${endpoint(resolved)}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      ok = res.status === 200;
    } catch {
      ok = false;
    }
    const pid = readServerPid(key, resolved);
    if (!ok || pid === null) {
      logLine(resolved, `health lost for rel=${rel}, will restart`);
      break;
    }
  }
}

async function cleanupWorker(
  resolved: ResolvedEnv,
  key: WorkloadKey,
  target: string,
  restarts: number,
  backoff: number,
  rel: string,
): Promise<void> {
  logLine(resolved, `supervisor exiting state=stopped`);
  writeState(resolved, {
    target,
    model: rel || "unknown",
    state: "stopped",
    restarts,
    backoff_seconds: backoff,
  });
  await stopServer({ key, resolved });
  try {
    unlinkSync(keepAlivePidFile(resolved));
  } catch {
    // no-op
  }
  try {
    unlinkSync(keepAliveStopFile(resolved));
  } catch {
    // no-op
  }
}

export async function runKeepAliveWorker(opts: RunKeepAliveWorkerOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const resolved = opts.resolved ?? resolveEnv(env);
  const key = opts.key;
  const intervalSeconds =
    opts.intervalSeconds ??
    Math.max(1, Number.parseInt(env["LLAMA_CPP_KEEP_ALIVE_INTERVAL"] ?? "", 10) || 5);
  const maxBackoff =
    opts.maxBackoff ??
    Math.max(
      intervalSeconds,
      Number.parseInt(env["LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF"] ?? "", 10) || 30,
    );

  try {
    unlinkSync(keepAliveStopFile(resolved));
  } catch {
    // no-op
  }
  writeFileSync(keepAlivePidFile(resolved), `${String(process.pid)}\n`);
  writeState(resolved, {
    target: opts.target,
    model: "pending",
    state: "launching",
    restarts: 0,
    backoff_seconds: 1,
  });

  let restarts = 0;
  let backoff = 1;
  let lastRel = "";
  try {
    while (!shouldStop(resolved, opts.signal)) {
      const rel = resolveTarget(opts.target, env);
      if (!rel) {
        logLine(resolved, `target=${opts.target} resolve-failed`);
        writeState(resolved, {
          target: opts.target,
          model: "unresolved",
          state: "resolve-failed",
          restarts,
          backoff_seconds: backoff,
        });
        await sleepWithAbort(backoff, opts.signal);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      lastRel = rel;

      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: "starting",
        restarts,
        backoff_seconds: backoff,
      });
      logLine(resolved, `starting server for rel=${rel}`);

      const startRes = await startServer({
        key,
        target: rel,
        timeoutSeconds: 60,
        resolved,
        env,
      });
      if (!startRes.ok) {
        restarts += 1;
        logLine(resolved, `start-failed rel=${rel} error=${startRes.error ?? "unknown"}`);
        writeState(resolved, {
          target: opts.target,
          model: rel,
          state: "start-failed",
          restarts,
          backoff_seconds: backoff,
        });
        await sleepWithAbort(backoff, opts.signal);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }

      backoff = 1;
      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: "ready",
        restarts,
        backoff_seconds: backoff,
      });
      logLine(resolved, `ready rel=${rel} pid=${String(startRes.pid)}`);

      await pollHealthUntilDown(resolved, key, intervalSeconds, opts.signal, rel);
      if (shouldStop(resolved, opts.signal)) break;

      restarts += 1;
      writeState(resolved, {
        target: opts.target,
        model: rel,
        state: "restart-pending",
        restarts,
        backoff_seconds: backoff,
      });
      await sleepWithAbort(backoff, opts.signal);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  } finally {
    await cleanupWorker(resolved, key, opts.target, restarts, backoff, lastRel);
  }
}
