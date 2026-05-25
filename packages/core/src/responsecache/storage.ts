import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;

export interface ResponseCacheStorage {
  db: Database;
  response_cache_hit_total: number;
  response_cache_miss_total: number;
  response_cache_evict_total: number;
  safeWrite(fn: () => void): { ok: true } | { ok: false; reason: 'enospc' | 'other'; error: Error };
  close(): void;
}

export function openResponseCacheStorage(dataRoot: string): ResponseCacheStorage {
  const cacheDir = join(dataRoot, 'responsecache');
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(cacheDir, 'responses.db'));
  db.run('PRAGMA journal_mode = WAL');
  migrate(db);
  const storage: ResponseCacheStorage = {
    db,
    response_cache_hit_total: 0,
    response_cache_miss_total: 0,
    response_cache_evict_total: 0,
    safeWrite: (fn) => safeWrite(storage, fn),
    close: () => db.close(),
  };
  return storage;
}

export function safeWrite(
  storage: ResponseCacheStorage,
  fn: () => void,
): { ok: true } | { ok: false; reason: 'enospc' | 'other'; error: Error } {
  try {
    fn();
    return { ok: true };
  } catch (error: unknown) {
    const normalized = toError(error);
    if (isEnospcError(normalized)) return { ok: false, reason: 'enospc', error: normalized };
    return { ok: false, reason: 'other', error: normalized };
  }
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `);
  const versionRow = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null;
  if (!versionRow) db.query('INSERT INTO schema_version (version) VALUES (0)').run();
  const fromVersion = versionRow?.version ?? 0;
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`responsecache schema_version ${fromVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  runMigrations(db, fromVersion, SCHEMA_VERSION);
}

export function runMigrations(db: Database, fromVersion: number, toVersion: number): void {
  if (fromVersion >= toVersion) return;
  for (let next = fromVersion + 1; next <= toVersion; next += 1) {
    switch (next) {
      case 1:
        db.run('BEGIN IMMEDIATE');
        try {
          db.run(`
            CREATE TABLE IF NOT EXISTS response_entries (
              sha TEXT PRIMARY KEY,
              model TEXT NOT NULL,
              content_type TEXT NOT NULL,
              status_code INTEGER NOT NULL,
              response_body BLOB NOT NULL,
              request_body_bytes INTEGER NOT NULL,
              response_body_bytes INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              last_used INTEGER NOT NULL,
              hits INTEGER NOT NULL DEFAULT 0
            )
          `);
          db.run('CREATE INDEX IF NOT EXISTS idx_resp_model ON response_entries (model)');
          db.run('CREATE INDEX IF NOT EXISTS idx_resp_last_used ON response_entries (last_used)');
          db.query('UPDATE schema_version SET version = 1').run();
          db.run('COMMIT');
        } catch (error) {
          db.run('ROLLBACK');
          throw error;
        }
        break;
      default:
        throw new Error(`Unsupported responsecache schema migration target ${next}`);
    }
  }
}

function isEnospcError(error: Error & { code?: unknown }): boolean {
  return error.code === 'ENOSPC';
}

function toError(error: unknown): Error & { code?: unknown } {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}
