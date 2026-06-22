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

/**
 * Published in-flight-move entry shape, mirroring FleetSnapshotEntry.inFlightMoves
 * (and MigrationController.getInFlightMoves()). A peer carries the workloads it has
 * deployed onto a destination but not yet removed from the source.
 */
type PublishedInFlightMove = NonNullable<FleetSnapshotEntry["inFlightMoves"]>[number];

/** Stamp a node's published in-flight moves into its snapshot in the shared map. */
function publishInFlight(map: SharedMap, node: string, moves: PublishedInFlightMove[]): void {
  const existing = map[node];
  if (!existing) throw new Error(`publish lease for ${node} before its in-flight moves`);
  map[node] = { ...existing, inFlightMoves: moves };
}

/**
 * Collect the workloads any FRESH peer reports as in-flight in the shared map —
 * the exact computation the supervisor wiring performs over the per-node-fresh
 * peer view (getLatestPerNode) before feeding it to the controller. A self peer
 * is excluded (a node never honors its own published move).
 */
function freshPeerInFlightWorkloads(map: SharedMap, selfNode: string, nowMs: number): Set<string> {
  const out = new Set<string>();
  for (const snapshot of Object.values(map)) {
    if (snapshot.node === selfNode) continue;
    const tsMs = Date.parse(snapshot.ts);
    if (!Number.isFinite(tsMs) || nowMs - tsMs >= STALE_AFTER_MS) continue;
    for (const move of snapshot.inFlightMoves ?? []) out.add(move.workload);
  }
  return out;
}

/**
 * A controller whose getLeaseHolder ALWAYS names this node — isolating the
 * cross-node in-flight-move consumer from the election guard. Both A and B believe
 * they hold the lease (the realistic mid-takeover window: A elected, started a
 * move, then B also became/also-acts-as holder). The ONLY thing that should stop B
 * from a second move of A's in-flight workload is the new consumer guard.
 *
 * `withConsumer` toggles whether the isPeerMovingWorkload dep is supplied:
 *  - false  -> the pre-consumer behavior (RED): B double-proposes W.
 *  - true   -> the consumer wired: B honors A's in-flight move and skips W.
 */
function makeSelfHolderController(
  node: string,
  peers: string[],
  map: SharedMap,
  now: () => number,
  withConsumer: boolean,
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
    getLeaseHolder: (): string | null => node,
    getNowMs: now,
    ...(withConsumer
      ? {
          isPeerMovingWorkload: (workload: string): boolean =>
            freshPeerInFlightWorkloads(map, node, now()).has(workload),
        }
      : {}),
  });
}

