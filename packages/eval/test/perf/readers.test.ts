// RED pins for #521: `createPerfHostReaders` builds the perf suite's
// per-engine host readers (I/O counters, peak RSS) for a pid+platform,
// and `runPerfSuite` honours caller-supplied `readerReasons` when a
// reader is absent. The factory is resolved dynamically because
// src/perf/readers.ts does not exist at base — a static import would
// crash the file instead of failing an assertion.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../../src/matrix/types.js";
import type { PerfSuiteOptions, PerfSuiteReaders } from "../../src/perf/runner.js";
import type { FakeEngine, FakeEngineOptions, ManualClock } from "./fake-engine.js";

import * as evalIndex from "../../src/index.js";
import { createManualClock, startFakeEngine } from "./fake-engine.js";

const RUN_ID = "run-perf-host-readers";

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

type CreatePerfHostReaders = (opts: {
  pid: number | null;
  platform: NodeJS.Platform;
  readFile: (path: string) => Promise<string>;
}) => { readers: PerfSuiteReaders; reasons: { io?: string; peakRss?: string } };

function hostReaders(): CreatePerfHostReaders {
  const fn = (evalIndex as Record<string, unknown>)["createPerfHostReaders"];
  expect(typeof fn).toBe("function");
  return fn as CreatePerfHostReaders;
}

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

function metricOf(rows: PerfRunRow[], name: string): MetricValue {
  const row = rows.find((r) => r.metric_name === name);
  if (row === undefined) throw new Error(`missing perf metric ${name}`);
  return row.metric;
}

