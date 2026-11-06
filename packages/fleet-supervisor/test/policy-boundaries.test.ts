import { describe, expect, it } from "bun:test";

import type { NodeMemSnapshot, WorkloadSnapshot } from "../src/types.js";

import {
  detectDegradation,
  detectPressure,
  PressureWindow,
  projectAdmissionHeadroom,
} from "../src/policy.js";

const PRESSURE = {
  headroomMinMb: 512,
  compressorWarnMb: 2048,
  consecutiveTicks: 3,
  clearTicks: 5,
};

const DEGRADATION = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5000,
  consecutiveCompletionErrorsForDegraded: 2,
};

const HIGH: NodeMemSnapshot = {
  free_mb: 30,
  compressor_mb: 4000,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};
const NORMAL: NodeMemSnapshot = {
  free_mb: 4096,
  compressor_mb: 200,
  active_mb: 0,
  inactive_mb: 0,
  wired_mb: 0,
  swap_in: 0,
  swap_out: 0,
};

function reachableHealthy(
  name: string,
  overrides: Partial<WorkloadSnapshot> = {},
): WorkloadSnapshot {
  return {
    name,
    kind: "ModelRun",
    priority: 50,
    endpoint: "http://127.0.0.1:8086",
    rss_mb: 2048,
    request_rate_5m: 1,
    error_rate_5m: 0,
    p50_ms: 120,
    p95_ms: 200,
    models: [],
    reachable: true,
    consecutiveErrors: 0,
    ...overrides,
  };
}

function pushRepeat(
  window: PressureWindow,
  times: number,
  nodeMem: NodeMemSnapshot,
  workloads: WorkloadSnapshot[],
): void {
  for (let i = 0; i < times; i++) {
    window.push(nodeMem, workloads);
  }
}

describe("PressureWindow", () => {
  it("drops the oldest entry once past capacity and tail clamps to size", () => {
    const window = new PressureWindow(2);
    window.push({ ...NORMAL, free_mb: 10 }, []);
    window.push({ ...NORMAL, free_mb: 20 }, []);
    window.push({ ...NORMAL, free_mb: 30 }, []);
    expect(window.size()).toBe(2);
    expect(window.tail(2).map((entry) => entry.node_mem.free_mb)).toEqual([20, 30]);
    expect(window.tail(5).map((entry) => entry.node_mem.free_mb)).toEqual([20, 30]);
  });

  it("ignores available:false but keeps available:true and an absent flag", () => {
    const window = new PressureWindow(3);
    window.push({ ...NORMAL, available: false }, []);
    expect(window.size()).toBe(0);
    window.push({ ...NORMAL, available: true }, []);
    expect(window.size()).toBe(1);
    window.push(NORMAL, []);
    expect(window.size()).toBe(2);
  });
});

