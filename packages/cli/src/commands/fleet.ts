import type { Database } from "bun:sqlite";

import { listPeers, type PeerNode } from "@llamactl/core/config/peers";
import {
  type AggregatedSnapshot,
  createPeerFetch,
  DEFAULT_PRESSURE_THRESHOLDS,
  defaultAggregatorDbPath,
  defaultFleetJournalPath,
  FleetAggregator,
  type FleetSnapshotEntry,
  openAggregatorDb,
  readLatestFleetSnapshotFromJournal,
  writeSnapshot,
} from "@llamactl/fleet-supervisor";

import { existsSync, readFileSync } from "../safe-fs.js";
import { defaultVersionDeps, resolveVersionInfo } from "./version.js";

const USAGE = `Usage: llamactl fleet <subcommand>

Subcommands:
  snapshot [--all]
  status
  journal-tail [--journal <path>] [--type <kind>] [--limit <n>]
  aggregator serve [--once] [--db <path>]
`;

interface FleetDeps {
  readLocalSnapshot?: () => Promise<FleetSnapshotEntry | null>;
  readPeers?: () => PeerNode[];
  fetchPeerSnapshot?: (peer: PeerNode) => Promise<FleetSnapshotEntry | null>;
  readCommit?: () => string | null;
}

interface SnapshotRow {
  node: string;
  free_mb: number;
  compressor_mb: number;
  workloads: number;
  pressure: "NORMAL" | "HIGH";
}

function toPressure(s: FleetSnapshotEntry): "NORMAL" | "HIGH" {
  if (s.node_mem.free_mb < DEFAULT_PRESSURE_THRESHOLDS.headroomMinMb) return "HIGH";
  if (s.node_mem.compressor_mb > DEFAULT_PRESSURE_THRESHOLDS.compressorWarnMb) return "HIGH";
  return "NORMAL";
}

function toRow(node: string, s: FleetSnapshotEntry): SnapshotRow {
  return {
    node,
    free_mb: s.node_mem.free_mb,
    compressor_mb: s.node_mem.compressor_mb,
    workloads: s.workloads.length,
    pressure: toPressure(s),
  };
}

function parseFlagValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((x) => x === name);
  if (i === -1) return undefined;
  return args[i + 1];
}

async function buildRows(deps: Required<FleetDeps>): Promise<SnapshotRow[]> {
  const rows: SnapshotRow[] = [];
  const local = await deps.readLocalSnapshot();
  if (local) rows.push(toRow(local.node, local));

  const peers = deps.readPeers();
  await Promise.all(
    peers.map(async (peer) => {
      const s = await deps.fetchPeerSnapshot(peer);
      if (s) rows.push(toRow(peer.id, s));
    }),
  );
  rows.sort((a, b) => a.node.localeCompare(b.node));
  return rows;
}

function printRowsTable(rows: SnapshotRow[]): void {
  process.stdout.write("node | free_mb | compressor_mb | workloads | pressure\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.node} | ${String(row.free_mb)} | ${String(row.compressor_mb)} | ${String(row.workloads)} | ${row.pressure}\n`,
    );
  }
}

function printStatusRows(rows: SnapshotRow[]): void {
  for (const row of rows) {
    process.stdout.write(
      `${row.node}: free_mb=${String(row.free_mb)} compressor_mb=${String(row.compressor_mb)} workloads=${String(row.workloads)} pressure=${row.pressure}\n`,
    );
  }
}

function readJournalEntries(
  path: string,
): { ts?: string; kind?: string; node?: string; raw: string }[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: { ts?: string; kind?: string; node?: string; raw: string }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ts?: string; kind?: string; node?: string };
      entries.push({
        ...(parsed.ts !== undefined ? { ts: parsed.ts } : {}),
        ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
        ...(parsed.node !== undefined ? { node: parsed.node } : {}),
        raw: trimmed,
      });
    } catch {
      entries.push({ raw: trimmed });
    }
  }
  return entries;
}

function resolveFleetDeps(deps: FleetDeps): Required<FleetDeps> {
  const readLocalSnapshot =
    deps.readLocalSnapshot ??
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    (async (): Promise<FleetSnapshotEntry | null> =>
      readLatestFleetSnapshotFromJournal(defaultFleetJournalPath()));
  const readPeers = deps.readPeers ?? listPeers;
  const fetchPeerSnapshot =
    deps.fetchPeerSnapshot ??
    (async (peer: PeerNode): Promise<FleetSnapshotEntry | null> => {
      const fetcher = createPeerFetch(peer);
      return await fetcher();
    });
  // #290: the commit the running code was loaded from; null (printed as unknown) without git.
  const readCommit =
    deps.readCommit ?? ((): string | null => resolveVersionInfo(defaultVersionDeps()).commit);
  return { readLocalSnapshot, readPeers, fetchPeerSnapshot, readCommit };
}

async function runFleetSnapshot(rest: string[], fullDeps: Required<FleetDeps>): Promise<number> {
  const all = rest.includes("--all");
  if (!all) {
    const local = await fullDeps.readLocalSnapshot();
    if (!local) {
      console.error("fleet snapshot: no local fleet-snapshot entry found");
      return 1;
    }
    process.stdout.write(`${JSON.stringify(local)}\n`);
    return 0;
  }

  const rows = await buildRows(fullDeps);
  printRowsTable(rows);
  return 0;
}

