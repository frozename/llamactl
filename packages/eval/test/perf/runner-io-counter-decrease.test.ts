// RED pins for #521: a process restart can make the end I/O counter lower
// than the start counter. Either counter decreasing invalidates both derived
// metrics; clamping the negative delta to zero would record a false measurement.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../../src/matrix/types.js";
import type { IoByteCounts } from "../../src/perf/normalise.js";
import type { PerfSuiteReaders } from "../../src/perf/runner.js";
import type { FakeEngine, FakeEngineOptions, ManualClock } from "./fake-engine.js";

import { listPerfRuns } from "../../src/matrix/store.js";
import { createHttpPerfEngineClient } from "../../src/perf/client.js";
import { runPerfSuite } from "../../src/perf/runner.js";
import { createManualClock, startFakeEngine } from "./fake-engine.js";

const RUN_ID = "run-perf-io-counter-decrease";

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

function engineOpts(clock: ManualClock): FakeEngineOptions {
  return {
    clock,
    ctx: 40960,
    acceptance: "llamacpp",
    ttftMs: 250,
    tokenMs: 20,
    promptTps: 900,
    decodeTps: 50,
  };
}

function metricOf(rows: PerfRunRow[], name: string): MetricValue {
  const row = rows.find((r) => r.metric_name === name);
  if (row === undefined) throw new Error(`missing perf metric ${name}`);
  return row.metric;
}

function decreaseReason(io0: IoByteCounts, io1: IoByteCounts): string {
  return `I/O counters decreased between the start and end samples (read_bytes ${String(
    io0.readBytes,
  )} -> ${String(io1.readBytes)}, write_bytes ${String(io0.writeBytes)} -> ${String(
    io1.writeBytes,
  )}); the sampled process likely restarted`;
}

function decreasedMetric(reason: string): MetricValue {
  return { value: null, status: "unavailable", reason };
}

describe("runPerfSuite I/O counter decreases", () => {
  let db: Database;
  const engines: FakeEngine[] = [];

  function startEngine(opts: FakeEngineOptions): FakeEngine {
    const engine = startFakeEngine(opts);
    engines.push(engine);
    return engine;
  }

  async function runScenario(
    io0: IoByteCounts,
    io1: IoByteCounts,
  ): Promise<{ rows: PerfRunRow[]; ioCalls: number }> {
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = createHttpPerfEngineClient(fake.url, { clock });
    let ioCalls = 0;
    const readers: PerfSuiteReaders = {
      io: () => {
        ioCalls += 1;
        return ioCalls === 1 ? io0 : io1;
      },
    };

    await runPerfSuite(db, {
      run_id: RUN_ID,
      model_name: "fake-model",
      provenance: PROVENANCE,
      client,
      clock,
      readers,
      prefillReason: "prefill is outside the I/O counter-decrease slice",
      decodeTokens: 1,
      concurrencyPromptWords: 4,
    });

    return { rows: listPerfRuns(db, { run_id: RUN_ID }), ioCalls };
  }

  function expectBothSsdMetrics(rows: PerfRunRow[], expected: MetricValue): void {
    expect(metricOf(rows, "ssd_read_bytes")).toEqual(expected);
    expect(metricOf(rows, "ssd_write_bytes")).toEqual(expected);
  }

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    db.close();
  });

  test("D1 read and write decreases mark both ssd metrics unavailable", async () => {
    const io0 = { readBytes: 5000, writeBytes: 30 };
    const io1 = { readBytes: 1000, writeBytes: 10 };

    const { rows, ioCalls } = await runScenario(io0, io1);

    expect(ioCalls).toBe(2);
    expectBothSsdMetrics(rows, decreasedMetric(decreaseReason(io0, io1)));
  });

  test("D2 a read-only decrease marks both ssd metrics unavailable", async () => {
    const io0 = { readBytes: 5000, writeBytes: 10 };
    const io1 = { readBytes: 1000, writeBytes: 30 };

    const { rows, ioCalls } = await runScenario(io0, io1);

    expect(ioCalls).toBe(2);
    expectBothSsdMetrics(rows, decreasedMetric(decreaseReason(io0, io1)));
  });

  test("D3 a write-only decrease marks both ssd metrics unavailable", async () => {
    const io0 = { readBytes: 1000, writeBytes: 30 };
    const io1 = { readBytes: 5000, writeBytes: 10 };

    const { rows, ioCalls } = await runScenario(io0, io1);

    expect(ioCalls).toBe(2);
    expectBothSsdMetrics(rows, decreasedMetric(decreaseReason(io0, io1)));
  });

  test("D4 listPerfRuns never exposes a decreased counter as a zero value", async () => {
    const io0 = { readBytes: 5000, writeBytes: 30 };
    const io1 = { readBytes: 1000, writeBytes: 10 };

    const { ioCalls } = await runScenario(io0, io1);
    const rows = listPerfRuns(db, { run_id: RUN_ID });

    expect(ioCalls).toBe(2);
    for (const metricName of ["ssd_read_bytes", "ssd_write_bytes"]) {
      const selected = rows.filter((row) => row.metric_name === metricName);
      expect(selected).toHaveLength(1);
      for (const row of selected) {
        expect(row.metric).toEqual(decreasedMetric(decreaseReason(io0, io1)));
      }
    }
  });

  test("G1 guard: equal start and end counters record a genuine zero delta", async () => {
    const { rows, ioCalls } = await runScenario(
      { readBytes: 7, writeBytes: 7 },
      { readBytes: 7, writeBytes: 7 },
    );

    expect(ioCalls).toBe(2);
    expect(metricOf(rows, "ssd_read_bytes")).toEqual({ value: 0, status: "ok" });
    expect(metricOf(rows, "ssd_write_bytes")).toEqual({ value: 0, status: "ok" });
  });

  test("G2 guard: increasing counters record their deltas", async () => {
    const { rows, ioCalls } = await runScenario(
      { readBytes: 1000, writeBytes: 10 },
      { readBytes: 5000, writeBytes: 30 },
    );

    expect(ioCalls).toBe(2);
    expect(metricOf(rows, "ssd_read_bytes")).toEqual({ value: 4000, status: "ok" });
    expect(metricOf(rows, "ssd_write_bytes")).toEqual({ value: 20, status: "ok" });
  });
});
