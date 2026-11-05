/* eslint-disable @typescript-eslint/require-await -- Test doubles implement async probe contracts without artificial scheduling. */
// RED pins for frozename/llamactl#249: the supervisor tick must drive the
// EngineThroughputRecorder — one read-only GET /metrics + GET /slots per
// reachable ModelHost target per tick — and carry the per-workload stats on
// the journaled fleet-snapshot as `engineThroughput`. The recorder itself is
// pinned in engine-throughput.test.ts.
import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineThroughputStats } from "../src/engine-throughput.js";
import type { SupervisorLoopHandle, SupervisorLoopOptions } from "../src/loop.js";
import type {
  FleetJournalEntry,
  FleetSnapshotEntry,
  NodeMemSnapshot,
  WorkloadSnapshot,
} from "../src/types.js";
import type { WorkloadTarget } from "../src/workload-probe.js";

import { collectLatestSnapshots } from "../../mcp/src/tools/fleet.js";
import { handleFleetSnapshotRoute } from "../../remote/src/routes/fleet.js";
import { startSupervisorLoop } from "../src/loop.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { readLatestFleetSnapshotFromJournal } from "../src/snapshot-reader.js";

// #249 additions to SupervisorLoopOptions / FleetSnapshotEntry. Kept as local
// extension types so the pins fail by assertion (the field is simply absent
// today), not by type error.
type ThroughputLoopOptions = SupervisorLoopOptions & {
  recordEngineThroughput?: boolean;
  engineThroughputNow?: () => number;
};

interface EndpointAvailability {
  available: boolean;
  reason?: string;
}

interface EngineThroughputSnapshotEntry {
  workload: string;
  revision: string | null;
  sampledAt: string;
  metrics: EndpointAvailability;
  slots: EndpointAvailability;
  stats: EngineThroughputStats | null;
}

type SnapshotWithThroughput = FleetSnapshotEntry & {
  engineThroughput?: EngineThroughputSnapshotEntry[];
};

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

const RUN_A: WorkloadTarget = {
  name: "run-a",
  endpoint: "http://127.0.0.1:8091",
  kind: "ModelRun",
};

const SLOTS_BODY = [
  { id: 0, is_processing: true },
  { id: 1, is_processing: false },
  { id: 2, is_processing: true },
];

interface FetchCall {
  url: string;
  method: string;
}

interface EngineHarness {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
  probeNodeMem: () => Promise<NodeMemSnapshot>;
  engineThroughputNow: () => number;
}

function metricsText(prompt: number, predicted: number, includeDeferred: boolean): string {
  const lines = [
    "# HELP llamacpp:prompt_tokens_total Total prompt tokens processed",
    "# TYPE llamacpp:prompt_tokens_total counter",
    `llamacpp:prompt_tokens_total ${String(prompt)}`,
    "# HELP llamacpp:tokens_predicted_total Total tokens predicted",
    "# TYPE llamacpp:tokens_predicted_total counter",
    `llamacpp:tokens_predicted_total ${String(predicted)}`,
    "# HELP llamacpp:requests_processing Requests currently processing",
    "# TYPE llamacpp:requests_processing gauge",
    "llamacpp:requests_processing 1",
  ];
  if (includeDeferred) {
    lines.push(
      "# HELP llamacpp:requests_deferred Requests deferred",
      "# TYPE llamacpp:requests_deferred gauge",
      "llamacpp:requests_deferred 0",
    );
  }
  return `${lines.join("\n")}\n`;
}