function runFleetJournalTail(rest: string[]): number {
  const journalPath = parseFlagValue(rest, "--journal") ?? defaultFleetJournalPath();
  const typeFilter = parseFlagValue(rest, "--type");
  const limitRaw = parseFlagValue(rest, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
  const entries = readJournalEntries(journalPath)
    .filter((entry) => (typeFilter ? entry.kind === typeFilter : true))
    .slice(-Math.max(1, limit));
  for (const entry of entries) {
    const prefix = `${entry.ts ?? "-"} ${entry.kind ?? "unknown"} ${entry.node ?? "-"}`;
    process.stdout.write(`${prefix} ${entry.raw}\n`);
  }
  return 0;
}

export interface PersistSnapshotsOptions {
  write?: (db: Database, node: string, snapshot: FleetSnapshotEntry) => void;
  log?: (line: string) => void;
  now?: () => Date;
}

// #290: write each aggregated snapshot on its own, so one failed row (for example
// SQLITE_BUSY while another process reads cluster.db) does not drop the rest of the cycle.
export function persistSnapshots(
  db: Database,
  rows: readonly AggregatedSnapshot[],
  opts: PersistSnapshotsOptions = {},
): number {
  const write = opts.write ?? writeSnapshot;
  const log =
    opts.log ??
    ((line: string): void => {
      process.stderr.write(line);
    });
  const now = opts.now ?? ((): Date => new Date());
  let failed = 0;
  for (const row of rows) {
    if (row.snapshot === null) continue;
    try {
      write(db, row.nodeId, row.snapshot);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log(
        `${now().toISOString()} fleet aggregator: snapshot write failed for node ${row.nodeId}: ${message}\n`,
      );
    }
  }
  return failed;
}

export interface StaleTransition {
  key: string;
  line: string | null;
}

// #290: report the set of stale peers only when it changes, so the stderr log gets one
// line per change instead of one per 30 s cycle. Errors are logged as the aggregator stored them.
export function staleTransition(
  prevKey: string | null,
  rows: readonly AggregatedSnapshot[],
  now: Date,
): StaleTransition {
  const stale = rows
    .filter((row) => row.stale)
    .map((row) => ({ nodeId: row.nodeId, reason: row.error ?? "stale" }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const key = JSON.stringify(stale.map((entry) => [entry.nodeId, entry.reason]));
  if (key === prevKey) return { key, line: null };
  const detail =
    stale.length === 0
      ? `all ${String(rows.length)} peers fresh`
      : `stale peers: ${stale.map((entry) => `${entry.nodeId} (${entry.reason})`).join(", ")}`;
  return { key, line: `${now.toISOString()} fleet aggregator: ${detail}\n` };
}

// #290: the start line names the running commit, so a crash loop can be tied to a deploy.
// A null commit (no checkout, or git missing from PATH under launchd) prints commit=unknown.
export function aggregatorStartLine(
  now: Date,
  commit: string | null,
  dbPath: string,
  peerCount: number,
): string {
  return `${now.toISOString()} fleet aggregator: serving db=${dbPath} peers=${String(peerCount)} commit=${commit ?? "unknown"}\n`;
}

async function runFleetAggregatorServe(
  rest: string[],
  readPeers: () => PeerNode[],
  readCommit: () => string | null,
): Promise<number> {
  const once = rest.includes("--once");
  const dbPath = parseFlagValue(rest, "--db") ?? defaultAggregatorDbPath();
  const peers = readPeers();
  const log = (line: string): void => {
    process.stderr.write(line);
  };
  // #290: one timestamped line per start, so a crash loop shows up as repeated start times.
  log(aggregatorStartLine(new Date(), readCommit(), dbPath, peers.length));
  const db = openAggregatorDb(dbPath);
  const aggregator = new FleetAggregator({
    peers,
    fetchSnapshot: async (peer): Promise<FleetSnapshotEntry | null> => {
      const fetcher = createPeerFetch(peer);
      return await fetcher();
    },
  });

  let staleKey: string | null = null;
  const persist = (): void => {
    const rows = aggregator.getAll();
    persistSnapshots(db, rows);
    const transition = staleTransition(staleKey, rows, new Date());
    staleKey = transition.key;
    if (transition.line !== null) log(transition.line);
  };

  if (once) {
    await aggregator.pollNow();
    persist();
    db.close();
    return 0;
  }

  const running = aggregator.start();
  const interval = setInterval(() => {
    persist();
  }, 30_000);
  const stop = (): never => {
    clearInterval(interval);
    running.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return await new Promise<number>(() => {
    // long-running
  });
}

export async function runFleet(args: string[], deps: FleetDeps = {}): Promise<number> {
  const fullDeps = resolveFleetDeps(deps);

  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 1;
  }

  if (sub === "snapshot") {
    return await runFleetSnapshot(rest, fullDeps);
  }

  if (sub === "status") {
    const rows = await buildRows(fullDeps);
    printStatusRows(rows);
    return 0;
  }

  if (sub === "journal-tail") {
    return runFleetJournalTail(rest);
  }

  if (sub === "aggregator" && rest[0] === "serve") {
    return await runFleetAggregatorServe(rest, fullDeps.readPeers, fullDeps.readCommit);
  }

  console.error(`Unknown fleet subcommand: ${sub}`);
  console.error(USAGE);
  return 1;
}
