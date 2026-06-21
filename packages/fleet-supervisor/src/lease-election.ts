import type { SnapshotRow } from "./aggregator-db.js";

/**
 * Self-published lease intent carried in a node's FleetSnapshotEntry. Every node
 * mints its own intent; the holder is a deterministic function of the replicated
 * intents (see electLeaseHolder), so there is no contested write and no shared
 * store. See docs/notes/2026-06-20-scheduler-lease-derived-election-design.md §1.
 */
export interface LeaseIntent {
  /** This node's id. */
  candidate: string;
  /** Monotonic, persisted locally; ++ only on (re)start. Lower = steadier tenure. */
  term: number;
  /** LLAMACTL_FLEET_MOVE_ENABLED === "1". Ineligible candidates never hold. */
  eligible: boolean;
  /** Per-tick monotonic liveness/freshness proof. */
  seq: number;
}

/** Bracket-safe optional read of a node's lease intent off its snapshot. */
function readLeaseIntent(row: SnapshotRow): LeaseIntent | undefined {
  const snapshot = row.snapshot as { lease?: unknown };
  const lease = snapshot.lease;
  if (typeof lease !== "object" || lease === null) return undefined;
  const candidate = (lease as { candidate?: unknown }).candidate;
  const term = (lease as { term?: unknown }).term;
  const eligible = (lease as { eligible?: unknown }).eligible;
  const seq = (lease as { seq?: unknown }).seq;
  if (typeof candidate !== "string") return undefined;
  if (typeof term !== "number" || !Number.isFinite(term)) return undefined;
  if (typeof eligible !== "boolean") return undefined;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return undefined;
  return { candidate, term, eligible, seq };
}

/**
 * Deterministic leader election over the replicated peer snapshots. Pure: no fs,
 * no clock read, no env — `now` and `staleAfterMs` are injected.
 *
 * 1. keep rows whose lease is present AND eligible AND fresh
 *    (`now - Date.parse(ts) < staleAfterMs`);
 * 2. holder = candidate with the lowest `(term, candidate)` tuple
 *    (term numeric ascending; candidate string ascending as tiebreak);
 * 3. empty kept-set => null (no holder = safe; never "two holders").
 *
 * Skew-free: selection compares self-minted (term, candidate) values, never a
 * cross-node clock subtraction. Liveness alone uses `ts`, always as local-now vs
 * peer-ts.
 */
export function electLeaseHolder(
  peerSnapshots: SnapshotRow[],
  now: number,
  staleAfterMs: number,
): string | null {
  let bestCandidate: string | null = null;
  let bestTerm = Number.POSITIVE_INFINITY;

  for (const row of peerSnapshots) {
    const lease = readLeaseIntent(row);
    if (!lease?.eligible) continue;

    const tsMs = Date.parse(row.ts);
    if (!Number.isFinite(tsMs)) continue;
    if (now - tsMs >= staleAfterMs) continue; // stale -> dead peer, dropped

    if (
      lease.term < bestTerm ||
      (lease.term === bestTerm && (bestCandidate === null || lease.candidate < bestCandidate))
    ) {
      bestTerm = lease.term;
      bestCandidate = lease.candidate;
    }
  }

  return bestCandidate;
}
