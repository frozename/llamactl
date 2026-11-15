import { expect, test } from "bun:test";

import {
  classifySleepObservation,
  decideSleepReconcile,
  type SleepCapability,
} from "../src/residency/llamacpp-sleep.js";

const GUARDED: SleepCapability = { kind: "guarded-sleep", fork: "ggml-org", build: "b7000" };
const FALLBACK: SleepCapability = { kind: "process-fallback", reason: "NotQualified" };

// #283 sleep-aware — kills restoring the `&& observation.healthStatus === 200`
// guard in the guarded-sleep branch of classifySleepObservation: a live
// guarded host that reports isSleeping is sleeping even while /health is
// failing, so the observation must classify "sleeping" and reconcile to
// request-wake, never restart.
test("#283 sleep-aware H1: a live guarded host flagged sleeping is sleeping even when /health fails", () => {
  for (const healthStatus of [503, 500, undefined] as const) {
    const observation = {
      processAlive: true,
      isSleeping: true,
      ...(healthStatus === undefined ? {} : { healthStatus }),
    };
    const observed = classifySleepObservation(observation, GUARDED);
    expect(observed).toBe("sleeping");

    const awake = decideSleepReconcile({ desired: "awake", observed, capability: GUARDED });
    expect(awake.action.kind).not.toBe("restart");
    expect(awake.action.kind).toBe("request-wake");

    const asleep = decideSleepReconcile({ desired: "asleep", observed, capability: GUARDED });
    expect(asleep.action.kind).toBe("none");
  }
});

// #283 sleep-aware — kills dropping the capability check in the
// guarded-sleep branch (process-fallback must never invent "sleeping") and
// checking isSleeping before processAlive (a dead process is "stopped" even
// when it claims sleeping): the flag exempts a live guarded host from failure
// classification only.
test("#283 sleep-aware H2: a sleeping flag is not a failure exemption off the guarded path, and a failed non-sleeping host stays failed", () => {
  expect(
    classifySleepObservation({ processAlive: true, isSleeping: true, healthStatus: 500 }, FALLBACK),
  ).toBe("unhealthy");
  expect(
    classifySleepObservation({ processAlive: true, isSleeping: false, healthStatus: 500 }, GUARDED),
  ).toBe("unhealthy");
  expect(
    classifySleepObservation({ processAlive: false, isSleeping: true, healthStatus: 503 }, GUARDED),
  ).toBe("stopped");
  expect(
    classifySleepObservation({ processAlive: true, isSleeping: true, healthStatus: 503 }, GUARDED),
  ).toBe("sleeping");
});
