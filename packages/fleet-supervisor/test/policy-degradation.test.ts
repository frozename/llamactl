import { describe, expect, it } from "bun:test";

import type { WorkloadSnapshot } from "../src/types.js";

import { detectDegradation } from "../src/policy.js";

const THRESHOLDS = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5000,
  consecutiveCompletionErrorsForDegraded: 2,
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
    models: ["granite-3b"],
    reachable: true,
    consecutiveErrors: 0,
    ...overrides,
  };
}

describe("detectDegradation", () => {
  it("4 consecutive errors → state degraded + restart proposal", () => {
    const workload: WorkloadSnapshot = {
      name: "granite-mini-3b",
      kind: "ModelRun",
      priority: 50,
      endpoint: "http://mac-mini.ai:8086",
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 1.0,
      p50_ms: 0,
      p95_ms: 0,
      models: [],
      reachable: false,
      consecutiveErrors: 4,
    };
    const result = detectDegradation(workload, "healthy", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("degraded");
    expect(result!.proposal).toBeDefined();
    if (result!.proposal?.action.type === "restart") {
      expect(result!.proposal.action.workload).toBe("granite-mini-3b");
    }
  });

  it("healthy workload emits no transition", () => {
    const workload: WorkloadSnapshot = {
      name: "qwen-host",
      kind: "ModelHost",
      priority: 50,
      endpoint: "http://127.0.0.1:8090",
      rss_mb: 10240,
      request_rate_5m: 2,
      error_rate_5m: 0,
      p50_ms: 240,
      p95_ms: 480,
      models: ["Qwen3-8B"],
      reachable: true,
      consecutiveErrors: 0,
    };
    expect(detectDegradation(workload, "healthy", THRESHOLDS)).toBeNull();
  });

  it("degraded → healthy recovery emits transition + no proposal", () => {
    const workload: WorkloadSnapshot = {
      name: "granite-mini-3b",
      kind: "ModelRun",
      priority: 50,
      endpoint: "http://mac-mini.ai:8086",
      rss_mb: 2048,
      request_rate_5m: 1,
      error_rate_5m: 0,
      p50_ms: 120,
      p95_ms: 200,
      models: [],
      reachable: true,
      consecutiveErrors: 0,
    };
    const result = detectDegradation(workload, "degraded", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("healthy");
    expect(result!.proposal).toBeUndefined();
  });

  it("p95-only degradation does not recover while latency stays high", () => {
    const workload: WorkloadSnapshot = {
      name: "slow-judge",
      kind: "ModelHost",
      priority: 50,
      endpoint: "http://x",
      rss_mb: 1024,
      request_rate_5m: 0.5,
      error_rate_5m: 0,
      p50_ms: 3000,
      p95_ms: 8000,
      models: [],
      reachable: true,
      consecutiveErrors: 0,
    };
    expect(detectDegradation(workload, "degraded", THRESHOLDS)).toBeNull();
  });

  it("p95 over threshold → degraded with p95 reason", () => {
    const workload: WorkloadSnapshot = {
      name: "slow-judge",
      kind: "ModelHost",
      priority: 50,
      endpoint: "http://x",
      rss_mb: 1024,
      request_rate_5m: 0.5,
      error_rate_5m: 0,
      p50_ms: 3000,
      p95_ms: 8000,
      models: [],
      reachable: true,
      consecutiveErrors: 0,
    };
    const result = detectDegradation(workload, "healthy", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("degraded");
    if (result!.proposal?.action.type === "restart") {
      expect(result!.proposal.action.reason).toContain("p95");
    }
  });

  it("still-degraded (no state change) returns null", () => {
    const workload: WorkloadSnapshot = {
      name: "broken",
      kind: "ModelHost",
      priority: 50,
      endpoint: "http://x",
      rss_mb: null,
      request_rate_5m: null,
      error_rate_5m: 1,
      p50_ms: 0,
      p95_ms: 0,
      models: [],
      reachable: false,
      consecutiveErrors: 7,
    };
    expect(detectDegradation(workload, "degraded", THRESHOLDS)).toBeNull();
  });

  it("completion wedge despite /health 200 → degraded + restart with wedge reason", () => {
    const workload = reachableHealthy("granite-judge", {
      completionProbe: { ran: true, ok: false, status: 503, consecutiveFailures: 2, latencyMs: 90 },
    });
    const result = detectDegradation(workload, "healthy", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("degraded");
    expect(result!.proposal?.action.type).toBe("restart");
    if (result!.proposal?.action.type === "restart") {
      expect(result!.proposal.action.workload).toBe("granite-judge");
      expect(result!.proposal.action.reason).toContain("despite /health 200");
      expect(result!.proposal.action.reason).toContain("503");
    }
  });

  it("completion failures below threshold → no degradation", () => {
    const workload = reachableHealthy("granite-judge", {
      completionProbe: { ran: true, ok: false, status: 503, consecutiveFailures: 1, latencyMs: 90 },
    });
    expect(detectDegradation(workload, "healthy", THRESHOLDS)).toBeNull();
  });

  it("still completion-wedged while already degraded → null (no false recovery)", () => {
    const workload = reachableHealthy("granite-judge", {
      completionProbe: { ran: true, ok: false, status: 503, consecutiveFailures: 3, latencyMs: 90 },
    });
    expect(detectDegradation(workload, "degraded", THRESHOLDS)).toBeNull();
  });

  it("completion probe recovers → healthy transition, no proposal", () => {
    const workload = reachableHealthy("granite-judge", {
      completionProbe: { ran: true, ok: true, status: 200, consecutiveFailures: 0, latencyMs: 80 },
    });
    const result = detectDegradation(workload, "degraded", THRESHOLDS);
    expect(result).not.toBeNull();
    expect(result!.to).toBe("healthy");
    expect(result!.proposal).toBeUndefined();
  });
});
