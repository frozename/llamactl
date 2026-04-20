import {
  createDefaultToolClient,
  defaultHealerJournalPath,
  startHealerLoop,
  stateTransitions,
  type DefaultToolClientHandle,
  type HealerLoopOptions,
  type JournalEntry,
  type ProbeReport,
} from '@llamactl/agents';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `llamactl heal — observe + journal fleet health

USAGE:
  llamactl heal [--interval=<seconds>] [--once] [--timeout=<ms>]
                [--journal=<path>] [--kubeconfig=<path>]
                [--providers-file=<path>] [--quiet]
                [--use-facade] [--no-use-facade]

The loop probes every gateway and sirius-provider baseUrl on an
interval. Every tick is journaled; every observed state change
(healthy↔unhealthy) gets a prominent 'transition' entry. Runs until
SIGINT / SIGTERM (or returns after one tick with --once).

Primary health signal is the in-proc nova.ops.healthcheck facade
(default). When that call rejects or returns isError, the loop logs
one stderr line and falls back to a raw HTTP probe for that tick.
Pass --no-use-facade to force the raw path (useful when nova-mcp
can't boot in the current environment).

Autonomous remediation (auto-promote, flip to private-first, etc.)
stays out of this command until the mutation tool surface carries
the primitives. The journal is the primary observation channel;
--quiet suppresses per-tick stderr chatter without affecting disk.

FLAGS:
  --interval=<s>         Seconds between ticks. Default 30. Clamped >= 1.
  --once                 One tick then exit.
  --timeout=<ms>         Per-probe timeout. Default 1500.
  --journal=<path>       Override the journal file. Default:
                         \$LLAMACTL_HEALER_JOURNAL or
                         ~/.llamactl/healer/journal.jsonl.
  --kubeconfig=<path>    Override kubeconfig (default ~/.llamactl/config).
  --providers-file=<path> Override sirius-providers.yaml.
  --quiet                Suppress per-tick stderr summary.
  --use-facade           Use nova.ops.healthcheck as the primary
                         probe (default).
  --no-use-facade        Skip the facade and probe HTTP directly.

EXAMPLES:
  llamactl heal --once
  llamactl heal --interval=15 --quiet
  llamactl heal --journal=/tmp/heal.jsonl --once
  llamactl heal --once --no-use-facade
`;

interface HealFlags {
  intervalSec: number;
  once: boolean;
  timeoutMs: number;
  journalPath: string;
  kubeconfigPath: string;
  providersPath: string;
  quiet: boolean;
  useFacade: boolean;
}

function parseFlags(argv: string[]): HealFlags | null {
  const base = process.env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  const flags: HealFlags = {
    intervalSec: 30,
    once: false,
    timeoutMs: 1500,
    journalPath: defaultHealerJournalPath(),
    kubeconfigPath: process.env.LLAMACTL_CONFIG?.trim() || join(base, 'config'),
    providersPath: process.env.LLAMACTL_PROVIDERS_FILE?.trim() || join(base, 'sirius-providers.yaml'),
    quiet: false,
    useFacade: true,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return null;
    }
    if (arg === '--once') {
      flags.once = true;
      continue;
    }
    if (arg === '--quiet') {
      flags.quiet = true;
      continue;
    }
    if (arg === '--use-facade') {
      flags.useFacade = true;
      continue;
    }
    if (arg === '--no-use-facade') {
      flags.useFacade = false;
      continue;
    }
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      process.stderr.write(`unknown arg: ${arg}\n\n${USAGE}`);
      return null;
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'interval':
        flags.intervalSec = Math.max(1, Number.parseInt(value, 10) || 30);
        break;
      case 'timeout':
        flags.timeoutMs = Math.max(100, Number.parseInt(value, 10) || 1500);
        break;
      case 'journal':
        flags.journalPath = value;
        break;
      case 'kubeconfig':
        flags.kubeconfigPath = value;
        break;
      case 'providers-file':
        flags.providersPath = value;
        break;
      default:
        process.stderr.write(`unknown flag: --${key}\n\n${USAGE}`);
        return null;
    }
  }
  return flags;
}

export async function runHeal(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags) return 0;

  // Boot the in-proc MCP client once (not per-tick) when facade mode
  // is enabled. `createDefaultToolClient` mounts @llamactl/mcp +
  // @nova/mcp in-process via InMemoryTransport and routes by
  // tool-name prefix — exactly the harness runbooks use.
  let toolHandle: DefaultToolClientHandle | null = null;
  if (flags.useFacade) {
    try {
      toolHandle = await createDefaultToolClient();
    } catch (err) {
      process.stderr.write(
        `healer: failed to boot in-proc MCP client (${(err as Error).message}); ` +
          'continuing with direct probe\n',
      );
      toolHandle = null;
    }
  }

  const loopOpts: HealerLoopOptions = {
    kubeconfigPath: flags.kubeconfigPath,
    siriusProvidersPath: flags.providersPath,
    intervalMs: flags.intervalSec * 1000,
    once: flags.once,
    timeoutMs: flags.timeoutMs,
    journalPath: flags.journalPath,
    onTick: (report: ProbeReport, transitions: ReturnType<typeof stateTransitions>): void => {
      if (flags.quiet) return;
      const summary = `healer: ${report.probes.length} probes, ${report.unhealthy} unhealthy`;
      process.stderr.write(`${report.ts}  ${summary}\n`);
      for (const t of transitions) {
        process.stderr.write(`  ${t.kind}/${t.name}: ${t.from} → ${t.to}\n`);
      }
    },
    ...(toolHandle ? { toolClient: toolHandle.client } : {}),
  };

  const handle = startHealerLoop(loopOpts);

  // Graceful shutdown on SIGINT / SIGTERM — don't tear down mid-tick.
  const stopSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const onSignal = (): void => {
    handle.stop();
    process.stderr.write('healer: stop requested, finishing current tick…\n');
  };
  for (const sig of stopSignals) process.on(sig, onSignal);

  try {
    await handle.done;
  } finally {
    for (const sig of stopSignals) process.off(sig, onSignal);
    if (toolHandle) {
      try {
        await toolHandle.dispose();
      } catch (err) {
        process.stderr.write(`healer: dispose failed: ${(err as Error).message}\n`);
      }
    }
  }
  return 0;
}

// Re-export so tests can assert entry shape without touching the loop.
export type { JournalEntry };
