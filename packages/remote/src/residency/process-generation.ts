import type {
  GenerationRecord,
  ProcessObservation,
} from "@llamactl/core/residency/generation-evidence";
import type { dlopen, ptr } from "bun:ffi";

import { readFileSync, readlinkSync } from "../safe-fs.js";
import {
  type AdmissionAuthority,
  type DetachedGroupState,
  openAdmissionAuthority,
} from "./admission-authority.js";
import { AuthorityUnavailableError } from "./admission-store.js";

type NativeIdentity = { birthId: string; processGroupId?: number; processGroupScope?: string };
type ReadNativeIdentity = (pid: number) => NativeIdentity | undefined;

export function linuxProcessStat(
  stat: string,
  pid: number,
): { startTicks: string; processGroupId: number } | undefined {
  const commEnd = stat.lastIndexOf(") ");
  if (commEnd < 0 || !stat.startsWith(`${String(pid)} (`)) return undefined;
  // Fields 5 and 22 are the process group and start time relative to boot.
  const fields = stat
    .slice(commEnd + 2)
    .trim()
    .split(/\s+/);
  const startTicks = fields[19];
  return startTicks !== undefined && /^\d+$/.test(startTicks)
    ? { startTicks, processGroupId: Number(fields[2]) }
    : undefined;
}

function captureDetachedGroup(
  pid: number,
  birthId: string,
  pgid: number,
  scope: string | undefined,
): NativeIdentity {
  return pid > 1 && pgid === pid && scope !== undefined
    ? { birthId, processGroupId: pid, processGroupScope: scope }
    : { birthId };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function linuxBootId(): string | undefined {
  const boot = readText("/proc/sys/kernel/random/boot_id")?.trim();
  return boot !== undefined && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(boot)
    ? boot
    : undefined;
}

function linuxGroupScope(boot: string): string | undefined {
  try {
    const namespace = readlinkSync("/proc/self/ns/pid");
    return /^pid:\[\d+\]$/.test(namespace) ? `linux:${boot}:${namespace}` : undefined;
  } catch {
    return undefined;
  }
}

const DARWIN_GROUP_SCOPE = "darwin:global";

function localProcessGroupScope(): string | undefined {
  if (process.platform === "darwin") return DARWIN_GROUP_SCOPE;
  if (process.platform !== "linux") return undefined;
  const boot = linuxBootId();
  return boot === undefined ? undefined : linuxGroupScope(boot);
}

function linuxReader(): ReadNativeIdentity {
  const boot = linuxBootId();
  if (boot === undefined) return () => undefined;
  const scope = linuxGroupScope(boot);
  return (pid) => {
    const stat = readText(`/proc/${String(pid)}/stat`);
    const data = stat === undefined ? undefined : linuxProcessStat(stat, pid);
    return data === undefined
      ? undefined
      : captureDetachedGroup(pid, `linux:${boot}:${data.startTicks}`, data.processGroupId, scope);
  };
}

const PROC_PID_TBSD_INFO = 3;
const BSD_INFO_BYTES = 136;
const DARWIN_PROCESS_INFO = {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
} as const;
type ProcessInfoLibrary = ReturnType<typeof dlopen<typeof DARWIN_PROCESS_INFO>>;

let darwinHandle: Promise<ReadNativeIdentity> | undefined;

function makeDarwinReader(library: ProcessInfoLibrary, pointer: typeof ptr): ReadNativeIdentity {
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
    // pbi_pgid and the birth time come from the same native record.
    return captureDetachedGroup(
      pid,
      `darwin:${String(seconds)}:${String(micros)}`,
      view.getUint32(100, true),
      DARWIN_GROUP_SCOPE,
    );
  };
}

async function nativeIdentityReader(): Promise<ReadNativeIdentity> {
  if (process.platform === "linux") return linuxReader();
  if (process.platform !== "darwin") return () => undefined;
  darwinHandle ??= (async (): Promise<ReadNativeIdentity> => {
    const ffi = await import("bun:ffi");
    return makeDarwinReader(ffi.dlopen("/usr/lib/libSystem.B.dylib", DARWIN_PROCESS_INFO), ffi.ptr);
  })();
  return await darwinHandle;
}

function observeLocalGeneration(
  pid: number,
  readIdentity: ReadNativeIdentity,
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
  const identity = readIdentity(pid);
  return identity === undefined ? undefined : { pid, ...identity, alive: true };
}

export function observeLocalDetachedGroup(
  generation: GenerationRecord,
  {
    probe = (pid, signal): boolean => process.kill(pid, signal),
    scope = localProcessGroupScope(),
  }: { probe?: (pid: number, signal: 0) => unknown; scope?: string } = {},
): DetachedGroupState {
  const { pid, processGroupId, processGroupScope, birthId } = generation;
  if (
    processGroupId !== pid ||
    scope === undefined ||
    processGroupScope !== scope ||
    !Number.isInteger(pid) ||
    pid <= 1 ||
    pid > 2_147_483_647 ||
    birthId?.startsWith(`${process.platform}:`) !== true
  ) {
    return "unknown";
  }
  try {
    probe(-processGroupId, 0);
    return "present";
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
  }
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
  const readIdentity = await nativeIdentityReader();
  const capture = (pid: number): GenerationRecord | undefined => {
    const live = observeLocalGeneration(pid, readIdentity, undefined);
    if (live?.alive !== true) return undefined;
    return {
      pid,
      birthId: live.birthId,
      ...(live.processGroupId === undefined ? {} : { processGroupId: live.processGroupId }),
      ...(live.processGroupScope === undefined
        ? {}
        : { processGroupScope: live.processGroupScope }),
    };
  };
  const owner = capture(process.pid);
  if (owner === undefined) {
    throw new AuthorityUnavailableError("cannot identify the local admission owner generation");
  }
  return {
    authority: openAdmissionAuthority({
      ...opts,
      owner: { pid: owner.pid, birthId: owner.birthId },
      observe: (pid, known) => observeLocalGeneration(pid, readIdentity, known),
      observeGroup: observeLocalDetachedGroup,
    }),
    capture,
  };
}
