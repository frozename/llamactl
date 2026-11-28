// RED pins for #521: macOS per-process SSD I/O comes from the
// proc_pid_rusage seam, using RUSAGE_INFO_V2 and the ri_diskio byte
// counters. The seam is injected everywhere except the explicitly named
// head-only guard, so no RED case reaches the real FFI.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../../src/matrix/types.js";
import type { PerfSuiteOptions, PerfSuiteReaders } from "../../src/perf/runner.js";
import type { FakeEngine, FakeEngineOptions, ManualClock } from "./fake-engine.js";

import * as evalIndex from "../../src/index.js";
import { createManualClock, startFakeEngine } from "./fake-engine.js";

type ProcPidRusage = (pid: number, flavor: number, buffer: Uint8Array) => number | Promise<number>;

type CreatePerfHostReaders = (opts: {
  pid: number | null | (() => number | null);
  platform: NodeJS.Platform;
  readFile: (path: string) => Promise<string>;
  procPidRusage?: ProcPidRusage;
}) => { readers: PerfSuiteReaders; reasons: { io?: string; peakRss?: string } };

function hostReaders(): CreatePerfHostReaders {
  const fn = (evalIndex as Record<string, unknown>)["createPerfHostReaders"];
  expect(typeof fn).toBe("function");
  return fn as CreatePerfHostReaders;
}

interface RusageCall {
  pid: number;
  flavor: number;
  byteLength: number;
}

function writeRusage(buffer: Uint8Array, readBytes: bigint, writeBytes: bigint): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setBigUint64(144, readBytes, true);
  view.setBigUint64(152, writeBytes, true);
}

