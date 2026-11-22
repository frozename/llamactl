import { parseGttCounters } from "@llamactl/core/resources/memory";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../../src/matrix/types.js";
import type { PerfEngineClient, PerfToken } from "../../src/perf/client.js";
import type {
  PerfSuiteLoadHooks,
  PerfSuiteOptions,
  PerfSuiteReaders,
} from "../../src/perf/runner.js";
import type { FakeEngine, FakeEngineOptions, ManualClock } from "./fake-engine.js";

import { listPerfRuns } from "../../src/matrix/store.js";
import { createHttpPerfEngineClient } from "../../src/perf/client.js";
import { PERF_METRIC_NAMES } from "../../src/perf/metrics.js";
import { runPerfSuite } from "../../src/perf/runner.js";
import { createManualClock, startFakeEngine } from "./fake-engine.js";

const RUN_ID = "run-perf-suite";

const PROVENANCE: EvalProvenance = {
  engine: "llamacpp",
  engine_version: "b1-mtp",
  engine_commit: "0123abcd",
  binary_sha256: "ab".repeat(32),
  gguf_sha256: "cd".repeat(32),
  hf_revision: "main@deadbeef",
  quant: "Q4_K_M",
  ctx: 40960,
  flags: ["-np", "2", "-c", "40960"],
  host: "test-host",
};

function engineOpts(
  clock: ManualClock,
  overrides: Partial<FakeEngineOptions> = {},
): FakeEngineOptions {
  return {
    clock,
    ctx: 40960,
    acceptance: "llamacpp",
    ttftMs: 250,
    tokenMs: 20,
    promptTps: 900,
    decodeTps: 50,
    ...overrides,
  };
}

function suiteOpts(args: {
  client: PerfEngineClient;
  clock: ManualClock;
  slots?: number | null;
  load?: PerfSuiteLoadHooks;
  readers?: PerfSuiteReaders;
  provenance?: EvalProvenance;
}): PerfSuiteOptions {
  return {
    run_id: RUN_ID,
    model_name: "fake-model",
    provenance: args.provenance ?? PROVENANCE,
    client: args.client,
    clock: args.clock,
    ...(args.slots === undefined ? {} : { slots: args.slots }),
    ...(args.load === undefined ? {} : { load: args.load }),
    ...(args.readers === undefined ? {} : { readers: args.readers }),
  };
}

function metricOf(rows: PerfRunRow[], name: string): MetricValue {
  const row = rows.find((r) => r.metric_name === name);
  if (row === undefined) throw new Error(`missing perf metric ${name}`);
  return row.metric;
}

function expectOk(metric: MetricValue): number {
  expect(metric.status).toBe("ok");
  if (metric.status !== "ok") throw new Error("expected an ok metric");
  return metric.value;
}

function expectUnavailable(metric: MetricValue, pattern: RegExp): void {
  expect(metric.status).toBe("unavailable");
  if (metric.status !== "unavailable") throw new Error("expected an unavailable metric");
  expect(metric.value).toBeNull();
  expect(metric.reason).toMatch(pattern);
}

function unavailableReason(metric: MetricValue): string {
  expect(metric.status).toBe("unavailable");
  if (metric.status !== "unavailable") throw new Error("expected an unavailable metric");
  expect(metric.value).toBeNull();
  return metric.reason;
}

function expectMetricNames(rows: PerfRunRow[]): void {
  const names = rows.map((row) => row.metric_name).sort();
  expect(names).toEqual([...PERF_METRIC_NAMES].sort());
}

function promptWordCount(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const prompt = (body as Record<string, unknown>)["prompt"];
  if (typeof prompt !== "string") return 0;
  return prompt.split(/\s+/).filter((word) => word.length > 0).length;
}

