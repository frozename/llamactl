/**
 * #283 DF-10: llama.cpp sleep-controller wakes admit through the shared
 * TargetAdmissionAuthority (Part of #283).
 *
 * `createSharedBudgetSleepController` and `wakeLlamacppMember` land in
 * `src/residency/llamacpp-sleep-client` with the fix; the module exists at
 * the pinned base but not those exports, so they are resolved through
 * bracket access and every case fails by assertion — never by a missing
 * export or a type error. Each case builds a fresh TargetAdmissionAuthority
 * and injects the wake `start` seam, so nothing touches the network, a
 * process, a timer or live user state.
 */
import type {
  ManagedAdmissionClaim,
  ManagedAdmissionDecision,
} from "@llamactl/core/residency/admission";

import {
  createLlamacppSleepController,
  type LlamacppSleepController,
  type SleepCapability,
  type SleepMember,
} from "@llamactl/core/residency/llamacpp-sleep";
import { describe, expect, test } from "bun:test";

import * as sleepClient from "../../src/residency/llamacpp-sleep-client.js";
import {
  createTargetAdmissionAuthority,
  type TargetAdmissionAuthority,
  type TargetAdmissionClaimHandle,
} from "../../src/workload/admission.js";

const GUARDED: SleepCapability = { kind: "guarded-sleep", fork: "ggml-org", build: "b1" };

const TARGET = "node-a";

type WakeStartOutcome = "ready" | "cancelled" | "readiness-failed";

type WakeStart = (slots: "restore" | "discard") => Promise<WakeStartOutcome>;

type WakeResult = { kind: string; reason?: string; outcome?: string; slots?: string };

type ClaimResult = {
  decision: ManagedAdmissionDecision;
  handle: TargetAdmissionClaimHandle | null;
};

type BinderFn = (o: {
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  budgetGiB: () => number | undefined;
}) => LlamacppSleepController;

type WakeFn = (o: {
  controller: LlamacppSleepController;
  memberId: string;
  start: WakeStart;
}) => Promise<WakeResult>;

const binder = (sleepClient as unknown as Record<string, unknown>)[
  "createSharedBudgetSleepController"
] as BinderFn | undefined;
const wake = (sleepClient as unknown as Record<string, unknown>)["wakeLlamacppMember"] as
  | WakeFn
  | undefined;

function member(id: string, rk = `rk-${id}`, dg = `d-${id}`): SleepMember {
  return { id, runtimeKey: rk, specDigest: dg, allocationGiB: 8, capability: GUARDED };
}

function foreignClaim(authority: TargetAdmissionAuthority, gib: number, budget = 16): ClaimResult {
  return authority.tryClaim({
    targetIdentity: TARGET,
    runtimeKey: "other-host",
    specDigest: "dx",
    kind: "ModelHost",
    allocationGiB: gib,
    budgetGiB: budget,
  });
}

function externalRuntimeClaim(authority: TargetAdmissionAuthority): ClaimResult {
  return authority.tryClaim({
    targetIdentity: TARGET,
    runtimeKey: "rk-b",
    specDigest: "d-b",
    kind: "ModelRun",
    allocationGiB: 8,
    budgetGiB: 16,
  });
}

function targetClaims(authority: TargetAdmissionAuthority): readonly ManagedAdmissionClaim[] {
  return authority.snapshot(TARGET);
}

function claimFor(
  authority: TargetAdmissionAuthority,
  runtimeKey: string,
): ManagedAdmissionClaim | undefined {
  return targetClaims(authority).find((c) => c.runtimeKey === runtimeKey);
}

function boundController(
  authority: TargetAdmissionAuthority,
  budgetGiB: () => number | undefined,
): LlamacppSleepController {
  return binder!({ authority, targetIdentity: TARGET, budgetGiB });
}

async function wakeMember(
  controller: LlamacppSleepController,
  memberId: string,
  start: WakeStart,
): Promise<WakeResult> {
  return await wake!({ controller, memberId, start });
}

function recordingStart(outcome: WakeStartOutcome): { starts: string[]; start: WakeStart } {
  const starts: string[] = [];
  const start: WakeStart = (slots): Promise<WakeStartOutcome> => {
    starts.push(slots);
    return Promise.resolve(outcome);
  };
  return { starts, start };
}

function pendingStart(): Promise<WakeStartOutcome> {
  return new Promise<WakeStartOutcome>(() => undefined);
}

