import type { DrainToken, ResidencyLeases } from "@llamactl/core/residency/leases";

import {
  createResidencyLeases,
  getResidencyLeaseRegistry,
  setResidencyLeaseRegistry,
} from "@llamactl/core/residency/leases";
import { createLlamacppSleepController } from "@llamactl/core/residency/llamacpp-sleep";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AdmissionAuthority,
  openAdmissionAuthority,
} from "../../src/residency/admission-authority.js";
import {
  createAgentLlamacppWakeDriver,
  type LlamacppWakeDriver,
  type ManagedLlamacppWakeProof,
} from "../../src/residency/llamacpp-wake-client.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";

const WORKLOAD = "managed-sleep-run";
const ENDPOINT = { host: "127.0.0.1", port: 19383 };

function parked(registry: ResidencyLeases): DrainToken {
  const drain = registry.beginDrain(WORKLOAD);
  if (!drain.ok || !registry.commitUnload(drain.token).ok) throw new Error("cannot park fixture");
  return drain.token;
}

type WakeFixtureState = {
  runtime: {
    workload: string;
    specDigest: string;
    pid: number;
    birthId: string;
    endpoint: typeof ENDPOINT;
  };
  reserved: boolean;
  begun: boolean;
  qualify: boolean;
  commit: boolean;
  uncertain: number;
  beforeObserve(): void;
  onRequest(path: string): void;
};

type WakeFixture = {
  driver(managed?: ManagedLlamacppWakeProof | null): LlamacppWakeDriver;
  calls: string[];
  state: WakeFixtureState;
  proof: ManagedLlamacppWakeProof;
  leases: ResidencyLeases;
  authority: AdmissionAuthority;
  [Symbol.dispose](): void;
};

function fixture(): WakeFixture {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-managed-wake-"));
  const previousRuntime = process.env["LOCAL_AI_RUNTIME_DIR"];
  const previousRegistry = getResidencyLeaseRegistry();
  const leases = createResidencyLeases();
  const sleepDrain = parked(leases);
  writeFileSync(join(runtimeDir, "managed-residency-v1"), "fixture\n");
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  setResidencyLeaseRegistry(leases);
  const controller = createLlamacppSleepController({ budgetGiB: 16 });
  controller.register(
    {
      id: "fixture-member",
      runtimeKey: WORKLOAD,
      specDigest: "fixture-runtime",
      allocationGiB: 8,
      capability: { kind: "guarded-sleep", fork: "fixture", build: "fixture" },
    },
    "ready",
  );
  expect(controller.requestSleep("fixture-member").kind).toBe("sleep");
  controller.sleepSettled("fixture-member", "slept", "fixture-slots");
  const calls: string[] = [];
  const state: WakeFixtureState = {
    runtime: {
      workload: WORKLOAD,
      specDigest: "fixture-runtime",
      pid: 123,
      birthId: "fixture-process-birth",
      endpoint: ENDPOINT,
    },
    reserved: true,
    begun: false,
    qualify: true,
    commit: true,
    uncertain: 0,
    beforeObserve: (): void => undefined,
    onRequest: (_path: string): void => undefined,
  };
  const authority = openAdmissionAuthority({
    storePath: join(runtimeDir, "admission.sqlite"),
    budgetGiB: () => 16,
    owner: { pid: process.pid },
    observe: () => undefined,
    readPidFile: () => undefined,
  });
  const allocationGiB = 8;
  const claim = authority.admit({
    kind: "ModelRun",
    runtimeKey: state.runtime.workload,
    specDigest: state.runtime.specDigest,
    allocationGiB,
  });
  if (claim.kind !== "admitted") throw new Error("fixture must hold a durable pending charge");
  const proof: ManagedLlamacppWakeProof = {
    sleepRegistry: leases,
    pin: {
      memberId: "fixture-member",
      sleepDrain,
      runtime: { ...state.runtime },
      claim: { claimId: claim.claimId, fenceToken: claim.fenceToken, allocationGiB },
    },
    async observeRuntime() {
      await Promise.resolve();
      state.beforeObserve();
      return state.runtime;
    },
    isReserved(pin) {
      return (
        state.reserved &&
        authority.isOperational() &&
        authority
          .snapshot()
          .some(
            (row) =>
              row.claimId === pin.claim.claimId &&
              row.runtimeKey === pin.runtime.workload &&
              row.specDigest === pin.runtime.specDigest &&
              row.allocationGiB === pin.claim.allocationGiB &&
              row.state === "pending",
          )
      );
    },
    beginDispatch() {
      if (state.begun) return false;
      state.begun = true;
      calls.push("begin");
      return true;
    },
    qualifiedReady: () => state.qualify,
    commitReady(pin) {
      calls.push("commit");
      expect(leases.snapshot(WORKLOAD).phase).toBe("unloaded");
      return (
        state.commit &&
        authority.recordGeneration(pin.claim.claimId, pin.claim.fenceToken, {
          pid: pin.runtime.pid,
          birthId: pin.runtime.birthId,
        }) &&
        authority.completeReady(pin.claim.claimId, pin.claim.fenceToken)
      );
    },
    markUncertain(pin) {
      state.uncertain++;
      authority.failUncertain(pin.claim.claimId, pin.claim.fenceToken, "fixture wake unresolved");
    },
  };
  const fakeFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("http://127.0.0.1:19383");
    expect(leases.snapshot(WORKLOAD).phase).toBe("unloaded");
    expect(init?.redirect).toBe("error");
    calls.push(url.pathname);
    state.onRequest(url.pathname);
    if (url.pathname === "/props") return Promise.resolve(Response.json({ is_sleeping: false }));
    if (url.pathname === "/slots/2") return Promise.resolve(Response.json({ n_restored: 6 }));
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  const driver = (managed: ManagedLlamacppWakeProof | null = proof): LlamacppWakeDriver =>
    createAgentLlamacppWakeDriver({
      controller,
      memberId: "fixture-member",
      endpoint: ENDPOINT,
      cacheIdentity: "fixture-slots",
      slot: { id: 2, filename: "fixture-slot.bin" },
      readinessPollMs: 2,
      readinessTimeoutMs: 30,
      fetch: fakeFetch as typeof globalThis.fetch,
      ...(managed === null ? {} : { managed }),
    });
  return {
    driver,
    calls,
    state,
    proof,
    leases,
    authority,
    [Symbol.dispose](): void {
      authority.close();
      setResidencyLeaseRegistry(previousRegistry);
      if (previousRuntime === undefined)
        Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntime;
      rmSync(runtimeDir, { recursive: true, force: true });
    },
  };
}

