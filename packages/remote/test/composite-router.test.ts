import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { Composite } from "../src/composite/schema.js";
import type { CompositeApplyEvent } from "../src/composite/types.js";

import {
  compositeEvents,
  _resetForTests as resetCompositeEvents,
} from "../src/composite/event-bus.js";
import { CompositeSchema } from "../src/composite/schema.js";
import { compositePath, loadComposite, saveComposite } from "../src/composite/store.js";
import { router } from "../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Phase 5 of composite-infra.md — router-level coverage for the
 * composite procedures. We test dry-run + list + get here; wet-run
 * apply is covered by `composite-apply.test.ts` (which injects a
 * fake `RuntimeBackend` directly into `applyComposite`). The router
 * composes the backend via `getCompositeRuntime()` which is not
 * injectable — exercising it in tests would require a live Docker
 * daemon, which we deliberately skip here.
 */

let runtimeDir = "";
let compositesDir = "";
let configPath = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-composite-router-"));
  compositesDir = join(runtimeDir, "composites");
  configPath = join(runtimeDir, "config");
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LLAMACTL_COMPOSITES_DIR: compositesDir,
    LLAMACTL_CONFIG: configPath,
  });
  resetCompositeEvents();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

function sampleManifest(overrides: Partial<Composite["spec"]> = {}): Composite {
  return {
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name: "kb-stack" },
    spec: {
      services: [
        {
          kind: "chroma",
          name: "chroma-1",
          node: "local",
          runtime: "docker",
          port: 8001,
          image: { repository: "chromadb/chroma", tag: "1.5.8" },
        },
      ],
      workloads: [],
      ragNodes: [
        {
          name: "kb",
          node: "local",
          binding: {
            provider: "chroma",
            // Non-empty placeholder — the applier auto-wires the
            // real endpoint from the backing service at apply time.
            endpoint: "placeholder",
            extraArgs: [],
          },
          backingService: "chroma-1",
        },
      ],
      gateways: [],
      pipelines: [],
      dependencies: [],
      onFailure: "rollback",
      ...overrides,
    },
  };
}

describe("router compositeApply — dry-run", () => {
  test("valid manifest returns { dryRun, manifest, order, impliedEdges }", async () => {
    const caller = router.createCaller({});
    const yaml = stringifyYaml(sampleManifest());
    const res = await caller.compositeApply({ manifestYaml: yaml, dryRun: true });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("type narrowing failed");
    expect(res.manifest.metadata.name).toBe("kb-stack");
    expect(res.order).toHaveLength(2); // service + rag
    // Service must come before the rag that depends on it (implicit
    // edge rag/kb → service/chroma-1).
    const serviceIdx = res.order.findIndex((r) => r.kind === "service" && r.name === "chroma-1");
    const ragIdx = res.order.findIndex((r) => r.kind === "rag" && r.name === "kb");
    expect(serviceIdx).toBeLessThan(ragIdx);
    // impliedEdges picks up the rag.backingService auto-wire.
    expect(res.impliedEdges).toHaveLength(1);
    expect(res.impliedEdges[0]?.from).toEqual({ kind: "rag", name: "kb" });
    expect(res.impliedEdges[0]?.to).toEqual({ kind: "service", name: "chroma-1" });
  });

  test("invalid YAML surfaces BAD_REQUEST", async () => {
    const caller = router.createCaller({});
    await caller.compositeApply({ manifestYaml: "not: [valid: yaml", dryRun: true }).then(
      () => {
        throw new Error("expected compositeApply to reject");
      },
      (error: unknown) => {
        expect(() => {
          throw error;
        }).toThrow(/invalid composite manifest/);
      },
    );
  });

  test("manifest missing required fields surfaces BAD_REQUEST", async () => {
    const caller = router.createCaller({});
    // apiVersion is required — omit it.
    const bad = stringifyYaml({
      kind: "Composite",
      metadata: { name: "x" },
      spec: { services: [], workloads: [], ragNodes: [], gateways: [] },
    });
    await caller.compositeApply({ manifestYaml: bad, dryRun: true }).then(
      () => {
        throw new Error("expected compositeApply to reject");
      },
      (error: unknown) => {
        expect(() => {
          throw error;
        }).toThrow(/invalid composite manifest/);
      },
    );
  });
});

