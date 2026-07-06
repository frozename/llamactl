import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { FleetSnapshotEntry } from "./types.js";

import { mkdirSync } from "./safe-fs.js";

// Keep this many most-recent rows per node. getHistoricalForNode defaults to limit 50,
// so the bound must be comfortably above that to avoid losing retained history.
export const SNAPSHOT_RETENTION_PER_NODE = 200;

export interface SnapshotRow {
  node: string;
  ts: string;
  receivedAt: string;
  snapshot: FleetSnapshotEntry;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS node_snapshots (
      node TEXT NOT NULL,
      ts TEXT NOT NULL,
      received_at TEXT,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY(node, ts)
    )
  `);
  migrateReceivedAt(db);
}

function migrateReceivedAt(db: Database): void {
  if (hasColumn(db, "node_snapshots", "received_at")) return;
  withMigrationLock(db, () => {
    addColumnIfMissing(
      db,
      "node_snapshots",
      "received_at",
      `
        ALTER TABLE node_snapshots
        ADD COLUMN received_at TEXT
      `,
    );
    db.run("UPDATE node_snapshots SET received_at = ts WHERE received_at IS NULL");
  });
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

function addColumnIfMissing(db: Database, table: string, column: string, sql: string): void {
  if (hasColumn(db, table, column)) return;
  db.run(sql);
}

function withMigrationLock(db: Database, migrate: () => void): void {
  db.run("PRAGMA busy_timeout = 15000");
  db.run("BEGIN IMMEDIATE");
  try {
    migrate();
    db.run("COMMIT");
  } catch (error: unknown) {
    try {
      db.run("ROLLBACK");
    } catch (rollbackError) {
      void rollbackError;
    }
    throw error;
  }
}

export function defaultAggregatorDbPath(): string {
  return join(homedir(), ".llamactl", "fleet", "cluster.db");
}

export function openAggregatorDb(path: string = defaultAggregatorDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureSchema(db);
  return db;
}

export function writeSnapshot(
  db: Database,
  node: string,
  snapshot: FleetSnapshotEntry,
  receivedAt = new Date().toISOString(),
): void {
  ensureSchema(db);
  db.query(
    `
      INSERT INTO node_snapshots (node, ts, received_at, snapshot_json)
      VALUES ($node, $ts, $received_at, $snapshot_json)
      ON CONFLICT(node, ts) DO UPDATE SET
        received_at=CASE
          WHEN node_snapshots.snapshot_json = excluded.snapshot_json THEN node_snapshots.received_at
          ELSE excluded.received_at
        END,
        snapshot_json=excluded.snapshot_json
    `,
  ).run({
    $node: node,
    $ts: snapshot.ts,
    $received_at: receivedAt,
    $snapshot_json: JSON.stringify(snapshot),
  });
  db.query(
    `
      DELETE FROM node_snapshots
      WHERE node = $node
        AND ts NOT IN (
          SELECT ts FROM node_snapshots
          WHERE node = $node
          ORDER BY ts DESC
          LIMIT $retention
        )
    `,
  ).run({ $node: node, $retention: SNAPSHOT_RETENTION_PER_NODE });
}

export function getLatestPerNode(db: Database, opts?: { freshAfterTs?: string }): SnapshotRow[] {
  ensureSchema(db);
  const { freshAfterTs } = opts ?? {};
  const rows = db
    .query(
      `
      SELECT node, ts, received_at, snapshot_json
      FROM (
        SELECT
          node,
          ts,
          received_at,
          snapshot_json,
          ROW_NUMBER() OVER (
            PARTITION BY node
            ORDER BY COALESCE(received_at, ts) DESC, ts DESC
          ) AS row_num
        FROM node_snapshots
      )
      WHERE row_num = 1
        AND ($freshAfterTs IS NULL OR COALESCE(received_at, ts) >= $freshAfterTs)
      ORDER BY node ASC
    `,
    )
    .all({ $freshAfterTs: freshAfterTs ?? null }) as {
    node: string;
    ts: string;
    received_at: string | null;
    snapshot_json: string;
  }[];
  return rows.map((row) => ({
    node: row.node,
    ts: row.ts,
    receivedAt: row.received_at ?? row.ts,
    snapshot: JSON.parse(row.snapshot_json) as FleetSnapshotEntry,
  }));
}

export function getHistoricalForNode(
  db: Database,
  node: string,
  opts: { sinceTs?: string; limit?: number } = {},
): SnapshotRow[] {
  ensureSchema(db);
  const limit = opts.limit ?? 50;
  const rows = db
    .query(
      `
      SELECT node, ts, received_at, snapshot_json
      FROM node_snapshots
      WHERE node = $node
        AND ($sinceTs IS NULL OR ts >= $sinceTs)
      ORDER BY ts DESC
      LIMIT $limit
    `,
    )
    .all({
      $node: node,
      $sinceTs: opts.sinceTs ?? null,
      $limit: limit,
    }) as { node: string; ts: string; received_at: string | null; snapshot_json: string }[];
  return rows.map((row) => ({
    node: row.node,
    ts: row.ts,
    receivedAt: row.received_at ?? row.ts,
    snapshot: JSON.parse(row.snapshot_json) as FleetSnapshotEntry,
  }));
}
