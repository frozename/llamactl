import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { afterEach, expect, test } from "bun:test";

import {
  createOmlxNativeClient,
  type OmlxNativeBinding,
} from "../../src/residency/engine-client.js";
import { resolveOmlxResidencyPath } from "../../src/residency/omlx-capability.js";
import { createManagedOmlxResidency } from "../../src/residency/omlx-managed.js";
import { createTargetAdmissionAuthority } from "../../src/workload/admission.js";

const ID = "native-model";
const PATH = "/fixtures/approved/native-model";
const OTHER = "/fixtures/foreign/native-model";
const WORKLOAD = "owned-omlx";
const servers: (() => Promise<void>)[] = [];
const previousLeases = getResidencyLeaseRegistry();

afterEach(async () => {
  setResidencyLeaseRegistry(previousLeases);
  await Promise.all(servers.splice(0).map((stop) => stop()));
});

type FakeState = {
  modelPath: string;
  generation: string;
  artifact: string;
  loaded: boolean;
  statusCode: number;
  omitReceiptId: boolean;
  onActivity: () => void;
  onLoad: () => void;
  onUnload: () => void;
};

type FakeOmlx = {
  state: FakeState;
  posts: string[];
  binding: OmlxNativeBinding;
  endpoint: { host: string; port: number };
};

