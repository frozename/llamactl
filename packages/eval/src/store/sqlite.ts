import type { Database, SQLQueryBindings } from "bun:sqlite";

export interface LeaderboardRow {
  model: string;
  node: string;
  ub: 256 | 512;
  throughput_tps: number;
  ttft_ms: number;
  tool_call_score: number;
  context_8k_score: number;
  context_16k_score: number | null;
  json_score: number;
  composite: number;
  asof: string;
}

export interface QueryFilter {
  node?: string;
  min_throughput?: number;
  min_tool_call_score?: number;
  sort_by?: keyof LeaderboardRow;
}

function ensureSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      model TEXT NOT NULL,
      node TEXT NOT NULL,
      ub INTEGER NOT NULL,
      throughput_tps REAL NOT NULL,
      ttft_ms REAL NOT NULL,
      tool_call_score REAL NOT NULL,
      context_8k_score REAL NOT NULL,
      context_16k_score REAL,
      json_score REAL NOT NULL,
      composite REAL NOT NULL,
      asof TEXT NOT NULL,
      PRIMARY KEY (model, node, ub)
    )
  `);
}

export function upsertRow(db: Database, row: LeaderboardRow): void {
  ensureSchema(db);
  const params = {
    $model: row.model,
    $node: row.node,
    $ub: row.ub,
    $throughput_tps: row.throughput_tps,
    $ttft_ms: row.ttft_ms,
    $tool_call_score: row.tool_call_score,
    $context_8k_score: row.context_8k_score,
    $context_16k_score: row.context_16k_score,
    $json_score: row.json_score,
    $composite: row.composite,
    $asof: row.asof,
  };
  db.query(
    `
      INSERT INTO leaderboard (
        model, node, ub, throughput_tps, ttft_ms, tool_call_score,
        context_8k_score, context_16k_score, json_score, composite, asof
      ) VALUES (
        $model, $node, $ub, $throughput_tps, $ttft_ms, $tool_call_score,
        $context_8k_score, $context_16k_score, $json_score, $composite, $asof
      )
      ON CONFLICT(model, node, ub) DO UPDATE SET
        throughput_tps=excluded.throughput_tps,
        ttft_ms=excluded.ttft_ms,
        tool_call_score=excluded.tool_call_score,
        context_8k_score=excluded.context_8k_score,
        context_16k_score=excluded.context_16k_score,
        json_score=excluded.json_score,
        composite=excluded.composite,
        asof=excluded.asof
    `,
  ).run(params);
}

export function queryRows(db: Database, filter: QueryFilter = {}): LeaderboardRow[] {
  ensureSchema(db);
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.node) {
    clauses.push("node = ?");
    params.push(filter.node);
  }
  if (filter.min_throughput !== undefined) {
    clauses.push("throughput_tps >= ?");
    params.push(filter.min_throughput);
  }
  if (filter.min_tool_call_score !== undefined) {
    clauses.push("tool_call_score >= ?");
    params.push(filter.min_tool_call_score);
  }
  const orderBy = filter.sort_by ?? "composite";
  const rows = db
    .query(
      `SELECT model, node, ub, throughput_tps, ttft_ms, tool_call_score, context_8k_score, context_16k_score, json_score, composite, asof
       FROM leaderboard
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY ${orderBy} DESC, model ASC, node ASC, ub ASC`,
    )
    .all(...params) as LeaderboardRow[];
  return rows;
}
