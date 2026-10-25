import { sourceRevision } from "@llamactl/core";
import {
  type CgroupOomSample,
  readCgroupOomSample,
  readOomBaseline,
  writeOomBaseline,
} from "@llamactl/core/cgroupOom";
import { recordModelHostOomKill } from "@llamactl/core/engines/conditions";
import { resolveEnv } from "@llamactl/core/env";
import {
  modelHostStore,
  noderunReconciler,
  workloadLock,
  workloadReconciler,
  workloadStore,
} from "@llamactl/remote";
import {
  externalManagerOf,
  type ModelHostManifest,
} from "@llamactl/remote/workload/modelhost-schema";
import { join } from "node:path";

import { getNodeClientByName } from "../dispatcher.js";
import { makeSpecArtifactResolver } from "./noderun-helpers.js";

const USAGE = `Usage: llamactl controller serve [--interval=<s>] [--once]

Run the reconcile loop against every manifest in the workloads
directory. Each tick queries the target node's serverStatus and
converges:
  * Unchanged when observed already matches desired.
  * Restart when observed mismatches (different rel or extraArgs).
  * Start when no server is running.

Flags:
  --interval=<s>   Seconds between reconcile passes (default 10).
  --once           Run one pass then exit (useful for cron-driven setups).
  --force          Start even when ModelHosts carry a llamactl.io/managed-by
                   label. Labeled hosts stay skipped by the reconciler.
  --no-reload-on-source-change
                   Keep running even when the controller's own git HEAD
                   moves after startup. Default: exit on a debounced change
                   so launchd reloads fresh code (avoids serving stale logic).

A lock file at $LLAMACTL_WORKLOADS_DIR/.controller.lock guards against
two controllers racing on the same directory. Stale locks from
crashed controllers are stolen automatically when their PID is gone.

A reconcile error is logged to stderr once per distinct message, again
every 10 minutes while it persists, and once on recovery. On Linux the
controller reads its own cgroup's memory.events each pass; when oom_kill
rises and a local ModelHost engine is found dead, it logs the OOM kill
and records an OOMKilled condition (see 'llamactl describe workload').
`;

interface ControllerFlags {
  intervalMs: number;
  once: boolean;
  force: boolean;
  reloadOnSourceChange: boolean;
}

export function parseFlags(args: string[]): ControllerFlags | { error: string } {
  let intervalMs = 10_000;
  let once = false;
  let force = false;
  let reloadOnSourceChange = true;
  for (const arg of args) {
    if (arg === "--once") once = true;
    else if (arg === "--force") force = true;
    else if (arg === "--no-reload-on-source-change") reloadOnSourceChange = false;
    else if (arg === "-h" || arg === "--help") return { error: "help" };
    else if (arg.startsWith("--interval=")) {
      const n = Number.parseFloat(arg.slice("--interval=".length));
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `controller: invalid --interval: ${arg}` };
      }
      intervalMs = Math.round(n * 1000);
    } else {
      return { error: `controller: unknown flag ${arg}` };
    }
  }
  return { intervalMs, once, force, reloadOnSourceChange };
}

/**
 * Refusal message when the store holds ModelHosts marked as managed by
 * another controller (llamactl.io/managed-by), or null when none are.
 * --force only lets the controller start; the reconciler still skips those
 * hosts, so a retired local controller can never reclaim a central seat.
 */
export function externallyManagedRefusal(hosts: readonly ModelHostManifest[]): string | null {
  const labeled = hosts.flatMap((host) => {
    const manager = externalManagerOf(host);
    return manager !== null ? [`modelhost/${host.metadata.name} (${manager})`] : [];
  });
  if (labeled.length === 0) return null;
  return (
    `ModelHosts are managed by another controller (llamactl.io/managed-by): ` +
    `${labeled.join(", ")}; refusing to start these seats. ` +
    `Re-run with --force to start anyway (labeled hosts stay skipped).`
  );
}

