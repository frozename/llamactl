/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async migration contracts without artificial scheduling. */
import { describe, expect, it } from "bun:test";

import type { SnapshotRow } from "../src/aggregator-db.js";
import type { LeaseIntent } from "../src/lease-election.js";
import type { NodeSnapshot } from "../src/migration-controller.js";
import type { FleetSnapshotEntry, MoveProposal } from "../src/types.js";

import { electLeaseHolder } from "../src/lease-election.js";
import { MigrationController } from "../src/migration-controller.js";

const STALE_AFTER_MS = 90_000;

/**
 * The shared in-memory replicated snapshot map every supervisor sees. Each node
 * publishes its own FleetSnapshotEntry (carrying its lease intent) into this one
 * Record; every controller's getLeaseHolder elects over the same view. This is
 * the per-node-fresh-peer-view that getLatestPerNode provides in prod, modeled
 * in memory.
 */
type SharedMap = Record<string, FleetSnapshotEntry>;

function publish(map: SharedMap, node: string, tsMs: number, lease: LeaseIntent): void {
  map[node] = {
    kind: "fleet-snapshot",
    ts: new Date(tsMs).toISOString(),
    node,
    node_mem: {
      free_mb: 8000,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [],
    lease,
  };
}

function rowsFrom(map: SharedMap): SnapshotRow[] {
  return Object.values(map).map((snapshot) => ({
    node: snapshot.node,
    ts: snapshot.ts,
    snapshot,
  }));
}

/** A controller for `node` whose getLeaseHolder elects over the shared map at the
 *  current `now`. Destinations always have ample free memory so the ONLY gate that
 *  can suppress a move is the lease guard — isolating the election invariant. */
function makeController(
  node: string,
  peers: string[],
  map: SharedMap,
  now: () => number,
): MigrationController {
  return new MigrationController({
    peers,
    fetchSnapshot: async (peer): Promise<NodeSnapshot> => ({
      node: peer,
      pressureState: "NORMAL",
      nodeMem: { freeMb: 16_000 },
      workloads: [],
    }),
    deployWorkload: async (): Promise<void> => undefined,
    removeWorkload: async (): Promise<void> => undefined,
    selfNode: node,
    getLeaseHolder: (): string | null => electLeaseHolder(rowsFrom(map), now(), STALE_AFTER_MS),
    getNowMs: now,
  });
}

const sourceSnapshot = (node: string): NodeSnapshot => ({
  node,
  pressureState: "HIGH",
  nodeMem: { freeMb: 100 },
  workloads: [],
});

const workload = {
  name: "model-a",
  spec: { placement: "auto" as const },
  evictProposalId: "evict-1",
};

async function proposalsThisTick(
  controllers: { node: string; ctrl: MigrationController }[],
): Promise<string[]> {
  const out: string[] = [];
  for (const { node, ctrl } of controllers) {
    const p: MoveProposal | null = await ctrl.evaluateMove(
      { ...workload, node },
      sourceSnapshot(node),
    );
    if (p) out.push(node);
  }
  return out;
}

describe("multi-supervisor lease election", () => {
  it("F1: across one tick, AT MOST ONE controller proposes a move (the elected holder)", async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const map: SharedMap = {};
    const nodes = ["m2mini", "m4pro", "studio"];
    // All three eligible, all fresh, all same term -> lowest candidate ('m2mini') holds.
    for (const node of nodes)
      publish(map, node, nowMs - 1_000, { candidate: node, term: 4, eligible: true, seq: 1 });

    const controllers = nodes.map((node) => ({
      node,
      ctrl: makeController(
        node,
        nodes.filter((p) => p !== node),
        map,
        now,
      ),
    }));

    const proposers = await proposalsThisTick(controllers);

    expect(proposers).toHaveLength(1);
    expect(proposers[0]).toBe("m2mini");
  });

  it("F4: when the holder stops ticking and goes stale, the successor becomes the SOLE proposer (zero overlap)", async () => {
    let nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const map: SharedMap = {};
    const nodes = ["m2mini", "m4pro"];
    // m2mini is the elected holder (lowest candidate at equal term).
    publish(map, "m2mini", nowMs - 1_000, { candidate: "m2mini", term: 4, eligible: true, seq: 1 });
    publish(map, "m4pro", nowMs - 1_000, { candidate: "m4pro", term: 4, eligible: true, seq: 1 });

    const controllers = nodes.map((node) => ({
      node,
      ctrl: makeController(
        node,
        nodes.filter((p) => p !== node),
        map,
        now,
      ),
    }));

    // Tick 1: m2mini holds.
    expect(await proposalsThisTick(controllers)).toEqual(["m2mini"]);

    // Holder stops ticking: its ts freezes while m4pro keeps publishing fresh.
    // Advance the clock past staleAfterMs so m2mini's frozen ts expires.
    nowMs += STALE_AFTER_MS + 1_000;
    publish(map, "m4pro", nowMs - 1_000, { candidate: "m4pro", term: 4, eligible: true, seq: 2 });

    const successors = await proposalsThisTick(controllers);
    // Exactly one proposer, and it is the successor m4pro — never both.
    expect(successors).toEqual(["m4pro"]);
  });

  it("gap window (all holders stale) = NO proposer, never two", async () => {
    let nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;
    const map: SharedMap = {};
    const nodes = ["m2mini", "m4pro"];
    publish(map, "m2mini", nowMs - 1_000, { candidate: "m2mini", term: 4, eligible: true, seq: 1 });
    publish(map, "m4pro", nowMs - 1_000, { candidate: "m4pro", term: 4, eligible: true, seq: 1 });

    const controllers = nodes.map((node) => ({
      node,
      ctrl: makeController(
        node,
        nodes.filter((p) => p !== node),
        map,
        now,
      ),
    }));

    // Both stop ticking; clock advances past staleAfterMs for both.
    nowMs += STALE_AFTER_MS + 1_000;

    expect(await proposalsThisTick(controllers)).toHaveLength(0);
  });
});
