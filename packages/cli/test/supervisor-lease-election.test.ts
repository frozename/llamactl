import {
  type FleetSnapshotEntry,
  getLatestPerNode,
  openAggregatorDb,
  type SnapshotRow,
  writeSnapshot,
} from "@llamactl/fleet-supervisor";
import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import { makeGetLeaseHolder } from "../src/commands/supervisor.js";
import * as fs from "../src/safe-fs.js";

const STALE_AFTER_MS = 90_000;
const NOW = 1_700_000_000_000;

/** A peer snapshot exactly as a node's own aggregator stores it in cluster.db:
 *  PEER rows only (listPeers excludes self), every peer eligible:false (no
 *  LLAMACTL_FLEET_MOVE_ENABLED on them). */
function peerRow(
  node: string,
  eligible: boolean,
  term: number,
  tsMs: number,
  receivedAtMs = tsMs,
): SnapshotRow {
  const ts = new Date(tsMs).toISOString();
  const receivedAt = new Date(receivedAtMs).toISOString();
  const snapshot: FleetSnapshotEntry = {
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
    lease: { candidate: node, term, eligible, seq: 1 },
  };
  return { node, ts, receivedAt, snapshot };
}

describe("makeGetLeaseHolder — real production wiring over a self-excluded view", () => {
  // The decisive regression test. The local cluster.db NEVER contains the self
  // row (listPeers filters node.name !== localNodeName), so getLatestPerNode
  // yields a self-EXCLUDED set of ineligible peers. Before the fix this elected
  // null and froze the one migration-enabled node. After the fix the wiring
  // injects self's own lease intent, so an eligible self elects itself.
  test("REGRESSION: single eligible self over a self-EXCLUDED cluster.db elects SELF, not null", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llamactl-lease-db-"));
    const dbPath = path.join(tmp, "cluster.db");
    const selfNode = "m4-pro";
    try {
      const db = openAggregatorDb(dbPath);
      // Only peer rows, all ineligible — exactly the prod cluster.db shape.
      writeSnapshot(db, "m2-mini", peerRow("m2-mini", false, 4, NOW - 1_000).snapshot);
      writeSnapshot(db, "studio", peerRow("studio", false, 4, NOW - 1_000).snapshot);
      db.close();

      const getLeaseHolder = makeGetLeaseHolder({
        selfNode,
        selfLeaseTerm: 7,
        selfEligible: true,
        leaseMode: "derived",
        now: () => NOW,
        // Use the REAL getLatestPerNode over this self-excluded db (the exact
        // prod path; only the db path is redirected away from $HOME).
        loadPeerRows: (freshAfterTs) => {
          const d = openAggregatorDb(dbPath);
          try {
            return getLatestPerNode(d, { freshAfterTs });
          } finally {
            d.close();
          }
        },
      });

      expect(getLeaseHolder()).toBe(selfNode);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an INELIGIBLE self over the same self-excluded view elects null (never always-self)", () => {
    const getLeaseHolder = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: false,
      leaseMode: "derived",
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", false, 4, NOW - 1_000)],
    });
    expect(getLeaseHolder()).toBeNull();
  });

  test("a lower-term eligible PEER wins over self (self-inclusive election still defers correctly)", () => {
    const getLeaseHolder = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 9,
      selfEligible: true,
      leaseMode: "derived",
      now: () => NOW,
      // A steadier eligible peer (lower term) is present in the replicated view.
      loadPeerRows: () => [peerRow("m2-mini", true, 2, NOW - 1_000)],
    });
    expect(getLeaseHolder()).toBe("m2-mini");
  });

  test("lease liveness uses received_at so future-clock dead peers drop and slow-clock live peers stay", () => {
    const futureClockDeadPeer = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 9,
      selfEligible: true,
      leaseMode: "derived",
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", true, 2, NOW + 60_000, NOW - STALE_AFTER_MS - 1_000)],
    });
    expect(futureClockDeadPeer()).toBe("m4-pro");

    const slowClockLivePeer = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 9,
      selfEligible: true,
      leaseMode: "derived",
      now: () => NOW,
      loadPeerRows: () => [peerRow("m2-mini", true, 2, NOW - STALE_AFTER_MS - 1_000, NOW - 1_000)],
    });
    expect(slowClockLivePeer()).toBe("m2-mini");
  });

  test("aggregator down/empty + eligible self => SELF synchronously (cold cache never spuriously null)", () => {
    const getLeaseHolder = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: true,
      leaseMode: "derived",
      now: () => NOW,
      loadPeerRows: () => null, // aggregator down
      directFetch: () => Promise.resolve([]), // cold cache
    });
    expect(getLeaseHolder()).toBe("m4-pro");
  });

  test("kill switch: legacy-self always returns self (instant rollback)", () => {
    const getLeaseHolder = makeGetLeaseHolder({
      selfNode: "m4-pro",
      selfLeaseTerm: 7,
      selfEligible: false, // even ineligible: legacy-self ignores the election
      leaseMode: "legacy-self",
      loadPeerRows: () => null,
    });
    expect(getLeaseHolder()).toBe("m4-pro");
  });

  test("default leaseMode is 'derived' (kill switch absent)", () => {
    const prev = process.env["LLAMACTL_FLEET_LEASE_MODE"];
    delete process.env["LLAMACTL_FLEET_LEASE_MODE"];
    try {
      const getLeaseHolder = makeGetLeaseHolder({
        selfNode: "m4-pro",
        selfLeaseTerm: 7,
        selfEligible: true,
        now: () => NOW,
        loadPeerRows: () => [], // empty (not null): aggregator up but no peers
        directFetch: () => Promise.resolve([]),
      });
      // derived + eligible self over an empty peer view => self (not legacy-self
      // bypass, but the derived election still names self via the injected row).
      expect(getLeaseHolder()).toBe("m4-pro");
    } finally {
      if (prev === undefined) delete process.env["LLAMACTL_FLEET_LEASE_MODE"];
      else process.env["LLAMACTL_FLEET_LEASE_MODE"] = prev;
    }
  });
});
