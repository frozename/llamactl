// The ordered update procedure. `controller serve` exits by itself ~20 s after
// the checkout's HEAD moves (source-staleness reload), and new code may need
// new dependencies before it can start, so the controller is stopped before the
// switch and started only after `bun install`. The heavy-job lock is taken
// before the stop and held until the start, so nothing waits on it while the
// controller is down. The agent never reloads itself; it is restarted last,
// once managed hosts are idle. Rollback is the same procedure pointed at the
// previous ref, and whatever fails, the controller is started again at the end.
import type { LockHandle, ManagedHost, UpdateDeps } from "./deps.js";
import type { AgentEndpoint } from "./probes.js";
import type { ServiceInfo, ServiceManager } from "./services.js";

import { type BranchMode, describeMode, type GitFn, resolveCommit, switchTo } from "./git.js";
import { agentHealthy, hostBaseUrl, hostIdle, hostReady, negotiateOutcome } from "./probes.js";

export type DeployStep =
  | { kind: "await-controller" }
  | { kind: "install" }
  | { kind: "lock" }
  | { kind: "unlock" }
  | { kind: "restart-agent" }
  | { kind: "start-controller" }
  | { kind: "stop-controller" }
  | { kind: "switch"; sha: string; mode: BranchMode }
  | { kind: "verify"; sha: string }
  | { kind: "wait-idle"; seconds: number };

export function buildDeploySteps(o: {
  sha: string;
  mode: BranchMode;
  depsChanged: boolean;
  waitIdleSec: number;
  restartAgent: boolean;
  /** A heavy-job lock is configured: hold it from before the stop until the start. */
  lock: boolean;
}): DeployStep[] {
  const locked = o.lock && o.depsChanged;
  return [
    ...(locked ? [{ kind: "lock" } as const] : []),
    { kind: "stop-controller" },
    { kind: "switch", sha: o.sha, mode: o.mode },
    ...(o.depsChanged ? [{ kind: "install" } as const] : []),
    { kind: "start-controller" },
    ...(locked ? [{ kind: "unlock" } as const] : []),
    { kind: "await-controller" },
    ...(o.restartAgent
      ? [{ kind: "wait-idle", seconds: o.waitIdleSec } as const, { kind: "restart-agent" } as const]
      : []),
    { kind: "verify", sha: o.sha },
  ];
}

export interface InstallCommand {
  argv: string[];
  capped: boolean;
  warnings: string[];
}

export const INSTALL_MEMORY_LIMITS = ["MemoryHigh=12G", "MemoryMax=16G", "MemorySwapMax=1G"];

/**
 * `bun install --frozen-lockfile --ignore-scripts`, memory-capped in a
 * transient systemd scope at a high OOM score when the host supports it
 * (systemd 255 rejects OOMScoreAdjust on scopes, hence choom). The heavy-job
 * lock is held around it by the procedure (`lock`/`unlock` steps), not here,
 * so its wait never eats into the install timeout.
 */
export function buildInstallCommand(o: {
  bun: string;
  platform: NodeJS.Platform;
  which: (bin: string) => string | null;
}): InstallCommand {
  const warnings: string[] = [];
  let argv = [o.bun, "install", "--frozen-lockfile", "--ignore-scripts"];
  const capped =
    o.platform === "linux" && o.which("systemd-run") !== null && o.which("choom") !== null;
  if (capped) {
    const limits = INSTALL_MEMORY_LIMITS.flatMap((l) => ["-p", l]);
    argv = [
      "systemd-run",
      "--user",
      "--scope",
      "--collect",
      "-q",
      ...limits,
      "--",
      "choom",
      "-n",
      "900",
      "--",
      ...argv,
    ];
  } else {
    warnings.push("systemd-run/choom unavailable: bun install runs without a memory cap");
  }
  return { argv, capped, warnings };
}

export type LogSource = { kind: "file"; path: string } | { kind: "journal" } | { kind: "none" };

export function controllerLogSource(info: ServiceInfo, override: string | null): LogSource {
  if (override !== null) return { kind: "file", path: override };
  if (info.stdoutPath !== null) return { kind: "file", path: info.stdoutPath };
  return info.journal ? { kind: "journal" } : { kind: "none" };
}

export interface SnapshotHost extends ManagedHost {
  /** A manifest exists, so the controller reports this host every pass. */
  reconciled: boolean;
}

