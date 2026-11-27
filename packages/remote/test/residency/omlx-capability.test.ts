/**
 * #282 DF-09 — oMLX native capability probe with declared process fallback.
 * `src/residency/omlx-capability` and the `omlxNative` section of
 * residencyStatus land with the fix, so the module is reached through a
 * guarded dynamic import — the specifier stays a runtime string so tsc
 * cannot resolve the missing module (a literal would be a resolution
 * error, not an assertion failure) — and the router payload through a
 * structural cast. Every case fails by assertion at the pinned base,
 * never by a missing module or a type error. The fake oMLX server mirrors
 * jundot/omlx server.py GET /v1/models/status at OMLX_REVISION
 * (list_models_status).
 */
import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OmlxNativeBinding } from "../../src/residency/engine-client.js";

import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";

const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const ID = "Qwen3-8B-MLX-4bit";

// ── module under test (lands with the fix) ──────────────────────────────

type OmlxCapability = {
  mode: "native" | "process-fallback" | "unknown";
  reason: string | null;
  httpStatus: number | null;
};

type ProbeOptions = {
  endpoint: { host: string; port: number };
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
};

type ResolveOptions = {
  endpoint: { host: string; port: number };
  hostedRel: string;
  binding: OmlxNativeBinding;
  activityObservable: boolean;
  workload: string;
  probeTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
};

type ResolveResult =
  | {
      path: "native";
      capability: OmlxCapability;
      client: { load: unknown; unload: unknown; status: unknown };
    }
  | { path: "process" | "held"; capability: OmlxCapability };

type OmlxCapabilityModule = {
  probeOmlxNativeCapability(opts: ProbeOptions): Promise<OmlxCapability>;
  ensureOmlxNativeCapability(opts: ProbeOptions): Promise<OmlxCapability>;
  resetOmlxNativeCapabilityCache(): void;
  resolveOmlxResidencyPath(opts: ResolveOptions): Promise<ResolveResult>;
};

// The specifier stays a runtime `string` (built from import.meta.url) so
// tsc cannot resolve the not-yet-existing module — a literal specifier
// would be a resolution error, not an assertion failure.
async function moduleRecord(): Promise<Record<string, unknown>> {
  const href = new URL("../../src/residency/omlx-capability.ts", import.meta.url).href;
  return (await import(href).catch(() => ({}))) as Record<string, unknown>;
}

async function loadModule(): Promise<OmlxCapabilityModule> {
  const mod = await moduleRecord();
  expect(typeof mod["probeOmlxNativeCapability"]).toBe("function");
  expect(typeof mod["ensureOmlxNativeCapability"]).toBe("function");
  expect(typeof mod["resetOmlxNativeCapabilityCache"]).toBe("function");
  expect(typeof mod["resolveOmlxResidencyPath"]).toBe("function");
  return mod as unknown as OmlxCapabilityModule;
}

// ── fake oMLX server ────────────────────────────────────────────────────

type StatusReply = {
  status: number;
  delayMs?: number;
  body?: unknown;
};

type FakeOmlx = {
  endpoint: { host: string; port: number };
  log: string[];
  // Per status request: whether the expected bearer header was present. The
  // header value itself is never recorded.
  bearerSeen: boolean[];
  stop: () => Promise<void>;
};

// A fixed test-only credential; never a real key and never logged.
const TEST_API_KEY = "test-omlx-key-282";

const fakes: FakeOmlx[] = [];