/**
 * The reconcile-loop boundary check (exported for unit testing without the slow
 * spawn-e2e). Advances the stale streak via the shared core reducer and reports
 * whether the running source changed and whether the change is debounced enough to
 * warrant a reload. `startupRev` null/undefined ⇒ feature off (inert).
 */
export function applyControllerSourceGate(
  state: sourceRevision.StaleStreakState,
  opts: {
    startupRev: string | null | undefined;
    readSourceRevision?: () => string | null;
    reloadStaleChecks?: number;
  },
): {
  nextState: sourceRevision.StaleStreakState;
  shouldReload: boolean;
  currentRev: string | null;
} {
  if (opts.startupRev === null || opts.startupRev === undefined) {
    return { nextState: state, shouldReload: false, currentRev: null };
  }
  const r = sourceRevision.checkSourceStale(opts.startupRev, state, {
    ...(opts.readSourceRevision ? { readSourceRevision: opts.readSourceRevision } : {}),
    ...(opts.reloadStaleChecks !== undefined ? { reloadStaleChecks: opts.reloadStaleChecks } : {}),
  });
  return { nextState: r.state, shouldReload: r.shouldReload, currentRev: r.currentRev };
}

/** How often a reconcile error that keeps repeating is logged again. */
export const RECONCILE_ERROR_REMINDER_MS = 10 * 60_000;

export interface ReconcileErrorEntry {
  message: string;
  firstSeenMs: number;
  lastLoggedMs: number;
  /** Consecutive failing passes with this message. */
  count: number;
}

export type ReconcileErrorLog = ReadonlyMap<string, ReconcileErrorEntry>;

export interface ControllerLogLine {
  stream: "stdout" | "stderr";
  text: string;
}

type ReportForLog = Pick<
  workloadReconciler.ReconcileNodeReport,
  "action" | "error" | "foundDead" | "kind" | "name" | "node"
>;

function reportLabel(r: ReportForLog): string {
  return `${r.kind === "ModelHost" ? "modelhost" : "modelrun"}/${r.name} on ${r.node}`;
}

function stamp(nowMs: number): string {
  return `[${new Date(nowMs).toISOString()}]`;
}

/**
 * Turn one pass's reports into log lines. A reconcile error goes to stderr
 * as a WARN the first time it is seen and whenever its message changes, is
 * repeated as a reminder at most every `reminderMs` while it persists, and is
 * closed by one recovery line; in between it is counted, not printed. Healthy
 * reports keep their per-pass stdout line. A workload missing from the pass
 * (deleted) drops out of the state silently.
 */
export function reduceReconcileReportLog(
  state: ReconcileErrorLog,
  reports: readonly ReportForLog[],
  nowMs: number,
  reminderMs: number = RECONCILE_ERROR_REMINDER_MS,
): { nextState: Map<string, ReconcileErrorEntry>; lines: ControllerLogLine[] } {
  const ts = stamp(nowMs);
  const nextState = new Map<string, ReconcileErrorEntry>();
  const lines: ControllerLogLine[] = [];
  for (const r of reports) {
    const label = reportLabel(r);
    const prev = state.get(label);
    if (r.error === undefined) {
      if (prev) {
        const text = `${ts} ${label}: recovered after ${String(prev.count)} failed pass(es)`;
        lines.push({ stream: "stderr", text });
      }
      lines.push({ stream: "stdout", text: `${ts} ${label}: ${r.action}` });
      continue;
    }
    if (prev?.message !== r.error) {
      nextState.set(label, { message: r.error, firstSeenMs: nowMs, lastLoggedMs: nowMs, count: 1 });
      lines.push({ stream: "stderr", text: `${ts} WARN ${label}: ${r.action} error=${r.error}` });
      continue;
    }
    const entry = { ...prev, count: prev.count + 1 };
    if (nowMs - prev.lastLoggedMs >= reminderMs) {
      entry.lastLoggedMs = nowMs;
      const since = new Date(prev.firstSeenMs).toISOString();
      lines.push({
        stream: "stderr",
        text: `${ts} WARN ${label}: still failing (${String(entry.count)} passes since ${since}) error=${r.error}`,
      });
    }
    nextState.set(label, entry);
  }
  return { nextState, lines };
}

