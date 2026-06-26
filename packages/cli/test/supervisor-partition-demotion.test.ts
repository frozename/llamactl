import type { SnapshotRow } from "@llamactl/fleet-supervisor";

import { describe, expect, test } from "bun:test";

import { makeCanSeeFreshDestinationPeer } from "../src/commands/supervisor.js";

const STALE_AFTER_MS = 90_000;
const NOW = 1_700_000_000_000;

/** A peer row as a node's own aggregator stores it (PEER rows only — listPeers
 *  excludes self). Eligibility is IRRELEVANT to the partition predicate: any
 *  fresh peer is a candidate move DESTINATION. */
function peerRow(node: string, tsMs: number): SnapshotRow {
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
      lease: { candidate: node, term: 4, eligible: false, seq: 1 },
    },
  };
}

describe("makeCanSeeFreshDestinationPeer — partition self-demotion predicate (design §2)", () => {
  test("HEALTHY: a fresh (ineligible) destination peer is visible => TRUE (no demotion in single-eligible prod)", () => {
    const canSee = makeCanSeeFreshDestinationPeer({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      // The single-eligible prod shape: self is the only eligible node, but its
      // ineligible peer is fresh and a valid destination.
      loadPeerRows: () => [peerRow("m2-mini", NOW - 1_000)],
    });
    expect(canSee()).toBe(true);
  });

  test("PARTITION (aggregator up, all peers stale): no fresh peer => FALSE (holder self-demotes)", () => {
    const canSee = makeCanSeeFreshDestinationPeer({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      // A row exists but its ts is older than STALE_AFTER_MS — a frozen/dead peer.
      loadPeerRows: () => [peerRow("m2-mini", NOW - STALE_AFTER_MS - 1_000)],
    });
    expect(canSee()).toBe(false);
  });

  test("PARTITION (aggregator up, zero peers): empty view => FALSE", () => {
    const canSee = makeCanSeeFreshDestinationPeer({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => [],
      directFetch: () => Promise.resolve([]),
    });
    expect(canSee()).toBe(false);
  });

  test("PARTITION (aggregator down, cold direct cache): no rows => FALSE (never spuriously true)", () => {
    const canSee = makeCanSeeFreshDestinationPeer({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      now: () => NOW,
      loadPeerRows: () => null, // aggregator down
      directFetch: () => Promise.resolve([]), // cold cache, no peers reachable
    });
    expect(canSee()).toBe(false);
  });
});
