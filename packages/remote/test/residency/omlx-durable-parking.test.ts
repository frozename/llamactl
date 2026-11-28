import type {
  ManagedCapacityOptions,
  ManagedCapacitySample,
} from "@llamactl/core/resources/managed-capacity";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { makeTempRuntime } from "../../../core/test/helpers.js";
import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import { createDurableOmlxParking } from "../../src/residency/durable-omlx-parking.js";
import { createAgentOmlxNativeClient } from "../../src/residency/engine-client.js";

const NAME = "omlx-model";
const MODEL_PATH = "/fixtures/approved/omlx-model";
const GIB = 2 ** 30;

type Proof = {
  residual: number | undefined;
  exclusive: boolean;
  headroom: number;
  response: number;
  loadResponse: number;
  ready: boolean;
  identityCurrent: boolean;
  changeIdentityOnStatus: boolean;
  changeIdentityOnCommit: boolean;
  loseExclusiveOnStatus: boolean;
  loaded: boolean;
  hold: boolean;
};
type Post = {
  action: string;
  allocation: number | undefined;
  native: string | undefined;
  lease: string;
};
type Fixture = {
  authority: ReturnType<typeof openAdmissionAuthority>;
  registry: ReturnType<typeof createResidencyLeases>;
  parking: ReturnType<typeof createDurableOmlxParking>;
  posts: Post[];
  proof: Proof;
  claimId: string;
  path: string;
  owner: { pid: number; birthId: string };
  alternateReads: () => number;
  [Symbol.asyncDispose](): Promise<void>;
};

function modelStatusResponse(proof: Proof): Response {
  if (proof.changeIdentityOnStatus) proof.identityCurrent = false;
  if (proof.loseExclusiveOnStatus) proof.exclusive = false;
  return Response.json({
    models: [
      {
        id: NAME,
        model_path: MODEL_PATH,
        engine_type: "batched",
        loaded: proof.loaded,
        is_loading: false,
      },
    ],
  });
}

