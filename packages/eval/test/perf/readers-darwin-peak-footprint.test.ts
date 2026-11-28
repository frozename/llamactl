// RED pins for #521: macOS peak RSS comes from proc_pid_rusage with
// RUSAGE_INFO_V4 and ri_lifetime_max_phys_footprint. The proc_pid_rusage
// seam is injected in every case, so no test reaches the real FFI.

import { describe, expect, test } from "bun:test";

import type { PerfSuiteReaders } from "../../src/perf/runner.js";

import * as evalIndex from "../../src/index.js";

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

interface RusageFakeOptions {
  flavor4Rc?: number;
  flavor4Value?: bigint;
  throwError?: Error;
}

function writePeakFootprint(buffer: Uint8Array, value: bigint): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  view.setBigUint64(72, 111n, true);
  view.setBigUint64(240, value, true);
  view.setBigUint64(280, 999n, true);
}

function createRusageFake(options: RusageFakeOptions = {}): {
  procPidRusage: ProcPidRusage;
  calls: RusageCall[];
} {
  const calls: RusageCall[] = [];
  const procPidRusage: ProcPidRusage = (pid, flavor, buffer) => {
    calls.push({ pid, flavor, byteLength: buffer.byteLength });
    if (options.throwError !== undefined) throw options.throwError;
    if (flavor === 4 && buffer.byteLength >= 296) {
      writePeakFootprint(buffer, options.flavor4Value ?? 3221225472n);
      return options.flavor4Rc ?? 0;
    }
    if (flavor === 2) {
      const view = new DataView(buffer.buffer, buffer.byteOffset);
      view.setBigUint64(144, 12288n, true);
      view.setBigUint64(152, 8192n, true);
      return 0;
    }
    return -1;
  };
  return { procPidRusage, calls };
}

function darwinHost(procPidRusage: ProcPidRusage): {
  readers: PerfSuiteReaders;
  reasons: { io?: string; peakRss?: string };
} {
  return hostReaders()({
    pid: 4242,
    platform: "darwin",
    readFile: () => Promise.resolve(""),
    procPidRusage,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("#521 darwin peak RSS via proc_pid_rusage RUSAGE_INFO_V4", () => {
  test("F1 darwin builds a peakRss reader and clears its platform reason", () => {
    // Kills: keeping the readers.ts:102-103 Linux-only reason on darwin.
    const fake = createRusageFake();
    const { readers, reasons } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(reasons.peakRss).toBeUndefined();
  });

  test("F2 the reader decodes ri_lifetime_max_phys_footprint from a 296-byte V4 buffer", async () => {
    // Kills: using V2 or an undersized buffer, or decoding offset 72 or 280.
    const fake = createRusageFake();
    const { readers } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBe(3221225472);
    expect(fake.calls).toEqual([{ pid: 4242, flavor: 4, byteLength: 296 }]);
  });

  test("F3 a non-zero rusage return resolves null", async () => {
    // Kills: decoding an unfilled buffer.
    const fake = createRusageFake({ flavor4Rc: 1 });
    const { readers } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBeNull();
  });

  test("F4 a throwing rusage loader resolves null rather than rejecting", async () => {
    // Kills: letting loader errors escape.
    const fake = createRusageFake({ throwError: new Error("dlopen failed") });
    const { readers } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBeNull();
  });

  test("F5 a zero lifetime maximum resolves null", async () => {
    // Kills: coercing an unfilled counter to 0.
    const fake = createRusageFake({ flavor4Value: 0n });
    const { readers } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBeNull();
  });

  test("F6 a counter outside the safe integer range resolves null", async () => {
    // Kills: a lossy Number() conversion.
    const fake = createRusageFake({ flavor4Value: 2n ** 53n });
    const { readers } = darwinHost(fake.procPidRusage);

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBeNull();
  });

  test("F7a each peakRss read resolves the live pid getter", async () => {
    // Kills: caching the pid.
    let currentPid: number | null = 1111;
    const fake = createRusageFake();
    const { readers } = hostReaders()({
      pid: () => currentPid,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(typeof readers.peakRss).toBe("function");
    expect(await readers.peakRss!()).toBe(3221225472);
    currentPid = 2222;
    expect(await readers.peakRss!()).toBe(3221225472);
    expect(fake.calls).toEqual([
      { pid: 1111, flavor: 4, byteLength: 296 },
      { pid: 2222, flavor: 4, byteLength: 296 },
    ]);
  });

  test("F7b a null getter result rejects with the engine-PID message", async () => {
    // Kills: swallowing the unknown pid into null.
    const fake = createRusageFake();
    const { readers } = hostReaders()({
      pid: () => null,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(typeof readers.peakRss).toBe("function");
    const err = await rejectionOf(Promise.resolve().then(() => readers.peakRss!()));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("engine PID not known when the reader ran");
    expect(fake.calls).toEqual([]);
  });

  test("G1 guard: the io reader keeps using flavor 2 with a 160-byte buffer", async () => {
    // Kills: regressing the existing darwin SSD I/O reader while adding peak RSS.
    const fake = createRusageFake();
    const { readers } = darwinHost(fake.procPidRusage);

    expect(readers.io).toBeDefined();
    expect(await readers.io!()).toEqual({ readBytes: 12288, writeBytes: 8192 });
    expect(fake.calls).toEqual([{ pid: 4242, flavor: 2, byteLength: 160 }]);
  });

  test("G2 guard: win32 keeps the exact no-peak-RSS platform reason", () => {
    // Kills: moving the macOS rusage reader onto the other-platform branch.
    const fake = createRusageFake();
    const { readers, reasons } = hostReaders()({
      pid: 4242,
      platform: "win32",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.peakRss).toBeUndefined();
    expect(reasons.peakRss).toBe(
      "VmHWM (/proc/<pid>/status) is Linux-only; no peak-RSS reader on win32",
    );
    expect(fake.calls).toEqual([]);
  });

  test("G3 guard: a null darwin pid keeps the exact engine-PID reason", () => {
    // Kills: calling proc_pid_rusage before validating the pid.
    const fake = createRusageFake();
    const { readers, reasons } = hostReaders()({
      pid: null,
      platform: "darwin",
      readFile: () => Promise.resolve(""),
      procPidRusage: fake.procPidRusage,
    });

    expect(readers.peakRss).toBeUndefined();
    expect(reasons.peakRss).toBe(
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id",
    );
    expect(fake.calls).toEqual([]);
  });
});
