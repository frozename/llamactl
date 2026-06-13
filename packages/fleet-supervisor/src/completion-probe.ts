// Completion-based liveness probe. A long-lived server can keep /health green
// while completions degrade to 5xx/timeout (the granite + diffusion "wedge":
// growing per-request bookkeeping). probeWorkload alone never sees this, so a
// repeated 5xx-despite-health-200 must be detected here and turned into a
// restart proposal by the policy layer.

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