export interface DeployTimeouts {
  /** How long a rollback waits for the heavy-job lock before going ahead without it. */
  rollbackLockWaitSec: number;
  controllerReportMs: number;
  controllerSettleMs: number;
  serviceStopMs: number;
  agentHealthyMs: number;
  hostReadyMs: number;
  restartedHostReadyMs: number;
  installMs: number;
  pollMs: number;
  idlePollMs: number;
}

export const DEFAULT_TIMEOUTS: DeployTimeouts = {
  rollbackLockWaitSec: 300,
  controllerReportMs: 90_000,
  controllerSettleMs: 25_000,
  serviceStopMs: 30_000,
  agentHealthyMs: 60_000,
  hostReadyMs: 60_000,
  restartedHostReadyMs: 600_000,
  installMs: 900_000,
  pollMs: 2000,
  idlePollMs: 5000,
};

export interface DeployContext {
  deps: UpdateDeps;
  git: GitFn;
  repo: string;
  manager: ServiceManager;
  controller: ServiceInfo;
  agent: ServiceInfo;
  agentEndpoint: AgentEndpoint;
  /** Environment that resolves the runtime dir the controller writes pid files to. */
  hostsEnv: NodeJS.ProcessEnv;
  snapshot: SnapshotHost[];
  install: InstallCommand;
  controllerLog: LogSource;
  timeouts: DeployTimeouts;
  /** The heavy-job lock; `handle` is set while it is held. */
  lock: HeavyLock | null;
  /** Aborted by SIGINT/SIGTERM: finish the current step, run nothing more. */
  signal: AbortSignal;
}

export interface HeavyLock {
  path: string;
  handle: LockHandle | null;
}

export interface StepResult {
  step: DeployStep["kind"];
  ok: boolean;
  detail: string;
  warnings: string[];
}

export interface DeployOutcome {
  ok: boolean;
  results: StepResult[];
  /** The procedure got as far as restarting the agent. */
  agentRestartAttempted: boolean;
  /** A signal stopped the procedure. */
  interrupted: boolean;
}

interface RunState {
  logOffset: number;
  startedAtMs: number;
  /** Hosts whose pid changed: the controller restarted them. */
  restartedHosts: Set<string>;
}

type StepOutcome = Omit<StepResult, "step">;

const ok = (detail: string, warnings: string[] = []): StepOutcome => ({
  ok: true,
  detail,
  warnings,
});
const fail = (detail: string, warnings: string[] = []): StepOutcome => ({
  ok: false,
  detail,
  warnings,
});
const short = (sha: string): string => sha.slice(0, 7);

export const INTERRUPTED = "interrupted by a signal";

async function pollUntil(
  ctx: DeployContext,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = ctx.deps.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (ctx.deps.now() >= deadline || ctx.signal.aborted) return false;
    await ctx.deps.sleep(intervalMs, ctx.signal);
  }
}

export function stepLabel(
  step: DeployStep,
  ctx: Pick<DeployContext, "agent" | "controller">,
): string {
  switch (step.kind) {
    case "lock":
      return "taking the heavy-job lock before stopping anything";
    case "unlock":
      return "releasing the heavy-job lock";
    case "stop-controller":
      return `stopping ${ctx.controller.name} (managed model hosts keep serving)`;
    case "switch":
      return `switching the checkout to ${short(step.sha)} on ${describeMode(step.mode)}`;
    case "install":
      return "bun install --frozen-lockfile --ignore-scripts (dependencies changed)";
    case "start-controller":
      return `starting ${ctx.controller.name}`;
    case "await-controller":
      return "waiting for the controller to re-adopt the managed hosts";
    case "wait-idle":
      return `waiting up to ${String(step.seconds)} s for idle model hosts before restarting the agent`;
    case "restart-agent":
      return `restarting ${ctx.agent.name}`;
    case "verify":
      return "verifying";
  }
}

/**
 * Hold the heavy-job lock before anything is stopped. An --apply takes it up
 * front (and refuses without it), so this only waits in a rollback, which
 * then goes ahead without the lock rather than leave the failed code running.
 */