// The clock contract: `tick` advances exactly once per tick because the loop
// calls probeNodeMem first in every runTick; engineThroughputNow then reads a
// stable per-tick value (0, 10_000, 20_000, ...) no matter how often the
// implementation samples the clock inside a tick.
function makeEngineHarness(spec: {
  prompt: readonly number[];
  predicted: readonly number[];
  includeDeferred?: boolean;
  metricsStatus?: number;
  slotsStatus?: number;
}): EngineHarness {
  let tick = -1;
  const calls: FetchCall[] = [];
  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    const index = Math.min(
      Math.max(tick, 0),
      Math.min(spec.prompt.length, spec.predicted.length) - 1,
    );
    if (url.endsWith("/metrics")) {
      const status = spec.metricsStatus ?? 200;
      if (status !== 200) {
        return new Response("not found", { status });
      }
      const body = metricsText(
        spec.prompt[index] ?? 0,
        spec.predicted[index] ?? 0,
        spec.includeDeferred ?? true,
      );
      return new Response(body, { status: 200 });
    }
    if (url.endsWith("/slots")) {
      const status = spec.slotsStatus ?? 200;
      if (status !== 200) {
        return new Response("not implemented", { status });
      }
      return Response.json(SLOTS_BODY);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch: fetchStub,
    calls,
    probeNodeMem: async (): Promise<NodeMemSnapshot> => {
      tick += 1;
      return NODE_MEM;
    },
    engineThroughputNow: () => tick * 10_000,
  };
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

async function probeReachable(t: WorkloadTarget): Promise<WorkloadSnapshot> {
  return makeReachable(t);
}

function startLoop(opts: ThroughputLoopOptions): SupervisorLoopHandle {
  return startSupervisorLoop(opts);
}

interface RunLoopSpec {
  ticks: number;
  targets: WorkloadTarget[];
  harness: EngineHarness;
  probeWorkload?: (target: WorkloadTarget) => Promise<WorkloadSnapshot>;
  recordEngineThroughput?: boolean;
}

async function runLoop(spec: RunLoopSpec): Promise<{
  snapshots: SnapshotWithThroughput[];
  journal: FleetJournalEntry[];
}> {
  const snapshots: SnapshotWithThroughput[] = [];
  const journal: FleetJournalEntry[] = [];
  const handle = startLoop({
    node: "local",
    intervalMs: 1,
    workloads: spec.targets,
    fetch: spec.harness.fetch,
    engineThroughputNow: spec.harness.engineThroughputNow,
    probeNodeMem: spec.harness.probeNodeMem,
    probeWorkload: spec.probeWorkload ?? probeReachable,
    writeJournal: (entry) => {
      journal.push(entry);
    },
    ...(spec.recordEngineThroughput !== undefined
      ? { recordEngineThroughput: spec.recordEngineThroughput }
      : {}),
    onTick: (snapshot) => {
      snapshots.push(snapshot);
      if (snapshots.length >= spec.ticks) {
        handle.stop();
      }
    },
  });
  await handle.done;
  return { snapshots, journal };
}

describe("engine throughput loop wiring (#249)", () => {
  it("records windowed decode and prefill rates on the fleet snapshot", async () => {
    const harness = makeEngineHarness({ prompt: [1000, 6000], predicted: [2000, 2450] });
    const { snapshots } = await runLoop({
      ticks: 2,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });

    const throughput = snapshots.at(-1)?.engineThroughput;
    expect(throughput).toBeDefined();
    expect(throughput).toHaveLength(1);
    const entry = throughput?.[0];
    expect(entry?.workload).toBe("gufo-host");
    expect(entry?.revision).toBe("rev-1");
    expect(entry?.sampledAt).toBe(new Date(10_000).toISOString());
    expect(entry?.metrics.available).toBe(true);
    expect(entry?.slots.available).toBe(true);
    // decode: (2450-2000) tokens / 10 s = 45 tok/s; prefill: (6000-1000) / 10 s = 500 tok/s.
    expect(entry?.stats?.decodeTokPerSec?.median).toBe(45);
    expect(entry?.stats?.prefillTokPerSec?.median).toBe(500);
    expect(entry?.stats?.meanBusySlots).toBe(2);
    expect(entry?.stats?.sampleCount).toBe(2);
    expect(entry?.stats?.firstSampleAt).toBe(new Date(0).toISOString());
    expect(entry?.stats?.lastSampleAt).toBe(new Date(10_000).toISOString());
  });

  it("counts a counter drop as a reset and excludes that interval from rates", async () => {
    const harness = makeEngineHarness({
      prompt: [1000, 1000, 1000],
      predicted: [2000, 100, 550],
    });
    const { snapshots } = await runLoop({
      ticks: 3,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });

    const entry = snapshots.at(-1)?.engineThroughput?.[0];
    expect(entry).toBeDefined();
    expect(entry?.stats?.counterResets).toBe(1);
    expect(entry?.stats?.decodeTokPerSec?.median).toBe(45);
    expect(entry?.stats?.decodeTokPerSec?.p10).toBeGreaterThan(0);
    expect(entry?.stats?.prefillTokPerSec).toBeNull();
  });

  it("surfaces /metrics and /slots failures with reasons and null stats", async () => {
    const harness = makeEngineHarness({
      prompt: [1000],
      predicted: [2000],
      metricsStatus: 404,
      slotsStatus: 501,
    });
    const { snapshots } = await runLoop({
      ticks: 1,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });

    const snapshot = snapshots.at(-1);
    const entry = snapshot?.engineThroughput?.find((e) => e.workload === "gufo-host");
    expect(entry).toBeDefined();
    expect(entry?.metrics.available).toBe(false);
    expect(entry?.metrics.reason).toContain("404");
    expect(entry?.slots.available).toBe(false);
    expect(entry?.slots.reason).toContain("501");
    expect(entry?.stats).toBeNull();
    expect(JSON.stringify(snapshot?.engineThroughput)).not.toMatch(
      /"(decodeTokPerSec|prefillTokPerSec|meanBusySlots|deferredShare)":0/,
    );
  });

  it("leaves deferredShare null when requests_deferred is absent", async () => {
    const harness = makeEngineHarness({
      prompt: [1000, 6000],
      predicted: [2000, 2450],
      includeDeferred: false,
    });
    const { snapshots } = await runLoop({
      ticks: 2,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });

    const entry = snapshots.at(-1)?.engineThroughput?.[0];
    expect(entry).toBeDefined();
    expect(entry?.metrics.available).toBe(true);
    expect(entry?.stats?.deferredShare).toBeNull();
    expect(entry?.stats?.decodeTokPerSec).not.toBeNull();
  });

  it("issues only read-only GET /metrics and /slots probes", async () => {
    const harness = makeEngineHarness({ prompt: [1000, 6000], predicted: [2000, 2450] });
    await runLoop({
      ticks: 2,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });

    expect(harness.calls.some((c) => c.url.endsWith("/metrics"))).toBe(true);
    expect(harness.calls.some((c) => c.url.endsWith("/slots"))).toBe(true);
    for (const call of harness.calls) {
      expect(call.method).toBe("GET");
      expect(call.url.endsWith("/metrics") || call.url.endsWith("/slots")).toBe(true);
      expect(call.url).not.toMatch(/completion|chat|embeddings|props/);
    }
  });

  it("marks unreachable workloads unavailable without probing them", async () => {
    const harness = makeEngineHarness({ prompt: [1000, 6000], predicted: [2000, 2450] });
    const { snapshots } = await runLoop({
      ticks: 2,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
      probeWorkload: async (t) => ({
        ...makeReachable(t),
        reachable: false,
        consecutiveErrors: 1,
        revision: null,
      }),
    });

    const throughput = snapshots.at(-1)?.engineThroughput;
    expect(throughput).toBeDefined();
    const entry = throughput?.find((e) => e.workload === "gufo-host");
    expect(entry).toBeDefined();
    expect(entry?.metrics.available).toBe(false);
    expect(entry?.metrics.reason).toContain("unreachable");
    expect(entry?.slots.available).toBe(false);
    expect(entry?.slots.reason).toContain("unreachable");
    expect(entry?.stats).toBeNull();
    expect(
      harness.calls.filter((c) => c.url.endsWith("/metrics") || c.url.endsWith("/slots")),
    ).toHaveLength(0);
  });

  it("samples ModelHost targets only and never touches ModelRun endpoints", async () => {
    const harness = makeEngineHarness({ prompt: [1000], predicted: [2000] });
    const { snapshots } = await runLoop({
      ticks: 1,
      targets: [GUFO_HOST, RUN_A],
      harness,
      recordEngineThroughput: true,
    });

    const throughput = snapshots.at(-1)?.engineThroughput;
    expect(throughput?.some((e) => e.workload === "gufo-host")).toBe(true);
    expect(harness.calls.some((c) => c.url === "http://127.0.0.1:8090/metrics")).toBe(true);
    expect(throughput?.some((e) => e.workload === "run-a")).toBe(false);
    expect(
      harness.calls.filter(
        (c) =>
          c.url.startsWith("http://127.0.0.1:8091/metrics") ||
          c.url.startsWith("http://127.0.0.1:8091/slots"),
      ),
    ).toHaveLength(0);
  });

  it("leaves engineThroughput off the snapshot when recordEngineThroughput is unset", async () => {
    const harness = makeEngineHarness({ prompt: [1000, 6000], predicted: [2000, 2450] });
    const { snapshots } = await runLoop({ ticks: 2, targets: [GUFO_HOST], harness });

    const last = snapshots.at(-1);
    expect(last).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(last, "engineThroughput")).toBe(false);
    expect(harness.calls.filter((c) => c.url.endsWith("/metrics"))).toHaveLength(0);
  });
});

