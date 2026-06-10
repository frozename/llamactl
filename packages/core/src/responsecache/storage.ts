import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_VERSION = 2;

export interface ResponseCacheStorage {
  db: Database;
  response_cache_hit_total: number;
  response_cache_miss_total: number;
  response_cache_evict_total: number;
  safeWrite(fn: () => void): { ok: true } | { ok: false; reason: "enospc" | "other"; error: Error };
  close(): void;
}

export function openResponseCacheStorage(dataRoot: string): ResponseCacheStorage {
  const cacheDir = join(dataRoot, "responsecache");
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(cacheDir, "responses.db"));
  db.run("PRAGMA journal_mode = WAL");
  migrate(db);
  const storage: ResponseCacheStorage = {
    db,
    response_cache_hit_total: 0,
    response_cache_miss_total: 0,
    response_cache_evict_total: 0,
    safeWrite: (fn) => safeWrite(storage, fn),
    close: () => {
      db.close();
    },
  };
  return storage;
}

export function safeWrite(
  storage: ResponseCacheStorage,
  fn: () => void,
): { ok: true } | { ok: false; reason: "enospc" | "other"; error: Error } {
  try {
    fn();
    return { ok: true };
  } catch (error: unknown) {
    const normalized = toError(error);
    if (isEnospcError(normalized)) return { ok: false, reason: "enospc", error: normalized };
    return { ok: false, reason: "other", error: normalized };
  }
}

function migrate(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `);
  const versionRow = db.query("SELECT version FROM schema_version LIMIT 1").get() as {
    version: number;
  } | null;
  if (!versionRow) db.query("INSERT INTO schema_version (version) VALUES (0)").run();
  const fromVersion = versionRow?.version ?? 0;
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(
      `responsecache schema_version ${String(fromVersion)} is newer than supported ${String(SCHEMA_VERSION)}`,
    );
  }
  runMigrations(db, fromVersion, SCHEMA_VERSION);
}

export function runMigrations(db: Database, fromVersion: number, toVersion: number): void {
  if (fromVersion >= toVersion) return;
  for (let next = fromVersion + 1; next <= toVersion; next += 1) {
    switch (next) {
      case 1:
        db.run("BEGIN IMMEDIATE");
        try {
          createResponseEntriesV2Table(db, "response_entries");
          db.run("CREATE INDEX IF NOT EXISTS idx_resp_model ON response_entries (model)");
          db.run("CREATE INDEX IF NOT EXISTS idx_resp_last_used ON response_entries (last_used)");
          db.query("UPDATE schema_version SET version = 1").run();
          db.run("COMMIT");
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
        break;
      case 2:
        db.run("BEGIN IMMEDIATE");
        try {
          createResponseEntriesV2Table(db, "response_entries_v2");
          db.run(`
            INSERT INTO response_entries_v2 (
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
            )
            SELECT
              sha,
              model,
              '',
              '',
              'openai',
              content_type,
              status_code,
              response_body,
              request_body_bytes,
              response_body_bytes,
              created_at,
              last_used,
              hits
            FROM response_entries
          `);
          db.run("DROP TABLE response_entries");
          db.run("ALTER TABLE response_entries_v2 RENAME TO response_entries");
          db.run("DROP INDEX IF EXISTS idx_resp_model");
          db.run(
            "CREATE INDEX IF NOT EXISTS idx_resp_model_scope ON response_entries (model, workload, workload_epoch)",
          );
          db.run("CREATE INDEX IF NOT EXISTS idx_resp_last_used ON response_entries (last_used)");
          db.query("UPDATE schema_version SET version = 2").run();
          db.run("COMMIT");
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
        break;
      default:
        throw new Error(`Unsupported responsecache schema migration target ${String(next)}`);
    }
  }
}

function createResponseEntriesV2Table(db: Database, tableName: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      sha TEXT NOT NULL,
      model TEXT NOT NULL,
      workload TEXT NOT NULL DEFAULT '',
      workload_epoch TEXT NOT NULL DEFAULT '',
      protocol_variant TEXT NOT NULL DEFAULT 'openai',
      content_type TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body BLOB NOT NULL,
      request_body_bytes INTEGER NOT NULL,
      response_body_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sha, model, workload, workload_epoch, protocol_variant)
    )
  `);
}

function isEnospcError(error: Error & { code?: unknown }): boolean {
  return error.code === "ENOSPC";
}

function toError(error: unknown): Error & { code?: unknown } {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown error");
}
