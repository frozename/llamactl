import type { IoByteCounts } from "./normalise.js";
import type { PerfSuiteReaders } from "./runner.js";

import { readFile as fsReadFile } from "../safe-fs-promises.js";
import { parseProcIo, parseVmHwm } from "./normalise.js";

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
 * `null` when the engine PID is unknown (I/O and VmHWM need it).
 * `platform` defaults to `process.platform`; override it in tests.
 * `readFile` defaults to the package safe-fs `readFile(path, 'utf8')`
 * (a `node:fs/promises` re-export).
 */
export interface PerfHostReaderOptions {
  pid: number | null;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
}

/**
 * Build per-engine host readers for I/O and peak RSS on Linux.
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
  if (opts.pid === null || !Number.isSafeInteger(opts.pid) || opts.pid <= 0) {
    reasons.io =
      "engine PID unknown; per-process I/O and VmHWM counters need the engine process id";
    reasons.peakRss = reasons.io;
    return { readers: {}, reasons };
  }

  // Non-Linux: /proc/<pid>/io and VmHWM are Linux-only.
  if (platform !== "linux") {
    reasons.io = `per-process disk I/O counters (/proc/<pid>/io) are Linux-only; ${platform} needs proc_pid_rusage, which this build does not read`;
    reasons.peakRss = `VmHWM (/proc/<pid>/status) is Linux-only; no peak-RSS reader on ${platform}`;
    return { readers: {}, reasons };
  }

  const pid = opts.pid;

  // Linux: wire up readers that delegate to parseProcIo / parseVmHwm,
  // wrapping each in try/catch so a rejection returns null.
  const readers: PerfSuiteReaders = {};

  readers.io = async (): Promise<IoByteCounts | null> => {
    try {
      return parseProcIo(await readFile(`/proc/${String(pid)}/io`));
    } catch {
      return null;
    }
  };

  readers.peakRss = async (): Promise<number | null> => {
    try {
      return parseVmHwm(await readFile(`/proc/${String(pid)}/status`));
    } catch {
      return null;
    }
  };

  return { readers, reasons };
}
