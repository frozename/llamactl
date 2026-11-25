import type { keepAlive } from "@llamactl/core";
// Part of #517 — RED tests proving a crashed keep-alive worker down. A
// keep-alive target has no ModelRun or ModelHost manifest, so the existing
// workload identity checks cannot clear its stale residency row. Post-fix
// `directWorkloadProvenDown` falls through to `keepAliveWorkloadProvenDown`:
// the state file must still belong to that target, the supervisor record must
// be absent or provably gone, and the recorded model's llama-server must be
// proven down. Everything fails closed. All state lives in temp dirs; no
// engine or supervisor process is started.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
  runProfileSwitchBootRecovery,
} from "../../src/residency/boot-recovery.js";
import { runDirectResidencyStart } from "../../src/residency/direct-lifecycle.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import * as routerMod from "../../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type KeepAliveStateSnapshot = ReturnType<typeof keepAlive.readKeepAliveState>;
type KeepAliveRecord = ReturnType<typeof keepAlive.readKeepAliveRecord>;
type KeepAliveWorkloadProvenDownDeps = {
  readState: () => KeepAliveStateSnapshot;
  readRecord: () => KeepAliveRecord;
  isServerProvenDown: (key: { name: string }) => boolean;
};
type KeepAliveWorkloadProvenDown = (
  model: string,
  deps: KeepAliveWorkloadProvenDownDeps,
) => boolean;

const originalEnv = { ...process.env };
let root = "";
let runtimeDir = "";

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

// Walks each row along legal edges under a fence claimed by the apply-profile
// owner, passing the group only on the loading hop. The final hop's stamp is
// the row's updatedAtMs, which the boot-recovery age gate reads.
function seed(
  rows: readonly { model: string; target: ResidencyState; group?: string }[],
  atMs = NOW,
): void {
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

function readRow(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function writeKeepAliveState(target = "current"): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "llama-keep-alive.state"),
    `target=${target}\nmodel=${GLM_REL}\nstate=ready\n`,
  );
}

function loadKeepAliveWorkloadProvenDown(): KeepAliveWorkloadProvenDown {
  const fn = (routerMod as Record<string, unknown>)["keepAliveWorkloadProvenDown"];
  expect(typeof fn).toBe("function");
  return fn as KeepAliveWorkloadProvenDown;
}

function stateFor(target: string | null): KeepAliveStateSnapshot {
  if (target === null) return null;
  return { target, model: GLM_REL, state: "ready" };
}

function recordFor(verdict: KeepAliveRecord["verdict"]): KeepAliveRecord {
  if (verdict === null) return { pid: null, verdict: null };
  return { pid: 4321, verdict };
}

function probeInjected(opts: {
  state?: KeepAliveStateSnapshot;
  record?: KeepAliveRecord;
  serverDown?: boolean;
  throwState?: boolean;
}): boolean {
  const fn = loadKeepAliveWorkloadProvenDown();
  const state = opts.state === undefined ? stateFor("current") : opts.state;
  const record = opts.record ?? recordFor(null);
  const serverDown = opts.serverDown ?? true;
  return fn("current", {
    readState: () => {
      if (opts.throwState === true) throw new Error("state read exploded");
      return state;
    },
    readRecord: () => record,
    isServerProvenDown: () => serverDown,
  });
}

