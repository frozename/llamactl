/**
 * #281 DF-08: hypothetical queue probe for a declared cold-model pin. Reports
 * what the shared RequestQueuePolicy WOULD do with this request. It never
 * queues, waits, schedules or loads, so policy state is unchanged: when the
 * probe itself enqueues the entry it cancels that entry before returning, and
 * when the probe's id collides with a pre-existing queue entry it refuses
 * without touching that entry (a caller-supplied probeId is not authoritative
 * over state the probe did not create). Not checked: per-principal share (the
 * caller identity is unknown here, so the probe uses a unique principal),
 * promptTokens (no tokenizer, passed as 0), and deadline (none).
 */
import type { DeclaredModelEntryV1 } from "../routing/catalog.js";
import type { QueueRefuseReason, RequestQueuePolicy } from "./queue-policy.js";

/**
 * Refuse reasons for the probe. Beyond the policy's own reasons it reports
 * `NotLoadable` (the declared entry can never load) and `RequestIdConflict`
 * (the probe's id matched an entry the probe did not create, so the probe
 * cannot report a verdict without disturbing that entry).
 */
export type ColdPinProbeRefuseReason = "NotLoadable" | "RequestIdConflict" | QueueRefuseReason;

/**
 * The verdict for a hypothetical cold-pin request. `queueDepth` is the queue
 * depth including the probe, not the schedule order.
 */
export type ColdPinQueueProbe =
  | { kind: "would_queue"; queueDepth: number; maxWaitMs: number }
  | {
      kind: "would_refuse";
      reason: ColdPinProbeRefuseReason;
      retryAfterMs: number | null;
    };

export interface ColdPinQueueProbeConfig {
  policy: RequestQueuePolicy;
}

export interface ColdPinQueueProbeInput extends ColdPinQueueProbeConfig {
  entry: DeclaredModelEntryV1;
  probeId: string;
  bytes: number;
  maxCompletionTokens: number;
}

export function isColdPinLoadable(entry: DeclaredModelEntryV1): boolean {
  return entry.state === "cold" && entry.autoLoadEligible;
}

export function probeColdPinQueue(input: ColdPinQueueProbeInput): ColdPinQueueProbe {
  const { entry, policy, probeId, bytes, maxCompletionTokens } = input;
  if (!isColdPinLoadable(entry)) {
    return { kind: "would_refuse", reason: "NotLoadable", retryAfterMs: null };
  }
  const requestId = `cold-pin-probe:${probeId}`;
  // DeclaredModelEntryV1 has no revision, so the workload is the revision key.
  const result = policy.enqueue({
    requestId,
    principal: requestId,
    priority: "interactive",
    model: { name: entry.id, revision: entry.workload },
    bytes,
    promptTokens: 0,
    maxCompletionTokens,
    deadlineMs: Number.POSITIVE_INFINITY,
  });
  if (result.kind === "queued") {
    try {
      const queueDepth = policy.snapshot().queued;
      const maxWaitMs = policy.queueLimits().maxQueueWaitMs;
      return { kind: "would_queue", queueDepth, maxWaitMs };
    } finally {
      policy.cancel(requestId);
    }
  }
  if (result.kind === "duplicate") {
    // The id belongs to an entry the probe never created, so it must not be
    // cancelled and no queue verdict can be reported without disturbing it.
    return { kind: "would_refuse", reason: "RequestIdConflict", retryAfterMs: null };
  }
  return { kind: "would_refuse", reason: result.reason, retryAfterMs: result.retryAfterMs };
}