describe("router compositeList + compositeGet", () => {
  test("empty directory → empty list", async () => {
    const caller = router.createCaller({});
    const listed = await caller.compositeList();
    expect(listed).toEqual([]);
  });

  test("compositeList returns saved composites sorted by name", async () => {
    const a = { ...sampleManifest(), metadata: { name: "alpha" } } satisfies Composite;
    const b = { ...sampleManifest(), metadata: { name: "zeta" } } satisfies Composite;
    saveComposite(a, compositesDir);
    saveComposite(b, compositesDir);

    const caller = router.createCaller({});
    const listed = await caller.compositeList();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.metadata.name).toBe("alpha");
    expect(listed[1]?.metadata.name).toBe("zeta");
  });

  test("compositeGet returns the stored manifest", async () => {
    const m = sampleManifest();
    saveComposite(m, compositesDir);
    const caller = router.createCaller({});
    const got = await caller.compositeGet({ name: "kb-stack" });
    expect(got).not.toBeNull();
    expect(got?.metadata.name).toBe("kb-stack");
    expect(got?.spec.services[0]?.name).toBe("chroma-1");
  });

  test("compositeGet returns null when absent", async () => {
    const caller = router.createCaller({});
    const got = await caller.compositeGet({ name: "does-not-exist" });
    expect(got).toBeNull();
  });
});

describe("router compositeDestroy — dry-run", () => {
  test("dry-run returns reverse-topo order without deleting", async () => {
    saveComposite(sampleManifest(), compositesDir);
    const caller = router.createCaller({});
    const res = await caller.compositeDestroy({ name: "kb-stack", dryRun: true });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("type narrowing failed");
    expect(res.name).toBe("kb-stack");
    expect(res.wouldRemove).toHaveLength(2);
    // Reverse-topo: rag (depends on service) tears down before service.
    expect(res.wouldRemove[0]?.kind).toBe("rag");
    expect(res.wouldRemove[1]?.kind).toBe("service");

    // YAML still there (dry-run doesn't touch disk).
    const still = await caller.compositeGet({ name: "kb-stack" });
    expect(still).not.toBeNull();
  });

  test("destroy of missing composite surfaces NOT_FOUND", async () => {
    const caller = router.createCaller({});
    await caller.compositeDestroy({ name: "never-existed", dryRun: true }).then(
      () => {
        throw new Error("expected compositeDestroy to reject");
      },
      (error: unknown) => {
        expect(() => {
          throw error;
        }).toThrow(/not found/);
      },
    );
  });

  test("dry-run with purgeVolumes: true surfaces wouldPurgeVolumes in the response", async () => {
    saveComposite(sampleManifest(), compositesDir);
    const caller = router.createCaller({});
    const res = await caller.compositeDestroy({
      name: "kb-stack",
      dryRun: true,
      purgeVolumes: true,
    });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("type narrowing failed");
    expect(res.wouldPurgeVolumes).toBe(true);
    // YAML untouched by dry-run regardless of purgeVolumes.
    const still = await caller.compositeGet({ name: "kb-stack" });
    expect(still).not.toBeNull();
  });

  test("dry-run without purgeVolumes defaults to wouldPurgeVolumes=false", async () => {
    saveComposite(sampleManifest(), compositesDir);
    const caller = router.createCaller({});
    const res = await caller.compositeDestroy({ name: "kb-stack", dryRun: true });
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("type narrowing failed");
    expect(res.wouldPurgeVolumes).toBe(false);
  });
});

