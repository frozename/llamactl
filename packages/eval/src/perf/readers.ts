import type { ProcPidRusage } from "./darwin-rusage.js";
import type { IoByteCounts } from "./normalise.js";
import type { PerfSuiteReaders } from "./runner.js";

import { readFile as fsReadFile } from "../safe-fs-promises.js";
import { defaultProcPidRusage } from "./darwin-rusage.js";
import {
  decodeRusageInfoV2Io,
  decodeRusageInfoV4LifetimeMaxFootprint,
  parseProcIo,
  parseVmHwm,
  RUSAGE_INFO_V2,
  RUSAGE_INFO_V2_SIZE,
  RUSAGE_INFO_V4,
  RUSAGE_INFO_V4_SIZE,
  rusageIo,
} from "./normalise.js";

export type { ProcPidRusage } from "./darwin-rusage.js";

/**
 * Per-reader unavailable reasons injected by `runPerfSuite` when a
 * reader is absent or returns no sample. The CLI bench-schedule
 * runner populates these so every unavailable metric names why.
 */
export interface PerfSuiteReaderReasons {
  io?: string;
  peakRss?: string;
  gtt?: string;
}

/**
 * Options for `createPerfHostReaders`.
 *
 * `pid` must be a positive safe integer for the engine process; pass
 * `null` when the engine PID is unknown (I/O and VmHWM need it). A
 * getter `() => number | null` is resolved on every read, so the
 * caller can supply a live pid that changes between cold and warm
 * boots.
 *
 * `platform` defaults to `process.platform`; override it in tests.
 * `readFile` defaults to the package safe-fs `readFile(path, 'utf8')`
 * (a `node:fs/promises` re-export).
 *
 * `procPidRusage` is the macOS `proc_pid_rusage` call used by the darwin I/O
 * and peak-RSS readers; it defaults to `defaultProcPidRusage()` and tests
 * inject a fake.
 */
export interface PerfHostReaderOptions {
  pid: number | null | (() => number | null);
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  procPidRusage?: ProcPidRusage;
}

/**
 * Build per-engine host readers for I/O and peak RSS.
 *
 * Linux reads `/proc/<pid>/io` and `VmHWM`. macOS reads both through
 * `proc_pid_rusage`: I/O with `RUSAGE_INFO_V2`, peak RSS with
 * `RUSAGE_INFO_V4`'s `ri_lifetime_max_phys_footprint`. Any other platform gets
 * no reader and names the platform in its reason.
 *
 * This function never sets `gtt` — GTT stays caller-injected
 * (probeGpuGtt lives in fleet-supervisor, which eval does not
 * depend on). The CLI bench-schedule runner passes
 * `readerReasons.gtt` so `runPerfSuite` can report
 * 'GTT counters unavailable' when no reader is present.
 */
export function createPerfHostReaders(opts: PerfHostReaderOptions): {
  readers: PerfSuiteReaders;
  reasons: PerfSuiteReaderReasons;
} {
  const platform = opts.platform ?? process.platform;
  const readFile = opts.readFile ?? ((path: string): Promise<string> => fsReadFile(path, "utf8"));

  const reasons: PerfSuiteReaderReasons = {};

  // Unknown / invalid PID: cannot build /proc/<pid> paths.
  // A getter is resolved on every read, so a function pid is never
  // treated as unknown here.
  if (
    !(typeof opts.pid === "function") &&
    (opts.pid === null || !Number.isSafeInteger(opts.pid) || opts.pid <= 0)
  ) {
    reasons.io =
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id";
    reasons.peakRss = reasons.io;
    return { readers: {}, reasons };
  }

  // Build a livePid that resolves the numeric pid (or calls the getter and
  // throws) so each reader can call it OUTSIDE its try/catch, on every
  // platform that has a reader.
  const livePid = (): number => {
    const raw = typeof opts.pid === "function" ? opts.pid() : opts.pid;
    if (raw === null || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new Error("engine PID not known when the reader ran");
    }
    return raw;
  };

  const readers: PerfSuiteReaders = {};

  // macOS: /proc is absent, so proc_pid_rusage supplies both counters: the
  // disk I/O bytes through RUSAGE_INFO_V2 and the lifetime peak physical
  // footprint (macOS's own peak-memory accounting) through RUSAGE_INFO_V4.
  if (platform === "darwin") {
    const call = opts.procPidRusage ?? defaultProcPidRusage();
    readers.io = async (): Promise<IoByteCounts | null> => {
      const pid = livePid();
      try {
        const buffer = new Uint8Array(RUSAGE_INFO_V2_SIZE);
        const rc = await call(pid, RUSAGE_INFO_V2, buffer);
        if (rc !== 0) return null;
        const counts = decodeRusageInfoV2Io(buffer);
        return counts === null ? null : rusageIo(counts);
      } catch {
        return null;
      }
    };
    readers.peakRss = async (): Promise<number | null> => {
      const pid = livePid();
      try {
        const buffer = new Uint8Array(RUSAGE_INFO_V4_SIZE);
        const rc = await call(pid, RUSAGE_INFO_V4, buffer);
        if (rc !== 0) return null;
        return decodeRusageInfoV4LifetimeMaxFootprint(buffer);
      } catch {
        return null;
      }
    };
    return { readers, reasons };
  }

  // Off Linux and off macOS there is neither /proc/<pid>/io nor
  // proc_pid_rusage, so no reader is built.
  if (platform !== "linux") {
    reasons.io = `per-process disk I/O counters are read from /proc/<pid>/io on Linux and proc_pid_rusage on macOS; no I/O reader on ${platform}`;
    reasons.peakRss = `VmHWM (/proc/<pid>/status) is Linux-only; no peak-RSS reader on ${platform}`;
    return { readers: {}, reasons };
  }

  // Linux: wire up readers that delegate to parseProcIo / parseVmHwm,
  // wrapping each in try/catch so a rejection returns null.
  readers.io = async (): Promise<IoByteCounts | null> => {
    const pid = livePid();
    try {
      return parseProcIo(await readFile(`/proc/${String(pid)}/io`));
    } catch {
      return null;
    }
  };

  readers.peakRss = async (): Promise<number | null> => {
    const pid = livePid();
    try {
      return parseVmHwm(await readFile(`/proc/${String(pid)}/status`));
    } catch {
      return null;
    }
  };

  return { readers, reasons };
}