/**
 * The startup gate: null when the controller may proceed, otherwise the
 * refusal message. --force only lets the controller start; the reconciler
 * still skips the labeled hosts each pass.
 */
function externalSeatRefusal(parsed: ControllerFlags, workloadsDir: string): string | null {
  if (parsed.force) return null;
  return externallyManagedRefusal(modelHostStore.listModelHosts(workloadsDir));
}

export interface OomWatchState {
  /** Last cgroup sample seen, seeded from the persisted baseline. */
  last: CgroupOomSample | null;
  /** Kills counted but not yet matched to a dead engine (held one pass). */
  pendingKills: number;
}

/**
 * Attribute a rise of the controller cgroup's oom_kill counter to the local
 * ModelHost engines found dead in the same pass. The kernel counts a kill
 * before the task is gone, so a sample taken after the pass covers every
 * engine the pass found dead; a kill that lands after a host's status check
 * is counted first, so an unmatched rise is held for one more pass and then
 * reported as unattributed. A new cgroup path or a lower counter (the cgroup
 * was recreated) re-baselines without attributing anything.
 */
export function advanceOomWatch(
  state: OomWatchState,
  sample: CgroupOomSample | null,
  deadHosts: readonly string[],
): { nextState: OomWatchState; oomKilled: string[]; unattributedKills: number } {
  const quiet = { oomKilled: [], unattributedKills: 0 };
  if (sample === null) return { nextState: state, ...quiet };
  const { last } = state;
  const reset = { last: sample, pendingKills: 0 };
  if (last?.cgroup !== sample.cgroup || sample.oomKill < last.oomKill) {
    return { nextState: reset, ...quiet };
  }
  const rise = sample.oomKill - last.oomKill;
  const pending = state.pendingKills + rise;
  if (pending === 0) return { nextState: reset, ...quiet };
  if (deadHosts.length > 0) {
    return { nextState: reset, oomKilled: [...deadHosts], unattributedKills: 0 };
  }
  if (rise === 0) return { nextState: reset, oomKilled: [], unattributedKills: pending };
  return { nextState: { last: sample, pendingKills: pending }, ...quiet };
}

/** Local ModelHosts this pass found dead that were not already failing. */
export function newlyDeadHosts(
  reports: readonly ReportForLog[],
  errorLog: ReconcileErrorLog,
): string[] {
  return reports
    .filter((r) => r.foundDead === true && !errorLog.has(reportLabel(r)))
    .map((r) => r.name);
}

export function deadHostLines(
  reports: readonly ReportForLog[],
  deadHosts: readonly string[],
  watch: { oomKilled: readonly string[]; unattributedKills: number },
  sample: CgroupOomSample | null,
  nowMs: number,
): ControllerLogLine[] {
  const ts = stamp(nowMs);
  const counter = String(sample?.oomKill ?? 0);
  const lines: ControllerLogLine[] = [];
  for (const name of deadHosts) {
    if (watch.oomKilled.includes(name)) {
      const text = `${ts} WARN modelhost/${name}: engine was OOM-killed (cgroup oom_kill ${counter}); restarting`;
      lines.push({ stream: "stderr", text });
      continue;
    }
    // A death whose restart failed is reported by the reconcile-error line.
    const report = reports.find((r) => r.kind === "ModelHost" && r.name === name);
    if (report === undefined || report.error !== undefined) continue;
    const text = `${ts} WARN ${reportLabel(report)}: engine had exited unexpectedly; restarted`;
    lines.push({ stream: "stderr", text });
  }
  if (watch.unattributedKills > 0) {
    lines.push({
      stream: "stderr",
      text: `${ts} WARN controller cgroup ${sample?.cgroup ?? "?"}: ${String(watch.unattributedKills)} OOM kill(s) (oom_kill ${counter}) not matched to a ModelHost engine`,
    });
  }
  return lines;
}

