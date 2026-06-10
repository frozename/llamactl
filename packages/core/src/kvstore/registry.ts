import { unlinkSync } from "node:fs";
import type { KvStorage } from "./storage.js";

export type KvEntryReason = "cold" | "continued" | "evict" | "shutdown" | "agentSession";
export type KvEntryState = "idle" | "reserved" | "active";

export interface KvEntry {
  sha: string;
  workload: string;
  model: string | null;
  upstreamSlotFile: string;
  quantBits: number;
  tokens: number;
  ctxSize: number;
  hits: number;
  createdAt: number;
  lastUsed: number;
  payloadBytes: number;
  textBytes: number;
  reason: KvEntryReason;
  prefixByteLength: number;
  workloadEpoch: string;
  quarantined: number;
  state: KvEntryState;
  firstResponseToken: string | null;
  extFlags: number;
}

interface KvEntryRow {
  sha: string;
  workload: string;
  model: string | null;
  upstream_slot_file: string;
  quant_bits: number;
  tokens: number;
  ctx_size: number;
  hits: number;
  created_at: number;
  last_used: number;
  payload_bytes: number;
  text_bytes: number;
  reason: "cold" | "continued" | "evict" | "shutdown" | "agent_session";
  prefix_byte_length: number;
  workload_epoch: string;
  quarantined: number;
  state: KvEntryState;
  first_response_token: string | null;
  ext_flags: number;
}

export class KvRegistry {
  constructor(private readonly storage: KvStorage) {}

  insert(entry: KvEntry): void {
    this.storage.db
      .query(
        `
      INSERT INTO kv_entries (
        sha,
        workload,
        model,
        upstream_slot_file,
        quant_bits,
        tokens,
        ctx_size,
        hits,
        created_at,
        last_used,
        payload_bytes,
        text_bytes,
        reason,
        prefix_byte_length,
        workload_epoch,
        quarantined,
        state,
        first_response_token,
        ext_flags
      ) VALUES (
        $sha,
        $workload,
        $model,
        $upstream_slot_file,
        $quant_bits,
        $tokens,
        $ctx_size,
        $hits,
        $created_at,
        $last_used,
        $payload_bytes,
        $text_bytes,
        $reason,
        $prefix_byte_length,
        $workload_epoch,
        $quarantined,
        $state,
        $first_response_token,
        $ext_flags
      )
      ON CONFLICT(sha) DO UPDATE SET
        workload=excluded.workload,
        model=excluded.model,
        upstream_slot_file=excluded.upstream_slot_file,
        quant_bits=excluded.quant_bits,
        tokens=excluded.tokens,
        ctx_size=excluded.ctx_size,
        hits=excluded.hits,
        created_at=excluded.created_at,
        last_used=excluded.last_used,
        payload_bytes=excluded.payload_bytes,
        text_bytes=excluded.text_bytes,
        reason=excluded.reason,
        prefix_byte_length=excluded.prefix_byte_length,
        workload_epoch=excluded.workload_epoch,
        quarantined=excluded.quarantined,
        state=excluded.state,
        first_response_token=excluded.first_response_token,
        ext_flags=excluded.ext_flags
    `,
      )
      .run(toQueryParams(entry));
  }

  get(sha: string): KvEntry | null {
    const row = this.storage.db
      .query("SELECT * FROM kv_entries WHERE sha = ?")
      .get(sha) as KvEntryRow | null;
    return row ? fromRow(row) : null;
  }

  findBySha(sha: string): KvEntry | null {
    return this.get(sha);
  }

  delete(sha: string): boolean {
    return deleteReturning(
      this.storage,
      "DELETE FROM kv_entries WHERE sha = ? RETURNING upstream_slot_file",
      sha,
    );
  }