describe("detectPressure boundaries", () => {
  it("free_mb == headroomMinMb and compressor_mb == compressorWarnMb both count as hot", () => {
    const window = new PressureWindow(3);
    const edge: NodeMemSnapshot = { ...NORMAL, free_mb: 512, compressor_mb: 2048 };
    pushRepeat(window, 3, edge, [reachableHealthy("target")]);
    const result = detectPressure(window, PRESSURE);
    if (!result) throw new Error("expected HIGH at exact inclusive thresholds");
    expect(result.level).toBe("HIGH");
  });

  it("capacity below consecutiveTicks never detects, however many HIGH pushes", () => {
    const window = new PressureWindow(2);
    pushRepeat(window, 5, HIGH, [reachableHealthy("target")]);
    expect(detectPressure(window, PRESSURE)).toBeNull();
  });

  it("only the last consecutiveTicks entries are considered", () => {
    const window = new PressureWindow(5);
    window.push(NORMAL, [reachableHealthy("target")]);
    pushRepeat(window, 3, HIGH, [reachableHealthy("target")]);
    const result = detectPressure(window, PRESSURE);
    if (!result) throw new Error("expected HIGH from the last 3 hot ticks");
    expect(result.level).toBe("HIGH");
  });

  it("transition and proposal.transition carry the exact node-pressure shape", () => {
    const window = new PressureWindow(3);
    pushRepeat(window, 3, HIGH, [reachableHealthy("target")]);
    const result = detectPressure(window, PRESSURE);
    if (!result) throw new Error("expected HIGH");
    const transition = {
      subject: "node",
      subjectKind: "node",
      signal: "pressure",
      from: "NORMAL",
      to: "HIGH",
    } as const;
    expect(result.transition).toEqual(transition);
    if (!result.proposal) throw new Error("expected an evict proposal");
    expect(result.proposal.transition).toEqual(transition);
  });

  it("evict reason names the tick count verbatim", () => {
    const window = new PressureWindow(3);
    pushRepeat(window, 3, HIGH, [reachableHealthy("target")]);
    const result = detectPressure(window, PRESSURE);
    if (!result?.proposal) throw new Error("expected an evict proposal");
    if (result.proposal.action.type !== "evict") throw new Error("expected evict action");
    expect(result.proposal.action.reason).toBe(
      "sustained memory pressure: 3 ticks below headroom + above compressor threshold",
    );
  });

  it("eviction target comes from the last entry's workloads, not earlier ticks", () => {
    const window = new PressureWindow(3);
    const oldBig = reachableHealthy("old-big", { rss_mb: 100_000 });
    const newSmall = reachableHealthy("new-small", { rss_mb: 10 });
    window.push(HIGH, [oldBig]);
    window.push(HIGH, [oldBig]);
    window.push(HIGH, [newSmall]);
    const result = detectPressure(window, PRESSURE);
    if (!result?.proposal) throw new Error("expected an evict proposal");
    if (result.proposal.action.type !== "evict") throw new Error("expected evict action");
    expect(result.proposal.action.workload).toBe("new-small");
  });

  it("null rss_mb ranks as 0 against a reported rss_mb", () => {
    const window = new PressureWindow(3);
    const mixed = [
      reachableHealthy("a-null", { rss_mb: null }),
      reachableHealthy("b-one", { rss_mb: 1 }),
    ];
    pushRepeat(window, 3, HIGH, mixed);
    const result = detectPressure(window, PRESSURE);
    if (!result?.proposal) throw new Error("expected an evict proposal");
    if (result.proposal.action.type !== "evict") throw new Error("expected evict action");
    expect(result.proposal.action.workload).toBe("b-one");
  });

  it("all-null rss falls back to the alphabetical tie-break", () => {
    const window = new PressureWindow(3);
    const tied = [
      reachableHealthy("a-null", { rss_mb: null }),
      reachableHealthy("b-null", { rss_mb: null }),
    ];
    pushRepeat(window, 3, HIGH, tied);
    const result = detectPressure(window, PRESSURE);
    if (!result?.proposal) throw new Error("expected an evict proposal");
    if (result.proposal.action.type !== "evict") throw new Error("expected evict action");
    expect(result.proposal.action.workload).toBe("a-null");
  });

  it("empty workloads gives HIGH without a proposal", () => {
    const window = new PressureWindow(3);
    pushRepeat(window, 3, HIGH, []);
    const result = detectPressure(window, PRESSURE);
    if (!result) throw new Error("expected HIGH with no eviction target");
    expect(result.level).toBe("HIGH");
    expect(result.proposal).toBeUndefined();
  });
});

describe("projectAdmissionHeadroom boundaries", () => {
  it("projected exactly at headroom is allowed (strict <)", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 5,
      headroomMinGiB: 5,
      safetyFactor: 1,
    });
    expect(result.allowed).toBe(true);
    expect(result.projectedFreeGiB).toBe(5);
  });

  it("an explicit safetyFactor of 0 is honoured", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 5,
      headroomMinGiB: 5,
      safetyFactor: 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.projectedFreeGiB).toBe(10);
  });

  it("measuredPeakMb of 0 still selects the measured source", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 5,
      headroomMinGiB: 5,
      measuredPeakMb: 0,
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed) throw new Error("expected allowed");
    expect(result.source).toBe("measured");
    expect(result.projectedFreeGiB).toBe(10);
  });

  it("compressor exactly at max denies", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 1,
      headroomMinGiB: 1,
      safetyFactor: 1,
      currentCompressorGiB: 2,
      compressorMaxGiB: 2,
    });
    if (result.allowed) throw new Error("expected compressor at max to deny");
    expect(result.reason).toBe("compressor_above_threshold");
    expect(result.currentCompressorGiB).toBe(2);
  });

  it("compressor without a max is allowed and echoed", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 1,
      headroomMinGiB: 1,
      safetyFactor: 1,
      currentCompressorGiB: 2,
    });
    expect(result.allowed).toBe(true);
    expect(result.currentCompressorGiB).toBe(2);
  });

  it("headroom deny takes precedence over the compressor signal", () => {
    const result = projectAdmissionHeadroom({
      currentFreeGiB: 4,
      expectedMemoryGiB: 1,
      headroomMinGiB: 5,
      safetyFactor: 1,
      currentCompressorGiB: 9,
      compressorMaxGiB: 2,
    });
    if (result.allowed) throw new Error("expected headroom denial");
    expect(result.reason).toBe("projected_free_below_headroom");
    expect(result.currentCompressorGiB).toBe(9);
  });

  it("omits currentCompressorGiB entirely on allow and deny paths when not provided", () => {
    const allowed = projectAdmissionHeadroom({
      currentFreeGiB: 10,
      expectedMemoryGiB: 1,
      headroomMinGiB: 5,
      safetyFactor: 1,
    });
    expect(allowed.allowed).toBe(true);
    expect("currentCompressorGiB" in allowed).toBe(false);
    const denied = projectAdmissionHeadroom({
      currentFreeGiB: 1,
      expectedMemoryGiB: 1,
      headroomMinGiB: 5,
      safetyFactor: 1,
    });
    expect(denied.allowed).toBe(false);
    expect("currentCompressorGiB" in denied).toBe(false);
  });
});

