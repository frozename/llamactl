import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KvEntry, KvRegistry, openKvStorage } from "../src/kvstore/index.js";
import { runMigrations } from "../src/kvstore/storage.js";
import { resolveEnv } from "../src/env.js";
import { workloadRuntimeRoot } from "../src/workloadRuntime.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-"));
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseEntry(overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: "abc123",
    workload: "wl-a",
    model: null,
    upstreamSlotFile: "/tmp/slot.bin",
    quantBits: 8,
    tokens: 2048,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000,
    lastUsed: 1716576000,
    payloadBytes: 1024,
    textBytes: 512,
    reason: "cold",
    prefixByteLength: 256,
    workloadEpoch: "epoch-1",
    quarantined: 0,
    state: "idle",
    firstResponseToken: null,
    extFlags: 0,
    ...overrides,
  };
}

test("schema migration creates schema_version=5 and kv_entries columns", () => {
  const t = makeTempRoot();
  try {
    const storage = openKvStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    const table = storage.db
      .query(
        `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'kv_entries'
      LIMIT 1
    `,
      )
      .get() as { name: string } | null;
    expect(table?.name).toBe("kv_entries");
    const columns = storage.db.query("PRAGMA table_info('kv_entries')").all() as {
      name: string;
    }[];
    expect(columns.map((c) => c.name)).toEqual([
      "sha",
      "workload",
      "upstream_slot_file",
      "quant_bits",
      "tokens",
      "ctx_size",
      "hits",
      "created_at",
      "last_used",
      "payload_bytes",
      "text_bytes",
      "reason",
      "prefix_byte_length",
      "workload_epoch",
      "quarantined",
      "state",
      "first_response_token",
      "ext_flags",
      "model",
    ]);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("schema is preserved across reopens with existing rows", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");

    const first = openKvStorage(t.root);
    const firstRegistry = new KvRegistry(first);
    firstRegistry.insert(baseEntry({ sha: "keep-me", upstreamSlotFile: slotFile }));
    first.close();

    const second = openKvStorage(t.root);
    const secondRegistry = new KvRegistry(second);
    const row = secondRegistry.get("keep-me");
    expect(row).not.toBeNull();
    expect(row?.upstreamSlotFile).toBe(slotFile);
    const version = second.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    second.close();
  } finally {
    t.cleanup();
  }
});

test("migration from v3 to v4 adds ext_flags column with 0 default", () => {
  const t = makeTempRoot();
  try {
    const kvDir = join(t.root, "kvstore");
    mkdirSync(kvDir, { recursive: true });
    const dbPath = join(kvDir, "registry.db");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `);
    db.query("INSERT INTO schema_version (version) VALUES (0)").run();
    runMigrations(db, 0, 3);
    db.query(
      `
      INSERT INTO kv_entries (
        sha, workload, upstream_slot_file, quant_bits, tokens, ctx_size, hits,
        created_at, last_used, payload_bytes, text_bytes, reason,
        prefix_byte_length, workload_epoch, quarantined, state, first_response_token
      ) VALUES (
        'legacy-sha', 'wl-a', '/tmp/legacy.slot', 8, 123, 32768, 0,
        1, 1, 10, 5, 'cold', 64, 'epoch-legacy', 0, 'idle', NULL
      )
    `,
    ).run();
    db.close();

    const storage = openKvStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    const row = storage.db
      .query(
        `
      SELECT state, first_response_token, ext_flags
      FROM kv_entries
      WHERE sha = ?
    `,
      )
      .get("legacy-sha") as {
      state: string;
      first_response_token: string | null;
      ext_flags: number;
    } | null;
    expect(row?.state).toBe("idle");
    expect(row?.first_response_token).toBeNull();
    expect(row?.ext_flags).toBe(0);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("migration from v4 to v5 adds model column defaulting to NULL for legacy rows", () => {
  const t = makeTempRoot();
  try {
    const kvDir = join(t.root, "kvstore");
    mkdirSync(kvDir, { recursive: true });
    const dbPath = join(kvDir, "registry.db");
    const db = new Database(dbPath);
    db.run("PRAGMA journal_mode = WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `);
    db.query("INSERT INTO schema_version (version) VALUES (0)").run();
    runMigrations(db, 0, 4);
    db.query(
      `
      INSERT INTO kv_entries (
        sha, workload, upstream_slot_file, quant_bits, tokens, ctx_size, hits,
        created_at, last_used, payload_bytes, text_bytes, reason,
        prefix_byte_length, workload_epoch, quarantined, state, first_response_token, ext_flags
      ) VALUES (
        'legacy-sha', 'wl-a', '/tmp/legacy.slot', 8, 123, 32768, 0,
        1, 1, 10, 5, 'cold', 64, 'epoch-legacy', 0, 'idle', NULL, 0
      )
    `,
    ).run();
    db.close();

    const storage = openKvStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    const row = storage.db
      .query("SELECT model FROM kv_entries WHERE sha = ?")
      .get("legacy-sha") as { model: string | null } | null;
    expect(row?.model ?? null).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("kvstore migrations are idempotent after a restart replays the same version", () => {
  const t = makeTempRoot();
  try {
    const storage = openKvStorage(t.root);
    storage.close();

    const reopened = openKvStorage(t.root);
    const version = reopened.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    const columns = reopened.db.query("PRAGMA table_info('kv_entries')").all() as {
      name: string;
    }[];
    expect(columns.some((column) => column.name === "ext_flags")).toBe(true);
    reopened.close();
  } finally {
    t.cleanup();
  }
});

test("kvstore migration recovers when schema_version lags behind already-added columns", () => {
  const t = makeTempRoot();
  try {
    const kvDir = join(t.root, "kvstore");
    mkdirSync(kvDir, { recursive: true });
    const db = new Database(join(kvDir, "registry.db"));
    db.run("PRAGMA journal_mode = WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `);
    db.query("INSERT INTO schema_version (version) VALUES (3)").run();
    db.run(`
      CREATE TABLE kv_entries (
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
        quarantined INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','reserved','active')),
        first_response_token TEXT,
        ext_flags INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.close();

    const storage = openKvStorage(t.root);
    const version = storage.db.query("SELECT version FROM schema_version LIMIT 1").get() as {
      version: number;
    } | null;
    expect(version?.version).toBe(5);
    const columns = storage.db.query("PRAGMA table_info('kv_entries')").all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).toContain("state");
    expect(columns.map((column) => column.name)).toContain("first_response_token");
    expect(columns.map((column) => column.name)).toContain("ext_flags");
    expect(columns.map((column) => column.name)).toContain("model");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("integrity scan quarantines rows with missing upstream_slot_file on open", () => {
  const t = makeTempRoot();
  try {
    const missingFile = join(t.root, "does-not-exist.slot");
    const first = openKvStorage(t.root);
    const firstRegistry = new KvRegistry(first);
    firstRegistry.insert(baseEntry({ sha: "missing", upstreamSlotFile: missingFile }));
    first.close();

    const second = openKvStorage(t.root);
    const secondRegistry = new KvRegistry(second);
    const row = secondRegistry.get("missing");
    expect(row?.quarantined).toBe(1);
    expect(second.registry_integrity_errors_total).toBe(1);
    second.close();
  } finally {
    t.cleanup();
  }
});

test("integrity scan self-heals quarantined rows when the slot file reappears and purges stale quarantines after grace", () => {
  const t = makeTempRoot();
  try {
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const missing = join(t.root, "missing.slot");
    const healed = join(t.root, "healed.slot");
    writeFileSync(healed, "payload");
    registry.insert(
      baseEntry({
        sha: "missing",
        upstreamSlotFile: missing,
        quarantined: 1,
        lastUsed: Date.now() - 1000 * 60 * 60 * 25,
      }),
    );
    registry.insert(
      baseEntry({ sha: "healed", upstreamSlotFile: healed, quarantined: 1, lastUsed: Date.now() }),
    );
    storage.close();

    const reopened = openKvStorage(t.root);
    const healedRow = new KvRegistry(reopened).get("healed");
    expect(healedRow?.quarantined).toBe(0);
    const missingRow = new KvRegistry(reopened).get("missing");
    expect(missingRow).toBeNull();
    reopened.close();
  } finally {
    t.cleanup();
  }
});

test("openKvStorage sets busy_timeout to 5000", () => {
  const t = makeTempRoot();
  try {
    const storage = openKvStorage(t.root);
    const row = storage.db.query("PRAGMA busy_timeout").get() as { timeout: number } | null;
    expect(row?.timeout).toBe(5000);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("openKvStorage enables WAL mode", () => {
  const t = makeTempRoot();
  try {
    const storage = openKvStorage(t.root);
    const mode = storage.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    expect(mode?.journal_mode.toLowerCase()).toBe("wal");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("KvRegistry CRUD and bumpHit round-trip", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);

    registry.insert(
      baseEntry({ sha: "roundtrip", upstreamSlotFile: slotFile, hits: 2, lastUsed: 100 }),
    );
    const inserted = registry.get("roundtrip");
    expect(inserted?.hits).toBe(2);
    expect(inserted?.lastUsed).toBe(100);

    registry.bumpHit("roundtrip", 200);
    const bumped = registry.get("roundtrip");
    expect(bumped?.hits).toBe(3);
    expect(bumped?.lastUsed).toBe(200);

    expect(registry.delete("roundtrip")).toBe(true);
    expect(registry.get("roundtrip")).toBeNull();
    expect(registry.delete("roundtrip")).toBe(false);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("openKvStorage creates <dataRoot>/kvstore directory on first open", () => {
  const t = makeTempRoot();
  try {
    const kvDir = join(t.root, "kvstore");
    expect(existsSync(kvDir)).toBe(false);
    const storage = openKvStorage(t.root);
    expect(existsSync(kvDir)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("kv metadata writes do not change workloadRuntimeRoot mtimeNs", () => {
  const t = makeTempRoot();
  try {
    const runtimeDir = join(t.root, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const resolved = resolveEnv({
      DEV_STORAGE: t.root,
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
    });
    const root = workloadRuntimeRoot(resolved);
    mkdirSync(root, { recursive: true });

    const before = statSync(root, { bigint: true }).mtimeNs;

    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(runtimeDir);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "mtime", upstreamSlotFile: slotFile }));
    storage.close();

    const after = statSync(root, { bigint: true }).mtimeNs;
    expect(after).toBe(before);
  } finally {
    t.cleanup();
  }
});