describe("cross-node in-flight-move consumer (PR-4)", () => {
  const nowMs = 1_700_000_000_000;
  const now = (): number => nowMs;

  /** Seed: A and B both lease-eligible+fresh; A is mid-moving workload W. */
  function seedSharedMapWithAInFlight(): SharedMap {
    const map: SharedMap = {};
    publish(map, "A", nowMs - 1_000, { candidate: "A", term: 4, eligible: true, seq: 1 });
    publish(map, "B", nowMs - 1_000, { candidate: "B", term: 4, eligible: true, seq: 1 });
    // A has deployed model-a onto its destination but not yet removed the source.
    publishInFlight(map, "A", [
      {
        workload: "model-a",
        fromNode: "src",
        toNode: "dest",
        proposalId: "move-model-a-1",
        deployedAtMs: nowMs - 500,
      },
    ]);
    return map;
  }

  it("RED without the consumer: B double-proposes the SAME workload A is mid-moving", async () => {
    const map = seedSharedMapWithAInFlight();
    const b = makeSelfHolderController("B", ["A"], map, now, /* withConsumer */ false);

    const proposal: MoveProposal | null = await b.evaluateMove(
      { ...workload, name: "model-a", node: "B" },
      sourceSnapshot("B"),
    );

    // Pre-consumer: B has no idea A is mid-moving model-a -> it proposes a SECOND
    // move of the same workload. This is the cross-node double-move gap.
    expect(proposal).not.toBeNull();
    expect(proposal?.workload).toBe("model-a");
  });

  it("GREEN with the consumer: B honors A's in-flight move and proposes NOTHING for model-a", async () => {
    const map = seedSharedMapWithAInFlight();
    const b = makeSelfHolderController("B", ["A"], map, now, /* withConsumer */ true);

    const proposal: MoveProposal | null = await b.evaluateMove(
      { ...workload, name: "model-a", node: "B" },
      sourceSnapshot("B"),
    );

    // B sees A's published in-flight move of model-a and skips it.
    expect(proposal).toBeNull();
  });

  it("with the consumer, B is FREE to move a DIFFERENT workload A is not moving", async () => {
    const map = seedSharedMapWithAInFlight();
    const b = makeSelfHolderController("B", ["A"], map, now, /* withConsumer */ true);

    // model-b is NOT in A's published in-flight set -> the guard is workload-scoped
    // and must not over-block.
    const proposal: MoveProposal | null = await b.evaluateMove(
      { ...workload, name: "model-b", node: "B" },
      sourceSnapshot("B"),
    );

    expect(proposal).not.toBeNull();
    expect(proposal?.workload).toBe("model-b");
  });

  it("mutation-check: a peer's STALE in-flight move does not block (consumer only honors FRESH peers)", async () => {
    const map: SharedMap = {};
    publish(map, "A", nowMs - 1_000, { candidate: "A", term: 4, eligible: true, seq: 1 });
    publish(map, "B", nowMs - 1_000, { candidate: "B", term: 4, eligible: true, seq: 1 });
    // A's snapshot is STALE (older than staleAfterMs): a dead/partitioned peer.
    // Its in-flight publication must NOT freeze B forever.
    const aStale = map["A"];
    if (!aStale) throw new Error("seed A first");
    map["A"] = {
      ...aStale,
      ts: new Date(nowMs - STALE_AFTER_MS - 1_000).toISOString(),
      inFlightMoves: [
        {
          workload: "model-a",
          fromNode: "src",
          toNode: "dest",
          proposalId: "move-model-a-1",
          deployedAtMs: nowMs - STALE_AFTER_MS - 1_500,
        },
      ],
    };

    const b = makeSelfHolderController("B", ["A"], map, now, /* withConsumer */ true);
    const proposal: MoveProposal | null = await b.evaluateMove(
      { ...workload, name: "model-a", node: "B" },
      sourceSnapshot("B"),
    );

    // Stale peer -> not honored -> B may proceed (no permanent block on a dead peer).
    expect(proposal).not.toBeNull();
    expect(proposal?.workload).toBe("model-a");
  });

  it("single-eligible no-op: with no peer publishing in-flight moves, behavior is unchanged", async () => {
    const map: SharedMap = {};
    // Prod-today shape: ONE eligible node (A) plus an ineligible destination peer
    // (dest) that publishes NO in-flight moves. A still has a viable destination,
    // so the only question is whether the consumer guard suppresses the move.
    publish(map, "A", nowMs - 1_000, { candidate: "A", term: 4, eligible: true, seq: 1 });
    publish(map, "dest", nowMs - 1_000, { candidate: "dest", term: 4, eligible: false, seq: 1 });

    const a = makeSelfHolderController("A", ["dest"], map, now, /* withConsumer */ true);
    const proposal: MoveProposal | null = await a.evaluateMove(
      { ...workload, name: "model-a", node: "A" },
      sourceSnapshot("A"),
    );

    // No peer inFlightMoves -> the consumer guard is a no-op -> the move proceeds
    // exactly as today (single-eligible fleet behavior is byte-preserved).
    expect(proposal).not.toBeNull();
    expect(proposal?.workload).toBe("model-a");
  });
});