describe("runPerfSuite", () => {
  let db: Database;
  const engines: FakeEngine[] = [];

  function startEngine(opts: FakeEngineOptions): FakeEngine {
    const engine = startFakeEngine(opts);
    engines.push(engine);
    return engine;
  }

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    db.close();
  });

  test("records every perf metric against a llamacpp fake engine", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    let ioCalls = 0;
    const readers: PerfSuiteReaders = {
      io: () => {
        ioCalls += 1;
        return ioCalls === 1
          ? { readBytes: 1000, writeBytes: 10 }
          : { readBytes: 5000, writeBytes: 30 };
      },
      peakRss: () => 2_000_000_000,
      gtt: () => parseGttCounters("8000", "3000", { source: "fixture", observedAtMs: 0 }),
    };
    const load: PerfSuiteLoadHooks = {
      cold: () => {
        clock.advance(9000);
        return Promise.resolve();
      },
      warm: () => {
        clock.advance(1500);
        return Promise.resolve();
      },
    };

    await runPerfSuite(db, suiteOpts({ client, clock, slots: 2, load, readers }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    for (const row of rows) {
      expect(row.suite_name).toBe("perf");
      expect(row.provenance).toEqual(PROVENANCE);
    }

    expect(metricOf(rows, "load_cold_ms")).toEqual({ value: 9000, status: "ok" });
    expect(metricOf(rows, "load_warm_ms")).toEqual({ value: 1500, status: "ok" });
    for (const name of ["prefill_4k_tps", "prefill_16k_tps", "prefill_32k_tps"]) {
      expect(metricOf(rows, name)).toEqual({ value: 900, status: "ok" });
    }

    const completions = fake.requests.filter((request) => request.path === "/v1/completions");
    expect(completions).toHaveLength(3);
    const wordCounts = completions
      .map((request) => promptWordCount(request.body))
      .sort((a, b) => a - b);
    expect(wordCounts).toEqual([4096, 16384, 32768]);

    expectUnavailable(metricOf(rows, "prefill_64k_tps"), /context/i);
    expect(metricOf(rows, "decode_tps")).toEqual({ value: 50, status: "ok" });

    const ttft = metricOf(rows, "ttft_ms");
    expect(ttft.status).toBe("ok");
    if (ttft.status === "ok") {
      expect(ttft.value).toBeGreaterThanOrEqual(250);
      expect(ttft.value).toBeLessThan(250 + 20 * 64);
    }

    expect(metricOf(rows, "spec_acceptance")).toEqual({ value: 0.75, status: "ok" });
    for (const name of ["c1_tps", "c2_tps"]) {
      expect(expectOk(metricOf(rows, name))).toBeGreaterThan(0);
    }
    expectUnavailable(metricOf(rows, "c4_tps"), /slots/i);

    expect(metricOf(rows, "ssd_read_bytes")).toEqual({ value: 4000, status: "ok" });
    expect(metricOf(rows, "ssd_write_bytes")).toEqual({ value: 20, status: "ok" });
    expect(metricOf(rows, "peak_rss_bytes")).toEqual({ value: 2_000_000_000, status: "ok" });
    expect(metricOf(rows, "peak_gtt_bytes")).toEqual({ value: 3000, status: "ok" });
  });

  test("stores provenance with its unavailable reasons intact on every row", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const partialProvenance: EvalProvenance = {
      ...PROVENANCE,
      quant: null,
      engine_commit: null,
      unavailable: {
        quant: "quant could not be read from the gguf header",
        engine_commit: "engine --version printed no commit",
      },
    };

    await runPerfSuite(db, suiteOpts({ client, clock, provenance: partialProvenance }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    for (const row of rows) {
      expect(row.provenance).toEqual(partialProvenance);
      expect(row.provenance.unavailable).toEqual({
        quant: "quant could not be read from the gguf header",
        engine_commit: "engine --version printed no commit",
      });
    }
  });

  test("samples GTT across phases and records the true peak", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const readers: PerfSuiteReaders = {
      gtt: () => parseGttCounters("8000", "5000", { source: "fixture", observedAtMs: 0 }),
    };

    await runPerfSuite(db, suiteOpts({ client, clock, readers }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "peak_gtt_bytes")).toEqual({ value: 5000, status: "ok" });
  });

  test("marks spec_acceptance unavailable when the engine reports no draft metrics", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { acceptance: "none" }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expectUnavailable(metricOf(rows, "spec_acceptance"), /no draft acceptance/i);

    const row = db
      .query(
        "SELECT metric_value, metric_status FROM perf_runs WHERE run_id = ? AND metric_name = 'spec_acceptance'",
      )
      .get(RUN_ID) as { metric_value: number | null; metric_status: string } | null;
    expect(row).not.toBeNull();
    expect(row!.metric_value).toBeNull();
    expect(row!.metric_status).toBe("unavailable");
  });

  test("marks load, io, memory and multi-slot metrics unavailable without hooks, readers or slots", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock, slots: null }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expectUnavailable(metricOf(rows, "load_cold_ms"), /load hooks/i);
    expectUnavailable(metricOf(rows, "load_warm_ms"), /load hooks/i);
    expectUnavailable(metricOf(rows, "ssd_read_bytes"), /I\/O reader/i);
    expectUnavailable(metricOf(rows, "ssd_write_bytes"), /I\/O reader/i);
    expectUnavailable(metricOf(rows, "peak_rss_bytes"), /VmHWM/i);
    expectUnavailable(metricOf(rows, "peak_gtt_bytes"), /GTT/i);
    expectUnavailable(metricOf(rows, "c2_tps"), /slots/i);
    expectUnavailable(metricOf(rows, "c4_tps"), /slots/i);
    expect(expectOk(metricOf(rows, "c1_tps"))).toBeGreaterThan(0);
    expect(rows.filter((row) => row.metric.status === "ok" && row.metric.value === 0)).toEqual([]);
  });

  test("normalises gufo usage fields for acceptance and decode", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { acceptance: "gufo" }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(expectOk(metricOf(rows, "spec_acceptance"))).toBeCloseTo(0.787, 3);
    expect(metricOf(rows, "decode_tps")).toEqual({ value: 50, status: "ok" });
  });

  test("marks every prefill metric unavailable when the tokenize endpoint is missing", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { tokenize: "missing" }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    for (const name of [
      "prefill_4k_tps",
      "prefill_16k_tps",
      "prefill_32k_tps",
      "prefill_64k_tps",
    ]) {
      expectUnavailable(metricOf(rows, name), /tokeniz/i);
    }
    expect(metricOf(rows, "decode_tps").status).toBe("ok");
    expect(metricOf(rows, "ttft_ms").status).toBe("ok");
    expect(metricOf(rows, "c1_tps").status).toBe("ok");
  });

  test("marks a rejected prefill unavailable with the engine HTTP status", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { rejectPromptAbove: 20000 }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "prefill_4k_tps").status).toBe("ok");
    expect(metricOf(rows, "prefill_16k_tps").status).toBe("ok");

    const rejected = metricOf(rows, "prefill_32k_tps");
    expectUnavailable(rejected, /failed/i);
    if (rejected.status === "unavailable") {
      expect(rejected.reason).toContain("400");
    }
    expect(metricOf(rows, "decode_tps").status).toBe("ok");
  });

  test("marks prefill unavailable when tokenization is not exact", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { tokenize: "inexact" }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expectUnavailable(metricOf(rows, "prefill_4k_tps"), /token-exact/i);
  });

  test("marks prefill unavailable when engine prompt_tokens differs from target by more than 8", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { promptTokenOverride: 1000 }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expectUnavailable(metricOf(rows, "prefill_4k_tps"), /engine counted/);
    expect(metricOf(rows, "decode_tps").status).toBe("ok");
  });

  test("records prefill normally when engine prompt_tokens differs by 8 or fewer", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { promptTokenOffset: 8 }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "prefill_4k_tps").status).toBe("ok");
  });

  test("records sizes above ctx from /v1/models as unavailable", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { ctx: 40960 }));
    const client = createHttpPerfEngineClient(fake.url, { clock });

    await runPerfSuite(db, suiteOpts({ client, clock }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "prefill_4k_tps").status).toBe("ok");
    expect(metricOf(rows, "prefill_16k_tps").status).toBe("ok");
    expect(metricOf(rows, "prefill_32k_tps").status).toBe("ok");
    expectUnavailable(metricOf(rows, "prefill_64k_tps"), /context/i);
  });

  test("marks all prefill sizes unavailable when model context is unknown", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock, { ctx: 0, noCtxFields: true }));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const emptyProvenance: EvalProvenance = {
      engine: "llamacpp",
      engine_version: "v1",
      engine_commit: "aaaa1111",
      binary_sha256: "ff".repeat(32),
      gguf_sha256: "ee".repeat(32),
      hf_revision: "main@00000000",
      quant: "Q8_0",
      ctx: null,
      flags: [],
      host: "test-host",
    };

    await runPerfSuite(db, suiteOpts({ client, clock, provenance: emptyProvenance }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    for (const name of [
      "prefill_4k_tps",
      "prefill_16k_tps",
      "prefill_32k_tps",
      "prefill_64k_tps",
    ]) {
      expectUnavailable(metricOf(rows, name), /context unknown/i);
    }
  });

  test("falls back to /v1/models context when provenance and opts ctx are absent", async () => {
    const clock = createManualClock();
    const ctxValue = 40960;
    const fake = startEngine(
      engineOpts(clock, { ctx: ctxValue, noCtxFields: false, acceptance: "llamacpp" }),
    );
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const emptyProvenance: EvalProvenance = {
      engine: "llamacpp",
      engine_version: "v1",
      engine_commit: "aaaa1111",
      binary_sha256: "ff".repeat(32),
      gguf_sha256: "ee".repeat(32),
      hf_revision: "main@00000000",
      quant: "Q8_0",
      ctx: null,
      flags: [],
      host: "test-host",
    };

    await runPerfSuite(db, suiteOpts({ client, clock, provenance: emptyProvenance }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "prefill_4k_tps").status).toBe("ok");
    expect(metricOf(rows, "prefill_16k_tps").status).toBe("ok");
    expect(metricOf(rows, "prefill_32k_tps").status).toBe("ok");
    expectUnavailable(metricOf(rows, "prefill_64k_tps"), /context/i);
  });

  test("reports peak GTT from the highest sample across all phases", async () => {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    let phaseIndex = 0;
    const gttValues = [1000, 3000, 9000, 2000, 4000, 1500, 2500, 1200, 1100, 1000];
    const readers: PerfSuiteReaders = {
      gtt: () => {
        const value = gttValues[phaseIndex] ?? gttValues[gttValues.length - 1];
        phaseIndex += 1;
        return parseGttCounters(String(value), String(value), {
          source: "fixture",
          observedAtMs: 0,
        });
      },
    };

    await runPerfSuite(db, suiteOpts({ client, clock, readers }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(metricOf(rows, "peak_gtt_bytes")).toEqual({ value: 9000, status: "ok" });
  });

  test("records caller-supplied reasons when a reader is absent", async () => {
    // Kills: runPerfSuite ignoring PerfSuiteOptions.readerReasons and
    //        falling back to the hardcoded platform strings.
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const opts = {
      ...suiteOpts({ client, clock, slots: null }),
      readerReasons: {
        io: "io-reason-X",
        peakRss: "rss-reason-Y",
        gtt: "gtt-reason-Z",
      },
    } as PerfSuiteOptions;

    await runPerfSuite(db, opts);

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    expect(unavailableReason(metricOf(rows, "ssd_read_bytes"))).toBe("io-reason-X");
    expect(unavailableReason(metricOf(rows, "ssd_write_bytes"))).toBe("io-reason-X");
    expect(unavailableReason(metricOf(rows, "peak_rss_bytes"))).toBe("rss-reason-Y");
    expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe("gtt-reason-Z");
  });

  test("a present reader that returns no sample is not reported as a missing reader", async () => {
    // Kills: collapsing absent-reader and failed-reader into the same
    //        'for this platform' / hardcoded reason.
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    const readers: PerfSuiteReaders = {
      io: () => null,
      peakRss: () => null,
      gtt: () => null,
    };

    await runPerfSuite(db, suiteOpts({ client, clock, readers }));

    const rows = listPerfRuns(db, { run_id: RUN_ID });
    expectMetricNames(rows);
    const ssdRead = metricOf(rows, "ssd_read_bytes");
    expectUnavailable(ssdRead, /I\/O reader returned no sample/i);
    expect(unavailableReason(ssdRead)).not.toMatch(/for this platform/);
    expectUnavailable(
      metricOf(rows, "peak_rss_bytes"),
      /peak-RSS \(VmHWM\) reader returned no sample/i,
    );
    expectUnavailable(metricOf(rows, "peak_gtt_bytes"), /GTT reader returned no sample/i);
  });

  describe("#521 slotsReason", () => {
    test("uses opts.slotsReason for the unknown-slots concurrency reason (kills: the runner ignoring slotsReason)", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const opts = {
        ...suiteOpts({ client, clock, slots: null }),
        slotsReason: "slots-reason-Q",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "c2_tps"))).toBe("slots-reason-Q");
      expect(unavailableReason(metricOf(rows, "c4_tps"))).toBe("slots-reason-Q");
      expect(metricOf(rows, "c1_tps").status).toBe("ok");
    });

    test("guard: without slotsReason the unknown-slots reason stays the legacy text", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });

      await runPerfSuite(db, suiteOpts({ client, clock, slots: null }));

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "c2_tps"))).toBe(
        "engine slots unknown (slot count not provided)",
      );
    });

    test("guard: a numeric slots wins over slotsReason", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const opts = {
        ...suiteOpts({ client, clock, slots: 2 }),
        slotsReason: "ignored",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(metricOf(rows, "c2_tps").status).toBe("ok");
      expect(unavailableReason(metricOf(rows, "c4_tps"))).toBe("engine slots 2 < concurrency 4");
    });
  });

  describe("#521 prefillReason", () => {
    test("records opts.prefillReason for every prefill size without calling tokenize", async () => {
      // Kills: the runner ignoring prefillReason, or checking it only
      //        after buildTokenExactPrompt.
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      let tokenizeCalls = 0;
      const counted = {
        ...client,
        tokenize: (c: string): Promise<PerfToken[]> => {
          tokenizeCalls += 1;
          return client.tokenize(c);
        },
      };
      const opts = {
        ...suiteOpts({ client: counted, clock }),
        prefillReason: "prefill-reason-Q",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      for (const name of [
        "prefill_4k_tps",
        "prefill_16k_tps",
        "prefill_32k_tps",
        "prefill_64k_tps",
      ]) {
        expect(unavailableReason(metricOf(rows, name))).toBe("prefill-reason-Q");
      }
      expect(tokenizeCalls).toBe(0);
      expect(metricOf(rows, "decode_tps").status).toBe("ok");
      expect(metricOf(rows, "c1_tps").status).toBe("ok");
    });

    test("prefillReason wins over an unknown model context", async () => {
      // Kills: placing the prefillReason check after the `ctx === null` check.
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock, { ctx: 0, noCtxFields: true }));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const emptyProvenance: EvalProvenance = {
        engine: "llamacpp",
        engine_version: "v1",
        engine_commit: "aaaa1111",
        binary_sha256: "ff".repeat(32),
        gguf_sha256: "ee".repeat(32),
        hf_revision: "main@00000000",
        quant: "Q8_0",
        ctx: null,
        flags: [],
        host: "test-host",
      };
      const opts = {
        ...suiteOpts({ client, clock, provenance: emptyProvenance }),
        prefillReason: "prefill-reason-Q",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      for (const name of [
        "prefill_4k_tps",
        "prefill_16k_tps",
        "prefill_32k_tps",
        "prefill_64k_tps",
      ]) {
        const reason = unavailableReason(metricOf(rows, name));
        expect(reason).toBe("prefill-reason-Q");
        expect(reason).not.toBe("model context unknown");
      }
    });

    test("guard: without prefillReason a normal engine still records prefill ok", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });

      await runPerfSuite(db, suiteOpts({ client, clock }));

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(metricOf(rows, "prefill_4k_tps").status).toBe("ok");
    });
  });

  describe("#521 loadReason", () => {
    test("uses opts.loadReason for missing load hooks (kills: the runner ignoring opts.loadReason)", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const opts = {
        ...suiteOpts({ client, clock }),
        loadReason: "load-reason-Q",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "load_cold_ms"))).toBe("load-reason-Q");
      expect(unavailableReason(metricOf(rows, "load_warm_ms"))).toBe("load-reason-Q");
    });

    test("applies loadReason per missing hook (kills: applying loadReason only when the whole load object is absent)", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const opts = {
        ...suiteOpts({
          client,
          clock,
          load: {
            cold: () => {
              clock.advance(9000);
              return Promise.resolve();
            },
          },
        }),
        loadReason: "load-reason-W",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(metricOf(rows, "load_cold_ms")).toEqual({ value: 9000, status: "ok" });
      expect(unavailableReason(metricOf(rows, "load_warm_ms"))).toBe("load-reason-W");
    });

    test("guard: without loadReason the missing-hook reasons stay the legacy text", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });

      await runPerfSuite(db, suiteOpts({ client, clock }));

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "load_cold_ms"))).toBe(
        "no load hooks injected (engine not managed by the suite)",
      );
      expect(unavailableReason(metricOf(rows, "load_warm_ms"))).toBe(
        "no load hooks injected (engine not managed by the suite)",
      );
    });

    test("guard: a present load hook wins over loadReason", async () => {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      const opts = {
        ...suiteOpts({
          client,
          clock,
          load: {
            cold: () => {
              clock.advance(9000);
              return Promise.resolve();
            },
            warm: () => {
              clock.advance(1500);
              return Promise.resolve();
            },
          },
        }),
        loadReason: "ignored-load-reason",
      } as PerfSuiteOptions;

      await runPerfSuite(db, opts);

      const rows = listPerfRuns(db, { run_id: RUN_ID });
      expectMetricNames(rows);
      expect(metricOf(rows, "load_cold_ms")).toEqual({ value: 9000, status: "ok" });
      expect(metricOf(rows, "load_warm_ms")).toEqual({ value: 1500, status: "ok" });
    });
  });

  describe("#521 host reader failure reasons", () => {
    async function runWithReaders(readers: PerfSuiteReaders): Promise<PerfRunRow[]> {
      const clock = createManualClock();
      const fake = startEngine(engineOpts(clock));
      const client = createHttpPerfEngineClient(fake.url, { clock });
      await runPerfSuite(db, suiteOpts({ client, clock, readers }));
      return listPerfRuns(db, { run_id: RUN_ID });
    }

    test("a denied GTT observation records its status (kills: the bare 'returned no sample' string for every non-ok observation)", async () => {
      const rows = await runWithReaders({
        gtt: () => ({
          status: "denied",
          totalBytes: null,
          usedBytes: null,
          observedAtMs: null,
          source: "",
          scope: "shared",
        }),
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe(
        "GTT reader returned no sample (status: denied)",
      );
    });

    test("a non-ok GTT observation with a source records status and source (kills: dropping the source clause)", async () => {
      const rows = await runWithReaders({
        gtt: () => ({
          status: "unavailable",
          totalBytes: null,
          usedBytes: null,
          observedAtMs: null,
          source: "/sys/class/drm/card1/device",
          scope: "shared",
        }),
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe(
        "GTT reader returned no sample (status: unavailable, source: /sys/class/drm/card1/device)",
      );
    });

    test("a throwing GTT reader records the failure message (kills: mapping a GTT throw back to 'returned no sample')", async () => {
      const rows = await runWithReaders({
        gtt: () => {
          throw new Error("gtt-boom");
        },
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe(
        "GTT reader failed: gtt-boom",
      );
    });

    test("an ok GTT observation without usedBytes records status and usedBytes (kills: the bare string for an ok observation with no bytes)", async () => {
      const rows = await runWithReaders({
        gtt: () => ({
          status: "ok",
          totalBytes: 8000,
          usedBytes: null,
          observedAtMs: 0,
          source: "fixture",
          scope: "shared",
        }),
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe(
        "GTT reader returned no sample (status: ok, usedBytes: null)",
      );
    });

    test("guard: an ok GTT sample still wins the peak fold over an earlier non-ok sample", async () => {
      let gttCalls = 0;
      const rows = await runWithReaders({
        gtt: () => {
          gttCalls += 1;
          return gttCalls === 1
            ? {
                status: "denied",
                totalBytes: null,
                usedBytes: null,
                observedAtMs: null,
                source: "",
                scope: "shared",
              }
            : {
                status: "ok",
                totalBytes: 8000,
                usedBytes: 777,
                observedAtMs: 0,
                source: "fixture",
                scope: "shared",
              };
        },
      });

      expectMetricNames(rows);
      expect(metricOf(rows, "peak_gtt_bytes")).toEqual({ value: 777, status: "ok" });
    });

    test("a throwing I/O reader records the failure message on both ssd metrics (kills: swallowing the I/O throw)", async () => {
      const rows = await runWithReaders({
        io: () => {
          throw new Error("io-boom");
        },
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "ssd_read_bytes"))).toBe(
        "I/O reader failed: io-boom",
      );
      expect(unavailableReason(metricOf(rows, "ssd_write_bytes"))).toBe(
        "I/O reader failed: io-boom",
      );
    });

    test("an I/O throw at the end sample records the failure message (kills: checking only the start sample's failure)", async () => {
      let ioCalls = 0;
      const rows = await runWithReaders({
        io: () => {
          ioCalls += 1;
          if (ioCalls === 1) return { readBytes: 1, writeBytes: 1 };
          throw new Error("io-end-boom");
        },
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "ssd_read_bytes"))).toBe(
        "I/O reader failed: io-end-boom",
      );
      expect(unavailableReason(metricOf(rows, "ssd_write_bytes"))).toBe(
        "I/O reader failed: io-end-boom",
      );
    });

    test("when both I/O samples throw the start sample's message wins (kills: preferring io1's failure over io0's)", async () => {
      let ioCalls = 0;
      const rows = await runWithReaders({
        io: () => {
          ioCalls += 1;
          throw new Error(ioCalls === 1 ? "io-start" : "io-end");
        },
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "ssd_read_bytes"))).toBe(
        "I/O reader failed: io-start",
      );
      expect(unavailableReason(metricOf(rows, "ssd_write_bytes"))).toBe(
        "I/O reader failed: io-start",
      );
    });

    test("a throwing peak-RSS reader records the failure message (kills: mapping a peak-RSS throw back to 'returned no sample')", async () => {
      const rows = await runWithReaders({
        peakRss: () => {
          throw new Error("rss-boom");
        },
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "peak_rss_bytes"))).toBe(
        "peak-RSS (VmHWM) reader failed: rss-boom",
      );
    });

    test("guard: readers that resolve null keep the exact legacy no-sample strings", async () => {
      const rows = await runWithReaders({
        io: () => null,
        peakRss: () => null,
        gtt: () => null,
      });

      expectMetricNames(rows);
      expect(unavailableReason(metricOf(rows, "ssd_read_bytes"))).toBe(
        "I/O reader returned no sample",
      );
      expect(unavailableReason(metricOf(rows, "ssd_write_bytes"))).toBe(
        "I/O reader returned no sample",
      );
      expect(unavailableReason(metricOf(rows, "peak_rss_bytes"))).toBe(
        "peak-RSS (VmHWM) reader returned no sample",
      );
      expect(unavailableReason(metricOf(rows, "peak_gtt_bytes"))).toBe(
        "GTT reader returned no sample",
      );
    });
  });
});
