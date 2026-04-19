import {
  noderunReconciler,
  workloadLock,
  workloadReconciler,
} from '@llamactl/remote';
import { getNodeClientByName } from '../dispatcher.js';
import { makeSpecArtifactResolver } from './noderun-helpers.js';

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

A lock file at \$LLAMACTL_WORKLOADS_DIR/.controller.lock guards against
two controllers racing on the same directory. Stale locks from
crashed controllers are stolen automatically when their PID is gone.
`;

interface ControllerFlags {
  intervalMs: number;
  once: boolean;
}

function parseFlags(args: string[]): ControllerFlags | { error: string } {
  let intervalMs = 10_000;
  let once = false;
  for (const arg of args) {
    if (arg === '--once') once = true;
    else if (arg === '-h' || arg === '--help') return { error: 'help' };
    else if (arg.startsWith('--interval=')) {
      const n = Number.parseFloat(arg.slice('--interval='.length));
      if (!Number.isFinite(n) || n <= 0) {
        return { error: `controller: invalid --interval: ${arg}` };
      }
      intervalMs = Math.round(n * 1000);
    } else {
      return { error: `controller: unknown flag ${arg}` };
    }
  }
  return { intervalMs, once };
}

export async function runController(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'serve') {
    process.stderr.write(`Unknown controller subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }

  const parsed = parseFlags(rest);
  if ('error' in parsed) {
    const stream = parsed.error === 'help' ? process.stdout : process.stderr;
    stream.write(USAGE);
    return parsed.error === 'help' ? 0 : 1;
  }

  const { default: path } = await import('node:path');
  const { config: kubecfg } = await import('@llamactl/remote');
  const cfgPath = process.env.LLAMACTL_CONFIG ?? kubecfg.defaultConfigPath();
  const workloadsDir = process.env.LLAMACTL_WORKLOADS_DIR
    ?? path.join(process.env.DEV_STORAGE ?? `${process.env.HOME}/.llamactl`, 'workloads');

  const acquired = workloadLock.acquireLock(workloadsDir);
  if ('error' in acquired) {
    process.stderr.write(`controller: ${acquired.error}\n`);
    return 1;
  }
  process.stdout.write(
    `controller started pid=${process.pid} workloads=${workloadsDir} cfg=${cfgPath}\n`,
  );

  let stopping = false;
  let wake: (() => void) | null = null;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`controller: received ${sig}, exiting after current reconcile\n`);
    wake?.();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const runOnePass = async (): Promise<void> => {
    // ModelRun pass — converges llama-server lifecycle per manifest.
    const modelrunResult = await workloadReconciler.reconcileOnce({
      workloadsDir,
      getClient: (nodeName) => getNodeClientByName(nodeName),
      onEvent: (e) => {
        process.stdout.write(`[${new Date().toISOString()}] ${e.name}: ${e.message}\n`);
      },
    });
    // NodeRun pass — converges infra inventory per manifest.
    const noderunResult = await noderunReconciler.reconcileNodeRunsOnce({
      workloadsDir,
      getClient: (nodeName) => getNodeClientByName(nodeName),
      getArtifactResolver: (_node, client) =>
        makeSpecArtifactResolver({ client: client as unknown as Parameters<typeof makeSpecArtifactResolver>[0]['client'] }),
      onReport: (r) => {
        const tail = r.error ? ` error=${r.error}` : '';
        const actions = r.actions > 0 ? ` actions=${r.actions}` : '';
        process.stdout.write(
          `[${new Date().toISOString()}] noderun/${r.name} on ${r.node}: ${r.phase}${actions}${tail}\n`,
        );
      },
    });
    if (modelrunResult.reports.length === 0 && noderunResult.reports.length === 0) {
      process.stdout.write(
        `[${new Date().toISOString()}] idle (no manifests in ${workloadsDir})\n`,
      );
      return;
    }
    for (const r of modelrunResult.reports) {
      const tail = r.error ? ` error=${r.error}` : '';
      process.stdout.write(
        `[${new Date().toISOString()}] modelrun/${r.name} on ${r.node}: ${r.action}${tail}\n`,
      );
    }
  };

  try {
    if (parsed.once) {
      await runOnePass();
      return 0;
    }
    // Loop forever. Interval is measured between pass START times so
    // slow passes don't bunch up on a naive "sleep N after finish".
    while (!stopping) {
      const start = Date.now();
      try {
        await runOnePass();
      } catch (err) {
        process.stderr.write(
          `[${new Date().toISOString()}] reconcile error: ${(err as Error).message}\n`,
        );
      }
      if (stopping) break;
      const elapsed = Date.now() - start;
      const sleepMs = Math.max(100, parsed.intervalMs - elapsed);
      // Race the sleep against a SIGTERM-triggered `wake()` so the
      // loop exits promptly even during a long --interval.
      await new Promise<void>((r) => {
        const timer = setTimeout(() => { wake = null; r(); }, sleepMs);
        wake = () => { clearTimeout(timer); wake = null; r(); };
      });
    }
    return 0;
  } finally {
    workloadLock.releaseLock(acquired);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
