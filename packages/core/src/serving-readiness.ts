import type { ModelHostReadiness } from "./engines/types.js";

/**
 * Declared serving-readiness contract (issue #220), distinct from liveness
 * `/health`: an engine can list its id on /v1/models and answer /health long
 * before it can serve. The shape is the engine layer's `ModelHostReadiness`
 * verbatim — GET <path> must answer `expectStatus` (default 200), and when
 * `expectJson` is set the top-level JSON body must carry those scalar
 * key/values. One shape, one evaluator, so probe / start / engine polls
 * cannot drift apart.
 */
export type ServingReadiness = ModelHostReadiness;

export interface ServingReadinessCheckOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Evaluate a declared contract against `url` (already host-formatted by the
 * caller). Everything that is not an explicit pass fails closed: status
 * mismatch (including a missing capability's 404), malformed JSON, non-object
 * payload, a wrong or absent expected field, network failure, or a timeout.
 * The signal/timeout bounds cover response-body consumption, not just headers.
 * When both a signal and a timeout are given, the earliest bound wins: a live
 * caller-side signal must not silently disable the declared timeout.
 */
function composeDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timer : AbortSignal.any([signal, timer]);
}

export async function servingReadinessCheck(
  url: string,
  readiness: ServingReadiness,
  opts: ServingReadinessCheckOptions = {},
): Promise<boolean> {
  const { fetch: fetchFn = globalThis.fetch, timeoutMs = 1_000 } = opts;
  try {
    const response = await fetchFn(url, {
      signal: composeDeadline(opts.signal, timeoutMs),
    });
    if (response.status !== (readiness.expectStatus ?? 200)) {
      return false;
    }
    if (readiness.expectJson === undefined) {
      return true;
    }
    const body: unknown = await response.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return false;
    }
    const record = body as Record<string, unknown>;
    return Object.entries(readiness.expectJson).every(([key, value]) => record[key] === value);
  } catch {
    return false;
  }
}