function setup({ alternateClient = false, requireCreditProof = false } = {}): Fixture {
  const temp = makeTempRuntime();
  const path = join(temp.devStorage, "omlx-admission.db");
  const previous = getResidencyLeaseRegistry();
  const registry = createResidencyLeases();
  setResidencyLeaseRegistry(registry);
  const runtime = { workload: NAME, specDigest: "launch", pid: 311, birthId: "engine-birth" };
  const owner = { pid: 310, birthId: "owner-birth" };
  const proof: Proof = {
    residual: 2,
    exclusive: true,
    headroom: 24,
    response: 200,
    loadResponse: 200,
    ready: true,
    identityCurrent: true,
    changeIdentityOnStatus: false,
    changeIdentityOnCommit: false,
    loseExclusiveOnStatus: false,
    loaded: true,
    hold: false,
  };
  const authority = openAdmissionAuthority({
    storePath: path,
    owner,
    budgetGiB: () => 16,
    observe: (pid) => (pid === runtime.pid ? { ...runtime, alive: true } : undefined),
    readPidFile: (workload) => (workload === NAME ? runtime.pid : undefined),
    ...(requireCreditProof
      ? {
          nativeAllocationFence: {
            verifyOwner: (): boolean => true,
            validateParkedCredit: (claim): boolean => parking.validateParkedCredit(claim),
          },
        }
      : {}),
  });
  const claim = authority.admit({
    runtimeKey: NAME,
    specDigest: runtime.specDigest,
    kind: "ModelHost",
    allocationGiB: 8,
  });
  if (
    claim.kind !== "admitted" ||
    !authority.recordGeneration(claim.claimId, claim.fenceToken, runtime) ||
    !authority.completeReady(claim.claimId, claim.fenceToken)
  ) {
    throw new Error("failed to establish resident fixture");
  }
  const posts: Post[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        return new Response(null, { status: proof.ready ? 204 : 503 });
      }
      if (pathname === "/v1/models/status") return modelStatusResponse(proof);
      if (pathname === "/api/status")
        return Response.json({ active_requests: 0, waiting_requests: 0 });
      if (request.method === "POST") {
        const action = pathname.split("/").at(-1) ?? "";
        using ledger = new Database(path, { readonly: true });
        const nativeSchema =
          ledger
            .query("SELECT 1 FROM pragma_table_info('claims') WHERE name = 'native_phase'")
            .get() !== null;
        const row = ledger
          .query<
            { allocation_gib: number; native_phase: string | null },
            [string]
          >(nativeSchema ? "SELECT allocation_gib, native_phase FROM claims WHERE claim_id = ?" : "SELECT allocation_gib, NULL AS native_phase FROM claims WHERE claim_id = ?")
          .get(claim.claimId);
        posts.push({
          action,
          allocation: row?.allocation_gib,
          native: row?.native_phase ?? undefined,
          lease: registry.snapshot(NAME).phase,
        });
        proof.loaded = action === "load";
        return Response.json(
          { status: "ok", model_id: NAME },
          { status: action === "load" ? proof.loadResponse : proof.response },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const endpoint = { host: "127.0.0.1", port: server.port ?? 0 };
  const binding = {
    endpoint,
    modelPath: MODEL_PATH,
    modelId: NAME,
    artifactRevision: "artifact",
    runtimeGeneration: runtime.birthId,
    stillCurrent: (): boolean => proof.identityCurrent,
  };
  let reads = 0;
  const alternate = alternateClient
    ? Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response | Promise<Response> {
          reads++;
          return server.fetch(request);
        },
      })
    : undefined;
  const alternateEndpoint = { host: "127.0.0.1", port: alternate?.port ?? 0 };
  const obsoleteOptions =
    alternate === undefined
      ? {}
      : {
          client: createAgentOmlxNativeClient({
            endpoint: alternateEndpoint,
            binding: { ...binding, endpoint: alternateEndpoint },
            workload: NAME,
            hostedRel: NAME,
            activityObservable: true,
          }),
        };
  let ingressChecks = 0;
  const parking: ReturnType<typeof createDurableOmlxParking> = createDurableOmlxParking({
    ...obsoleteOptions,
    apiKey: "fixture-owner-key",
    readiness: { path: "/health", expectStatus: 204 },
    activityObservable: true,
    authority,
    runtime,
    binding,
    registry,
    readInferenceHold: () => (proof.hold ? "current" : "clear"),
    verifyExclusiveIngress: (): boolean => {
      ingressChecks++;
      if (proof.changeIdentityOnCommit && ingressChecks === 2) proof.identityCurrent = false;
      return proof.exclusive;
    },
    qualifiedResidualGiB: () => proof.residual,
    readCapacity: (): ManagedCapacitySample => ({
      source: "darwin-vm",
      physicalBytes: 48 * GIB,
      availableBytes: proof.headroom * GIB,
      pressure: "normal",
      swapUsedBytes: 0,
      observedAtMs: 1000,
      scope: { kind: "host-physical" },
    }),
    capacityPolicy: (): ManagedCapacityOptions => ({ nowMs: 1000, configuredBudgetGiB: 16 }),
  });
  return {
    authority,
    registry,
    parking,
    posts,
    proof,
    claimId: claim.claimId,
    path,
    owner,
    alternateReads: (): number => reads,
    async [Symbol.asyncDispose](): Promise<void> {
      await alternate?.stop(true);
      await server.stop(true);
      setResidencyLeaseRegistry(previous);
      authority.close();
      temp.cleanup();
    },
  };
}

test("native oMLX holds the same durable charge before unload and reload dispatch", async () => {
  await using f = setup();
  const parked = await f.parking.unload();
  expect(f.posts).toEqual([
    { action: "unload", allocation: 8, native: "parking", lease: "draining" },
  ]);
  expect(parked).toMatchObject({ kind: "parked", chargedGiB: 2, modelId: NAME });
  expect(f.authority.snapshot()).toMatchObject([
    { claimId: f.claimId, state: "uncertain", allocationGiB: 2, native: { phase: "parked" } },
  ]);
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(await f.parking.unload()).toEqual(parked);
  expect(f.posts).toHaveLength(1);

  expect(await f.parking.load()).toEqual({ kind: "loaded", modelId: NAME });
  expect(f.posts[1]).toEqual({
    action: "load",
    allocation: 8,
    native: "dispatched",
    lease: "unloaded",
  });
  expect(f.authority.snapshot()).toMatchObject([
    { claimId: f.claimId, state: "resident", allocationGiB: 8 },
  ]);
  expect(f.authority.snapshot()[0]?.native).toBeUndefined();
  expect(f.registry.snapshot(NAME).phase).toBe("open");
  expect(await f.parking.load()).toEqual({ kind: "already-loaded", modelId: NAME });
  expect(f.posts).toHaveLength(2);
});

