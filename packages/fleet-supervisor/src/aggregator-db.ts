import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { FleetSnapshotEntry } from './types.js';

export interface SnapshotRow {
  node: string;
  ts: string;
  snapshot: FleetSnapshotEntry;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS node_snapshots (
      node TEXT NOT NULL,
      ts TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY(node, ts)
    )
  `);
}

export function defaultAggregatorDbPath(): string {
  return join(homedir(), '.llamactl', 'fleet', 'cluster.db');
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
): void {
  ensureSchema(db);
  db.query(
    `
      INSERT INTO node_snapshots (node, ts, snapshot_json)
      VALUES ($node, $ts, $snapshot_json)
      ON CONFLICT(node, ts) DO UPDATE SET
        snapshot_json=excluded.snapshot_json
    `,
  ).run({
    $node: node,
    $ts: snapshot.ts,
    $snapshot_json: JSON.stringify(snapshot),
  });
}

export function getLatestPerNode(db: Database): SnapshotRow[] {
  ensureSchema(db);
  const rows = db.query(
    `
      SELECT node, ts, snapshot_json
      FROM node_snapshots
      WHERE (node, ts) IN (
        SELECT node, MAX(ts) AS ts
        FROM node_snapshots
        GROUP BY node
      )
      ORDER BY node ASC
    `,
  ).all() as Array<{ node: string; ts: string; snapshot_json: string }>;
  return rows.map((row) => ({
    node: row.node,
    ts: row.ts,
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
  const rows = db.query(
    `
      SELECT node, ts, snapshot_json
      FROM node_snapshots
      WHERE node = $node
        AND ($sinceTs IS NULL OR ts >= $sinceTs)
      ORDER BY ts DESC
      LIMIT $limit
    `,
  ).all({
    $node: node,
    $sinceTs: opts.sinceTs ?? null,
    $limit: limit,
  }) as Array<{ node: string; ts: string; snapshot_json: string }>;
  return rows.map((row) => ({
    node: row.node,
    ts: row.ts,
    snapshot: JSON.parse(row.snapshot_json) as FleetSnapshotEntry,
  }));
}