describe("detectDegradation precedence and boundaries", () => {
  it("completion wedge beats the error count and renders null status as none", () => {
    const workload = reachableHealthy("wedged", {
      consecutiveErrors: 5,
      completionProbe: { ran: true, ok: false, status: null, consecutiveFailures: 2, latencyMs: 1 },
    });
    const result = detectDegradation(workload, "healthy", DEGRADATION);
    if (!result?.proposal) throw new Error("expected a restart proposal");
    if (result.proposal.action.type !== "restart") throw new Error("expected restart action");
    expect(result.proposal.action.reason).toBe(
      "completion probe failed 2× despite /health 200 (last status none)",
    );
  });

  it("error threshold beats p95 for the reason", () => {
    const workload = reachableHealthy("errors-and-slow", {
      consecutiveErrors: 3,
      p95_ms: 9000,
    });
    const result = detectDegradation(workload, "healthy", DEGRADATION);
    if (!result?.proposal) throw new Error("expected a restart proposal");
    if (result.proposal.action.type !== "restart") throw new Error("expected restart action");
    expect(result.proposal.action.reason).toBe("consecutive errors 3 ≥ 3");
  });

  it("p95-only degrade renders the exact latency reason", () => {
    const workload = reachableHealthy("slow", { p95_ms: 8000 });
    const result = detectDegradation(workload, "healthy", DEGRADATION);
    if (!result?.proposal) throw new Error("expected a restart proposal");
    if (result.proposal.action.type !== "restart") throw new Error("expected restart action");
    expect(result.proposal.action.reason).toBe("p95 8000ms > 5000ms");
  });

  it("p95 exactly at the threshold does not degrade (strict >)", () => {
    const workload = reachableHealthy("edge-slow", { p95_ms: 5000 });
    expect(detectDegradation(workload, "healthy", DEGRADATION)).toBeNull();
  });

  it("one error below the error threshold does not degrade", () => {
    const workload = reachableHealthy("almost", { consecutiveErrors: 2 });
    expect(detectDegradation(workload, "healthy", DEGRADATION)).toBeNull();
  });

  it("recovery requires reachability", () => {
    const workload = reachableHealthy("ghost", {
      reachable: false,
      consecutiveErrors: 0,
      p95_ms: 200,
    });
    expect(detectDegradation(workload, "degraded", DEGRADATION)).toBeNull();
  });

  it("null p95 counts as recovered", () => {
    const workload = reachableHealthy("recovered", { p95_ms: null });
    const result = detectDegradation(workload, "degraded", DEGRADATION);
    if (!result) throw new Error("expected a recovery transition");
    expect(result.to).toBe("healthy");
    expect(result.transition).toEqual({
      subject: "recovered",
      subjectKind: "workload",
      signal: "degraded",
      from: "degraded",
      to: "healthy",
    });
    expect(result.proposal).toBeUndefined();
  });

  it("residual errors block recovery", () => {
    const workload = reachableHealthy("residual", { consecutiveErrors: 1 });
    expect(detectDegradation(workload, "degraded", DEGRADATION)).toBeNull();
  });

  it("degrade echoes the prior state and proposal shares the transition", () => {
    const workload = reachableHealthy("flips", { consecutiveErrors: 3 });
    const result = detectDegradation(workload, "healthy", DEGRADATION);
    if (!result) throw new Error("expected a degrade transition");
    expect(result.transition.from).toBe("healthy");
    if (!result.proposal) throw new Error("expected a restart proposal");
    expect(result.proposal.transition).toEqual(result.transition);
  });
});
