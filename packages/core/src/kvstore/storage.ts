import { Database } from "bun:sqlite";
import { join } from "node:path";

import * as safeFs from "../safe-fs.js";

const SCHEMA_VERSION = 5;

export interface KvStorage {
  db: Database;
  registry_integrity_errors_total: number;
  registry_write_fail_total: number;
  kv_false_hit_total: number;
  kv_replay_mismatch_total: number;
  kv_model_mismatch_total: number;
  safeWrite(fn: () => void): { ok: true } | { ok: false; reason: "enospc" | "other"; error: Error };
  close(): void;
}

export function openKvStorage(dataRoot: string): KvStorage {
  const kvDir = join(dataRoot, "kvstore");
  safeFs.mkdirSync(kvDir, { recursive: true });
  const db = new Database(join(kvDir, "registry.db"));
  // Any throw during post-construction init (pragmas, migrate,
  // runIntegrityScan) must close the freshly-opened handle, or it leaks a
  // file descriptor and holds the WAL lock. Close on the failure path only;
  // on success the handle stays open and is owned by the returned storage.
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 15000");
    migrate(db);
    const storage: KvStorage = {
      db,
      registry_integrity_errors_total: 0,
      registry_write_fail_total: 0,
      kv_false_hit_total: 0,
      kv_replay_mismatch_total: 0,
      kv_model_mismatch_total: 0,
      safeWrite: (fn) => safeWrite(storage, fn),
      close: () => {
        db.close();
      },
    };
    runIntegrityScan(storage);
    return storage;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function safeWrite(
  storage: KvStorage,
  fn: () => void,
): { ok: true } | { ok: false; reason: "enospc" | "other"; error: Error } {
  try {
    fn();
    return { ok: true };
  } catch (error: unknown) {
    const normalized = toError(error);
    if (isEnospcError(normalized)) {
      storage.registry_write_fail_total += 1;
      return { ok: false, reason: "enospc", error: normalized };
    }
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
      `kvstore schema_version ${String(fromVersion)} is newer than supported ${String(SCHEMA_VERSION)}`,
    );
  }
  runMigrations(db, fromVersion, SCHEMA_VERSION);
}

export function runMigrations(db: Database, fromVersion: number, toVersion: number): void {
  if (fromVersion >= toVersion) return;
  for (let next = fromVersion + 1; next <= toVersion; next += 1) {
    switch (next) {
      case 1:
        withMigrationLock(db, 1, () => {
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
          db.run(
            "CREATE INDEX IF NOT EXISTS idx_kv_workload_quant_ctx ON kv_entries (workload, quant_bits, ctx_size)",
          );
          db.run("CREATE INDEX IF NOT EXISTS idx_kv_last_used ON kv_entries (last_used)");
        });
        break;
      case 2:
        withMigrationLock(db, 2, () => {
          addColumnIfMissing(
            db,
            "kv_entries",
            "state",
            `
              ALTER TABLE kv_entries
              ADD COLUMN state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','reserved','active'))
            `,
          );
        });
        break;
      case 3:
        withMigrationLock(db, 3, () => {
          addColumnIfMissing(
            db,
            "kv_entries",
            "first_response_token",
            `
              ALTER TABLE kv_entries
              ADD COLUMN first_response_token TEXT
            `,
          );
        });
        break;
      case 4:
        withMigrationLock(db, 4, () => {
          addColumnIfMissing(
            db,
            "kv_entries",
            "ext_flags",
            `
              ALTER TABLE kv_entries
              ADD COLUMN ext_flags INTEGER NOT NULL DEFAULT 0
            `,
          );
        });
        break;
      case 5:
        withMigrationLock(db, 5, () => {
          addColumnIfMissing(
            db,
            "kv_entries",
            "model",
            `
              ALTER TABLE kv_entries
              ADD COLUMN model TEXT
            `,
          );
        });
        break;
      default:
        throw new Error(`Unsupported kvstore schema migration target ${String(next)}`);
    }
  }
}

function addColumnIfMissing(db: Database, table: string, column: string, sql: string): void {
  const columns = db.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  if (columns.some((candidate) => candidate.name === column)) return;
  db.run(sql);
}

export function runIntegrityScan(storage: KvStorage): void {
  const graceMs = ((): number => {
    const raw = process.env["LLAMACTL_KV_QUARANTINE_PURGE_HOURS"];
    const hours = raw ? Number.parseFloat(raw) : 24;
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  })();
  const now = Date.now();
  const rows = storage.db
    .query("SELECT sha, upstream_slot_file, quarantined, last_used FROM kv_entries")
    .all() as {
    sha: string;
    upstream_slot_file: string;
    quarantined: number;
    last_used: number;
  }[];
  const toUnquarantine: string[] = [];
  const toQuarantine: string[] = [];
  const toPurge: string[] = [];
  for (const row of rows) {
    const exists = safeFs.existsSync(row.upstream_slot_file);
    if (exists && row.quarantined === 1) {
      toUnquarantine.push(row.sha);
      continue;
    }
    if (!exists && row.quarantined === 0) {
      toQuarantine.push(row.sha);
      storage.registry_integrity_errors_total += 1;
      continue;
    }
    if (!exists && row.quarantined === 1 && now - row.last_used > graceMs) {
      toPurge.push(row.sha);
    }
  }
  if (toUnquarantine.length === 0 && toQuarantine.length === 0 && toPurge.length === 0) return;
  storage.db.transaction(() => {
    const quarantine = storage.db.query("UPDATE kv_entries SET quarantined = 1 WHERE sha = ?");
    const unquarantine = storage.db.query("UPDATE kv_entries SET quarantined = 0 WHERE sha = ?");
    const purge = storage.db.query("DELETE FROM kv_entries WHERE sha = ?");
    for (const sha of toUnquarantine) {
      unquarantine.run(sha);
    }
    for (const sha of toQuarantine) {
      quarantine.run(sha);
    }
    for (const sha of toPurge) {
      purge.run(sha);
    }
  })();
}

function withMigrationLock(db: Database, version: number, migrate: () => void): void {
  db.run("PRAGMA busy_timeout = 15000");
  db.run("BEGIN IMMEDIATE");
  try {
    migrate();
    db.query("UPDATE schema_version SET version = ?").run(version);
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

function isEnospcError(error: Error & { code?: unknown }): boolean {
  return error.code === "ENOSPC";
}

function toError(error: unknown): Error & { code?: unknown } {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown error");
}
