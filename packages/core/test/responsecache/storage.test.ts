import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResponseCacheStorage,
  type ResponseCacheEntry,
  ResponseCacheRegistry,
} from "../../src/responsecache/index.js";
import { runMigrations } from "../../src/responsecache/storage.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-responsecache-"));
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseEntry(overrides: Partial<ResponseCacheEntry> = {}): ResponseCacheEntry {
  return {
    sha: "sha-1",
    model: "Qwen",
    workload: "",
    workloadEpoch: "",
    protocolVariant: "openai",
    contentType: "application/json",
    statusCode: 200,
    responseBody: new TextEncoder().encode('{"ok":true}'),
    requestBodyBytes: 64,
    responseBodyBytes: 32,
    createdAt: 1,
    lastUsed: 1,
    hits: 0,
    ...overrides,
  };
}

function lookupParams(
  overrides: Partial<{
    sha: string;
    model: string;
    workload: string;
    workloadEpoch: string;
    protocolVariant: "openai" | "anthropic";
  }> = {},
): {
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant: "openai" | "anthropic";
} {
  return {
    sha: "sha-1",
    model: "Qwen",
    workload: "",
    workloadEpoch: "",
    protocolVariant: "openai" as const,
    ...overrides,
  };
}

test("schema migration creates schema_version=2 and response_entries columns", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(2);
    const table = storage.db
      .query(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'response_entries'
      LIMIT 1
    `,
      )
      .get() as { name: string } | null;
    expect(table?.name).toBe("response_entries");
    const columns = storage.db.query("PRAGMA table_info('response_entries')").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toEqual([
      "sha",
      "model",
      "workload",
      "workload_epoch",
      "protocol_variant",
      "content_type",
      "status_code",
      "response_body",
      "request_body_bytes",
      "response_body_bytes",
      "created_at",
      "last_used",
      "hits",
    ]);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("migration from v0 to v1 preserves inserted rows", () => {
  const t = makeTempRoot();
  try {
    const cacheDir = join(t.root, "responsecache");
    mkdirSync(cacheDir, { recursive: true });
    const db = new Database(join(cacheDir, "responses.db"));
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    db.query("INSERT INTO schema_version (version) VALUES (0)").run();
    runMigrations(db, 0, 1);
    db.query(
      `
      INSERT INTO response_entries (
        sha, model, content_type, status_code, response_body,
        request_body_bytes, response_body_bytes, created_at, last_used, hits
      ) VALUES (
        'sha-legacy', 'Legacy', 'application/json', 200, x'7B7D',
        2, 2, 1, 1, 0
      )
    `,
    ).run();
    db.close();

    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    const row = registry.findBySha(lookupParams({ sha: "sha-legacy", model: "Legacy" }));
    expect(row).not.toBeNull();
    expect(row?.model).toBe("Legacy");
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(2);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("v1 rows migrate to unknown scope defaults and do not match typed scope lookups", () => {
  const t = makeTempRoot();
  try {
    const cacheDir = join(t.root, "responsecache");
    mkdirSync(cacheDir, { recursive: true });
    const db = new Database(join(cacheDir, "responses.db"));
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    db.query("INSERT INTO schema_version (version) VALUES (1)").run();
    db.run(`
      CREATE TABLE response_entries (
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
    db.query(
      `
      INSERT INTO response_entries (
        sha, model, content_type, status_code, response_body,
        request_body_bytes, response_body_bytes, created_at, last_used, hits
      ) VALUES (
        'sha-v1', 'Legacy', 'application/json', 200, x'7B7D',
        2, 2, 1, 1, 0
      )
    `,
    ).run();
    db.close();

    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    expect(
      registry.findBySha(
        lookupParams({
          sha: "sha-v1",
          model: "Legacy",
          workload: "wl-a",
          workloadEpoch: "epoch-a",
        }),
      ),
    ).toBeNull();
    expect(
      registry.findBySha(
        lookupParams({
          sha: "sha-v1",
          model: "Legacy",
        }),
      ),
    ).not.toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("responsecache migrations are idempotent after a restart replays the same version", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    storage.close();

    const reopened = openResponseCacheStorage(t.root);
    const version = reopened.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(2);
    const columns = reopened.db.query("PRAGMA table_info('response_entries')").all() as {
      name: string;
    }[];
    expect(columns.some((column) => column.name === "hits")).toBe(true);
    reopened.close();
  } finally {
    t.cleanup();
  }
});

test("responsecache migration recovers when schema_version lags behind already-added tables", () => {
  const t = makeTempRoot();
  try {
    const cacheDir = join(t.root, "responsecache");
    mkdirSync(cacheDir, { recursive: true });
    const db = new Database(join(cacheDir, "responses.db"));
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    db.query("INSERT INTO schema_version (version) VALUES (0)").run();
    db.run(`
      CREATE TABLE response_entries (
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
    db.close();

    const storage = openResponseCacheStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(2);
    const row = storage.db
      .query(
        `
      SELECT sha, model, hits
      FROM response_entries
      LIMIT 1
    `,
      )
      .get() as { sha: string; model: string; hits: number } | null;
    expect(row).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("openResponseCacheStorage closes the db handle when migrate() throws on a newer schema", () => {
  const t = makeTempRoot();
  try {
    const cacheDir = join(t.root, "responsecache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "responses.db");
    // Seed a schema_version GREATER than the code's SCHEMA_VERSION (2) so
    // migrate() throws "newer than supported" during open.
    const seed = new Database(dbPath);
    seed.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    seed.query("INSERT INTO schema_version (version) VALUES (99)").run();
    seed.close();

    const closeSpy = spyOn(Database.prototype, "close");
    try {
      expect(() => openResponseCacheStorage(t.root)).toThrow(/newer than supported/);
      // The handle opened inside openResponseCacheStorage must be closed on
      // the failure path so it does not leak (WAL lock + fd leak otherwise).
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }

    // Hermetic proof the lock is released: a subsequent in-process open of
    // the same path must not hang on a lingering WAL lock. We bump the
    // seeded version down to a supported value so this open succeeds.
    const fix = new Database(dbPath);
    fix.query("UPDATE schema_version SET version = 2").run();
    fix.close();
    const reopened = openResponseCacheStorage(t.root);
    expect(reopened.db).toBeDefined();
    reopened.close();
  } finally {
    t.cleanup();
  }
});

test("openResponseCacheStorage enables WAL mode", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const mode = storage.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    expect(mode?.journal_mode.toLowerCase()).toBe("wal");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("ResponseCacheRegistry CRUD and bumpHit round-trip", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    registry.insert(baseEntry({ sha: "roundtrip", hits: 2, lastUsed: 100 }));

    const inserted = registry.findBySha(lookupParams({ sha: "roundtrip" }));
    expect(inserted?.hits).toBe(2);
    expect(inserted?.lastUsed).toBe(100);

    registry.bumpHit(lookupParams({ sha: "roundtrip" }), 250);
    const bumped = registry.findBySha(lookupParams({ sha: "roundtrip" }));
    expect(bumped?.hits).toBe(3);
    expect(bumped?.lastUsed).toBe(250);

    expect(registry.tryDelete(lookupParams({ sha: "roundtrip" }))).toBe(true);
    expect(registry.findBySha(lookupParams({ sha: "roundtrip" }))).toBeNull();
    expect(registry.tryDelete(lookupParams({ sha: "roundtrip" }))).toBe(false);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("in-process counters exist and are mutable", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    expect(storage.response_cache_hit_total).toBe(0);
    expect(storage.response_cache_miss_total).toBe(0);
    expect(storage.response_cache_evict_total).toBe(0);
    storage.response_cache_hit_total += 1;
    storage.response_cache_miss_total += 2;
    storage.response_cache_evict_total += 3;
    expect(storage.response_cache_hit_total).toBe(1);
    expect(storage.response_cache_miss_total).toBe(2);
    expect(storage.response_cache_evict_total).toBe(3);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("openResponseCacheStorage creates <dataRoot>/responsecache directory on first open", () => {
  const t = makeTempRoot();
  try {
    const cacheDir = join(t.root, "responsecache");
    expect(existsSync(cacheDir)).toBe(false);
    const storage = openResponseCacheStorage(t.root);
    expect(existsSync(cacheDir)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});
