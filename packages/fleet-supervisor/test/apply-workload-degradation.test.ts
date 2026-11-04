import { describe, expect, test } from "bun:test";

import type { DegradationThresholds, WorkloadHealthState } from "../src/policy.js";
import type {
  FleetJournalEntry,
  FleetProposalEntry,
  FleetTransitionEntry,
  WorkloadSnapshot,
} from "../src/types.js";

import { applyWorkloadDegradation } from "../src/loop-helpers.js";

const BASE_TS = "2026-08-19T12:00:00Z";

function workload(name: string, overrides: Partial<WorkloadSnapshot> = {}): WorkloadSnapshot {
  return {
    name,
    kind: "ModelRun",
    endpoint: `http://127.0.0.1:8080`,
    priority: 50,
    rss_mb: 0,
    request_rate_5m: 0,
    error_rate_5m: 0,
    p50_ms: 10,
    p95_ms: 20,
    models: [] as string[],
    reachable: true,
    consecutiveErrors: 0,
    ...overrides,
  };
}

const THRESHOLDS: DegradationThresholds = {
  consecutiveErrorsForDegraded: 3,
  p95DegradedMs: 5000,
  consecutiveCompletionErrorsForDegraded: 2,
};

function collectEntries(
  workloads: WorkloadSnapshot[],
  workloadHealth: Map<string, WorkloadHealthState>,
): FleetJournalEntry[] {
  const entries: FleetJournalEntry[] = [];
  applyWorkloadDegradation(
    BASE_TS,
    "node1",
    workloads,
    THRESHOLDS,
    workloadHealth,
    (entry: FleetJournalEntry) => entries.push(entry),
  );
  return entries;
}

function transitions(entries: FleetJournalEntry[]): FleetTransitionEntry[] {
  return entries.filter((e): e is FleetTransitionEntry => e.kind === "fleet-transition");
}

function proposals(entries: FleetJournalEntry[]): FleetProposalEntry[] {
  return entries.filter((e): e is FleetProposalEntry => e.kind === "fleet-proposal");
}

