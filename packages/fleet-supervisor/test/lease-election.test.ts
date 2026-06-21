import { describe, expect, it } from "bun:test";

import type { SnapshotRow } from "../src/aggregator-db.js";
import type { LeaseIntent } from "../src/lease-election.js";
import type { FleetSnapshotEntry } from "../src/types.js";

import { electLeaseHolder } from "../src/lease-election.js";

const NOW = 1_700_000_000_000;
const STALE_AFTER_MS = 90_000;

/** Build a SnapshotRow whose snapshot carries (or omits) a lease intent.
 *  `tsOffsetMs` is added to NOW to age the row (negative = older). */
function row(node: string, tsOffsetMs: number, lease: LeaseIntent | undefined): SnapshotRow {
  const ts = new Date(NOW + tsOffsetMs).toISOString();
  const snapshot: FleetSnapshotEntry = {
    kind: "fleet-snapshot",
    ts,
    node,
    node_mem: {
      free_mb: 4096,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [],
    ...(lease ? { lease } : {}),
  };
  return { node, ts, snapshot };
}

function intent(candidate: string, term: number, eligible: boolean, seq = 1): LeaseIntent {
  return { candidate, term, eligible, seq };
}

describe("electLeaseHolder", () => {
  it("F1: two eligible fresh nodes -> single holder = lowest (term, candidate)", () => {
    const rows = [
      row("m4pro", -1_000, intent("m4pro", 5, true)),
      row("m2mini", -1_000, intent("m2mini", 5, true)),
    ];
    // Same term -> candidate string tiebreak: 'm2mini' < 'm4pro'.
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m2mini");
  });

  it("F1b: lower term wins regardless of candidate ordering", () => {
    const rows = [
      row("m2mini", -1_000, intent("m2mini", 9, true)),
      row("m4pro", -1_000, intent("m4pro", 2, true)),
    ];
    // 'm4pro' sorts after 'm2mini' but its term is lower -> it holds.
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });

  it("F5: clock skew within Δ < staleAfterMs leaves the election unchanged", () => {
    const skew = STALE_AFTER_MS - 5_000; // still fresh
    const rows = [
      // Two nodes with different (but still-fresh) ts offsets — skew does not
      // change selection because it compares self-minted (term, candidate).
      row("m2mini", -skew, intent("m2mini", 5, true)),
      row("m4pro", -5_000, intent("m4pro", 5, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m2mini");
  });

  it("F5b: a stale-ts (expired) peer is dropped as dead", () => {
    const rows = [
      // m2mini would win on (term, candidate) but its ts is past staleAfterMs.
      row("m2mini", -(STALE_AFTER_MS + 1), intent("m2mini", 1, true)),
      row("m4pro", -1_000, intent("m4pro", 5, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });

  it("F6: empty rows -> null (no holder, NOT self)", () => {
    expect(electLeaseHolder([], NOW, STALE_AFTER_MS)).toBeNull();
  });

  it("F6b: all candidates ineligible -> null", () => {
    const rows = [
      row("m2mini", -1_000, intent("m2mini", 5, false)),
      row("m4pro", -1_000, intent("m4pro", 5, false)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBeNull();
  });

  it("F6c: all candidates stale -> null", () => {
    const rows = [
      row("m2mini", -(STALE_AFTER_MS + 1), intent("m2mini", 5, true)),
      row("m4pro", -(STALE_AFTER_MS + 1), intent("m4pro", 5, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBeNull();
  });

  it("F7: term flap -> higher-term candidate loses to lower-term", () => {
    const rows = [
      // m2mini restarted (term bumped to 8); m4pro has steadier lower term 3.
      row("m2mini", -1_000, intent("m2mini", 8, true)),
      row("m4pro", -1_000, intent("m4pro", 3, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });

  it("F8: old peer without a lease field is an ineligible candidate, never holder", () => {
    const rows = [
      row("m2mini", -1_000, undefined), // legacy peer, no lease
      row("m4pro", -1_000, intent("m4pro", 5, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });

  it("F8b: a fleet of only legacy (no-lease) peers elects nobody", () => {
    const rows = [row("m2mini", -1_000, undefined), row("m4pro", -1_000, undefined)];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBeNull();
  });

  it("rejects a non-finite term (guards against corrupt peer rows)", () => {
    const rows = [
      row("m2mini", -1_000, intent("m2mini", Number.NaN, true)),
      row("m4pro", -1_000, intent("m4pro", 5, true)),
    ];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });

  it("single eligible fresh node elects itself (prod single-writer case)", () => {
    const rows = [row("m4pro", -1_000, intent("m4pro", 7, true))];
    expect(electLeaseHolder(rows, NOW, STALE_AFTER_MS)).toBe("m4pro");
  });
});
