// #519: residencyEvictIdle — the router mutation that runs the idle
// eviction on the serving node. A bare { node } call is the dry run: it
// reports the window and the would-evict rows without touching anything.
// { node, targets } is the wet run: each target is re-checked against the
// live lease registry, then stopped through the same fenced path
// serverStop/modelHostStop use — lifecycle walk plus lease drain — with a
// skipped/StopRefused/StopFailed row instead of an eviction whenever the
// stop cannot complete. The durable idle hold itself is stamped and
// released by the CLI around this call, so the procedure tests pin rows,
// lifecycle and lease state only. At the pinned base the procedure is not
// registered, so every case fails BY ASSERTION on the _def probe — never
// by import, type or caller error.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { readModelHostState, writeModelHostState } from "@llamactl/core/engines/state";
import {
  createResidencyLeases,
  type ResidencyLeases,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { loadWorkloadByName, saveWorkload } from "../../src/workload/store.js";

const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const NODE = "local";
const NOW = 1_000_000_000;
const IDLE_EVICTED_AT = "llamactl.io/idle-evicted-at";

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type Fence = { ownerId: string; incarnation: string; fenceToken: number };
type SeedRow = { model: string; target: ResidencyState; group?: string };

type EvictIdleKind = "modelrun" | "modelhost";
type EvictIdleTarget = { workload: string; kind: EvictIdleKind };
type EvictIdleInput = { node: string; targets?: readonly EvictIdleTarget[] };
type EvictIdleRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: EvictIdleKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};
type EvictIdleResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: EvictIdleRow[] };

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let runtimeDir = "";
let modelsDir = "";
let leases: ResidencyLeases;

const storePath = (): string => defaultResidencyStorePath();

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
    case "warming":
    case "draining":
    case "unloading":
    case "failed":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

// Same fenced seed the direct-lifecycle suites use: claim the store
// ownership, then walk each row along legal edges at the fixed past clock
// so the idle window is long past due against the real Date.now().
function seed(rows: readonly SeedRow[]): void {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const row of rows) {
      for (const to of seedPathTo(row.target)) {
        const result = store.transitionResidencyState({
          fenceToken: fence.fenceToken,
          model: row.model,
          ...(to === "loading" && row.group !== undefined ? { group: row.group } : {}),
          to,
          expectedVersion: store.getResidencyState(row.model)?.version ?? 0,
          nowMs: NOW,
        });
        expect(result.ok).toBe(true);
      }
    }
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    return store.getResidencyState(model);
  } finally {
    store.close();
  }
}

function writeNodeRun(name: string, residency?: { idleEvictSeconds: number }): void {
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name, labels: {} },
      spec: {
        node: name,
        ...(residency === undefined ? {} : { residency }),
        infra: [],
      },
    },
    workloadsDir,
  );
}

function writeRun(name: string): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: GROUP },
      },
      spec: {
        node: NODE,
        enabled: true,
        restartPolicy: "Always",
        target: { kind: "rel", value: `${name}/missing.gguf` },
      },
    }),
    workloadsDir,
  );
}

