// Part of #275, DF-02: eviction intent recorded as a fenced DF-03 operation;
// dual-written beside the manifest markers.
import { randomUUID } from "node:crypto";

import type { ResidencyOperationOutcome, ResidencyOperationStore } from "./store.js";

/**
 * Opt-in and inert when the option is absent: an apply that does not pass it
 * records nothing in the store.
 *
 * Single owner per victim is enforced through the store's unique nonterminal
 * `evict:<victim>` row; the manifest markers are still written alongside, so a
 * crash between the two is recoverable from either side.
 *
 * COUPLING: `evict:` rows share the store-wide desiredRevision watermark, the
 * single authority and the fence with profile switches. `desiredRevision` must
 * come from the same revision space as profile switches; a higher revision
 * taken from another space would make lower-revision profile switches fail as
 * stale-revision.
 *
 * The caller must claim under the profile path's ownerId, or apply-profile's
 * foreign-owner check reports busy.
 *
 * A claimOwnership (fence bump) between begin and finish makes finishOperation
 * fail with stale-fence. That leaves the row nonterminal, and it blocks later
 * evictions of that victim until agent boot recovery finishes the stale row
 * `unknown` (Part of #517).
 *
 * Known edge cases:
 * - Rollback is not atomic across the two records. If clearEvictionMarkers
 *   cannot save the victim's manifest, the store row is still finished as
 *   failed (`rolled-back:`) while the manifest's evicted-by marker remains,
 *   so the marker alone holds the victim until its grace window lapses.
 * - beginOperation is idempotent on operationId. A deterministic
 *   operationIdFor (as the tests inject) makes two applies of the same
 *   replacement and victim replay the same row, so both would share
 *   ownership of it. The default id carries a randomUUID, so each apply
 *   opens its own row and the second is refused as reservation-conflict.
 */
export type EvictionOperationOpts = {
  store: Pick<ResidencyOperationStore, "beginOperation" | "finishOperation">;
  fenceToken: number;
  desiredRevision: number;
  nodeBudgetGiB?: number;
  nowMs?: () => number;
  operationIdFor?: (victim: string) => string;
};

export function evictionOperationKey(victim: string): string {
  return `evict:${victim}`;
}

export type BegunEvictionOps = Map<string, { operationId: string; version: number }>;

export function beginEvictionOperations(
  opts: EvictionOperationOpts,
  replacementName: string,
  victims: readonly string[],
): { ok: true; ops: BegunEvictionOps } | { ok: false; victim: string; reason: string } {
  const ops: BegunEvictionOps = new Map();
  const nowMs = (opts.nowMs ?? Date.now)();
  for (const victim of victims) {
    const operationId =
      opts.operationIdFor?.(victim) ?? `evict:${victim}:${replacementName}:${randomUUID()}`;
    const input = {
      fenceToken: opts.fenceToken,
      operationId,
      model: evictionOperationKey(victim),
      targetState: `evicted-by:${replacementName}`,
      desiredRevision: opts.desiredRevision,
      reservationGiB: 0,
      ...(opts.nodeBudgetGiB !== undefined ? { nodeBudgetGiB: opts.nodeBudgetGiB } : {}),
      nowMs,
    };
    try {
      const begun = opts.store.beginOperation(input);
      if (!begun.ok) {
        finishEvictionOperations(opts, ops, "cancelled", `refused: '${victim}' ${begun.reason}`);
        return { ok: false, victim, reason: begun.reason };
      }
      ops.set(victim, { operationId: begun.record.operationId, version: begun.record.version });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finishEvictionOperations(opts, ops, "cancelled", `refused: '${victim}' ${reason}`);
      return { ok: false, victim, reason };
    }
  }
  return { ok: true, ops };
}

export function finishEvictionOperations(
  opts: EvictionOperationOpts,
  ops: BegunEvictionOps,
  outcome: ResidencyOperationOutcome,
  detail: string,
): void {
  const nowMs = (opts.nowMs ?? Date.now)();
  for (const op of ops.values()) {
    try {
      opts.store.finishOperation({
        fenceToken: opts.fenceToken,
        operationId: op.operationId,
        expectedVersion: op.version,
        nowMs,
        outcome,
        detail,
      });
    } catch {
      // An unfinished row stays nonterminal, which is the recoverable crash
      // state; never let a finish failure escape into the apply.
    }
  }
}