function rejectingStart(): { starts: string[]; start: WakeStart } {
  const starts: string[] = [];
  const start: WakeStart = (slots): Promise<WakeStartOutcome> => {
    starts.push(slots);
    return Promise.reject(new Error("engine start rejected"));
  };
  return { starts, start };
}

describe("llama.cpp sleep wakes through the shared TargetAdmissionAuthority (DF-10 #283)", () => {
  test("a wake that fits the shared node budget is admitted and charged in the shared ledger", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    expect(foreignClaim(authority, 4).decision).toMatchObject({ kind: "admit" });
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);

    expect(out).toMatchObject({ kind: "woke" });
    expect(starts).toHaveLength(1);
    expect(claimFor(authority, "rk-b")).toMatchObject({
      state: "resident",
      allocationGiB: 8,
    });
    expect(controller.snapshot().members["b"]).toEqual({
      state: "ready",
      reservation: "resident",
    });
  });

  test("a wake that would exceed the shared budget is refused with the admission reason and zero starts", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    expect(foreignClaim(authority, 10).decision).toMatchObject({ kind: "admit" });
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);

    expect(out).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(starts).toHaveLength(0);
    expect(controller.snapshot().members["b"]).toEqual({
      state: "sleeping",
      reservation: "released",
    });
    const snap = targetClaims(authority);
    expect(snap).toHaveLength(1);
    expect(snap[0]?.runtimeKey).toBe("other-host");
  });

  test("two concurrent wakes on one controller cannot together exceed the node budget", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 12);
    controller.register(member("b"), "sleeping");
    controller.register(member("c"), "sleeping");
    void wakeMember(controller, "b", pendingStart);
    const c = recordingStart("ready");

    const out = await wakeMember(controller, "c", c.start);

    expect(out).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(c.starts).toHaveLength(0);
    expect(claimFor(authority, "rk-b")?.state).toBe("pending");
  });

  test("a wake readiness failure keeps the shared claim charged as uncertain", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");
    const { start } = recordingStart("readiness-failed");

    const out = await wakeMember(controller, "b", start);

    expect(out).toMatchObject({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(claimFor(authority, "rk-b")?.state).toBe("uncertain");
    expect(controller.snapshot().members["b"]).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
  });

  test("a confirmed sleep releases the shared claim so the node budget frees", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");
    const { start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);
    expect(out).toMatchObject({ kind: "woke" });
    expect(controller.requestSleep("b").kind).toBe("sleep");
    controller.sleepSettled("b", "slept");

    expect(claimFor(authority, "rk-b")).toBeUndefined();
    expect(foreignClaim(authority, 10).decision).toMatchObject({ kind: "admit" });
  });

  test("the core controller delegates wake admission and does not consult its private budget when admitWake is supplied", () => {
    const admitOpts: {
      budgetGiB?: number;
      admitWake: (i: unknown) => ManagedAdmissionDecision;
    } = {
      budgetGiB: 4,
      admitWake: () => ({ kind: "admit", chargedGiB: 8, budgetGiB: 100, committedGiB: 8 }),
    };
    const admitting = createLlamacppSleepController(admitOpts);
    admitting.register(member("b"), "sleeping");
    expect(admitting.requestWake("b")).toMatchObject({ kind: "wake", chargedGiB: 8 });

    const refuseOpts: {
      budgetGiB?: number;
      admitWake: (i: unknown) => ManagedAdmissionDecision;
    } = {
      budgetGiB: 100,
      admitWake: () => ({ kind: "refuse", reason: "WorkloadBusy", detail: "x" }),
    };
    const refusing = createLlamacppSleepController(refuseOpts);
    refusing.register(member("c"), "sleeping");
    expect(refusing.requestWake("c")).toEqual({ kind: "refuse", reason: "WorkloadBusy" });
  });

  test("an unknown shared budget refuses with BudgetUnknown and zero starts", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => undefined);
    controller.register(member("b"), "sleeping");
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);

    expect(out).toEqual({ kind: "refused", reason: "BudgetUnknown" });
    expect(starts).toHaveLength(0);
  });

  test("a runtime-group sibling keeps the shared claim charged after one member sleeps", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("b", "rk-g", "d-g"), "sleeping");
    controller.register(member("c", "rk-g", "d-g"), "sleeping");
    const b = recordingStart("ready");

    const outB = await wakeMember(controller, "b", b.start);
    expect(outB).toMatchObject({ kind: "woke" });
    expect(b.starts).toHaveLength(1);

    const c = recordingStart("ready");
    const outC = await wakeMember(controller, "c", c.start);
    expect(outC).toEqual({ kind: "already-awake" });
    expect(c.starts).toHaveLength(0);
    expect(controller.snapshot().members["c"]).toEqual({
      state: "ready",
      reservation: "resident",
    });

    expect(controller.requestSleep("b").kind).toBe("sleep");
    controller.sleepSettled("b", "slept");
    const groupClaims = targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-g");
    expect(groupClaims).toHaveLength(1);
    expect(groupClaims[0]).toMatchObject({ state: "resident", allocationGiB: 8 });
    expect(foreignClaim(authority, 10).decision).toMatchObject({
      kind: "refuse",
      reason: "BudgetExceeded",
    });

    expect(controller.requestSleep("c").kind).toBe("sleep");
    controller.sleepSettled("c", "slept");
    expect(claimFor(authority, "rk-g")).toBeUndefined();
    expect(foreignClaim(authority, 8).decision).toMatchObject({ kind: "admit" });
  });

  test("a shared claim on the same runtime held outside this controller refuses WorkloadBusy, not BudgetExceeded", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");

    const residentAuthority = createTargetAdmissionAuthority();
    externalRuntimeClaim(residentAuthority).handle!.markResident();
    const residentController = boundController(residentAuthority, () => 16);
    residentController.register(member("b"), "sleeping");
    const residentStart = recordingStart("ready");
    const residentOut = await wakeMember(residentController, "b", residentStart.start);
    expect(residentOut).toEqual({ kind: "refused", reason: "WorkloadBusy" });
    expect(residentStart.starts).toHaveLength(0);
    expect(residentController.snapshot().members["b"]).toEqual({
      state: "sleeping",
      reservation: "released",
    });
    expect(targetClaims(residentAuthority)).toHaveLength(1);

    const pendingAuthority = createTargetAdmissionAuthority();
    externalRuntimeClaim(pendingAuthority);
    const pendingController = boundController(pendingAuthority, () => 16);
    pendingController.register(member("b"), "sleeping");
    const pendingWakeStart = recordingStart("ready");
    const pendingOut = await wakeMember(pendingController, "b", pendingWakeStart.start);
    expect(pendingOut).toEqual({ kind: "refused", reason: "WorkloadBusy" });
    expect(pendingWakeStart.starts).toHaveLength(0);
  });

  test("two independent controllers on one node are serialized by the shared ledger", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");

    const inflightAuthority = createTargetAdmissionAuthority();
    const inflightA = boundController(inflightAuthority, () => 12);
    const inflightB = boundController(inflightAuthority, () => 12);
    inflightA.register(member("a"), "sleeping");
    inflightB.register(member("b"), "sleeping");
    void wakeMember(inflightA, "a", pendingStart);
    const inflightBStart = recordingStart("ready");
    const inflightOut = await wakeMember(inflightB, "b", inflightBStart.start);
    expect(inflightOut).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(inflightBStart.starts).toHaveLength(0);

    const settledAuthority = createTargetAdmissionAuthority();
    const settledA = boundController(settledAuthority, () => 12);
    const settledB = boundController(settledAuthority, () => 12);
    settledA.register(member("a"), "sleeping");
    settledB.register(member("b"), "sleeping");
    const settledAStart = recordingStart("ready");
    const settledAOut = await wakeMember(settledA, "a", settledAStart.start);
    expect(settledAOut).toMatchObject({ kind: "woke" });
    const settledBStart = recordingStart("ready");
    const settledOut = await wakeMember(settledB, "b", settledBStart.start);
    expect(settledOut).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(settledBStart.starts).toHaveLength(0);
  });

  // The locally awake sibling is adopted before the join; the join must
  // reuse that one ledger claim instead of opening a second.
  test("a wake joins a locally awake runtime-group sibling as already-awake, not WorkloadBusy", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("a", "rk-g", "d-g"), "ready");
    controller.register(member("b", "rk-g", "d-g"), "sleeping");
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);

    expect(out).toEqual({ kind: "already-awake" });
    expect(starts).toHaveLength(0);
    expect(controller.snapshot().members["b"]).toEqual({
      state: "ready",
      reservation: "resident",
    });
    const groupClaims = targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-g");
    expect(groupClaims).toHaveLength(1);
    expect(groupClaims[0]).toMatchObject({
      runtimeKey: "rk-g",
      state: "resident",
      allocationGiB: 8,
      kind: "ModelRun",
    });
  });

  // Kills the mutant that drops the `kind` tag in sharedLivingClaims
  // (`claims.map((claim) => ({ ...claim, kind }))` -> `[...claims]`): after
  // the foreign claim is released the ledger is empty, so the awake sibling
  // reaches core only as a local `living` claim, and an untagged one reads
  // as a kind mismatch that core refuses WorkloadBusy instead of
  // already-resident.
  test("a wake joins a locally awake sibling whose runtime claim was released elsewhere as already-awake, not WorkloadBusy", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const foreign = authority.tryClaim({
      targetIdentity: TARGET,
      runtimeKey: "rk-g",
      specDigest: "d-g",
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB: 16,
    });
    foreign.handle!.markResident();
    const controller = boundController(authority, () => 16);
    controller.register(member("a", "rk-g", "d-g"), "ready");
    controller.register(member("b", "rk-g", "d-g"), "sleeping");
    expect(targetClaims(authority)).toHaveLength(1);
    expect(targetClaims(authority)[0]?.claimId).toBe(foreign.handle!.claimId);
    foreign.handle!.releaseVerified();
    expect(targetClaims(authority)).toHaveLength(0);
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controller, "b", start);

    expect(out).toEqual({ kind: "already-awake" });
    expect(starts).toHaveLength(0);
    expect(controller.snapshot().members["b"]).toEqual({
      state: "ready",
      reservation: "resident",
    });
    const groupClaims = targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-g");
    expect(groupClaims).toHaveLength(1);
    expect(groupClaims[0]).toMatchObject({
      runtimeKey: "rk-g",
      state: "resident",
      allocationGiB: 8,
      kind: "ModelRun",
    });
  });

  // Kills the mutants on runWakeStart's catch branch: removing the
  // try/catch (the rejection escapes wakeLlamacppMember), dropping the
  // `controller.wakeSettled(memberId, "readiness-failed")` call (the member
  // stays waking and the claim stays pending), or returning another outcome.
  test("a wake whose start rejects settles readiness-failed and keeps the shared claim charged as uncertain", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");
    const { starts, start } = rejectingStart();

    const out = await wakeMember(controller, "b", start);

    expect(out).toEqual({ kind: "wake-failed", outcome: "readiness-failed" });
    expect(starts).toHaveLength(1);
    expect(claimFor(authority, "rk-b")).toMatchObject({ state: "uncertain", allocationGiB: 8 });
    expect(controller.snapshot().members["b"]).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(foreignClaim(authority, 10).decision).toMatchObject({
      kind: "refuse",
      reason: "BudgetExceeded",
    });
  });

  // Pins the binder's contract for a cancelled wake: the start may have
  // reached the engine, so the claim stays charged as uncertain rather than
  // released. Kills a binder wakeSettled that skips syncGroup (the claim
  // stays pending), and one that releases the claim on 'cancelled'
  // (releaseUnstarted/releaseVerified frees the budget for the foreign claim).
  test("a cancelled wake keeps the shared claim charged as uncertain at the binder", async () => {
    expect(typeof binder).toBe("function");
    expect(typeof wake).toBe("function");
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("b"), "sleeping");

    expect(controller.requestWake("b")).toMatchObject({ kind: "wake", chargedGiB: 8 });
    expect(claimFor(authority, "rk-b")?.state).toBe("pending");
    controller.wakeSettled("b", "cancelled");

    expect(claimFor(authority, "rk-b")).toMatchObject({ state: "uncertain", allocationGiB: 8 });
    expect(controller.snapshot().members["b"]).toEqual({
      state: "unknown",
      reservation: "uncertain",
    });
    expect(foreignClaim(authority, 10).decision).toMatchObject({
      kind: "refuse",
      reason: "BudgetExceeded",
    });

    const viaWakeAuthority = createTargetAdmissionAuthority();
    const viaWake = boundController(viaWakeAuthority, () => 16);
    viaWake.register(member("c"), "sleeping");
    const c = recordingStart("cancelled");
    const out = await wakeMember(viaWake, "c", c.start);
    expect(out).toEqual({ kind: "wake-failed", outcome: "cancelled" });
    expect(c.starts).toHaveLength(1);
    expect(claimFor(viaWakeAuthority, "rk-c")?.state).toBe("uncertain");
  });
});
