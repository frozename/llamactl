// Transient systemd user scopes for engine launches (#806 phase 3).
//
// On Linux an agent-launched engine runs inside its own transient systemd user
// scope (`systemd-run --user --scope`), so the engine's whole process tree is
// owned by a unit the agent can tear down deterministically — surviving the
// agent's own death and never being adopted as an anonymous orphan. This module
// holds the pure helpers that decide *whether* to scope a launch (the launcher
// seam and its capability resolve), *how* to ask systemd-run (argv + env
// shaping), and *what happened* between spawn and exec (the exec-marker
// handshake and the outcome classification that turns a pre-exec systemd-run
// failure into a safe direct-spawn fallback). Nothing here spawns the engine
// itself; the callers in modelhost.ts and server.ts do.

import type { ChildProcess } from "node:child_process";

import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type { CommandExpectation } from "../pidIdentity.js";

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "../safe-fs.js";

export const ENGINE_SCOPE_SLICE = "llamactl-engines.slice";

// Bus locators must reach systemd-run from the agent's own environment, not the
// child env, so the scope lands on the right user manager.
export const SCOPE_BUS_ENV = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

// Documented log-routing keys a manifest must not override; the strip rule below
// is broader (every SYSTEMD_* plus JOURNAL_STREAM) so a stray journald setting
// cannot make the marker line land in the journal instead of the boot log.
export const SCOPE_LOG_ENV = ["SYSTEMD_LOG_LEVEL", "SYSTEMD_LOG_TARGET", "JOURNAL_STREAM"] as const;

export const SCOPE_ESTABLISH_TIMEOUT_MS = 30_000;
export const SCOPE_POLL_MS = 25;
export const SCOPE_KILL_WAIT_MS = 5_000;
export const SCOPE_MARKER_SCAN_BYTES = 65_536;
export const SCOPE_NEGATIVE_TTL_MS = 600_000;

const SYSTEMD_RUN_PATHS = ["/usr/bin/systemd-run", "/bin/systemd-run"] as const;
const TRUE_PATHS = ["/usr/bin/true", "/bin/true"] as const;

// A transient scope unit is `llamactl-engine-<workload>-<12 hex>.scope`: the
// 48-bit nonce makes every launch's unit unique, which is what lets the exec
// marker (which names the unit) be unambiguous and what stops a restart from
// colliding with the still-collecting `--collect` fragment of the last unit.
const SCOPE_UNIT_RE = /^llamactl-engine-[a-z0-9_-]{1,63}-[0-9a-f]{12}\.scope$/;

export function scopeUnitBase(workload: string, suffix: string): string {
  const clean =
    workload
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "_")
      .slice(0, 63) || "_";
  return `llamactl-engine-${clean}-${suffix}`;
}

export function isScopeUnit(value: unknown): value is string {
  return typeof value === "string" && SCOPE_UNIT_RE.test(value);
}

/** The exact `--`-separated argv handed to systemd-run for one scope launch. */
export function buildScopeArgv(
  base: string,
  workload: string,
  binary: string,
  args: readonly string[],
): string[] {
  return [
    "--user",
    "--scope",
    `--unit=${base}`,
    `--description=llamactl engine ${workload}`,
    "--collect",
    `--slice=${ENGINE_SCOPE_SLICE}`,
    "--expand-environment=no",
    "--",
    binary,
    ...args,
  ];
}

/** The line systemd-run prints (to its stderr) once the child has exec'd. */
export function scopeMarker(base: string): string {
  return `Running scope as unit: ${base}.scope`;
}

function readMarkerRegion(logPath: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.allocUnsafe(SCOPE_MARKER_SCAN_BYTES);
    const read = readSync(fd, buf, 0, SCOPE_MARKER_SCAN_BYTES, offset);
    return read <= 0 ? "" : buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The fd is process-local; a close failure cannot corrupt the log.
    }
  }
}

// Match a line that ENDS with the marker so systemd's optional time/location/tid
// prefixes before the message do not defeat detection; the nonce in the unit
// keeps an ends-with match from ever matching an unrelated line.
export function scopeMarkerSeen(logPath: string, offset: number, base: string): boolean {
  const region = readMarkerRegion(logPath, offset);
  if (region === "") return false;
  const suffix = scopeMarker(base);
  for (const line of region.split("\n")) {
    if (line.endsWith(suffix)) return true;
  }
  return false;
}

function isScopeBusKey(key: string): boolean {
  return (SCOPE_BUS_ENV as readonly string[]).includes(key);
}

function isScopeLogKey(key: string): boolean {
  return key.startsWith("SYSTEMD_") || (SCOPE_LOG_ENV as readonly string[]).includes(key);
}

export type ScopedEnv = { conflict: string } | { env: NodeJS.ProcessEnv };