describe("createPerfHostReaders", () => {
  const engines: FakeEngine[] = [];

  function startEngine(opts: FakeEngineOptions): FakeEngine {
    const engine = startFakeEngine(opts);
    engines.push(engine);
    return engine;
  }

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
  });

  test("linux reads /proc/<pid>/io read_bytes/write_bytes", async () => {
    // Kills: reading /proc/self/io, using rchar/wchar, or not
    //        delegating to parseProcIo.
    const paths: string[] = [];
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "linux",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("rchar: 1\nwchar: 2\nread_bytes: 8192\nwrite_bytes: 4096\n");
      },
    });
    expect(typeof readers.io).toBe("function");
    expect(await readers.io!()).toEqual({ readBytes: 8192, writeBytes: 4096 });
    expect(paths).toEqual(["/proc/4242/io"]);
    expect(reasons.io).toBeUndefined();
  });

  test("linux peakRss reads VmHWM from /proc/<pid>/status in bytes", async () => {
    // Kills: reading VmRSS instead of VmHWM, or a kB->bytes slip.
    const paths: string[] = [];
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "linux",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("Name:\tllama-server\nVmHWM:\t  204800 kB\nVmRSS:\t 1024 kB\n");
      },
    });
    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBe(204800 * 1024);
    expect(paths).toEqual(["/proc/4242/status"]);
  });

  test("darwin returns no io/peakRss reader and names the platform", () => {
    // Kills: returning Linux /proc readers on darwin, or omitting the
    //        platform reason.
    const paths: string[] = [];
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("");
      },
    });
    expect(readers.io).toBeUndefined();
    expect(readers.peakRss).toBeUndefined();
    expect(reasons.io).toMatch(/darwin/);
    expect(reasons.io).toMatch(/\/proc\/<pid>\/io|Linux-only/i);
    expect(reasons.peakRss).toMatch(/VmHWM/);
    expect(reasons.peakRss).toMatch(/darwin/);
    expect(paths).toEqual([]);
  });

  test("unknown pid yields no readers with an engine-PID reason", () => {
    // Kills: falling back to /proc/self when the engine pid is unknown,
    //        and accepting 0, negative or non-integer pids as valid.
    for (const pid of [null, 0, -1, 1.5]) {
      const { readers, reasons } = hostReaders()({
        pid,
        platform: "linux",
        readFile: () => Promise.resolve(""),
      });
      expect(readers.io).toBeUndefined();
      expect(readers.peakRss).toBeUndefined();
      expect(reasons.io).toMatch(/engine PID unknown/i);
      expect(reasons.peakRss).toMatch(/engine PID unknown/i);
    }
  });

  test("a failed read yields null, not a throw and not 0", async () => {
    // Kills: a mutant that lets the readFile rejection propagate or
    //        coerces the failure to 0.
    const enoent = new Error("ENOENT: no such file or directory, open '/proc/4242/io'");
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "linux",
      readFile: () => Promise.reject(enoent),
    });
    expect(typeof readers.io).toBe("function");
    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.io!()).toBeNull();
    expect(await readers.peakRss!()).toBeNull();
  });

  test("end-to-end with runPerfSuite records real deltas on linux and darwin reasons otherwise", async () => {
    // Kills: host readers that read the CLI's own /proc/self counters
    //        instead of the engine pid's, record 0 for missing readers,
    //        or drop readerReasons on non-linux platforms.
    const clock = createManualClock();
    const fake = startEngine(engineOpts(clock));
    const client = evalIndex.createHttpPerfEngineClient(fake.url, { clock });

    const ioTexts = [
      "rchar: 1\nwchar: 2\nread_bytes: 1000\nwrite_bytes: 10\n",
      "rchar: 1\nwchar: 2\nread_bytes: 5000\nwrite_bytes: 30\n",
    ];
    let ioReads = 0;
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "linux",
      readFile: (path) => {
        if (path === "/proc/4242/io") {
          const text = ioTexts[Math.min(ioReads, ioTexts.length - 1)] ?? "";
          ioReads += 1;
          return Promise.resolve(text);
        }
        if (path === "/proc/4242/status") {
          return Promise.resolve("Name:\tllama-server\nVmHWM:\t  1000 kB\nVmRSS:\t 100 kB\n");
        }
        return Promise.reject(new Error(`unexpected proc read: ${path}`));
      },
    });
    const opts: PerfSuiteOptions = {
      run_id: RUN_ID,
      model_name: "fake-model",
      provenance: PROVENANCE,
      client,
      clock,
      ...{ readers, readerReasons: reasons },
    };

    const linuxDb = new Database(":memory:");
    try {
      await evalIndex.runPerfSuite(linuxDb, opts);
      const rows = evalIndex.listPerfRuns(linuxDb, { run_id: RUN_ID });
      expect(metricOf(rows, "ssd_read_bytes")).toEqual({ value: 4000, status: "ok" });
      expect(metricOf(rows, "ssd_write_bytes")).toEqual({ value: 20, status: "ok" });
      expect(metricOf(rows, "peak_rss_bytes")).toEqual({ value: 1000 * 1024, status: "ok" });
    } finally {
      linuxDb.close();
    }

    const darwinClock = createManualClock();
    const darwinFake = startEngine(engineOpts(darwinClock));
    const darwinClient = evalIndex.createHttpPerfEngineClient(darwinFake.url, {
      clock: darwinClock,
    });
    const darwinHost = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.reject(new Error("darwin host readers must not read /proc")),
    });
    const darwinOpts: PerfSuiteOptions = {
      run_id: RUN_ID,
      model_name: "fake-model",
      provenance: PROVENANCE,
      client: darwinClient,
      clock: darwinClock,
      ...{ readers: darwinHost.readers, readerReasons: darwinHost.reasons },
    };

    const darwinDb = new Database(":memory:");
    try {
      await evalIndex.runPerfSuite(darwinDb, darwinOpts);
      const rows = evalIndex.listPerfRuns(darwinDb, { run_id: RUN_ID });
      for (const name of ["ssd_read_bytes", "ssd_write_bytes", "peak_rss_bytes"] as const) {
        const metric = metricOf(rows, name);
        expect(metric.status).toBe("unavailable");
        if (metric.status === "unavailable") {
          expect(metric.value).toBeNull();
          expect(metric.reason).toMatch(/darwin/);
        }
      }
      expect(rows.filter((row) => row.metric.status === "ok" && row.metric.value === 0)).toEqual(
        [],
      );
    } finally {
      darwinDb.close();
    }
  });
});
