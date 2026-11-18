import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for the residencyForceUnload lifecycle slice: the
 * procedure's stop must run inside runDirectResidencyStop after the lease
 * drain commits, so a confirmed force-unload walks the residency_states row
 * ready -> draining -> unloading -> downloaded under the shared
 * apply-profile fence, an unconfirmed stop is never recorded (the row keeps
 * occupying its exclusive group), a stop during an in-flight profile switch
 * runs but records nothing, and a node with no store file never creates one.
 * Both kinds are covered: the ModelRun branch rides directModelRunOpts and
 * the ModelHost branch directResidencyOpts(name, undefined). Every ModelRun
 * target names a missing .gguf and no host is ever started, so the engine
 * stop is trivial — the lifecycle row, fence and stderr are the only things
 * under test. At base the procedure calls stopModelHost/stopServer outside
 * the wrapper, so every case fails BY ASSERTION on the row, fence or stderr
 * — never by import, type or exit code.
 */
import { server } from "@llamactl/core";
import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ForceUnloadResult } from "../../src/residency/force-unload.js";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
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
let fakeBinary = "";

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
// apply-profile owner — the same owner the production lifecycle wrapper
// claims under — passing the group only on the 'loading' hop, the same
// rule the lifecycle walks use. `switchOp` leaves a nonterminal
// profile-switch:local operation row behind, the in-flight marker the
// direct paths must respect.
function seed(rows: readonly SeedRow[], opts?: { switchOp?: boolean }): Fence {
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
    if (opts?.switchOp === true) {
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-seed",
        model: "profile-switch:local",
        targetState: "x",
        desiredRevision: 1,
        reservationGiB: 0,
        nowMs: NOW,
      });
      expect(begun.ok).toBe(true);
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

