/**
 * #282 DF-09 slice 2 — native oMLX status/load/unload client.
 * `src/residency/engine-client` and the new `@llamactl/core/engines`
 * exports land with the fix, so both seams are reached through a guarded
 * dynamic import and bracket access: at the pinned base every case fails
 * by assertion — never by a missing module or a type error. The fake
 * oMLX server mirrors jundot/omlx server.py at OMLX_REVISION
 * (list_models_status, load_model_public, unload_model, /api/status).
 */
import type { ResidencyLeases } from "@llamactl/core/residency/leases";

import * as coreEngines from "@llamactl/core/engines";
import { createResidencyLeases } from "@llamactl/core/residency/leases";
import { afterEach, describe, expect, test } from "bun:test";

// Pinned jundot/omlx revision: server.py list_models_status,
// load_model_public, unload_model and /api/status (engine_pool.get_status).
const OMLX_REVISION = "feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b";
const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const ID = "Qwen3-8B-MLX-4bit";

const core = coreEngines as unknown as Record<string, unknown>;

type ClientOpts = {
  endpoint: { host: string; port: number };
  hostedRel: string;
  activityObservable: boolean;
  apiKey?: string;
  readiness?: { path: string; expectStatus?: number };
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  leases?: { registry: ResidencyLeases; workload: string };
};

type NativeClient = {
  status(): Promise<unknown>;
  load(): Promise<unknown>;
  unload(): Promise<unknown>;
};

type ClientModule = {
  createOmlxNativeClient(opts: ClientOpts): NativeClient;
};

// The specifier stays a runtime `string` (built from import.meta.url) so
// tsc cannot resolve the not-yet-existing module — a literal specifier
// would be a resolution error, not an assertion failure.
async function loadClientModule(): Promise<ClientModule> {
  const href = new URL("../../src/residency/engine-client.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => ({}))) as unknown;
  const rec = mod as Record<string, unknown>;
  expect(typeof rec["createOmlxNativeClient"]).toBe("function");
  return mod as ClientModule;
}

type StatusFixtureModel = { id: string; loaded: boolean; is_loading: boolean; engineType?: string };

// Mirrors GET /v1/models/status (list_models_status) at OMLX_REVISION.
function statusFixtureV1(models: StatusFixtureModel[]): Record<string, unknown> {
  return {
    final_ceiling: 34359738368,
    current_model_memory: 0,
    model_count: models.length,
    loaded_count: models.filter((m) => m.loaded).length,
    load_seconds_per_gb_estimate: null,
    load_time_observations: 0,
    models: models.map((m) => {
      const base: Record<string, unknown> = {
        id: m.id,
        model_path: `/models/${m.id}`,
        loaded: m.loaded,
        is_loading: m.is_loading,
        loading_started_at: null,
        estimated_size: 5000000000,
        resident_estimated_size: 5000000000,
        distributed: false,
        actual_size: m.loaded ? 4800000000 : null,
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
      };
      // engine_type: "batched" for batched models (engine_pool.get_status default)
      if (m.engineType !== undefined) {
        base["engine_type"] = m.engineType;
      }
      return base;
    }),
  };
}

type ActivityCounts = { active: number; waiting: number };

// Mirrors GET /api/status (engine_pool.get_status) at OMLX_REVISION.
function activityFixtureV1(activity: ActivityCounts): Record<string, unknown> {
  return {
    status: "ok",
    version: "0.0.0",
    uptime_seconds: 1,
    models_discovered: 1,
    models_loaded: 0,
    models_loading: 0,
    default_model: null,
    loaded_models: [],
    total_requests: 0,
    active_requests: activity.active,
    waiting_requests: activity.waiting,
    model_memory_used: 0,
    model_memory_max: 0,
  };
}

function activityBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...activityFixtureV1({ active: 0, waiting: 0 }), ...overrides };
}

type FakeModelState = { loaded: boolean; is_loading: boolean; engineType?: string };

type StatusMode = "ok" | 404 | 500 | "garbage" | "hang";
type ActivityMode = "ok" | 500;
type LoadMode = "ok" | "already" | 404 | 409 | 500 | 507 | "garbage" | "hang";
type UnloadMode = "ok" | 400 | "400-stale" | 403 | 404 | 500 | "hang";