/**
 * Build the env systemd-run (and therefore the engine) runs with: the child env
 * minus every log-routing key, plus the bus locators taken from the agent's own
 * environment. A manifest that declares a bus or log key is rejected outright —
 * it would let a manifest retarget the scope onto a different user manager or
 * reroute the marker into the journal, so the caller falls back to a direct
 * spawn instead of honouring the override.
 */
export function shapeScopeEnv(
  childEnv: NodeJS.ProcessEnv,
  agentEnv: NodeJS.ProcessEnv,
  declaredKeys: readonly string[],
): ScopedEnv {
  for (const key of declaredKeys) {
    if (isScopeBusKey(key) || isScopeLogKey(key)) return { conflict: key };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(childEnv)) {
    if (value !== undefined && !isScopeLogKey(key)) env[key] = value;
  }
  for (const key of SCOPE_BUS_ENV) {
    const value = agentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return { env };
}

export type ScopeOutcome =
  | { kind: "established" }
  | { kind: "engine-exited"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "pre-exec-failed"; code: number | null }
  | { kind: "signalled-pre-exec"; signal: NodeJS.Signals }
  | { kind: "hung-killed" }
  | { kind: "engine-killed" }
  | { kind: "hung-unreaped" }
  | { kind: "aborted" };

/**
 * Classify a systemd-run wrapper exit into an outcome. A marker already seen
 * means systemd-run exec'd the engine, so any later exit is the *engine*
 * exiting (never a pre-exec boot that a direct relaunch would double-boot);
 * only a marker-less nonzero exit or a pre-exec signal is a fallback-eligible
 * failure, and a marker-less clean exit is treated as an engine exit.
 */
export function classifyScopeExit(
  markerSeen: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): ScopeOutcome {
  if (markerSeen) return { kind: "engine-exited", code, signal };
  if (signal !== null) return { kind: "signalled-pre-exec", signal };
  if (code === 0) return { kind: "engine-exited", code, signal };
  return { kind: "pre-exec-failed", code };
}

/** Outcomes safe to retry with a direct spawn (systemd-run never started the engine). */
export function isScopeFallback(outcome: ScopeOutcome): boolean {
  return outcome.kind === "pre-exec-failed" || outcome.kind === "hung-killed";
}

export function describeScopeOutcome(outcome: ScopeOutcome, scopeUnit?: string): string {
  const where = scopeUnit === undefined ? "" : ` in scope ${scopeUnit}`;
  switch (outcome.kind) {
    case "established":
      return `engine established${where}`;
    case "engine-exited":
      return `engine exited${where} (code ${String(outcome.code)}, signal ${String(outcome.signal)})`;
    case "pre-exec-failed":
      return `systemd-run failed before exec${where} (code ${String(outcome.code)})`;
    case "signalled-pre-exec":
      return `systemd-run signalled before exec${where} (${outcome.signal})`;
    case "hung-killed":
      return `scope hung before exec${where} and was killed`;
    case "engine-killed":
      return `engine was killed after exec${where}`;
    case "hung-unreaped":
      return `scope did not exit after SIGKILL${where}`;
    case "aborted":
      return `scope launch aborted${where}`;
  }
}

export interface AwaitScopeExecArgs {
  child: ChildProcess;
  pid: number;
  logPath: string;
  offset: number;
  base: string;
  timeoutMs: number;
  pollMs?: number;
  killWaitMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// SIGKILL the whole group (the wrapper leads its own, being detached), then
// wait at most killWaitMs for the reap. `cause` decides the resulting outcome:
// an abort is always "aborted"; a timeout with no marker is fallback-eligible.
async function terminateScopeGroup(
  child: ChildProcess,
  pid: number,
  killWaitMs: number,
  cause: "timeout" | "aborted",
  logPath: string,
  offset: number,
  base: string,
): Promise<ScopeOutcome> {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone between the liveness read and the kill.
    }
  }
  const reaped = await waitForGroupExit(child, killWaitMs);
  if (cause === "aborted") return { kind: "aborted" };
  if (!reaped) return { kind: "hung-unreaped" };
  return scopeMarkerSeen(logPath, offset, base)
    ? { kind: "engine-killed" }
    : { kind: "hung-killed" };
}

