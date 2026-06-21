import { omitUndefined } from "@llamactl/core/object";
// Completion-based liveness probe. A long-lived server can keep /health green
// while completions degrade to 5xx/timeout (the granite + diffusion "wedge":
// growing per-request bookkeeping). probeWorkload alone never sees this, so a
// repeated 5xx-despite-health-200 must be detected here and turned into a
// restart proposal by the policy layer.

import type { SlotProgressReading } from "./types.js";

import { InvalidEndpointError, validateProbeEndpoint } from "./workload-probe.js";

export interface CompletionProbeConfig {
  /** Path of the chat-completions endpoint. Default "/v1/chat/completions". */
  path: string;
  prompt: string;
  /** Explicit model id; falls back to the workload's first served model, then "default". */
  model?: string;
  maxTokens: number;
  timeoutMs: number;
  /** Run the probe every N supervisor ticks (load control for single-slot servers). */
  everyNTicks: number;
  k?: number;
  maxTimeoutMs?: number;
  minSamples?: number;
  latencyRingSize?: number;
  busyStallChecks?: number;
  minStallIntervalMs?: number;
}

export type CompletionProbeClassification = "ok" | "wedge" | "misconfigured";

export interface CompletionProbeOptions {
  config: CompletionProbeConfig;
  /** Served models from the same-tick health probe, used to pick a default model. */
  models?: string[];
  fetch?: typeof globalThis.fetch;
  priorConsecutiveFailures?: number;
  allowPublicEndpoints?: boolean;
}

export interface CompletionProbeResult {
  ok: boolean;
  /** HTTP status; null on timeout / network error. */
  status: number | null;
  latencyMs: number;
  classification: CompletionProbeClassification;
  /** Wedge counter after applying this result (ok→0, wedge→+1, misconfigured→unchanged). */
  consecutiveFailures: number;
}

export interface BusyGuardProgress {
  nPast: number | null;
  nDecoded: number | null;
  stallChecks: number;
  /** Wall-clock ms of the last observed advance/activity; the stall window is
   *  measured from here so two fast polls inside one prompt-eval batch gap can't
   *  both count as a stall. */
  lastAdvanceAt: number;
}

export type BusyGuardReason = "busy" | "stall-below-threshold" | "wedge" | "idle-wedge";

export interface BusyGuardInput {
  classification: CompletionProbeClassification;
  prior: number;
  reading: SlotProgressReading;
  lastProgress: BusyGuardProgress | undefined;
  busyStallChecks: number;
  /** Wall-clock ms now (Date.now()), used to gate the stall window. */
  now: number;
  /** Minimum elapsed wall-clock since the last advance before a stalled probe may
   *  increment the stall counter. Must exceed one prompt-eval batch interval so a
   *  healthy mid-prompt-eval flat read is never mistaken for a wedge. */
  minStallIntervalMs: number;
}

export interface BusyGuardResult {
  consecutiveFailures: number;
  reason?: BusyGuardReason;
  nextProgress?: BusyGuardProgress;
}

// 2xx is healthy. 4xx is a configuration error (wrong model/path/auth) — recycling
// won't fix it, so it must never drive a restart. Everything else (5xx, and the
// anomalous 1xx/3xx on a POST completion) is a wedge signal.
function classify(status: number): CompletionProbeClassification {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500) return "misconfigured";
  return "wedge";
}

