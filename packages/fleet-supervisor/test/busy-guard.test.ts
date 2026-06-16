import { describe, expect, it } from "bun:test";

import type { SlotProgressReading } from "../src/types.js";

import { applyBusyGuard } from "../src/completion-probe.js";

function reading(slots: SlotProgressReading["slots"]): SlotProgressReading {
  return { available: true, slots };
}

const BUSY = { id: 0, state: 1, processing: true };
const IDLE = { id: 0, state: 0, processing: false, nPast: 4096, nDecoded: 128 };
const MIN_STALL = 8000;

describe("applyBusyGuard", () => {
  it("holds a wedge when decode progress advanced on a processing slot", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 200 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 4096, nDecoded: 200, stallChecks: 0, lastAdvanceAt: 10000 },
    });
  });

  it("holds a wedge when prompt progress advanced and decode progress stayed flat", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 6144, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded.consecutiveFailures).toBe(1);
    expect(guarded.reason).toBe("busy");
    expect(guarded.nextProgress).toEqual({
      nPast: 6144,
      nDecoded: 128,
      stallChecks: 0,
      lastAdvanceAt: 10000,
    });
  });

  it("holds a wedge below the stall threshold when counters are flat and the window elapsed", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000, // elapsed 10000 >= MIN_STALL, so the stall counter may advance
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "stall-below-threshold",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 0 },
    });
  });

  it("increments a wedge once flat counters reach the stall threshold after the window", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: "wedge",
      // lastAdvanceAt is NOT reset on the wedge increment, so a deadlocked slot keeps
      // incrementing at a steady cadence on subsequent stalled probes.
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 2, lastAdvanceAt: 0 },
    });
  });

  it("increments an idle wedge when /slots is available and no slot is processing", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([IDLE]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: "idle-wedge",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
    });
  });

  it("holds a wedge when slot progress is unavailable", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: { available: false, reason: "HTTP 404", slots: [] },
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: undefined,
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
    });
  });

  it("holds ambiguous null counters without incrementing", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: null, nDecoded: null }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded.consecutiveFailures).toBe(1);
    expect(guarded.nextProgress).toEqual({
      nPast: null,
      nDecoded: null,
      stallChecks: 0,
      lastAdvanceAt: 10000,
    });
  });

  it("holds the first processing wedge and seeds progress", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: undefined,
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 10000 },
    });
  });

  it("holds and resets progress when counters move lower", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 512, nDecoded: 10 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 512, nDecoded: 10, stallChecks: 0, lastAdvanceAt: 10000 },
    });
  });

  it("leaves non-wedge classifications at the prior count", () => {
    const guarded = applyBusyGuard({
      classification: "ok",
      prior: 2,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 5 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: undefined,
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 5 },
    });
  });

  // F1 — the false-recycle fix: two fast polls inside one prompt-eval batch gap
  // (elapsed < minStallIntervalMs) must NOT both count as a stall, even though both
  // read flat. Without the wall-clock gate this recycled a busy judge mid-prompt-eval.
  it("does not count flat polls inside one batch gap as a stall (false-recycle fix)", () => {
    const first = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 1000 },
      busyStallChecks: 2,
      now: 2000, // elapsed 1000 < MIN_STALL
      minStallIntervalMs: MIN_STALL,
    });
    expect(first.consecutiveFailures).toBe(1);
    expect(first.reason).toBe("stall-below-threshold");
    expect(first.nextProgress).toEqual({
      nPast: 4096,
      nDecoded: 128,
      stallChecks: 0, // unchanged — the window has not elapsed
      lastAdvanceAt: 1000,
    });

    // a second fast poll, still inside the gap, also holds — no increment accumulates
    const second = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: first.nextProgress,
      busyStallChecks: 2,
      now: 4000, // elapsed 3000 < MIN_STALL
      minStallIntervalMs: MIN_STALL,
    });
    expect(second.consecutiveFailures).toBe(1);
    expect(second.nextProgress?.stallChecks).toBe(0);
  });

  it("increments only after the stall window elapses (busyStallChecks 1)", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0, lastAdvanceAt: 0 },
      busyStallChecks: 1,
      now: 9000, // elapsed 9000 >= MIN_STALL
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded.consecutiveFailures).toBe(2);
    expect(guarded.reason).toBe("wedge");
  });

  it("resets the stall window on a prompt-eval batch jump", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 6144, nDecoded: 128 }]), // batch advanced nPast
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1, lastAdvanceAt: 0 },
      busyStallChecks: 2,
      now: 10000,
      minStallIntervalMs: MIN_STALL,
    });

    expect(guarded.consecutiveFailures).toBe(1);
    expect(guarded.reason).toBe("busy");
    expect(guarded.nextProgress).toEqual({
      nPast: 6144,
      nDecoded: 128,
      stallChecks: 0,
      lastAdvanceAt: 10000,
    });
  });
});