async function waitForGroupExit(child: ChildProcess, killWaitMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, killWaitMs);
    function onExit(): void {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

/**
 * Watch a freshly spawned systemd-run wrapper until it either exec'd the engine
 * (the marker appears in the boot log while the wrapper is still alive) or it
 * exited/failed before exec. The post-exit marker re-read and the fallback-gate
 * inputs are computed synchronously in the same turn as the exit event, so a
 * marker written just before the exit is never missed by a coalesced poll.
 */
export async function awaitScopeExec(args: AwaitScopeExecArgs): Promise<ScopeOutcome> {
  const { child, pid, logPath, offset, base, timeoutMs } = args;
  const pollMs = args.pollMs ?? SCOPE_POLL_MS;
  const killWaitMs = args.killWaitMs ?? SCOPE_KILL_WAIT_MS;
  const signal = args.signal;

  // A mutable box (not a captured `let`) so control-flow analysis keeps the
  // ExitInfo type at the read sites rather than narrowing it to the `null`
  // initializer across the exit/abort closures below.
  const exit: { info: ExitInfo | null } = { info: null };
  let wake: (() => void) | null = null;
  const noteExit = (code: number | null, sig: NodeJS.Signals | null): void => {
    exit.info = { code, signal: sig };
    wake?.();
  };
  child.once("exit", noteExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    noteExit(child.exitCode, child.signalCode);
  }
  const onAbort = (): void => {
    wake?.();
  };
  if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });

  const wakeLater = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (exit.info !== null || signal?.aborted === true) {
        resolve();
        return;
      }
      wake = (): void => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
    });

  try {
    let marker = scopeMarkerSeen(logPath, offset, base);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = exit.info;
      if (info !== null) {
        const seen = scopeMarkerSeen(logPath, offset, base);
        return classifyScopeExit(seen, info.code, info.signal);
      }
      if (marker) return { kind: "established" };
      if (signal?.aborted === true) {
        return await terminateScopeGroup(child, pid, killWaitMs, "aborted", logPath, offset, base);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return await terminateScopeGroup(child, pid, killWaitMs, "timeout", logPath, offset, base);
      }
      await wakeLater(Math.min(pollMs, remaining));
      marker = scopeMarkerSeen(logPath, offset, base);
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The wrapper expectation that lets a recorded scoped pid verify by argv0. */
export function scopeWrapperExpectation(scopeUnit: string): CommandExpectation {
  return {
    binary: "systemd-run",
    args: ["--user", "--scope", `--unit=${scopeUnit.slice(0, -".scope".length)}`],
  };
}

export type ScopeResolveResult =
  | { ok: true; systemdRunPath: string }
  | {
      ok: false;
      reason:
        | "not-linux"
        | "no-runtime-dir"
        | "no-user-bus"
        | "no-systemd-run"
        | "recent-pre-exec-failure"
        | "probe-failed";
    };

export interface EngineScopeLauncher {
  resolve(env: NodeJS.ProcessEnv): Promise<ScopeResolveResult>;
  unitSuffix(): string;
  noteFailure(): void;
  readonly establishTimeoutMs: number;
}

export type ProbeRunner = (
  systemdRunPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number; stderr: string }>;

export interface EngineScopeLauncherDeps {
  platform?: () => NodeJS.Platform;
  isSocket?: (path: string) => boolean;
  exists?: (path: string) => boolean;
  runProbe?: ProbeRunner;
  now?: () => number;
  unitSuffix?: () => string;
  establishTimeoutMs?: number;
}

function defaultIsSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

// The capability probe runs systemd-run in its own process group (detached, like
// the real launch) over an env built by the same shapeScopeEnv, so a probe that
// prints the exec marker means the real launch will too. Never exercised by
// tests, which inject runProbe.
async function defaultRunProbe(
  systemdRunPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(systemdRunPath, argv, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      env,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const killer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 10_000);
    child.once("close", (code: number | null) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, stderr });
    });
    child.once("error", () => {
      clearTimeout(killer);
      resolve({ code: 1, stderr });
    });
  });
}

