// #278 (DF-05): the forced-unload lease audit persists into the node-local
// residency store so the history survives a serving-process restart, and
// residencyStatus merges the store rows with any live in-memory entries the
// store is missing, so a quietly failed sink write never hides an entry.
// The store module gains RESIDENCY_LEASE_AUDIT_RETENTION,
// RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS, createResidencyLeaseAuditSink and
// readResidencyLeaseAudit with the fix; at the pinned base the exports are
// absent, so every case fails by assertion on the typeof/value probes
// before the unimplemented API is touched.
import {
  createResidencyLeases,
  type ResidencyAuditEntry,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeResidencyLeaseAudit } from "../../src/residency/procedures.js";
import { router } from "../../src/router.js";
import { existsSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";

const STORE_MODULE = "../../src/residency/store.js";

type LeaseAuditSink = {
  onAudit: (entry: ResidencyAuditEntry) => void;
  close: () => void;
};

type AuditStoreModule = {
  RESIDENCY_LEASE_AUDIT_RETENTION: number;
  RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS: number;
  createResidencyLeaseAuditSink: (input: {
    path: string;
    busyTimeoutMs?: number;
  }) => LeaseAuditSink;
  readResidencyLeaseAudit: (path: string) => ResidencyAuditEntry[];
};

type LeaseWorkloadRow = {
  workload: string;
  phase: "open" | "draining" | "unloaded";
  epoch: number;
  activeLeaseCount: number;
  waiters: number;
};

type LeaseAuditRow = {
  workload: string;
  epoch: number;
  forced: true;
  revokedCount: number;
  reason: string | null;
};

type LeasesSection =
  | { status: "unavailable"; scope: "serving-process" }
  | {
      status: "available";
      scope: "serving-process";
      workloads: LeaseWorkloadRow[];
      auditCount: number;
      recentAudit: LeaseAuditRow[];
    };

type AvailableLeases = Extract<LeasesSection, { status: "available" }>;

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-lease-audit-"));
  storePath = join(tmp, "residency-state", "operations.sqlite");
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

async function loadAuditStore(): Promise<AuditStoreModule | null> {
  try {
    const mod: unknown = await import(STORE_MODULE);
    return mod as AuditStoreModule;
  } catch {
    return null;
  }
}

function leasesWithAudit(onAudit: (entry: ResidencyAuditEntry) => void): ResidencyLeases {
  return createResidencyLeases({ onAudit });
}

type Token = Parameters<ResidencyLeases["commitUnload"]>[0];

function drainOnly(reg: ResidencyLeases, workload: string, leases = 1): Token {
  for (let i = 0; i < leases; i += 1) {
    const got = reg.acquire(workload);
    if (!got.ok) {
      throw new Error(`acquire(${workload}) refused: ${got.reason}`);
    }
  }
  const drain = reg.beginDrain(workload);
  if (!drain.ok) {
    throw new Error(`beginDrain(${workload}) refused: ${drain.reason}`);
  }
  return drain.token;
}

function forceUnload(
  reg: ResidencyLeases,
  workload: string,
  opts?: { reason?: string; leases?: number },
): ReturnType<ResidencyLeases["commitUnload"]> {
  return reg.commitUnload(drainOnly(reg, workload, opts?.leases), {
    force: true,
    ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

async function leasesStatus(): Promise<LeasesSection> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyStatus");
  const caller = router.createCaller({}) as unknown as {
    residencyStatus: (input: { node: string }) => Promise<{ leases: LeasesSection }>;
  };
  const r = await caller.residencyStatus({ node: "local" });
  return r.leases;
}

function expectAvailable(leases: LeasesSection): AvailableLeases {
  expect(leases.status).toBe("available");
  if (leases.status !== "available") {
    throw new Error("expected an available leases section");
  }
  return leases;
}

describe("residency lease audit persistence", () => {
  test("forced-unload entries persist in order; the sink opens lazily; close stops writes", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");
    const readAudit = mod!.readResidencyLeaseAudit;

    const sink = mod!.createResidencyLeaseAuditSink({ path: storePath });
    expect(existsSync(storePath)).toBe(false);

    const reg = leasesWithAudit((entry) => {
      sink.onAudit(entry);
    });
    expect(forceUnload(reg, "a", { reason: "r-a" })).toEqual({
      ok: true,
      revoked: ["a#1"],
    });
    expect(forceUnload(reg, "b")).toEqual({ ok: true, revoked: ["b#1"] });
    expect(forceUnload(reg, "c", { reason: "r-c", leases: 2 })).toEqual({
      ok: true,
      revoked: ["c#1", "c#2"],
    });

    expect(readAudit(storePath)).toEqual(reg.audit());
    const rows = readAudit(storePath);
    expect(rows).toHaveLength(3);
    expect("reason" in rows[1]!).toBe(false);

    sink.close();
    expect(readAudit(storePath)).toEqual(reg.audit());

    expect(forceUnload(reg, "d")).toEqual({ ok: true, revoked: ["d#1"] });
    expect(reg.audit()).toHaveLength(4);
    expect(readAudit(storePath)).toHaveLength(3);
  });

  test("retention keeps the newest 500", async () => {
    const mod = await loadAuditStore();
    expect(mod?.RESIDENCY_LEASE_AUDIT_RETENTION).toBe(500);
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");

    const sink = mod!.createResidencyLeaseAuditSink({ path: storePath });
    for (let i = 0; i < 505; i += 1) {
      const name = `w${String(i).padStart(3, "0")}`;
      sink.onAudit({ workload: name, epoch: i, forced: true, revoked: [`w${String(i)}#1`] });
    }

    const rows = mod!.readResidencyLeaseAudit(storePath);
    expect(rows).toHaveLength(500);
    expect(rows[0]?.workload).toBe("w005");
    expect(rows[499]?.workload).toBe("w504");

    const ro = new Database(storePath, { readonly: true });
    try {
      const row = ro.query("SELECT COUNT(*) AS n FROM lease_audit").get() as {
        n: number;
      } | null;
      expect(row?.n).toBe(500);
    } finally {
      ro.close();
    }
  });

  test("restart: status merges store rows with the live audit, so pre-restart entries survive the next forced unload", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");

    const sinkA = mod!.createResidencyLeaseAuditSink({ path: storePath });
    const regA = leasesWithAudit((entry) => {
      sinkA.onAudit(entry);
    });
    expect(forceUnload(regA, "gone-model", { reason: "gc" })).toEqual({
      ok: true,
      revoked: ["gone-model#1"],
    });
    sinkA.close();

    const sinkB = mod!.createResidencyLeaseAuditSink({ path: storePath });
    const regB = leasesWithAudit((entry) => {
      sinkB.onAudit(entry);
    });
    setResidencyLeaseRegistry(regB);

    const first = expectAvailable(await leasesStatus());
    expect(first.auditCount).toBe(1);
    expect(first.recentAudit).toEqual([
      { workload: "gone-model", epoch: 1, forced: true, revokedCount: 1, reason: "gc" },
    ]);
    expect(first.workloads).toContainEqual({
      workload: "gone-model",
      phase: "open",
      epoch: 0,
      activeLeaseCount: 0,
      waiters: 0,
    });

    expect(forceUnload(regB, "fresh", { reason: "new" })).toEqual({
      ok: true,
      revoked: ["fresh#1"],
    });
    const second = expectAvailable(await leasesStatus());
    expect(second.recentAudit).toEqual([
      { workload: "gone-model", epoch: 1, forced: true, revokedCount: 1, reason: "gc" },
      { workload: "fresh", epoch: 1, forced: true, revokedCount: 1, reason: "new" },
    ]);
    expect(second.auditCount).toBe(2);

    setResidencyLeaseRegistry(null);
    expect(await leasesStatus()).toEqual({ status: "unavailable", scope: "serving-process" });
  });

  test("live fallback when the store is absent; the reader never creates or migrates", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");
    const readAudit = mod!.readResidencyLeaseAudit;

    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    expect(forceUnload(reg, "x", { reason: "live" })).toEqual({
      ok: true,
      revoked: ["x#1"],
    });

    const leases = expectAvailable(await leasesStatus());
    expect(leases.recentAudit).toEqual([
      { workload: "x", epoch: 1, forced: true, revokedCount: 1, reason: "live" },
    ]);
    expect(leases.auditCount).toBe(1);
    expect(existsSync(storePath)).toBe(false);

    const absent = join(tmp, "absent.sqlite");
    expect(readAudit(absent)).toEqual([]);
    expect(existsSync(absent)).toBe(false);

    const empty = join(tmp, "empty.sqlite");
    const db = new Database(empty);
    db.close();
    expect(readAudit(empty)).toEqual([]);
    const ro = new Database(empty, { readonly: true });
    try {
      expect(ro.query("SELECT name FROM sqlite_master").all()).toEqual([]);
    } finally {
      ro.close();
    }
  });

  test("a locked store costs at most the short audit busy timeout and never fails the unload", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS).toBe("number");
    const busyTimeoutMs = mod!.RESIDENCY_LEASE_AUDIT_BUSY_TIMEOUT_MS;
    expect(busyTimeoutMs).toBeGreaterThan(0);
    expect(busyTimeoutMs).toBeLessThanOrEqual(1000);
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");
    const readAudit = mod!.readResidencyLeaseAudit;

    const sink = mod!.createResidencyLeaseAuditSink({ path: storePath });
    const reg = leasesWithAudit((entry) => {
      sink.onAudit(entry);
    });
    expect(forceUnload(reg, "w1")).toEqual({ ok: true, revoked: ["w1#1"] });
    expect(readAudit(storePath)).toHaveLength(1);

    const holder = new Database(storePath);
    holder.run("BEGIN IMMEDIATE");
    const token = drainOnly(reg, "w2");
    const t0 = performance.now();
    const committed = reg.commitUnload(token, { force: true });
    const elapsedMs = performance.now() - t0;
    expect(committed).toEqual({ ok: true, revoked: ["w2#1"] });
    expect(elapsedMs).toBeLessThan(3000);
    expect(reg.audit()).toHaveLength(2);

    holder.run("ROLLBACK");
    holder.close();
    const rows = readAudit(storePath);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workload).toBe("w1");
    sink.close();
  }, 30_000);

  test("status shows a live entry whose sink write failed on a locked store, in order", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");
    const readAudit = mod!.readResidencyLeaseAudit;

    const sink = mod!.createResidencyLeaseAuditSink({ path: storePath });
    const reg = leasesWithAudit((entry) => {
      sink.onAudit(entry);
    });
    setResidencyLeaseRegistry(reg);
    expect(forceUnload(reg, "w1", { reason: "first" })).toEqual({
      ok: true,
      revoked: ["w1#1"],
    });

    const holder = new Database(storePath);
    holder.run("BEGIN IMMEDIATE");
    try {
      expect(forceUnload(reg, "w2", { reason: "locked" })).toEqual({
        ok: true,
        revoked: ["w2#1"],
      });
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }

    expect(reg.audit()).toHaveLength(2);
    expect(readAudit(storePath)).toHaveLength(1);

    const leases = expectAvailable(await leasesStatus());
    expect(leases.auditCount).toBe(2);
    expect(leases.recentAudit).toEqual([
      { workload: "w1", epoch: 1, forced: true, revokedCount: 1, reason: "first" },
      { workload: "w2", epoch: 1, forced: true, revokedCount: 1, reason: "locked" },
    ]);
    sink.close();
  }, 30_000);

  test("status lists an entry held by both the store and the live audit once", async () => {
    const mod = await loadAuditStore();
    expect(typeof mod?.createResidencyLeaseAuditSink).toBe("function");
    expect(typeof mod?.readResidencyLeaseAudit).toBe("function");

    const sink = mod!.createResidencyLeaseAuditSink({ path: storePath });
    const reg = leasesWithAudit((entry) => {
      sink.onAudit(entry);
    });
    setResidencyLeaseRegistry(reg);
    expect(forceUnload(reg, "dup", { reason: "both" })).toEqual({
      ok: true,
      revoked: ["dup#1"],
    });
    expect(mod!.readResidencyLeaseAudit(storePath)).toEqual(reg.audit());

    const leases = expectAvailable(await leasesStatus());
    expect(leases.auditCount).toBe(1);
    expect(leases.recentAudit).toEqual([
      { workload: "dup", epoch: 1, forced: true, revokedCount: 1, reason: "both" },
    ]);
    sink.close();
  });
});

