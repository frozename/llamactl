import type { dlopen } from "bun:ffi";

/**
 * Seam for `proc_pid_rusage(pid, flavor, buffer)`: it fills the caller's buffer
 * and returns 0 on success. Tests inject a fake.
 */
export type ProcPidRusage = (
  pid: number,
  flavor: number,
  buffer: Uint8Array,
) => number | Promise<number>;

const PROC_PID_RUSAGE_SYMBOLS = {
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
} as const;

type ProcPidRusageLibrary = ReturnType<typeof dlopen<typeof PROC_PID_RUSAGE_SYMBOLS>>;

interface ProcPidRusageHandle {
  // Holding the library open keeps the symbol valid for later reads.
  library: ProcPidRusageLibrary;
  call(pid: number, flavor: number, buffer: Uint8Array): number;
}

let handle: Promise<ProcPidRusageHandle> | null = null;

/**
 * The default `proc_pid_rusage` for macOS host readers, backed by libSystem
 * through `bun:ffi`. The library opens on the first call, so Linux runs and the
 * app bundle never load `bun:ffi`.
 */
export function defaultProcPidRusage(): ProcPidRusage {
  return async (pid, flavor, buffer) => {
    handle ??= (async (): Promise<ProcPidRusageHandle> => {
      const ffi = await import("bun:ffi");
      const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", PROC_PID_RUSAGE_SYMBOLS);
      return {
        library,
        call: (callPid, callFlavor, callBuffer) =>
          library.symbols.proc_pid_rusage(callPid, callFlavor, ffi.ptr(callBuffer)),
      };
    })();
    return (await handle).call(pid, flavor, buffer);
  };
}
