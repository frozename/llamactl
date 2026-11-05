// Pins for the frozename/llamactl#249 review round 2, collector level:
// collectEngineThroughput reads ModelHost targets concurrently and stamps each
// sample with the injected clock at that target's read completion (a serial
// loop stamped every sample at tick start, skewing rates); the "no llama.cpp
// counters" /metrics branch (a proxied endpoint exposing only the agent's own
// registry) reports unavailable with all-null counters, never zeros; and mixed
// availability (/metrics failing, /slots succeeding) keeps gauge-derived stats
// unavailable, never 0.
import { describe, expect, it } from "bun:test";

import type { WorkloadSnapshot } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { collectEngineThroughput, readEngineMetrics } from "../src/engine-throughput-collector.js";
import { EngineThroughputRecorder } from "../src/engine-throughput.js";

const SLOW_HOST: WorkloadTarget = {
  name: "slow-host",
  endpoint: "http://127.0.0.1:8190",
  kind: "ModelHost",
};

const FAST_HOST: WorkloadTarget = {
  name: "fast-host",
  endpoint: "http://127.0.0.1:8191",
  kind: "ModelHost",
};

const AGENT_HOST: WorkloadTarget = {
  name: "agent-proxy-host",
  endpoint: "http://127.0.0.1:8192",
  kind: "ModelHost",
};

const SLOTS_BODY = [
  { id: 0, is_processing: true },
  { id: 1, is_processing: false },
  { id: 2, is_processing: true },
];

// A node agent's own /metrics registry (the shape a proxied endpoint exposes):
// Prometheus runtime series only, no llamacpp:* counters at all.
const AGENT_REGISTRY_METRICS = [
  "# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.",
  "# TYPE process_cpu_seconds_total counter",
  "process_cpu_seconds_total 4.29",
  "# HELP process_start_time_seconds Start time of the process in seconds since the epoch.",
  "# TYPE process_start_time_seconds gauge",
  "process_start_time_seconds 1780000000",
  "# HELP nodejs_heap_space_used_bytes Heap space used, in bytes, per space.",
  "# TYPE nodejs_heap_space_used_bytes gauge",
  'nodejs_heap_space_used_bytes{space="old"} 1048576',
].join("\n");

