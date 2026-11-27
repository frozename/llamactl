// packages/remote/test/composite-destroy-stop-refusal.test.ts
//
// Part of #520: `llamactl composite destroy` must surface a node
// stop-fence refusal (leases, drain, or bound sessions) instead of
// claiming the workload was removed, and must keep the composite
// manifest so the destroy can be retried. destroyComposite drives a
// fake RuntimeBackend (no destroyCompositeBoundary → per-component
// loop) and a fake WorkloadClient whose serverStop.mutate returns a
// canned StopServerResult — no docker, no live inference, temp dirs
// only.
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompositeDestroyResult } from "../src/composite/apply.js";
import type { Composite } from "../src/composite/schema.js";
import type { RuntimeBackend } from "../src/runtime/backend.js";
import type { WorkloadClient } from "../src/workload/apply.js";

import { destroyComposite } from "../src/composite/apply.js";
import { CompositeSchema } from "../src/composite/schema.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let tmp = "";
let configPath = "";
let compositesDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-composite-destroy-fence-"));
  configPath = join(tmp, "config");
  compositesDir = join(tmp, "composites");
  saveConfig(freshConfig(), configPath);
  process.env["LLAMACTL_CONFIG"] = configPath;
  process.env["LLAMACTL_COMPOSITES_DIR"] = compositesDir;
  // cleanupGatewayCatalogs rewrites both catalogs unconditionally —
  // point them at temp files so the test never touches live state.
  process.env["LLAMACTL_SIRIUS_PROVIDERS"] = join(tmp, "sirius-providers.yaml");
  process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = join(tmp, "embersynth.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

// ---- fakes ---------------------------------------------------------------

function makeBackend(): RuntimeBackend {
  return {
    kind: "fake",
    ping: () => Promise.resolve(),
    ensureService: () => Promise.reject(new Error("ensureService unused in destroy")),
    removeService: () => Promise.resolve(),
    inspectService: () => Promise.resolve(null),
    listServices: () => Promise.resolve([]),
    // No destroyCompositeBoundary — the per-component loop is the path
    // under test.
  };
}

type StopInput = { workload: string; graceSeconds?: number };

function makeWorkloadClient(stop: (input: StopInput) => Promise<unknown>): {
  client: WorkloadClient;
  stopKeys: string[];
} {
  const stopKeys: string[] = [];
  const neverSubscribe = (): { unsubscribe: () => void } => ({
    unsubscribe: () => undefined,
  });
  const client: WorkloadClient = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "stopped",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "http://127.0.0.1:8080",
        }),
    },
    serverStop: {
      mutate: async (input) => {
        stopKeys.push(input.workload);
        return await stop(input);
      },
    },
    serverStart: { subscribe: neverSubscribe },
    modelHostStart: { subscribe: neverSubscribe },
    modelHostStop: { mutate: () => Promise.resolve({}) },
    modelHostStatus: {
      query: () => Promise.resolve({ state: "Stopped", pid: null }),
    },
    rpcServerStart: { subscribe: neverSubscribe },
    rpcServerStop: { mutate: () => Promise.resolve({}) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: "/fake", llamaCppBin: "/fake" }),
    },
  };
  return { client, stopKeys };
}

// ---- manifest --------------------------------------------------------------

// Workload-only composite, parsed through the real schema so
// ModelRunSpec defaults populate exactly as in production (a raw cast
// would leave `enabled` undefined and short-circuit the workload).
function workloadComposite(nodes: readonly string[]): Composite {
  return CompositeSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "stack" },
    spec: {
      services: [],
      workloads: nodes.map((node) => ({
        node,
        target: { kind: "rel", value: "m.gguf" },
      })),
      ragNodes: [],
      gateways: [],
      pipelines: [],
      dependencies: [],
      onFailure: "rollback",
    },
  });
}

