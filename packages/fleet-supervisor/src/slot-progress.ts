// Read-only slot-progress poller for the busy-aware-probing data plan. Reads a
// llama.cpp `GET /slots` snapshot per workload so the busy-vs-wedged signature
// can be characterized before the busy-guard is designed. Nothing here drives a
// proposal. See docs/notes/2026-06-15-busy-aware-probing-design.md.

import type { SlotProgress, SlotProgressReading } from "./types.js";

import { InvalidEndpointError, validateProbeEndpoint } from "./workload-probe.js";

const DEFAULT_TIMEOUT_MS = 5_000;

// The /slots schema varies across llama.cpp builds; read whichever counter key
// is present rather than assuming one.
const PAST_KEYS = ["n_past", "n_prompt_tokens_processed", "n_prompt"] as const;
const DECODED_KEYS = ["n_decoded", "tokens_predicted", "n_predicted"] as const;

function numField(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function deriveProcessing(obj: Record<string, unknown>, state: number | null): boolean | null {
  if (typeof obj.is_processing === "boolean") return obj.is_processing;
  if (state === null) return null;
  return state !== 0;
}

/**
 * Parse a llama.cpp `GET /slots` body into per-slot progress. Pure and
 * defensive: a non-array yields [], and any missing/non-numeric field becomes
 * null rather than throwing.
 */
export function parseSlotsResponse(body: unknown): SlotProgress[] {
  if (!Array.isArray(body)) return [];
  return body.map((raw): SlotProgress => {
    if (raw === null || typeof raw !== "object") {
      return { id: null, state: null, processing: null, nPast: null, nDecoded: null };
    }
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === "number" && Number.isFinite(obj.id) ? obj.id : null;
    const state = typeof obj.state === "number" && Number.isFinite(obj.state) ? obj.state : null;
    return {
      id,
      state,
      processing: deriveProcessing(obj, state),
      nPast: numField(obj, PAST_KEYS),
      nDecoded: numField(obj, DECODED_KEYS),
    };
  });
}

export interface ReadSlotProgressOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  allowPublicEndpoints?: boolean;
}

/**
 * Poll a workload's `/slots` once, read-only. Returns `available:false` with a
 * reason (rather than throwing) for any non-200, non-array, network failure, or
 * rejected endpoint — every outcome is data for the §6 plan.
 */
export async function readSlotProgress(
  endpoint: string,
  opts: ReadSlotProgressOptions = {},
): Promise<SlotProgressReading> {
  const {
    fetch: fetchFn = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowPublicEndpoints = false,
  } = opts;

  try {
    validateProbeEndpoint(endpoint, allowPublicEndpoints);
  } catch (err) {
    if (err instanceof InvalidEndpointError) {
      return { available: false, reason: `invalid endpoint: ${err.message}`, slots: [] };
    }
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(`${endpoint}/slots`, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      return { available: false, reason: `HTTP ${String(res.status)}`, slots: [] };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { available: false, reason: "invalid JSON", slots: [] };
    }
    if (!Array.isArray(body)) {
      return { available: false, reason: "non-array /slots body", slots: [] };
    }
    return { available: true, slots: parseSlotsResponse(body) };
  } catch {
    return { available: false, reason: "network/timeout", slots: [] };
  } finally {
    clearTimeout(timer);
  }
}