function writeLines(lines: readonly ControllerLogLine[]): void {
  for (const line of lines) {
    (line.stream === "stderr" ? process.stderr : process.stdout).write(`${line.text}\n`);
  }
}

interface ControllerPassState {
  errors: ReconcileErrorLog;
  oom: OomWatchState;
}

function oomBaselineFile(workloadsDir: string): string {
  return join(workloadsDir, ".controller-oom.json");
}

function setupSignalHandlers(
  stopping: { value: boolean },
  wakeRef: { wake: (() => void) | null },
): {
  isStopping: () => boolean;
  onSignal: (sig: NodeJS.Signals) => void;
} {
  const onSignal = (sig: NodeJS.Signals): void => {
    if (stopping.value) return;
    stopping.value = true;
    process.stdout.write(`controller: received ${sig}, exiting after current reconcile\n`);
    wakeRef.wake?.();
  };
  const isStopping = (): boolean => stopping.value;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return { isStopping, onSignal };
}

/**
 * Subcommand + flag preflight. Returns the serve flags, or a process exit
 * code once USAGE / the error has been written. Extracted from runController
 * to keep that function within the complexity budget.
 */
function parseServeInvocation(args: string[]): ControllerFlags | { code: number } {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(USAGE);
    return { code: sub === undefined ? 1 : 0 };
  }
  if (sub !== "serve") {
    process.stderr.write(`Unknown controller subcommand: ${sub}\n\n${USAGE}`);
    return { code: 1 };
  }
  const parsed = parseFlags(rest);
  if ("error" in parsed) {
    const stream = parsed.error === "help" ? process.stdout : process.stderr;
    stream.write(USAGE);
    return { code: parsed.error === "help" ? 0 : 1 };
  }
  return parsed;
}