async function takeLock(ctx: DeployContext): Promise<StepOutcome> {
  const lock = ctx.lock;
  if (lock === null) return ok("no heavy-job lock configured");
  if (lock.handle !== null) return ok(`holding ${lock.path}`);
  const wait = ctx.timeouts.rollbackLockWaitSec;
  lock.handle = await ctx.deps.acquireLock(lock.path, wait, ctx.signal);
  if (lock.handle !== null) return ok(`holding ${lock.path}`);
  if (ctx.signal.aborted) return fail(INTERRUPTED);
  return ok(`proceeding without ${lock.path}`, [
    `could not take the heavy-job lock within ${String(wait)} s; going ahead without it (bun install stays memory-capped)`,
  ]);
}

function releaseLock(ctx: DeployContext): StepOutcome {
  const lock = ctx.lock;
  const handle = lock?.handle ?? null;
  if (lock === null || handle === null) return ok("no heavy-job lock held");
  handle.release();
  lock.handle = null;
  return ok(`released ${lock.path}`);
}

async function stopController(ctx: DeployContext): Promise<StepOutcome> {
  const r = await ctx.manager.stop(ctx.controller);
  const stopped = await pollUntil(
    ctx,
    ctx.timeouts.serviceStopMs,
    ctx.timeouts.pollMs,
    async () => !(await ctx.manager.isActive(ctx.controller)),
  );
  if (stopped) return ok(`${ctx.controller.name} stopped`);
  return fail(
    `could not stop ${ctx.controller.name}: ${r.stderr.trim() || `exit ${String(r.code)}`}`,
  );
}

async function switchCheckout(
  ctx: DeployContext,
  sha: string,
  mode: BranchMode,
): Promise<StepOutcome> {
  const err = await switchTo(ctx.git, sha, mode);
  return err === null ? ok(`HEAD ${short(sha)} on ${describeMode(mode)}`) : fail(err);
}

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join(" | ");
}

async function install(ctx: DeployContext): Promise<StepOutcome> {
  // Its own process group: a timeout or a signal kills everything it started.
  const r = await ctx.deps.exec(ctx.install.argv, {
    cwd: ctx.repo,
    timeoutMs: ctx.timeouts.installMs,
    processGroup: true,
    signal: ctx.signal,
  });
  if (r.code === 0) {
    const how = [
      ctx.install.capped ? "memory-capped" : "uncapped",
      (ctx.lock?.handle ?? null) === null ? null : "under the heavy-job lock",
    ];
    return ok(
      `bun install done (${how.filter((s) => s !== null).join(", ")})`,
      ctx.install.warnings,
    );
  }
  return fail(
    `bun install failed (exit ${String(r.code)}): ${tail(r.stderr || r.stdout, 5)}`,
    ctx.install.warnings,
  );
}

async function startController(ctx: DeployContext, state: RunState): Promise<StepOutcome> {
  if (ctx.controllerLog.kind === "file") {
    state.logOffset = ctx.deps.fileSize(ctx.controllerLog.path) ?? 0;
  }
  state.startedAtMs = ctx.deps.now();
  const r = await ctx.manager.start(ctx.controller);
  if (r.code === 0 || (await ctx.manager.isActive(ctx.controller))) {
    return ok(`${ctx.controller.name} started`);
  }
  return fail(
    `could not start ${ctx.controller.name}: ${r.stderr.trim() || `exit ${String(r.code)}`}`,
  );
}

export interface ControllerReports {
  /** `controller started pid=` seen. */
  started: boolean;
  /** At least one reconcile-pass line after the start line. */
  passSeen: boolean;
  /** Workload name → the actions reported for it since the start line. */
  actions: Map<string, Set<string>>;
}

const REPORT_RE = /^\[[^\]]+\] (?:modelhost|modelrun)\/([^\s/]+) on [^\s:]+: ([a-z-]+)/;

/** What a controller's stdout since its (re)start says about the reconcile passes. */
export function parseControllerReports(text: string): ControllerReports {
  const out: ControllerReports = { started: false, passSeen: false, actions: new Map() };
  for (const line of text.split("\n")) {
    if (line.startsWith("controller started pid=")) {
      out.started = true;
      continue;
    }
    if (!out.started || !line.startsWith("[")) continue;
    out.passSeen = true;
    const match = REPORT_RE.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const set = out.actions.get(match[1]) ?? new Set<string>();
    set.add(match[2]);
    out.actions.set(match[1], set);
  }
  return out;
}