function firstExisting(paths: readonly string[], exists: (path: string) => boolean): string | null {
  for (const candidate of paths) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Run the `--scope` capability probe of /usr/bin/true and report whether it
// printed the exec marker under the same shaped env the real launch uses.
async function probeScopeCapability(args: {
  runProbe: ProbeRunner;
  exists: (path: string) => boolean;
  unitSuffix: () => string;
  env: NodeJS.ProcessEnv;
  systemdRunPath: string;
}): Promise<boolean> {
  const { runProbe, exists, unitSuffix, env, systemdRunPath } = args;
  const probeBase = "llamactl-probe-" + unitSuffix();
  const truePath = firstExisting(TRUE_PATHS, exists) ?? "/bin/true";
  const probeArgv = buildScopeArgv(probeBase, "probe", truePath, []);
  const pathValue = env["PATH"];
  const shaped = shapeScopeEnv(pathValue === undefined ? {} : { PATH: pathValue }, env, []);
  const probeEnv = "env" in shaped ? shaped.env : {};
  let probe: { code: number; stderr: string };
  try {
    probe = await runProbe(systemdRunPath, probeArgv, probeEnv);
  } catch {
    probe = { code: 1, stderr: "" };
  }
  return (
    probe.code === 0 && probe.stderr.split("\n").some((l) => l.endsWith(scopeMarker(probeBase)))
  );
}

/**
 * Build a capability launcher. Construction spawns nothing; `resolve` runs the
 * checks in order — platform, an absolute XDG_RUNTIME_DIR, a real user-bus
 * socket, the systemd-run binary, the failure TTL, then a memoized `--scope`
 * probe of `/usr/bin/true` — and caches both the probe result and a
 * negative-cache window opened by `noteFailure`.
 */
export function createEngineScopeLauncher(deps: EngineScopeLauncherDeps = {}): EngineScopeLauncher {
  const platform = deps.platform ?? ((): NodeJS.Platform => process.platform);
  const isSocket = deps.isSocket ?? defaultIsSocket;
  const exists = deps.exists ?? existsSync;
  const runProbe = deps.runProbe ?? defaultRunProbe;
  const now = deps.now ?? ((): number => Date.now());
  const unitSuffix = deps.unitSuffix ?? ((): string => randomBytes(6).toString("hex"));
  const establishTimeoutMs = deps.establishTimeoutMs ?? SCOPE_ESTABLISH_TIMEOUT_MS;

  let probeMemo: { ok: boolean; at: number } | null = null;
  let negativeUntil = 0;

  return {
    establishTimeoutMs,
    unitSuffix,
    noteFailure(): void {
      negativeUntil = now() + SCOPE_NEGATIVE_TTL_MS;
      probeMemo = null;
    },
    async resolve(env: NodeJS.ProcessEnv): Promise<ScopeResolveResult> {
      if (platform() !== "linux") return { ok: false, reason: "not-linux" };
      const runtimeDir = env["XDG_RUNTIME_DIR"];
      if (runtimeDir === undefined || !isAbsolute(runtimeDir)) {
        return { ok: false, reason: "no-runtime-dir" };
      }
      if (!isSocket(join(runtimeDir, "bus"))) return { ok: false, reason: "no-user-bus" };
      const systemdRunPath = firstExisting(SYSTEMD_RUN_PATHS, exists);
      if (systemdRunPath === null) return { ok: false, reason: "no-systemd-run" };
      if (now() < negativeUntil) return { ok: false, reason: "recent-pre-exec-failure" };
      const cached = probeMemo;
      if (cached !== null && now() - cached.at < SCOPE_NEGATIVE_TTL_MS) {
        return cached.ok ? { ok: true, systemdRunPath } : { ok: false, reason: "probe-failed" };
      }
      const ok = await probeScopeCapability({ runProbe, exists, unitSuffix, env, systemdRunPath });
      probeMemo = { ok, at: now() };
      return ok ? { ok: true, systemdRunPath } : { ok: false, reason: "probe-failed" };
    },
  };
}

let installedLauncher: EngineScopeLauncher | null = null;

export function setEngineScopeLauncher(launcher: EngineScopeLauncher | null): void {
  installedLauncher = launcher;
}

export function getEngineScopeLauncher(): EngineScopeLauncher | null {
  return installedLauncher;
}

function stopFile(dir: string, stem: string): string {
  return join(dir, `${stem}.scope-stop`);
}

function pendingFile(dir: string, stem: string): string {
  return join(dir, `${stem}.scope-pending`);
}

/**
 * A tombstone names the scope a teardown is already draining. A scoped launch
 * that sees a tombstone for its own unit must NOT fall back to a direct spawn —
 * the engine was deliberately stopped mid-handshake, and double-booting it is
 * exactly the defect the tombstone prevents.
 */
export function writeScopeStop(dir: string, stem: string, unit: string): void {
  writeFileSync(stopFile(dir, stem), JSON.stringify({ scopeUnit: unit }));
}

export function scopeStopNames(dir: string, stem: string, unit: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(stopFile(dir, stem), "utf8")) as { scopeUnit?: unknown };
    return parsed.scopeUnit === unit;
  } catch {
    return false;
  }
}

/** The pending record names the wrapper pid + unit between spawn and handshake. */
export function writeScopePending(dir: string, stem: string, pid: number, unit: string): void {
  writeFileSync(pendingFile(dir, stem), JSON.stringify({ pid, scopeUnit: unit }));
}

export function readScopePending(
  dir: string,
  stem: string,
): { pid: number; scopeUnit: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingFile(dir, stem), "utf8")) as {
      pid?: unknown;
      scopeUnit?: unknown;
    };
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      isScopeUnit(parsed.scopeUnit)
    ) {
      return { pid: parsed.pid, scopeUnit: parsed.scopeUnit };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the pending record once the handshake completes, but only if we own it. */
export function removeScopePendingIfOwned(dir: string, stem: string, pid: number): void {
  const pending = readScopePending(dir, stem);
  if (pending !== null && pending.pid !== pid) return;
  try {
    unlinkSync(pendingFile(dir, stem));
  } catch {
    // Best-effort: a missing record is already the cleared state.
  }
}
