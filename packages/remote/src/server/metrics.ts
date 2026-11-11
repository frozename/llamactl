import {
  OOM_KILLED_CONDITION,
  readModelHostRuntimeStatus,
} from "@llamactl/core/engines/conditions";
import { resolveEnv } from "@llamactl/core/env";
import {
  evaluateRuntimeMemoryBudget,
  type HostMemoryObservation,
  type MemoryReading,
  type RuntimeMemoryBudget,
  type RuntimeMemoryBudgetOptions,
  type RuntimeMemorySample,
  type RuntimeMemoryVerdict,
} from "@llamactl/core/resources/memory";
import { listWorkloadDirs } from "@llamactl/core/workloadRuntime";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Prometheus metrics for the agent. Registered on a dedicated
 * `Registry` so we don't fight with any other prom-client usage in
 * the same process (tests, for instance). Scraped at `GET /metrics`.
 *
 * Labels are kept tight on purpose — path/status/rel cardinality is
 * bounded (handful of OpenAI endpoints, ~5 HTTP status bins, one
 * rel at a time). Nothing unbounded like per-request IDs. Token names
 * are operator-chosen, regex-bounded and few.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: "llamactl-agent" });
collectDefaultMetrics({ register: registry });

export const openaiRequestsTotal = new Counter({
  name: "llamactl_openai_requests_total",
  help: "OpenAI gateway requests handled by the agent, by path and response status class.",
  labelNames: ["path", "status_class"] as const,
  registers: [registry],
});

export const openaiUpstreamErrorsTotal = new Counter({
  name: "llamactl_openai_upstream_errors_total",
  help: "OpenAI gateway requests where the upstream llama-server was unreachable.",
  registers: [registry],
});