function writeHost(name: string): void {
  const binary = join(root, "fake-omlx");
  writeFileSync(binary, "");
  saveModelHost(
    parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${name}
  labels:
    ${GROUP_LABEL}: ${GROUP}
spec:
  engine: omlx
  node: ${NODE}
  enabled: true
  binary: ${binary}
  endpoint:
    host: 127.0.0.1
    port: 18097
  hostedModels:
    - rel: ${name}.gguf
`),
    workloadsDir,
  );
}

// A ModelHost sidecar whose recorded pid is this test process: alive, but not
// the engine binary, so stopModelHost's identity check reads unknown and it
// returns ok:false with "pid identity unknown", keeping the sidecar. The
// ModelRun stopServer path finds no llama-server pid for the same name and
// reports stopped:true, so the two paths are distinguishable.
function writeUnverifiableHostSidecar(name: string): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "omlx",
      pid: process.pid,
      host: "127.0.0.1",
      port: 18097,
      modelAliases: [name],
      startedAt: new Date().toISOString(),
    },
    { name },
  );
}

// Records this test process as the ModelRun's llama-server pid: alive, so
// stopServer reads it, but not a llama-server, so its identity check reads
// unknown and it returns stopped:false (not refused) with the pid kept.
function writeUnverifiableRunPid(name: string): string {
  const pidDir = join(runtimeDir, "workloads", name);
  mkdirSync(pidDir, { recursive: true });
  const pidPath = join(pidDir, "llama-server.pid");
  writeFileSync(pidPath, `${String(process.pid)}\n`);
  return pidPath;
}

// Every router case opens with the registration probe: the procedure must
// exist in _def before the caller is built, so a missing procedure fails
// here by assertion rather than as a caller TypeError.
function evictIdleCaller(): (input: EvictIdleInput) => Promise<EvictIdleResult> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyEvictIdle");
  const caller = router.createCaller({}) as unknown as {
    residencyEvictIdle: (input: EvictIdleInput) => Promise<EvictIdleResult>;
  };
  return (input) => caller.residencyEvictIdle(input);
}

function rowFor(result: EvictIdleResult, workload: string): EvictIdleRow | undefined {
  return result.ok ? result.rows.find((row) => row.workload === workload) : undefined;
}

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-evict-idle-"));
  workloadsDir = join(root, "workloads");
  runtimeDir = join(root, "runtime");
  modelsDir = join(root, "models");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMACTL_CONFIG: join(root, "config-missing"),
    LLAMACTL_NODE_NAME: NODE,
  });
  // The registry clock is pinned at the same past instant the lifecycle
  // rows are seeded with, so lastActivityAtMs reports NOW until real
  // traffic stamps it; Date.now() is always far past NOW + 60s, so the
  // seeded ready row is due.
  leases = createResidencyLeases({ now: () => NOW });
  setResidencyLeaseRegistry(leases);
  writeNodeRun(NODE, { idleEvictSeconds: 60 });
  writeRun("w1");
  seed([{ model: "w1", target: "ready", group: GROUP }]);
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("residencyEvictIdle", () => {
  test("R1: the procedure is registered", () => {
    // kills: shipping the CLI without the router procedure.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyEvictIdle");
  });

  test("R2: a bare { node } call is a dry run that changes nothing", async () => {
    // kills: a dry run that stops, stamps the hold or walks the lifecycle.
    const evict = evictIdleCaller();
    const result = await evict({ node: NODE });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: 60 });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      kind: "modelrun",
    });
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
    expect(
      loadWorkloadByName("w1", workloadsDir).metadata.annotations[IDLE_EVICTED_AT],
    ).toBeUndefined();
  });

  test("R3: a targeted wet call evicts through the fenced stop path", async () => {
    // kills: calling stopServer directly — the lifecycle row must walk to
    // downloaded and the lease registry must commit the unload.
    const evict = evictIdleCaller();
    const result = await evict({
      node: NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, windowSeconds: 60 });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "evicted",
      kind: "modelrun",
    });
    expect(readState("w1")?.state).toBe("downloaded");
    expect(leases.snapshot("w1").phase).toBe("unloaded");
  });

  test("R4: a live session refuses the stop and the row stays ready", async () => {
    // kills: bypassing the session checkUnload inside the stop fence.
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => NOW });
    const acquired = sessions.acquire("s1", "w1");
    expect(acquired.ok).toBe(true);
    setSessionRefcountRegistry(sessions);

    const evict = evictIdleCaller();
    const result = await evict({
      node: NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });
    expect(result.ok).toBe(true);
    const row = rowFor(result, "w1");
    expect(row).toMatchObject({ workload: "w1", action: "skipped", reason: "StopRefused" });
    expect(row?.detail ?? "").toContain("SessionsActive");
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
  });

  test("R5: a NodeRun without residency policy reports Disabled", async () => {
    // kills: a non-default fallback that evicts with no knob configured.
    // 'plain' is also the serving node here so Disabled is the answer under
    // either check order (unset knob vs not-serving).
    writeNodeRun("plain");
    process.env["LLAMACTL_NODE_NAME"] = "plain";
    const evict = evictIdleCaller();
    const result = await evict({ node: "plain" });
    expect(result).toMatchObject({ ok: false, reason: "Disabled" });
    expect(readState("w1")?.state).toBe("ready");
    expect(leases.snapshot("w1").phase).toBe("open");
  });

  test("R6: off the serving node the procedure reports NotServingNode", async () => {
    // kills: running the eviction against a peer's policy or state.
    process.env["LLAMACTL_NODE_NAME"] = "other-node";
    const evict = evictIdleCaller();
    const result = await evict({ node: NODE });
    expect(result).toMatchObject({ ok: false, reason: "NotServingNode" });
    expect(readState("w1")?.state).toBe("ready");
  });

  test("R7: a target with no lifecycle row is skipped NotReady", async () => {
    // kills: stopping a workload the lifecycle store does not track.
    const evict = evictIdleCaller();
    const result = await evict({
      node: NODE,
      targets: [{ workload: "w9", kind: "modelrun" }],
    });
    expect(result.ok).toBe(true);
    expect(rowFor(result, "w9")).toMatchObject({
      workload: "w9",
      action: "skipped",
      reason: "NotReady",
    });
    expect(readState("w1")?.state).toBe("ready");
  });

  test("R8: a modelhost target is stopped through the ModelHost stop path", async () => {
    // kills: dispatching a modelhost target to stopServer (or swapping the
    // kind dispatch) — stopServer finds no llama-server pid for h1 and would
    // report a verified stop, whereas stopModelHost refuses the unverifiable
    // sidecar and keeps it.
    writeHost("h1");
    writeUnverifiableHostSidecar("h1");
    seed([{ model: "h1", target: "ready" }]);

    const evict = evictIdleCaller();
    const result = await evict({
      node: NODE,
      targets: [{ workload: "h1", kind: "modelhost" }],
    });
    expect(result).toMatchObject({ ok: true, dryRun: false });
    expect(rowFor(result, "h1")).toEqual({
      workload: "h1",
      action: "skipped",
      reason: "StopRefused",
      detail: "pid identity unknown",
    });
    expect(readModelHostState({ name: "h1" })).not.toBeNull();
    expect(leases.snapshot("h1").phase).toBe("open");
    expect(readState("h1")?.state).toBe("ready");
  });

  test("R9: an unconfirmed ModelRun stop reopens the fence and never commits the unload", async () => {
    // kills: treating any ModelRun stop result as verified — a stopped:false
    // (not refused) stop must reopen the lease fence, not commit unloaded.
    const pidPath = writeUnverifiableRunPid("w1");

    const evict = evictIdleCaller();
    const result = await evict({
      node: NODE,
      targets: [{ workload: "w1", kind: "modelrun" }],
    });
    expect(result).toMatchObject({ ok: true, dryRun: false });
    expect(rowFor(result, "w1")).toEqual({
      workload: "w1",
      action: "skipped",
      reason: "StopRefused",
      detail: "stop did not confirm process removal",
    });
    expect(leases.snapshot("w1").phase).toBe("open");
    expect(readFileSync(pidPath, "utf8").trim()).toBe(String(process.pid));
    expect(readState("w1")?.state).toBe("ready");
  });
});