// Part of #520: the router keeps the composite YAML only when
// destroyComposite reports a stop-fence refusal. A workload-only composite
// on the in-proc `local` node drives the real serverStop fence: a held
// lease on the node key refuses before any process is touched, and with no
// lease the stop no-ops on the temp runtime dir. No docker is touched
// (no services, and the docker backend has no composite boundary).
describe("router compositeDestroy — stop-fence refusal (#520)", () => {
  beforeEach(() => {
    const localRuntime = join(runtimeDir, "local-ai");
    mkdirSync(localRuntime, { recursive: true });
    Object.assign(process.env, {
      LOCAL_AI_RUNTIME_DIR: localRuntime,
      LLAMACTL_RESIDENCY_STORE: join(runtimeDir, "residency.sqlite"),
      LLAMACTL_SIRIUS_PROVIDERS: join(runtimeDir, "sirius-providers.yaml"),
      LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, "embersynth.yaml"),
      LLAMACTL_RUNTIME_BACKEND: "docker",
    });
  });

  afterEach(() => {
    setResidencyLeaseRegistry(null);
  });

  function workloadComposite(): Composite {
    return CompositeSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "Composite",
      metadata: { name: "wl-stack" },
      spec: {
        services: [],
        workloads: [{ node: "local", target: { kind: "rel", value: "m.gguf" } }],
        ragNodes: [],
        gateways: [],
        pipelines: [],
        dependencies: [],
        onFailure: "rollback",
      },
      status: { phase: "Ready", appliedAt: "2026-11-01T00:00:00.000Z", components: [] },
    });
  }

  test("RT1: a refused workload stop keeps the YAML, returns manifestPreserved true, and records the partial destroy", async () => {
    // Kills: reverting the guard to an unconditional deleteComposite
    // (router.ts compositeDestroy), inverting it to `if
    // (result.manifestPreserved) deleteComposite`, dropping the
    // manifestPreserved field from the returned object, and not
    // recording the Degraded/Failed status on the kept manifest.
    const registry = createResidencyLeases();
    setResidencyLeaseRegistry(registry);
    const acquired = registry.acquire("local");
    if (!acquired.ok) throw new Error("expected lease acquire to succeed");
    saveComposite(workloadComposite(), compositesDir);

    const res = await router.createCaller({}).compositeDestroy({ name: "wl-stack" });

    if (res.dryRun) throw new Error("expected a wet destroy");
    expect(res.ok).toBe(false);
    expect(res.manifestPreserved).toBe(true);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.ref).toEqual({ kind: "workload", name: "local" });
    expect(res.errors[0]?.message).toContain("serverStop on local refused (LeasesActive");
    expect(existsSync(compositePath("wl-stack", compositesDir))).toBe(true);
    const kept = loadComposite("wl-stack", compositesDir);
    expect(kept?.status?.phase).toBe("Degraded");
    expect(kept?.status?.appliedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(kept?.status?.components).toEqual([
      {
        ref: { kind: "workload", name: "local" },
        state: "Failed",
        message: res.errors[0]?.message,
      },
    ]);
  });

  test("RT2: a clean workload stop deletes the YAML and returns manifestPreserved false", async () => {
    // Kills: inverting the guard (`if (result.manifestPreserved)
    // deleteComposite`) — a clean stop must still remove the YAML — and
    // returning a hard-coded `manifestPreserved: true`.
    saveComposite(workloadComposite(), compositesDir);

    const res = await router.createCaller({}).compositeDestroy({ name: "wl-stack" });

    if (res.dryRun) throw new Error("expected a wet destroy");
    expect(res.manifestPreserved).toBe(false);
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    expect(existsSync(compositePath("wl-stack", compositesDir))).toBe(false);
  });
});

