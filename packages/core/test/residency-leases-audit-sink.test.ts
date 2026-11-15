// #278 (DF-05): durability extension of AC3 — the lease registry gains an
// optional onAudit sink invoked once per forced-unload audit entry, after
// the in-memory auditLog push. The sink receives a copy, and a throwing sink
// never fails commitUnload.
import { describe, expect, test } from "bun:test";

import {
  createResidencyLeases,
  type ResidencyAuditEntry,
  type ResidencyLeases,
} from "../src/residency/leases.js";

function registryWithAuditSink(onAudit: (entry: ResidencyAuditEntry) => void): ResidencyLeases {
  return createResidencyLeases({ onAudit });
}

function forceUnload(
  reg: ResidencyLeases,
  workload: string,
  reason?: string,
): ReturnType<ResidencyLeases["commitUnload"]> {
  const got = reg.acquire(workload);
  if (!got.ok) {
    throw new Error(`acquire(${workload}) refused: ${got.reason}`);
  }
  const drain = reg.beginDrain(workload);
  if (!drain.ok) {
    throw new Error(`beginDrain(${workload}) refused: ${drain.reason}`);
  }
  return reg.commitUnload(drain.token, {
    force: true,
    ...(reason !== undefined ? { reason } : {}),
  });
}

describe("residency lease audit sink", () => {
  test("onAudit receives each forced-unload entry once, in order, after the in-memory push", () => {
    const calls: { entry: ResidencyAuditEntry; lenAtCall: number }[] = [];
    const reg: ResidencyLeases = registryWithAuditSink((entry) => {
      calls.push({ entry, lenAtCall: reg.audit().length });
    });

    expect(forceUnload(reg, "glm", "operator")).toEqual({
      ok: true,
      revoked: ["glm#1"],
    });

    const qwenDrain = reg.beginDrain("qwen");
    if (!qwenDrain.ok) {
      throw new Error(`beginDrain(qwen) refused: ${qwenDrain.reason}`);
    }
    expect(reg.commitUnload(qwenDrain.token)).toEqual({ ok: true, revoked: [] });

    expect(forceUnload(reg, "mimo")).toEqual({ ok: true, revoked: ["mimo#1"] });

    const emptyDrain = reg.beginDrain("empty");
    if (!emptyDrain.ok) {
      throw new Error(`beginDrain(empty) refused: ${emptyDrain.reason}`);
    }
    expect(reg.commitUnload(emptyDrain.token, { force: true })).toEqual({
      ok: true,
      revoked: [],
    });

    expect(calls.map((c) => c.entry)).toEqual(reg.audit());
    expect(calls.map((c) => c.lenAtCall)).toEqual([1, 2]);
    expect(reg.audit()).toEqual([
      {
        workload: "glm",
        epoch: 1,
        forced: true,
        revoked: ["glm#1"],
        reason: "operator",
      },
      { workload: "mimo", epoch: 1, forced: true, revoked: ["mimo#1"] },
    ]);
    expect("reason" in calls[1]!.entry).toBe(false);
  });

  test("a throwing onAudit never fails commitUnload", () => {
    const calls: ResidencyAuditEntry[] = [];
    const reg = registryWithAuditSink((entry) => {
      calls.push(entry);
      throw new Error("sink down");
    });

    expect(forceUnload(reg, "w")).toEqual({ ok: true, revoked: ["w#1"] });
    expect(forceUnload(reg, "v")).toEqual({ ok: true, revoked: ["v#1"] });
    expect(calls).toHaveLength(2);
    expect(reg.audit()).toHaveLength(2);
    expect(reg.snapshot("w").phase).toBe("unloaded");
  });

  test("the sink receives a copy", () => {
    const calls: ResidencyAuditEntry[] = [];
    const reg = registryWithAuditSink((entry) => {
      calls.push(entry);
      entry.revoked.push("tampered");
      entry.workload = "x";
    });

    expect(forceUnload(reg, "w")).toEqual({ ok: true, revoked: ["w#1"] });
    expect(calls).toHaveLength(1);
    expect(reg.audit()[0]).toEqual({
      workload: "w",
      epoch: 1,
      forced: true,
      revoked: ["w#1"],
    });
  });
});