  reserve(sha: string): boolean {
    const result = this.storage.db
      .query(
        `
      UPDATE kv_entries
      SET state = 'reserved'
      WHERE sha = ? AND state = 'idle'
    `,
      )
      .run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  activate(sha: string): boolean {
    const result = this.storage.db
      .query(
        `
      UPDATE kv_entries
      SET state = 'active'
      WHERE sha = ? AND state = 'reserved'
    `,
      )
      .run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  release(sha: string): boolean {
    const result = this.storage.db
      .query(
        `
      UPDATE kv_entries
      SET state = 'idle'
      WHERE sha = ? AND state IN ('reserved', 'active')
    `,
      )
      .run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  tryDelete(sha: string): boolean {
    return deleteReturning(
      this.storage,
      `
      DELETE FROM kv_entries
      WHERE sha = ? AND state = 'idle'
      RETURNING upstream_slot_file
    `,
      sha,
    );
  }

  deleteEpochStale(workload: string, currentEpoch: string): boolean {
    const rows = this.storage.db
      .query(
        `
      DELETE FROM kv_entries
      WHERE workload = ? AND workload_epoch != ? AND state = 'idle'
      RETURNING upstream_slot_file
    `,
      )
      .all(workload, currentEpoch) as Array<{ upstream_slot_file: string }>;
    for (const row of rows) unlinkSlotArtifacts(row.upstream_slot_file);
    return rows.length > 0;
  }

  listAll(): KvEntry[] {
    const rows = this.storage.db
      .query("SELECT * FROM kv_entries ORDER BY sha ASC")
      .all() as KvEntryRow[];
    return rows.map(fromRow);
  }

  bumpHit(sha: string, now: number): void {
    this.storage.db
      .query(
        `
      UPDATE kv_entries
      SET hits = hits + 1,
          last_used = ?
      WHERE sha = ?
    `,
      )
      .run(now, sha);
  }

  setExtFlags(sha: string, extFlags: number): void {
    this.storage.db
      .query(
        `
      UPDATE kv_entries
      SET ext_flags = ?
      WHERE sha = ?
    `,
      )
      .run(extFlags, sha);
  }
}

function unlinkSlotArtifacts(path: string): void {
  for (const candidate of [path, `${path}.trailer.json`]) {
    try {
      unlinkSync(candidate);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      )
        continue;
      console.warn(`[kvstore] failed to unlink ${candidate}`);
    }
  }
}

function deleteReturning(storage: KvStorage, sql: string, sha: string): boolean {
  const rows = storage.db.query(sql).all(sha) as Array<{ upstream_slot_file: string }>;
  for (const row of rows) unlinkSlotArtifacts(row.upstream_slot_file);
  return rows.length > 0;
}

function toQueryParams(entry: KvEntry): Record<string, number | string | null> {
  return {
    $sha: entry.sha,
    $workload: entry.workload,
    $model: entry.model,
    $upstream_slot_file: entry.upstreamSlotFile,
    $quant_bits: entry.quantBits,
    $tokens: entry.tokens,
    $ctx_size: entry.ctxSize,
    $hits: entry.hits,
    $created_at: entry.createdAt,
    $last_used: entry.lastUsed,
    $payload_bytes: entry.payloadBytes,
    $text_bytes: entry.textBytes,
    $reason: toDbReason(entry.reason),
    $prefix_byte_length: entry.prefixByteLength,
    $workload_epoch: entry.workloadEpoch,
    $quarantined: entry.quarantined,
    $state: entry.state,
    $first_response_token: entry.firstResponseToken,
    $ext_flags: entry.extFlags,
  };
}

function toDbReason(reason: KvEntryReason): KvEntryRow["reason"] {
  return reason === "agentSession" ? "agent_session" : reason;
}

function fromDbReason(reason: KvEntryRow["reason"]): KvEntryReason {
  return reason === "agent_session" ? "agentSession" : reason;
}

function fromRow(row: KvEntryRow): KvEntry {
  return {
    sha: row.sha,
    workload: row.workload,
    model: row.model,
    upstreamSlotFile: row.upstream_slot_file,
    quantBits: row.quant_bits,
    tokens: row.tokens,
    ctxSize: row.ctx_size,
    hits: row.hits,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    payloadBytes: row.payload_bytes,
    textBytes: row.text_bytes,
    reason: fromDbReason(row.reason),
    prefixByteLength: row.prefix_byte_length,
    workloadEpoch: row.workload_epoch,
    quarantined: row.quarantined,
    state: row.state,
    firstResponseToken: row.first_response_token,
    extFlags: row.ext_flags,
  };
}
