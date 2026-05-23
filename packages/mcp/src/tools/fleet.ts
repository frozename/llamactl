import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toTextContent } from '@nova/mcp-shared';
import {
  defaultFleetJournalPath,
  type FleetJournalEntry,
  type FleetSnapshotEntry,
  type FleetProposalEntry,
  type FleetExecutionEntry,
} from '@llamactl/fleet-supervisor';

function readJournal(journalPath: string): FleetJournalEntry[] {
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, 'utf8');
  const entries: FleetJournalEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FleetJournalEntry);
    } catch {
      console.warn('[fleet-tools] skipping malformed journal line:', trimmed.slice(0, 80));
    }
  }
  return entries;
}

type SpawnFn = typeof spawn;

interface FleetToolDeps {
  spawn?: SpawnFn;
}

async function runProcess(
  spawnFn: SpawnFn,
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; code?: number }> {
  return new Promise((resolve) => {
    const proc = spawnFn(cmd, args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve({ ok: false, code: -1, stdout, stderr });
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true, stdout, stderr } : { ok: false, code: code ?? -1, stdout, stderr });
      }
    });

    proc.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stdout, stderr: stderr + (stderr ? '\n' : '') + err.message });
      }
    });
  });
}

export function registerFleetTools(server: McpServer, deps?: FleetToolDeps): void {
  const spawnFn = deps?.spawn ?? spawn;
  server.registerTool(
    'llamactl_fleet_snapshot',
    {
      title: 'Fleet snapshot',
      description:
        'Return the latest fleet snapshot per node from the fleet-supervisor journal. When node is set, returns at most one snapshot for that node.',
      inputSchema: {
        node: z.string().optional(),
        journalPath: z.string().optional(),
      },
    },
    async (input) => {
      const path = input.journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);
      const latest = new Map<string, FleetSnapshotEntry>();
      for (const e of entries) {
        if (e.kind !== 'fleet-snapshot') continue;
        if (input.node !== undefined && e.node !== input.node) continue;
        latest.set(e.node, e);
      }
      return toTextContent({ snapshots: [...latest.values()] });
    },
  );

  server.registerTool(
    'llamactl_fleet_pressure',
    {
      title: 'Fleet pressure state',
      description:
        'Current pressure state (NORMAL | HIGH) per node, derived from fleet-transition entries where subjectKind=node and signal=pressure. Nodes that never transitioned appear as NORMAL with lastTransitionAt: null.',
      inputSchema: {
        node: z.string().optional(),
        journalPath: z.string().optional(),
      },
    },
    async (input) => {
      const path = input.journalPath ?? defaultFleetJournalPath();
      const entries = readJournal(path);

      const knownNodes = new Set<string>();
      const latestTransition = new Map<string, { state: string; ts: string }>();

      for (const e of entries) {
        if (input.node !== undefined && e.node !== input.node) continue;
        if (e.kind === 'fleet-snapshot') {
          knownNodes.add(e.node);
        } else if (
          e.kind === 'fleet-transition' &&
          e.subjectKind === 'node' &&
          (e.signal === 'pressure' || e.signal === 'pressure-cleared')
        ) {
          const cur = latestTransition.get(e.node);
          if (!cur || e.ts > cur.ts) {
            latestTransition.set(e.node, { state: e.to, ts: e.ts });
          }
        }
      }
      for (const node of latestTransition.keys()) knownNodes.add(node);

      const nodes = [...knownNodes].map((node) => {
        const t = latestTransition.get(node);
        return {
          node,
          state: (t?.state === 'HIGH' ? 'HIGH' : 'NORMAL') as 'NORMAL' | 'HIGH',
          lastTransitionAt: t?.ts ?? null,
        };
      });

      return toTextContent({ nodes });
    },
  );

  server.registerTool(
    'llamactl_fleet_proposals',
    {
      title: 'Fleet proposals',
      description:
        'List fleet proposals from the journal. pendingOnly=true (default) returns only proposals with no matching fleet-execution entry. Ordered most-recent-first; limit applied after filtering.',
      inputSchema: {
        node: z.string().optional(),
        pendingOnly: z.boolean().optional(),
        sinceIsoTs: z.string().optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    async (input) => {
      const path = input.journalPath ?? defaultFleetJournalPath();
      const pendingOnly = input.pendingOnly ?? true;
      const limit = input.limit ?? 50;
      const entries = readJournal(path);

      const executedIds = new Set<string>();
      for (const e of entries) {
        if (e.kind === 'fleet-execution') executedIds.add(e.proposalId);
      }

      const proposals: FleetProposalEntry[] = [];
      for (const e of entries) {
        if (e.kind !== 'fleet-proposal') continue;
        if (input.node !== undefined && e.node !== input.node) continue;
        if (input.sinceIsoTs !== undefined && e.ts < input.sinceIsoTs) continue;
        if (pendingOnly && executedIds.has(e.proposalId)) continue;
        proposals.push(e);
      }

      proposals.sort((a, b) => b.ts.localeCompare(a.ts));
      const total = proposals.length;
      return toTextContent({ proposals: proposals.slice(0, limit), total });
    },
  );

  server.registerTool(
    'llamactl_fleet_executions',
    {
      title: 'Fleet executions',
      description:
        'List fleet executor actions from the journal. Ordered most-recent-first; total is post-filter pre-limit count.',
      inputSchema: {
        node: z.string().optional(),
        sinceIsoTs: z.string().optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    async (input) => {
      const path = input.journalPath ?? defaultFleetJournalPath();
      const limit = input.limit ?? 50;
      const entries = readJournal(path);

      const executions: FleetExecutionEntry[] = [];
      for (const e of entries) {
        if (e.kind !== 'fleet-execution') continue;
        if (input.node !== undefined && e.node !== input.node) continue;
        if (input.sinceIsoTs !== undefined && e.ts < input.sinceIsoTs) continue;
        executions.push(e);
      }

      executions.sort((a, b) => b.ts.localeCompare(a.ts));
      const total = executions.length;
      return toTextContent({ executions: executions.slice(0, limit), total });
    },
  );

  server.registerTool(
    'llamactl_fleet_journal_tail',
    {
      title: 'Fleet journal tail',
      description:
        'Return raw recent journal entries, optionally filtered by node and/or entry kind. Returns the last `limit` (default 20) matching entries in chronological order.',
      inputSchema: {
        node: z.string().optional(),
        kinds: z
          .array(
            z.enum([
              'fleet-snapshot',
              'fleet-heartbeat',
              'fleet-transition',
              'fleet-proposal',
              'fleet-execution',
            ]),
          )
          .optional(),
        limit: z.number().optional(),
        journalPath: z.string().optional(),
      },
    },
    async (input) => {
      const path = input.journalPath ?? defaultFleetJournalPath();
      const limit = input.limit ?? 20;
      const entries = readJournal(path);
      const kindSet = input.kinds ? new Set(input.kinds) : null;

      const filtered = entries.filter((e) => {
        if (input.node !== undefined && e.node !== input.node) return false;
        if (kindSet && !kindSet.has(e.kind)) return false;
        return true;
      });

      return toTextContent({ entries: filtered.slice(-limit) });
    },
  );

  server.registerTool(
    'llamactl_admit_measure',
    {
      title: 'Admit Measure',
      description: 'Probe peak RSS for a workload via `admit measure`.',
      inputSchema: {
        workload: z.string(),
        node: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ workload, node, timeoutMs }) => {
      const args = ['packages/cli/src/bin.ts', 'admit', 'measure', workload];
      if (node) args.push(`--node=${node}`);
      const result = await runProcess(spawnFn, 'bun', args, timeoutMs ?? 120_000);
      return toTextContent(result);
    },
  );

  server.registerTool(
    'llamactl_supervisor_execute',
    {
      title: 'Supervisor Execute',
      description: 'Execute a supervisor proposal or run auto mode (single tick via --once).',
      inputSchema: {
        proposalId: z.string().optional(),
        auto: z.boolean().optional(),
        severityThreshold: z.number().int().min(1).max(3).optional(),
        node: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
    },
    async ({ proposalId, auto, severityThreshold, node, timeoutMs }) => {
      const hasProposal = proposalId != null;
      const hasAuto = auto === true;
      if (hasProposal === hasAuto) {
        return toTextContent({ ok: false, error: 'must specify exactly one of proposalId or auto' });
      }
      const args = ['packages/cli/src/bin.ts', 'supervisor', 'tick'];
      if (node) args.push(`--node=${node}`);
      if (hasAuto) {
        args.push('--auto');
        if (severityThreshold != null) args.push(`--severity-threshold=${severityThreshold}`);
      } else {
        args.push(`--execute=${proposalId}`);
      }
      const result = await runProcess(spawnFn, 'bun', args, timeoutMs ?? 60_000);
      return toTextContent(result);
    },
  );
}