function destroy(
  manifest: Composite,
  getWorkloadClient: (nodeName: string) => WorkloadClient,
): Promise<CompositeDestroyResult> {
  return destroyComposite({
    manifest,
    backend: makeBackend(),
    getWorkloadClient,
    configPath,
    compositesDir,
  });
}

// manifestPreserved is added by the fix; read it through a cast so this
// file typechecks against both the base and the fixed result type.
function manifestPreserved(result: unknown): boolean | undefined {
  return (result as { manifestPreserved?: boolean }).manifestPreserved;
}

const UNVERIFIED =
  "serverStop on local refused (pid identity unverifiable); composite manifest preserved";

// ---- tests -----------------------------------------------------------------

describe("destroyComposite — stop-fence refusal (#520)", () => {
  test("R1: SessionsActive refusal fails the destroy, keeps the workload out of removed, and preserves the manifest", async () => {
    // Kills: dropping the refusal check in destroyWorkloadComponent
    // (apply.ts) — a fenced serverStop must become a destroy error, not a
    // silent 'removed'.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsActive", active: ["s1", "s2"] },
      }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      {
        ref: { kind: "workload", name: "local" },
        message:
          "serverStop on local refused (SessionsActive: s1, s2); composite manifest preserved",
      },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("R2: SessionsUnknown with no active ids omits the id list from the refusal message", async () => {
    // Kills: always appending ': <ids>' — SessionsUnknown carries an empty
    // active list, so the detail must be '(SessionsUnknown)' with no
    // trailing colon.
    const { client } = makeWorkloadClient(() =>
      Promise.resolve({
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "SessionsUnknown", active: [] },
      }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      {
        ref: { kind: "workload", name: "local" },
        message: "serverStop on local refused (SessionsUnknown); composite manifest preserved",
      },
    ]);
    expect(manifestPreserved(result)).toBe(true);
  });

  test("R3: a partial refusal still stops the other workloads and preserves the manifest", async () => {
    // Kills: aborting the destroy loop on the first refusal (local must
    // still be stopped after gpu2 refuses), and setting manifestPreserved
    // only when EVERY workload refused.
    const localFake = makeWorkloadClient(() =>
      Promise.resolve({ stopped: true, pid: 1, killed: false }),
    );
    const gpu2Fake = makeWorkloadClient(() =>
      Promise.resolve({
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: "LeasesActive", active: ["lease-1"] },
      }),
    );
    const byNode = new Map<string, WorkloadClient>([
      ["local", localFake.client],
      ["gpu2", gpu2Fake.client],
    ]);
    const getWorkloadClient = (node: string): WorkloadClient => {
      const c = byNode.get(node);
      if (!c) throw new Error(`no fake client for node '${node}'`);
      return c;
    };

    const result = await destroy(workloadComposite(["local", "gpu2"]), getWorkloadClient);

    expect(result.ok).toBe(false);
    expect(result.removed).toContainEqual({ kind: "workload", name: "local" });
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "gpu2" });
    expect(result.errors).toEqual([
      {
        ref: { kind: "workload", name: "gpu2" },
        message: "serverStop on gpu2 refused (LeasesActive: lease-1); composite manifest preserved",
      },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(localFake.stopKeys).toEqual(["local"]);
    expect(gpu2Fake.stopKeys).toEqual(["gpu2"]);
  });

  test("R4: a bare stopped:false with a pid is an unverifiable stop refusal", async () => {
    // Kills: treating stopped:false as a successful teardown whenever the
    // structured fence detail is absent — the pid identity is unverifiable,
    // so the workload must stay out of removed.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({ stopped: false, pid: 4242, killed: false }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      { ref: { kind: "workload", name: "local" }, message: UNVERIFIED },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("R5: a bare stopped:false without a pid is an unverifiable stop refusal", async () => {
    // Kills: requiring a pid before treating stopped:false as unverified —
    // the router's serverStop fallback has pid:null.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({ stopped: false, pid: null, killed: false }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      { ref: { kind: "workload", name: "local" }, message: UNVERIFIED },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("R6: a malformed refused reason still leaves the stop unverifiable", async () => {
    // Kills: returning null for a non-string refusal reason instead of
    // falling back to the pid-identity-unverifiable refusal.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({
        stopped: false,
        pid: null,
        killed: false,
        refused: { reason: 42 },
      }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      { ref: { kind: "workload", name: "local" }, message: UNVERIFIED },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("R7: a non-object refused value still leaves the stop unverifiable", async () => {
    // Kills: returning null when `refused` is present but not an object.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({ stopped: false, pid: null, killed: false, refused: "x" }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([
      { ref: { kind: "workload", name: "local" }, message: UNVERIFIED },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("R8: an unverifiable stop on one node preserves the manifest while the other workload is removed", async () => {
    // Kills: aborting the destroy loop on an unverified stop, and treating a
    // bare stopped:false as removable when another node stopped cleanly.
    const localFake = makeWorkloadClient(() =>
      Promise.resolve({ stopped: true, pid: 1, killed: false }),
    );
    const gpu2Fake = makeWorkloadClient(() =>
      Promise.resolve({ stopped: false, pid: 9, killed: false }),
    );
    const byNode = new Map<string, WorkloadClient>([
      ["local", localFake.client],
      ["gpu2", gpu2Fake.client],
    ]);
    const getWorkloadClient = (node: string): WorkloadClient => {
      const c = byNode.get(node);
      if (!c) throw new Error(`no fake client for node '${node}'`);
      return c;
    };

    const result = await destroy(workloadComposite(["local", "gpu2"]), getWorkloadClient);

    expect(result.ok).toBe(false);
    expect(result.removed).toContainEqual({ kind: "workload", name: "local" });
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "gpu2" });
    expect(result.errors).toEqual([
      {
        ref: { kind: "workload", name: "gpu2" },
        message:
          "serverStop on gpu2 refused (pid identity unverifiable); composite manifest preserved",
      },
    ]);
    expect(manifestPreserved(result)).toBe(true);
    expect(localFake.stopKeys).toEqual(["local"]);
    expect(gpu2Fake.stopKeys).toEqual(["gpu2"]);
  });

  test("G3 guard: a null stop outcome remains a transport-style miss, not a refusal", async () => {
    // Guard (passes on the base too): no outcome object means there is no
    // positive stopped:false signal to fence on.
    const { client, stopKeys } = makeWorkloadClient(() => Promise.resolve(null));

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(true);
    expect(result.removed).toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([]);
    expect(manifestPreserved(result)).not.toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("G1 guard: a verified stop is not a refusal — ok, removed, and no manifestPreserved", async () => {
    // Guard (passes on the base too): pins the fix's happy path — a
    // stopped:true outcome must not be mistaken for a fence refusal.
    const { client, stopKeys } = makeWorkloadClient(() =>
      Promise.resolve({ stopped: true, pid: 1, killed: false }),
    );

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(true);
    expect(result.removed).toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([]);
    expect(manifestPreserved(result)).not.toBe(true);
    expect(stopKeys).toEqual(["local"]);
  });

  test("G2 guard: a thrown stop is a transport error, not a fence refusal", async () => {
    // Guard (passes on the base too): an unreachable/throwing stop must
    // surface the raw error and must NOT set manifestPreserved — only a
    // structured `refused` outcome preserves the manifest. Kills:
    // setting manifestPreserved on any workload error.
    const { client } = makeWorkloadClient(() => Promise.reject(new Error("boom")));

    const result = await destroy(workloadComposite(["local"]), () => client);

    expect(result.ok).toBe(false);
    expect(result.removed).not.toContainEqual({ kind: "workload", name: "local" });
    expect(result.errors).toEqual([{ ref: { kind: "workload", name: "local" }, message: "boom" }]);
    expect(manifestPreserved(result)).not.toBe(true);
  });
});