function fakeOmlx(): FakeOmlx {
  const state = {
    modelPath: PATH,
    generation: "engine-1",
    artifact: "artifact-v1",
    loaded: false,
    statusCode: 200,
    omitReceiptId: false,
    onActivity: (): void => undefined,
    onLoad: (): void => undefined,
    onUnload: (): void => undefined,
  };
  const posts: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const { pathname } = new URL(req.url);
      if (pathname === "/v1/models/status") {
        return Response.json(
          {
            models: [
              {
                id: ID,
                model_path: state.modelPath,
                loaded: state.loaded,
                is_loading: false,
                engine_type: "batched",
              },
            ],
          },
          { status: state.statusCode },
        );
      }
      if (pathname === "/api/status") {
        state.onActivity();
        return Response.json({ active_requests: 0, waiting_requests: 0 });
      }
      if (req.method === "POST") {
        posts.push(pathname);
        if (pathname.endsWith("/load")) {
          state.loaded = true;
          state.onLoad();
        } else if (pathname.endsWith("/unload")) {
          state.loaded = false;
          state.onUnload();
        }
        return Response.json(
          state.omitReceiptId ? { status: "ok" } : { status: "ok", model_id: ID },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  servers.push(async (): Promise<void> => {
    await server.stop(true);
  });
  const endpoint = { host: "127.0.0.1", port: server.port ?? 0 };
  const binding: OmlxNativeBinding = {
    endpoint,
    modelId: ID,
    modelPath: PATH,
    artifactRevision: "artifact-v1",
    runtimeGeneration: "engine-1",
    stillCurrent: ({ runtimeGeneration, artifactRevision }): boolean =>
      runtimeGeneration === state.generation && artifactRevision === state.artifact,
  };
  return { state, posts, binding, endpoint };
}

function clientFor(
  fake: FakeOmlx,
  registry = createResidencyLeases(),
): {
  registry: ReturnType<typeof createResidencyLeases>;
  native: ReturnType<typeof createOmlxNativeClient>;
} {
  return {
    registry,
    native: createOmlxNativeClient({
      endpoint: fake.endpoint,
      hostedRel: `owner/${ID}`,
      activityObservable: true,
      binding: fake.binding,
      leases: { registry, workload: WORKLOAD, sessions: null },
    }),
  };
}

test("native actions cannot use the approved model id from a different artifact path", async () => {
  const fake = fakeOmlx();
  const { native } = clientFor(fake);
  fake.state.modelPath = OTHER;
  expect(await native.load()).toEqual({ kind: "refused", reason: "IdentityUnverified" });
  fake.state.loaded = true;
  expect(await native.unload()).toEqual({
    kind: "refused",
    reason: "IdentityUnverified",
    reservation: "held",
  });
  expect(fake.posts).toEqual([]);
});

test("an accepted load with a changed model path remains uncertain in the owner ledger", async () => {
  const fake = fakeOmlx();
  const { native, registry } = clientFor(fake);
  const drain = registry.beginDrain(WORKLOAD);
  if (!drain.ok) throw new Error(drain.reason);
  registry.commitUnload(drain.token);
  const authority = createTargetAdmissionAuthority();
  const managed = createManagedOmlxResidency({
    client: native,
    authority,
    targetIdentity: "node",
    runtimeKey: WORKLOAD,
    specDigest: "fixture",
    budgetGiB: () => 8,
    allocationGiB: 8,
  });
  fake.state.onLoad = (): void => {
    fake.state.modelPath = OTHER;
  };
  expect(await managed.ensureLoaded()).toEqual({
    kind: "ambiguous",
    reason: "LoadUnconfirmed",
    reservation: "uncertain",
  });
  expect(managed.residency()).toBe("uncertain");
  expect(managed.claimId()).toBeDefined();
  expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
  expect(fake.posts).toEqual([`/v1/models/${ID}/load`]);
});

test("a generation change during an accepted unload keeps routing fenced and the owner claim held", async () => {
  const fake = fakeOmlx();
  const { native, registry } = clientFor(fake);
  const authority = createTargetAdmissionAuthority();
  const managed = createManagedOmlxResidency({
    client: native,
    authority,
    targetIdentity: "node",
    runtimeKey: WORKLOAD,
    specDigest: "fixture",
    budgetGiB: () => 8,
    allocationGiB: 8,
  });
  expect((await managed.ensureLoaded()).kind).toBe("loaded");
  fake.state.onUnload = (): void => {
    fake.state.generation = "engine-2";
  };
  expect(await managed.unload()).toMatchObject({
    kind: "ambiguous",
    reason: "UnloadUnconfirmed",
    reservation: "uncertain",
  });
  expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
  expect(registry.acquire(WORKLOAD).ok).toBe(false);
  expect(managed.residency()).toBe("uncertain");
  expect(managed.claimId()).toBeDefined();
  expect(fake.posts).toEqual([`/v1/models/${ID}/load`, `/v1/models/${ID}/unload`]);
});

test("artifact proof is rechecked after activity and before an unload is submitted", async () => {
  const fake = fakeOmlx();
  const { native } = clientFor(fake);
  fake.state.loaded = true;
  fake.state.onActivity = (): void => {
    fake.state.artifact = "artifact-v2";
  };
  expect(await native.unload()).toEqual({
    kind: "refused",
    reason: "IdentityUnverified",
    reservation: "held",
  });
  expect(fake.posts).toEqual([]);
});

test("unknown and unbound capabilities hold, and only exact unsupported selects process fallback", async () => {
  const fake = fakeOmlx();
  setResidencyLeaseRegistry(createResidencyLeases());
  const opts = {
    endpoint: fake.endpoint,
    workload: WORKLOAD,
    hostedRel: ID,
    activityObservable: true,
  };
  expect(await resolveOmlxResidencyPath(opts)).toMatchObject({
    path: "held",
    reason: "NativeIdentityUnverified",
  });
  fake.state.statusCode = 500;
  expect(await resolveOmlxResidencyPath({ ...opts, binding: fake.binding })).toMatchObject({
    path: "held",
    reason: "NativeCapabilityUnknown",
  });
  fake.state.statusCode = 404;
  expect(await resolveOmlxResidencyPath({ ...opts, binding: fake.binding })).toMatchObject({
    path: "process",
    capability: { mode: "process-fallback" },
  });
  fake.state.generation = "engine-2";
  expect(await resolveOmlxResidencyPath({ ...opts, binding: fake.binding })).toMatchObject({
    path: "held",
    reason: "NativeIdentityUnverified",
  });
  expect(fake.posts).toEqual([]);
});

test("an exact capability is fresh for the selected generation and requires its published lease registry", async () => {
  const fake = fakeOmlx();
  const opts = {
    endpoint: fake.endpoint,
    workload: WORKLOAD,
    hostedRel: ID,
    activityObservable: true,
    binding: fake.binding,
  };
  setResidencyLeaseRegistry(null);
  expect(await resolveOmlxResidencyPath(opts)).toMatchObject({
    path: "held",
    reason: "NativeLeaseRegistryRequired",
    capability: { mode: "native" },
  });
  setResidencyLeaseRegistry(createResidencyLeases());
  expect(await resolveOmlxResidencyPath(opts)).toMatchObject({ path: "native" });
  fake.state.modelPath = OTHER;
  expect(await resolveOmlxResidencyPath(opts)).toMatchObject({
    path: "held",
    reason: "NativeIdentityUnverified",
  });
  fake.state.modelPath = PATH;
  fake.state.generation = "engine-2";
  fake.state.statusCode = 500;
  const latest = { ...fake.binding, runtimeGeneration: "engine-2" };
  expect(await resolveOmlxResidencyPath({ ...opts, binding: latest })).toMatchObject({
    path: "held",
    reason: "NativeCapabilityUnknown",
  });
  expect(fake.posts).toEqual([]);
});

test("a same-process catalog path change during activity proof blocks an unload POST", async () => {
  const fake = fakeOmlx();
  const { native, registry } = clientFor(fake);
  fake.state.loaded = true;
  fake.state.onActivity = (): void => {
    fake.state.modelPath = OTHER;
  };
  expect(await native.unload()).toEqual({
    kind: "refused",
    reason: "IdentityUnverified",
    reservation: "held",
  });
  expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
  expect(fake.posts).toEqual([]);
});

test("load confirmation observes the loaded artifact again after the auxiliary readiness checks", async () => {
  const fake = fakeOmlx();
  const { native } = clientFor(fake);
  fake.state.onActivity = (): void => {
    if (fake.state.loaded) fake.state.modelPath = OTHER;
  };
  expect(await native.load()).toEqual({
    kind: "ambiguous",
    reason: "LoadUnconfirmed",
    reservation: "uncertain",
  });
  expect(fake.posts).toEqual([`/v1/models/${ID}/load`]);
});

test("a qualified mutation requires the pinned upstream receipt to identify the model", async () => {
  const fake = fakeOmlx();
  const { native, registry } = clientFor(fake);
  fake.state.omitReceiptId = true;
  expect(await native.load()).toEqual({
    kind: "ambiguous",
    reason: "MalformedResponse",
    reservation: "uncertain",
  });
  expect(await native.unload()).toEqual({
    kind: "ambiguous",
    reason: "MalformedResponse",
    reservation: "uncertain",
  });
  expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("a pin for another listener cannot authorize the same model on this loopback endpoint", async () => {
  const fake = fakeOmlx();
  const peer = fakeOmlx();
  const { native } = clientFor({ ...fake, binding: peer.binding });
  expect(await native.load()).toEqual({ kind: "refused", reason: "IdentityUnverified" });
  expect(fake.posts).toEqual([]);
  expect(peer.posts).toEqual([]);
});

test("same-generation exact native load and unload can settle and release the managed claim", async () => {
  const fake = fakeOmlx();
  const { native, registry } = clientFor(fake);
  const managed = createManagedOmlxResidency({
    client: native,
    authority: createTargetAdmissionAuthority(),
    targetIdentity: "node",
    runtimeKey: WORKLOAD,
    specDigest: "fixture",
    budgetGiB: () => 8,
    allocationGiB: 8,
  });
  expect(await managed.ensureLoaded()).toEqual({ kind: "loaded", modelId: ID });
  expect(managed.residency()).toBe("resident");
  expect(await managed.unload()).toEqual({
    kind: "unloaded",
    modelId: ID,
    reservation: "released",
  });
  expect(managed.claimId()).toBeUndefined();
  expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
  expect(fake.posts).toEqual([`/v1/models/${ID}/load`, `/v1/models/${ID}/unload`]);
});
