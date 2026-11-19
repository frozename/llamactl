import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for identity-based ModelRun proof: the remaining scope
 * the direct-lifecycle slice left open. `directWorkloadProvenDown` must
 * prove a ModelRun down through `serverMod.isServerProvenDown` — the same
 * recorded-pid identity check `stopServer` uses — instead of reading any
 * recorded pid file as still alive, so a same-group `ready` peer whose
 * llama-server is dead or recycled reconciles to downloaded, and the
 * boot-recovery orphan sweep can fail its stale interrupted row through
 * the real predicate. Every ModelRun target names a missing .gguf, so
 * startServer returns `Model file not found` before any spawn — the
 * lifecycle row and the predicate are the only things under test. At base
 * the predicate keeps `readServerPid(...) === null`, so every case fails
 * BY ASSERTION on the refused start, the predicate's answer, the kept
 * row or the missing log line — never by an import, type or exit code.
 * All state lives in mkdtemp dirs; the only process is a reaped
 * spawnSync child used as a dead pid.
 */
import { server } from "@llamactl/core";
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

describe("ModelRun identity-based proven-down (#517)", () => {
  // Part of #517. kills: directWorkloadProvenDown keeping
  // `readServerPid(...) === null` — a ready peer whose recorded pid is
  // dead must reconcile to downloaded instead of refusing the start.
  test("IP1: a same-group ready peer with a dead pid reconciles before the group check", async () => {
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "ready", group: GROUP }]);
    writeDeadPid("run-b");
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

  // Part of #517. kills: a predicate that reaps via serverStatus /
  // resolveTrackedServerPid (the pid file must survive the read), and one
  // that counts an unverifiable identity or an unknown workload as down.
  test("IP2: directWorkloadProvenDown answers through the recorded-pid identity", () => {
    writeRun("run-b", GROUP);
    writeRun("run-c", GROUP);
    const deadPath = writeDeadPid("run-b");
    const livePath = writeLivePid("run-c");

    expect(directWorkloadProvenDown("run-b")).toBe(true);
    expect(existsSync(deadPath)).toBe(true);
    expect(directWorkloadProvenDown("run-c")).toBe(false);
    expect(existsSync(livePath)).toBe(true);
    expect(directWorkloadProvenDown("ghost-run")).toBe(false);
  });

  // Part of #517. kills: the orphan sweep's proven-down gate staying on
  // the pid-file-only rule — a stale interrupted row whose workload's
  // recorded pid is dead must fail through the real predicate.
  test("IP3: boot recovery sweeps an orphaned loading row through the real predicate", () => {
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "loading", group: GROUP }], { atMs: 1_000_000 });
    writeDeadPid("run-b");
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path: defaultResidencyStorePath(),
      incarnation: "i2",
      nowMs: () => 1_000_000 + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
      write: (line): void => {
        writes.push(line);
      },
      isProvenDown: directWorkloadProvenDown,
    });

    expect(summary.status).toBe("clean");
    expect(readState("run-b")).toMatchObject({ state: "failed", group: GROUP });
    expect(writes).toEqual([
      '[residency] lifecycle boot recovery {"failed":1,"recordFailures":0}\n',
    ]);
  });
});
