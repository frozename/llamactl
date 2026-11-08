// Pins for frozename/llamactl#523 (E-11): p50/p95 cold-start load-ms
// estimates per (model, node) over a sliding observedAtMs window capped to
// the newest maxSamples, plus the bench-vision.tsv row adapter. The module
// does not exist at the RED base, so the loaders turn a missing module into
// an empty namespace and every case fails on the export assertion, never on
// a resolution error.
import { describe, expect, it } from "bun:test";

const NOW = 1_000_000_000;

type ColdStartSampleT = {
  model: string;
  node: string;
  loadMs: number;
  observedAtMs: number;
};

type ColdStartEstimateT =
  | { state: "unknown"; model: string; node: string; sampleCount: 0 }
  | {
      state: "estimated";
      model: string;
      node: string;
      p50Ms: number;
      p95Ms: number;
      sampleCount: number;
    };

type BenchVisionT = {
  machine: string;
  rel: string;
  ctx: string;
  build: string;
  load_ms: string;
  image_encode_ms: string;
  prompt_tps: string;
  gen_tps: string;
  updated_at: string;
};

type LocalColdStartModule = {
  estimateColdStart: (
    samples: readonly ColdStartSampleT[],
    key: { model: string; node: string },
    opts: { now: () => number; windowMs: number; maxSamples: number },
  ) => ColdStartEstimateT;
  coldStartSamplesFromBenchVision: (
    rows: readonly BenchVisionT[],
    opts: { resolveNode: (machineProfile: string) => string | undefined },
  ) => ColdStartSampleT[];
};

async function load(): Promise<Partial<LocalColdStartModule>> {
  const spec = "../src/cold-start.js";
  try {
    return (await import(spec)) as Partial<LocalColdStartModule>;
  } catch {
    return {};
  }
}

async function loadIndex(): Promise<Partial<LocalColdStartModule>> {
  const spec = "../src/index.js";
  try {
    return (await import(spec)) as Partial<LocalColdStartModule>;
  } catch {
    return {};
  }
}

async function loadEstimate(): Promise<LocalColdStartModule["estimateColdStart"]> {
  const mod = await load();
  expect(typeof mod.estimateColdStart).toBe("function");
  return mod.estimateColdStart!;
}

async function loadFns(): Promise<{
  estimate: LocalColdStartModule["estimateColdStart"];
  adapt: LocalColdStartModule["coldStartSamplesFromBenchVision"];
}> {
  const mod = await load();
  expect(typeof mod.estimateColdStart).toBe("function");
  expect(typeof mod.coldStartSamplesFromBenchVision).toBe("function");
  return {
    estimate: mod.estimateColdStart!,
    adapt: mod.coldStartSamplesFromBenchVision!,
  };
}

const KEY = { model: "m", node: "n" };

const OPTS = { now: (): number => NOW, windowMs: 10_000, maxSamples: 100 };

function sample(
  loadMs: number,
  observedAtMs: number,
  key: { model?: string; node?: string } = {},
): ColdStartSampleT {
  return { model: key.model ?? "m", node: key.node ?? "n", loadMs, observedAtMs };
}

function expectRangeError(fn: () => unknown): void {
  let threwRangeError = false;
  try {
    fn();
  } catch (err) {
    threwRangeError = err instanceof RangeError;
  }
  expect(threwRangeError).toBe(true);
}