// Mirrors GET /v1/models/status (list_models_status) at OMLX_REVISION.
function statusFixtureV1(): Record<string, unknown> {
  return {
    final_ceiling: 34359738368,
    current_model_memory: 0,
    model_count: 1,
    loaded_count: 0,
    load_seconds_per_gb_estimate: null,
    load_time_observations: 0,
    models: [
      {
        id: ID,
        model_path: `/models/${ID}`,
        loaded: false,
        is_loading: false,
        loading_started_at: null,
        estimated_size: 5000000000,
        resident_estimated_size: 5000000000,
        distributed: false,
        actual_size: null,
        pinned: false,
        model_type: "llm",
        config_model_type: "qwen3",
        model_context_length: 40960,
        is_helper: false,
        source_type: "local",
        max_context_window: 40960,
        max_tokens: 32768,
        is_favorite: false,
        is_hidden: false,
        engine_type: "batched",
      },
    ],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function statusHits(fake: FakeOmlx): number {
  return fake.log.filter((entry) => entry === "GET /v1/models/status").length;
}

// statusScript entries are consumed in order per status request; the last
// entry repeats once the script is exhausted. delayMs postpones the reply
// so a short probe timeout observes a Timeout while the server still
// answers late. requireBearer makes the status path answer 401 unless the
// request carries exactly `Authorization: Bearer <requireBearer>`, like an
// oMLX engine started with an API key.
function startFakeOmlx(
  opts: { statusScript?: StatusReply[]; requireBearer?: string } = {},
): FakeOmlx {
  const script = opts.statusScript ?? [{ status: 200, body: statusFixtureV1() }];
  if (script.length === 0) {
    throw new Error("statusScript must not be empty");
  }
  const log: string[] = [];
  const bearerSeen: boolean[] = [];
  const requireBearer = opts.requireBearer;
  let statusCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      log.push(`${req.method} ${url.pathname}`);
      if (req.method === "GET" && url.pathname === "/v1/models/status") {
        if (requireBearer !== undefined) {
          const authorized = req.headers.get("authorization") === `Bearer ${requireBearer}`;
          bearerSeen.push(authorized);
          if (!authorized) {
            return Response.json({ detail: "Unauthorized" }, { status: 401 });
          }
        }
        const reply = script[Math.min(statusCalls, script.length - 1)]!;
        statusCalls += 1;
        const delayMs = reply.delayMs ?? 0;
        if (delayMs > 0) {
          await delay(delayMs);
        }
        if (reply.status === 200) {
          return Response.json(reply.body ?? statusFixtureV1());
        }
        return Response.json(
          { detail: `status ${String(reply.status)}` },
          { status: reply.status },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) {
    throw new Error("fake oMLX did not bind a port");
  }
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      await server.stop(true);
    }
  };
  const fake: FakeOmlx = {
    endpoint: { host: "127.0.0.1", port },
    log,
    bearerSeen,
    stop,
  };
  fakes.push(fake);
  return fake;
}

// ── env + lifecycle ─────────────────────────────────────────────────────

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(async () => {
  const mod = await moduleRecord();
  const reset = mod["resetOmlxNativeCapabilityCache"];
  if (typeof reset === "function") {
    (reset as () => void)();
  }
  tmp = mkdtempSync(join(tmpdir(), "llamactl-omlx-capability-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "residency-state", "operations.sqlite"),
    DEV_STORAGE: join(tmp, "dev"),
  });
});

afterEach(async () => {
  const pending = fakes.splice(0);
  await Promise.all(pending.map((fake): Promise<void> => fake.stop()));
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

// ── residencyStatus projection helpers ──────────────────────────────────

type ResidencyStatusSlice = {
  omlxNative?: {
    scope: string;
    workloads: unknown[];
  };
};

function saveHostManifests(fake: FakeOmlx): void {
  saveModelHost(
    ModelHostManifestSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "host-omlx" },
      spec: {
        engine: "omlx",
        node: "local",
        binary: "/x/engine",
        endpoint: { host: "127.0.0.1", port: fake.endpoint.port },
        hostedModels: [{ rel: REL }],
      },
    }),
    tmp,
  );
  saveModelHost(
    ModelHostManifestSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "host-llama" },
      spec: {
        engine: "llamacpp",
        node: "local",
        binary: "/x/llama-server",
        endpoint: { host: "127.0.0.1", port: fake.endpoint.port },
        hostedModels: [{ rel: "org/repo/llama.gguf" }],
      },
    }),
    tmp,
  );
}

async function residencyStatus(node: string): Promise<ResidencyStatusSlice> {
  const caller = router.createCaller({});
  const result = await caller.residencyStatus({ node });
  return result;
}

// ── probeOmlxNativeCapability ───────────────────────────────────────────

describe("probeOmlxNativeCapability", () => {
  // kills classifying a 200 models-status body as process-fallback or unknown
  test("native status endpoint -> native", async () => {
    const fake = startFakeOmlx();
    const mod = await loadModule();
    const capability = await mod.probeOmlxNativeCapability({
      endpoint: fake.endpoint,
      timeoutMs: 1000,
    });
    expect(capability).toEqual({ mode: "native", reason: null, httpStatus: 200 });
  });

  // kills dropping 501 from the unsupported set
  test("404 and 501 -> process-fallback", async () => {
    const mod = await loadModule();
    const fake404 = startFakeOmlx({ statusScript: [{ status: 404 }] });
    expect(
      await mod.probeOmlxNativeCapability({ endpoint: fake404.endpoint, timeoutMs: 1000 }),
    ).toEqual({ mode: "process-fallback", reason: "NativeStatusUnsupported", httpStatus: 404 });
    const fake501 = startFakeOmlx({ statusScript: [{ status: 501 }] });
    expect(
      await mod.probeOmlxNativeCapability({ endpoint: fake501.endpoint, timeoutMs: 1000 }),
    ).toEqual({ mode: "process-fallback", reason: "NativeStatusUnsupported", httpStatus: 501 });
  });

  // kills mapping auth failures to a declared fallback
  test("401 -> unknown, not fallback", async () => {
    const fake = startFakeOmlx({ statusScript: [{ status: 401 }] });
    const mod = await loadModule();
    expect(
      await mod.probeOmlxNativeCapability({ endpoint: fake.endpoint, timeoutMs: 1000 }),
    ).toEqual({ mode: "unknown", reason: "Unauthorized", httpStatus: 401 });
  });

  // kills a probe that drops the apiKey: an authenticated engine must be
  // probed with the bearer the native client would send.
  test("authenticated engine: native with the apiKey, unknown without it", async () => {
    const fake = startFakeOmlx({ requireBearer: TEST_API_KEY });
    const mod = await loadModule();
    expect(
      await mod.probeOmlxNativeCapability({
        endpoint: fake.endpoint,
        timeoutMs: 1000,
        apiKey: TEST_API_KEY,
      }),
    ).toEqual({ mode: "native", reason: null, httpStatus: 200 });
    expect(
      await mod.probeOmlxNativeCapability({ endpoint: fake.endpoint, timeoutMs: 1000 }),
    ).toEqual({ mode: "unknown", reason: "Unauthorized", httpStatus: 401 });
    expect(fake.bearerSeen).toEqual([true, false]);
  });
});

