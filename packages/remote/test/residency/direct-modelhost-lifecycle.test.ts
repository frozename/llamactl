import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for the direct ModelHost lifecycle slice: modelHostStart
 * and modelHostStop must drive residency_states rows through the same
 * fenced walks the profile-switch executor uses (pre-walk to loading /
 * unloading, dep, post-walk to ready|failed / downloaded|failed), gated on
 * the store file existing, refuse a start while a profile switch is in
 * flight, reconcile proven-down same-group peers, and never record a stop
 * while a switch holds the fence. Every host binds 0.0.0.0 without
 * allowExternalBind, so the underlying startModelHost refuses at
 * modelHostBindRefusal before any spawn — the lifecycle row is the only
 * thing under test. At base the router procedures never touch the
 * residency store, so every case fails BY ASSERTION on the rows, fence
 * or stderr — never by import, type or exit code.
 */
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";

const GROUP = "z13-large-gpu";
const OTHER_GROUP = "m4-other";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type Fence = { ownerId: string; incarnation: string; fenceToken: number };
type SeedRow = { model: string; target: ResidencyState; group?: string };
type HostResult = { ok: boolean; pid: number | null; error?: string };

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
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

function bindRefusal(name: string): string {
  return `refusing to bind ModelHost ${name} to 0.0.0.0 without \`allowExternalBind: true\` in the workload spec`;
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

// modelHostStart is a subscription: collect the stream and take the done
// event's result (the last one wins if a wrapper ever emits its own).
async function startWorkload(workload: string): Promise<HostResult> {
  const stream = await router.createCaller({}).modelHostStart({ workload });
  let result: HostResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: HostResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`modelHostStart(${workload}) stream ended without a done event`);
  }
  return result;
}

function stopWorkload(
  workload: string,
): ReturnType<ReturnType<typeof router.createCaller>["modelHostStop"]> {
  return router.createCaller({}).modelHostStop({ workload });
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

beforeEach(() => {
  // Null registries keep fenceWorkloadStop on its pass-through path: these
  // cases pin the residency lifecycle rows, not lease/session fencing, and
  // a registry leaked by another file must not refuse the stop.
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-direct-modelhost-"));
  workloadsDir = join(root, "workloads");
  mkdirSync(workloadsDir, { recursive: true });
  // omlx validateSpec requires the binary to exist; the bind refusal fires
  // before any spawn, so an empty file is enough.
  fakeBinary = join(root, "fake-omlx");
  writeFileSync(fakeBinary, "");
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: join(root, "runtime"),
    LLAMACTL_CONFIG: join(root, "no-such-kubeconfig.yaml"),
  });
  writeHost("z13-a", GROUP, 18094);
  writeHost("z13-b", GROUP, 18095);
  writeHost("other-c", OTHER_GROUP, 18096);
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

describe("modelHostStart/modelHostStop direct residency lifecycle", () => {
  test("DL1: no store file leaves the bind refusal untouched; a seeded store records the failed row", async () => {
    // kills: modelHostStart not wrapped; also kills removing the
    // store-existence gate (the first start must not create the store).
    const first = await startWorkload("z13-a");
    expect(first.ok).toBe(false);
    expect(first.pid).toBeNull();
    expect(first.error).toBe(bindRefusal("z13-a"));
    expect(existsSync(storePath())).toBe(false);

    seed([]);

    const second = await startWorkload("z13-a");
    expect(second.ok).toBe(false);
    expect(second.error).toBe(bindRefusal("z13-a"));
    expect(readState("z13-a")).toMatchObject({
      state: "failed",
      group: GROUP,
      version: 3,
    });
  });

  test("DL2: a loading exclusive-group peer refuses the start before the bind gate", async () => {
    // kills: treating a loading/warming peer as reconcilable; skipping the
    // store's exclusive check.
    seed([{ model: "z13-b", target: "loading", group: GROUP }]);

    const result = await startWorkload("z13-a");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(
      "residency lifecycle refused z13-a downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by z13-b in state loading",
    );
    expect(result.error ?? "").not.toContain("refusing to bind");
    expect(readState("z13-b")?.state).toBe("loading");
    expect(readState("z13-a")?.state).toBe("downloaded");
  });

  test("DL3: a proven-down ready peer is reconciled before the group check", async () => {
    // kills: ignoring live corroboration (z13-b has a manifest but no
    // sidecar, so it is proven down and its stale ready row releases).
    seed([{ model: "z13-b", target: "ready", group: GROUP }]);
    const stderr = captureStderr();
    try {
      const result = await startWorkload("z13-a");

      expect(result.ok).toBe(false);
      expect(result.error).toBe(bindRefusal("z13-a"));
      expect(readState("z13-b")).toMatchObject({ state: "downloaded", group: GROUP });
      expect(readState("z13-a")?.state).toBe("failed");
      expect(stderr.text()).toContain(
        "[residency] lifecycle reconciled stale z13-b ready -> downloaded in group z13-large-gpu",
      );
    } finally {
      stderr.restore();
    }
  });

  test("DL4: an occupying row with no manifest is not proven down and still refuses", async () => {
    // kills: isProvenDown true for a peer that is not a known ModelHost —
    // qwen-prod has no manifest, so its ready row keeps occupying.
    seed([{ model: "qwen-prod", target: "ready", group: GROUP }]);

    const result = await startWorkload("z13-a");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "residency lifecycle refused z13-a downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready",
    );
    expect(readState("qwen-prod")?.state).toBe("ready");
  });

  test("DL5: an in-flight profile switch refuses the start without claiming the fence", async () => {
    // kills: claiming the fence without the in-flight profile-switch
    // check — the refusal must leave authority and rows untouched.
    const fence = seed([], { switchOp: true });

    const result = await startWorkload("z13-a");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(
      "residency lifecycle refused z13-a: profile switch in flight on this node; retry after it settles",
    );
    expect(readState("z13-a")).toBeNull();
    expect(readFence()).toEqual(fence);
  });

  test("DL6: an undeclared label group records no group and still hits the bind refusal", async () => {
    // kills: passing an undeclared label group to the store, which would
    // refuse UnknownGroup instead of reaching the dep.
    seed([]);

    const result = await startWorkload("other-c");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(bindRefusal("other-c"));
    expect(result.error ?? "").not.toContain("UnknownGroup");
    expect(readState("other-c")).toMatchObject({ state: "failed", group: null, version: 3 });
  });

  test("DL7: modelHostStop walks a ready row down to downloaded", async () => {
    // kills: modelHostStop not wrapped.
    seed([{ model: "z13-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("z13-a")?.version ?? 0;

    const result = await stopWorkload("z13-a");

    expect(result.ok).toBe(true);
    expect(readState("z13-a")).toMatchObject({
      state: "downloaded",
      version: seededVersion + 3,
    });
  });

  test("DL8: a stop during an in-flight profile switch runs but records nothing", async () => {
    // kills: blocking a stop, or stealing the fence, while a switch is in
    // flight — the stop still runs, the row and fence stay untouched.
    const fence = seed([{ model: "z13-a", target: "ready", group: GROUP }], { switchOp: true });
    const seededVersion = readState("z13-a")?.version ?? 0;
    const stderr = captureStderr();
    try {
      const result = await stopWorkload("z13-a");

      expect(result.ok).toBe(true);
      expect(readState("z13-a")).toMatchObject({ state: "ready", version: seededVersion });
      expect(readFence()).toEqual(fence);
      expect(stderr.text()).toContain(
        "[residency] lifecycle z13-a stop not recorded: profile switch in flight",
      );
    } finally {
      stderr.restore();
    }
  });
});