function nextFailures(prior: number, classification: CompletionProbeClassification): number {
  if (classification === "ok") return 0;
  if (classification === "wedge") return prior + 1;
  return prior;
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function effectiveTimeout(input: {
  samples: number[];
  base: number;
  k: number;
  max: number;
  minSamples: number;
}): number {
  const { samples, base, k, max, minSamples } = input;
  if (samples.length < minSamples) return base;
  // base is the guaranteed floor (max() is the OUTER op): even if a misconfigured
  // base exceeds max, the probe never tightens below its configured base timeout.
  return Math.max(base, Math.min(max, percentile(samples, 0.95) * k));
}

export function pushLatencySample(ring: number[], value: number, cap: number): void {
  ring.push(value);
  while (ring.length > cap) {
    ring.shift();
  }
}

function maxProgress(reading: SlotProgressReading): {
  processing: boolean;
  ambiguousProcessing: boolean;
  nPast: number | null;
  nDecoded: number | null;
} {
  let processing = false;
  let ambiguousProcessing = false;
  let nPast: number | null = null;
  let nDecoded: number | null = null;
  for (const slot of reading.slots) {
    if (slot.processing === null) ambiguousProcessing = true;
    if (slot.processing !== true) continue;
    processing = true;
    if (slot.nPast !== null) nPast = Math.max(nPast ?? slot.nPast, slot.nPast);
    if (slot.nDecoded !== null) nDecoded = Math.max(nDecoded ?? slot.nDecoded, slot.nDecoded);
  }
  return { processing, ambiguousProcessing, nPast, nDecoded };
}

type ProgressCounters = { nPast: number | null; nDecoded: number | null };

// Mechanism A treats EITHER counter advancing as progress, so a partial wedge that
// keeps one counter ticking (e.g. nPast++ each poll) while the other is frozen and no
// tokens reach the client is NOT caught here — mechanism D (adaptive timeout) is the
// backstop for that mode.
function advanced(current: ProgressCounters, last: ProgressCounters): boolean {
  return (
    (current.nPast !== null && last.nPast !== null && current.nPast > last.nPast) ||
    (current.nDecoded !== null && last.nDecoded !== null && current.nDecoded > last.nDecoded)
  );
}

function lowered(current: ProgressCounters, last: ProgressCounters): boolean {
  return (
    (current.nPast !== null && last.nPast !== null && current.nPast < last.nPast) ||
    (current.nDecoded !== null && last.nDecoded !== null && current.nDecoded < last.nDecoded)
  );
}

function ambiguous(current: ProgressCounters, last: ProgressCounters): boolean {
  return (
    (current.nPast === null && last.nPast !== null) ||
    (current.nDecoded === null && last.nDecoded !== null)
  );
}

export function applyBusyGuard(input: BusyGuardInput): BusyGuardResult {
  const { classification, prior, reading, lastProgress, busyStallChecks, now, minStallIntervalMs } =
    input;
  // Non-wedge classifications return the caller-supplied `prior` unchanged. The
  // ok->0 reset is the loop caller's responsibility (loop-helpers.ts), not this
  // reducer's — the two paths diverge deliberately so the guard only ever decides
  // the wedge-vs-busy question.
  if (classification !== "wedge") {
    return {
      consecutiveFailures: prior,
      ...omitUndefined({ nextProgress: lastProgress }),
    };
  }
  if (!reading.available) {
    return {
      consecutiveFailures: prior,
      ...omitUndefined({ nextProgress: lastProgress }),
    };
  }

  const progress = maxProgress(reading);
  if (!progress.processing) {
    if (progress.ambiguousProcessing) {
      return {
        consecutiveFailures: prior,
        ...omitUndefined({ nextProgress: lastProgress }),
      };
    }
    return {
      consecutiveFailures: prior + 1,
      reason: "idle-wedge",
      ...omitUndefined({ nextProgress: lastProgress }),
    };
  }

  const observed = { nPast: progress.nPast, nDecoded: progress.nDecoded };
  // First wedge while processing, or real activity (advance / lower) resets stall state.
  if (!lastProgress || advanced(observed, lastProgress) || lowered(observed, lastProgress)) {
    return {
      consecutiveFailures: prior,
      reason: "busy",
      nextProgress: { ...observed, stallChecks: 0, lastAdvanceAt: now },
    };
  }

  // Counter dropped from non-null to null: hold stall state without resetting it.
  // A flapping /slots counter must not allow a wedged server to evade detection by
  // intermittently dropping the counter and resetting the stall accumulation.
  if (ambiguous(observed, lastProgress)) {
    return {
      consecutiveFailures: prior,
      reason: "busy",
      nextProgress: {
        ...observed,
        stallChecks: lastProgress.stallChecks,
        lastAdvanceAt: lastProgress.lastAdvanceAt,
      },
    };
  }

  // Stalled: processing but counters flat vs the last reading. The stall counter may
  // only advance once at least minStallIntervalMs of wall clock has elapsed since the
  // last real advance — long enough to span a healthy prompt-eval inter-batch gap,
  // where nPast/nDecoded legitimately read flat. Two fast polls in one gap therefore
  // do NOT both count (the false-recycle fix). lastAdvanceAt is carried, never reset,
  // so the window keeps accumulating across stalled probes.
  if (now - lastProgress.lastAdvanceAt < minStallIntervalMs) {
    return {
      consecutiveFailures: prior,
      reason: "stall-below-threshold",
      nextProgress: {
        ...observed,
        stallChecks: lastProgress.stallChecks,
        lastAdvanceAt: lastProgress.lastAdvanceAt,
      },
    };
  }
  const stallChecks = lastProgress.stallChecks + 1;
  if (stallChecks < busyStallChecks) {
    return {
      consecutiveFailures: prior,
      reason: "stall-below-threshold",
      nextProgress: { ...observed, stallChecks, lastAdvanceAt: lastProgress.lastAdvanceAt },
    };
  }
  // Genuine wedge: processing, no progress for >= minStallIntervalMs across
  // >= busyStallChecks checks. Keep lastAdvanceAt (do not reset) so each subsequent
  // fully-stalled probe keeps incrementing at a steady cadence rather than resetting
  // the accounting on every increment.
  return {
    consecutiveFailures: prior + 1,
    reason: "wedge",
    nextProgress: { ...observed, stallChecks, lastAdvanceAt: lastProgress.lastAdvanceAt },
  };
}

export async function probeCompletion(
  endpoint: string,
  opts: CompletionProbeOptions,
): Promise<CompletionProbeResult> {
  const {
    config,
    models = [],
    fetch: fetchFn = globalThis.fetch,
    priorConsecutiveFailures = 0,
    allowPublicEndpoints = false,
  } = opts;

  try {
    validateProbeEndpoint(endpoint, allowPublicEndpoints);
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      return {
        ok: false,
        status: null,
        latencyMs: 0,
        classification: "misconfigured",
        consecutiveFailures: priorConsecutiveFailures,
      };
    }
    throw err;
  }

  const model = config.model ?? models[0] ?? "default";
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: config.prompt }],
    max_tokens: config.maxTokens,
    temperature: 0,
    stream: false,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);
  const start = Date.now();

  try {
    const res = await fetchFn(`${endpoint}${config.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    const classification = classify(res.status);
    return {
      ok: classification === "ok",
      status: res.status,
      latencyMs,
      classification,
      consecutiveFailures: nextFailures(priorConsecutiveFailures, classification),
    };
  } catch {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - start,
      classification: "wedge",
      consecutiveFailures: priorConsecutiveFailures + 1,
    };
  } finally {
    clearTimeout(timer);
  }
}
