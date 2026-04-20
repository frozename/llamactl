import {
  appendHealerJournal,
  createDefaultToolClient,
  defaultHealerJournalPath,
  executePlan,
  startHealerLoop,
  stateTransitions,
  type DefaultToolClientHandle,
  type HealerLoopOptions,
  type JournalEntry,
  type JournalProposalEntry,
  type ProbeReport,
  type Tier,
} from '@llamactl/agents';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `llamactl heal — observe + journal fleet health + propose/auto-remediate

USAGE:
  llamactl heal [--interval=<seconds>] [--once] [--timeout=<ms>]
                [--journal=<path>] [--kubeconfig=<path>]
                [--providers-file=<path>] [--quiet]
                [--use-facade] [--no-use-facade]
                [--auto] [--severity-threshold=<1|2|3>]
                [--execute=<proposal-id>]

The loop probes every gateway and sirius-provider baseUrl on an
interval. Every tick is journaled; every observed state change
(healthy↔unhealthy) gets a prominent 'transition' entry. On every
healthy→unhealthy flip the loop asks nova.operator.plan for a
remediation plan and journals it as a proposal; with --auto, plans
that pass the severity gate execute immediately. Runs until SIGINT /
SIGTERM (or returns after one tick with --once).

Primary health signal is the in-proc nova.ops.healthcheck facade
(default). When that call rejects or returns isError, the loop logs
one stderr line and falls back to a raw HTTP probe for that tick.
Pass --no-use-facade to force the raw path (useful when nova-mcp
can't boot in the current environment).

The journal is the primary observation channel; --quiet suppresses
per-tick stderr chatter without affecting disk.

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
  --auto                 Execute plans that pass the severity gate
                         immediately; default is propose-only.
  --severity-threshold=<1|2|3>
                         Max tier allowed for auto-execution. 1=read,
                         2=mutation-dry-run-safe (default),
                         3=destructive (never auto-executed regardless).
  --execute=<proposal-id>
                         One-shot: load the named proposal from the
                         journal, execute its plan, journal an
                         'executed' entry, exit. Does not start a loop.

EXAMPLES:
  llamactl heal --once
  llamactl heal --interval=15 --quiet
  llamactl heal --journal=/tmp/heal.jsonl --once
  llamactl heal --once --no-use-facade
  llamactl heal --auto --severity-threshold=2
  llamactl heal --execute=1a2b3c4d5e6f
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
  auto: boolean;
  severityThreshold: Tier;
  executeProposalId: string | null;
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
    auto: false,
    severityThreshold: 2,
    executeProposalId: null,
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
    if (arg === '--auto') {
      flags.auto = true;
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
      case 'severity-threshold': {
        const parsed = Number.parseInt(value, 10);
        if (parsed !== 1 && parsed !== 2 && parsed !== 3) {
          process.stderr.write(`invalid --severity-threshold: ${value} (must be 1, 2, or 3)\n\n${USAGE}`);
          return null;
        }
        flags.severityThreshold = parsed as Tier;
        break;
      }
      case 'execute':
        flags.executeProposalId = value;
        break;
      default:
        process.stderr.write(`unknown flag: --${key}\n\n${USAGE}`);
        return null;
    }
  }
  return flags;
}

/**
 * Scan the JSONL journal for the most recent `proposal` entry whose
 * `proposalId` matches the supplied id. Returns null when the id is
 * absent from the journal.
 */
function readProposalFromJournal(
  journalPath: string,
  proposalId: string,
): JournalProposalEntry | null {
  let raw: string;
  try {
    raw = readFileSync(journalPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `heal --execute: could not read journal ${journalPath}: ${(err as Error).message}\n`,
    );
    return null;
  }
  let match: JournalProposalEntry | null = null;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      continue;
    }
    if (entry.kind === 'proposal' && entry.proposalId === proposalId) {
      match = entry;
    }
  }
  return match;
}

async function runExecuteProposal(flags: HealFlags): Promise<number> {
  const id = flags.executeProposalId!;
  const entry = readProposalFromJournal(flags.journalPath, id);
  if (!entry) {
    process.stderr.write(
      `heal --execute: no proposal with id ${id} found in ${flags.journalPath}\n`,
    );
    return 1;
  }

  let toolHandle: DefaultToolClientHandle;
  try {
    toolHandle = await createDefaultToolClient();
  } catch (err) {
    process.stderr.write(
      `heal --execute: failed to boot in-proc MCP client: ${(err as Error).message}\n`,
    );
    return 1;
  }

  try {
    const result = await executePlan(entry.plan, {
      toolClient: toolHandle.client,
      dryRun: false,
    });
    const executed = {
      kind: 'executed' as const,
      ts: new Date().toISOString(),
      proposalId: id,
      steps: result.steps,
      ...(result.stoppedAt !== undefined ? { stoppedAt: result.stoppedAt } : {}),
    };
    appendHealerJournal(executed, flags.journalPath);
    process.stdout.write(`${JSON.stringify(executed, null, 2)}\n`);
    return result.stoppedAt === undefined ? 0 : 1;
  } finally {
    try {
      await toolHandle.dispose();
    } catch (err) {
      process.stderr.write(
        `heal --execute: dispose failed: ${(err as Error).message}\n`,
      );
    }
  }
}

export async function runHeal(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (!flags) return 0;

  // --execute <proposal-id>: out-of-band apply of a previously-
  // journaled proposal. Boots the same in-proc tool client the loop
  // would use, runs the plan through executePlan, writes one
  // 'executed' journal entry, and exits. Never starts the tick loop.
  if (flags.executeProposalId) {
    return await runExecuteProposal(flags);
  }

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
    mode: flags.auto ? 'auto' : 'propose',
    severityThreshold: flags.severityThreshold,
    onTick: (report: ProbeReport, transitions: ReturnType<typeof stateTransitions>): void => {
      if (flags.quiet) return;
      const summary = `healer: ${report.probes.length} probes, ${report.unhealthy} unhealthy`;
      process.stderr.write(`${report.ts}  ${summary}\n`);
      for (const t of transitions) {
        process.stderr.write(`  ${t.kind}/${t.name}: ${t.from} → ${t.to}\n`);
      }
    },
    onProposal: (entry: JournalProposalEntry): void => {
      if (flags.quiet) return;
      process.stderr.write(
        `healer: proposal ${entry.proposalId} — ${entry.plan.steps.length} step(s) for ${entry.transition.resourceKind}/${entry.transition.name}\n`,
      );
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