function createRusageFake(
  readBytes: bigint,
  writeBytes: bigint,
  rc = 0,
): {
  procPidRusage: ProcPidRusage;
  calls: RusageCall[];
} {
  const calls: RusageCall[] = [];
  const procPidRusage: ProcPidRusage = (pid, flavor, buffer) => {
    calls.push({ pid, flavor, byteLength: buffer.byteLength });
    writeRusage(buffer, readBytes, writeBytes);
    return rc;
  };
  return { procPidRusage, calls };
}

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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("#521 darwin SSD I/O via proc_pid_rusage", () => {
  const engines: FakeEngine[] = [];

  function startEngine(opts: FakeEngineOptions): FakeEngine {
    const engine = startFakeEngine(opts);
    engines.push(engine);
    return engine;
  }

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
  });

  test("R1 darwin decodes little-endian disk counters at the rusage offsets", async () => {
    // Kills: no darwin io reader, the wrong flavor, offsets other than
    //        144/152, or reading /proc on darwin.
    const paths: string[] = [];
    const fake = createRusageFake(12288n, 8192n);
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("");
      },
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 12288, writeBytes: 8192 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.pid).toBe(4242);
    expect(fake.calls[0]?.flavor).toBe(2);
    expect(fake.calls[0]?.byteLength).toBeGreaterThanOrEqual(160);
    expect(paths).toEqual([]);
  });

  test("R2 darwin clears both reader reasons and builds a peakRss reader", () => {
    // Kills: keeping the stale io or peakRss platform reasons, or leaving
    //        peak RSS without a macOS rusage reader.
    const fake = createRusageFake(1n, 1n);
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(reasons.io).toBeUndefined();
    expect(reasons.peakRss).toBeUndefined();
    expect(typeof readers.peakRss).toBe("function");
  });

  test("R3 a non-zero proc_pid_rusage return resolves null", async () => {
    // Kills: decoding a failed call as zeros, or throwing for a non-zero rc.
    const fake = createRusageFake(1n, 1n, -1);
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toBeNull();
  });

  test("R4 a throwing proc_pid_rusage loader resolves null", async () => {
    // Kills: an uncaught loader error escaping the reader.
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: () => {
        throw new Error("dlopen failed");
      },
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toBeNull();
  });

  test("R5 a counter outside the safe integer range resolves null", async () => {
    // Kills: lossy BigInt-to-Number conversion.
    const fake = createRusageFake(2n ** 53n + 1n, 1n);
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toBeNull();
  });

  test("R6 each io read resolves the live pid getter", async () => {
    // Kills: caching the pid, or swallowing the missing pid.
    let currentPid: number | null = 1111;
    const fake = createRusageFake(8n, 4n);
    const { readers } = hostReaders()({
      pid: () => currentPid,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 8, writeBytes: 4 });
    currentPid = 2222;
    expect(await readers.io!()).toEqual({ readBytes: 8, writeBytes: 4 });
    expect(fake.calls.map((call) => call.pid)).toEqual([1111, 2222]);

    currentPid = null;
    const err = await rejectionOf(Promise.resolve().then(() => readers.io!()));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("engine PID not known when the reader ran");
    expect(fake.calls).toHaveLength(2);
  });

  test("R7 win32 keeps the cross-platform no-io reason and never calls rusage", () => {
    // Kills: building the darwin reader for every non-Linux platform, or
    //        keeping the old reason.
    const fake = createRusageFake(1n, 1n);
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "win32",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(reasons.io).toBe(
      "per-process disk I/O counters are read from /proc/<pid>/io on Linux and proc_pid_rusage on macOS; no I/O reader on win32",
    );
  });

  test("R8 runPerfSuite records increasing darwin rusage deltas", async () => {
    // Kills: the reader not reaching the suite, or a reversed diff order.
    const clock = createManualClock();
    const engine = startEngine(engineOpts(clock));
    const client = evalIndex.createHttpPerfEngineClient(engine.url, { clock });
    let ioCalls = 0;
    const procPidRusage: ProcPidRusage = (_pid, flavor, buffer) => {
      if (flavor === 4) {
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        view.setBigUint64(240, 3221225472n, true);
        return 0;
      }
      if (flavor !== 2) return -1;
      const first = ioCalls === 0;
      ioCalls += 1;
      writeRusage(buffer, first ? 1000n : 5000n, first ? 10n : 30n);
      return 0;
    };
    const host = hostReaders()({
      pid: 4242,
      platform: "darwin",
      readFile: () => Promise.reject(new Error("darwin host readers must not read /proc")),
      procPidRusage,
    });
    const opts: PerfSuiteOptions = {
      run_id: "run-darwin-rusage",
      model_name: "fake-model",
      provenance: PROVENANCE,
      client,
      clock,
      ...{ readers: host.readers, readerReasons: host.reasons },
    };

    const db = new Database(":memory:");
    try {
      await evalIndex.runPerfSuite(db, opts);
      const rows = evalIndex.listPerfRuns(db, { run_id: "run-darwin-rusage" });
      expect(metricOf(rows, "ssd_read_bytes")).toEqual({ status: "ok", value: 4000 });
      expect(metricOf(rows, "ssd_write_bytes")).toEqual({ status: "ok", value: 20 });
      expect(metricOf(rows, "peak_rss_bytes")).toEqual({ status: "ok", value: 3221225472 });
    } finally {
      db.close();
    }
  });

  test("G1 guard: linux still reads /proc/<pid>/io and never calls rusage", async () => {
    // Kills: routing Linux through proc_pid_rusage.
    const paths: string[] = [];
    const fake = createRusageFake(1n, 1n);
    const { readers } = hostReaders()({
      pid: 4242,
      platform: "linux",
      readFile: (path) => {
        paths.push(path);
        return Promise.resolve("read_bytes: 8192\nwrite_bytes: 4096\n");
      },
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 8192, writeBytes: 4096 });
    expect(paths).toEqual(["/proc/4242/io"]);
    expect(fake.calls).toEqual([]);
  });

  test("G2 guard: a null darwin pid keeps the engine-PID reason and never calls rusage", () => {
    // Kills: calling proc_pid_rusage before validating the pid.
    const fake = createRusageFake(1n, 1n);
    const { readers, reasons } = hostReaders()({
      pid: null,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.io).toBeUndefined();
    expect(reasons.io).toBe(
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id",
    );
    expect(fake.calls).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin")(
    "S1 guard (head only): the default darwin reader reads only this process counters",
    async () => {
      // Kills: eagerly loading bun:ffi or reading a process other than the
      //        requested pid. On base io is absent, so this is not RED evidence.
      const { readers } = hostReaders()({
        pid: process.pid,
        platform: "darwin",
        readFile: () => Promise.resolve(""),
      });

      expect(readers.io).toBeDefined();
      const sample = await readers.io!();
      expect(sample).not.toBeNull();
      if (sample !== null) {
        expect(Number.isFinite(sample.readBytes)).toBe(true);
        expect(sample.readBytes).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(sample.writeBytes)).toBe(true);
        expect(sample.writeBytes).toBeGreaterThanOrEqual(0);
      }
    },
  );
});