type FakeState = {
  models: Map<string, FakeModelState>;
  activity: ActivityCounts;
  readyStatus: number;
  statusMode: StatusMode;
  activityMode: ActivityMode;
  loadMode: LoadMode;
  unloadMode: UnloadMode;
};

type FakeCounts = {
  statusGets: number;
  activityGets: number;
  readyGets: number;
  loadPosts: number;
  unloadPosts: number;
  statusGetsAfterUnloadPost: number;
};

type FakeSeen = {
  authHeaders: string[];
  readyAuthHeaders: string[];
  unloadSearch: string[];
};

type FakeContext = {
  state: FakeState;
  counts: FakeCounts;
  seen: FakeSeen;
  apiKey: string | undefined;
  loadDelayMs: number;
};

type FakeOmlx = {
  endpoint: { host: string; port: number };
  state: FakeState;
  counts: FakeCounts;
  seen: FakeSeen;
  stop: () => Promise<void>;
};

const fakes: FakeOmlx[] = [];

afterEach(async () => {
  const pending = fakes.splice(0);
  await Promise.all(pending.map((fake): Promise<void> => fake.stop()));
});

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function hangResponse(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function actionModelId(path: string, action: "load" | "unload"): string | null {
  const prefix = "/v1/models/";
  const suffix = `/${action}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) {
    return null;
  }
  const id = path.slice(prefix.length, path.length - suffix.length);
  if (id === "" || id.includes("/")) {
    return null;
  }
  return decodeURIComponent(id);
}

function statusResponse(ctx: FakeContext): Response | Promise<Response> {
  ctx.counts.statusGets += 1;
  if (ctx.counts.unloadPosts > 0) {
    ctx.counts.statusGetsAfterUnloadPost += 1;
  }
  const mode = ctx.state.statusMode;
  if (mode === "hang") {
    return hangResponse();
  }
  if (mode === "garbage") {
    return new Response("not json", { status: 200 });
  }
  if (mode === 404 || mode === 500) {
    return jsonError(mode, "status unavailable");
  }
  const models: StatusFixtureModel[] = [...ctx.state.models.entries()].map(
    ([id, m]): StatusFixtureModel => ({
      id,
      loaded: m.loaded,
      is_loading: m.is_loading,
      ...(m.engineType !== undefined ? { engineType: m.engineType } : {}),
    }),
  );
  return Response.json(statusFixtureV1(models));
}

function activityResponse(ctx: FakeContext): Response {
  ctx.counts.activityGets += 1;
  if (ctx.state.activityMode === 500) {
    return jsonError(500, "activity unavailable");
  }
  return Response.json(activityFixtureV1(ctx.state.activity));
}

function readyResponse(ctx: FakeContext): Response {
  ctx.counts.readyGets += 1;
  return Response.json({}, { status: ctx.state.readyStatus });
}

async function loadResponse(ctx: FakeContext, id: string): Promise<Response> {
  ctx.counts.loadPosts += 1;
  const mode = ctx.state.loadMode;
  if (mode === "hang") {
    return await hangResponse();
  }
  if (mode === "garbage") {
    return Response.json({ weird: true });
  }
  if (mode === "already") {
    return Response.json({ status: "ok", model_id: id, message: `Already loaded: ${id}` });
  }
  if (typeof mode === "number") {
    return jsonError(mode, "load rejected");
  }
  const model = ctx.state.models.get(id);
  if (model === undefined) {
    return jsonError(404, `Model not found: ${id}`);
  }
  if (model.loaded) {
    return Response.json({ status: "ok", model_id: id, message: `Already loaded: ${id}` });
  }
  model.is_loading = true;
  await delay(ctx.loadDelayMs);
  model.loaded = true;
  model.is_loading = false;
  return Response.json({ status: "ok", model_id: id, message: `Loaded ${id}` });
}

function unloadResponse(
  ctx: FakeContext,
  id: string,
  search: string,
): Response | Promise<Response> {
  ctx.counts.unloadPosts += 1;
  ctx.seen.unloadSearch.push(search);
  const mode = ctx.state.unloadMode;
  if (mode === "hang") {
    return hangResponse();
  }
  const model = ctx.state.models.get(id);
  if (mode === "400-stale") {
    return jsonError(400, `Model not loaded: ${id}`);
  }
  if (mode === 400) {
    if (model !== undefined) {
      model.loaded = false;
      model.is_loading = false;
    }
    return jsonError(400, `Model not loaded: ${id}`);
  }
  if (typeof mode === "number") {
    return jsonError(mode, "unload rejected");
  }
  if (model === undefined) {
    return jsonError(404, `Model not found: ${id}`);
  }
  if (!model.loaded) {
    return jsonError(400, `Model not loaded: ${id}`);
  }
  model.loaded = false;
  return Response.json({ status: "ok", model_id: id });
}

function routeRequest(ctx: FakeContext, method: string, url: URL): Response | Promise<Response> {
  const path = url.pathname;
  if (method === "GET" && path === "/v1/models/status") {
    return statusResponse(ctx);
  }
  if (method === "GET" && path === "/api/status") {
    return activityResponse(ctx);
  }
  if (method === "GET" && path === "/ready") {
    return readyResponse(ctx);
  }
  if (method === "POST") {
    const loadId = actionModelId(path, "load");
    if (loadId !== null) {
      return loadResponse(ctx, loadId);
    }
    const unloadId = actionModelId(path, "unload");
    if (unloadId !== null) {
      return unloadResponse(ctx, unloadId, url.search);
    }
  }
  return new Response("not found", { status: 404 });
}

function startFakeOmlx(opts: { apiKey?: string; loadDelayMs?: number }): FakeOmlx {
  const state: FakeState = {
    models: new Map([[ID, { loaded: false, is_loading: false, engineType: "batched" }]]),
    activity: { active: 0, waiting: 0 },
    readyStatus: 503,
    statusMode: "ok",
    activityMode: "ok",
    loadMode: "ok",
    unloadMode: "ok",
  };
  const counts: FakeCounts = {
    statusGets: 0,
    activityGets: 0,
    readyGets: 0,
    loadPosts: 0,
    unloadPosts: 0,
    statusGetsAfterUnloadPost: 0,
  };
  const seen: FakeSeen = { authHeaders: [], readyAuthHeaders: [], unloadSearch: [] };
  const ctx: FakeContext = {
    state,
    counts,
    seen,
    apiKey: opts.apiKey,
    loadDelayMs: opts.loadDelayMs ?? 0,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (auth !== null) {
        seen.authHeaders.push(auth);
      }
      const isReadyProbe = req.method === "GET" && url.pathname === "/ready";
      if (isReadyProbe && auth !== null) {
        seen.readyAuthHeaders.push(auth);
      }
      if (ctx.apiKey !== undefined && !isReadyProbe && auth !== `Bearer ${ctx.apiKey}`) {
        return Response.json({ detail: "Unauthorized" }, { status: 401 });
      }
      return routeRequest(ctx, req.method, url);
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
    state,
    counts,
    seen,
    stop,
  };
  fakes.push(fake);
  return fake;
}

function baseClientOpts(endpoint: { host: string; port: number }): ClientOpts {
  return {
    endpoint,
    hostedRel: REL,
    activityObservable: true,
    apiKey: "test-key",
    requestTimeoutMs: 600,
    statusTimeoutMs: 300,
  };
}

async function clientFor(fake: FakeOmlx, opts?: ClientOpts): Promise<NativeClient> {
  const mod = await loadClientModule();
  return mod.createOmlxNativeClient(opts ?? baseClientOpts(fake.endpoint));
}

describe("core contract", () => {
  test("C1 core engines exports the native oMLX contract", () => {
    expect(OMLX_REVISION).toHaveLength(40);
    expect(typeof core["parseOmlxModelsStatus"]).toBe("function");
    expect(typeof core["deriveOmlxResidency"]).toBe("function");
    expect(typeof core["parseOmlxActivity"]).toBe("function");
    expect(typeof core["omlxModelActionPath"]).toBe("function");
    expect(typeof core["checkServingReadiness"]).toBe("function");
    expect(core["OMLX_MODELS_STATUS_PATH"]).toBe("/v1/models/status");
    expect(core["OMLX_ACTIVITY_PATH"]).toBe("/api/status");
    const actionPath = core["omlxModelActionPath"];
    expect(typeof actionPath).toBe("function");
    const pathFor = actionPath as (action: string, modelId: string) => string;
    expect(pathFor("load", ID)).toBe("/v1/models/Qwen3-8B-MLX-4bit/load");
    expect(pathFor("unload", "a/b c")).toBe("/v1/models/a%2Fb%20c/unload");
  });

  test("C2 parseOmlxActivity maps /api/status to request counts", () => {
    const fn = core["parseOmlxActivity"];
    expect(typeof fn).toBe("function");
    const parse = fn as (body: unknown) => unknown;
    expect(parse(activityFixtureV1({ active: 2, waiting: 1 }))).toStrictEqual({
      activeRequests: 2,
      waitingRequests: 1,
    });
    expect(parse(activityFixtureV1({ active: 0, waiting: 0 }))).toStrictEqual({
      activeRequests: 0,
      waitingRequests: 0,
    });
    const missingWaiting = activityFixtureV1({ active: 0, waiting: 0 });
    delete missingWaiting["waiting_requests"];
    const invalidBodies: unknown[] = [
      null,
      {},
      activityBody({ active_requests: -1 }),
      activityBody({ active_requests: 1.5 }),
      activityBody({ active_requests: "2" }),
      missingWaiting,
    ];
    for (const body of invalidBodies) {
      expect(parse(body)).toBeNull();
    }
  });
});

describe("status()", () => {
  test("S1 reports a discovered model", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const client = await clientFor(fake);
    expect(await client.status()).toStrictEqual({
      state: "discovered",
      modelId: ID,
      engineType: "batched",
    });
    expect(fake.seen.authHeaders).toContain("Bearer test-key");
  });

  test("S2 reports a loading model", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.is_loading = true;
    const client = await clientFor(fake);
    expect(await client.status()).toStrictEqual({
      state: "loading",
      modelId: ID,
      engineType: "batched",
    });
  });

  test("S3 promotes a loaded idle model to ready", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const client = await clientFor(fake);
    expect(await client.status()).toStrictEqual({
      state: "ready",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
      activity: { activeRequests: 0, waitingRequests: 0 },
    });
    expect(fake.counts.readyGets).toBe(0);
  });

  test("S4 readiness probe gates ready vs resident", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const opts: ClientOpts = {
      ...baseClientOpts(fake.endpoint),
      readiness: { path: "/ready" },
    };
    const client = await clientFor(fake, opts);
    fake.state.readyStatus = 503;
    expect(await client.status()).toMatchObject({ state: "resident", modelId: ID });
    fake.state.readyStatus = 200;
    expect(await client.status()).toMatchObject({ state: "ready", modelId: ID });
    expect(fake.seen.readyAuthHeaders).toContain("Bearer test-key");
  });

  test("S5 reports busy while requests are active or waiting", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.readyStatus = 200;
    const opts: ClientOpts = {
      ...baseClientOpts(fake.endpoint),
      readiness: { path: "/ready" },
    };
    const client = await clientFor(fake, opts);
    fake.state.activity = { active: 1, waiting: 0 };
    expect(await client.status()).toMatchObject({
      state: "busy",
      modelId: ID,
      activity: { activeRequests: 1, waitingRequests: 0 },
    });
    fake.state.activity = { active: 0, waiting: 1 };
    expect(await client.status()).toMatchObject({ state: "busy", modelId: ID });

    const fakeUnknown = startFakeOmlx({ apiKey: "test-key" });
    fakeUnknown.state.models.get(ID)!.loaded = true;
    fakeUnknown.state.activityMode = 500;
    const clientUnknown = await clientFor(fakeUnknown);
    expect(await clientUnknown.status()).toMatchObject({
      state: "ready",
      modelId: ID,
      activity: "unknown",
    });
  });

  test("S6 maps status endpoint failures", async () => {
    const fake500 = startFakeOmlx({ apiKey: "test-key" });
    fake500.state.statusMode = 500;
    const client500 = await clientFor(fake500);
    expect(await client500.status()).toStrictEqual({
      state: "failed",
      reason: "StatusHttpError",
      httpStatus: 500,
    });

    const fake404 = startFakeOmlx({ apiKey: "test-key" });
    fake404.state.statusMode = 404;
    const client404 = await clientFor(fake404);
    expect(await client404.status()).toStrictEqual({
      state: "failed",
      reason: "NativeStatusUnsupported",
      httpStatus: 404,
    });

    const fakeGarbage = startFakeOmlx({ apiKey: "test-key" });
    fakeGarbage.state.statusMode = "garbage";
    const clientGarbage = await clientFor(fakeGarbage);
    expect(await clientGarbage.status()).toStrictEqual({
      state: "failed",
      reason: "MalformedStatus",
    });

    const fakeAuth = startFakeOmlx({ apiKey: "test-key" });
    const wrongKey: ClientOpts = { ...baseClientOpts(fakeAuth.endpoint), apiKey: "wrong" };
    const clientAuth = await clientFor(fakeAuth, wrongKey);
    expect(await clientAuth.status()).toStrictEqual({
      state: "failed",
      reason: "Unauthorized",
      httpStatus: 401,
    });

    const fakeStopped = startFakeOmlx({ apiKey: "test-key" });
    const stoppedClient = await clientFor(fakeStopped);
    await fakeStopped.stop();
    expect(await stoppedClient.status()).toStrictEqual({
      state: "unknown",
      reason: "StatusUnreachable",
    });
  });

  test("S7 reports unreachable when the status endpoint hangs", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.statusMode = "hang";
    const client = await clientFor(fake);
    expect(await client.status()).toStrictEqual({ state: "unknown", reason: "StatusUnreachable" });
  }, 5000);

  test("S8 reports unknown activity when activity is not observable", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const opts: ClientOpts = { ...baseClientOpts(fake.endpoint), activityObservable: false };
    const client = await clientFor(fake, opts);
    expect(await client.status()).toStrictEqual({
      state: "ready",
      modelId: ID,
      actualSize: 4800000000,
      residentEstimatedSize: 5000000000,
      activity: "unknown",
    });
    expect(fake.counts.activityGets).toBe(0);
  });
});

describe("load()", () => {
  test("L1 loads an unloaded model and dedupes a second load", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key", loadDelayMs: 20 });
    const client = await clientFor(fake);
    expect(await client.load()).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(1);
    expect(await client.status()).toMatchObject({ state: "ready", modelId: ID });
    expect(await client.load()).toStrictEqual({ kind: "already-loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(1);
  });

  test("L2 concurrent loads on separate clients post once", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key", loadDelayMs: 50 });
    const clientA = await clientFor(fake);
    const clientB = await clientFor(fake);
    const [resultA, resultB] = await Promise.all([clientA.load(), clientB.load()]);
    expect(fake.counts.loadPosts).toBe(1);
    expect(resultA).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(resultB).toStrictEqual({ kind: "loaded", modelId: ID });
  });

  test("L3 refuses load without a POST when state forbids it", async () => {
    const fakeLoaded = startFakeOmlx({ apiKey: "test-key" });
    fakeLoaded.state.models.get(ID)!.loaded = true;
    const loadedClient = await clientFor(fakeLoaded);
    expect(await loadedClient.load()).toStrictEqual({ kind: "already-loaded", modelId: ID });
    expect(fakeLoaded.counts.loadPosts).toBe(0);

    const fakeLoading = startFakeOmlx({ apiKey: "test-key" });
    fakeLoading.state.models.get(ID)!.is_loading = true;
    const loadingClient = await clientFor(fakeLoading);
    expect(await loadingClient.load()).toStrictEqual({
      kind: "refused",
      reason: "LoadInProgress",
    });
    expect(fakeLoading.counts.loadPosts).toBe(0);

    const fakeStatus = startFakeOmlx({ apiKey: "test-key" });
    fakeStatus.state.statusMode = 500;
    const statusClient = await clientFor(fakeStatus);
    expect(await statusClient.load()).toStrictEqual({
      kind: "refused",
      reason: "StatusUnavailable",
    });
    expect(fakeStatus.counts.loadPosts).toBe(0);
  });

  test("L4 maps load POST failures", async () => {
    const cases: { mode: LoadMode; expected: Record<string, unknown> }[] = [
      { mode: 507, expected: { kind: "failed", reason: "InsufficientMemory", httpStatus: 507 } },
      { mode: 409, expected: { kind: "failed", reason: "Conflict", httpStatus: 409 } },
      { mode: 404, expected: { kind: "failed", reason: "ModelNotListed", httpStatus: 404 } },
      {
        mode: 500,
        expected: {
          kind: "ambiguous",
          reason: "HttpError",
          reservation: "uncertain",
          httpStatus: 500,
        },
      },
      {
        mode: "garbage",
        expected: { kind: "ambiguous", reason: "MalformedResponse", reservation: "uncertain" },
      },
    ];
    for (const { mode, expected } of cases) {
      const fake = startFakeOmlx({ apiKey: "test-key" });
      fake.state.loadMode = mode;
      const client = await clientFor(fake);
      expect(await client.load()).toStrictEqual(expected);
      expect(fake.counts.loadPosts).toBe(1);
    }
  });

  test("L5 reports an ambiguous timeout when load hangs", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.loadMode = "hang";
    const client = await clientFor(fake);
    expect(await client.load()).toStrictEqual({
      kind: "ambiguous",
      reason: "Timeout",
      reservation: "uncertain",
    });
    expect(fake.counts.loadPosts).toBe(1);
  }, 5000);

  test("L6 maps an already-loaded POST to already-loaded", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.loadMode = "already";
    const client = await clientFor(fake);
    expect(await client.load()).toStrictEqual({ kind: "already-loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(1);
  });
});

describe("unload()", () => {
  test("U1 unloads a loaded idle model", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
    expect(fake.seen.unloadSearch).toStrictEqual([""]);
    expect(await client.status()).toStrictEqual({
      state: "discovered",
      modelId: ID,
      engineType: "batched",
    });
    expect(await client.unload()).toStrictEqual({
      kind: "already-unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
  });

  test("U2 refuses unload while busy or when activity is unknown", async () => {
    const fakeActive = startFakeOmlx({ apiKey: "test-key" });
    fakeActive.state.models.get(ID)!.loaded = true;
    fakeActive.state.activity = { active: 1, waiting: 0 };
    const activeClient = await clientFor(fakeActive);
    expect(await activeClient.unload()).toStrictEqual({
      kind: "refused",
      reason: "BackendBusy",
      reservation: "held",
    });
    expect(fakeActive.counts.unloadPosts).toBe(0);
    expect(fakeActive.state.models.get(ID)!.loaded).toBe(true);

    const fakeWaiting = startFakeOmlx({ apiKey: "test-key" });
    fakeWaiting.state.models.get(ID)!.loaded = true;
    fakeWaiting.state.activity = { active: 0, waiting: 1 };
    const waitingClient = await clientFor(fakeWaiting);
    expect(await waitingClient.unload()).toStrictEqual({
      kind: "refused",
      reason: "BackendBusy",
      reservation: "held",
    });
    expect(fakeWaiting.counts.unloadPosts).toBe(0);

    const fakeActivity = startFakeOmlx({ apiKey: "test-key" });
    fakeActivity.state.models.get(ID)!.loaded = true;
    fakeActivity.state.activityMode = 500;
    const activityClient = await clientFor(fakeActivity);
    expect(await activityClient.unload()).toStrictEqual({
      kind: "refused",
      reason: "ActivityUnknown",
      reservation: "held",
    });
    expect(fakeActivity.counts.unloadPosts).toBe(0);
  });

  test("U3 confirms a raced 400 unload via a follow-up status", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.unloadMode = 400;
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "already-unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
    expect(fake.counts.statusGetsAfterUnloadPost).toBeGreaterThanOrEqual(1);
  });

  test("U4 reports an ambiguous unconfirmed unload on stale 400", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.unloadMode = "400-stale";
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "ambiguous",
      reason: "UnloadUnconfirmed",
      reservation: "uncertain",
      httpStatus: 400,
    });
  });

  test("U5 maps unload POST failures", async () => {
    const cases: { mode: UnloadMode; expected: Record<string, unknown> }[] = [
      {
        mode: 500,
        expected: {
          kind: "ambiguous",
          reason: "HttpError",
          reservation: "uncertain",
          httpStatus: 500,
        },
      },
      {
        mode: 404,
        expected: {
          kind: "failed",
          reason: "ModelNotListed",
          reservation: "held",
          httpStatus: 404,
        },
      },
      {
        mode: 403,
        expected: { kind: "failed", reason: "Unauthorized", reservation: "held", httpStatus: 403 },
      },
    ];
    for (const { mode, expected } of cases) {
      const fake = startFakeOmlx({ apiKey: "test-key" });
      fake.state.models.get(ID)!.loaded = true;
      fake.state.unloadMode = mode;
      const client = await clientFor(fake);
      expect(await client.unload()).toStrictEqual(expected);
      expect(fake.counts.unloadPosts).toBe(1);
    }
  });

  test("U6 reports an ambiguous timeout when unload hangs", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.unloadMode = "hang";
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "ambiguous",
      reason: "Timeout",
      reservation: "uncertain",
    });
    expect(fake.counts.unloadPosts).toBe(1);
  }, 5000);

  test("U7 refuses unload without a POST when state forbids it", async () => {
    const fakeOff = startFakeOmlx({ apiKey: "test-key" });
    const offClient = await clientFor(fakeOff);
    expect(await offClient.unload()).toStrictEqual({
      kind: "already-unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fakeOff.counts.unloadPosts).toBe(0);

    const fakeLoading = startFakeOmlx({ apiKey: "test-key" });
    fakeLoading.state.models.get(ID)!.is_loading = true;
    const loadingClient = await clientFor(fakeLoading);
    expect(await loadingClient.unload()).toStrictEqual({
      kind: "refused",
      reason: "LoadInProgress",
      reservation: "held",
    });
    expect(fakeLoading.counts.unloadPosts).toBe(0);

    const fakeStatus = startFakeOmlx({ apiKey: "test-key" });
    fakeStatus.state.statusMode = 500;
    const statusClient = await clientFor(fakeStatus);
    expect(await statusClient.unload()).toStrictEqual({
      kind: "refused",
      reason: "StatusUnavailable",
      reservation: "held",
    });
    expect(fakeStatus.counts.unloadPosts).toBe(0);
  });

  test("U8 refuses unload when activity is not observable", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const opts: ClientOpts = { ...baseClientOpts(fake.endpoint), activityObservable: false };
    const client = await clientFor(fake, opts);
    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "ActivityUnknown",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(fake.counts.activityGets).toBe(0);
    expect(fake.state.models.get(ID)!.loaded).toBe(true);
  });

  test("U9 embedding model (non-batch engine) fails closed with ActivityUnknown", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const model = fake.state.models.get(ID)!;
    model.loaded = true;
    model.engineType = "embedding";
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "ActivityUnknown",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(fake.counts.activityGets).toBe(0);
    expect(fake.state.models.get(ID)!.loaded).toBe(true);
  });

  test("U10 reranker model (non-batch engine) fails closed with ActivityUnknown", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const model = fake.state.models.get(ID)!;
    model.loaded = true;
    model.engineType = "reranker";
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "ActivityUnknown",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(fake.counts.activityGets).toBe(0);
    expect(fake.state.models.get(ID)!.loaded).toBe(true);
  });

  test("U11 batched model unloads when idle", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const model = fake.state.models.get(ID)!;
    model.loaded = true;
    model.engineType = "batched";
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
    expect(fake.state.models.get(ID)!.loaded).toBe(false);
  });

  test("U12 missing engine_type refuses unload with ActivityUnknown", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const model = fake.state.models.get(ID)!;
    model.loaded = true;
    delete model.engineType;
    const client = await clientFor(fake);
    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "ActivityUnknown",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(fake.counts.activityGets).toBe(0);
    expect(fake.state.models.get(ID)!.loaded).toBe(true);
  });
});

describe("cross-operation", () => {
  test("X1 refuses unload while a load is in flight", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key", loadDelayMs: 300 });
    const clientA = await clientFor(fake);
    const clientB = await clientFor(fake);
    const pending = clientA.load();
    expect(await clientB.unload()).toStrictEqual({
      kind: "refused",
      reason: "OperationInProgress",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(await pending).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(await clientA.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
  });
});

describe("lease fencing", () => {
  const W = "omlx-host";

  async function leasedClientFor(fake: FakeOmlx, registry: ResidencyLeases): Promise<NativeClient> {
    const opts: ClientOpts = {
      ...baseClientOpts(fake.endpoint),
      leases: { registry, workload: W },
    };
    return await clientFor(fake, opts);
  }

  test("F1 refuses unload while a lease is held, then unloads and commits once released", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    const a = registry.acquire(W);
    expect(a.ok).toBe(true);
    if (!a.ok) {
      throw new Error(`acquire(${W}) refused`);
    }

    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "LeasesActive",
      reservation: "held",
      active: [a.lease.id],
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
    expect(fake.state.models.get(ID)!.loaded).toBe(true);

    a.lease.release();

    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(registry.acquire(W)).toMatchObject({ ok: false, reason: "Unloaded" });
  });

  test("F2 drain fences new acquires while native unload is in flight; ambiguous outcome cancels the drain", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.unloadMode = "hang";
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    const p = client.unload();
    expect(registry.acquire(W)).toMatchObject({ ok: false, reason: "Draining" });

    expect(await p).toStrictEqual({
      kind: "ambiguous",
      reason: "Timeout",
      reservation: "uncertain",
    });
    expect(registry.snapshot(W)).toMatchObject({ phase: "open", epoch: 1, active: [] });
    expect(registry.acquire(W).ok).toBe(true);
  }, 5000);

  test("F3 refusal and failure outcomes cancel the drain", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    fake.state.activity = { active: 1, waiting: 0 };
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "BackendBusy",
      reservation: "held",
    });
    expect(registry.snapshot(W)).toMatchObject({ phase: "open", epoch: 1 });
    expect(registry.acquire(W).ok).toBe(true);
  });

  test("F4 commit fences admission until a native load reopens it", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    const committed = registry.snapshot(W);
    expect(committed.phase).toBe("unloaded");

    expect(await client.unload()).toStrictEqual({
      kind: "already-unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(1);
    expect(registry.snapshot(W).epoch).toBe(committed.epoch);

    expect(await client.load()).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(registry.snapshot(W).phase).toBe("open");
    expect(registry.acquire(W).ok).toBe(true);
  });

  test("F5 refuses unload while another drain owns the workload", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    const d = registry.beginDrain(W);
    expect(d.ok).toBe(true);
    if (!d.ok) {
      throw new Error(`beginDrain(${W}) refused`);
    }

    expect(await client.unload()).toStrictEqual({
      kind: "refused",
      reason: "DrainInProgress",
      reservation: "held",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.commitUnload(d.token)).toStrictEqual({ ok: true, revoked: [] });
  });

  test("F6 failed/ambiguous native load does NOT call reopen — phase stays 'unloaded'", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(fake.counts.unloadPosts).toBe(1);

    fake.state.loadMode = 500;
    const loadResult = await client.load();
    expect(loadResult).toStrictEqual({
      kind: "ambiguous",
      reason: "HttpError",
      reservation: "uncertain",
      httpStatus: 500,
    });
    expect(fake.counts.loadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(registry.acquire(W)).toMatchObject({ ok: false, reason: "Unloaded" });
  });

  test("F7 failed native load (timeout) does NOT call reopen", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(fake.counts.unloadPosts).toBe(1);

    fake.state.loadMode = "hang";
    const loadResult = await client.load();
    expect(loadResult).toStrictEqual({
      kind: "ambiguous",
      reason: "Timeout",
      reservation: "uncertain",
    });
    expect(fake.counts.loadPosts).toBe(1);
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(registry.acquire(W)).toMatchObject({ ok: false, reason: "Unloaded" });
  }, 5000);

  test("F8 already-unloaded commit branch on open workload", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(registry.snapshot(W).phase).toBe("open");
    expect(fake.state.models.get(ID)!.loaded).toBe(false);

    const unloadResult = await client.unload();
    expect(unloadResult).toStrictEqual({
      kind: "already-unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(fake.counts.unloadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(registry.acquire(W)).toMatchObject({ ok: false, reason: "Unloaded" });
  });

  test("F9 already-loaded from reopen set reopens the committed workload", async () => {
    const fake = startFakeOmlx({ apiKey: "test-key" });
    fake.state.models.get(ID)!.loaded = true;
    const registry = createResidencyLeases();
    const client = await leasedClientFor(fake, registry);

    expect(await client.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(registry.snapshot(W).phase).toBe("unloaded");
    expect(fake.counts.unloadPosts).toBe(1);

    fake.state.models.get(ID)!.loaded = true;
    const loadResult = await client.load();
    expect(loadResult).toStrictEqual({ kind: "already-loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(0);
    expect(registry.snapshot(W).phase).toBe("open");
    expect(registry.acquire(W).ok).toBe(true);
  });
});