function readFence(): Fence | null {
  return withStore((store) => store.currentFence());
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

function writeHost(name: string, group: string, port: number): void {
  saveModelHost(
    parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${name}
  labels:
    llamactl.io/residency-group: ${group}
spec:
  engine: omlx
  node: local
  enabled: true
  binary: ${fakeBinary}
  endpoint:
    host: 0.0.0.0
    port: ${String(port)}
  hostedModels:
    - rel: ${name}.gguf
`),
    workloadsDir,
  );
}

// serverStart is a subscription: collect the stream and take the done
// event's result (the last one wins if a wrapper ever emits its own).
async function startRun(
  name: string,
  extra?: { endpoint?: { host?: string; port?: number } },
): Promise<RunStartResult> {
  const stream = await router
    .createCaller({})
    .serverStart({ workload: name, target: `${name}/missing.gguf`, ...extra });
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

// A loopback port nothing listens on: bind an ephemeral port, then release
// it. Any HTTP hop to it is refused locally; nothing off this host is dialled.
function closedLoopbackPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket): void {
        socket.end();
      },
    },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
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

// Makes every residency_states write abort, standing in for a store that
// cannot record (disk full, a corrupt page) while the fence stays claimable.
function blockResidencyWrites(): void {
  const db = new Database(storePath());
  try {
    db.run(
      "CREATE TRIGGER block_residency_update BEFORE UPDATE ON residency_states BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    db.run(
      "CREATE TRIGGER block_residency_insert BEFORE INSERT ON residency_states BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
  } finally {
    db.close();
  }
}

// Records this test process as the ModelRun's llama-server pid: alive, so
// readServerPid returns it, but not a llama-server, so stopServer's identity
// check reads unknown and refuses to signal it.
function writePidFile(name: string): void {
  const pidDir = join(runtimeDir, "workloads", name);
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, "llama-server.pid"), `${String(process.pid)}\n`);
  expect(server.readServerPid({ name })).toBe(process.pid);
}

// A fresh lease registry per call: each force-unload drains and commits at
// its own epoch, so repeated unloads of the same workload never hit
// AlreadyUnloaded from a prior call's committed epoch.
async function forceUnload(name: string): Promise<ForceUnloadResult> {
  setResidencyLeaseRegistry(createResidencyLeases());
  return await router.createCaller({}).residencyForceUnload({
    workload: name,
    reason: "drill",
    confirm: true,
  });
}

beforeEach(() => {
  // Null registries keep the force path on its pass-through seam: these
  // cases pin the residency lifecycle rows, not lease/session fencing, and
  // a registry leaked by another file must not refuse the stop.
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-direct-force-unload-"));
  workloadsDir = join(root, "workloads");
  runtimeDir = join(root, "runtime");
  modelsDir = join(root, "models");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  // omlx validateSpec requires the binary to exist; the stop never spawns,
  // so an empty file is enough.
  fakeBinary = join(root, "fake-omlx");
  writeFileSync(fakeBinary, "");
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

describe("residencyForceUnload direct residency lifecycle", () => {
  test("FU1: a ModelRun force-unload walks the seeded ready row to downloaded under a bumped fence", async () => {
    // kills: the residencyForceUnload ModelRun stop not wrapped in
    // runDirectResidencyStop; dropping the store-existence gate (the first
    // unload must not create the store).
    writeRun("run-a", GROUP);

    const first = await forceUnload("run-a");
    expect(first).toMatchObject({ ok: true, kind: "modelrun", source: "operator" });
    expect(existsSync(storePath())).toBe(false);

    const seedFence = seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("run-a")?.version ?? 0;

    const second = await forceUnload("run-a");
    expect(second).toMatchObject({ ok: true, kind: "modelrun" });

    expect(readState("run-a")).toMatchObject({
      state: "downloaded",
      version: seededVersion + 3,
    });
    const fence = readFence();
    expect(fence?.ownerId).toBe(RESIDENCY_APPLY_PROFILE_FENCE_OWNER);
    expect(fence?.fenceToken ?? 0).toBeGreaterThan(seedFence.fenceToken);
  });

  test("FU2: a ModelHost force-unload walks the seeded ready row to downloaded", async () => {
    // kills: the modelhost branch of force-unload unwrapped.
    writeHost("host-a", GROUP, closedLoopbackPort());
    seed([{ model: "host-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("host-a")?.version ?? 0;

    const result = await forceUnload("host-a");

    expect(result).toMatchObject({ ok: true, kind: "modelhost" });
    expect(readState("host-a")).toMatchObject({
      state: "downloaded",
      version: seededVersion + 3,
    });
  });

  test("FU3: an unconfirmed force-unload stop reports StopFailed, keeps the row occupying and frees nothing", async () => {
    // kills: mapping force-unload ok to anything but stopServer's `stopped`
    // — a mutant that walks the row to downloaded would free the exclusive
    // group beside a process that may still be alive.
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seeded = readState("run-a");
    writePidFile("run-a");
    const stderr = captureStderr();
    try {
      const result = await forceUnload("run-a");

      expect(result).toMatchObject({ ok: false, reason: "StopFailed", workload: "run-a" });
      expect(readState("run-a")).toEqual(seeded);
      expect(stderr.text()).toContain(
        "[residency] lifecycle run-a stop not recorded: unconfirmed stop (process may be alive)",
      );

      const started = await startRun("run-b");
      expect(started.error).toBe(
        "residency lifecycle refused run-b downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by run-a in state ready",
      );
      expect(readState("run-a")?.state).toBe("ready");
    } finally {
      stderr.restore();
    }
  });

  test("FU4: a force-unload during an in-flight profile switch runs but records nothing", async () => {
    // kills: refusing or recording a force-unload during an in-flight
    // profile switch — the stop must still run and report ok while the row
    // and fence stay untouched.
    writeRun("run-a", GROUP);
    const fence = seed([{ model: "run-a", target: "ready", group: GROUP }], {
      switchOp: true,
    });
    const seededVersion = readState("run-a")?.version ?? 0;
    const stderr = captureStderr();
    try {
      const result = await forceUnload("run-a");

      expect(result).toMatchObject({ ok: true });
      expect(readState("run-a")).toMatchObject({ state: "ready", version: seededVersion });
      expect(readFence()).toEqual(fence);
      expect(stderr.text()).toContain(
        "[residency] lifecycle run-a stop not recorded: profile switch in flight",
      );
    } finally {
      stderr.restore();
    }
  });

  test("FU5: a force-unload whose lifecycle walk cannot record still stops and reports ok", async () => {
    // kills: mapping a refused or failed lifecycle walk to a StopFailed
    // force-unload — bookkeeping never blocks or reruns a stop.
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seeded = readState("run-a");
    blockResidencyWrites();
    const stderr = captureStderr();
    try {
      const result = await forceUnload("run-a");

      expect(result).toMatchObject({ ok: true });
      expect(readState("run-a")).toEqual(seeded);
      expect(stderr.text()).toContain("run-a stop not recorded:");
      expect(stderr.text()).toContain("disk full");
    } finally {
      stderr.restore();
    }
  });
});
