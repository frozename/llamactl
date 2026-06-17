import { sourceRevision } from "@llamactl/core";
import {
  noderunReconciler,
  workloadLock,
  workloadReconciler,
  workloadStore,
} from "@llamactl/remote";

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
  --no-reload-on-source-change
                   Keep running even when the controller's own git HEAD
                   moves after startup. Default: exit on a debounced change
                   so launchd reloads fresh code (avoids serving stale logic).

A lock file at $LLAMACTL_WORKLOADS_DIR/.controller.lock guards against
two controllers racing on the same directory. Stale locks from
crashed controllers are stolen automatically when their PID is gone.
`;

interface ControllerFlags {
  intervalMs: number;
  once: boolean;
  reloadOnSourceChange: boolean;
}

export function parseFlags(args: string[]): ControllerFlags | { error: string } {
  let intervalMs = 10_000;
  let once = false;
  let reloadOnSourceChange = true;
  for (const arg of args) {
    if (arg === "--once") once = true;
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
  return { intervalMs, once, reloadOnSourceChange };
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

export async function runController(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== "serve") {
    process.stderr.write(`Unknown controller subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }

  const parsed = parseFlags(rest);
  if ("error" in parsed) {
    const stream = parsed.error === "help" ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === "help" ? 0 : 1;
  }

  const { config: kubecfg } = await import("@llamactl/remote");
  const cfgPath = process.env.LLAMACTL_CONFIG ?? kubecfg.defaultConfigPath();
  // Reuse the canonical resolver instead of reinventing the
  // DEV_STORAGE→~/.llamactl base (the inline copy used $HOME +
  // `??`, which fed an "undefined/.llamactl" path when HOME was
  // unset and kept an empty-string DEV_STORAGE).
  const workloadsDir = workloadStore.defaultWorkloadsDir();
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
  process.stdout.write(`controller: source revision ${startupRev ?? "none"}\n`);

  const stopping = { value: false };
  const wakeRef: { wake: (() => void) | null } = { wake: null };
  const { isStopping, onSignal } = setupSignalHandlers(stopping, wakeRef);

  const runOnePass = (): Promise<void> => runReconcilePass(workloadsDir, resolveNodeIdentity);

  try {
    if (parsed.once) {
      await runOnePass();
      return 0;
    }
    await runServeLoop(parsed, stopping, wakeRef, isStopping, runOnePass, startupRev);
    return 0;
  } finally {
    workloadLock.releaseLock(acquired);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runReconcilePass(
  workloadsDir: string,
  resolveNodeIdentity: (n: string) => string | null,
): Promise<void> {
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
  if (modelrunResult.reports.length === 0 && noderunResult.reports.length === 0) {
    process.stdout.write(`[${new Date().toISOString()}] idle (no manifests in ${workloadsDir})\n`);
    return;
  }
  for (const r of modelrunResult.reports) {
    const tail = r.error ? ` error=${r.error}` : "";
    process.stdout.write(
      `[${new Date().toISOString()}] modelrun/${r.name} on ${r.node}: ${r.action}${tail}\n`,
    );
  }
}

/**
 * One loop-boundary source check: advance the stale streak, and if the running
 * source changed since startup, warn — exiting (→ launchd reload) once the change
 * is debounced and reload is enabled. Returns the next streak state. Extracted
 * from runServeLoop to keep that loop body under the complexity budget.
 */
function controllerSourceBoundary(
  staleState: sourceRevision.StaleStreakState,
  startupRev: string | null,
  reloadOnSourceChange: boolean,
): sourceRevision.StaleStreakState {
  const gate = applyControllerSourceGate(staleState, { startupRev });
  if (gate.currentRev !== null && gate.currentRev !== startupRev) {
    const reloading = gate.shouldReload && reloadOnSourceChange;
    process.stderr.write(
      `controller: source revision changed since startup (was ${String(startupRev)}, now ${gate.currentRev})${reloading ? " — reloading" : ""}\n`,
    );
    if (reloading) process.exit(0);
  }
  return gate.nextState;
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
  runOnePass: () => Promise<void>,
  startupRev: string | null,
): Promise<void> {
  let staleState: sourceRevision.StaleStreakState = { streak: 0 };
  while (!stopping.value) {
    const start = Date.now();
    try {
      await runOnePass();
    } catch (err) {
      process.stderr.write(
        `[${new Date().toISOString()}] reconcile error: ${(err as Error).message}\n`,
      );
    }
    if (isStopping()) break;
    // Loop boundary (after a completed pass): if the running source changed, warn
    // every boundary and — once debounced — exit so launchd reloads fresh code.
    staleState = controllerSourceBoundary(staleState, startupRev, parsed.reloadOnSourceChange);
    const elapsed = Date.now() - start;
    const sleepMs = Math.max(100, parsed.intervalMs - elapsed);
    await sleepInterruptible(sleepMs, wakeRef);
  }
}
