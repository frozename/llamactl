// #519: residency lease activity timestamps. The lease registry gains an
// injectable clock (`now`) and a `lastActivityAtMs(workload)` read-out so the
// residency status idle-eviction section can tell "ready but recently used"
// from "ready and idle". At the pinned base the option is ignored and the
// method does not exist, so every case fails BY ASSERTION on the runtime
// probe — never by import or type error.
import { describe, expect, test } from "bun:test";

import { createResidencyLeases, type ResidencyLeases } from "../src/residency/leases.js";

type ActivityProbe = { lastActivityAtMs?: (workload: string) => number };

function registryWithClock(now: () => number): ResidencyLeases {
  return createResidencyLeases({ now });
}

function lastActivityAtMs(reg: ResidencyLeases, workload: string): number {
  const probe = reg as unknown as ActivityProbe;
  expect(typeof probe.lastActivityAtMs).toBe("function");
  return probe.lastActivityAtMs!(workload);
}

describe("residency lease activity timestamps (#519)", () => {
  test("L1: an unseen workload reports the registry creation time", () => {
    // Kills: lastActivityAtMs missing, or not seeded with the creation time
    // (e.g. seeded with the first query time or 0).
    let t = 1000;
    const reg = registryWithClock(() => t);
    t = 4000;
    expect(lastActivityAtMs(reg, "w")).toBe(1000);
  });

  test("L2: a successful acquire stamps the activity time", () => {
    // Kills: no stamp on acquire.
    let t = 1000;
    const reg = registryWithClock(() => t);
    t = 2000;
    const got = reg.acquire("w");
    expect(got.ok).toBe(true);
    expect(lastActivityAtMs(reg, "w")).toBe(2000);
  });

  test("L3: a successful release stamps; a no-op release does not", () => {
    // Kills: no stamp on release, or stamping a release that removed
    // nothing.
    let t = 1000;
    const reg = registryWithClock(() => t);
    t = 2000;
    const got = reg.acquire("w");
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("acquire(w) refused");
    }
    t = 5000;
    expect(got.lease.release()).toBe(true);
    expect(lastActivityAtMs(reg, "w")).toBe(5000);
    t = 9000;
    expect(got.lease.release()).toBe(false);
    expect(lastActivityAtMs(reg, "w")).toBe(5000);
  });

  test("L4: a refused acquire during drain does not stamp", () => {
    // Kills: stamping activity before the phase check in acquire.
    let t = 1000;
    const reg = registryWithClock(() => t);
    t = 3000;
    const drain = reg.beginDrain("w");
    expect(drain.ok).toBe(true);
    const before = lastActivityAtMs(reg, "w");
    t = 7000;
    const refused = reg.acquire("w");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("Draining");
    }
    expect(lastActivityAtMs(reg, "w")).toBe(before);
  });

  test("L5: without a now option the stamp uses the wall clock", () => {
    // Kills: the typeof probe at base; once present, a creation-time seed
    // outside [before, after] or a per-call Date.now() on read.
    const before = Date.now();
    const reg = createResidencyLeases();
    const after = Date.now();
    const value = lastActivityAtMs(reg, "w");
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  test("L6: activity is tracked per workload", () => {
    // Kills: a single shared stamp across workloads.
    let t = 1000;
    const reg = registryWithClock(() => t);
    t = 2000;
    const got = reg.acquire("a");
    expect(got.ok).toBe(true);
    expect(lastActivityAtMs(reg, "a")).toBe(2000);
    expect(lastActivityAtMs(reg, "b")).toBe(1000);
  });
});
