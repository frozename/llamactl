import { readFileSync, existsSync } from 'node:fs';
import type {
  FleetExecutionEntry,
  FleetJournalEntry,
  FleetProposalEntry,
} from './types.js';
import { actionTier } from './types.js';

export type { FleetExecutionEntry };
export { actionTier };

export interface ExecutorOptions {
  node: string;
  auto: boolean;
  severityThreshold: 1 | 2 | 3;
  /** Manual single-proposal override: execute this proposalId regardless of tier/auto. */
  executeId?: string;
  journalPath: string;
  writeJournal: (entry: FleetJournalEntry) => void;
  /** Injectable for tests; defaults to reading from journalPath. */
  readJournal?: (path: string) => FleetJournalEntry[];
  /** Disable a workload by name; returns exit code. */
  disable: (workload: string) => Promise<number>;
  /** Enable a workload by name; returns exit code. */
  enable: (workload: string) => Promise<number>;
}

function defaultReadJournal(path: string): FleetJournalEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as FleetJournalEntry]; }
      catch { return []; }
    });
}

export async function runExecutor(opts: ExecutorOptions): Promise<FleetExecutionEntry[]> {
  const read = opts.readJournal ?? defaultReadJournal;
  const entries = read(opts.journalPath);

  const proposals = entries.filter(
    (e): e is FleetProposalEntry => e.kind === 'fleet-proposal' && e.node === opts.node,
  );

  const executedIds = new Set(
    entries
      .filter((e): e is FleetExecutionEntry => e.kind === 'fleet-execution')
      .map((e) => e.proposalId),
  );

  const pending = proposals.filter((p) => !executedIds.has(p.proposalId));

  const results: FleetExecutionEntry[] = [];
  for (const proposal of pending) {
    results.push(await executeOne(proposal, opts));
  }
  return results;
}

async function executeOne(
  proposal: FleetProposalEntry,
  opts: ExecutorOptions,
): Promise<FleetExecutionEntry> {
  const ts = new Date().toISOString();
  const tier = actionTier(proposal.action);
  const isManualOverride = opts.executeId === proposal.proposalId;
  const shouldExecute = isManualOverride || (opts.auto && tier <= opts.severityThreshold);

  const base = {
    kind: 'fleet-execution' as const,
    ts,
    node: opts.node,
    proposalId: proposal.proposalId,
    action: proposal.action,
  };

  if (!shouldExecute) {
    const reason = !opts.auto
      ? '--auto not set'
      : `tier ${tier} exceeds threshold ${opts.severityThreshold}`;
    const entry: FleetExecutionEntry = { ...base, status: 'skipped', reason };
    opts.writeJournal(entry);
    return entry;
  }

  try {
    if (proposal.action.type === 'mark-degraded') {
      const entry: FleetExecutionEntry = { ...base, status: 'executed' };
      opts.writeJournal(entry);
      return entry;
    }

    if (proposal.action.type === 'evict') {
      const exitCode = await opts.disable(proposal.action.workload);
      const entry: FleetExecutionEntry = {
        ...base,
        status: exitCode === 0 ? 'executed' : 'failed',
        exitCode,
      };
      opts.writeJournal(entry);
      return entry;
    }

    if (proposal.action.type === 'restart') {
      const disableCode = await opts.disable(proposal.action.workload);
      if (disableCode !== 0) {
        const entry: FleetExecutionEntry = {
          ...base,
          status: 'failed',
          exitCode: disableCode,
          reason: 'disable phase failed',
        };
        opts.writeJournal(entry);
        return entry;
      }
      const enableCode = await opts.enable(proposal.action.workload);
      const entry: FleetExecutionEntry = {
        ...base,
        status: enableCode === 0 ? 'executed' : 'failed',
        exitCode: enableCode,
      };
      opts.writeJournal(entry);
      return entry;
    }
  } catch (err) {
    const entry: FleetExecutionEntry = {
      ...base,
      status: 'failed',
      reason: (err as Error).message,
    };
    opts.writeJournal(entry);
    return entry;
  }

  // TypeScript exhaustive guard — unreachable with current action union
  const entry: FleetExecutionEntry = { ...base, status: 'skipped', reason: 'unknown action type' };
  opts.writeJournal(entry);
  return entry;
}
