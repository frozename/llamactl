/**
 * #281 DF-08: hypothetical queue probe for a declared cold-model pin. Reports
 * what the shared RequestQueuePolicy WOULD do with this request. It never
 * queues, waits, schedules or loads; the probe is cancelled before returning,
 * so policy state is unchanged. Not checked: per-principal share (the caller
 * identity is unknown here, so the probe uses a unique principal),
 * promptTokens (no tokenizer, passed as 0), and deadline (none).
 */
import type { DeclaredModelEntryV1 } from "../routing/catalog.js";
import type { QueueRefuseReason, RequestQueuePolicy } from "./queue-policy.js";

/**
 * The verdict for a hypothetical cold-pin request. `queueDepth` is the queue
 * depth including the probe, not the schedule order.
 */
export type ColdPinQueueProbe =
  | { kind: "would_queue"; queueDepth: number; maxWaitMs: number }
  | {
      kind: "would_refuse";
      reason: "NotLoadable" | QueueRefuseReason;
      retryAfterMs: number | null;
    };

export interface ColdPinQueueProbeConfig {
  policy: RequestQueuePolicy;
  maxQueueWaitMs: number;
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
  const { entry, policy, probeId, bytes, maxCompletionTokens, maxQueueWaitMs } = input;
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
  if (result.kind === "queued" || result.kind === "duplicate") {
    try {
      const queueDepth = policy.snapshot().queued;
      return { kind: "would_queue", queueDepth, maxWaitMs: maxQueueWaitMs };
    } finally {
      policy.cancel(requestId);
    }
  }
  return { kind: "would_refuse", reason: result.reason, retryAfterMs: result.retryAfterMs };
}
