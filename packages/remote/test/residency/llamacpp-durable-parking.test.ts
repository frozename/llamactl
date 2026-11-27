import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { createLlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { makeTempRuntime } from "../../../core/test/helpers.js";
import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import { createDurableLlamacppParking } from "../../src/residency/durable-llamacpp-parking.js";
import { createAgentLlamacppSleepDriver } from "../../src/residency/llamacpp-sleep-client.js";
import { mkdirSync, writeFileSync } from "../../src/safe-fs.js";

test("a managed engine cannot enter native sleep without an issuer qualified to park its durable charge", async () => {
  const temp = makeTempRuntime();
  mkdirSync(temp.runtimeDir, { recursive: true });
  writeFileSync(join(temp.runtimeDir, "managed-residency-v1"), "fixture\n");
  const previousDir = process.env["LOCAL_AI_RUNTIME_DIR"];
  const previousLeases = getResidencyLeaseRegistry();
  process.env["LOCAL_AI_RUNTIME_DIR"] = temp.runtimeDir;
  setResidencyLeaseRegistry(createResidencyLeases());
  const controller = createLlamacppSleepController({ budgetGiB: 16 });
  controller.register(
    {
      id: "member",
      runtimeKey: "model",
      allocationGiB: 8,
      specDigest: "qualified-launch",
      capability: { kind: "guarded-sleep", build: "fixture", fork: "fixture" },
    },
    "ready",
  );
  let posts = 0;
  const fetchFixture = Object.assign(
    (): Promise<Response> => {
      posts++;
      return Promise.resolve(Response.json({ is_sleeping: true }));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  try {
    const outcome = await createAgentLlamacppSleepDriver({
      controller,
      memberId: "member",
      endpoint: { host: "127.0.0.1", port: 19010 },
      managed: { workload: "model", readInferenceHold: () => "clear" },
      verifiedStop: () => Promise.resolve({ ok: true }),
      fetch: fetchFixture,
    }).sleep();
    expect(outcome).toMatchObject({ kind: "refused", reason: "ManagedSleepReleaseProofRequired" });
    expect(posts).toBe(0);
    expect(controller.snapshot().committedGiB).toBe(8);
  } finally {
    if (previousDir === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previousDir;
    setResidencyLeaseRegistry(previousLeases);
    temp.cleanup();
  }
});

const WORKLOAD = "native-model";
const MEMBER = "native-member";
const GIB = 1024 ** 3;
const runtime = {
  workload: WORKLOAD,
  specDigest: "qualified-spec",
  pid: 310,
  birthId: "qualified-birth",
  endpoint: { host: "127.0.0.1", port: 19011 },
};

type FixtureProof = {
  residualGiB: number | undefined;
  ready: boolean;
  availableGiB: number;
  sampleAtMs: number;
  beforeObserve?: () => void;
  beforeResidual?: () => void;
  endpointOwned: boolean;
  refuseSleepAfterPost: boolean;
};

type Fixture = {
  authority: ReturnType<typeof openAdmissionAuthority>;
  registry: ReturnType<typeof createResidencyLeases>;
  path: string;
  owner: { pid: number; birthId: string };
  sleep: ReturnType<typeof createAgentLlamacppSleepDriver>;
  driverEndpoint: typeof runtime.endpoint;
  proof: FixtureProof;
  observed: typeof runtime;
  calls: string[];
  stops: number[];
  wake: () => ReturnType<ReturnType<typeof createDurableLlamacppParking>["wake"]>;
  [Symbol.dispose](): void;
};

function durableFixture(options?: {
  host?: string;
  port?: number;
  sleepPath?: string;
  driverHost?: string;
}): Fixture {
  const pinned = {
    ...runtime,
    endpoint: {
      host: options?.host ?? runtime.endpoint.host,
      port: options?.port ?? runtime.endpoint.port,
    },
  };
  const temp = makeTempRuntime();
  mkdirSync(temp.runtimeDir, { recursive: true });
  writeFileSync(join(temp.runtimeDir, "managed-residency-v1"), "fixture\n");
  const path = join(temp.runtimeDir, "admission.db");
  const previousDir = process.env["LOCAL_AI_RUNTIME_DIR"];
  const previousLeases = getResidencyLeaseRegistry();
  const registry = createResidencyLeases();
  setResidencyLeaseRegistry(registry);
  process.env["LOCAL_AI_RUNTIME_DIR"] = temp.runtimeDir;

  const owner = { pid: 301, birthId: "first-owner" };
  const observed = { ...pinned };
  const authority = openAdmissionAuthority({
    storePath: path,
    budgetGiB: () => 16,
    owner,
    observe: (pid) => (pid === runtime.pid ? { ...observed, alive: true } : undefined),
    readPidFile: (workload) => (workload === WORKLOAD ? runtime.pid : undefined),
  });
  const row = authority.admit({
    kind: "ModelHost",
    runtimeKey: WORKLOAD,
    specDigest: runtime.specDigest,
    allocationGiB: 8,
  });
  if (
    row.kind !== "admitted" ||
    !authority.recordGeneration(row.claimId, row.fenceToken, runtime) ||
    !authority.completeReady(row.claimId, row.fenceToken)
  )
    throw new Error("fixture claim refused");

  const controller = createLlamacppSleepController({ budgetGiB: 16 });
  controller.register(
    {
      id: MEMBER,
      runtimeKey: WORKLOAD,
      specDigest: runtime.specDigest,
      allocationGiB: 8,
      capability: { kind: "guarded-sleep", build: "fixture", fork: "fixture" },
    },
    "ready",
  );
  const proof: FixtureProof = {
    residualGiB: 2,
    ready: true,
    availableGiB: 56,
    sampleAtMs: 100_000,
    endpointOwned: true,
    refuseSleepAfterPost: false,
  };
  const calls: string[] = [];
  const stops: number[] = [];
  let sleeping = false;
  const fetchFixture = Object.assign(
    (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(url.pathname);
      if (url.pathname === "/sleep") {
        if (proof.refuseSleepAfterPost) {
          observed.birthId = "replacement";
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        sleeping = true;
      }
      if (url.pathname === "/wake") {
        // A separate connection must observe dispatch and the full charge
        // before the fake engine sees the command.
        const opened = new Database(path, { readonly: true });
        try {
          expect(
            opened
              .query("SELECT state,allocation_gib,native_phase FROM claims WHERE claim_id = ?")
              .get(row.claimId),
          ).toEqual({ state: "pending", allocation_gib: 8, native_phase: "dispatched" });
        } finally {
          opened.close();
        }
        expect(registry.snapshot(WORKLOAD).phase).toBe("unloaded");
        const pending = authority.snapshot()[0];
        if (pending === undefined) throw new Error("fixture reservation missing");
        expect(authority.completeReady(pending.claimId, pending.fenceToken)).toBe(false);
        expect(
          authority.failUncertain(pending.claimId, pending.fenceToken, "ordinary terminal path"),
        ).toBe(false);
        sleeping = false;
      }
      return Promise.resolve(
        Response.json({ is_sleeping: sleeping, qualified_ready: proof.ready }),
      );
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  const parking = createDurableLlamacppParking({
    authority,
    runtime: pinned,
    memberId: MEMBER,
    readInferenceHold: () => "clear",
    qualifiedResidualGiB: () => {
      proof.beforeResidual?.();
      return proof.residualGiB;
    },
    verifySleepEndpoint: () => proof.endpointOwned,
    observeRuntime: () => {
      proof.beforeObserve?.();
      return Promise.resolve(observed);
    },
    qualifiedReady: (_pin, props) =>
      typeof props === "object" &&
      props !== null &&
      "qualified_ready" in props &&
      props.qualified_ready === true,
    readCapacity: () => ({
      source: "linux-procfs",
      observedAtMs: proof.sampleAtMs,
      physicalBytes: 64 * GIB,
      availableBytes: proof.availableGiB * GIB,
      scope: { kind: "host-physical" },
      pressure: "normal",
      swapUsedBytes: 0,
    }),
    capacityPolicy: () => ({ nowMs: 100_000, configuredBudgetGiB: 16 }),
  });
  const driverEndpoint = { ...pinned.endpoint, host: options?.driverHost ?? pinned.endpoint.host };
  const sleep = createAgentLlamacppSleepDriver({
    controller,
    memberId: MEMBER,
    endpoint: driverEndpoint,
    ...(options?.sleepPath === undefined ? {} : { sleepPath: options.sleepPath }),
    managed: parking.sleep,
    fetch: fetchFixture,
    verifiedStop: (drain) => {
      stops.push(drain.epoch);
      return Promise.resolve({ ok: false, reason: "fixture should not stop" });
    },
  });
  return {
    authority,
    registry,
    path,
    owner,
    sleep,
    driverEndpoint,
    proof,
    observed,
    calls,
    stops,
    wake: (): ReturnType<typeof parking.wake> =>
      parking.wake({
        controller,
        fetch: fetchFixture,
        readinessTimeoutMs: 30,
        readinessPollMs: 2,
      }),
    [Symbol.dispose](): void {
      authority.close();
      setResidencyLeaseRegistry(previousLeases);
      if (previousDir === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousDir;
      temp.cleanup();
    },
  };
}

test("the sealed sleep receipt restores the SQL charge before an actual managed wake", async () => {
  using fixture = durableFixture();
  using opened = new Database(fixture.path, { readonly: true });
  expect(opened.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  expect(await fixture.sleep.sleep()).toEqual({ kind: "slept", reservation: "released" });
  expect(opened.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
  expect(fixture.authority.snapshot()).toMatchObject([
    {
      state: "uncertain",
      allocationGiB: 2,
      native: { phase: "parked", wakeAllocationGiB: 8 },
    },
  ]);
  const duplicate = fixture.authority.admit({
    kind: "ModelHost",
    runtimeKey: WORKLOAD,
    specDigest: runtime.specDigest,
    allocationGiB: 8,
  });
  expect(duplicate).toMatchObject({ kind: "refuse", reason: "WorkloadBusy" });

  const peer = fixture.authority.admit({
    runtimeKey: "pressure-peer",
    kind: "ModelRun",
    specDigest: "peer",
    allocationGiB: 10,
  });
  if (peer.kind !== "admitted") throw new Error("fixture peer must fit parked capacity");
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
  expect(fixture.calls).toEqual(["/sleep", "/props"]);
  expect(fixture.authority.abandonUnstarted(peer.claimId, peer.fenceToken)).toBe(true);

  fixture.proof.sampleAtMs = 1;
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
  fixture.proof.sampleAtMs = 100_000;
  fixture.proof.availableGiB = 20;
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
  fixture.proof.availableGiB = 56;
  expect(fixture.calls).toEqual(["/sleep", "/props"]);
  const waking = fixture.wake();
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
  expect(await waking).toMatchObject({ kind: "woke", slots: "discard" });
  expect(fixture.calls).toEqual(["/sleep", "/props", "/wake", "/props"]);
  expect(fixture.authority.snapshot()[0]).toMatchObject({ state: "resident", allocationGiB: 8 });
  expect(fixture.authority.snapshot()[0]?.native).toBeUndefined();
  expect(fixture.registry.snapshot(WORKLOAD).phase).toBe("open");
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
});

test("unknown sleep residual and replaced generations preserve the full charge", async () => {
  using residual = durableFixture();
  residual.proof.residualGiB = undefined;
  expect(await residual.sleep.sleep()).toMatchObject({
    kind: "unconfirmed",
    reason: "NativeReleaseUnverified",
  });
  expect(residual.authority.snapshot()[0]).toMatchObject({ state: "resident", allocationGiB: 8 });
  expect(residual.registry.snapshot(WORKLOAD).phase).toBe("unloaded");
  using generation = durableFixture();
  generation.observed.birthId = "replacement";
  expect(await generation.sleep.sleep()).toMatchObject({
    kind: "refused",
    reason: "NativeSleepGenerationChanged",
  });
  expect(generation.calls).toEqual([]);
  expect(generation.authority.snapshot()[0]?.allocationGiB).toBe(8);
  expect(generation.registry.snapshot(WORKLOAD).phase).toBe("open");
});

test("a generation replaced after sleep dispatch never reaches the process stop fallback", async () => {
  using fixture = durableFixture();
  fixture.proof.refuseSleepAfterPost = true;
  expect(await fixture.sleep.sleep()).toMatchObject({
    kind: "unconfirmed",
    reason: "NativeSleepGenerationChanged",
  });
  expect(fixture.calls).toEqual(["/sleep"]);
  expect(fixture.stops).toEqual([]);
  expect(fixture.authority.snapshot()[0]?.allocationGiB).toBe(8);
  expect(fixture.registry.snapshot(WORKLOAD).phase).toBe("draining");
});

test.each([
  { label: "external address", host: "192.0.2.1" },
  { label: "DNS name", host: "localhost" },
  { label: "noncanonical sleep path", sleepPath: "/sleep?force=1" },
  { label: "invalid port", port: 0 },
])("managed native sleep refuses $label before dispatch", async ({ label: _label, ...options }) => {
  using fixture = durableFixture(options);
  const outcome = await fixture.sleep.sleep();
  expect(fixture.calls).toEqual([]);
  expect(fixture.stops).toEqual([]);
  expect(outcome).toMatchObject({ kind: "refused", reason: "ManagedSleepBindingInvalid" });
  expect(fixture.authority.snapshot()[0]?.allocationGiB).toBe(8);
  expect(fixture.registry.snapshot(WORKLOAD).phase).toBe("open");
});

test("mutating the supplied endpoint cannot authorize the URL captured for the dispatch", async () => {
  using fixture = durableFixture({ driverHost: "192.0.2.1" });
  fixture.driverEndpoint.host = runtime.endpoint.host;
  const outcome = await fixture.sleep.sleep();
  expect(fixture.calls).toEqual([]);
  expect(fixture.stops).toEqual([]);
  expect(outcome).toMatchObject({ kind: "refused", reason: "ManagedSleepBindingInvalid" });
  expect(fixture.registry.snapshot(WORKLOAD).phase).toBe("open");
});

test("sleep refuses a listener whose owner cannot be proven", async () => {
  using fixture = durableFixture();
  fixture.proof.endpointOwned = false;
  expect(await fixture.sleep.sleep()).toMatchObject({
    kind: "refused",
    reason: "NativeSleepGenerationChanged",
  });
  expect(fixture.calls).toEqual([]);
  expect(fixture.stops).toEqual([]);
});

test("a superseded sleep drain cannot park the claim", async () => {
  using fixture = durableFixture();
  fixture.proof.beforeResidual = (): void => {
    const current = fixture.registry.snapshot(WORKLOAD);
    expect(fixture.registry.reopen({ workload: WORKLOAD, epoch: current.epoch })).toBe(true);
    const next = fixture.registry.beginDrain(WORKLOAD);
    if (!next.ok) throw new Error("replacement drain refused");
    expect(fixture.registry.commitUnload(next.token).ok).toBe(true);
  };
  expect(await fixture.sleep.sleep()).toMatchObject({
    kind: "unconfirmed",
    reason: "NativeReleaseUnverified",
  });
  expect(fixture.authority.snapshot()[0]).toMatchObject({ state: "resident", allocationGiB: 8 });
});

test("a superseded drain cannot claim a wake reservation", async () => {
  using fixture = durableFixture();
  expect(await fixture.sleep.sleep()).toMatchObject({ kind: "slept" });
  const first = fixture.registry.snapshot(WORKLOAD);
  expect(fixture.registry.reopen({ workload: WORKLOAD, epoch: first.epoch })).toBe(true);
  const next = fixture.registry.beginDrain(WORKLOAD);
  if (!next.ok) throw new Error("replacement drain refused");
  expect(next.token.epoch).not.toBe(first.epoch);
  expect(fixture.registry.commitUnload(next.token).ok).toBe(true);
  expect(await fixture.wake()).toMatchObject({
    kind: "refused",
    reason: "ManagedWakeReservationUnavailable",
  });
  expect(fixture.calls).toEqual(["/sleep", "/props"]);
  expect(fixture.authority.snapshot()[0]?.allocationGiB).toBe(2);
});

test("physical evidence invalidated after reservation prevents dispatch and holds full capacity", async () => {
  using fixture = durableFixture();
  expect(await fixture.sleep.sleep()).toMatchObject({ kind: "slept" });
  fixture.proof.beforeObserve = (): void => {
    fixture.proof.sampleAtMs = 1;
  };
  expect(await fixture.wake()).not.toMatchObject({ kind: "woke" });
  expect(fixture.calls).toEqual(["/sleep", "/props"]);
  expect(fixture.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  expect(fixture.registry.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("an ambiguous wake and restart each retain full capacity without reopening inference", async () => {
  using waking = durableFixture();
  expect(await waking.sleep.sleep()).toMatchObject({ kind: "slept" });
  waking.proof.ready = false;
  expect(await waking.wake()).toMatchObject({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(waking.authority.snapshot()[0]).toMatchObject({ state: "uncertain", allocationGiB: 8 });
  expect(waking.authority.snapshot()[0]?.native).toBeUndefined();
  expect(waking.registry.snapshot(WORKLOAD).phase).toBe("unloaded");

  using restarting = durableFixture();
  expect(await restarting.sleep.sleep()).toMatchObject({ kind: "slept" });
  const old = restarting.authority.snapshot()[0];
  restarting.authority.close();
  const reopener = openAdmissionAuthority({
    storePath: restarting.path,
    requireExisting: true,
    budgetGiB: () => 16,
    owner: { pid: 302, birthId: "second-owner" },
    observe: (pid) =>
      pid === restarting.owner.pid ? { ...restarting.owner, alive: false } : undefined,
    readPidFile: () => runtime.pid,
  });
  try {
    const current = reopener.snapshot()[0];
    expect(current).toMatchObject({ state: "uncertain", allocationGiB: 8 });
    expect(current?.native).toBeUndefined();
    expect(current?.fenceToken).not.toBe(old?.fenceToken);
    expect(await restarting.wake()).toMatchObject({
      kind: "refused",
      reason: "ManagedWakeReservationUnavailable",
    });
    expect(restarting.calls).toEqual(["/sleep", "/props"]);
  } finally {
    reopener.close();
  }
});