/** Expected hosts the controller has not yet reported as unchanged. */
export function missingAdoptions(
  reports: ControllerReports,
  expected: readonly string[],
): string[] {
  return expected.filter((name) => {
    const actions = reports.actions.get(name);
    return actions === undefined || !(actions.has("unchanged") || actions.has("converged"));
  });
}

async function readControllerOutput(ctx: DeployContext, state: RunState): Promise<string | null> {
  const src = ctx.controllerLog;
  if (src.kind === "none") return null;
  if (src.kind === "journal") {
    return await ctx.manager.journalSince(ctx.controller, state.startedAtMs - 1000);
  }
  const size = ctx.deps.fileSize(src.path);
  if (size !== null && size < state.logOffset) state.logOffset = 0;
  return ctx.deps.readFileFrom(src.path, state.logOffset) ?? "";
}

/** Compare the managed hosts' pids with the snapshot taken before the update. */
function compareHostPids(
  ctx: DeployContext,
  state: RunState,
): { detail: string; warnings: string[] } {
  if (ctx.snapshot.length === 0) return { detail: "no managed model hosts", warnings: [] };
  const now = new Map(ctx.deps.listManagedHosts(ctx.hostsEnv).map((h) => [h.name, h.pid]));
  const warnings: string[] = [];
  const kept: string[] = [];
  for (const h of ctx.snapshot) {
    const pid = now.get(h.name);
    if (pid === h.pid) kept.push(`${h.name} (pid ${String(pid)})`);
    else {
      state.restartedHosts.add(h.name);
      warnings.push(
        pid === undefined
          ? `${h.name} (pid ${String(h.pid)}) is no longer running`
          : `${h.name} pid changed ${String(h.pid)} -> ${String(pid)}: it was restarted`,
      );
    }
  }
  return {
    detail: kept.length > 0 ? `unchanged: ${kept.join(", ")}` : "no host kept its pid",
    warnings,
  };
}

function adoptionOutcome(
  ctx: DeployContext,
  state: RunState,
  reports: ControllerReports | null,
  extra: string[],
): StepOutcome {
  const pids = compareHostPids(ctx, state);
  const warnings = [...extra, ...pids.warnings];
  for (const [name, actions] of reports?.actions ?? []) {
    if (actions.has("started") || actions.has("restarted")) {
      warnings.push(`the controller (re)started ${name}`);
    }
  }
  return ok(`controller running; ${pids.detail}`, warnings);
}

/** Without readable controller output: require the controller to stay up for a settle period. */
async function settleController(
  ctx: DeployContext,
  state: RunState,
  why: string,
): Promise<StepOutcome> {
  const deadline = ctx.deps.now() + ctx.timeouts.controllerSettleMs;
  for (;;) {
    if (!(await ctx.manager.isActive(ctx.controller))) {
      return fail(`${ctx.controller.name} is not active`);
    }
    if (ctx.signal.aborted) return fail(INTERRUPTED);
    if (ctx.deps.now() >= deadline) break;
    await ctx.deps.sleep(ctx.timeouts.pollMs, ctx.signal);
  }
  const settled = `${why}; checked that ${ctx.controller.name} stayed active for ${String(ctx.timeouts.controllerSettleMs / 1000)} s`;
  return adoptionOutcome(ctx, state, null, [settled]);
}

/** One look at the controller's output: a final outcome, or null to keep waiting. */
async function pollControllerOnce(
  ctx: DeployContext,
  state: RunState,
  expected: readonly string[],
  deadline: number,
): Promise<StepOutcome | null> {
  if (!(await ctx.manager.isActive(ctx.controller))) {
    return fail(`${ctx.controller.name} is not active`);
  }
  const text = await readControllerOutput(ctx, state);
  if (text === null) {
    return await settleController(ctx, state, "journalctl could not read the controller output");
  }
  const reports = parseControllerReports(text);
  const missing = missingAdoptions(reports, expected);
  if (reports.started && reports.passSeen && missing.length === 0) {
    return adoptionOutcome(ctx, state, reports, []);
  }
  if (ctx.deps.now() < deadline) return null;
  const what =
    missing.length > 0 ? `report ${missing.join(", ")} unchanged` : "complete a reconcile pass";
  return fail(
    `the controller did not ${what} within ${String(ctx.timeouts.controllerReportMs / 1000)} s`,
  );
}