describe("loose readers tolerate the optional engineThroughput field", () => {
  it("round-trips snapshots with and without engineThroughput through every reader", async () => {
    const harness = makeEngineHarness({ prompt: [1000, 6000], predicted: [2000, 2450] });
    const { snapshots } = await runLoop({
      ticks: 2,
      targets: [GUFO_HOST],
      harness,
      recordEngineThroughput: true,
    });
    const snapshot = snapshots.at(-1)!;
    expect(snapshot.engineThroughput).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), "engine-throughput-loop-"));
    try {
      const journalA = join(dir, "journal-a.jsonl");
      const journalB = join(dir, "journal-b.jsonl");
      writeFileSync(journalA, `${JSON.stringify(snapshot)}\n`, "utf8");
      const legacy = {
        kind: "fleet-snapshot",
        ts: "2026-10-30T00:00:00.000Z",
        node: "local",
        node_mem: NODE_MEM,
        workloads: [makeReachable(GUFO_HOST)],
      };
      writeFileSync(journalB, `${JSON.stringify(legacy)}\n`, "utf8");

      for (const { path, expectThroughput } of [
        { path: journalA, expectThroughput: true },
        { path: journalB, expectThroughput: false },
      ]) {
        const read: SnapshotWithThroughput | null = readLatestFleetSnapshotFromJournal(path);
        expect(read).not.toBeNull();
        expect(read?.workloads[0]?.name).toBe("gufo-host");
        if (expectThroughput) {
          expect(read?.engineThroughput?.[0]?.workload).toBe("gufo-host");
        } else {
          expect(Object.prototype.hasOwnProperty.call(read, "engineThroughput")).toBe(false);
        }

        const res = handleFleetSnapshotRoute(new Request("http://x/fleet/snapshot"), {
          journalPath: path,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { workloads: { name: string }[] };
        expect(body.workloads[0]?.name).toBe("gufo-host");

        const parsed = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as FleetJournalEntry);
        expect(collectLatestSnapshots(parsed)).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