test("the owner verifies its exact parked receipt inside the allocation transaction", async () => {
  await using f = setup({ requireCreditProof: true });
  expect(await f.parking.unload()).toMatchObject({ kind: "parked", chargedGiB: 2 });
  expect(
    f.authority.admit({
      runtimeKey: "small",
      specDigest: "small",
      kind: "ModelRun",
      allocationGiB: 1,
    }),
  ).toMatchObject({ kind: "admitted" });
  const observed = f.authority.snapshot().find((row) => row.claimId === f.claimId);
  if (observed === undefined) throw new Error("fixture claim missing");
  const { generations, ...parked } = observed;
  expect(generations).toHaveLength(1);
  expect(f.parking.validateParkedCredit(parked)).toBe(true);
  expect(f.parking.validateParkedCredit({ ...parked, allocationGiB: 1 })).toBe(false);

  f.proof.identityCurrent = false;
  expect(
    f.authority.admit({
      runtimeKey: "denied",
      specDigest: "denied",
      kind: "ModelRun",
      allocationGiB: 1,
    }),
  ).toMatchObject({ kind: "refuse", reason: "ManagedNativeCreditUnverified" });

  f.proof.identityCurrent = true;
  expect(await f.parking.load()).toMatchObject({ kind: "loaded", modelId: NAME });
  expect(f.parking.validateParkedCredit(parked)).toBe(false);
  expect(f.posts.map(({ action }) => action)).toEqual(["unload", "load"]);
});

test("an active request, an unproven exclusive route, and a durable inference hold each prevent dispatch", async () => {
  await using f = setup();
  const lease = f.registry.acquire(NAME);
  if (!lease.ok) throw new Error("fixture lease refused");
  expect(await f.parking.unload()).toMatchObject({ kind: "refused", reason: "LeasesActive" });
  lease.lease.release();

  f.proof.exclusive = false;
  expect(await f.parking.unload()).toMatchObject({
    kind: "refused",
    reason: "ManagedReservationUnavailable",
  });
  f.proof.exclusive = true;
  f.proof.hold = true;
  expect(await f.parking.unload()).toMatchObject({
    kind: "refused",
    reason: "ManagedReservationUnavailable",
  });
  expect(f.posts).toEqual([]);
  expect(f.registry.snapshot(NAME).phase).toBe("open");
  expect(f.authority.snapshot()[0]).toMatchObject({ state: "resident", allocationGiB: 8 });
});

