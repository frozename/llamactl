import { describe, expect, it } from "bun:test";

import type { SlotProgressReading } from "../src/types.js";

import { applyBusyGuard } from "../src/completion-probe.js";

function reading(slots: SlotProgressReading["slots"]): SlotProgressReading {
  return { available: true, slots };
}

const BUSY = { id: 0, state: 1, processing: true };
const IDLE = { id: 0, state: 0, processing: false, nPast: 4096, nDecoded: 128 };

describe("applyBusyGuard", () => {
  it("holds a wedge when decode progress advanced on a processing slot", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 200 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 4096, nDecoded: 200, stallChecks: 0 },
    });
  });

  it("holds a wedge when prompt progress advanced and decode progress stayed flat", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 6144, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded.consecutiveFailures).toBe(1);
    expect(guarded.reason).toBe("busy");
    expect(guarded.nextProgress).toEqual({ nPast: 6144, nDecoded: 128, stallChecks: 0 });
  });

  it("holds a wedge below the stall threshold when counters are flat", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "stall-below-threshold",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1 },
    });
  });

  it("increments a wedge once flat counters reach the stall threshold", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: "wedge",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
    });
  });

  it("increments an idle wedge when /slots is available and no slot is processing", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([IDLE]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: "idle-wedge",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
    });
  });

  it("holds a wedge when slot progress is unavailable", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: { available: false, reason: "HTTP 404", slots: [] },
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: undefined,
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
    });
  });

  it("holds ambiguous null counters without incrementing", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: null, nDecoded: null }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
      busyStallChecks: 2,
    });

    expect(guarded.consecutiveFailures).toBe(1);
    expect(guarded.nextProgress).toEqual({ nPast: null, nDecoded: null, stallChecks: 0 });
  });

  it("holds the first processing wedge and seeds progress", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: undefined,
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 0 },
    });
  });

  it("holds and resets progress when counters move lower", () => {
    const guarded = applyBusyGuard({
      classification: "wedge",
      prior: 1,
      reading: reading([{ ...BUSY, nPast: 512, nDecoded: 10 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 1,
      reason: "busy",
      nextProgress: { nPast: 512, nDecoded: 10, stallChecks: 0 },
    });
  });

  it("leaves non-wedge classifications at the prior count", () => {
    const guarded = applyBusyGuard({
      classification: "ok",
      prior: 2,
      reading: reading([{ ...BUSY, nPast: 4096, nDecoded: 128 }]),
      lastProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1 },
      busyStallChecks: 2,
    });

    expect(guarded).toEqual({
      consecutiveFailures: 2,
      reason: undefined,
      nextProgress: { nPast: 4096, nDecoded: 128, stallChecks: 1 },
    });
  });
});
