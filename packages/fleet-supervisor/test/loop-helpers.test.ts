import { describe, expect, it } from "bun:test";

import type { FleetJournalEntry, FleetPressureStatusEntry, NodeMemSnapshot } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import {
  applyPressureTransition,
  emitPeriodicPressureStatus,
  makeUnreachableFallback,
} from "../src/loop-helpers.js";
import { detectPressure, PressureWindow } from "../src/policy.js";

const THRESHOLDS = {
  headroomMinMb: 512,
  compressorWarnMb: 2048,
  consecutiveTicks: 1,
  clearTicks: 5,
};

const HOT_MEM: NodeMemSnapshot = {
  free_mb: 100,
  compressor_mb: 4000,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};

const BOUNDARY_MEM: NodeMemSnapshot = {
  free_mb: 512, // exactly at headroomMinMb
  compressor_mb: 2048, // exactly at compressorWarnMb
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};

function makePressureWindow(mem: NodeMemSnapshot): PressureWindow {
  const w = new PressureWindow(1);
  w.push(mem, []);
  return w;
}

function makeInitialState() {
  return {
    pressureDetected: false,
    lastPressureLevel: "NORMAL" as const,
    consecutiveClearTicks: 0,
    enteredHighAt: null,
    ticksInHigh: 0,
  };
}

// M5: makeUnreachableFallback must return null (not 0) for p50_ms and p95_ms
describe("makeUnreachableFallback (M5)", () => {
  it("returns null for p50_ms and p95_ms", () => {
    const target: WorkloadTarget = { name: "t", endpoint: "http://t", kind: "ModelHost" };
    const snap = makeUnreachableFallback(new Map())(target);
    expect(snap.p50_ms).toBeNull();
    expect(snap.p95_ms).toBeNull();
  });
});

// M7: breach flags must use inclusive bounds (<=, >=) matching isPressureHot
describe("applyPressureTransition breach flags (M7)", () => {
  it("emits headroomBreach:true AND compressorBreach:true when node is exactly at thresholds", () => {
    const window = makePressureWindow(BOUNDARY_MEM);
    const pressure = detectPressure(window, THRESHOLDS);
    expect(pressure).not.toBeNull();

    const entries: FleetJournalEntry[] = [];
    applyPressureTransition(
      "2026-01-01T00:00:00.000Z",
      "n",
      BOUNDARY_MEM,
      pressure,
      window,
      makeInitialState(),
      THRESHOLDS,
      (e) => entries.push(e),
    );

    const status = entries.find(
      (e): e is FleetPressureStatusEntry => e.kind === "fleet-pressure-status",
    );
    expect(status).toBeDefined();
    expect(status?.headroomBreach).toBe(true);
    expect(status?.compressorBreach).toBe(true);
  });

  it("emits headroomBreach:true AND compressorBreach:true from emitPeriodicPressureStatus at boundary", () => {
    const window = makePressureWindow(BOUNDARY_MEM);
    const pressure = detectPressure(window, THRESHOLDS);
    const entryTs = "2026-01-01T00:00:00.000Z";
    const laterTs = "2026-01-01T00:00:01.000Z";

    // Advance to HIGH state
    const state = applyPressureTransition(
      entryTs,
      "n",
      BOUNDARY_MEM,
      pressure,
      window,
      makeInitialState(),
      THRESHOLDS,
      () => {},
    );
    // Tick 1: ticksInHigh becomes 1
    const state2 = applyPressureTransition(
      laterTs,
      "n",
      BOUNDARY_MEM,
      null,
      window,
      state,
      THRESHOLDS,
      () => {},
    );

    const entries: FleetJournalEntry[] = [];
    emitPeriodicPressureStatus(laterTs, "n", BOUNDARY_MEM, state2, THRESHOLDS, 1, (e) =>
      entries.push(e),
    );

    const status = entries.find(
      (e): e is FleetPressureStatusEntry => e.kind === "fleet-pressure-status",
    );
    expect(status).toBeDefined();
    expect(status?.headroomBreach).toBe(true);
    expect(status?.compressorBreach).toBe(true);
  });
});

// M8: on the HIGH-entry tick exactly ONE fleet-pressure-status is emitted;
//     on a later aligned tick (ticksInHigh > 0 and ticksInHigh % N === 0) it still emits.
describe("emitPeriodicPressureStatus duplicate guard (M8)", () => {
  const pressureStatusEveryTicks = 2;

  it("HIGH-entry tick emits exactly ONE fleet-pressure-status (no duplicate from periodic)", () => {
    const window = makePressureWindow(HOT_MEM);
    const pressure = detectPressure(window, THRESHOLDS);
    const ts = "2026-01-01T00:00:00.000Z";

    const entries: FleetJournalEntry[] = [];
    const state = applyPressureTransition(
      ts,
      "n",
      HOT_MEM,
      pressure,
      window,
      makeInitialState(),
      THRESHOLDS,
      (e) => entries.push(e),
    );
    // state.ticksInHigh === 0 here — the bug fires on 0 % N === 0
    emitPeriodicPressureStatus(ts, "n", HOT_MEM, state, THRESHOLDS, pressureStatusEveryTicks, (e) =>
      entries.push(e),
    );

    const statuses = entries.filter((e) => e.kind === "fleet-pressure-status");
    expect(statuses).toHaveLength(1);
  });

  it("later tick with ticksInHigh > 0 and ticksInHigh % N === 0 still emits periodic status", () => {
    const window = makePressureWindow(HOT_MEM);
    const pressure = detectPressure(window, THRESHOLDS);
    const t0 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-01-01T00:00:02.000Z";

    // HIGH-entry tick (ticksInHigh → 0)
    const state0 = applyPressureTransition(
      t0,
      "n",
      HOT_MEM,
      pressure,
      window,
      makeInitialState(),
      THRESHOLDS,
      () => {},
    );
    // Tick +1 (ticksInHigh → 1)
    const state1 = applyPressureTransition(
      t2,
      "n",
      HOT_MEM,
      null,
      window,
      state0,
      THRESHOLDS,
      () => {},
    );
    // Tick +2 (ticksInHigh → 2; 2 % 2 === 0 and > 0 → should emit)
    const state2 = applyPressureTransition(
      t2,
      "n",
      HOT_MEM,
      null,
      window,
      state1,
      THRESHOLDS,
      () => {},
    );

    const entries: FleetJournalEntry[] = [];
    emitPeriodicPressureStatus(
      t2,
      "n",
      HOT_MEM,
      state2,
      THRESHOLDS,
      pressureStatusEveryTicks,
      (e) => entries.push(e),
    );

    expect(entries.filter((e) => e.kind === "fleet-pressure-status")).toHaveLength(1);
  });
});