describe("applyWorkloadDegradation", () => {
  test("(a) healthy workload with no map entry writes nothing and leaves map without entry", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    const entries = collectEntries([workload("healthy-workload")], workloadHealth);
    expect(entries).toEqual([]);
    expect(workloadHealth.has("healthy-workload")).toBe(false);
  });

  test("(b) missing map entry counts as prior healthy; consecutiveErrors 3 writes fleet-transition + fleet-proposal", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    const entries = collectEntries(
      [workload("err-workload", { reachable: false, consecutiveErrors: 3 })],
      workloadHealth,
    );
    expect(entries).toHaveLength(2);
    const trans = transitions(entries);
    expect(trans).toHaveLength(1);
    const t = trans[0]!;
    expect(t.from).toBe("healthy");
    expect(t.to).toBe("degraded");
    expect(t.signal).toBe("degraded");
    expect(t.subjectKind).toBe("workload");
    expect(t.subject).toBe("err-workload");
    expect(t.ts).toBe(BASE_TS);
    expect(t.node).toBe("node1");
  });

  test("(c) same flip writes fleet-proposal with exact proposalId, deep-equals transition, restart action", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    const entries = collectEntries(
      [workload("err-workload", { reachable: false, consecutiveErrors: 3 })],
      workloadHealth,
    );
    expect(entries).toHaveLength(2);
    const e0 = entries[0] as FleetTransitionEntry;
    const e1 = entries[1] as FleetProposalEntry;
    expect(e0.kind).toBe("fleet-transition");
    expect(e1.kind).toBe("fleet-proposal");
    const trans = transitions(entries);
    const props = proposals(entries);
    expect(props).toHaveLength(1);
    const proposal = props[0]!;
    const expectedId = `degradation-err-workload-${BASE_TS}`;
    expect(proposal.proposalId).toBe(expectedId);
    expect(proposal.ts).toBe(BASE_TS);
    expect(proposal.node).toBe("node1");
    // transition fields deep-equal between transition and proposal
    const t = trans[0]!;
    expect(proposal.transition.subject).toBe(t.subject);
    expect(proposal.transition.subjectKind).toBe(t.subjectKind);
    expect(proposal.transition.signal).toBe(t.signal);
    expect(proposal.transition.from).toBe(t.from);
    expect(proposal.transition.to).toBe(t.to);
    expect(proposal.action.type).toBe("restart");
    const action = proposal.action as Extract<
      FleetProposalEntry,
      { kind: "fleet-proposal" }
    >["action"] & { type: "restart"; workload: string; reason: string };
    expect(action.workload).toBe("err-workload");
    expect(action.reason).toContain("consecutive errors 3");
  });

  test("(d) after flip the map holds 'degraded' for that workload", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    collectEntries(
      [workload("err-workload", { reachable: false, consecutiveErrors: 3 })],
      workloadHealth,
    );
    expect(workloadHealth.get("err-workload")).toBe("degraded");
  });

  test("(e) prior degraded while still unhealthy writes nothing, map stays degraded", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    workloadHealth.set("err-workload", "degraded");
    const entries = collectEntries(
      [workload("err-workload", { reachable: false, consecutiveErrors: 5 })],
      workloadHealth,
    );
    expect(entries).toEqual([]);
    expect(workloadHealth.get("err-workload")).toBe("degraded");
  });

  test("(f) recovery: prior degraded with reachable, 0 errors, p95 under threshold writes one transition, no proposal, map set to healthy", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    workloadHealth.set("recovered-workload", "degraded");
    const entries = collectEntries(
      [workload("recovered-workload", { reachable: true, consecutiveErrors: 0, p95_ms: 100 })],
      workloadHealth,
    );
    expect(entries).toHaveLength(1);
    const trans = transitions(entries);
    expect(trans).toHaveLength(1);
    const t = trans[0]!;
    expect(t.from).toBe("degraded");
    expect(t.to).toBe("healthy");
    expect(workloadHealth.get("recovered-workload")).toBe("healthy");
  });

  test("(g) prior degraded with reachable false and consecutiveErrors 0 writes nothing, map stays degraded", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    workloadHealth.set("unreachable-zero", "degraded");
    const entries = collectEntries(
      [workload("unreachable-zero", { reachable: false, consecutiveErrors: 0 })],
      workloadHealth,
    );
    expect(entries).toEqual([]);
    expect(workloadHealth.get("unreachable-zero")).toBe("degraded");
  });

  test("(h) several workloads: entries in array order, each independent; [unhealthy A, healthy B, unhealthy C] → [transition A, proposal A, transition C, proposal C]", () => {
    const workloadHealth = new Map<string, WorkloadHealthState>();
    const workloads = [
      workload("A", { reachable: false, consecutiveErrors: 4 }),
      workload("B"),
      workload("C", { reachable: false, consecutiveErrors: 3 }),
    ];
    const entries = collectEntries(workloads, workloadHealth);
    expect(entries).toHaveLength(4);
    const trans = transitions(entries);
    const props = proposals(entries);
    expect(trans).toHaveLength(2);
    const t0 = trans[0]!;
    const t1 = trans[1]!;
    expect(t0.subject).toBe("A");
    expect(t1.subject).toBe("C");
    expect(props).toHaveLength(2);
    const p0 = props[0]!;
    const p1 = props[1]!;
    expect(
      (
        p0.action as Extract<FleetProposalEntry, { kind: "fleet-proposal" }>["action"] & {
          type: "restart";
          workload: string;
          reason: string;
        }
      ).workload,
    ).toBe("A");
    expect(
      (
        p1.action as Extract<FleetProposalEntry, { kind: "fleet-proposal" }>["action"] & {
          type: "restart";
          workload: string;
          reason: string;
        }
      ).workload,
    ).toBe("C");
    expect(workloadHealth.get("A")).toBe("degraded");
    expect(workloadHealth.get("C")).toBe("degraded");
    expect(workloadHealth.has("B")).toBe(false);
  });
});
