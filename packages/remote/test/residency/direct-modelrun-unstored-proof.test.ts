// Part of #517
/**
 * #517 — RED tests for unstored ModelRun proof: a run the agent started
 * through `serverStart` has no manifest in its own workloads dir, but its
 * `llama-server.state` sidecar still identifies it as a ModelRun. Every
 * ModelRun target names a missing .gguf, so startServer returns
 * `Model file not found` before any spawn — the lifecycle row and the
 * predicate are the only things under test. At base the predicate treats
 * the manifest-less name as neither a ModelRun nor a live keep-alive
 * workload, so every case fails BY ASSERTION on the predicate's answer,
 * the refused start, the kept row or the missing log line — never by an
 * import, type or exit code. All state lives in mkdtemp dirs; the only
 * process is a reaped spawnSync child used as a dead pid.
 */
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { keepAlive, server } from "@llamactl/core";
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
  runProfileSwitchBootRecovery,
} from "../../src/residency/boot-recovery.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { directWorkloadProvenDown, router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type Fence = { ownerId: string; incarnation: string; fenceToken: number };
type SeedRow = { model: string; target: ResidencyState; group?: string };
type RunStartResult = {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  advertisedEndpoint: string;
  tunedProfile: string | null;
  retried: boolean;
  error?: string;
};

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let runtimeDir = "";
let modelsDir = "";

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

// Walks each row along legal edges under a fence claimed by the
// apply-profile owner, passing the group only on the 'loading' hop. Every
// hop is stamped atMs (default NOW); only the last hop's stamp survives as
// the row's updatedAtMs, which is the progress clock the boot-recovery
// age gate reads.
function seed(rows: readonly SeedRow[], opts?: { atMs?: number }): Fence {
  const atMs = opts?.atMs ?? NOW;
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
          nowMs: atMs,
        });
        expect(result.ok).toBe(true);
      }
    }
    return fence;
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function writeRun(name: string, group: string): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: group },
      },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: `${name}/missing.gguf` },
      },
    }),
    workloadsDir,
  );
}

// serverStart is a subscription: collect the stream and take the done
// event's result (the last one wins if a wrapper ever emits its own).
async function startRun(name: string): Promise<RunStartResult> {
  const stream = await router
    .createCaller({})
    .serverStart({ workload: name, target: `${name}/missing.gguf` });
  let result: RunStartResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: RunStartResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`serverStart(${name}) stream ended without a done event`);
  }
  return result;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += chunk.toString();
    return true;
  };
  return {
    text: () => captured,
    restore: (): void => {
      process.stderr.write = original;
    },
  };
}

// Records a dead, already-reaped pid as the workload's llama-server pid:
// spawnSync waits for the child and collects its status, so kill(pid, 0)
// reads ESRCH on macOS and Linux — the residue a crashed llama-server
// leaves behind. Returns the pid file's path.
function writeDeadPid(name: string): string {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) {
    throw new Error("spawnSync reported no child pid");
  }
  const pidDir = join(runtimeDir, "workloads", name);
  mkdirSync(pidDir, { recursive: true });
  const pidPath = join(pidDir, "llama-server.pid");
  writeFileSync(pidPath, `${String(pid)}\n`);
  expect(server.readServerPid({ name })).toBe(pid);
  return pidPath;
}

// Records this test process as the workload's llama-server pid: alive,
// but not a llama-server, so the identity check reads unknown.
function writeLivePid(name: string): string {
  const pidDir = join(runtimeDir, "workloads", name);
  mkdirSync(pidDir, { recursive: true });
  const pidPath = join(pidDir, "llama-server.pid");
  writeFileSync(pidPath, `${String(process.pid)}\n`);
  expect(server.readServerPid({ name })).toBe(process.pid);
  return pidPath;
}

function recordedPid(name: string): number {
  const pid = server.readServerPid({ name });
  expect(pid).not.toBeNull();
  return pid!;
}

function writeSidecar(name: string, pid: number): void {
  const dir = join(runtimeDir, "workloads", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify(
      {
        rel: `${name}/missing.gguf`,
        extraArgs: [],
        host: "127.0.0.1",
        port: "18080",
        binary: "",
        pid,
        startedAt: new Date(NOW).toISOString(),
        tunedProfile: null,
      },
      null,
      2,
    ),
  );
  expect(server.readServerState({ name })).not.toBeNull();
}

// Turns a propagated throw into a failing value, so a fail-closed case that
// leaks its error fails BY ASSERTION instead of as an uncaught test error.
function provenDownOrThrown(name: string): boolean | string {
  try {
    return directWorkloadProvenDown(name);
  } catch (e) {
    return e instanceof Error ? `threw: ${e.message}` : "threw";
  }
}

beforeEach(() => {
  // Null registries keep fenceWorkloadStop on its pass-through path: these
  // cases pin the residency lifecycle rows and the proven-down predicate,
  // not lease/session fencing, and a registry leaked by another file must
  // not refuse the stop.
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-modelrun-identity-"));
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
    LLAMACTL_NODE_NAME: "local",
  });
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

