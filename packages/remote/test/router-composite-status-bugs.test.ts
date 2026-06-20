/**
 * Regression tests for three bugs in compositeStatus + compositeApply:
 *
 * Bug 1 (HIGH): compositeStatus hangs forever when applyComposite throws
 *   before emitting a terminal { type: "done" } event. The subscriber
 *   waits on a Promise that nothing ever resolves.
 *
 * Bug 3 (LOW): compositeStatus live-path adds an "abort" event listener
 *   to clientSignal but never removes it on completion, leaking the
 *   reference.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { CompositeApplyEvent } from "../src/composite/types.js";

import {
  compositeEvents,
  _resetForTests as resetCompositeEvents,
} from "../src/composite/event-bus.js";
import { router } from "../src/router.js";

// ---------------------------------------------------------------------------
// Controllable mock for applyComposite — lets tests trigger a throw at
// a precise moment to reproduce the Bug 1 hang condition without racing
// arbitrary setTimeout delays.
// ---------------------------------------------------------------------------
const applyControl: { reject: (err: Error) => void; started: boolean } = {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  reject: (): void => {},
  started: false,
};

await mock.module("../src/composite/apply.js", () => ({
  applyComposite: (): Promise<never> => {
    applyControl.started = true;
    return new Promise<never>((_, reject) => {
      applyControl.reject = reject;
    });
  },
}));

// Fake RuntimeBackend returned by getCompositeRuntime so tests never need
// a live Docker daemon — the backend is only forwarded to the mocked
// applyComposite anyway.
await mock.module("../src/runtime/factory.js", () => ({
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  createRuntimeBackend: () => ({}),
}));

// ---------------------------------------------------------------------------

let runtimeDir = "";
const originalEnv = { ...process.env };

function minimalCompositeYaml(name: string): string {
  return stringifyYaml({
    apiVersion: "llamactl/v1",
    kind: "Composite",
    metadata: { name },
    spec: {
      services: [],
      workloads: [],
      ragNodes: [],
      gateways: [],
      pipelines: [],
      dependencies: [],
      onFailure: "rollback",
    },
  });
}

async function collectEvents(
  iter: AsyncIterable<CompositeApplyEvent>,
): Promise<CompositeApplyEvent[]> {
  const out: CompositeApplyEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (ev.type === "done") break;
  }
  return out;
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-composite-bugs-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LLAMACTL_COMPOSITES_DIR: join(runtimeDir, "composites"),
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
  });
  applyControl.started = false;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  applyControl.reject = (): void => {};
  resetCompositeEvents();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

// ===========================================================================
// Bug 1: compositeStatus hangs when applyComposite throws before emitting done
// ===========================================================================
describe("Bug 1 — compositeStatus drains when applyComposite throws", () => {
  test("subscriber receives {type:done,ok:false} instead of hanging forever", async () => {
    const caller = router.createCaller({});
    const name = "err-stack";

    // Start the wet-run mutation. It will block inside the mocked
    // applyComposite until applyControl.reject() is called.
    const applyP = caller
      .compositeApply({ manifestYaml: minimalCompositeYaml(name), dryRun: false })
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .catch((): void => {}); // throw is expected — swallow it

    // Spin until the mock has been entered, meaning startRun has already
    // been called and the run is live on the bus.
    while (!applyControl.started) {
      await new Promise<void>((r) => {
        setTimeout(r, 5);
      });
    }

    // Subscribe while the run is still active.
    const iter = (await caller.compositeStatus({
      name,
    })) as AsyncIterable<CompositeApplyEvent>;

    const collectP = Promise.race([
      collectEvents(iter),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("TIMEOUT: compositeStatus subscriber hung"));
        }, 500);
      }),
    ]);

    // Give the subscriber a moment to attach to the bus.
    await new Promise<void>((r) => {
      setTimeout(r, 10);
    });

    // Trigger the throw — this is the exact condition that caused the hang.
    applyControl.reject(new Error("simulated-backend-fail"));
    await applyP;

    const events = await collectP;
    expect(events.at(-1)).toEqual({ type: "done", ok: false });
  }, 3_000);
});

// ===========================================================================
// Bug 3: abort listener leaked on clientSignal after subscription completes
// ===========================================================================
describe("Bug 3 — abort listener removed on compositeStatus completion", () => {
  test("removeEventListener('abort') called for the compositeStatus listener", async () => {
    let abortRemoveCount = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const origRemove = AbortSignal.prototype.removeEventListener;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (AbortSignal.prototype as any).removeEventListener = function (
      type: string,
      ...args: unknown[]
    ): void {
      if (type === "abort") abortRemoveCount++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      (origRemove as any).call(this, type, ...args);
    };

    try {
      const name = "listen-test";
      compositeEvents.startRun(name);

      const caller = router.createCaller({});
      const iter = (await caller.compositeStatus({
        name,
      })) as AsyncIterable<CompositeApplyEvent>;
      const collectP = collectEvents(iter);

      // Brief pause so the subscriber has attached to the bus.
      await new Promise<void>((r) => {
        setTimeout(r, 10);
      });

      compositeEvents.emit(name, { type: "done", ok: true });

      await collectP;

      // bridgeEventStream removes its own abort listener (listener A).
      // With the fix, compositeStatus also removes its listener (listener B).
      // Without fix: count === 1; with fix: count === 2.
      expect(abortRemoveCount).toBe(2);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (AbortSignal.prototype as any).removeEventListener = origRemove;
      compositeEvents.endRun("listen-test");
    }
  });
});