test("a queued oMLX unload retains the full durable charge and keeps inference closed", async () => {
  await using f = setup();
  f.proof.response = 202;
  expect(await f.parking.unload()).toMatchObject({ kind: "ambiguous", reservation: "uncertain" });
  expect(f.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(await f.parking.load()).toMatchObject({
    kind: "refused",
    reason: "ManagedReservationUnavailable",
  });
  expect(f.posts.map(({ action }) => action)).toEqual(["unload"]);
});

test("parked oMLX gets no memory credit without a qualified observation and refuses reload under pressure", async () => {
  await using f = setup();
  f.proof.residual = undefined;
  expect(await f.parking.unload()).toMatchObject({ kind: "parked", chargedGiB: 8 });
  expect(f.authority.snapshot()[0]).toMatchObject({
    native: { phase: "parked", wakeAllocationGiB: 8 },
    allocationGiB: 8,
  });
  f.proof.headroom = 15;
  expect(await f.parking.load()).toMatchObject({
    kind: "refused",
    reason: "ManagedReservationUnavailable",
  });
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(f.posts).toHaveLength(1);
  f.proof.headroom = 24;
  expect(await f.parking.load()).toMatchObject({ kind: "loaded" });
});

test("loss of exclusive ingress while parked revokes the previously measured memory credit", async () => {
  await using f = setup();
  expect(await f.parking.unload()).toMatchObject({ kind: "parked", chargedGiB: 2 });
  f.proof.exclusive = false;
  expect(await f.parking.load()).toMatchObject({ kind: "refused" });
  expect(f.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  expect(f.authority.snapshot()[0]?.native).toBeUndefined();
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(f.posts.map(({ action }) => action)).toEqual(["unload"]);
});

test("owner recovery after native park restores the full allocation and invalidates the old receipt", async () => {
  await using f = setup();
  expect(await f.parking.unload()).toMatchObject({ kind: "parked", chargedGiB: 2 });
  const old = f.authority.snapshot()[0];
  f.authority.close();
  const recovered = openAdmissionAuthority({
    storePath: f.path,
    requireExisting: true,
    owner: { pid: 312, birthId: "recovered-owner" },
    budgetGiB: () => 16,
    observe: (pid) => (pid === f.owner.pid ? { ...f.owner, alive: false } : undefined),
    readPidFile: () => 311,
  });
  try {
    const claim = recovered.snapshot()[0];
    expect(claim).toMatchObject({ claimId: f.claimId, state: "uncertain", allocationGiB: 8 });
    expect(claim?.native).toBeUndefined();
    expect(claim?.fenceToken).not.toBe(old?.fenceToken);
    expect(await f.parking.load()).toMatchObject({ kind: "refused" });
    expect(f.posts.map(({ action }) => action)).toEqual(["unload"]);
  } finally {
    recovered.close();
  }
});

test("an alternate client cannot receive status traffic for the pinned model", async () => {
  await using f = setup({ alternateClient: true });
  expect(await f.parking.load()).toMatchObject({ kind: "already-loaded", modelId: NAME });
  expect(f.alternateReads()).toBe(0);
});

test("direct owner calls do not send the bearer to an ambient HTTP proxy", async () => {
  await using f = setup();
  const captured: (string | null)[] = [];
  using trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      captured.push(request.headers.get("authorization"));
      return new Response(null, { status: 502 });
    },
  });
  const overrides = {
    HTTP_PROXY: String(trap.url),
    http_proxy: String(trap.url),
    NO_PROXY: "",
    no_proxy: "",
  };
  const saved = Object.entries(overrides).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, overrides);
  try {
    expect(await f.parking.load()).toMatchObject({ kind: "already-loaded" });
    expect(await f.parking.unload()).toMatchObject({ kind: "parked" });
    expect(captured).toEqual([]);
  } finally {
    for (const [name, prior] of saved) {
      if (prior === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = prior;
    }
  }
});

test("identity loss during the status read closes inference without dispatch", async () => {
  await using f = setup();
  f.proof.changeIdentityOnStatus = true;
  expect(await f.parking.unload()).toMatchObject({ kind: "refused", reason: "IdentityUnverified" });
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(f.authority.snapshot()[0]?.allocationGiB).toBe(8);
  expect(f.posts).toEqual([]);
});

test("queued reloads and failed serving readiness retain capacity without reopening inference", async () => {
  for (const scenario of [{ loadResponse: 202 }, { ready: false }]) {
    await using f = setup();
    expect(await f.parking.unload()).toMatchObject({ kind: "parked" });
    Object.assign(f.proof, scenario);
    expect(await f.parking.load()).toMatchObject({ kind: "ambiguous" });
    expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
    expect(f.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  }
});

test("losing identity inside unload admission keeps the route fenced before dispatch", async () => {
  await using f = setup();
  f.proof.changeIdentityOnCommit = true;
  expect(await f.parking.unload()).toMatchObject({ kind: "refused", reason: "IdentityUnverified" });
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(f.authority.snapshot()[0]?.allocationGiB).toBe(8);
  expect(f.posts).toEqual([]);
});

test("losing exclusivity during the reload status probe restores the full charge", async () => {
  await using f = setup();
  expect(await f.parking.unload()).toMatchObject({ kind: "parked", chargedGiB: 2 });
  f.proof.loseExclusiveOnStatus = true;
  expect(await f.parking.load()).toMatchObject({ kind: "refused" });
  expect(f.registry.snapshot(NAME).phase).toBe("unloaded");
  expect(f.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  expect(f.posts.map(({ action }) => action)).toEqual(["unload"]);
});
