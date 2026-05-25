import type { ResponseCacheStorage } from './storage.js';

export interface ResponseCacheEntry {
  sha: string;
  model: string;
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
  content_type: string;
  status_code: number;
  response_body: Uint8Array;
  request_body_bytes: number;
  response_body_bytes: number;
  created_at: number;
  last_used: number;
  hits: number;
}

export class ResponseCacheRegistry {
  constructor(private readonly storage: ResponseCacheStorage) {}

  insert(entry: ResponseCacheEntry): void {
    this.storage.db.query(`
      INSERT INTO response_entries (
        sha,
        model,
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
        $content_type,
        $status_code,
        $response_body,
        $request_body_bytes,
        $response_body_bytes,
        $created_at,
        $last_used,
        $hits
      )
      ON CONFLICT(sha) DO UPDATE SET
        model=excluded.model,
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

  findBySha(sha: string): ResponseCacheEntry | null {
    const row = this.storage.db.query('SELECT * FROM response_entries WHERE sha = ?').get(sha) as ResponseCacheEntryRow | null;
    return row ? fromRow(row) : null;
  }

  bumpHit(sha: string, now: number): void {
    this.storage.db.query(`
      UPDATE response_entries
      SET hits = hits + 1,
          last_used = ?
      WHERE sha = ?
    `).run(now, sha);
  }

  tryDelete(sha: string): boolean {
    const result = this.storage.db.query('DELETE FROM response_entries WHERE sha = ?').run(sha) as { changes?: number };
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

function fromRow(row: ResponseCacheEntryRow): ResponseCacheEntry {
  return {
    sha: row.sha,
    model: row.model,
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
