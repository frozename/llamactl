import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_PRESSURE_THRESHOLDS,
  FleetAggregator,
  createPeerFetch,
  defaultAggregatorDbPath,
  defaultFleetJournalPath,
  openAggregatorDb,
  readLatestFleetSnapshotFromJournal,
  writeSnapshot,
  type AggregatorPeer,
  type FleetSnapshotEntry,
} from "../../../fleet-supervisor/src/index.js";
import { listPeers, type PeerNode } from "../../../remote/src/config/peers.js";

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

  const peers = deps.readPeers ? deps.readPeers() : listPeers();
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
  console.log("node | free_mb | compressor_mb | workloads | pressure");
  for (const row of rows) {
    console.log(
      `${row.node} | ${row.free_mb} | ${row.compressor_mb} | ${row.workloads} | ${row.pressure}`,
    );
  }
}

function printStatusRows(rows: SnapshotRow[]): void {
  for (const row of rows) {
    console.log(
      `${row.node}: free_mb=${row.free_mb} compressor_mb=${row.compressor_mb} workloads=${row.workloads} pressure=${row.pressure}`,
    );
  }
}

function readJournalEntries(
  path: string,
): Array<{ ts?: string; kind?: string; node?: string; raw: string }> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const entries: Array<{ ts?: string; kind?: string; node?: string; raw: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ts?: string; kind?: string; node?: string };
      entries.push({ ts: parsed.ts, kind: parsed.kind, node: parsed.node, raw: trimmed });
    } catch {
      entries.push({ raw: trimmed });
    }
  }
  return entries;
}

export async function runFleet(args: string[], deps: FleetDeps = {}): Promise<number> {
  const readLocalSnapshot =
    deps.readLocalSnapshot ??
    (async () => readLatestFleetSnapshotFromJournal(defaultFleetJournalPath()));
  const readPeers = deps.readPeers ?? listPeers;
  const fetchPeerSnapshot =
    deps.fetchPeerSnapshot ??
    (async (peer: PeerNode) => {
      const fetcher = createPeerFetch(peer as AggregatorPeer);
      return fetcher();
    });
  const fullDeps: Required<FleetDeps> = {
    readLocalSnapshot,
    readPeers,
    fetchPeerSnapshot,
  };

  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return sub ? 0 : 1;
  }

  if (sub === "snapshot") {
    const all = rest.includes("--all");
    if (!all) {
      const local = await fullDeps.readLocalSnapshot();
      if (!local) {
        console.error("fleet snapshot: no local fleet-snapshot entry found");
        return 1;
      }
      console.log(JSON.stringify(local));
      return 0;
    }

    const rows = await buildRows(fullDeps);
    printRowsTable(rows);
    return 0;
  }

  if (sub === "status") {
    const rows = await buildRows(fullDeps);
    printStatusRows(rows);
    return 0;
  }

  if (sub === "journal-tail") {
    const journalPath = parseFlagValue(rest, "--journal") ?? defaultFleetJournalPath();
    const typeFilter = parseFlagValue(rest, "--type");
    const limitRaw = parseFlagValue(rest, "--limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const entries = readJournalEntries(journalPath)
      .filter((entry) => (typeFilter ? entry.kind === typeFilter : true))
      .slice(-Math.max(1, limit));
    for (const entry of entries) {
      const prefix = `${entry.ts ?? "-"} ${entry.kind ?? "unknown"} ${entry.node ?? "-"}`;
      console.log(`${prefix} ${entry.raw}`);
    }
    return 0;
  }

  if (sub === "aggregator" && rest[0] === "serve") {
    const once = rest.includes("--once");
    const dbPath = parseFlagValue(rest, "--db") ?? defaultAggregatorDbPath();
    const peers = readPeers();
    const db = openAggregatorDb(dbPath);
    const aggregator = new FleetAggregator({
      peers,
      fetchSnapshot: async (peer) => {
        const fetcher = createPeerFetch(peer);
        return fetcher();
      },
    });

    const persist = () => {
      for (const row of aggregator.getAll()) {
        if (row.snapshot === null) continue;
        writeSnapshot(db, row.nodeId, row.snapshot);
      }
    };

    if (once) {
      await aggregator.pollNow();
      persist();
      db.close();
      return 0;
    }

    const running = aggregator.start();
    const interval = setInterval(() => persist(), 30_000);
    const stop = () => {
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

  console.error(`Unknown fleet subcommand: ${sub}`);
  console.error(USAGE);
  return 1;
}
