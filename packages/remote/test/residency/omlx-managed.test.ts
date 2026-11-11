/**
 * #282 DF-09 — managed oMLX residency: target-admission-gated
 * ensureLoaded/unload over the native client, plus the claim-handle
 * transitions (releaseVerified, demoteUncertain) the managed layer needs
 * to retire resident and uncertain claims. `src/residency/omlx-managed`
 * and the new handle methods land with the fix, so the module is reached
 * through a guarded dynamic import and the handle methods through bracket
 * access: at the pinned base every case fails by assertion — never by a
 * missing module or a type error. The fake oMLX server mirrors
 * jundot/omlx server.py at OMLX_REVISION (list_models_status,
 * load_model_public, unload_model, /api/status).
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  createOmlxNativeClient,
  type OmlxNativeClient,
} from "../../src/residency/engine-client.js";
import {
  createTargetAdmissionAuthority,
  type TargetAdmissionAuthority,
  type TargetAdmissionClaimHandle,
} from "../../src/workload/admission.js";

// Pinned jundot/omlx revision: server.py list_models_status,
// load_model_public, unload_model and /api/status (engine_pool.get_status).
const OMLX_REVISION = "feec0a0e4eda6ad5c227a5f9ee216c6fb6d2fe9b";
const REL = "mlx-community/Qwen3-8B-MLX-4bit";
const ID = "Qwen3-8B-MLX-4bit";
const API_KEY = "test-key";

type ManagedResidencyState = "unclaimed" | "pending" | "resident" | "uncertain";

type ManagedResidencyOptions = {
  client: OmlxNativeClient;
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number;
  budgetGiB: () => number | undefined;
};

type ManagedResidency = {
  ensureLoaded(): Promise<unknown>;
  unload(): Promise<unknown>;
  residency(): ManagedResidencyState | Promise<ManagedResidencyState>;
};

type OmlxManagedModule = {
  createManagedOmlxResidency(opts: ManagedResidencyOptions): ManagedResidency;
};

// The specifier stays a runtime `string` (built from import.meta.url) so
// tsc cannot resolve the not-yet-existing module — a literal specifier
// would be a resolution error, not an assertion failure.
async function loadManagedModule(): Promise<OmlxManagedModule> {
  const href = new URL("../../src/residency/omlx-managed.ts", import.meta.url).href;
  const mod = (await import(href).catch(() => ({}))) as unknown;
  const rec = mod as Record<string, unknown>;
  expect(typeof rec["createManagedOmlxResidency"]).toBe("function");
  return mod as OmlxManagedModule;
}

// --- fake oMLX server ---

type FakeModel = { loaded: boolean; is_loading: boolean };

type FakeState = {
  model: FakeModel;
  activity: { active: number; waiting: number };
  loadMode: "ok" | 409 | 500 | 507 | "hang";
  unloadMode: "ok" | 500 | "hang";
};

type FakeCounts = {
  statusGets: number;
  activityGets: number;
  loadPosts: number;
  unloadPosts: number;
  total: number;
};

type FakeOmlx = {
  endpoint: { host: string; port: number };
  state: FakeState;
  counts: FakeCounts;
  loadPosted: Promise<void>;
  stop: () => Promise<void>;
};

const fakes: FakeOmlx[] = [];

afterEach(async () => {
  const pending = fakes.splice(0);
  await Promise.all(pending.map((fake): Promise<void> => fake.stop()));
});

// Mirrors GET /v1/models/status (list_models_status) at OMLX_REVISION.
function statusFixtureV1(model: FakeModel): Record<string, unknown> {
  return {
    final_ceiling: 34359738368,
    current_model_memory: 0,
    model_count: 1,
    loaded_count: model.loaded ? 1 : 0,
    load_seconds_per_gb_estimate: null,
    load_time_observations: 0,
    models: [
      {
        id: ID,
        model_path: `/models/${ID}`,
        loaded: model.loaded,
        is_loading: model.is_loading,
        loading_started_at: null,
        estimated_size: 5000000000,
        resident_estimated_size: 5000000000,
        distributed: false,
        actual_size: model.loaded ? 4800000000 : null,
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

// Mirrors GET /api/status (engine_pool.get_status) at OMLX_REVISION.
function activityFixtureV1(activity: { active: number; waiting: number }): Record<string, unknown> {
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

type FakeContext = {
  state: FakeState;
  counts: FakeCounts;
  loadDelayMs: number;
  onLoadPost: () => void;
};

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

function statusResponse(ctx: FakeContext): Response {
  ctx.counts.statusGets += 1;
  return Response.json(statusFixtureV1(ctx.state.model));
}

function activityResponse(ctx: FakeContext): Response {
  ctx.counts.activityGets += 1;
  return Response.json(activityFixtureV1(ctx.state.activity));
}

async function loadResponse(ctx: FakeContext, id: string): Promise<Response> {
  ctx.counts.loadPosts += 1;
  ctx.onLoadPost();
  const mode = ctx.state.loadMode;
  if (mode === "hang") {
    return await hangResponse();
  }
  if (mode === 409) {
    return jsonError(409, "Model X is already being loaded");
  }
  if (typeof mode === "number") {
    return jsonError(mode, "load rejected");
  }
  if (id !== ID) {
    return jsonError(404, `Model not found: ${id}`);
  }
  if (ctx.state.model.loaded) {
    return Response.json({ status: "ok", model_id: id, message: `Already loaded: ${id}` });
  }
  ctx.state.model.is_loading = true;
  await delay(ctx.loadDelayMs);
  ctx.state.model.loaded = true;
  ctx.state.model.is_loading = false;
  return Response.json({ status: "ok", model_id: id, message: `Loaded ${id}` });
}

function unloadResponse(ctx: FakeContext, id: string): Response | Promise<Response> {
  ctx.counts.unloadPosts += 1;
  const mode = ctx.state.unloadMode;
  if (mode === "hang") {
    return hangResponse();
  }
  if (typeof mode === "number") {
    return jsonError(mode, "unload rejected");
  }
  if (id !== ID) {
    return jsonError(404, `Model not found: ${id}`);
  }
  if (!ctx.state.model.loaded) {
    return jsonError(400, `Model not loaded: ${id}`);
  }
  ctx.state.model.loaded = false;
  ctx.state.model.is_loading = false;
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
  if (method === "POST") {
    const loadId = actionModelId(path, "load");
    if (loadId !== null) {
      return loadResponse(ctx, loadId);
    }
    const unloadId = actionModelId(path, "unload");
    if (unloadId !== null) {
      return unloadResponse(ctx, unloadId);
    }
  }
  return new Response("not found", { status: 404 });
}

function startFakeOmlx(opts: { loadDelayMs?: number } = {}): FakeOmlx {
  const state: FakeState = {
    model: { loaded: false, is_loading: false },
    activity: { active: 0, waiting: 0 },
    loadMode: "ok",
    unloadMode: "ok",
  };
  const counts: FakeCounts = {
    statusGets: 0,
    activityGets: 0,
    loadPosts: 0,
    unloadPosts: 0,
    total: 0,
  };
  const ctx: FakeContext = {
    state,
    counts,
    loadDelayMs: opts.loadDelayMs ?? 0,
    onLoadPost: () => undefined,
  };
  const loadPosted = new Promise<void>((resolve) => {
    ctx.onLoadPost = (): void => {
      resolve();
    };
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      ctx.counts.total += 1;
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
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
    loadPosted,
    stop,
  };
  fakes.push(fake);
  return fake;
}

// --- helpers ---

function nativeClientFor(fake: FakeOmlx): OmlxNativeClient {
  // requestTimeoutMs 300 clears the 150 ms load delay while still bounding
  // the hang modes; statusTimeoutMs 200 keeps status reads fast.
  return createOmlxNativeClient({
    endpoint: fake.endpoint,
    hostedRel: REL,
    activityObservable: true,
    apiKey: API_KEY,
    requestTimeoutMs: 300,
    statusTimeoutMs: 200,
  });
}

function managedOpts(
  client: OmlxNativeClient,
  authority: TargetAdmissionAuthority,
  budgetGiB: () => number | undefined = () => 24,
): ManagedResidencyOptions {
  return {
    client,
    authority,
    targetIdentity: "node-a",
    runtimeKey: "omlx-host",
    specDigest: "d1",
    allocationGiB: 8,
    budgetGiB,
  };
}

function createResidency(
  mod: OmlxManagedModule,
  fake: FakeOmlx,
  authority: TargetAdmissionAuthority,
  budgetGiB?: () => number | undefined,
): ManagedResidency {
  return mod.createManagedOmlxResidency(managedOpts(nativeClientFor(fake), authority, budgetGiB));
}

async function loadResidency(
  mod: OmlxManagedModule,
  fake: FakeOmlx,
  authority: TargetAdmissionAuthority,
): Promise<ManagedResidency> {
  const residency = createResidency(mod, fake, authority);
  expect(await residency.ensureLoaded()).toStrictEqual({ kind: "loaded", modelId: ID });
  return residency;
}

function claimTarget(
  authority: TargetAdmissionAuthority,
  runtimeKey: string,
  allocationGiB: number,
  budgetGiB: number,
): ReturnType<TargetAdmissionAuthority["tryClaim"]> {
  return authority.tryClaim({
    targetIdentity: "node-a",
    runtimeKey,
    specDigest: "d1",
    kind: "ModelHost",
    allocationGiB,
    budgetGiB,
  });
}

// releaseVerified/demoteUncertain land on TargetAdmissionClaimHandle with
// the fix; bracket access keeps the base type-check honest.
async function callClaimMethod(
  handle: TargetAdmissionClaimHandle,
  name: "releaseVerified" | "demoteUncertain",
): Promise<void> {
  const method = (handle as unknown as Record<string, unknown>)[name];
  expect(typeof method).toBe("function");
  await Promise.resolve((method as () => unknown)());
}

async function expectUncertainAfterAmbiguousUnload(
  mod: OmlxManagedModule,
  fake: FakeOmlx,
  expected: Record<string, unknown>,
): Promise<void> {
  const authority = createTargetAdmissionAuthority();
  const residency = await loadResidency(mod, fake, authority);
  expect(await residency.unload()).toStrictEqual(expected);
  const snap = authority.snapshot("node-a");
  expect(snap).toHaveLength(1);
  expect(snap[0]?.state).toBe("uncertain");
  // The uncertain claim keeps charging the budget.
  const probe = claimTarget(authority, "probe-host", 20, 24);
  expect(probe.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
  // ensureLoaded refuses without touching the backend at all.
  const statusBefore = fake.counts.statusGets;
  const loadBefore = fake.counts.loadPosts;
  const totalBefore = fake.counts.total;
  expect(await residency.ensureLoaded()).toStrictEqual({
    kind: "refused",
    reason: "ResidencyUncertain",
  });
  expect(fake.counts.statusGets).toBe(statusBefore);
  expect(fake.counts.loadPosts).toBe(loadBefore);
  expect(fake.counts.total).toBe(totalBefore);
}

// --- admission claim handle transitions (A) ---

describe("claim handle transitions", () => {
  test("A1 releaseVerified releases a resident claim and ignores pending claims", async () => {
    const authority = createTargetAdmissionAuthority();
    const first = claimTarget(authority, "omlx-host", 8, 24);
    expect(first.decision.kind).toBe("admit");
    const handle = first.handle!;
    handle.markResident();
    expect(handle.state()).toBe("resident");
    await callClaimMethod(handle, "releaseVerified");
    expect(handle.state()).toBe("released");
    expect(authority.snapshot("node-a")).toHaveLength(0);

    const second = claimTarget(authority, "omlx-host", 8, 24);
    expect(second.decision.kind).toBe("admit");
    const pending = second.handle!;
    await callClaimMethod(pending, "releaseVerified");
    expect(pending.state()).toBe("pending");
    expect(authority.snapshot("node-a")).toHaveLength(1);
  });

  test("A2 demoteUncertain demotes a resident claim and releaseVerified retires it", async () => {
    const authority = createTargetAdmissionAuthority();
    const first = claimTarget(authority, "omlx-host", 8, 24);
    expect(first.decision.kind).toBe("admit");
    const handle = first.handle!;
    handle.markResident();
    expect(handle.state()).toBe("resident");
    await callClaimMethod(handle, "demoteUncertain");
    expect(handle.state()).toBe("uncertain");
    expect(authority.snapshot("node-a")[0]?.state).toBe("uncertain");

    const conflict = claimTarget(authority, "omlx-host", 8, 24);
    expect(conflict.decision).toMatchObject({ kind: "refuse", reason: "WorkloadBusy" });

    await callClaimMethod(handle, "releaseVerified");
    expect(handle.state()).toBe("released");
    expect(authority.snapshot("node-a")).toHaveLength(0);

    const pending = claimTarget(authority, "other-host", 8, 24);
    expect(pending.decision.kind).toBe("admit");
    const pendingHandle = pending.handle!;
    await callClaimMethod(pendingHandle, "demoteUncertain");
    expect(pendingHandle.state()).toBe("pending");
  });
});

// --- managed oMLX residency (M) ---

describe("managed oMLX residency", () => {
  test("M1 ensureLoaded admits, loads and marks the claim resident", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority);
    expect(await residency.ensureLoaded()).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(1);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.runtimeKey).toBe("omlx-host");
    expect(snap[0]?.kind).toBe("ModelHost");
    expect(snap[0]?.allocationGiB).toBe(8);
    expect(snap[0]?.state).toBe("resident");
    expect(await residency.residency()).toBe("resident");
  });

  test("M2 budget gate refuses before any backend request", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const other = claimTarget(authority, "other-host", 8, 12);
    expect(other.decision.kind).toBe("admit");
    const residency = createResidency(mod, fake, authority, () => 12);
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "AdmissionRefused",
      admission: "BudgetExceeded",
    });
    expect(fake.counts.total).toBe(0);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.runtimeKey).toBe("other-host");
  });

  test("M3 unknown budget refuses before any backend request", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority, () => undefined);
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "AdmissionRefused",
      admission: "BudgetUnknown",
    });
    expect(fake.counts.total).toBe(0);
  });

  test("M4 InsufficientMemory fails the load and releases the claim", async () => {
    const fake = startFakeOmlx();
    fake.state.loadMode = 507;
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority);
    expect(await residency.ensureLoaded()).toMatchObject({
      kind: "failed",
      reason: "InsufficientMemory",
    });
    expect(authority.snapshot("node-a")).toHaveLength(0);
    expect(await residency.residency()).toBe("unclaimed");
  });

  test("M5 ambiguous load failure keeps an uncertain claim and blocks retry", async () => {
    const fake = startFakeOmlx();
    fake.state.loadMode = 500;
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority);
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "ambiguous",
      reason: "HttpError",
      reservation: "uncertain",
      httpStatus: 500,
    });
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("uncertain");
    expect(await residency.residency()).toBe("uncertain");
    const totalBefore = fake.counts.total;
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "ResidencyUncertain",
    });
    expect(fake.counts.total).toBe(totalBefore);
  });

  test("M6 unload releases the claim and ensureLoaded readmits with a new claimId", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = await loadResidency(mod, fake, authority);
    const firstClaimId = authority.snapshot("node-a")[0]?.claimId;
    expect(firstClaimId).toBeDefined();
    expect(await residency.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(authority.snapshot("node-a")).toHaveLength(0);
    expect(await residency.residency()).toBe("unclaimed");
    expect(await residency.ensureLoaded()).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(2);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("resident");
    expect(snap[0]?.claimId).not.toBe(firstClaimId);
  });

  test("M7 ambiguous unload HttpError demotes the claim to uncertain", async () => {
    const fake = startFakeOmlx();
    fake.state.unloadMode = 500;
    const mod = await loadManagedModule();
    await expectUncertainAfterAmbiguousUnload(mod, fake, {
      kind: "ambiguous",
      reason: "HttpError",
      reservation: "uncertain",
      httpStatus: 500,
    });
  });

  test("M7 unload timeout demotes the claim to uncertain", async () => {
    const fake = startFakeOmlx();
    fake.state.unloadMode = "hang";
    const mod = await loadManagedModule();
    await expectUncertainAfterAmbiguousUnload(mod, fake, {
      kind: "ambiguous",
      reason: "Timeout",
      reservation: "uncertain",
    });
  }, 5000);

  test("M8 verified unload recovers an uncertain claim", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = await loadResidency(mod, fake, authority);
    fake.state.unloadMode = 500;
    expect(await residency.unload()).toStrictEqual({
      kind: "ambiguous",
      reason: "HttpError",
      reservation: "uncertain",
      httpStatus: 500,
    });
    expect(authority.snapshot("node-a")[0]?.state).toBe("uncertain");
    // The backend still holds the model, so a retry unload verifies.
    fake.state.unloadMode = "ok";
    expect(await residency.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(authority.snapshot("node-a")).toHaveLength(0);
    expect(await residency.residency()).toBe("unclaimed");
    expect(await residency.ensureLoaded()).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(2);
  });

  test("M9 busy backend refuses unload and ensureLoaded reports already-loaded", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = await loadResidency(mod, fake, authority);
    fake.state.activity = { active: 1, waiting: 0 };
    expect(await residency.unload()).toStrictEqual({
      kind: "refused",
      reason: "BackendBusy",
      reservation: "held",
    });
    expect(authority.snapshot("node-a")).toHaveLength(1);
    expect(authority.snapshot("node-a")[0]?.state).toBe("resident");
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "already-loaded",
      modelId: ID,
    });
    expect(fake.counts.loadPosts).toBe(1);
    expect(authority.snapshot("node-a")).toHaveLength(1);
  });

  test("M10 concurrent ensureLoaded shares one load and sibling calls refuse", async () => {
    const fake = startFakeOmlx({ loadDelayMs: 150 });
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const first = createResidency(mod, fake, authority);
    const second = createResidency(mod, fake, authority);
    const loadA = first.ensureLoaded();
    const loadB = first.ensureLoaded();
    // Wait for the load POST to be in flight so the sibling calls observe
    // a busy backend deterministically instead of racing the first POST.
    await Promise.race([fake.loadPosted, loadA, loadB]);
    expect(await second.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "LoadInProgress",
    });
    expect(await first.unload()).toStrictEqual({
      kind: "refused",
      reason: "OperationInProgress",
      reservation: "held",
    });
    expect(await loadA).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(await loadB).toStrictEqual({ kind: "loaded", modelId: ID });
    expect(fake.counts.loadPosts).toBe(1);
    expect(fake.counts.unloadPosts).toBe(0);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("resident");
  });

  test("M11 backend auto-load refuses LoadInProgress and keeps the claim uncertain", async () => {
    const fake = startFakeOmlx();
    fake.state.model.is_loading = true;
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority);
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "LoadInProgress",
    });
    expect(fake.counts.loadPosts).toBe(0);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("uncertain");
    expect(await residency.residency()).toBe("uncertain");
  });

  test("M12 409 Conflict keeps the claim charged and uncertain, second over-budget claim refused", async () => {
    const fake = startFakeOmlx();
    fake.state.loadMode = 409;
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = createResidency(mod, fake, authority);
    const result = await residency.ensureLoaded();
    expect(result).toMatchObject({
      kind: "failed",
      reason: "Conflict",
    });
    expect((result as { httpStatus: number }).httpStatus).toBe(409);
    expect(fake.counts.loadPosts).toBe(1);
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("uncertain");
    expect(await residency.residency()).toBe("uncertain");
    // A second 20 GiB claim on a 24 GiB budget should be refused (target overspend).
    const probe = claimTarget(authority, "probe-host", 20, 24);
    expect(probe.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
  });

  test("M13 resident-path re-load with ambiguous/LoadInProgress demotes to uncertain", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = await loadResidency(mod, fake, authority);
    expect(await residency.residency()).toBe("resident");
    // Simulate backend going into LoadInProgress during resident re-check.
    fake.state.model.is_loading = true;
    const result = await residency.ensureLoaded();
    expect(result).toStrictEqual({
      kind: "refused",
      reason: "LoadInProgress",
    });
    expect(fake.counts.loadPosts).toBe(1);
    expect(await residency.residency()).toBe("uncertain");
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("uncertain");
  });

  test("M14 client.load() exception leaves the claim uncertain, not pending", async () => {
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const client: OmlxNativeClient = {
      status: () => Promise.reject(new Error("unused")),
      load: () => Promise.reject(new Error("load exploded")),
      unload: () => Promise.reject(new Error("unused")),
    };
    const residency = mod.createManagedOmlxResidency(managedOpts(client, authority));
    const failure: unknown = await residency.ensureLoaded().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toBe("load exploded");
    const snap = authority.snapshot("node-a");
    expect(snap).toHaveLength(1);
    expect(snap[0]?.state).toBe("uncertain");
    expect(await residency.residency()).toBe("uncertain");
    // The uncertain claim keeps charging the budget and blocks retries
    // until a verified unload retires it.
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "ResidencyUncertain",
    });
  });

  test("M15 ambiguous unload with no claim makes local state uncertain", async () => {
    const fake = startFakeOmlx();
    const mod = await loadManagedModule();
    const authority = createTargetAdmissionAuthority();
    const residency = await loadResidency(mod, fake, authority);
    // A verified unload retires the claim; the backend then loads the
    // model on its own, leaving residency with no claim held.
    expect(await residency.unload()).toStrictEqual({
      kind: "unloaded",
      modelId: ID,
      reservation: "released",
    });
    expect(await residency.residency()).toBe("unclaimed");
    expect(authority.snapshot("node-a")).toHaveLength(0);
    fake.state.model.loaded = true;
    fake.state.unloadMode = 500;
    expect(await residency.unload()).toStrictEqual({
      kind: "ambiguous",
      reason: "HttpError",
      reservation: "uncertain",
      httpStatus: 500,
    });
    // Even with no claim held, local state goes to uncertain.
    expect(await residency.residency()).toBe("uncertain");
    // ensureLoaded refuses without touching the backend at all.
    const totalBefore = fake.counts.total;
    expect(await residency.ensureLoaded()).toStrictEqual({
      kind: "refused",
      reason: "ResidencyUncertain",
    });
    expect(fake.counts.total).toBe(totalBefore);
  });
});
