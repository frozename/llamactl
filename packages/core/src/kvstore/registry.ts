import type { KvStorage } from './storage.js';

export type KvEntryReason = 'cold' | 'continued' | 'evict' | 'shutdown' | 'agentSession';
export type KvEntryState = 'idle' | 'reserved' | 'active';

export interface KvEntry {
  sha: string;
  workload: string;
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
}

interface KvEntryRow {
  sha: string;
  workload: string;
  upstream_slot_file: string;
  quant_bits: number;
  tokens: number;
  ctx_size: number;
  hits: number;
  created_at: number;
  last_used: number;
  payload_bytes: number;
  text_bytes: number;
  reason: 'cold' | 'continued' | 'evict' | 'shutdown' | 'agent_session';
  prefix_byte_length: number;
  workload_epoch: string;
  quarantined: number;
  state: KvEntryState;
}

export class KvRegistry {
  constructor(private readonly storage: KvStorage) {}

  insert(entry: KvEntry): void {
    this.storage.db.query(`
      INSERT INTO kv_entries (
        sha,
        workload,
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
        state
      ) VALUES (
        $sha,
        $workload,
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
        $state
      )
      ON CONFLICT(sha) DO UPDATE SET
        workload=excluded.workload,
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
        state=excluded.state
    `).run(toQueryParams(entry));
  }

  get(sha: string): KvEntry | null {
    const row = this.storage.db.query('SELECT * FROM kv_entries WHERE sha = ?').get(sha) as KvEntryRow | null;
    return row ? fromRow(row) : null;
  }

  findBySha(sha: string): KvEntry | null {
    return this.get(sha);
  }

  delete(sha: string): boolean {
    const result = this.storage.db.query('DELETE FROM kv_entries WHERE sha = ?').run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  reserve(sha: string): boolean {
    const result = this.storage.db.query(`
      UPDATE kv_entries
      SET state = 'reserved'
      WHERE sha = ? AND state = 'idle'
    `).run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  activate(sha: string): boolean {
    const result = this.storage.db.query(`
      UPDATE kv_entries
      SET state = 'active'
      WHERE sha = ? AND state = 'reserved'
    `).run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  release(sha: string): boolean {
    const result = this.storage.db.query(`
      UPDATE kv_entries
      SET state = 'idle'
      WHERE sha = ? AND state IN ('reserved', 'active')
    `).run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  tryDelete(sha: string): boolean {
    const result = this.storage.db.query(`
      DELETE FROM kv_entries
      WHERE sha = ? AND state = 'idle'
    `).run(sha) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  listAll(): KvEntry[] {
    const rows = this.storage.db.query('SELECT * FROM kv_entries ORDER BY sha ASC').all() as KvEntryRow[];
    return rows.map(fromRow);
  }

  bumpHit(sha: string, now: number): void {
    this.storage.db.query(`
      UPDATE kv_entries
      SET hits = hits + 1,
          last_used = ?
      WHERE sha = ?
    `).run(now, sha);
  }
}

function toQueryParams(entry: KvEntry): Record<string, number | string> {
  return {
    $sha: entry.sha,
    $workload: entry.workload,
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
  };
}

function toDbReason(reason: KvEntryReason): KvEntryRow['reason'] {
  return reason === 'agentSession' ? 'agent_session' : reason;
}

function fromDbReason(reason: KvEntryRow['reason']): KvEntryReason {
  return reason === 'agent_session' ? 'agentSession' : reason;
}

function fromRow(row: KvEntryRow): KvEntry {
  return {
    sha: row.sha,
    workload: row.workload,
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
  };
}
