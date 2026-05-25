import type { ResponseCacheStorage } from './storage.js';

export interface ResponseCacheEntry {
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant: 'openai' | 'anthropic';
  contentType: string;
  statusCode: number;
  responseBody: Uint8Array;
  requestBodyBytes: number;
  responseBodyBytes: number;
  createdAt: number;
  lastUsed: number;
  hits: number;
}

interface ResponseCacheEntryRow {
  sha: string;
  model: string;
  workload: string;
  workload_epoch: string;
  protocol_variant: 'openai' | 'anthropic';
  content_type: string;
  status_code: number;
  response_body: Uint8Array;
  request_body_bytes: number;
  response_body_bytes: number;
  created_at: number;
  last_used: number;
  hits: number;
}

export interface ResponseCacheLookup {
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant: 'openai' | 'anthropic';
}

export class ResponseCacheRegistry {
  constructor(private readonly storage: ResponseCacheStorage) {}

  insert(entry: ResponseCacheEntry): void {
    this.storage.db.query(`
      INSERT INTO response_entries (
        sha,
        model,
        workload,
        workload_epoch,
        protocol_variant,
        content_type,
        status_code,
        response_body,
        request_body_bytes,
        response_body_bytes,
        created_at,
        last_used,
        hits
      ) VALUES (
        $sha,
        $model,
        $workload,
        $workload_epoch,
        $protocol_variant,
        $content_type,
        $status_code,
        $response_body,
        $request_body_bytes,
        $response_body_bytes,
        $created_at,
        $last_used,
        $hits
      )
      ON CONFLICT(sha, model, workload, workload_epoch, protocol_variant) DO UPDATE SET
        content_type=excluded.content_type,
        status_code=excluded.status_code,
        response_body=excluded.response_body,
        request_body_bytes=excluded.request_body_bytes,
        response_body_bytes=excluded.response_body_bytes,
        created_at=excluded.created_at,
        last_used=excluded.last_used,
        hits=excluded.hits
    `).run(toQueryParams(entry));
  }

  findBySha(lookup: ResponseCacheLookup): ResponseCacheEntry | null {
    const row = this.storage.db.query(`
      SELECT *
      FROM response_entries
      WHERE sha = $sha
        AND model = $model
        AND workload = $workload
        AND workload_epoch = $workload_epoch
        AND protocol_variant = $protocol_variant
      LIMIT 1
    `).get(toLookupParams(lookup)) as ResponseCacheEntryRow | null;
    return row ? fromRow(row) : null;
  }

  bumpHit(lookup: ResponseCacheLookup, now: number): void {
    this.storage.db.query(`
      UPDATE response_entries
      SET hits = hits + 1,
          last_used = $last_used
      WHERE sha = $sha
        AND model = $model
        AND workload = $workload
        AND workload_epoch = $workload_epoch
        AND protocol_variant = $protocol_variant
    `).run({
      ...toLookupParams(lookup),
      $last_used: now,
    });
  }

  tryDelete(lookup: ResponseCacheLookup): boolean {
    const result = this.storage.db.query(`
      DELETE FROM response_entries
      WHERE sha = $sha
        AND model = $model
        AND workload = $workload
        AND workload_epoch = $workload_epoch
        AND protocol_variant = $protocol_variant
    `).run(toLookupParams(lookup)) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  listForModel(model: string): ResponseCacheEntry[] {
    const rows = this.storage.db.query('SELECT * FROM response_entries WHERE model = ? ORDER BY sha ASC').all(model) as ResponseCacheEntryRow[];
    return rows.map(fromRow);
  }

  listAll(): ResponseCacheEntry[] {
    const rows = this.storage.db.query('SELECT * FROM response_entries ORDER BY sha ASC').all() as ResponseCacheEntryRow[];
    return rows.map(fromRow);
  }
}

function toQueryParams(entry: ResponseCacheEntry): Record<string, number | string | Uint8Array> {
  return {
    $sha: entry.sha,
    $model: entry.model,
    $workload: entry.workload,
    $workload_epoch: entry.workloadEpoch,
    $protocol_variant: entry.protocolVariant,
    $content_type: entry.contentType,
    $status_code: entry.statusCode,
    $response_body: entry.responseBody,
    $request_body_bytes: entry.requestBodyBytes,
    $response_body_bytes: entry.responseBodyBytes,
    $created_at: entry.createdAt,
    $last_used: entry.lastUsed,
    $hits: entry.hits,
  };
}

function toLookupParams(lookup: ResponseCacheLookup): Record<string, string> {
  return {
    $sha: lookup.sha,
    $model: lookup.model,
    $workload: lookup.workload,
    $workload_epoch: lookup.workloadEpoch,
    $protocol_variant: lookup.protocolVariant,
  };
}

function fromRow(row: ResponseCacheEntryRow): ResponseCacheEntry {
  return {
    sha: row.sha,
    model: row.model,
    workload: row.workload,
    workloadEpoch: row.workload_epoch,
    protocolVariant: row.protocol_variant,
    contentType: row.content_type,
    statusCode: row.status_code,
    responseBody: row.response_body,
    requestBodyBytes: row.request_body_bytes,
    responseBodyBytes: row.response_body_bytes,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    hits: row.hits,
  };
}