beforeEach(() => {
  // Null registries keep the direct lifecycle on its pass-through path: these
  // cases pin the proven-down predicate and lifecycle rows, not lease/session
  // fencing, and a registry leaked by another file must not change either.
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-keepalive-crash-row-"));
  const workloadsDir = join(root, "workloads");
  runtimeDir = join(root, "runtime");
  mkdirSync(workloadsDir, { recursive: true });
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: join(root, "models"),
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

describe("keep-alive crash row proven down (#517)", () => {
  // Kills: the fall-through `return false` in directWorkloadProvenDown — a
  // keep-alive target is neither a ModelRun nor a ModelHost, so the base
  // never reaches the keep-alive proof.
  test("P1: directWorkloadProvenDown proves a matching keep-alive target down and rejects a mismatch", () => {
    writeKeepAliveState("current");
    expect(routerMod.directWorkloadProvenDown("current")).toBe(true);
    writeKeepAliveState("other");
    expect(routerMod.directWorkloadProvenDown("current")).toBe(false);
  });

  // Kills: skipping the supervisor check, skipping the server check, or not
  // failing closed. The export is absent at base, so the typeof assertion —
  // not an import or type error — is the RED failure.
  test("P2: keepAliveWorkloadProvenDown requires a matching state, a gone supervisor and a down server", () => {
    expect(probeInjected({ record: recordFor(null), serverDown: true })).toBe(true);
    expect(probeInjected({ record: recordFor("dead"), serverDown: true })).toBe(true);
    expect(probeInjected({ record: recordFor("reused"), serverDown: true })).toBe(true);
    expect(probeInjected({ record: recordFor("alive"), serverDown: true })).toBe(false);
    expect(probeInjected({ record: recordFor("unknown"), serverDown: true })).toBe(false);
    expect(probeInjected({ record: recordFor("dead"), serverDown: false })).toBe(false);
    expect(probeInjected({ state: stateFor("other"), serverDown: true })).toBe(false);
    expect(probeInjected({ state: null, serverDown: true })).toBe(false);
    expect(probeInjected({ throwState: true, serverDown: true })).toBe(false);
  });

  // Kills: runDirectResidencyStart still corroborating the crashed keep-alive
  // row as a live occupant. Once it is proven down it is outside
  // occupiedAtPlan, so the lifecycle walk reconciles it before loading qwen.
  test("P3: a same-group start reconciles the crashed keep-alive ready row before loading", async () => {
    seed([{ model: "current", target: "ready", group: GROUP }]);
    writeKeepAliveState("current");
    const lines: string[] = [];
    const outcome = await runDirectResidencyStart(
      "qwen-prod",
      () => Promise.resolve({ ok: true }),
      {
        storePath: storePath(),
        group: GROUP,
        isProvenDown: routerMod.directWorkloadProvenDown,
        isRunning: () => false,
        log: (line) => {
          lines.push(line);
        },
      },
    );

    expect(outcome.ran).toBe(true);
    if (!outcome.ran) throw new Error(`start did not run: ${outcome.detail}`);
    expect(outcome.result.ok).toBe(true);
    expect(readRow("current")).toMatchObject({ state: "downloaded", group: GROUP });
    expect(readRow("qwen-prod")).toMatchObject({ state: "ready", group: GROUP });
    expect(lines.join("")).toContain(
      "[residency] lifecycle reconciled stale current ready -> downloaded in group z13-large-gpu: not observed occupying by the plan\n",
    );
  });

  // Kills: boot recovery keeping the pid-file-only ModelRun/ModelHost gate —
  // a stale ready row owned by a crashed keep-alive target must fail through
  // the same directWorkloadProvenDown fall-through.
  test("P4: boot recovery fails a stale ready row owned by a crashed keep-alive", () => {
    seed([{ model: "current", target: "ready", group: GROUP }], NOW);
    writeKeepAliveState("current");
    const writes: string[] = [];

    const summary = runProfileSwitchBootRecovery({
      path: storePath(),
      incarnation: "boot-test",
      nowMs: () => NOW + PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS,
      write: (line): void => {
        writes.push(line);
      },
      isProvenDown: routerMod.directWorkloadProvenDown,
    });

    expect(summary.status).toBe("clean");
    expect(readRow("current")).toMatchObject({ state: "failed", group: GROUP });
    expect(writes.join("")).toContain(
      '[residency] lifecycle boot recovery {"failed":1,"recordFailures":0}\n',
    );
  });
});
