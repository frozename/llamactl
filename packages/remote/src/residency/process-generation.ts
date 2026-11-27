import type {
  GenerationRecord,
  ProcessObservation,
} from "@llamactl/core/residency/generation-evidence";
import type { dlopen, ptr } from "bun:ffi";

import { readFileSync } from "../safe-fs.js";
import { type AdmissionAuthority, openAdmissionAuthority } from "./admission-authority.js";
import { AuthorityUnavailableError } from "./admission-store.js";

type ReadBirthId = (pid: number) => string | undefined;

export function linuxProcessStartTicks(stat: string, pid: number): string | undefined {
  const commEnd = stat.lastIndexOf(") ");
  if (commEnd < 0 || !stat.startsWith(`${String(pid)} (`)) return undefined;
  // Field 3 is the process state. Field 22 is start time relative to boot.
  const startTicks = stat
    .slice(commEnd + 2)
    .trim()
    .split(/\s+/)[19];
  return startTicks !== undefined && /^\d+$/.test(startTicks) ? startTicks : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function linuxReader(): ReadBirthId {
  const boot = readText("/proc/sys/kernel/random/boot_id")?.trim();
  if (boot === undefined || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(boot)) {
    return () => undefined;
  }
  return (pid) => {
    const stat = readText(`/proc/${String(pid)}/stat`);
    const start = stat === undefined ? undefined : linuxProcessStartTicks(stat, pid);
    return start === undefined ? undefined : `linux:${boot}:${start}`;
  };
}

const PROC_PID_TBSD_INFO = 3;
const BSD_INFO_BYTES = 136;
const DARWIN_PROCESS_INFO = {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
} as const;
type ProcessInfoLibrary = ReturnType<typeof dlopen<typeof DARWIN_PROCESS_INFO>>;

let darwinHandle: Promise<ReadBirthId> | undefined;

function makeDarwinReader(library: ProcessInfoLibrary, pointer: typeof ptr): ReadBirthId {
  return (pid) => {
    // struct proc_bsdinfo from <sys/proc_info.h> on Darwin's 64-bit ABI.
    const bytes = new Uint8Array(BSD_INFO_BYTES);
    const written = library.symbols.proc_pidinfo(
      pid,
      PROC_PID_TBSD_INFO,
      0n,
      pointer(bytes),
      bytes.byteLength,
    );
    if (written !== BSD_INFO_BYTES) return undefined;
    const view = new DataView(bytes.buffer);
    if (view.getUint32(12, true) !== pid) return undefined;
    const seconds = view.getBigUint64(120, true);
    const micros = view.getBigUint64(128, true);
    if (seconds === 0n || micros > 999999n) return undefined;
    return `darwin:${String(seconds)}:${String(micros)}`;
  };
}

async function nativeBirthReader(): Promise<ReadBirthId> {
  if (process.platform === "linux") return linuxReader();
  if (process.platform !== "darwin") return () => undefined;
  darwinHandle ??= (async (): Promise<ReadBirthId> => {
    const ffi = await import("bun:ffi");
    return makeDarwinReader(ffi.dlopen("/usr/lib/libSystem.B.dylib", DARWIN_PROCESS_INFO), ffi.ptr);
  })();
  return await darwinHandle;
}

function observeLocalGeneration(
  pid: number,
  readBirth: ReadBirthId,
  known: GenerationRecord | undefined,
): ProcessObservation | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return undefined;
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH certifies absence of the PID now. Only previously recorded
    // native identity ties that observation to a particular generation.
    if (code === "ESRCH" && known?.pid === pid && known.birthId !== undefined) {
      return { pid, birthId: known.birthId, alive: false };
    }
    return undefined;
  }
  const birthId = readBirth(pid);
  return birthId === undefined ? undefined : { pid, birthId, alive: true };
}

export interface LocalAdmissionRuntime {
  authority: AdmissionAuthority;
  capture(pid: number): GenerationRecord | undefined;
}

export async function openLocalAdmissionRuntime(opts: {
  storePath: string;
  requireExisting?: boolean | undefined;
  budgetGiB: () => number | undefined;
  readPidFile: (runtimeKey: string) => number | undefined;
}): Promise<LocalAdmissionRuntime> {
  const readBirth = await nativeBirthReader();
  const capture = (pid: number): GenerationRecord | undefined => {
    const live = observeLocalGeneration(pid, readBirth, undefined);
    return live?.alive === true ? { pid, birthId: live.birthId } : undefined;
  };
  const owner = capture(process.pid);
  if (owner === undefined) {
    throw new AuthorityUnavailableError("cannot identify the local admission owner generation");
  }
  return {
    authority: openAdmissionAuthority({
      ...opts,
      owner,
      observe: (pid, known) => observeLocalGeneration(pid, readBirth, known),
    }),
    capture,
  };
}