export async function runController(args: string[]): Promise<number> {
  const invocation = parseServeInvocation(args);
  if ("code" in invocation) return invocation.code;
  const parsed = invocation;

  const { config: kubecfg } = await import("@llamactl/remote");
  const cfgPath = process.env["LLAMACTL_CONFIG"] ?? kubecfg.defaultConfigPath();
  // Reuse the canonical resolver instead of reinventing the
  // DEV_STORAGE→~/.llamactl base (the inline copy used $HOME +
  // `??`, which fed an "undefined/.llamactl" path when HOME was
  // unset and kept an empty-string DEV_STORAGE).
  const workloadsDir = workloadStore.defaultWorkloadsDir();
  const refusal = externalSeatRefusal(parsed, workloadsDir);
  if (refusal !== null) {
    process.stderr.write(`controller: ${refusal}\n`);
    return 1;
  }
  const cfg = kubecfg.loadConfig(cfgPath);
  const resolveNodeIdentity = (n: string): string | null => {
    try {
      return kubecfg.resolveNode(cfg, n).node.endpoint || null;
    } catch {
      return null;
    }
  };

  const acquired = workloadLock.acquireLock(workloadsDir);
  if ("error" in acquired) {
    process.stderr.write(`controller: ${acquired.error}\n`);
    return 1;
  }
  process.stdout.write(
    `controller started pid=${String(process.pid)} workloads=${workloadsDir} cfg=${cfgPath}\n`,
  );

  // Source-staleness auto-reload: capture the running source revision once; the
  // serve loop exits (→ launchd reload) once a confirmed post-startup change is
  // debounced. null (not a git checkout) ⇒ detection disabled.
  const startupRev = sourceRevision.getSourceRevision();
  process.stdout.write(
    startupRev
      ? `controller: source-staleness reload ARMED at ${startupRev}\n`
      : `controller: source-staleness reload OFF — no git checkout resolved (compiled binary or non-git deploy); run 'llamactl infra restart-control-plane' after deploys\n`,
  );

  const stopping = { value: false };
  const wakeRef: { wake: (() => void) | null } = { wake: null };
  const { isStopping, onSignal } = setupSignalHandlers(stopping, wakeRef);

  const runOnePass = (state: ControllerPassState): Promise<ControllerPassState> =>
    runReconcilePass(workloadsDir, resolveNodeIdentity, state);
  const initialPass: ControllerPassState = {
    errors: new Map(),
    oom: { last: readOomBaseline(oomBaselineFile(workloadsDir)), pendingKills: 0 },
  };

  try {
    if (parsed.once) {
      await runOnePass(initialPass);
      return 0;
    }
    await runServeLoop(parsed, stopping, wakeRef, isStopping, runOnePass, initialPass, startupRev);
    return 0;
  } finally {
    workloadLock.releaseLock(acquired);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * Sample the controller cgroup after a pass, attribute any new OOM kill to
 * the local engines the pass found dead, record it on their conditions, and
 * keep the persisted baseline current so a kill during a controller restart
 * still counts.
 */
function observeOomKills(
  workloadsDir: string,
  state: ControllerPassState,
  reports: readonly ReportForLog[],
  nowMs: number,
): OomWatchState {
  const sample = readCgroupOomSample();
  const deadHosts = newlyDeadHosts(reports, state.errors);
  const watch = advanceOomWatch(state.oom, sample, deadHosts);
  const { last } = state.oom;
  if (sample && (sample.cgroup !== last?.cgroup || sample.oomKill !== last.oomKill)) {
    writeOomBaseline(oomBaselineFile(workloadsDir), sample);
  }
  if (sample) {
    for (const name of watch.oomKilled) {
      try {
        recordModelHostOomKill({ name }, sample.oomKill, resolveEnv(process.env));
      } catch {
        // The log line below still reports the kill.
      }
    }
  }
  writeLines(deadHostLines(reports, deadHosts, watch, sample, nowMs));
  return watch.nextState;
}

async function runReconcilePass(
  workloadsDir: string,
  resolveNodeIdentity: (n: string) => string | null,
  state: ControllerPassState,
): Promise<ControllerPassState> {
  // ModelRun pass — converges llama-server lifecycle per manifest.
  const modelrunResult = await workloadReconciler.reconcileOnce({
    workloadsDir,
    getClient: (nodeName) => getNodeClientByName(nodeName),
    resolveNodeIdentity,
    onEvent: (e) => {
      process.stdout.write(`[${new Date().toISOString()}] ${e.name}: ${e.message}\n`);
    },
  });
  // NodeRun pass — converges infra inventory per manifest.
  const noderunResult = await noderunReconciler.reconcileNodeRunsOnce({
    workloadsDir,
    getClient: (nodeName) => getNodeClientByName(nodeName),
    getArtifactResolver: (_node, client) =>
      makeSpecArtifactResolver({
        client: client as unknown as Parameters<typeof makeSpecArtifactResolver>[0]["client"],
      }),
    onReport: (r) => {
      const tail = r.error ? ` error=${r.error}` : "";
      const actions = r.actions > 0 ? ` actions=${String(r.actions)}` : "";
      process.stdout.write(
        `[${new Date().toISOString()}] noderun/${r.name} on ${r.node}: ${r.phase}${actions}${tail}\n`,
      );
    },
  });
  const nowMs = Date.now();
  const oom = observeOomKills(workloadsDir, state, modelrunResult.reports, nowMs);
  if (modelrunResult.reports.length === 0 && noderunResult.reports.length === 0) {
    process.stdout.write(`${stamp(nowMs)} idle (no manifests in ${workloadsDir})\n`);
    return { errors: new Map(), oom };
  }
  const log = reduceReconcileReportLog(state.errors, modelrunResult.reports, nowMs);
  writeLines(log.lines);
  return { errors: log.nextState, oom };
}

/**
 * One loop-boundary source check: advance the stale streak, and if the running
 * source changed since startup, warn — exiting (→ launchd reload) once the change
 * is debounced and reload is enabled. Returns the next streak state plus the next
 * log signature. To avoid per-boundary stderr spam (e.g. under
 * --no-reload-on-source-change, where currentRev stays != startupRev forever), the
 * warning is emitted only when the `(currentRev, reloading)` signature CHANGES from
 * the last emitted one — log on transition, not on every poll. The first stale
 * boundary and the reload-flip boundary both have a new signature, so both emit.
 * Extracted from runServeLoop to keep that loop body under the complexity budget.
 */
function controllerSourceBoundary(
  staleState: sourceRevision.StaleStreakState,
  startupRev: string | null,
  reloadOnSourceChange: boolean,
  lastSig: string | null,
): { nextState: sourceRevision.StaleStreakState; nextSig: string | null } {
  const gate = applyControllerSourceGate(staleState, { startupRev });
  if (gate.currentRev !== null && gate.currentRev !== startupRev) {
    const reloading = gate.shouldReload && reloadOnSourceChange;
    const sig = `${gate.currentRev}|${String(reloading)}`;
    if (sig !== lastSig) {
      process.stderr.write(
        `controller: source revision changed since startup (was ${String(startupRev)}, now ${gate.currentRev})${reloading ? " — reloading" : ""}\n`,
      );
      if (reloading) process.exit(0);
      return { nextState: gate.nextState, nextSig: sig };
    }
  }
  return { nextState: gate.nextState, nextSig: lastSig };
}

// Race the sleep against a SIGTERM-triggered `wake()` so the
// loop exits promptly even during a long --interval.
async function sleepInterruptible(
  sleepMs: number,
  wakeRef: { wake: (() => void) | null },
): Promise<void> {
  await new Promise<void>((r) => {
    const timer = setTimeout(() => {
      wakeRef.wake = null;
      r();
    }, sleepMs);
    wakeRef.wake = (): void => {
      clearTimeout(timer);
      wakeRef.wake = null;
      r();
    };
  });
}

// Loop forever. Interval is measured between pass START times so
// slow passes don't bunch up on a naive "sleep N after finish".
async function runServeLoop(
  parsed: ControllerFlags,
  stopping: { value: boolean },
  wakeRef: { wake: (() => void) | null },
  isStopping: () => boolean,
  runOnePass: (state: ControllerPassState) => Promise<ControllerPassState>,
  initialPass: ControllerPassState,
  startupRev: string | null,
): Promise<void> {
  let staleState: sourceRevision.StaleStreakState = { streak: 0 };
  let lastSourceStaleSig: string | null = null;
  // Reconcile-error dedup and OOM-watch state, threaded pass to pass like the
  // source-staleness signature below.
  let passState = initialPass;
  while (!stopping.value) {
    const start = Date.now();
    try {
      passState = await runOnePass(passState);
    } catch (err) {
      process.stderr.write(
        `[${new Date().toISOString()}] reconcile error: ${(err as Error).message}\n`,
      );
    }
    if (isStopping()) break;
    // Loop boundary (after a completed pass): if the running source changed, warn
    // on each (rev,reloading) transition and — once debounced — exit so launchd
    // reloads fresh code.
    const boundary = controllerSourceBoundary(
      staleState,
      startupRev,
      parsed.reloadOnSourceChange,
      lastSourceStaleSig,
    );
    staleState = boundary.nextState;
    lastSourceStaleSig = boundary.nextSig;
    const elapsed = Date.now() - start;
    const sleepMs = Math.max(100, parsed.intervalMs - elapsed);
    await sleepInterruptible(sleepMs, wakeRef);
  }
}
