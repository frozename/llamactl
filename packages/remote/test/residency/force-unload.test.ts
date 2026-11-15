// #278 (DF-05) AC3: the operator forced-unload path. A pure helper revokes
// held leases through the fencing drain token, commits the unload, stops the
// engine and audits with an "operator: "-prefixed reason; the
// residencyForceUnload tRPC mutation classifies the workload kind
// (ModelRun/ModelHost), gates on confirm:true and persists the audit through
// the #686 sink. Neither seam exists at the pinned base: the helper module is
// probed through a guarded dynamic import and the procedure through the
// untyped _def lookup, so every case fails by assertion, never by a missing
// module, a thrown TRPCError or a type error.
import {
  createResidencyLeases,
  type Lease,
  type ResidencyAuditEntry,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createResidencyLeaseAuditSink,
  readResidencyLeaseAudit,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { saveWorkload } from "../../src/workload/store.js";

const MOD = "../../src/residency/force-unload.js";

type ForceUnloadKind = "modelrun" | "modelhost";

type ForceUnloadResult = {
  ok: boolean;
  workload?: string;
  kind?: string;
  source?: string;
  reason?: string;
  detail?: string;
  revoked?: string[];
  stopped?: boolean;
  epoch?: number;
};

type ForceUnloadStop = () => Promise<{ stopped: boolean; detail?: string }>;

type ForceUnloadOpts = {
  workload: string;
  reason: string;
  kind: ForceUnloadKind | null;
  registry: ResidencyLeases | null;
  stop: ForceUnloadStop;
};

type ForceUnloadModule = {
  forceUnloadWorkload: (opts: ForceUnloadOpts) => Promise<ForceUnloadResult>;
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
      workloads: unknown[];
      auditCount: number;
      recentAudit: LeaseAuditRow[];
    };

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-force-unload-"));
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

async function loadForceUnload(): Promise<ForceUnloadModule> {
  const mod = (await import(MOD).catch(() => ({}))) as Record<string, unknown>;
  expect(typeof mod["forceUnloadWorkload"]).toBe("function");
  return mod as unknown as ForceUnloadModule;
}

function acquireLease(reg: ResidencyLeases, workload: string): Lease {
  const got = reg.acquire(workload);
  if (!got.ok) {
    throw new Error(`acquire(${workload}) refused: ${got.reason}`);
  }
  return got.lease;
}

function okStop(): ForceUnloadStop {
  return () => Promise.resolve({ stopped: true });
}

function modelRunManifest(name: string): Parameters<typeof saveWorkload>[0] {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "fake-org/run.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      resources: { expectedMemoryGiB: 12 },
      endpoint: { host: "127.0.0.1", port: 8199 },
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function modelHostManifest(name: string): Parameters<typeof saveModelHost>[0] {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name, labels: {} },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: "/usr/local/bin/omlx",
      endpoint: { host: "127.0.0.1", port: 8182 },
      hostedModels: [{ rel: "acme/model.gguf" }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

describe("forceUnloadWorkload", () => {
  test("revokes held leases, commits the unload and audits with the operator reason", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();

    const onAudit = mock((_entry: ResidencyAuditEntry): void => undefined);
    const reg = createResidencyLeases({ onAudit });
    const lease1 = acquireLease(reg, "w1");
    const lease2 = acquireLease(reg, "w1");
    expect([lease1.id, lease2.id]).toEqual(["w1#1", "w1#2"]);

    const stopCalls: number[] = [];
    let abortedInStop: boolean[] = [];
    const stop: ForceUnloadStop = () => {
      stopCalls.push(1);
      abortedInStop = [lease1.signal.aborted, lease2.signal.aborted];
      return Promise.resolve({ stopped: true });
    };

    const result = await forceUnloadWorkload({
      workload: "w1",
      reason: "oom on gpu1",
      kind: "modelrun",
      registry: reg,
      stop,
    });

    expect(result).toMatchObject({
      ok: true,
      workload: "w1",
      kind: "modelrun",
      source: "operator",
      reason: "oom on gpu1",
      revoked: ["w1#1", "w1#2"],
      stopped: true,
    });
    expect(result.epoch).toBe(reg.snapshot("w1").epoch);

    expect(lease1.signal.aborted).toBe(true);
    expect(lease2.signal.aborted).toBe(true);
    expect(reg.snapshot("w1")).toMatchObject({ phase: "unloaded", active: [] });

    const audit = reg.audit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      workload: "w1",
      forced: true,
      revoked: ["w1#1", "w1#2"],
      reason: "operator: oom on gpu1",
    });
    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(onAudit.mock.calls[0]?.[0]).toEqual(audit[0]);

    expect(stopCalls).toHaveLength(1);
    expect(abortedInStop).toEqual([true, true]);
  });

  test("no registry -> typed Unavailable, engine untouched", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();
    const stop = mock(okStop());

    const result = await forceUnloadWorkload({
      workload: "w1",
      reason: "r",
      kind: "modelrun",
      registry: null,
      stop,
    });

    expect(result).toMatchObject({ ok: false, reason: "Unavailable", workload: "w1" });
    expect(typeof result.detail).toBe("string");
    expect(result.detail).toContain("lease registry");
    expect(stop).not.toHaveBeenCalled();
  });

  test("unknown workload -> typed UnknownWorkload", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();
    const reg = createResidencyLeases();
    const stop = mock(okStop());

    const result = await forceUnloadWorkload({
      workload: "ghost",
      reason: "r",
      kind: null,
      registry: reg,
      stop,
    });

    expect(result).toMatchObject({ ok: false, reason: "UnknownWorkload", workload: "ghost" });
    expect(stop).not.toHaveBeenCalled();
    expect(reg.snapshot("ghost")).toMatchObject({ phase: "open", epoch: 0 });
  });

  test("stop failure reopens admission and reports StopFailed", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();

    const reg = createResidencyLeases();
    const lease = acquireLease(reg, "w1");
    const result = await forceUnloadWorkload({
      workload: "w1",
      reason: "r",
      kind: "modelrun",
      registry: reg,
      stop: () => Promise.resolve({ stopped: false, detail: "pid identity unknown" }),
    });
    expect(result).toMatchObject({ ok: false, reason: "StopFailed", revoked: ["w1#1"] });
    expect(typeof result.detail).toBe("string");
    expect(result.detail).toContain("pid identity unknown");
    expect(lease.signal.aborted).toBe(true);
    expect(reg.acquire("w1").ok).toBe(true);
    expect(reg.audit()).toHaveLength(1);
    expect(reg.audit()[0]?.forced).toBe(true);

    const reg2 = createResidencyLeases();
    acquireLease(reg2, "w2");
    const thrown = await forceUnloadWorkload({
      workload: "w2",
      reason: "r",
      kind: "modelrun",
      registry: reg2,
      stop: () => Promise.reject(new Error("boom")),
    });
    expect(thrown).toMatchObject({ ok: false, reason: "StopFailed", revoked: ["w2#1"] });
    expect(reg2.acquire("w2").ok).toBe(true);
    expect(reg2.audit()).toHaveLength(1);
  });

  test("drain in progress -> DrainInProgress; already unloaded -> AlreadyUnloaded", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();
    const reg = createResidencyLeases();
    const stop = mock(okStop());

    const drain = reg.beginDrain("w1");
    if (!drain.ok) {
      throw new Error(`beginDrain(w1) refused: ${drain.reason}`);
    }
    const busy = await forceUnloadWorkload({
      workload: "w1",
      reason: "r",
      kind: "modelrun",
      registry: reg,
      stop,
    });
    expect(busy).toMatchObject({ ok: false, reason: "DrainInProgress", workload: "w1" });
    expect(stop).not.toHaveBeenCalled();

    const drain2 = reg.beginDrain("w2");
    if (!drain2.ok) {
      throw new Error(`beginDrain(w2) refused: ${drain2.reason}`);
    }
    expect(reg.commitUnload(drain2.token)).toEqual({ ok: true, revoked: [] });
    const done = await forceUnloadWorkload({
      workload: "w2",
      reason: "r",
      kind: "modelrun",
      registry: reg,
      stop,
    });
    expect(done).toMatchObject({ ok: false, reason: "AlreadyUnloaded", workload: "w2" });
    expect(stop).not.toHaveBeenCalled();
  });

  test("idle workload: no leases held -> ok with revoked [] and no audit entry", async () => {
    const { forceUnloadWorkload } = await loadForceUnload();
    const onAudit = mock((_entry: ResidencyAuditEntry): void => undefined);
    const reg = createResidencyLeases({ onAudit });

    const result = await forceUnloadWorkload({
      workload: "w1",
      reason: "r",
      kind: "modelrun",
      registry: reg,
      stop: okStop(),
    });

    expect(result).toMatchObject({ ok: true, workload: "w1", revoked: [] });
    expect(reg.audit()).toHaveLength(0);
    expect(onAudit).not.toHaveBeenCalled();
  });
});

