import { createResidencyLeases } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { expect, test } from "bun:test";

import {
  executeProfileSwitch,
  type ProfileSwitchStepOutcome,
} from "../../src/residency/profile-transition.js";

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
  const registry = createResidencyLeases();
  const held = registry.acquire("old");
  if (!held.ok) throw new Error("fixture lease failed");
  const calls: string[] = [];
  let changed = false;
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
    { dryRun: false, registry },
  );
  expect(registry.snapshot("old").phase).toBe("draining");
  changed = true;
  held.lease.release();
  const report = await execution;
  expect(report.failedAt).toMatchObject({ action: "verify", detail: "replacement changed" });
  expect(calls).toEqual([]);
  expect(registry.snapshot("old").phase).toBe("open");
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