// ── ensureOmlxNativeCapability ──────────────────────────────────────────

describe("ensureOmlxNativeCapability", () => {
  // kills removing the cache set, removing in-flight dedupe, or a cache key
  // that ignores host:port. The concurrent pair runs while the cache is
  // cold so a missing in-flight dedupe shows up as a second status hit.
  test("probe cached once per process per host", async () => {
    const mod = await loadModule();
    const ensure = (endpoint: { host: string; port: number }): Promise<OmlxCapability> =>
      mod.ensureOmlxNativeCapability({ endpoint, timeoutMs: 1000 });

    const fakeA = startFakeOmlx();
    await Promise.all([ensure(fakeA.endpoint), ensure(fakeA.endpoint)]);
    await ensure(fakeA.endpoint);
    await ensure(fakeA.endpoint);
    await ensure(fakeA.endpoint);
    expect(statusHits(fakeA)).toBe(1);

    const fakeB = startFakeOmlx();
    const fakeC = startFakeOmlx();
    await ensure(fakeB.endpoint);
    await ensure(fakeC.endpoint);
    expect(statusHits(fakeB)).toBe(1);
    expect(statusHits(fakeC)).toBe(1);

    const fake404 = startFakeOmlx({ statusScript: [{ status: 404 }] });
    await ensure(fake404.endpoint);
    await ensure(fake404.endpoint);
    await ensure(fake404.endpoint);
    expect(statusHits(fake404)).toBe(1);
  });

  // kills caching an unknown capability
  test("unknown is not cached", async () => {
    const fake = startFakeOmlx({
      statusScript: [{ status: 200, delayMs: 500 }, { status: 200 }],
    });
    const mod = await loadModule();
    const first = await mod.ensureOmlxNativeCapability({
      endpoint: fake.endpoint,
      timeoutMs: 50,
    });
    expect(first).toEqual({ mode: "unknown", reason: "Timeout", httpStatus: null });
    const second = await mod.ensureOmlxNativeCapability({
      endpoint: fake.endpoint,
      timeoutMs: 500,
    });
    expect(second).toEqual({ mode: "native", reason: null, httpStatus: 200 });
    expect(statusHits(fake)).toBe(2);
  });

  // kills a cache key that ignores the credential: an unauthenticated 401 must
  // not hide the keyed native answer, the keyed answer is cached, and a
  // different key re-probes rather than reusing it.
  test("cache is keyed by credential fingerprint", async () => {
    const fake = startFakeOmlx({ requireBearer: TEST_API_KEY });
    const mod = await loadModule();
    const ensure = (apiKey?: string): Promise<OmlxCapability> =>
      mod.ensureOmlxNativeCapability({
        endpoint: fake.endpoint,
        timeoutMs: 1000,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
    expect((await ensure()).mode).toBe("unknown");
    expect(await ensure(TEST_API_KEY)).toEqual({ mode: "native", reason: null, httpStatus: 200 });
    expect((await ensure(TEST_API_KEY)).mode).toBe("native");
    expect(statusHits(fake)).toBe(2);
    expect(await ensure("other-test-key")).toEqual({
      mode: "unknown",
      reason: "Unauthorized",
      httpStatus: 401,
    });
    expect(fake.bearerSeen).toEqual([false, true, false]);
  });
});

// ── resolveOmlxResidencyPath ────────────────────────────────────────────

describe("resolveOmlxResidencyPath", () => {
  const previousLeases = getResidencyLeaseRegistry();
  beforeEach(() => {
    setResidencyLeaseRegistry(createResidencyLeases());
  });
  afterEach(() => {
    setResidencyLeaseRegistry(previousLeases);
  });

  function resolveOpts(
    endpoint: { host: string; port: number },
    probeTimeoutMs = 1000,
  ): ResolveOptions {
    return {
      endpoint,
      hostedRel: REL,
      binding: {
        endpoint,
        modelId: ID,
        modelPath: `/models/${ID}`,
        artifactRevision: "fixture-artifact",
        runtimeGeneration: "fixture-generation",
        stillCurrent: () => true,
      },
      activityObservable: true,
      workload: "host-omlx",
      probeTimeoutMs,
    };
  }

  // kills a gate of the form `mode !== "process-fallback"`
  test("probe timeout -> held without process fallback", async () => {
    const fake = startFakeOmlx({ statusScript: [{ status: 200, delayMs: 500 }] });
    const mod = await loadModule();
    const result = await mod.resolveOmlxResidencyPath(resolveOpts(fake.endpoint, 50));
    expect(result.path).toBe("held");
    expect(result.capability).toEqual({
      mode: "unknown",
      reason: "Timeout",
      httpStatus: null,
    });
    expect("client" in result).toBe(false);
    await delay(600);
    expect(fake.log.every((entry) => entry === "GET /v1/models/status")).toBe(true);
    expect(fake.log.some((entry) => /\/(?:load|unload)$/.test(entry))).toBe(false);
  });

  // kills building or using the native client on fallback
  test("404 -> process path, no native calls", async () => {
    const fake = startFakeOmlx({ statusScript: [{ status: 404 }] });
    const mod = await loadModule();
    const result = await mod.resolveOmlxResidencyPath(resolveOpts(fake.endpoint));
    expect(result.path).toBe("process");
    expect(result.capability).toEqual({
      mode: "process-fallback",
      reason: "NativeStatusUnsupported",
      httpStatus: 404,
    });
    expect("client" in result).toBe(false);
    expect(fake.log).toEqual(["GET /v1/models/status"]);
  });

  // kills a gate that always returns process
  test("native -> native path with client", async () => {
    const fake = startFakeOmlx();
    const mod = await loadModule();
    const result = await mod.resolveOmlxResidencyPath(resolveOpts(fake.endpoint));
    expect(result.path).toBe("native");
    expect(result.capability.mode).toBe("native");
    expect("client" in result).toBe(true);
    if ("client" in result) {
      expect(typeof result.client.load).toBe("function");
      expect(typeof result.client.unload).toBe("function");
      expect(typeof result.client.status).toBe("function");
    }
    expect(fake.log).toEqual(["GET /v1/models/status"]);
  });

  // kills resolveOmlxResidencyPath not forwarding the client apiKey to the probe
  test("authenticated engine with apiKey -> native path", async () => {
    const fake = startFakeOmlx({ requireBearer: TEST_API_KEY });
    const mod = await loadModule();
    const result = await mod.resolveOmlxResidencyPath({
      ...resolveOpts(fake.endpoint),
      apiKey: TEST_API_KEY,
    });
    expect(result.path).toBe("native");
    expect(result.capability).toEqual({ mode: "native", reason: null, httpStatus: 200 });
    expect(fake.bearerSeen).toEqual([true]);
  });
});

// ── residencyStatus projection ──────────────────────────────────────────

describe("residencyStatus omlxNative", () => {
  // kills the router not being wired, re-probing on every status call, or
  // non-omlx hosts being included
  test("serving node projects oMLX capability rows", async () => {
    const fake = startFakeOmlx();
    saveHostManifests(fake);
    process.env["LLAMACTL_NODE_NAME"] = "local";
    const expected = {
      scope: "serving-process",
      workloads: [
        {
          workload: "host-omlx",
          endpoint: `127.0.0.1:${String(fake.endpoint.port)}`,
          mode: "native",
          reason: null,
          httpStatus: 200,
        },
      ],
    };
    const first = await residencyStatus("local");
    const second = await residencyStatus("local");
    expect(first.omlxNative).toEqual(expected);
    expect(second.omlxNative).toEqual(expected);
    expect(statusHits(fake)).toBe(1);
  });

  // kills removing the servingNode guard
  test("non-serving node reports NotServingNode without probing", async () => {
    const fake = startFakeOmlx();
    saveHostManifests(fake);
    process.env["LLAMACTL_NODE_NAME"] = "elsewhere";
    const result = await residencyStatus("local");
    expect(result.omlxNative).toEqual({
      scope: "serving-process",
      workloads: [
        {
          workload: "host-omlx",
          endpoint: `127.0.0.1:${String(fake.endpoint.port)}`,
          mode: "unknown",
          reason: "NotServingNode",
          httpStatus: null,
        },
      ],
    });
    expect(fake.log).toEqual([]);
  });
});