test("a managed node with no durable wake proof remains inert", async () => {
  using f = fixture();
  const driver = f.driver(null);
  expect(await driver.wake()).toEqual({ kind: "inert", reason: "ManagedWakeProofRequired" });
  expect(f.calls).toEqual([]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("wake commits the durable charge after qualified ready and restore, then reopens the exact sleep drain", async () => {
  using f = fixture();
  expect(await f.driver().wake()).toEqual({ kind: "woke", slots: "restore", tokensRestored: 6 });
  expect(f.calls).toEqual(["begin", "/wake", "/props", "/slots/2", "commit"]);
  expect(f.state.uncertain).toBe(0);
  expect(f.authority.snapshot()).toMatchObject([{ state: "resident", allocationGiB: 8 }]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("open");
});

test("a reused pid with a different birth cannot receive a managed wake POST", async () => {
  using f = fixture();
  f.state.runtime.birthId = "replacement";
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toEqual([]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("a newer sleep drain cannot be reopened by the prior receipt", async () => {
  using f = fixture();
  f.state.beforeObserve = (): void => {
    expect(f.leases.reopen(f.proof.pin.sleepDrain)).toBe(true);
    expect(parked(f.leases).epoch).toBeGreaterThan(f.proof.pin.sleepDrain.epoch);
  };
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toEqual([]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("the prior sleep receipt is invalid in a replacement lease registry with the same epoch", async () => {
  using f = fixture();
  const replacement = createResidencyLeases();
  expect(parked(replacement).epoch).toBe(f.proof.pin.sleepDrain.epoch);
  setResidencyLeaseRegistry(replacement);
  expect(await f.driver().wake()).toEqual({ kind: "refused", reason: "ManagedWakeProofInvalid" });
  expect(f.calls).toEqual([]);
  expect(replacement.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("cancellation while checking the listener after dispatch retains the charge and sleep drain", async () => {
  using f = fixture();
  const abort = new AbortController();
  f.state.beforeObserve = (): void => {
    if (f.calls.includes("/wake")) abort.abort();
  };
  expect(await f.driver().wake({ signal: abort.signal })).toEqual({
    kind: "wake-failed",
    outcome: "cancelled",
  });
  expect(f.calls).toEqual(["begin", "/wake"]);
  expect(f.state.uncertain).toBe(1);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

for (const [stage, calls] of [
  ["/wake", ["begin", "/wake"]],
  ["/props", ["begin", "/wake", "/props"]],
  ["/slots/2", ["begin", "/wake", "/props", "/slots/2"]],
] as const) {
  test(`capacity loss during ${stage} prevents the next managed wake action and reopen`, async () => {
    using f = fixture();
    f.state.onRequest = (path): void => {
      if (path === stage) f.state.reserved = false;
    };
    expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(f.calls).toEqual([...calls]);
    expect(f.state.uncertain).toBe(1);
    expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", allocationGiB: 8 }]);
    expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
  });
}

test("a positive awake flag alone cannot reopen an unqualified managed runtime", async () => {
  using f = fixture();
  f.state.qualify = false;
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toContain("/props");
  expect(f.calls).not.toContain("/slots/2");
  expect(f.calls).not.toContain("commit");
  expect(f.state.uncertain).toBe(1);
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", allocationGiB: 8 }]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("a wake claim already taken by another owner sends no request and retains its reservation", async () => {
  using f = fixture();
  f.state.begun = true;
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toEqual([]);
  expect(f.state.uncertain).toBe(0);
  expect(f.authority.snapshot()).toMatchObject([{ state: "pending", allocationGiB: 8 }]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("an endpoint that moves during restore cannot publish ready for the old listener", async () => {
  using f = fixture();
  f.state.onRequest = (path): void => {
    if (path === "/slots/2") f.state.runtime.endpoint = { ...ENDPOINT, port: ENDPOINT.port + 1 };
  };
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toEqual(["begin", "/wake", "/props", "/slots/2"]);
  expect(f.authority.snapshot()).toMatchObject([{ state: "uncertain", allocationGiB: 8 }]);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});

test("durable ready commit refusal keeps lease admission closed and retains uncertainty", async () => {
  using f = fixture();
  f.state.commit = false;
  expect(await f.driver().wake()).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
  expect(f.calls).toEqual(["begin", "/wake", "/props", "/slots/2", "commit"]);
  expect(f.state.uncertain).toBe(1);
  expect(f.leases.snapshot(WORKLOAD).phase).toBe("unloaded");
});
