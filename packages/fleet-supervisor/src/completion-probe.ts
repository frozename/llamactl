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
}

export type BusyGuardReason = "busy" | "stall-below-threshold" | "wedge" | "idle-wedge";

export interface BusyGuardInput {
  classification: CompletionProbeClassification;
  prior: number;
  reading: SlotProgressReading;
  lastProgress: BusyGuardProgress | undefined;
  busyStallChecks: number;
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
  return Math.min(max, Math.max(base, percentile(samples, 0.95) * k));
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

function advanced(current: BusyGuardProgress, last: BusyGuardProgress): boolean {
  return (
    (current.nPast !== null && last.nPast !== null && current.nPast > last.nPast) ||
    (current.nDecoded !== null && last.nDecoded !== null && current.nDecoded > last.nDecoded)
  );
}

function lowered(current: BusyGuardProgress, last: BusyGuardProgress): boolean {
  return (
    (current.nPast !== null && last.nPast !== null && current.nPast < last.nPast) ||
    (current.nDecoded !== null && last.nDecoded !== null && current.nDecoded < last.nDecoded)
  );
}

function ambiguous(current: BusyGuardProgress, last: BusyGuardProgress): boolean {
  return (
    (current.nPast === null && last.nPast !== null) ||
    (current.nDecoded === null && last.nDecoded !== null)
  );
}

export function applyBusyGuard(input: BusyGuardInput): BusyGuardResult {
  const { classification, prior, reading, lastProgress, busyStallChecks } = input;
  if (classification !== "wedge") {
    return { consecutiveFailures: prior, reason: undefined, nextProgress: lastProgress };
  }
  if (!reading.available) {
    return { consecutiveFailures: prior, reason: undefined, nextProgress: lastProgress };
  }

  const progress = maxProgress(reading);
  if (!progress.processing) {
    if (progress.ambiguousProcessing) {
      return { consecutiveFailures: prior, reason: undefined, nextProgress: lastProgress };
    }
    return {
      consecutiveFailures: prior + 1,
      reason: "idle-wedge",
      nextProgress: lastProgress,
    };
  }

  const nextProgress = {
    nPast: progress.nPast,
    nDecoded: progress.nDecoded,
    stallChecks: 0,
  };
  if (!lastProgress) {
    return { consecutiveFailures: prior, reason: "busy", nextProgress };
  }
  if (lowered(nextProgress, lastProgress) || ambiguous(nextProgress, lastProgress)) {
    return { consecutiveFailures: prior, reason: "busy", nextProgress };
  }
  if (advanced(nextProgress, lastProgress)) {
    return { consecutiveFailures: prior, reason: "busy", nextProgress };
  }

  const stallChecks = lastProgress.stallChecks + 1;
  if (stallChecks < busyStallChecks) {
    return {
      consecutiveFailures: prior,
      reason: "stall-below-threshold",
      nextProgress: { ...nextProgress, stallChecks },
    };
  }
  return { consecutiveFailures: prior + 1, reason: "wedge", nextProgress };
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