export const openaiRequestDurationSeconds = new Histogram({
  name: "llamactl_openai_request_duration_seconds",
  help: "Wall-clock latency of OpenAI gateway requests (including upstream).",
  labelNames: ["path"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const trpcRequestsTotal = new Counter({
  name: "llamactl_trpc_requests_total",
  help: "tRPC procedure calls handled by the agent, by procedure and operation type.",
  labelNames: ["procedure", "type"] as const,
  registers: [registry],
});

export const agentBearerRequestsTotal = new Counter({
  name: "llamactl_agent_bearer_requests_total",
  help: "Authenticated agent API requests by bearer token name (#218); never the token or its hash.",
  labelNames: ["token"] as const,
  registers: [registry],
});

export const agentBearerLastUsedSeconds = new Gauge({
  name: "llamactl_agent_bearer_last_used_timestamp_seconds",
  help: "Unix time of the last authenticated request per bearer token name (#218).",
  labelNames: ["token"] as const,
  registers: [registry],
});

export const llamaServerUp = new Gauge({
  name: "llamactl_llama_server_up",
  help: "1 when this agent tracks a running llama-server, 0 when down or absent.",
  registers: [registry],
});

export const agentInfo = new Gauge({
  name: "llamactl_agent_info",
  help: "Agent identity metadata. Value is always 1; information lives in labels.",
  labelNames: ["node_name", "version"] as const,
  registers: [registry],
});

let modelHostMetricsNode: string | null = null;

export function setModelHostMetricsNode(name: string | null): void {
  modelHostMetricsNode = name;
}

function modelHostMetricsNodeName(): string {
  return modelHostMetricsNode ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent";
}

export interface AgentRuntimeMemorySample {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

type RuntimeMemorySampler = () => AgentRuntimeMemorySample | null;

let runtimeMemorySampler: RuntimeMemorySampler | null = null;

export function setRuntimeMemorySampler(sampler: RuntimeMemorySampler | null): void {
  runtimeMemorySampler = sampler;
}

export interface AgentRuntimeIdentity {
  role: string;
  memoryBudgetBytes?: number;
}

let runtimeIdentity: AgentRuntimeIdentity | null = null;

export function setAgentRuntimeIdentity(identity: AgentRuntimeIdentity | null): void {
  runtimeIdentity = identity ?? { role: "agent" };
}

export interface ModelHostMetricSample {
  workload: string;
  restarts: number;
  oomKills?: number;
  cgroupOomKill?: number;
}

export function readModelHostMetricSamples(
  resolved = resolveEnv(process.env),
): ModelHostMetricSample[] {
  let names: string[];
  try {
    names = listWorkloadDirs(resolved);
  } catch {
    return [];
  }
  const samples: ModelHostMetricSample[] = [];
  for (const name of names) {
    try {
      const status = readModelHostRuntimeStatus({ name }, resolved);
      if (status === null) continue;
      const oom = status.conditions.find((c) => c.type === OOM_KILLED_CONDITION);
      samples.push({
        workload: name,
        restarts: status.restarts,
        ...(oom ? { oomKills: oom.count } : {}),
        ...(typeof oom?.cgroupOomKill === "number" ? { cgroupOomKill: oom.cgroupOomKill } : {}),
      });
    } catch {
      continue;
    }
  }
  return samples;
}

// registry.metrics() runs every collect() synchronously in one loop,
// so caching across the microtask boundary gives one sidecar read per
// scrape. A collect landing in a later tick re-reads, which is still
// correct — just not free.
let scrapeSamples: ModelHostMetricSample[] | null = null;

function samplesForScrape(): ModelHostMetricSample[] {
  if (scrapeSamples === null) {
    scrapeSamples = readModelHostMetricSamples();
    queueMicrotask(() => {
      scrapeSamples = null;
    });
  }
  return scrapeSamples;
}

new Gauge({
  name: "llamactl_modelhost_restarts",
  help: "Restarts of a running ModelHost recorded by the reconciler (engine found dead or spec drift), from modelhost.conditions.json.",
  labelNames: ["workload", "node"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    for (const sample of samplesForScrape()) {
      this.labels({ workload: sample.workload, node: modelHostMetricsNodeName() }).set(
        sample.restarts,
      );
    }
  },
});

new Gauge({
  name: "llamactl_modelhost_oom_kills",
  help: "Engine OOM kills attributed to the ModelHost (OOMKilled condition count).",
  labelNames: ["workload", "node"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    for (const sample of samplesForScrape()) {
      if (sample.oomKills === undefined) continue;
      this.labels({ workload: sample.workload, node: modelHostMetricsNodeName() }).set(
        sample.oomKills,
      );
    }
  },
});

new Gauge({
  name: "llamactl_modelhost_cgroup_oom_kill",
  help: "The controller cgroup's oom_kill counter at the ModelHost's latest OOM kill.",
  labelNames: ["workload", "node"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    for (const sample of samplesForScrape()) {
      if (sample.cgroupOomKill === undefined) continue;
      this.labels({ workload: sample.workload, node: modelHostMetricsNodeName() }).set(
        sample.cgroupOomKill,
      );
    }
  },
});

// Per-role runtime memory series (RSS, JS heap used/total, external,
// ArrayBuffer bytes) plus the configured memory budget and an over-budget
// flag. The sampler defaults to process.memoryUsage(); setRuntimeMemorySampler
// replaces it for tests. The identity (role + optional memoryBudgetBytes) is
// set via setAgentRuntimeIdentity; without a budget no budget or over-budget
// series are emitted.
//
// The budget check charges a single basis (footprint when ok and fresh, RSS
// as fallback) — JS heap, external memory and device-wide counters are never
// attributed to a control process.

let runtimeMemoryScrapeSample: AgentRuntimeMemorySample | null = null;
let runtimeMemoryScrapeVerdict: RuntimeMemoryVerdict | null = null;
let runtimeMemoryScrapeRole: string | null = null;

function runtimeMemoryScrape(): {
  sample: AgentRuntimeMemorySample | null;
  verdict: RuntimeMemoryVerdict | null;
  role: string;
} {
  if (runtimeMemoryScrapeSample !== null) {
    return {
      sample: runtimeMemoryScrapeSample,
      verdict: runtimeMemoryScrapeVerdict,
      role: runtimeMemoryScrapeRole ?? "agent",
    };
  }

  let sample: AgentRuntimeMemorySample | null = null;
  try {
    const raw = (runtimeMemorySampler ?? ((): AgentRuntimeMemorySample => process.memoryUsage()))();
    if (raw !== null) {
      sample = {
        rss: raw.rss,
        heapUsed: raw.heapUsed,
        heapTotal: raw.heapTotal,
        external: raw.external,
        arrayBuffers: raw.arrayBuffers,
      };
    }
  } catch {
    /* ignore — sample stays null */
  }

  const identity = runtimeIdentity ?? { role: "agent" };
  const role = identity.role;
  let verdict: RuntimeMemoryVerdict | null = null;

  if (sample !== null && identity.memoryBudgetBytes !== undefined) {
    const nowMs = Date.now();
    const rssReading: MemoryReading = {
      bytes: sample.rss,
      observedAtMs: nowMs,
      source: "process.memoryUsage",
      status: "ok",
    };
    const unsupportedReading: MemoryReading = {
      bytes: null,
      observedAtMs: null,
      source: "",
      status: "unsupported",
    };
    const deviceReading: HostMemoryObservation["device"] = {
      ...unsupportedReading,
      scope: "unknown",
    };
    const runtimeSample: RuntimeMemorySample = {
      role,
      rss: rssReading,
      footprint: unsupportedReading,
      jsHeapUsed: unsupportedReading,
      external: unsupportedReading,
      device: deviceReading,
    };
    const budget: RuntimeMemoryBudget = {
      role,
      maxBytes: identity.memoryBudgetBytes,
    };
    const options: RuntimeMemoryBudgetOptions = {
      nowMs,
      maxAgeMs: 0,
    };
    verdict = evaluateRuntimeMemoryBudget(runtimeSample, budget, options);
  }

  runtimeMemoryScrapeSample = sample;
  runtimeMemoryScrapeVerdict = verdict;
  runtimeMemoryScrapeRole = role;

  queueMicrotask(() => {
    runtimeMemoryScrapeSample = null;
    runtimeMemoryScrapeVerdict = null;
    runtimeMemoryScrapeRole = null;
  });

  return { sample, verdict, role };
}

new Gauge({
  name: "llamactl_agent_runtime_memory_bytes",
  help: "Per-kind runtime memory bytes for the agent control process, by role.",
  labelNames: ["role", "node", "kind"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    const { sample, role } = runtimeMemoryScrape();
    if (sample === null) return;
    const labels = { role, node: modelHostMetricsNodeName() };
    const kinds: { key: keyof AgentRuntimeMemorySample; kind: string }[] = [
      { key: "rss", kind: "rss" },
      { key: "heapUsed", kind: "heap_used" },
      { key: "heapTotal", kind: "heap_total" },
      { key: "external", kind: "external" },
      { key: "arrayBuffers", kind: "array_buffers" },
    ];
    for (const { key, kind } of kinds) {
      const value = sample[key];
      if (Number.isFinite(value) && value >= 0) {
        this.labels({ ...labels, kind }).set(value);
      }
    }
  },
});

new Gauge({
  name: "llamactl_agent_runtime_memory_budget_bytes",
  help: "Configured per-role memory budget in bytes. Only present when a budget is set.",
  labelNames: ["role", "node"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    const { verdict, role } = runtimeMemoryScrape();
    if (!verdict?.known) return;
    this.labels({ role, node: modelHostMetricsNodeName() }).set(verdict.maxBytes);
  },
});

new Gauge({
  name: "llamactl_agent_runtime_memory_over_budget",
  help: "1 when the control process charge exceeds its role budget, 0 when within budget, absent when no budget is configured.",
  labelNames: ["role", "node"] as const,
  registers: [registry],
  collect(): void {
    this.reset();
    const { verdict, role } = runtimeMemoryScrape();
    if (!verdict?.known) return;
    this.labels({ role, node: modelHostMetricsNodeName() }).set(verdict.withinBudget ? 0 : 1);
  },
});

/** Bin a numeric HTTP status into 2xx/3xx/4xx/5xx for low-cardinality labels. */
export function statusClass(code: number): string {
  if (code < 100 || code >= 600) return "unknown";
  return `${String(Math.floor(code / 100))}xx`;
}

/**
 * Normalize an OpenAI path into a small set of bucket labels. Avoids
 * blowing up cardinality when clients hit ad-hoc or slash-variant
 * paths — only the well-known OpenAI surface is tracked directly;
 * anything else gets the `other` bucket.
 */
export function openaiPathBucket(pathname: string): string {
  const known = [
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/models",
    "/v1/rerank",
  ];
  if (known.includes(pathname)) return pathname;
  return "/v1/other";
}