function llamacppMetrics(prompt: number, predicted: number): string {
  return [
    "# HELP llamacpp:prompt_tokens_total Total prompt tokens processed",
    "# TYPE llamacpp:prompt_tokens_total counter",
    `llamacpp:prompt_tokens_total ${String(prompt)}`,
    "# HELP llamacpp:tokens_predicted_total Total tokens predicted",
    "# TYPE llamacpp:tokens_predicted_total counter",
    `llamacpp:tokens_predicted_total ${String(predicted)}`,
    "# HELP llamacpp:requests_processing Requests currently processing",
    "# TYPE llamacpp:requests_processing gauge",
    "llamacpp:requests_processing 1",
    "# HELP llamacpp:requests_deferred Requests deferred",
    "# TYPE llamacpp:requests_deferred gauge",
    "llamacpp:requests_deferred 0",
  ].join("\n");
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

// Bun's `typeof fetch` carries a preconnect property, so a bare arrow is not
// assignable; Object.assign keeps the call signature without any cast.
function makeFetchStub(handle: (url: string) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(
    (input: string | URL | Request): Promise<Response> => handle(requestUrl(input)),
    { preconnect: (): void => undefined },
  );
}

function makeReachable(t: WorkloadTarget, revision: string | null = "rev-1"): WorkloadSnapshot {
  return {
    name: t.name,
    kind: t.kind,
    endpoint: t.endpoint,
    priority: t.priority ?? 50,
    rss_mb: null,
    request_rate_5m: null,
    error_rate_5m: 0,
    p50_ms: 10,
    p95_ms: 10,
    models: [],
    reachable: true,
    consecutiveErrors: 0,
    revision,
  };
}

function respondThroughput(url: string): Response {
  if (url.endsWith("/metrics")) {
    return new Response(llamacppMetrics(1000, 2000), { status: 200 });
  }
  if (url.endsWith("/slots")) {
    return Response.json(SLOTS_BODY);
  }
  return new Response("not found", { status: 404 });
}

describe("readEngineMetrics no-llama.cpp-counters branch (#249 P4)", () => {
  it("reports unavailable with all-null counters when /metrics carries only the agent registry", async () => {
    const fetchStub = makeFetchStub((url) => {
      if (url.endsWith("/metrics")) {
        return Promise.resolve(new Response(AGENT_REGISTRY_METRICS, { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const reading = await readEngineMetrics(AGENT_HOST.endpoint, { fetch: fetchStub });

    expect(reading.available).toBe(false);
    if (reading.available) {
      expect.unreachable("a registry-only /metrics must report unavailable");
    }
    expect(reading.reason).toBe("no llama.cpp counters");
    expect(reading.metrics).toEqual({
      promptTokensTotal: null,
      predictedTokensTotal: null,
      requestsProcessing: null,
      requestsDeferred: null,
    });
  });
});

describe("collectEngineThroughput concurrent sampling (#249 rate skew)", () => {
  it("reads targets concurrently and stamps each sample with its own completion time", async () => {
    const issued: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clockMs = 5_000;
    const clock = (): number => clockMs;
    const fetchStub = makeFetchStub((url) => {
      issued.push(url);
      if (url.startsWith(SLOW_HOST.endpoint)) {
        return gate.then(() => respondThroughput(url));
      }
      return Promise.resolve(respondThroughput(url));
    });

    const recorder = new EngineThroughputRecorder({ now: clock });
    const collecting = collectEngineThroughput({
      workloads: [makeReachable(SLOW_HOST), makeReachable(FAST_HOST)],
      targets: [SLOW_HOST, FAST_HOST],
      recorder,
      tickMs: 0,
      now: clock,
      fetch: fetchStub,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // The fast host's reads were issued while the slow host's reads were still
    // pending — one slow ModelHost cannot serialize its siblings behind it.
    expect(issued.filter((url) => url.startsWith(SLOW_HOST.endpoint))).toHaveLength(2);
    expect(issued.filter((url) => url.startsWith(FAST_HOST.endpoint))).toHaveLength(2);

    clockMs = 20_000;
    release();
    const out = await collecting;

    expect(out.map((entry) => entry.workload)).toEqual(["slow-host", "fast-host"]);
    const byName = new Map(out.map((entry) => [entry.workload, entry]));
    // The fast host keeps its own read time (5_000, not the 0 tick stamp and
    // not the slow host's 20_000); the slow host gets the clock at its own
    // completion.
    expect(byName.get("fast-host")?.sampledAt).toBe(new Date(5_000).toISOString());
    expect(byName.get("slow-host")?.sampledAt).toBe(new Date(20_000).toISOString());
    expect(byName.get("fast-host")?.stats?.firstSampleAt).toBe(new Date(5_000).toISOString());
    expect(byName.get("fast-host")?.stats?.lastSampleAt).toBe(new Date(5_000).toISOString());
    expect(byName.get("slow-host")?.stats?.lastSampleAt).toBe(new Date(20_000).toISOString());
  });
});

describe("collectEngineThroughput availability branches (#249 P4 + P11)", () => {
  it("reports decode/prefill unavailable, not 0, on a registry-only /metrics", async () => {
    const fetchStub = makeFetchStub((url) => {
      if (url.endsWith("/metrics")) {
        return Promise.resolve(new Response(AGENT_REGISTRY_METRICS, { status: 200 }));
      }
      if (url.endsWith("/slots")) {
        return Promise.resolve(Response.json(SLOTS_BODY));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const recorder = new EngineThroughputRecorder({ now: (): number => 1_000 });

    const out = await collectEngineThroughput({
      workloads: [makeReachable(AGENT_HOST)],
      targets: [AGENT_HOST],
      recorder,
      tickMs: 1_000,
      now: () => 1_000,
      fetch: fetchStub,
    });

    const entry = out[0];
    expect(entry).toBeDefined();
    expect(entry?.metrics.available).toBe(false);
    expect(entry?.metrics.reason).toContain("no llama.cpp counters");
    expect(entry?.slots.available).toBe(true);
    expect(entry?.stats).not.toBeNull();
    expect(entry?.stats?.decodeTokPerSec).toBeNull();
    expect(entry?.stats?.prefillTokPerSec).toBeNull();
    expect(entry?.stats?.meanBusySlots).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/"(decodeTokPerSec|prefillTokPerSec)":0/);
  });

  it("keeps deferredShare and meanRequestsProcessing unavailable when /metrics fails but /slots succeeds", async () => {
    const fetchStub = makeFetchStub((url) => {
      if (url.endsWith("/metrics")) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      if (url.endsWith("/slots")) {
        return Promise.resolve(Response.json(SLOTS_BODY));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    const clock = { ms: 1_000 };
    const recorder = new EngineThroughputRecorder({ now: (): number => clock.ms });

    const first = await collectEngineThroughput({
      workloads: [makeReachable(AGENT_HOST)],
      targets: [AGENT_HOST],
      recorder,
      tickMs: clock.ms,
      now: () => clock.ms,
      fetch: fetchStub,
    });
    expect(first[0]?.metrics.available).toBe(false);
    expect(first[0]?.metrics.reason).toContain("404");
    expect(first[0]?.slots.available).toBe(true);

    clock.ms = 31_000;
    const out = await collectEngineThroughput({
      workloads: [makeReachable(AGENT_HOST)],
      targets: [AGENT_HOST],
      recorder,
      tickMs: clock.ms,
      now: () => clock.ms,
      fetch: fetchStub,
    });

    const entry = out[0];
    expect(entry).toBeDefined();
    expect(entry?.stats).not.toBeNull();
    expect(entry?.stats?.sampleCount).toBe(2);
    expect(entry?.stats?.deferredShare).toBeNull();
    expect(entry?.stats?.meanRequestsProcessing).toBeNull();
    expect(entry?.stats?.meanBusySlots).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/"(deferredShare|meanRequestsProcessing)":0/);
  });
});
