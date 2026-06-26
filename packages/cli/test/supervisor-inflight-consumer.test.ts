import type { SnapshotRow } from "@llamactl/fleet-supervisor";

import { describe, expect, test } from "bun:test";

import { makeIsPeerMovingWorkload } from "../src/commands/supervisor.js";

const STALE_AFTER_MS = 90_000;
const NOW = 1_700_000_000_000;

type PublishedInFlightMove = {
  workload: string;
  fromNode: string;
  toNode: string;
  proposalId: string;
  deployedAtMs: number;
};

/** A PEER row as a node's own self-excluded aggregator stores it, optionally
 *  carrying that peer's published in-flight moves. */
function peerRow(node: string, tsMs: number, inFlightMoves?: PublishedInFlightMove[]): SnapshotRow {
  const ts = new Date(tsMs).toISOString();
  return {
    node,
    ts,
    receivedAt: ts,
    snapshot: {
      kind: "fleet-snapshot",
      ts,
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
      lease: { candidate: node, term: 4, eligible: true, seq: 1 },
      ...(inFlightMoves ? { inFlightMoves } : {}),
    },
  };
}

const inFlight = (workload: string): PublishedInFlightMove[] => [
  {
    workload,
    fromNode: "src",
    toNode: "dest",
    proposalId: `move-${workload}-1`,
    deployedAtMs: NOW - 500,
  },
];

describe("makeIsPeerMovingWorkload — cross-node in-flight-move consumer (design §4)", () => {
  test("a FRESH peer mid-moving W => TRUE for W (honor the peer's in-flight move)", () => {
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", NOW - 1_000, inFlight("model-a"))],
    });
    expect(isMoving("model-a")).toBe(true);
  });

  test("workload-scoped: a peer mid-moving W does NOT block a DIFFERENT workload", () => {
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", NOW - 1_000, inFlight("model-a"))],
    });
    expect(isMoving("model-b")).toBe(false);
  });

  test("STALE peer's in-flight publication is dropped => FALSE (a dead peer cannot freeze W forever)", () => {
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", NOW - STALE_AFTER_MS - 1_000, inFlight("model-a"))],
    });
    expect(isMoving("model-a")).toBe(false);
  });

  test("single-eligible no-op: a fresh peer publishing NO in-flight moves => FALSE for any workload", () => {
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      // Prod-today shape: peers are present and fresh but publish no in-flight moves.
      loadPeerRows: () => [peerRow("m2-mini", NOW - 1_000)],
    });
    expect(isMoving("model-a")).toBe(false);
  });

  test("aggregator down + cold direct cache => FALSE (never spuriously blocks)", () => {
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => null, // aggregator down
      directFetch: () => Promise.resolve([]), // cold cache, no peers reachable
    });
    expect(isMoving("model-a")).toBe(false);
  });

  test("aggregator down, direct fallback later surfaces a peer's in-flight move => TRUE on the next call", async () => {
    let resolveFetch: (rows: SnapshotRow[]) => void = () => undefined;
    const fetched = new Promise<SnapshotRow[]>((resolve) => {
      resolveFetch = resolve;
    });
    const isMoving = makeIsPeerMovingWorkload({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => null, // aggregator down -> direct fallback path
      directFetch: () => fetched,
    });

    // First call: cold cache, fallback kicked but not yet resolved.
    expect(isMoving("model-a")).toBe(false);

    // Direct peer pull resolves with the peer mid-moving model-a.
    resolveFetch([peerRow("m2-mini", NOW - 1_000, inFlight("model-a"))]);
    await fetched;

    // Next call sees the cached fresh peer rows -> honors the in-flight move.
    expect(isMoving("model-a")).toBe(true);
  });
});
