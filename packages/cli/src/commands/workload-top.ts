// frozename/llamactl#249: `llamactl workload top` — one throughput row per
// ModelHost across the local journal and peer snapshots. Reads only journaled
// or peer-published data through workload-snapshots.ts; it never wakes a model
// or calls an engine. Deliberately free of workload-status.ts imports so the
// two commands share snapshot plumbing without an import cycle.

import type { FleetSnapshotEntry, WorkloadThroughputStats } from "@llamactl/fleet-supervisor";

import {
  findThroughputMatch,
  gatherSnapshots,
  latestSnapshotByNode,
  NO_SNAPSHOT_REASON,
  resolveWorkloadStatusDeps,
  type WorkloadDeps,
} from "./workload-snapshots.js";

const TOP_USAGE = "Usage: llamactl workload top [--watch[=<seconds>]] [--json]\n";
const DEFAULT_WATCH_SECONDS = 5;
const CLEAR_SCREEN = "\x1b[H\x1b[2J";

const COLUMNS = [
  "WORKLOAD",
  "NODE",
  "DECODE",
  "PREFILL",
  "BUSY",
  "DEFERRED",
  "RESETS",
  "SAMPLED",
] as const;

interface TopRow {
  workload: string;
  node: string;
  sampledAt: string | null;
  decodeTokPerSec: number | null;
  prefillTokPerSec: number | null;
  meanBusySlots: number | null;
  deferredShare: number | null;
  counterResets: number | null;
}

function unavailableRow(name: string, node: string): TopRow {
  return {
    workload: name,
    node,
    sampledAt: null,
    decodeTokPerSec: null,
    prefillTokPerSec: null,
    meanBusySlots: null,
    deferredShare: null,
    counterResets: null,
  };
}

function metricRow(
  name: string,
  node: string,
  sampledAt: string,
  stats: WorkloadThroughputStats | null | undefined,
): TopRow {
  return {
    workload: name,
    node,
    sampledAt,
    decodeTokPerSec: stats?.decodeTokPerSec?.median ?? null,
    prefillTokPerSec: stats?.prefillTokPerSec?.median ?? null,
    meanBusySlots: stats?.meanBusySlots ?? null,
    deferredShare: stats?.deferredShare ?? null,
    counterResets: stats === null || stats === undefined ? null : stats.counterResets,
  };
}

interface ModelHostIndex {
  names: Set<string>;
  modelHostNodes: Map<string, string[]>;
}

function indexModelHosts(snapshots: readonly FleetSnapshotEntry[]): ModelHostIndex {
  const modelHostNodes = new Map<string, string[]>();
  const names = new Set<string>();
  for (const snapshot of latestSnapshotByNode(snapshots).values()) {
    for (const workload of snapshot.workloads) {
      if (workload.kind !== "ModelHost") continue;
      names.add(workload.name);
      const nodes = modelHostNodes.get(workload.name);
      if (nodes === undefined) modelHostNodes.set(workload.name, [snapshot.node]);
      else nodes.push(snapshot.node);
    }
    for (const entry of snapshot.engineThroughput ?? []) {
      names.add(entry.workload);
    }
  }
  return { names, modelHostNodes };
}

function buildRows(snapshots: readonly FleetSnapshotEntry[]): TopRow[] {
  const { names, modelHostNodes } = indexModelHosts(snapshots);
  const rows: TopRow[] = [];
  for (const name of [...names].sort()) {
    const match = findThroughputMatch(snapshots, name);
    if (match !== null) {
      rows.push(metricRow(name, match.node, match.entry.sampledAt, match.entry.stats));
      continue;
    }
    const nodes = modelHostNodes.get(name)?.slice().sort();
    const first = nodes?.[0];
    if (first === undefined) continue;
    rows.push(unavailableRow(name, first));
  }
  return rows;
}

function formatCells(row: TopRow): string[] {
  return [
    row.workload,
    row.node,
    row.decodeTokPerSec === null ? "unavailable" : row.decodeTokPerSec.toFixed(1),
    row.prefillTokPerSec === null ? "unavailable" : row.prefillTokPerSec.toFixed(1),
    row.meanBusySlots === null ? "unavailable" : row.meanBusySlots.toFixed(2),
    row.deferredShare === null ? "unavailable" : `${(row.deferredShare * 100).toFixed(1)}%`,
    row.counterResets === null ? "unavailable" : String(row.counterResets),
    row.sampledAt ?? "unavailable",
  ];
}

