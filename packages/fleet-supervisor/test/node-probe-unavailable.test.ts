import { describe, expect, it } from "bun:test";

import type { WorkloadSnapshot } from "../src/types.js";

import { parseVmStatOutput, probeNodeMem } from "../src/node-probe.js";
import { detectPressure, PressureWindow } from "../src/policy.js";

const THRESHOLDS = {
  headroomMinMb: 512,
  compressorWarnMb: 2048,
  consecutiveTicks: 3,
  clearTicks: 5,
};

const REACHABLE_WORKLOAD: WorkloadSnapshot = {
  name: "w",
  kind: "ModelHost",
  endpoint: "http://127.0.0.1:8099",
  priority: 50,
  rss_mb: 100,
  request_rate_5m: 1,
  error_rate_5m: 0,
  p50_ms: 10,
  p95_ms: 10,
  models: [],
  reachable: true,
  consecutiveErrors: 0,
};

describe("parseVmStatOutput unavailable", () => {
  it("returns available:false when raw is empty — not free_mb:0 masquerading as pressure", () => {
    const snap = parseVmStatOutput("");
    // RED before fix: snap.available is undefined (field does not exist)
    expect(snap.available).toBe(false);
  });

  it("returns available:false when raw matches no known vm_stat fields", () => {
    const snap = parseVmStatOutput("some garbage that matches nothing");
    expect(snap.available).toBe(false);
  });

  it("does not mark valid output unavailable", () => {
    const FAKE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                         1031.`;
    const snap = parseVmStatOutput(FAKE);
    expect(snap.available).not.toBe(false);
    expect(snap.free_mb).toBeGreaterThan(0);
  });
});

describe("probeNodeMem unavailable", () => {
  it("yields available:false when exec returns empty string", async () => {
    const snap = await probeNodeMem({ exec: () => Promise.resolve("") });
    expect(snap.available).toBe(false);
  });
});

describe("detectPressure with unavailable readings", () => {
  it("does not detect pressure from unavailable readings even after consecutiveTicks passes", () => {
    const window = new PressureWindow(3);
    // free_mb:0 + compressor_mb:9999 would look like extreme pressure if counted;
    // include a real workload so pickEvictionCandidate doesn't short-circuit on empty list
    for (let i = 0; i < 5; i++) {
      window.push(
        {
          free_mb: 0,
          compressor_mb: 9999,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          swap_in: 0,
          swap_out: 0,
          available: false,
        },
        [REACHABLE_WORKLOAD],
      );
    }
    // RED before fix: detectPressure returns non-null (sees 3 "hot" all-zero entries)
    expect(detectPressure(window, THRESHOLDS)).toBeNull();
  });

  it("still detects pressure from valid hot readings that follow unavailable ticks", () => {
    const window = new PressureWindow(3);
    for (let i = 0; i < 2; i++) {
      window.push(
        {
          free_mb: 0,
          compressor_mb: 0,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          swap_in: 0,
          swap_out: 0,
          available: false,
        },
        [],
      );
    }
    for (let i = 0; i < 3; i++) {
      window.push(
        {
          free_mb: 30,
          compressor_mb: 4000,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          swap_in: 0,
          swap_out: 0,
        },
        [REACHABLE_WORKLOAD],
      );
    }
    expect(detectPressure(window, THRESHOLDS)).not.toBeNull();
  });
});
