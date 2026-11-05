// Pins for the frozename/llamactl#249 review round 2 at the loop level: the
// supervisor tick must feed the recorder the workload revision (a revision
// change between ticks with strictly rising counters counts as exactly one
// reset and surfaces on stats.revision), and each ModelHost sample must carry
// the injected clock at its own read completion — a slow host must not shift
// its sibling's timestamp, and the two hosts' reads must overlap.
import { describe, expect, it } from "bun:test";

import type { FleetSnapshotEntry, NodeMemSnapshot, WorkloadSnapshot } from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { startSupervisorLoop } from "../src/loop.js";

const NODE_MEM: NodeMemSnapshot = {
  free_mb: 8192,
  active_mb: 1024,
  inactive_mb: 512,
  wired_mb: 256,
  compressor_mb: 64,
  swap_in: 0,
  swap_out: 0,
};

const GUFO_HOST: WorkloadTarget = {
  name: "gufo-host",
  endpoint: "http://127.0.0.1:8090",
  kind: "ModelHost",
};

const SLOW_HOST: WorkloadTarget = {
  name: "slow-host",
  endpoint: "http://127.0.0.1:8290",
  kind: "ModelHost",
};

const FAST_HOST: WorkloadTarget = {
  name: "fast-host",
  endpoint: "http://127.0.0.1:8291",
  kind: "ModelHost",
};

const SLOTS_BODY = [
  { id: 0, is_processing: true },
  { id: 1, is_processing: false },
  { id: 2, is_processing: true },
];

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

describe("engine throughput revision pin (#249 P8)", () => {
  it("counts a revision change with rising counters as one reset and carries it on stats", async () => {
    const revisions = ["rev-1", "rev-2", "rev-2"];
    const prompts = [1000, 6000, 11000];
    const predicted = [2000, 2450, 2900];
    let tick = -1;

    const fetchStub = makeFetchStub((url) => {
      if (url.endsWith("/metrics")) {
        const index = Math.max(tick, 0);
        return Promise.resolve(
          new Response(llamacppMetrics(prompts[index] ?? 0, predicted[index] ?? 0), {
            status: 200,
          }),
        );
      }
      if (url.endsWith("/slots")) {
        return Promise.resolve(Response.json(SLOTS_BODY));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const snapshots: FleetSnapshotEntry[] = [];
    const handle = startSupervisorLoop({
      node: "local",
      intervalMs: 1,
      workloads: [GUFO_HOST],
      fetch: fetchStub,
      engineThroughputNow: () => Math.max(tick, 0) * 10_000,
      probeNodeMem: () => {
        tick += 1;
        return Promise.resolve(NODE_MEM);
      },
      probeWorkload: (target) =>
        Promise.resolve(makeReachable(target, revisions[Math.min(Math.max(tick, 0), 2)])),
      writeJournal: () => undefined,
      recordEngineThroughput: true,
      onTick: (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length >= 3) {
          handle.stop();
        }
      },
    });
    await handle.done;

    const entry = snapshots.at(-1)?.engineThroughput?.[0];
    expect(entry).toBeDefined();
    expect(entry?.revision).toBe("rev-2");
    expect(entry?.stats).not.toBeNull();
    // rev-1 -> rev-2 flips the revision once with strictly rising counters:
    // exactly one reset, the rev-2 -> rev-2 interval still yields rates.
    expect(entry?.stats?.counterResets).toBe(1);
    expect(entry?.stats?.revision).toBe("rev-2");
    expect(entry?.stats?.sampleCount).toBe(3);
    expect(entry?.stats?.decodeTokPerSec?.median).toBe(45);
    expect(entry?.stats?.prefillTokPerSec?.median).toBe(500);
  });
});

describe("engine throughput per-sample clock pin (#249 rate skew)", () => {
  it("stamps each ModelHost sample with the clock at its own read completion", async () => {
    const clock = { ms: 4_000 };
    const issued: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchStub = makeFetchStub((url) => {
      issued.push(url);
      if (url.startsWith(FAST_HOST.endpoint)) {
        // The fast host's reads complete 5 s into the tick.
        clock.ms = 9_000;
        return Promise.resolve(respondThroughput(url));
      }
      return gate.then(() => respondThroughput(url));
    });

    let last: FleetSnapshotEntry | undefined;
    const handle = startSupervisorLoop({
      node: "local",
      intervalMs: 50,
      workloads: [SLOW_HOST, FAST_HOST],
      fetch: fetchStub,
      engineThroughputNow: () => clock.ms,
      probeNodeMem: () => Promise.resolve(NODE_MEM),
      probeWorkload: (target) => Promise.resolve(makeReachable(target)),
      writeJournal: () => undefined,
      recordEngineThroughput: true,
      onTick: (snapshot) => {
        last = snapshot;
        handle.stop();
      },
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // The fast host's /metrics read was issued while the slow host's reads
    // were still pending — the two hosts' reads overlap.
    expect(
      issued.filter((url) => url.startsWith(FAST_HOST.endpoint) && url.endsWith("/metrics")),
    ).toHaveLength(1);

    clock.ms = 24_000;
    release();
    await handle.done;

    const byName = new Map((last?.engineThroughput ?? []).map((entry) => [entry.workload, entry]));
    // Tick start was 4_000; each host's stamp is its own completion time.
    expect(byName.get("fast-host")?.sampledAt).toBe(new Date(9_000).toISOString());
    expect(byName.get("slow-host")?.sampledAt).toBe(new Date(24_000).toISOString());
    expect(byName.get("fast-host")?.stats?.lastSampleAt).toBe(new Date(9_000).toISOString());
    expect(byName.get("slow-host")?.stats?.lastSampleAt).toBe(new Date(24_000).toISOString());
  });
});
