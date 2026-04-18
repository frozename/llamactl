import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for the agent. Registered on a dedicated
 * `Registry` so we don't fight with any other prom-client usage in
 * the same process (tests, for instance). Scraped at `GET /metrics`.
 *
 * Labels are kept tight on purpose — path/status/rel cardinality is
 * bounded (handful of OpenAI endpoints, ~5 HTTP status bins, one
 * rel at a time). Nothing unbounded like per-request IDs.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: 'llamactl-agent' });
collectDefaultMetrics({ register: registry });

export const openaiRequestsTotal = new Counter({
  name: 'llamactl_openai_requests_total',
  help: 'OpenAI gateway requests handled by the agent, by path and response status class.',
  labelNames: ['path', 'status_class'] as const,
  registers: [registry],
});

export const openaiUpstreamErrorsTotal = new Counter({
  name: 'llamactl_openai_upstream_errors_total',
  help: 'OpenAI gateway requests where the upstream llama-server was unreachable.',
  registers: [registry],
});

export const openaiRequestDurationSeconds = new Histogram({
  name: 'llamactl_openai_request_duration_seconds',
  help: 'Wall-clock latency of OpenAI gateway requests (including upstream).',
  labelNames: ['path'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const trpcRequestsTotal = new Counter({
  name: 'llamactl_trpc_requests_total',
  help: 'tRPC procedure calls handled by the agent, by procedure and operation type.',
  labelNames: ['procedure', 'type'] as const,
  registers: [registry],
});

export const llamaServerUp = new Gauge({
  name: 'llamactl_llama_server_up',
  help: '1 when this agent tracks a running llama-server, 0 when down or absent.',
  registers: [registry],
});

export const agentInfo = new Gauge({
  name: 'llamactl_agent_info',
  help: 'Agent identity metadata. Value is always 1; information lives in labels.',
  labelNames: ['node_name', 'version'] as const,
  registers: [registry],
});

/** Bin a numeric HTTP status into 2xx/3xx/4xx/5xx for low-cardinality labels. */
export function statusClass(code: number): string {
  if (code < 100 || code >= 600) return 'unknown';
  return `${Math.floor(code / 100)}xx`;
}

/**
 * Normalize an OpenAI path into a small set of bucket labels. Avoids
 * blowing up cardinality when clients hit ad-hoc or slash-variant
 * paths — only the well-known OpenAI surface is tracked directly;
 * anything else gets the `other` bucket.
 */
export function openaiPathBucket(pathname: string): string {
  const known = [
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/v1/models',
    '/v1/rerank',
  ];
  if (known.includes(pathname)) return pathname;
  return '/v1/other';
}