describe("unstored ModelRun proven-down (#517)", () => {
  // Part of #517. Kills: deleting the `|| unstoredModelRunRecorded(model)`
  // disjunct, dropping the sidecar requirement, dropping the ModelHost-runtime
  // exclusion, and dropping the keep-alive exclusion.
  test("UP1: directWorkloadProvenDown proves an unstored ModelRun down by its server sidecar and fails closed otherwise", () => {
    const deadPath = writeDeadPid("run-x");
    writeSidecar("run-x", recordedPid("run-x"));

    expect(directWorkloadProvenDown("run-x")).toBe(true);
    expect(existsSync(deadPath)).toBe(true);

    writeLivePid("run-live");
    writeSidecar("run-live", process.pid);
    expect(directWorkloadProvenDown("run-live")).toBe(false);

    writeDeadPid("run-nosidecar");
    expect(directWorkloadProvenDown("run-nosidecar")).toBe(false);

    writeDeadPid("run-host");
    writeSidecar("run-host", recordedPid("run-host"));
    writeFileSync(
      join(runtimeDir, "workloads", "run-host", "modelhost.pid"),
      `${String(process.pid)}\n`,
    );
    expect(directWorkloadProvenDown("run-host")).toBe(false);

    writeDeadPid("run-ka");
    writeSidecar("run-ka", recordedPid("run-ka"));
    writeFileSync(
      join(runtimeDir, "llama-keep-alive.state"),
      "target=run-ka\nmodel=x.gguf\nstate=ready\n",
    );
    writeFileSync(join(runtimeDir, "llama-keep-alive.pid"), `${String(process.pid)}\n`);
    expect(directWorkloadProvenDown("run-ka")).toBe(false);

    expect(directWorkloadProvenDown("ghost-run")).toBe(false);
  });

  // Part of #517. Kills: the same disjunct removal at the start-side reconcile.
  test("UP2: a same-group start reconciles a crashed unstored ModelRun's ready row", async () => {
    writeRun("run-a", GROUP);
    seed([{ model: "run-b", target: "ready", group: GROUP }]);
    writeDeadPid("run-b");
    writeSidecar("run-b", recordedPid("run-b"));
    const stderr = captureStderr();
    try {
      const result = await startRun("run-a");

      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/^Model file not found:/);
      expect(readState("run-b")).toMatchObject({ state: "downloaded", group: GROUP });
      expect(stderr.text()).toContain(
        "[residency] lifecycle reconciled stale run-b ready -> downloaded in group z13-large-gpu",
      );
    } finally {
      stderr.restore();
    }
  });

  // Part of #517. Kills: the disjunct removal on the boot-recovery path.
  test("UP3: boot orphan sweep fails a stale unstored ModelRun ready row", () => {
    seed([{ model: "run-b", target: "ready", group: GROUP }], { atMs: 1_000_000 });
    writeDeadPid("run-b");
    writeSidecar("run-b", recordedPid("run-b"));
    const writes: string[] = [];

    runProfileSwitchBootRecovery({
      path: defaultResidencyStorePath(),
      incarnation: "u3",
      nowMs: () => 1_000_000 + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
      write: (line): void => {
        writes.push(line);
      },
      isProvenDown: directWorkloadProvenDown,
    });

    expect(readState("run-b")).toMatchObject({ state: "failed", group: GROUP });
    expect(
      writes.some(
        (line) =>
          line.startsWith("[residency] lifecycle boot recovery") && line.includes('"failed":1'),
      ),
    ).toBe(true);
  });

  // Part of #905. Kills: (a) requiring a pid file for the unstored-ModelRun
  // identity (`serverMod.readServerPid(key) === null` in the sidecar guard) and
  // (b) dropping the `modelhost.state` runtime exclusion, i.e. only the no-pid-file
  // branch of isServerProvenDown and only `modelhost.pid` would prove down.
  test("UP4: a sidecar with no pid file is proven down, and a sidecar beside only modelhost.state fails closed", () => {
    writeSidecar("run-stateonly", 424242);
    expect(server.readServerPid({ name: "run-stateonly" })).toBeNull();
    expect(directWorkloadProvenDown("run-stateonly")).toBe(true);

    const name = "run-hoststate";
    writeDeadPid(name);
    writeSidecar(name, recordedPid(name));
    expect(directWorkloadProvenDown(name)).toBe(true);

    writeFileSync(join(runtimeDir, "workloads", name, "modelhost.state"), "{}");
    expect(directWorkloadProvenDown(name)).toBe(false);
  });

  // Part of #905. Kills: turning unstoredModelRunRecorded's `catch { return false }`
  // into a rethrow, on the first statement of its try (the sidecar read). The
  // sidecar is written before the spy lands, because writeSidecar reads it back
  // through the same function.
  test("UP5a: a throw from the sidecar read fails closed", () => {
    writeDeadPid("run-throw");
    writeSidecar("run-throw", recordedPid("run-throw"));
    expect(provenDownOrThrown("run-throw")).toBe(true);

    const spy = spyOn(server, "readServerState").mockImplementation(() => {
      throw new Error("boom-state");
    });
    try {
      expect(provenDownOrThrown("run-throw")).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Part of #905. Kills: the same rethrow on the last statement of the try (the
  // keep-alive read). keepAliveWorkloadProvenDown also hits the spy on the
  // fall-through path, but its own catch keeps the answer false.
  test("UP5b: a throw from the keep-alive read fails closed", () => {
    writeDeadPid("run-throw-ka");
    writeSidecar("run-throw-ka", recordedPid("run-throw-ka"));
    expect(provenDownOrThrown("run-throw-ka")).toBe(true);

    const spy = spyOn(keepAlive, "readKeepAliveState").mockImplementation(() => {
      throw new Error("boom-ka");
    });
    try {
      expect(provenDownOrThrown("run-throw-ka")).toBe(false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