async function awaitController(ctx: DeployContext, state: RunState): Promise<StepOutcome> {
  if (ctx.controllerLog.kind === "none") {
    return await settleController(ctx, state, "controller output is not readable");
  }
  const expected = ctx.snapshot.filter((h) => h.reconciled).map((h) => h.name);
  const deadline = ctx.deps.now() + ctx.timeouts.controllerReportMs;
  for (;;) {
    const outcome = await pollControllerOnce(ctx, state, expected, deadline);
    if (outcome !== null) return outcome;
    if (ctx.signal.aborted) return fail(INTERRUPTED);
    await ctx.deps.sleep(ctx.timeouts.pollMs, ctx.signal);
  }
}

async function waitIdle(ctx: DeployContext, seconds: number): Promise<StepOutcome> {
  if (ctx.snapshot.length === 0) return ok("no managed model hosts");
  const deadline = ctx.deps.now() + seconds * 1000;
  let lastLogged = -Infinity;
  for (;;) {
    const states = await Promise.all(
      ctx.snapshot.map(async (h) => ({ name: h.name, state: await hostIdle(ctx.deps.httpGet, h) })),
    );
    const busy = states.filter((s) => s.state === "busy").map((s) => s.name);
    const unknown = states.filter((s) => s.state === "unknown").map((s) => s.name);
    const note = unknown.length > 0 ? ` (idle state unknown for ${unknown.join(", ")})` : "";
    if (busy.length === 0) return ok(`model hosts idle${note}`);
    if (ctx.deps.now() >= deadline) {
      return ok("model hosts busy", [
        `${busy.join(", ")} still busy after ${String(seconds)} s; restarting the agent anyway`,
      ]);
    }
    if (ctx.signal.aborted) return fail(INTERRUPTED);
    if (ctx.deps.now() - lastLogged >= 30_000) {
      ctx.deps.log(`llamactl update: waiting: ${busy.join(", ")} busy`);
      lastLogged = ctx.deps.now();
    }
    await ctx.deps.sleep(ctx.timeouts.idlePollMs, ctx.signal);
  }
}

async function restartAgent(ctx: DeployContext): Promise<StepOutcome> {
  const r = await ctx.manager.restart(ctx.agent);
  if (r.code !== 0) {
    return fail(
      `could not restart ${ctx.agent.name}: ${r.stderr.trim() || `exit ${String(r.code)}`}`,
    );
  }
  const healthy = await pollUntil(
    ctx,
    ctx.timeouts.agentHealthyMs,
    ctx.timeouts.pollMs,
    async () => await agentHealthy(ctx.deps.httpGet, ctx.agentEndpoint),
  );
  if (!healthy) {
    return fail(
      `agent ${ctx.agentEndpoint.url}/healthz not ok within ${String(ctx.timeouts.agentHealthyMs / 1000)} s`,
    );
  }
  return ok(`${ctx.agent.name} restarted, healthz ok`);
}

async function hostsNotReady(ctx: DeployContext, state: RunState): Promise<string[]> {
  const out: string[] = [];
  for (const h of ctx.snapshot) {
    // A host the controller restarted may still be loading its model.
    const timeout = state.restartedHosts.has(h.name)
      ? ctx.timeouts.restartedHostReadyMs
      : ctx.timeouts.hostReadyMs;
    const ready = await pollUntil(
      ctx,
      timeout,
      ctx.timeouts.pollMs,
      async () => await hostReady(ctx.deps.httpGet, h),
    );
    if (!ready) out.push(`${h.name} (${hostBaseUrl(h)})`);
  }
  return out;
}

async function verify(ctx: DeployContext, state: RunState, sha: string): Promise<StepOutcome> {
  const problems: string[] = [];
  const head = await resolveCommit(ctx.git, "HEAD");
  if (head !== sha) {
    problems.push(`HEAD is ${head === null ? "unknown" : short(head)}, expected ${short(sha)}`);
  }
  if (!(await ctx.manager.isActive(ctx.controller))) {
    problems.push(`${ctx.controller.name} is not active`);
  }
  const agentOk =
    (await ctx.manager.isActive(ctx.agent)) &&
    (await pollUntil(
      ctx,
      ctx.timeouts.agentHealthyMs,
      ctx.timeouts.pollMs,
      async () => await agentHealthy(ctx.deps.httpGet, ctx.agentEndpoint),
    ));
  if (!agentOk) {
    problems.push(`agent ${ctx.agent.name} is not healthy (${ctx.agentEndpoint.url}/healthz)`);
  }
  const notReady = await hostsNotReady(ctx, state);
  if (notReady.length > 0) problems.push(`model hosts not ready: ${notReady.join(", ")}`);
  if (problems.length > 0) return fail(problems.join("; "));
  const negotiate = await negotiateOutcome(ctx.deps.httpGet, ctx.agentEndpoint);
  const hosts =
    ctx.snapshot.length > 0 ? `, ready: ${ctx.snapshot.map((h) => h.name).join(", ")}` : "";
  const rpc = negotiate === null ? "" : `, worker RPC negotiate: ${negotiate}`;
  return ok(`HEAD ${short(sha)}, controller active, agent healthz ok${hosts}${rpc}`);
}

