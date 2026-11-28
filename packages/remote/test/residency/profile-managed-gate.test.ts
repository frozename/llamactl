import { createResidencyLeases } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { managedProfileTargetState } from "@llamactl/core/residency/profile-selection";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeProfileSwitch,
  type ProfileSwitchStepOutcome,
} from "../../src/residency/profile-transition.js";
import { openResidencyOperationStore } from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const plan = planProfileSwitch({
  node: "fixture",
  to: "new",
  budgetGiB: 24,
  groups: [],
  nowMs: 0,
  workloads: [
    { id: "old", profiles: ["old"], state: "ready", expectedMemoryGiB: 16 },
    { id: "new", profiles: ["new"], state: "downloaded", expectedMemoryGiB: 16 },
  ],
});

test("managed preflight revalidates after drain ahead of any stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-preflight-"));
  const store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  try {
    const registry = createResidencyLeases();
    const held = registry.acquire("old");
    if (!held.ok) throw new Error("fixture lease failed");
    const calls: string[] = [];
    let changed = false;
    const fence = store.claimOwnership({ ownerId: "fixture", incarnation: "one" });
    const execution = executeProfileSwitch(
      plan,
      {
        beforeTeardown: () => (changed ? "replacement changed" : undefined),
        stop: (): Promise<{ ok: true }> => {
          calls.push("stop");
          return Promise.resolve({ ok: true });
        },
        start: (): Promise<{ ok: true }> => {
          calls.push("start");
          return Promise.resolve({ ok: true });
        },
      },
      {
        dryRun: false,
        registry,
        operation: {
          store,
          fenceToken: fence.fenceToken,
          operationId: "managed-preflight",
          desiredRevision: 0,
          managed: true,
          checkDesired: () => null,
        },
      },
    );
    expect(registry.snapshot("old").phase).toBe("draining");
    changed = true;
    held.lease.release();
    const report = await execution;
    expect(report.failedAt).toMatchObject({ action: "verify", detail: "replacement changed" });
    expect(calls).toEqual([]);
    expect(store.getOperation("managed-preflight")?.outcome).toBe("failed");
    expect(registry.snapshot("old").phase).toBe("open");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an executing replacement receives the profile cancellation signal without a step timer", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<undefined>();
  const finish = Promise.withResolvers<undefined>();
  let observed: AbortSignal | undefined;
  const execution = executeProfileSwitch(
    plan,
    {
      stop: () => Promise.resolve({ ok: true }),
      start: async (_workload, ctx): Promise<ProfileSwitchStepOutcome> => {
        observed = ctx?.signal;
        started.resolve(undefined);
        await finish.promise;
        return observed?.aborted === true ? { ok: false, detail: "canceled" } : { ok: true };
      },
    },
    { dryRun: false, registry: null, signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  finish.resolve(undefined);
  const report = await execution;
  expect(observed).toBe(controller.signal);
  expect(report.failedAt).toMatchObject({ action: "start", detail: "canceled" });
});

test("losing exclusive ingress during final readiness cannot publish a managed profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-publish-"));
  const store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  try {
    const operationId = "managed-publication";
    const pending = store.claimAndBeginOperation(
      { ownerId: "fixture", incarnation: "one" },
      {
        operationId,
        model: "profile-switch:fixture",
        targetState: managedProfileTargetState("new"),
        desiredRevision: 0,
        reservationGiB: 16,
        nowMs: 1,
      },
    );
    if (!pending.ok) throw new Error("fixture operation not reserved");
    const { fenceToken, version } = pending.record;
    expect(
      store.commitReservation({ operationId, fenceToken, expectedVersion: version, nowMs: 2 }),
    ).toEqual({ ok: true });
    const registry = createResidencyLeases();
    let exclusiveIngress = true;
    const report = await executeProfileSwitch(
      plan,
      {
        stop: () => Promise.resolve({ ok: true }),
        start: (): Promise<{ ok: true }> => {
          exclusiveIngress = false;
          return Promise.resolve({ ok: true });
        },
      },
      {
        dryRun: false,
        registry,
        operation: {
          store,
          fenceToken,
          operationId,
          desiredRevision: 0,
          managed: true,
          begun: {
            ...pending,
            record: { ...pending.record, version: version + 1, phase: "committed" },
          },
          checkBeforePublish: () => (exclusiveIngress ? undefined : "exclusive ingress lost"),
        },
      },
    );
    expect(report.failedAt).toMatchObject({ action: "verify", detail: "exclusive ingress lost" });
    expect(report.operation).toMatchObject({
      id: operationId,
      outcome: "unknown",
      recorded: false,
    });
    expect(store.getOperation(operationId)?.phase).toBe("committed");
    expect(registry.snapshot("old").phase).toBe("unloaded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the managed window can retain the exact actuator beyond its step deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-late-actuator-"));
  const store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  const started = Promise.withResolvers<undefined>();
  const settled = Promise.withResolvers<ProfileSwitchStepOutcome>();
  try {
    const fence = store.claimOwnership({ ownerId: "fixture", incarnation: "one" });
    const tracked: Promise<ProfileSwitchStepOutcome>[] = [];
    const expired = Promise.withResolvers<() => void>();
    const execution = executeProfileSwitch(
      plan,
      {
        stop: () => Promise.resolve({ ok: true }),
        start: (): Promise<ProfileSwitchStepOutcome> => {
          started.resolve(undefined);
          return settled.promise;
        },
      },
      {
        dryRun: false,
        registry: createResidencyLeases(),
        stepTimeouts: { loadMs: 10 },
        stepTimer: (_ms, expire): (() => void) => {
          expired.resolve(expire);
          return () => undefined;
        },
        operation: {
          store,
          fenceToken: fence.fenceToken,
          operationId: "managed-late-actuator",
          desiredRevision: 0,
          managed: true,
          checkDesired: () => null,
          trackActuator: (actuator) => {
            tracked.push(actuator);
          },
        },
      },
    );
    await started.promise;
    (await expired.promise)();
    const report = await execution;
    expect(report.steps.at(-1)).toMatchObject({
      action: "start",
      status: "failed",
      reason: "StepTimedOut",
    });
    expect(report.operation).toMatchObject({ outcome: "unknown", recorded: false });
    const actuator = tracked.at(-1);
    expect(actuator).toBe(settled.promise);
    settled.resolve({ ok: true });
    expect(await actuator).toEqual({ ok: true });
  } finally {
    settled.resolve({ ok: true });
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "guarded switch handles cancellation around actuation (started=%s)",
  async (started) => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-cancel-boundary-"));
    const store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
    try {
      const fence = store.claimOwnership({ ownerId: "fixture", incarnation: "one" });
      const registry = createResidencyLeases();
      const controller = new AbortController();
      let actuated = false;
      const report = await executeProfileSwitch(
        plan,
        {
          stop: (): Promise<ProfileSwitchStepOutcome> => {
            actuated = true;
            return Promise.resolve({ ok: true });
          },
          start: (): Promise<ProfileSwitchStepOutcome> => {
            controller.abort();
            return Promise.resolve({ ok: true });
          },
        },
        {
          dryRun: false,
          registry,
          signal: controller.signal,
          operation: {
            store,
            fenceToken: fence.fenceToken,
            operationId: "managed-cancel-boundary",
            desiredRevision: 0,
            managed: true,
            checkDesired: () => (started ? null : "authorization expired"),
            checkBeforePublish: () => undefined,
            didActuate: () => actuated,
          },
        },
      );
      expect(actuated).toBe(started);
      expect(report.failedAt).toMatchObject(
        started
          ? { action: "verify", detail: "ProfileSwitchCanceled" }
          : { action: "stop", detail: "authorization expired" },
      );
      expect(report.operation).toMatchObject(
        started ? { outcome: "unknown", recorded: false } : { outcome: "failed", recorded: true },
      );
      expect(store.listNonterminal()).toHaveLength(started ? 1 : 0);
      expect(registry.snapshot("old").phase).toBe(started ? "unloaded" : "open");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
