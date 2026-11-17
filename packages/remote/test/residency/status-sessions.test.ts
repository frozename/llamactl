// #520: bound sessions surface in residency status. buildResidencyStatus
// gains a sessionRegistry input projected into a `sessions` section, and
// the router feeds it currentSessionRefcounts(). The section lands with
// the fix; every non-guard case reads the new payload key through a
// Record cast and fails by assertion at the pinned base (the key is
// absent), never by a missing export or a type error.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  type SessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildResidencyStatus } from "../../src/residency/procedures.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

type BuildInput = Parameters<typeof buildResidencyStatus>[0];

function statusInput(sessionRegistry?: BuildInput["sessionRegistry"]): BuildInput {
  const input: BuildInput = {
    node: "n",
    nodeRun: undefined,
    budgetGiB: 10,
    budgetSource: "computed",
    store: { path: "/p", present: false },
  };
  if (sessionRegistry !== undefined) {
    input.sessionRegistry = sessionRegistry;
  }
  return input;
}

function sessionsOf(built: unknown): unknown {
  return (built as Record<string, unknown>)["sessions"];
}

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-status-sessions-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "residency-state", "operations.sqlite"),
  });
});

afterEach(() => {
  setSessionRefcountRegistry(null);
  setResidencyLeaseRegistry(null);
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("buildResidencyStatus sessions section", () => {
  test("S1 reports NoRegistry when sessionRegistry is null", () => {
    // Kills: section omitted when no registry is installed.
    const built = buildResidencyStatus(statusInput(null));
    expect(sessionsOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "NoRegistry",
    });
  });

  test("S2 projects the registry snapshot rows", () => {
    // Kills: rows not projected from the registry snapshot.
    let t = 0;
    const reg = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => t });
    const inFlight = reg.acquire("s-b", "wl-b");
    expect(inFlight.ok).toBe(true);
    const idle = reg.acquire("s-a", "wl-a");
    if (!idle.ok) throw new Error("acquire(s-a) refused");
    t = 200;
    reg.release("s-a", idle.generation);
    t = 700;
    const built = buildResidencyStatus(statusInput(reg));
    expect(sessionsOf(built)).toEqual({
      status: "available",
      scope: "serving-process",
      idleTimeoutMs: 1000,
      sessions: [
        { sessionId: "s-a", workload: "wl-a", refs: 0, idleMs: 500, expiresInMs: 500 },
        { sessionId: "s-b", workload: "wl-b", refs: 1, idleMs: 700, expiresInMs: null },
      ],
    });
  });

  test("S3 degrades to SessionsUnknown when snapshot throws", () => {
    // Kills: an uncaught throw breaking the whole status query.
    const real = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    const throwing: SessionRefcounts & { snapshot?: () => unknown } = {
      ...real,
      snapshot: () => {
        throw new Error("session registry unreadable");
      },
    };
    const built = buildResidencyStatus(statusInput(throwing));
    expect(sessionsOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "SessionsUnknown",
    });
    expect(built.leases).toEqual({ status: "unavailable", scope: "serving-process" });
  });

  test("S4 reports SnapshotUnsupported when the registry has no snapshot", () => {
    // Kills: treating a missing snapshot as an empty session list.
    const real = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    const bare: SessionRefcounts = {
      acquire: (sessionId, workload) => real.acquire(sessionId, workload),
      release: (sessionId, generation) => {
        real.release(sessionId, generation);
      },
      touch: (sessionId) => {
        real.touch(sessionId);
      },
      forceRelease: (workload) => real.forceRelease(workload),
      activeSessions: (workload) => real.activeSessions(workload),
      checkUnload: (workload, opts) => real.checkUnload(workload, opts),
    };
    const built = buildResidencyStatus(statusInput(bare));
    expect(sessionsOf(built)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "SnapshotUnsupported",
    });
  });

  test("G1 omits the sessions section when sessionRegistry is not passed", () => {
    // GUARD — passes at base: pins that the whole-payload toEqual in
    // status-procedure.test.ts stays unchanged for callers without the key.
    const built = buildResidencyStatus(statusInput());
    expect("sessions" in built).toBe(false);
  });
});

describe("residencyStatus sessions section", () => {
  test("S5 projects the installed registry through the router", async () => {
    // Kills: router not passing currentSessionRefcounts().
    const reg = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => 0 });
    setSessionRefcountRegistry(reg);
    const acq = reg.acquire("s1", "w1");
    expect(acq.ok).toBe(true);
    const caller = router.createCaller({}) as unknown as {
      residencyStatus: (input: { node: string }) => Promise<unknown>;
    };
    const r = await caller.residencyStatus({ node: "n" });
    const sessions = sessionsOf(r) as
      | { status?: string; sessions?: { sessionId?: string }[] }
      | undefined;
    expect(sessions?.status).toBe("available");
    expect(sessions?.sessions?.[0]?.sessionId).toBe("s1");

    setSessionRefcountRegistry(null);
    const r2 = await caller.residencyStatus({ node: "n" });
    expect(sessionsOf(r2)).toEqual({
      status: "unavailable",
      scope: "serving-process",
      reason: "NoRegistry",
    });
  });
});