describe("mergeResidencyLeaseAudit", () => {
  const e = (workload: string, epoch = 1, reason?: string): ResidencyAuditEntry => ({
    workload,
    epoch,
    forced: true,
    revoked: [`${workload}#1`],
    ...(reason !== undefined ? { reason } : {}),
  });

  test("either source alone passes through", () => {
    expect(mergeResidencyLeaseAudit([], [e("a")])).toEqual([e("a")]);
    expect(mergeResidencyLeaseAudit([e("a")], [])).toEqual([e("a")]);
    expect(mergeResidencyLeaseAudit([], [])).toEqual([]);
  });

  test("dedupes shared entries and slots unpersisted live entries chronologically", () => {
    const persisted = [e("old"), e("a"), e("c")];
    const live = [e("a"), e("b"), e("c"), e("d")];
    expect(mergeResidencyLeaseAudit(persisted, live)).toEqual([
      e("old"),
      e("a"),
      e("b"),
      e("c"),
      e("d"),
    ]);
  });

  test("an unpersisted live entry before every persisted live entry lands ahead of it", () => {
    expect(mergeResidencyLeaseAudit([e("old"), e("b")], [e("a"), e("b")])).toEqual([
      e("old"),
      e("a"),
      e("b"),
    ]);
  });

  test("the key includes epoch and reason; a pre-restart duplicate is matched newest first", () => {
    expect(mergeResidencyLeaseAudit([e("w", 1, "x")], [e("w", 2, "x")])).toEqual([
      e("w", 1, "x"),
      e("w", 2, "x"),
    ]);
    expect(mergeResidencyLeaseAudit([e("w", 1, "x")], [e("w", 1, "y")])).toEqual([
      e("w", 1, "x"),
      e("w", 1, "y"),
    ]);
    expect(mergeResidencyLeaseAudit([e("w")], [e("w"), e("w")])).toEqual([e("w"), e("w")]);
    expect(mergeResidencyLeaseAudit([e("w"), e("v"), e("w")], [e("w")])).toEqual([
      e("w"),
      e("v"),
      e("w"),
    ]);
  });
});