describe("estimateColdStart", () => {
  it("returns unknown for empty samples without percentile keys", async () => {
    const estimate = await loadEstimate();
    const est = estimate([], KEY, OPTS);
    expect(est).toEqual({ state: "unknown", model: "m", node: "n", sampleCount: 0 });
    expect("p50Ms" in est).toBe(false);
    expect("p95Ms" in est).toBe(false);
  });

  it("isolates samples by model and node", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [sample(100, NOW, { node: "other-node" }), sample(200, NOW, { model: "other-model" })],
      KEY,
      OPTS,
    );
    expect(est).toEqual({ state: "unknown", model: "m", node: "n", sampleCount: 0 });
  });

  it("computes nearest-rank percentiles on unsorted odd counts", async () => {
    const estimate = await loadEstimate();
    const est = estimate([sample(3000, NOW), sample(1000, NOW), sample(2000, NOW)], KEY, OPTS);
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 2000,
      p95Ms: 3000,
      sampleCount: 3,
    });
  });

  it("uses nearest-rank percentiles on even counts", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [sample(400, NOW), sample(100, NOW), sample(300, NOW), sample(200, NOW)],
      KEY,
      OPTS,
    );
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 200,
      p95Ms: 400,
      sampleCount: 4,
    });
  });

  it("keeps p95 below max on twenty shuffled samples", async () => {
    const estimate = await loadEstimate();
    const loadValues = [
      1300, 400, 1900, 100, 1600, 700, 2000, 300, 1200, 900, 1500, 500, 1800, 1100, 600, 1400, 800,
      1700, 200, 1000,
    ];
    const samples = loadValues.map((loadMs) => sample(loadMs, NOW));
    const est = estimate(samples, KEY, OPTS);
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 1000,
      p95Ms: 1900,
      sampleCount: 20,
    });
  });

  it("includes the window boundary and excludes older and future samples", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [sample(111, NOW - 10_000), sample(222, NOW - 10_001), sample(333, NOW + 1)],
      KEY,
      OPTS,
    );
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 111,
      p95Ms: 111,
      sampleCount: 1,
    });
  });

  it("re-evaluates samples against the injected clock", async () => {
    const estimate = await loadEstimate();
    let nowMs = NOW;
    const clockOpts = { now: (): number => nowMs, windowMs: 10_000, maxSamples: 100 };
    const samples = [sample(700, NOW - 1_000)];
    expect(estimate(samples, KEY, clockOpts)).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 700,
      p95Ms: 700,
      sampleCount: 1,
    });
    nowMs = NOW + 20_000;
    expect(estimate(samples, KEY, clockOpts)).toEqual({
      state: "unknown",
      model: "m",
      node: "n",
      sampleCount: 0,
    });
  });

  it("keeps only the newest maxSamples by observedAtMs", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [
        sample(99999, NOW - 5_000),
        sample(300, NOW),
        sample(400, NOW - 2_000),
        sample(500, NOW - 1_000),
      ],
      KEY,
      { ...OPTS, maxSamples: 2 },
    );
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 300,
      p95Ms: 500,
      sampleCount: 2,
    });
  });

  it("ignores non-positive and non-finite samples", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [
        sample(0, NOW),
        sample(-5, NOW),
        sample(NaN, NOW),
        sample(Infinity, NOW),
        sample(-Infinity, NOW),
        sample(100, NaN),
        sample(100, Infinity),
        sample(-100, -Infinity),
      ],
      KEY,
      OPTS,
    );
    expect(est).toEqual({ state: "unknown", model: "m", node: "n", sampleCount: 0 });
  });

  it("estimates from the valid samples only", async () => {
    const estimate = await loadEstimate();
    const est = estimate(
      [
        sample(0, NOW),
        sample(-5, NOW),
        sample(NaN, NOW),
        sample(Infinity, NOW),
        sample(100, NaN),
        sample(400, NOW - 200),
        sample(200, NOW - 100),
      ],
      KEY,
      OPTS,
    );
    expect(est).toEqual({
      state: "estimated",
      model: "m",
      node: "n",
      p50Ms: 200,
      p95Ms: 400,
      sampleCount: 2,
    });
  });

  it("does not mutate the input array", async () => {
    const estimate = await loadEstimate();
    const samples = [sample(300, NOW), sample(100, NOW - 100), sample(200, NOW - 200)];
    const snapshot = samples.map((s) => ({ ...s }));
    estimate(samples, KEY, OPTS);
    expect(samples).toEqual(snapshot);
  });

  it("rejects invalid options with RangeError", async () => {
    const estimate = await loadEstimate();
    const samples = [sample(100, NOW)];
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, windowMs: 0 }));
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, windowMs: -1 }));
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, windowMs: NaN }));
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, maxSamples: 0 }));
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, maxSamples: 1.5 }));
    expectRangeError(() => estimate(samples, KEY, { ...OPTS, maxSamples: -1 }));
  });
});

function visionRow(fields: {
  machine: string;
  rel: string;
  load_ms: string;
  updated_at: string;
}): BenchVisionT {
  return {
    ctx: "4096",
    build: "fixture-build",
    image_encode_ms: "0",
    prompt_tps: "0",
    gen_tps: "0",
    ...fields,
  };
}

const resolveNode = (machineProfile: string): string | undefined =>
  machineProfile === "profile-a" ? "node-1" : machineProfile === "profile-b" ? "node-2" : undefined;

const resolveNodeOrEmpty = (machineProfile: string): string | undefined => {
  if (machineProfile === "profile-a") return "node-1";
  if (machineProfile === "profile-b") return "node-2";
  if (machineProfile === "profile-empty") return "";
  return undefined;
};

// 1970-01-12T13:46:40Z parses to exactly NOW so adapter output lands inside
// the 10s estimate window; the -2s/-4s rows stay comfortably inside it.
const TS_NOW = "1970-01-12T13:46:40Z";
const TS_NOW_M2S = "1970-01-12T13:46:38Z";
const TS_NOW_M4S = "1970-01-12T13:46:36Z";