describe("router compositeStatus — live event streaming", () => {
  async function collectEvents(
    iter: AsyncIterable<CompositeApplyEvent>,
  ): Promise<CompositeApplyEvent[]> {
    const out: CompositeApplyEvent[] = [];
    for await (const ev of iter) {
      out.push(ev);
      if (ev.type === "done") break;
    }
    return out;
  }

  test("subscribes to an in-flight run and streams live events", async () => {
    // Pretend a compositeApply is running: the bus is seeded with an
    // active run (no compositeApply call needed — that path needs a
    // docker backend which the router-level tests never spin up).
    compositeEvents.startRun("live-stack");
    compositeEvents.emit("live-stack", { type: "phase", phase: "Applying" });

    const caller = router.createCaller({});
    const iter = (await caller.compositeStatus({
      name: "live-stack",
    })) as AsyncIterable<CompositeApplyEvent>;
    const collect = collectEvents(iter);

    // Emit further events after the subscription lands so the test
    // exercises both replay (phase:Applying) and live fan-out.
    await new Promise((r) => setTimeout(r, 10));
    compositeEvents.emit("live-stack", {
      type: "component-start",
      ref: { kind: "service", name: "chroma-1" },
    });
    compositeEvents.emit("live-stack", {
      type: "component-ready",
      ref: { kind: "service", name: "chroma-1" },
    });
    compositeEvents.emit("live-stack", { type: "phase", phase: "Ready" });
    compositeEvents.emit("live-stack", { type: "done", ok: true });

    const events = await collect;
    const types = events.map((e) => e.type);
    expect(types).toContain("phase");
    expect(types).toContain("component-start");
    expect(types).toContain("component-ready");
    expect(types).toContain("done");
    expect(events[events.length - 1]).toEqual({ type: "done", ok: true });

    compositeEvents.endRun("live-stack");
  });

  test("late subscriber receives the full replayed buffer", async () => {
    compositeEvents.startRun("live-stack-2");
    compositeEvents.emit("live-stack-2", { type: "phase", phase: "Applying" });
    compositeEvents.emit("live-stack-2", {
      type: "component-start",
      ref: { kind: "service", name: "svc-a" },
    });
    compositeEvents.emit("live-stack-2", {
      type: "component-ready",
      ref: { kind: "service", name: "svc-a" },
    });

    // Subscribe after three events are buffered; the stream should
    // replay all three before we emit the terminal `done`.
    const caller = router.createCaller({});
    const iter = (await caller.compositeStatus({
      name: "live-stack-2",
    })) as AsyncIterable<CompositeApplyEvent>;
    const collect = collectEvents(iter);

    await new Promise((r) => setTimeout(r, 10));
    compositeEvents.emit("live-stack-2", { type: "phase", phase: "Ready" });
    compositeEvents.emit("live-stack-2", { type: "done", ok: true });

    const events = await collect;
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events[0]?.type).toBe("phase");
    expect(events[events.length - 1]).toEqual({ type: "done", ok: true });

    compositeEvents.endRun("live-stack-2");
  });

  test("after endRun (no live run), falls back to persisted status", async () => {
    // Persist a ready composite — no active run in the bus.
    const manifest: Composite = {
      ...sampleManifest(),
      metadata: { name: "persisted-stack" },
      status: {
        phase: "Ready",
        appliedAt: new Date().toISOString(),
        components: [
          { ref: { kind: "service", name: "chroma-1" }, state: "Ready" },
          { ref: { kind: "rag", name: "kb" }, state: "Ready" },
        ],
      },
    };
    saveComposite(manifest, compositesDir);

    const caller = router.createCaller({});
    const iter = (await caller.compositeStatus({
      name: "persisted-stack",
    })) as AsyncIterable<CompositeApplyEvent>;
    const events = await collectEvents(iter);

    // Synthesized order: phase → (component-start + component-ready)* → done.
    expect(events[0]).toEqual({ type: "phase", phase: "Ready" });
    expect(events[events.length - 1]).toEqual({ type: "done", ok: true });
    // Two components → two starts + two readys.
    const starts = events.filter((e) => e.type === "component-start");
    const readys = events.filter((e) => e.type === "component-ready");
    expect(starts).toHaveLength(2);
    expect(readys).toHaveLength(2);
  });

  test("NOT_FOUND when composite has no run and no persisted manifest", async () => {
    const caller = router.createCaller({});
    const iter = (await caller.compositeStatus({
      name: "ghost",
    })) as AsyncIterable<CompositeApplyEvent>;
    await (async (): Promise<void> => {
      for await (const _e of iter) {
        // drain — should throw before first yield
      }
    })().then(
      () => {
        throw new Error("expected compositeStatus iterator to reject");
      },
      (error: unknown) => {
        expect(() => {
          throw error;
        }).toThrow(/not found/);
      },
    );
  });
});
