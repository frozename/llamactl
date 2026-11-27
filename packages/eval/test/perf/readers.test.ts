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
  procPidRusage?: (pid: number, flavor: number, buffer: Uint8Array) => number | Promise<number>;
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

  test("darwin reads SSD I/O through proc_pid_rusage but keeps peakRss platform-only", async () => {
    // Kills: returning Linux /proc readers on darwin, omitting the io reader,
    //        or inventing a macOS VmHWM reader.
    const paths: string[] = [];
    const rusageCalls: number[] = [];
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("");
      },
      procPidRusage: (pid, _flavor, buffer) => {
        rusageCalls.push(pid);
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        view.setBigUint64(144, 1n, true);
        view.setBigUint64(152, 1n, true);
        return 0;
      },
    });
    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 1, writeBytes: 1 });
    expect(rusageCalls).toEqual([4242]);
    expect(readers.peakRss).toBeUndefined();
    expect(reasons.io).toBeUndefined();
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

  test("end-to-end with runPerfSuite records real linux and darwin SSD deltas", async () => {
    // Kills: host readers that read the CLI's own counters instead of the
    //        engine pid's, record 0 for missing readers, or drop the
    //        remaining peakRss reader reason on darwin.
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
    let darwinRusageCalls = 0;
    const darwinHost = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.reject(new Error("darwin host readers must not read /proc")),
      procPidRusage: (_pid, _flavor, buffer) => {
        const first = darwinRusageCalls === 0;
        darwinRusageCalls += 1;
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        view.setBigUint64(144, first ? 1000n : 5000n, true);
        view.setBigUint64(152, first ? 10n : 30n, true);
        return 0;
      },
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
      expect(metricOf(rows, "ssd_read_bytes")).toEqual({ status: "ok", value: 4000 });
      expect(metricOf(rows, "ssd_write_bytes")).toEqual({ status: "ok", value: 20 });
      const peakRss = metricOf(rows, "peak_rss_bytes");
      expect(peakRss.status).toBe("unavailable");
      if (peakRss.status === "unavailable") {
        expect(peakRss.value).toBeNull();
        expect(peakRss.reason).toMatch(/darwin/);
      }
      expect(rows.filter((row) => row.metric.status === "ok" && row.metric.value === 0)).toEqual(
        [],
      );
    } finally {
      darwinDb.close();
    }
  });
});

type LivePidHostReaderOptions = Omit<Parameters<CreatePerfHostReaders>[0], "pid"> & {
  pid: () => number | null;
};

function livePidOpts(opts: LivePidHostReaderOptions): Parameters<CreatePerfHostReaders>[0] {
  return opts as unknown as Parameters<CreatePerfHostReaders>[0];
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("#521 createPerfHostReaders live pid getter", () => {
  test("linux resolves the getter when each reader runs", async () => {
    // Kills: snapshotting the pid when the readers are built, or treating
    //        a getter as an unknown pid.
    const paths: string[] = [];
    let current = 10;
    const { readers } = hostReaders()(
      livePidOpts({
        pid: () => current,
        platform: "linux",
        readFile: (path) => {
          paths.push(path);
          if (path.endsWith("/status")) return Promise.resolve("VmHWM:\t    2048 kB");
          if (path.endsWith("/io")) return Promise.resolve("read_bytes: 8\nwrite_bytes: 4\n");
          return Promise.reject(new Error(`unexpected proc read: ${path}`));
        },
      }),
    );
    current = 20;

    expect(readers.peakRss).toBeDefined();
    expect(await readers.peakRss!()).toBe(2097152);
    expect(paths).toEqual(["/proc/20/status"]);

    paths.length = 0;
    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 8, writeBytes: 4 });
    expect(paths).toEqual(["/proc/20/io"]);
  });

  test("linux a null getter result rejects when the reader runs", async () => {
    // Kills: swallowing the missing pid into a null return, which would
    //        become the misleading 'returned no sample'.
    const { readers } = hostReaders()(
      livePidOpts({
        pid: () => null,
        platform: "linux",
        readFile: () => Promise.resolve(""),
      }),
    );

    expect(readers.peakRss).toBeDefined();
    const peakErr = await rejectionOf(Promise.resolve().then(() => readers.peakRss!()));
    expect(peakErr).toBeInstanceOf(Error);
    expect((peakErr as Error).message).toBe("engine PID not known when the reader ran");

    expect(readers.io).toBeDefined();
    const ioErr = await rejectionOf(Promise.resolve().then(() => readers.io!()));
    expect(ioErr).toBeInstanceOf(Error);
    expect((ioErr as Error).message).toBe("engine PID not known when the reader ran");
  });

  test("darwin keeps only the peakRss platform reason for a live pid getter", () => {
    // Kills: running the PID-unknown branch for a getter, or treating a live
    //        darwin pid as though proc_pid_rusage were unavailable.
    const { reasons } = hostReaders()(
      livePidOpts({
        pid: () => 5,
        platform: "darwin",
        readFile: () => Promise.resolve(""),
        procPidRusage: (_pid, _flavor, buffer) => {
          const view = new DataView(buffer.buffer, buffer.byteOffset);
          view.setBigUint64(144, 1n, true);
          view.setBigUint64(152, 1n, true);
          return 0;
        },
      }),
    );

    expect(reasons.peakRss).toBe(
      "VmHWM (/proc/<pid>/status) is Linux-only; no peak-RSS reader on darwin",
    );
    expect(reasons.io).toBeUndefined();
  });

  test("guard: numeric null pid keeps the engine-PID-unknown reason", () => {
    // Kills: dropping the existing unknown-pid contract while adding live
    //        getters.
    const { readers, reasons } = hostReaders()({
      pid: null,
      platform: "linux",
      readFile: () => Promise.resolve(""),
    });

    expect(readers.io).toBeUndefined();
    expect(readers.peakRss).toBeUndefined();
    expect(reasons.io).toBe(
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id",
    );
    expect(reasons.peakRss).toBe(
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id",
    );
  });
});