describe("coldStartSamplesFromBenchVision", () => {
  it("maps rows to samples keyed by resolved node", async () => {
    const { adapt } = await loadFns();
    const rows: BenchVisionT[] = [
      visionRow({
        machine: "profile-a",
        rel: "fixture/a.gguf",
        load_ms: "1234.5",
        updated_at: "2026-11-01T10:20:30+0100",
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/b.gguf",
        load_ms: "500",
        updated_at: "2026-11-01T10:20:30-0530",
      }),
      visionRow({
        machine: "profile-b",
        rel: "fixture/c.gguf",
        load_ms: "700",
        updated_at: "2026-11-01T12:00:00Z",
      }),
      visionRow({
        machine: "profile-b",
        rel: "fixture/d.gguf",
        load_ms: "900",
        updated_at: "2026-11-01T13:30:00+01:00",
      }),
    ];
    const samples = adapt(rows, { resolveNode });
    expect(samples).toEqual([
      {
        model: "fixture/a.gguf",
        node: "node-1",
        loadMs: 1234.5,
        observedAtMs: Date.UTC(2026, 10, 1, 9, 20, 30),
      },
      {
        model: "fixture/b.gguf",
        node: "node-1",
        loadMs: 500,
        observedAtMs: Date.UTC(2026, 10, 1, 15, 50, 30),
      },
      {
        model: "fixture/c.gguf",
        node: "node-2",
        loadMs: 700,
        observedAtMs: Date.UTC(2026, 10, 1, 12, 0, 0),
      },
      {
        model: "fixture/d.gguf",
        node: "node-2",
        loadMs: 900,
        observedAtMs: Date.UTC(2026, 10, 1, 12, 30, 0),
      },
    ]);
    expect(samples.every((s) => s.node !== "profile-a" && s.node !== "profile-b")).toBe(true);
  });

  it("drops unmappable nodes, absent load times and bad timestamps", async () => {
    const { adapt } = await loadFns();
    const rows: BenchVisionT[] = [
      visionRow({
        machine: "profile-unmapped",
        rel: "fixture/x.gguf",
        load_ms: "500",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-empty",
        rel: "fixture/x.gguf",
        load_ms: "500",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "0",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "abc",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "-3",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "500",
        updated_at: "not-a-date",
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/x.gguf",
        load_ms: "500",
        updated_at: "",
      }),
    ];
    expect(adapt(rows, { resolveNode: resolveNodeOrEmpty })).toEqual([]);
  });

  it("feeds an unknown estimate when every load_ms is the absent default", async () => {
    const { estimate, adapt } = await loadFns();
    const rows: BenchVisionT[] = [
      visionRow({
        machine: "profile-a",
        rel: "fixture/a.gguf",
        load_ms: "0",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/a.gguf",
        load_ms: "0",
        updated_at: TS_NOW_M2S,
      }),
    ];
    const samples = adapt(rows, { resolveNode: resolveNodeOrEmpty });
    expect(estimate(samples, { model: "fixture/a.gguf", node: "node-1" }, OPTS)).toEqual({
      state: "unknown",
      model: "fixture/a.gguf",
      node: "node-1",
      sampleCount: 0,
    });
  });

  it("keeps estimates independent per resolved node", async () => {
    const { estimate, adapt } = await loadFns();
    const rows: BenchVisionT[] = [
      visionRow({
        machine: "profile-a",
        rel: "fixture/a.gguf",
        load_ms: "100",
        updated_at: TS_NOW,
      }),
      visionRow({
        machine: "profile-a",
        rel: "fixture/a.gguf",
        load_ms: "300",
        updated_at: TS_NOW_M2S,
      }),
      visionRow({
        machine: "profile-b",
        rel: "fixture/a.gguf",
        load_ms: "99999",
        updated_at: TS_NOW_M4S,
      }),
    ];
    const samples = adapt(rows, { resolveNode: resolveNodeOrEmpty });
    expect(estimate(samples, { model: "fixture/a.gguf", node: "node-1" }, OPTS)).toEqual({
      state: "estimated",
      model: "fixture/a.gguf",
      node: "node-1",
      p50Ms: 100,
      p95Ms: 300,
      sampleCount: 2,
    });
    expect(estimate(samples, { model: "fixture/a.gguf", node: "node-2" }, OPTS)).toEqual({
      state: "estimated",
      model: "fixture/a.gguf",
      node: "node-2",
      p50Ms: 99999,
      p95Ms: 99999,
      sampleCount: 1,
    });
  });
});

describe("package exports", () => {
  it("re-exports both cold-start helpers from src/index.js", async () => {
    const mod = await loadIndex();
    expect(typeof mod.estimateColdStart).toBe("function");
    expect(typeof mod.coldStartSamplesFromBenchVision).toBe("function");
  });
});