function frameHeader(nowIso: string, nodeCount: number): string {
  return `llamactl workload top  ${nowIso}  (${String(nodeCount)} node snapshot(s))`;
}

function renderTable(rows: TopRow[]): string {
  const cells = rows.map(formatCells);
  const widths = COLUMNS.map((header, index) =>
    Math.max(header.length, ...cells.map((row) => (row[index] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, index) => value.padEnd((widths[index] ?? value.length) + 1))
      .join("")
      .trimEnd();
  const lines = [line(COLUMNS), ...cells.map(line)];
  return `${lines.join("\n")}\n`;
}

interface TopArgs {
  json: boolean;
  watchSeconds: number | null;
}

function parseWatchSeconds(raw: string): number | null {
  const seconds = Number(raw);
  if (raw === "" || !Number.isFinite(seconds) || seconds <= 0) {
    process.stderr.write(`workload top: invalid --watch value ${raw}\n`);
    return null;
  }
  return seconds;
}

// Applies one argument to `state`; returns false (after reporting) on a bad one.
function applyTopArg(arg: string, state: TopArgs): boolean {
  if (arg === "--json") {
    state.json = true;
    return true;
  }
  if (arg === "--watch") {
    state.watchSeconds ??= DEFAULT_WATCH_SECONDS;
    return true;
  }
  if (arg.startsWith("--watch=")) {
    const seconds = parseWatchSeconds(arg.slice("--watch=".length));
    if (seconds === null) return false;
    state.watchSeconds = seconds;
    return true;
  }
  const message = arg.startsWith("-")
    ? `workload top: unknown flag ${arg}`
    : `workload top: unexpected argument ${arg}`;
  process.stderr.write(`${message}\n${TOP_USAGE}`);
  return false;
}

function parseTopArgs(rest: string[]): TopArgs | null {
  const state: TopArgs = { json: false, watchSeconds: null };
  for (const arg of rest) {
    if (!applyTopArg(arg, state)) return null;
  }
  if (state.watchSeconds !== null && state.json) {
    process.stderr.write("workload top: --watch and --json are mutually exclusive\n");
    return null;
  }
  return state;
}

export async function runTop(rest: string[], deps: WorkloadDeps): Promise<number> {
  const parsed = parseTopArgs(rest);
  if (parsed === null) return 1;
  const { json, watchSeconds } = parsed;
  const watchMs = watchSeconds === null ? null : Math.round(watchSeconds * 1000);
  const resolved = resolveWorkloadStatusDeps(deps);

  const renderFrame = async (): Promise<number | null> => {
    const snapshots = await gatherSnapshots(resolved);
    const header = frameHeader(resolved.now().toISOString(), latestSnapshotByNode(snapshots).size);
    if (snapshots.length === 0) {
      if (watchMs === null) {
        process.stderr.write(`workload top: ${NO_SNAPSHOT_REASON}\n`);
        return 1;
      }
      if (resolved.isTTY) process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(`${header}\n${NO_SNAPSHOT_REASON}\n`);
      return null;
    }
    if (json) {
      const rows = buildRows(snapshots);
      process.stdout.write(
        `${JSON.stringify({ snapshots: latestSnapshotByNode(snapshots).size, rows }, null, 2)}\n`,
      );
      return null;
    }
    if (watchMs !== null && resolved.isTTY) process.stdout.write(CLEAR_SCREEN);
    const rows = buildRows(snapshots);
    if (rows.length === 0) {
      process.stdout.write(`${header}\nno ModelHost workloads in the fleet snapshot\n`);
      return null;
    }
    process.stdout.write(`${header}\n${renderTable(rows)}`);
    return null;
  };

  if (watchMs === null) {
    return (await renderFrame()) ?? 0;
  }

  const loop = async (signal: AbortSignal): Promise<number> => {
    // A function call, not a bare property read, so the check after sleep() is
    // not narrowed away: the signal can abort while sleep() is pending.
    const aborted = (): boolean => signal.aborted;
    for (;;) {
      await renderFrame();
      if (aborted()) break;
      await resolved.sleep(watchMs, signal);
      if (aborted()) break;
    }
    return 0;
  };

  const external = resolved.signal;
  if (external !== undefined) return await loop(external);
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  try {
    return await loop(controller.signal);
  } finally {
    process.off("SIGINT", onSigint);
  }
}