describe("residencyForceUnload procedure", () => {
  function forceUnloadCaller(): {
    residencyForceUnload: (input: {
      workload: string;
      reason: string;
      confirm?: boolean;
    }) => Promise<ForceUnloadResult>;
  } {
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyForceUnload");
    return router.createCaller({}) as unknown as {
      residencyForceUnload: (input: {
        workload: string;
        reason: string;
        confirm?: boolean;
      }) => Promise<ForceUnloadResult>;
    };
  }

  async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error("expected the mutation to reject");
  }

  async function forceUnload(input: {
    workload: string;
    reason: string;
    confirm?: boolean;
  }): Promise<ForceUnloadResult> {
    const caller = forceUnloadCaller();
    return await caller.residencyForceUnload(input);
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

  test("mutation revokes the lease, unloads, audits and persists through the sink", async () => {
    saveWorkload(modelRunManifest("w1"), tmp);
    const sink = createResidencyLeaseAuditSink({ path: storePath });
    try {
      const reg = createResidencyLeases({ onAudit: sink.onAudit });
      setResidencyLeaseRegistry(reg);
      const lease = acquireLease(reg, "w1");

      const result = await forceUnload({
        workload: "w1",
        reason: "operator drill",
        confirm: true,
      });

      expect(result).toMatchObject({
        ok: true,
        workload: "w1",
        kind: "modelrun",
        source: "operator",
      });
      expect(result.revoked).toEqual(["w1#1"]);
      expect(lease.signal.aborted).toBe(true);
      expect(reg.snapshot("w1").phase).toBe("unloaded");

      const rows = readResidencyLeaseAudit(storePath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        workload: "w1",
        epoch: 1,
        forced: true,
        revoked: ["w1#1"],
        reason: "operator: operator drill",
      });

      const leases = await leasesStatus();
      expect(leases.status).toBe("available");
      if (leases.status !== "available") {
        throw new Error("expected an available leases section");
      }
      expect(leases.recentAudit).toContainEqual({
        workload: "w1",
        epoch: 1,
        forced: true,
        revokedCount: 1,
        reason: "operator: operator drill",
      });
    } finally {
      sink.close();
    }
  });

  test("confirm gate: omitted, false and blank reason all reject BAD_REQUEST", async () => {
    saveWorkload(modelRunManifest("w1"), tmp);
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const lease = acquireLease(reg, "w1");

    expect(
      await rejectionOf(forceUnload({ workload: "w1", reason: "operator drill" })),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await rejectionOf(forceUnload({ workload: "w1", reason: "operator drill", confirm: false })),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await rejectionOf(forceUnload({ workload: "w1", reason: "   ", confirm: true })),
    ).toMatchObject({ code: "BAD_REQUEST" });

    expect(lease.signal.aborted).toBe(false);
    expect(reg.snapshot("w1").phase).toBe("open");
  });

  test("unknown workload and missing registry resolve typed refusals", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const ghost = await forceUnload({ workload: "ghost", reason: "r", confirm: true });
    expect(ghost).toMatchObject({ ok: false, reason: "UnknownWorkload", workload: "ghost" });

    setResidencyLeaseRegistry(null);
    saveWorkload(modelRunManifest("w1"), tmp);
    const unavailable = await forceUnload({ workload: "w1", reason: "r", confirm: true });
    expect(unavailable).toMatchObject({ ok: false, reason: "Unavailable", workload: "w1" });
  });

  test("a saved ModelHost classifies as modelhost and unloads with no leases held", async () => {
    saveModelHost(modelHostManifest("mh1"), tmp);
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);

    const result = await forceUnload({ workload: "mh1", reason: "r", confirm: true });

    expect(result).toMatchObject({ ok: true, kind: "modelhost", source: "operator" });
    expect(reg.snapshot("mh1").phase).toBe("unloaded");
  });
});
