import {
  type AggregatedSnapshot,
  getLatestPerNode,
  openAggregatorDb,
  writeSnapshot,
} from "@llamactl/fleet-supervisor";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FleetSnapshotEntry } from "../../fleet-supervisor/src/types.js";

import { persistSnapshots, type PersistSnapshotsOptions, runFleet } from "../src/commands/fleet.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const snap = (
  node: string,
  free: number,
  comp: number,
  ts = "2026-05-25T17:00:00Z",
): FleetSnapshotEntry => ({
  kind: "fleet-snapshot",
  ts,
  node,
  node_mem: {
    free_mb: free,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: comp,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [
    {
      name: "w1",
      kind: "ModelHost",
      endpoint: "http://127.0.0.1:8000",
      priority: 50,
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 0,
      p50_ms: 10,
      p95_ms: 20,
      models: [],
      reachable: true,
      consecutiveErrors: 0,
    },
  ],
});

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): true => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  let out = "";
  const orig = console.error;
  console.error = ((...args: unknown[]) => {
    out += `${args.map((x) => String(x)).join(" ")}\n`;
  }) as typeof console.error;
  return fn()
    .then((result) => ({ result, out }))
    .finally(() => {
      console.error = orig;
    });
}

describe("fleet command", () => {
  test("fleet snapshot prints local node latest snapshot JSON", async () => {
    const { result, out } = await captureStdout(() =>
      runFleet(["snapshot"], {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        readLocalSnapshot: async () => snap("local", 2048, 100),
        readPeers: () => [],
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        fetchPeerSnapshot: async () => null,
      }),
    );

    expect(result).toBe(0);
    const parsed = JSON.parse(out.trim()) as { kind: string; node: string };
    expect(parsed.kind).toBe("fleet-snapshot");
    expect(parsed.node).toBe("local");
  });

  test("fleet snapshot --all prints table with expected columns", async () => {
    const peers = [{ id: "mac-mini", endpoint: "https://mac-mini" }];
    const { result, out } = await captureStdout(() =>
      runFleet(["snapshot", "--all"], {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        readLocalSnapshot: async () => snap("local", 2048, 100),
        readPeers: () => peers,
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        fetchPeerSnapshot: async () => snap("mac-mini", 3000, 90),
      }),
    );

    expect(result).toBe(0);
    expect(out).toContain("node | free_mb | compressor_mb | workloads | pressure");
    expect(out).toContain("local | 2048 | 100 | 1 | NORMAL");
    expect(out).toContain("mac-mini | 3000 | 90 | 1 | NORMAL");
  });

  test("fleet status prints one summary line per node", async () => {
    const peers = [{ id: "mac-mini", endpoint: "https://mac-mini" }];
    const { result, out } = await captureStdout(() =>
      runFleet(["status"], {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        readLocalSnapshot: async () => snap("local", 200, 3000),
        readPeers: () => peers,
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        fetchPeerSnapshot: async () => snap("mac-mini", 3000, 90),
      }),
    );

    expect(result).toBe(0);
    expect(out).toContain("local:");
    expect(out).toContain("mac-mini:");
    const lines = out.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
  });

  test("fleet snapshot exits non-zero when local snapshot is missing", async () => {
    const { result, out } = await captureStderr(() =>
      runFleet(["snapshot"], {
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        readLocalSnapshot: async () => null,
        readPeers: () => [],
        // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
        fetchPeerSnapshot: async () => null,
      }),
    );
    expect(result).toBe(1);
    expect(out).toContain("no local fleet-snapshot entry found");
  });
});

const NOW = (): Date => new Date("2026-10-26T10:00:00.000Z");

const aggregated = (nodeId: string): AggregatedSnapshot => ({
  nodeId,
  fetchedAt: 0,
  snapshot: snap(nodeId, 2048, 100),
  stale: false,
});

describe("persistSnapshots", () => {
  test("keeps writing after a row fails and logs one timestamped line for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-persist-test-"));
    const db = openAggregatorDb(join(dir, "cluster.db"));
    try {
      const calls: string[] = [];
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
      const write: NonNullable<PersistSnapshotsOptions["write"]> = (d, node, snapshot) => {
        calls.push(node);
        if (node === "node-2") throw new Error("database is locked");
        writeSnapshot(d, node, snapshot);
      };
      const rows: AggregatedSnapshot[] = [
        aggregated("node-1"),
        aggregated("node-2"),
        aggregated("node-3"),
        { nodeId: "node-4", fetchedAt: null, snapshot: null, stale: true },
      ];
      let failed = -1;
      expect(() => {
        failed = persistSnapshots(db, rows, { write, log, now: NOW });
      }).not.toThrow();
      expect(failed).toBe(1);
      expect(calls).toEqual(["node-1", "node-2", "node-3"]);
      expect(getLatestPerNode(db).map((row) => row.node)).toEqual(["node-1", "node-3"]);
      expect(lines).toEqual([
        "2026-10-26T10:00:00.000Z fleet aggregator: snapshot write failed for node node-2: database is locked\n",
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a later cycle with the default writer persists every row after a failing cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet-persist-test-"));
    const db = openAggregatorDb(join(dir, "cluster.db"));
    try {
      const lines: string[] = [];
      const log = (line: string): void => {
        lines.push(line);
      };
      const rows = [aggregated("node-1"), aggregated("node-2"), aggregated("node-3")];
      let firstFailed = -1;
      expect(() => {
        firstFailed = persistSnapshots(db, rows, {
          write: () => {
            throw new Error("database is locked");
          },
          log,
          now: NOW,
        });
      }).not.toThrow();
      expect(firstFailed).toBe(3);
      expect(lines).toHaveLength(3);
      expect(getLatestPerNode(db)).toHaveLength(0);

      expect(persistSnapshots(db, rows, { log, now: NOW })).toBe(0);
      expect(lines).toHaveLength(3);
      expect(getLatestPerNode(db).map((row) => row.node)).toEqual(["node-1", "node-2", "node-3"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
