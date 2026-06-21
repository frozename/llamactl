import { describe, expect, test } from "bun:test";

import { installControllerClosedGuard } from "./helpers.js";

/**
 * Tripwire for the shared `installControllerClosedGuard` contract used to
 * swallow the benign `TypeError: ... Controller is already closed` rejection
 * that tRPC's SSE adapter leaks at teardown (PR #96). The guard must:
 *
 *   (a) SUPPRESS a Controller-is-already-closed TypeError delivered as an
 *       `unhandledRejection` — `dispose()` does not throw; and
 *   (b) RE-THROW any OTHER rejection on `dispose()`, so a suite still fails
 *       loudly on an unexpected rejection.
 *
 * We drive the exact listener the guard installs by emitting the
 * `unhandledRejection` process event synchronously — deterministic, and it
 * bites: if the guard stops returning early on the benign TypeError (a)
 * fails; if it stops capturing other reasons (b) fails.
 */

/** Synchronously deliver a reason to every `unhandledRejection` listener. */
function emitUnhandledRejection(reason: unknown): void {
  // The guard inspects only the reason, never the associated promise. Pass a
  // non-rejecting placeholder so this helper never produces its OWN real
  // unhandled rejection in this process.
  const placeholder = Promise.resolve();
  process.emit("unhandledRejection", reason, placeholder);
}

describe("installControllerClosedGuard", () => {
  test("suppresses a Controller-is-already-closed TypeError (dispose does not throw)", () => {
    const guard = installControllerClosedGuard();
    emitUnhandledRejection(new TypeError("Invalid state: Controller is already closed"));
    // Benign rejection swallowed — dispose must be clean.
    expect(() => {
      guard.dispose();
    }).not.toThrow();
  });

  test("re-throws a non-benign rejection on dispose", () => {
    const guard = installControllerClosedGuard();
    const unexpected = new Error("genuinely unexpected rejection");
    emitUnhandledRejection(unexpected);
    expect(() => {
      guard.dispose();
    }).toThrow(unexpected);
  });

  test("a non-TypeError mentioning the phrase is NOT suppressed (only the TypeError is)", () => {
    const guard = installControllerClosedGuard();
    // The guard keys on `instanceof TypeError`, not the message alone: a
    // plain Error carrying the same phrase must still surface.
    const lookalike = new Error("Controller is already closed");
    emitUnhandledRejection(lookalike);
    expect(() => {
      guard.dispose();
    }).toThrow(lookalike);
  });

  test("dispose removes the listener (no capture after dispose)", () => {
    const before = process.listenerCount("unhandledRejection");
    const guard = installControllerClosedGuard();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    guard.dispose();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
