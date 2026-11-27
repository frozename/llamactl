/**
 * #283 DF-10: llama.cpp members observed awake are adopted into the shared
 * TargetAdmissionAuthority ledger (Part of #283).
 *
 * `TargetAdmissionAuthority.adopt` lands with the fix; it is absent at the
 * pinned base, so it is resolved through bracket access and every direct call
 * first asserts that it is a function. Each case builds a fresh authority and
 * injects the wake `start` seam, so nothing touches the network, a process,
 * a timer or live user state.
 */
import type {
  ManagedAdmissionClaim,
  ManagedAdmissionDecision,
  ManagedClaimState,
  ManagedWorkloadKind,
} from "@llamactl/core/residency/admission";
import type {
  LlamacppSleepController,
  SleepCapability,
  SleepMember,
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

type AdoptInput = {
  targetIdentity: string;
  runtimeKey: string;
  specDigest: string;
  kind: ManagedWorkloadKind;
  allocationGiB: number;
  state: ManagedClaimState;
};

type AdoptResult = {
  handle: TargetAdmissionClaimHandle | null;
  heldBy: string | null;
};

type AdoptFn = (input: AdoptInput) => AdoptResult;

const binder = (sleepClient as unknown as Record<string, unknown>)[
  "createSharedBudgetSleepController"
] as BinderFn | undefined;
const wake = (sleepClient as unknown as Record<string, unknown>)["wakeLlamacppMember"] as
  | WakeFn
  | undefined;

function member(id: string, rk = `rk-${id}`, dg = `d-${id}`): SleepMember {
  return { id, runtimeKey: rk, specDigest: dg, allocationGiB: 8, capability: GUARDED };
}

function sized(id: string, allocationGiB: number): SleepMember {
  return { id, runtimeKey: "rk-g", specDigest: "d-g", allocationGiB, capability: GUARDED };
}

function expectGroupBilledAtCore(
  authority: TargetAdmissionAuthority,
  controller: LlamacppSleepController,
  expectedGiB: number,
): void {
  expect(controller.snapshot().committedGiB).toBe(expectedGiB);
  const groupClaims = targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-g");
  expect(groupClaims).toHaveLength(1);
  expect(groupClaims[0]?.allocationGiB).toBe(expectedGiB);
}

function foreignClaim(
  authority: TargetAdmissionAuthority,
  gib: number,
  budget: number,
): ClaimResult {
  return authority.tryClaim({
    targetIdentity: TARGET,
    runtimeKey: "other-host",
    specDigest: "dx",
    kind: "ModelHost",
    allocationGiB: gib,
    budgetGiB: budget,
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
  expect(typeof binder).toBe("function");
  return binder!({ authority, targetIdentity: TARGET, budgetGiB });
}

async function wakeMember(
  controller: LlamacppSleepController,
  memberId: string,
  start: WakeStart,
): Promise<WakeResult> {
  expect(typeof wake).toBe("function");
  return await wake!({ controller, memberId, start });
}

function adoptClaim(authority: TargetAdmissionAuthority, input: AdoptInput): AdoptResult {
  const adopt = (authority as unknown as Record<string, unknown>)["adopt"] as AdoptFn | undefined;
  expect(typeof adopt).toBe("function");
  return adopt!(input);
}

function recordingStart(outcome: WakeStartOutcome): { starts: string[]; start: WakeStart } {
  const starts: string[] = [];
  const start: WakeStart = (slots): Promise<WakeStartOutcome> => {
    starts.push(slots);
    return Promise.resolve(outcome);
  };
  return { starts, start };
}

describe("llama.cpp sleep adoption into the shared TargetAdmissionAuthority (DF-10 #283)", () => {
  test("#283 adopt A1: a member registered ready is adopted into the shared ledger as resident", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(member("m1"), "ready");

    const claims = targetClaims(authority);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      runtimeKey: "rk-m1",
      specDigest: "d-m1",
      state: "resident",
      allocationGiB: 8,
      kind: "ModelRun",
    });
  });

  test("#283 adopt A2: a second controller on the same node cannot wake past an adopted awake member", async () => {
    const authority = createTargetAdmissionAuthority();
    const controllerA = boundController(authority, () => 16);
    controllerA.register(member("m1"), "ready");
    const controllerB = boundController(authority, () => 12);
    controllerB.register(member("m2"), "sleeping");
    const { starts, start } = recordingStart("ready");

    const out = await wakeMember(controllerB, "m2", start);

    expect(out).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(starts).toHaveLength(0);
  });

  test("#283 adopt A3: an ordinary workload claim sees the adopted member", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 12);
    controller.register(member("m1"), "ready");

    const foreign = foreignClaim(authority, 8, 12);

    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A4: a confirmed sleep releases the adopted claim", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("m1"), "ready");
    expect(claimFor(authority, "rk-m1")).toBeDefined();

    expect(controller.requestSleep("m1").kind).toBe("sleep");
    controller.sleepSettled("m1", "slept");

    expect(claimFor(authority, "rk-m1")).toBeUndefined();
    expect(foreignClaim(authority, 8, 12).decision).toMatchObject({ kind: "admit" });
  });

  test("#283 adopt A5: unknown residency retains its reservation", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 20);
    controller.register(member("m1"), "unknown");
    controller.register(member("m1u"), "unhealthy");

    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "uncertain" });
    expect(claimFor(authority, "rk-m1u")).toMatchObject({ state: "uncertain" });
    const foreign = foreignClaim(authority, 8, 20);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();

    controller.observe("m1", "stopped");

    expect(claimFor(authority, "rk-m1")).toBeUndefined();
    expect(claimFor(authority, "rk-m1u")).toMatchObject({ state: "uncertain" });
  });

  test("#283 adopt A6: a loading member is adopted pending and promoted on ready", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(member("m1"), "loading");
    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "pending" });

    controller.observe("m1", "ready");

    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "resident" });
  });

  test("#283 adopt A7: adoption bills a runtime group once and is idempotent", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(member("m1", "rk-g", "d-g"), "ready");
    controller.register(member("m1", "rk-g", "d-g"), "ready");
    controller.register(member("m1b", "rk-g", "d-g"), "ready");

    const groupClaims = targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-g");
    expect(groupClaims).toHaveLength(1);
    expect(groupClaims[0]).toMatchObject({
      state: "resident",
      allocationGiB: 8,
      kind: "ModelRun",
    });
  });

  test("#283 adopt A8: adoption records observed residency even over budget", async () => {
    const authority = createTargetAdmissionAuthority();
    expect(foreignClaim(authority, 4, 12).decision).toMatchObject({ kind: "admit" });
    const controllerA = boundController(authority, () => 12);
    controllerA.register(member("m1"), "ready");

    const afterAdopt = targetClaims(authority);
    expect(afterAdopt).toHaveLength(2);
    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "resident" });

    const controllerB = boundController(authority, () => 12);
    controllerB.register(member("m2"), "sleeping");
    const { starts, start } = recordingStart("ready");
    const out = await wakeMember(controllerB, "m2", start);

    expect(out).toEqual({ kind: "refused", reason: "BudgetExceeded" });
    expect(starts).toHaveLength(0);
  });

  test("#283 adopt A9: authority.adopt records without a budget check and defers to an existing runtime claim", () => {
    const authority = createTargetAdmissionAuthority();

    const adopted = adoptClaim(authority, {
      targetIdentity: TARGET,
      runtimeKey: "rk-x",
      specDigest: "d-x",
      kind: "ModelHost",
      allocationGiB: 8,
      state: "resident",
    });
    expect(adopted.handle).not.toBeNull();
    expect(adopted.heldBy).toBeNull();
    expect(claimFor(authority, "rk-x")).toMatchObject({
      state: "resident",
      allocationGiB: 8,
      kind: "ModelHost",
    });

    adopted.handle!.releaseVerified();
    expect(claimFor(authority, "rk-x")).toBeUndefined();

    const existing = authority.tryClaim({
      targetIdentity: TARGET,
      runtimeKey: "rk-y",
      specDigest: "d-y",
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB: 16,
    });
    expect(existing.handle).not.toBeNull();
    const deferred = adoptClaim(authority, {
      targetIdentity: TARGET,
      runtimeKey: "rk-y",
      specDigest: "d-y",
      kind: "ModelRun",
      allocationGiB: 8,
      state: "resident",
    });
    expect(deferred.handle).toBeNull();
    expect(deferred.heldBy).toBe(existing.handle!.claimId);
    expect(targetClaims(authority).filter((claim) => claim.runtimeKey === "rk-y")).toHaveLength(1);

    adoptClaim(authority, {
      targetIdentity: TARGET,
      runtimeKey: "rk-z",
      specDigest: "d-z",
      kind: "ModelRun",
      allocationGiB: 8,
      state: "uncertain",
    });
    expect(claimFor(authority, "rk-z")).toMatchObject({ state: "uncertain" });
  });

  test("#283 adopt A10: a member observed awake after registering asleep is adopted", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 12);
    controller.register(member("m1"), "sleeping");
    expect(claimFor(authority, "rk-m1")).toBeUndefined();

    controller.observe("m1", "ready");

    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "resident" });
    const foreign = foreignClaim(authority, 8, 12);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A11: an auto-wake after a confirmed sleep is re-adopted", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(member("m1"), "ready");
    expect(controller.requestSleep("m1").kind).toBe("sleep");
    controller.sleepSettled("m1", "slept");
    expect(claimFor(authority, "rk-m1")).toBeUndefined();

    controller.observe("m1", "loading");
    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "pending" });

    controller.observe("m1", "ready");
    expect(claimFor(authority, "rk-m1")).toMatchObject({ state: "resident" });
  });

  test("#283 adopt G1: a member registered sleeping or stopped adds no claim", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(member("m1"), "sleeping");
    controller.register(member("m2"), "stopped");

    expect(targetClaims(authority)).toHaveLength(0);
  });

  test("#283 adopt G2: an existing runtime claim is not duplicated or released by the member lifecycle", () => {
    const authority = createTargetAdmissionAuthority();
    const existing = authority.tryClaim({
      targetIdentity: TARGET,
      runtimeKey: "rk-m1",
      specDigest: "d-m1",
      kind: "ModelRun",
      allocationGiB: 8,
      budgetGiB: 16,
    });
    existing.handle!.markResident();
    const controller = boundController(authority, () => 16);

    controller.register(member("m1"), "ready");
    expect(targetClaims(authority)).toHaveLength(1);
    expect(claimFor(authority, "rk-m1")).toMatchObject({
      claimId: existing.handle!.claimId,
    });

    controller.observe("m1", "ready");
    expect(targetClaims(authority)).toHaveLength(1);
    expect(claimFor(authority, "rk-m1")).toMatchObject({
      claimId: existing.handle!.claimId,
    });

    expect(controller.requestSleep("m1").kind).toBe("sleep");
    controller.sleepSettled("m1", "slept");
    expect(targetClaims(authority)).toHaveLength(1);
    expect(claimFor(authority, "rk-m1")).toMatchObject({
      claimId: existing.handle!.claimId,
      state: "resident",
    });
  });
  test("#283 adopt A12: a larger member adopted after a smaller one raises the group claim", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(sized("s", 4), "ready");
    expectGroupBilledAtCore(authority, controller, 4);
    controller.register(sized("l", 12), "ready");

    expectGroupBilledAtCore(authority, controller, 12);
    const foreign = foreignClaim(authority, 10, 16);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A13: a smaller member adopted after a larger one keeps the larger bill", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);

    controller.register(sized("l", 12), "ready");
    controller.register(sized("s", 4), "ready");

    expectGroupBilledAtCore(authority, controller, 12);
    const foreign = foreignClaim(authority, 10, 16);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A14: an auto-wake of the larger member raises the group claim before it is ready", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(sized("s", 4), "ready");
    controller.register(sized("l", 12), "sleeping");
    expectGroupBilledAtCore(authority, controller, 4);

    controller.observe("l", "loading");
    expectGroupBilledAtCore(authority, controller, 12);
    expect(foreignClaim(authority, 10, 16).decision).toMatchObject({
      kind: "refuse",
      reason: "BudgetExceeded",
    });

    controller.observe("l", "ready");
    expectGroupBilledAtCore(authority, controller, 12);
    expect(claimFor(authority, "rk-g")).toMatchObject({ state: "resident" });
    const foreign = foreignClaim(authority, 10, 16);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A15: an auto-wake straight to ready of the larger member raises the group claim", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(sized("s", 4), "ready");
    controller.register(sized("l", 12), "sleeping");

    controller.observe("l", "ready");

    expectGroupBilledAtCore(authority, controller, 12);
    const foreign = foreignClaim(authority, 10, 16);
    expect(foreign.decision).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
    expect(foreign.handle).toBeNull();
  });

  test("#283 adopt A16: the group claim follows core down when the larger member sleeps", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(sized("s", 4), "ready");
    controller.register(sized("l", 12), "ready");
    expectGroupBilledAtCore(authority, controller, 12);

    expect(controller.requestSleep("l").kind).toBe("sleep");
    // A sleep in flight is still resident: no early drop.
    expectGroupBilledAtCore(authority, controller, 12);
    controller.sleepSettled("l", "slept");

    expectGroupBilledAtCore(authority, controller, 4);
    expect(claimFor(authority, "rk-g")).toMatchObject({ state: "resident" });
    expect(foreignClaim(authority, 10, 16).decision).toMatchObject({ kind: "admit" });
  });

  test("#283 adopt A17: the group claim follows core down when the larger member stops", () => {
    const authority = createTargetAdmissionAuthority();
    const controller = boundController(authority, () => 16);
    controller.register(sized("l", 12), "ready");
    controller.register(sized("s", 4), "ready");

    controller.observe("l", "stopped");

    expectGroupBilledAtCore(authority, controller, 4);
    controller.observe("s", "stopped");
    expect(controller.snapshot().committedGiB).toBe(0);
    expect(claimFor(authority, "rk-g")).toBeUndefined();
  });
});
