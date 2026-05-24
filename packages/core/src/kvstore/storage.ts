import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 2;

export interface KvStorage {
  db: Database;
  registry_integrity_errors_total: number;
  registry_write_fail_total: number;
  safeWrite(fn: () => void): { ok: true } | { ok: false; reason: 'enospc' | 'other'; error: Error };
  close(): void;
}

export function openKvStorage(dataRoot: string): KvStorage {
  const kvDir = join(dataRoot, 'kvstore');
  mkdirSync(kvDir, { recursive: true });
  const db = new Database(join(kvDir, 'registry.db'));
  db.run('PRAGMA journal_mode = WAL');
  migrate(db);
  const storage: KvStorage = {
    db,
    registry_integrity_errors_total: 0,
    registry_write_fail_total: 0,
    safeWrite: (fn) => safeWrite(storage, fn),
    close: () => db.close(),
  };
  runIntegrityScan(storage);
  return storage;
}

export function safeWrite(
  storage: KvStorage,
  fn: () => void,
): { ok: true } | { ok: false; reason: 'enospc' | 'other'; error: Error } {
  try {
    fn();
    return { ok: true };
  } catch (error: unknown) {
    const normalized = toError(error);
    if (isEnospcError(normalized)) {
      storage.registry_write_fail_total += 1;
      return { ok: false, reason: 'enospc', error: normalized };
    }
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
    throw new Error(`kvstore schema_version ${fromVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  runMigrations(db, fromVersion, SCHEMA_VERSION);
}

export function runMigrations(db: Database, fromVersion: number, toVersion: number): void {
  if (fromVersion >= toVersion) return;
  for (let next = fromVersion + 1; next <= toVersion; next += 1) {
    switch (next) {
      case 1:
        db.run(`
          CREATE TABLE IF NOT EXISTS kv_entries (
            sha TEXT PRIMARY KEY,
            workload TEXT NOT NULL,
            upstream_slot_file TEXT NOT NULL,
            quant_bits INTEGER NOT NULL,
            tokens INTEGER NOT NULL,
            ctx_size INTEGER NOT NULL,
            hits INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_used INTEGER NOT NULL,
            payload_bytes INTEGER NOT NULL,
            text_bytes INTEGER NOT NULL,
            reason TEXT NOT NULL CHECK(reason IN ('cold','continued','evict','shutdown','agent_session')),
            prefix_byte_length INTEGER NOT NULL,
            workload_epoch TEXT NOT NULL,
            quarantined INTEGER NOT NULL DEFAULT 0
          )
        `);
        db.run('CREATE INDEX IF NOT EXISTS idx_kv_workload_quant_ctx ON kv_entries (workload, quant_bits, ctx_size)');
        db.run('CREATE INDEX IF NOT EXISTS idx_kv_last_used ON kv_entries (last_used)');
        db.query('UPDATE schema_version SET version = 1').run();
        break;
      case 2:
        db.run(`
          ALTER TABLE kv_entries
          ADD COLUMN state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','reserved','active'))
        `);
        db.query('UPDATE schema_version SET version = 2').run();
        break;
      default:
        throw new Error(`Unsupported kvstore schema migration target ${next}`);
    }
  }
}

function runIntegrityScan(storage: KvStorage): void {
  const rows = storage.db.query('SELECT sha, upstream_slot_file FROM kv_entries').all() as Array<{
    sha: string;
    upstream_slot_file: string;
  }>;
  const quarantine = storage.db.query('UPDATE kv_entries SET quarantined = 1 WHERE sha = ?');
  for (const row of rows) {
    if (existsSync(row.upstream_slot_file)) continue;
    quarantine.run(row.sha);
    storage.registry_integrity_errors_total += 1;
  }
}

function isEnospcError(error: Error & { code?: unknown }): boolean {
  return error.code === 'ENOSPC';
}

function toError(error: unknown): Error & { code?: unknown } {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : 'Unknown error');
}
