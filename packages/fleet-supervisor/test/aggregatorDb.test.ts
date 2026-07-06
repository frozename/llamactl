import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FleetSnapshotEntry } from "../src/types.js";

import {
  getHistoricalForNode,
  getLatestPerNode,
  openAggregatorDb,
  SNAPSHOT_RETENTION_PER_NODE,
  writeSnapshot,
} from "../src/aggregator-db.js";
import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

const snapshot = (node: string, ts: string, freeMb: number): FleetSnapshotEntry => ({
  kind: "fleet-snapshot",
  ts,
  node,
  node_mem: {
    free_mb: freeMb,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 100,
    swap_in: 0,
    swap_out: 0,
  },
  workloads: [],
});

describe("aggregator db", () => {
  test("writeSnapshot then getLatestPerNode returns the inserted row", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(
        db,
        "mac-mini",
        snapshot("mac-mini", "2026-05-25T17:00:00Z", 2048),
        "2026-05-25T17:00:00Z",
      );
      const rows = getLatestPerNode(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.node).toBe("mac-mini");
      expect(rows[0]?.receivedAt).toBe("2026-05-25T17:00:00Z");
      expect(rows[0]?.snapshot.node_mem.free_mb).toBe(2048);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multiple upserts for same node: getLatestPerNode returns row with latest received_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(
        db,
        "mac-mini",
        snapshot("mac-mini", "2099-01-01T00:00:00Z", 1024),
        "2026-05-25T17:00:00Z",
      );
      writeSnapshot(
        db,
        "mac-mini",
        snapshot("mac-mini", "2026-05-25T17:02:00Z", 4096),
        "2026-05-25T17:02:30Z",
      );
      const rows = getLatestPerNode(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe("2026-05-25T17:02:00Z");
      expect(rows[0]?.receivedAt).toBe("2026-05-25T17:02:30Z");
      expect(rows[0]?.snapshot.node_mem.free_mb).toBe(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("identical snapshot re-ingest preserves received_at so freshness still expires on schedule", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      const first = snapshot("mac-mini", "2026-05-25T17:00:00Z", 1024);
      writeSnapshot(db, "mac-mini", first, "2026-05-25T17:00:00Z");
      writeSnapshot(db, "mac-mini", first, "2026-05-25T17:05:00Z");

      const rows = getLatestPerNode(db, { freshAfterTs: "2026-05-25T17:01:00Z" });
      expect(rows).toHaveLength(0);

      const [history] = getHistoricalForNode(db, "mac-mini", { limit: 1 });
      expect(history?.receivedAt).toBe("2026-05-25T17:00:00Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("advanced snapshot re-ingest refreshes received_at and stays fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(
        db,
        "mac-mini",
        snapshot("mac-mini", "2026-05-25T17:00:00Z", 1024),
        "2026-05-25T17:00:00Z",
      );
      writeSnapshot(
        db,
        "mac-mini",
        snapshot("mac-mini", "2026-05-25T17:01:00Z", 1024),
        "2026-05-25T17:05:00Z",
      );

      const rows = getLatestPerNode(db, { freshAfterTs: "2026-05-25T17:01:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe("2026-05-25T17:01:00Z");
      expect(rows[0]?.receivedAt).toBe("2026-05-25T17:05:00Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same-key upsert with changed snapshot_json refreshes received_at", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      const ts = "2026-05-25T17:01:00Z";
      writeSnapshot(db, "mac-mini", snapshot("mac-mini", ts, 1024), "2026-05-25T17:02:00Z");
      writeSnapshot(db, "mac-mini", snapshot("mac-mini", ts, 2048), "2026-05-25T17:05:00Z");

      const rows = getLatestPerNode(db, { freshAfterTs: "2026-05-25T17:01:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe(ts);
      expect(rows[0]?.receivedAt).toBe("2026-05-25T17:05:00Z");
      expect(rows[0]?.snapshot.node_mem.free_mb).toBe(2048);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getHistoricalForNode filters by sinceTs, honors limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(db, "mac-mini", snapshot("mac-mini", "2026-05-25T17:00:00Z", 1000));
      writeSnapshot(db, "mac-mini", snapshot("mac-mini", "2026-05-25T17:01:00Z", 2000));
      writeSnapshot(db, "mac-mini", snapshot("mac-mini", "2026-05-25T17:02:00Z", 3000));
      const rows = getHistoricalForNode(db, "mac-mini", {
        sinceTs: "2026-05-25T17:00:30Z",
        limit: 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ts).toBe("2026-05-25T17:02:00Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("db dir is created on first open (mkdirSync)", () => {
    const root = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const nested = join(root, "a", "b", "c", "cluster.db");
    try {
      expect(existsSync(join(root, "a", "b", "c"))).toBe(false);
      const db = openAggregatorDb(nested);
      db.close();
      expect(existsSync(join(root, "a", "b", "c"))).toBe(true);
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("getLatestPerNode with freshAfterTs excludes rows whose received_at is older than the cutoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(
        db,
        "future-clock-stale",
        snapshot("future-clock-stale", "2099-01-01T00:00:00Z", 1000),
        "2026-01-01T00:00:00Z",
      );
      writeSnapshot(
        db,
        "slow-clock-fresh",
        snapshot("slow-clock-fresh", "2020-01-01T00:00:00Z", 2000),
        "2026-01-01T01:00:00Z",
      );
      const rows = getLatestPerNode(db, { freshAfterTs: "2026-01-01T00:30:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.node).toBe("slow-clock-fresh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getLatestPerNode with freshAfterTs includes rows at or after the cutoff", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(
        db,
        "node-a",
        snapshot("node-a", "2020-01-01T01:00:00Z", 1000),
        "2026-01-01T01:00:00Z",
      );
      const rows = getLatestPerNode(db, { freshAfterTs: "2026-01-01T01:00:00Z" });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.node).toBe("node-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getLatestPerNode without opts returns all latest rows (backward-compat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      writeSnapshot(db, "stale", snapshot("stale", "2020-01-01T00:00:00Z", 1000));
      writeSnapshot(db, "fresh", snapshot("fresh", "2026-01-01T01:00:00Z", 2000));
      const rows = getLatestPerNode(db);
      expect(rows).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeSnapshot prunes old rows beyond SNAPSHOT_RETENTION_PER_NODE, preserving latest", () => {
    const dir = mkdtempSync(join(tmpdir(), "aggr-db-test-"));
    const dbPath = join(dir, "cluster.db");
    try {
      const db = openAggregatorDb(dbPath);
      const n = SNAPSHOT_RETENTION_PER_NODE;
      // Write one more than the retention bound using sequential minute-offset timestamps
      for (let i = 0; i <= n; i++) {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
        writeSnapshot(db, "mac-mini", snapshot("mac-mini", ts, i));
      }

      // Table must not exceed the retention bound
      const { count } = db
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) as count FROM node_snapshots WHERE node = 'mac-mini'")
        .get()!;
      expect(count).toBeLessThanOrEqual(n);

      // The latest row is still present
      const latest = getLatestPerNode(db);
      expect(latest).toHaveLength(1);
      const expectedLatestTs = new Date(Date.UTC(2026, 0, 1, 0, n, 0)).toISOString();
      expect(latest[0]?.ts).toBe(expectedLatestTs);
      expect(latest[0]?.snapshot.node_mem.free_mb).toBe(n);

      // getHistoricalForNode returns the retained recent history (default limit 50)
      const history = getHistoricalForNode(db, "mac-mini");
      expect(history.length).toBe(50);
      expect(history[0]?.ts).toBe(expectedLatestTs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