async function runStep(
  step: DeployStep,
  ctx: DeployContext,
  state: RunState,
): Promise<StepOutcome> {
  switch (step.kind) {
    case "lock":
      return await takeLock(ctx);
    case "unlock":
      return releaseLock(ctx);
    case "stop-controller":
      return await stopController(ctx);
    case "switch":
      return await switchCheckout(ctx, step.sha, step.mode);
    case "install":
      return await install(ctx);
    case "start-controller":
      return await startController(ctx, state);
    case "await-controller":
      return await awaitController(ctx, state);
    case "wait-idle":
      return await waitIdle(ctx, step.seconds);
    case "restart-agent":
      return await restartAgent(ctx);
    case "verify":
      return await verify(ctx, state, step.sha);
  }
}

/**
 * One step; an exception becomes a failed step, so a half-done procedure still
 * reaches the caller's rollback instead of leaving the controller stopped.
 */
async function runStepSafely(
  step: DeployStep,
  ctx: DeployContext,
  state: RunState,
): Promise<StepOutcome> {
  try {
    return await runStep(step, ctx, state);
  } catch (err) {
    return fail(`unexpected error: ${(err as Error).message}`);
  }
}

/** Run the steps in order, stopping at the first failure or at a signal. */
export async function runDeploy(
  steps: readonly DeployStep[],
  ctx: DeployContext,
): Promise<DeployOutcome> {
  const state: RunState = { logOffset: 0, startedAtMs: ctx.deps.now(), restartedHosts: new Set() };
  const results: StepResult[] = [];
  let agentRestartAttempted = false;
  for (const step of steps) {
    if (ctx.signal.aborted) return { ok: false, results, agentRestartAttempted, interrupted: true };
    ctx.deps.log(`llamactl update: ${stepLabel(step, ctx)}`);
    if (step.kind === "restart-agent") agentRestartAttempted = true;
    const outcome = await runStepSafely(step, ctx, state);
    results.push({ step: step.kind, ...outcome });
    for (const w of outcome.warnings) ctx.deps.log(`llamactl update: WARNING: ${w}`);
    ctx.deps.log(`llamactl update:   ${outcome.ok ? "ok" : "FAILED"}: ${outcome.detail}`);
    if (!outcome.ok) {
      return { ok: false, results, agentRestartAttempted, interrupted: ctx.signal.aborted };
    }
  }
  return { ok: true, results, agentRestartAttempted, interrupted: false };
}

/**
 * The last line of defence on every exit path (failure, failed rollback,
 * exception, signal): if the controller is not running, start it, then drop
 * the heavy-job lock. Never throws. Null when the controller was running.
 */
export async function ensureControllerRunning(ctx: DeployContext): Promise<StepResult | null> {
  try {
    if (await ctx.manager.isActive(ctx.controller)) return null;
    ctx.deps.log(`llamactl update: ${ctx.controller.name} is not running; starting it`);
    const r = await ctx.manager.start(ctx.controller);
    const started = r.code === 0 || (await ctx.manager.isActive(ctx.controller));
    const detail = started
      ? `${ctx.controller.name} started`
      : `could not start ${ctx.controller.name}: ${r.stderr.trim() || `exit ${String(r.code)}`}`;
    ctx.deps.log(`llamactl update:   ${started ? "ok" : "FAILED"}: ${detail}`);
    return { step: "start-controller", ok: started, detail, warnings: [] };
  } catch (err) {
    const detail = `could not start ${ctx.controller.name}: ${(err as Error).message}`;
    return { step: "start-controller", ok: false, detail, warnings: [] };
  } finally {
    releaseLock(ctx);
  }
}
