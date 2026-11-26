// Footprint is the single charged basis. The split kinds are attribution only
// and are never summed; shared shmem and file-backed pages are not charged.
import type { MemoryReadStatus } from "@llamactl/core/resources/memory";

import { dlopen, FFIType } from "bun:ffi";

import { readFileSync } from "../safe-fs.js";

export interface ProcessMemoryAttribution {
  footprint: {
    status: MemoryReadStatus;
    bytes: number | null;
    source: string;
  };
  rssAnonBytes?: number | null;
  rssFileBytes?: number | null;
  rssShmemBytes?: number | null;
  swapBytes?: number | null;
}

export type ProcessMemoryReader = () => ProcessMemoryAttribution;

type LinuxProcStatusMemory = {
  rssAnonBytes: number | null;
  rssFileBytes: number | null;
  rssShmemBytes: number | null;
  swapBytes: number | null;
};

type DarwinRusageV0Memory = {
  residentBytes: number;
  physFootprintBytes: number;
};

const LINUX_PROC_STATUS_MEMORY_RE = /^(RssAnon|RssFile|RssShmem|VmSwap):\s+(\d+) kB$/;
const LINUX_FOOTPRINT_SOURCE = "linux:/proc/self/status RssAnon+VmSwap";
const DARWIN_FOOTPRINT_SOURCE = "darwin:proc_pid_rusage ri_phys_footprint";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function parseLinuxProcStatusMemory(text: string): LinuxProcStatusMemory | null {
  let rssAnonBytes: number | null = null;
  let rssFileBytes: number | null = null;
  let rssShmemBytes: number | null = null;
  let swapBytes: number | null = null;

  for (const line of text.split("\n")) {
    const match = LINUX_PROC_STATUS_MEMORY_RE.exec(line);
    if (match === null) continue;
    const key = match[1];
    const kibText = match[2];
    if (key === undefined || kibText === undefined) continue;
    const bytes = Number(kibText) * 1024;
    if (!Number.isSafeInteger(bytes)) continue;
    switch (key) {
      case "RssAnon":
        rssAnonBytes = bytes;
        break;
      case "RssFile":
        rssFileBytes = bytes;
        break;
      case "RssShmem":
        rssShmemBytes = bytes;
        break;
      case "VmSwap":
        swapBytes = bytes;
        break;
    }
  }

  if (
    rssAnonBytes === null &&
    rssFileBytes === null &&
    rssShmemBytes === null &&
    swapBytes === null
  ) {
    return null;
  }
  return { rssAnonBytes, rssFileBytes, rssShmemBytes, swapBytes };
}

export function decodeDarwinRusageV0(bytes: Uint8Array): DarwinRusageV0Memory | null {
  if (bytes.byteLength < 96) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const residentBytes = view.getBigUint64(64, true);
  const physFootprintBytes = view.getBigUint64(72, true);
  if (residentBytes > MAX_SAFE_INTEGER_BIGINT || physFootprintBytes > MAX_SAFE_INTEGER_BIGINT) {
    return null;
  }
  return {
    residentBytes: Number(residentBytes),
    physFootprintBytes: Number(physFootprintBytes),
  };
}

function unavailableAttribution(source: string): ProcessMemoryAttribution {
  return {
    footprint: {
      status: "unavailable",
      bytes: null,
      source,
    },
  };
}

function linuxProcessMemoryAttribution(
  readLinuxProcStatus: (() => string) | undefined,
): ProcessMemoryAttribution {
  try {
    if (readLinuxProcStatus === undefined) return unavailableAttribution(LINUX_FOOTPRINT_SOURCE);
    const parsed = parseLinuxProcStatusMemory(readLinuxProcStatus());
    if (parsed === null) return unavailableAttribution(LINUX_FOOTPRINT_SOURCE);

    const chargedBytes =
      parsed.rssAnonBytes !== null && parsed.swapBytes !== null
        ? parsed.rssAnonBytes + parsed.swapBytes
        : null;
    const footprint: ProcessMemoryAttribution["footprint"] =
      chargedBytes !== null && Number.isSafeInteger(chargedBytes)
        ? {
            status: "ok",
            bytes: chargedBytes,
            source: LINUX_FOOTPRINT_SOURCE,
          }
        : {
            status: "unavailable",
            bytes: null,
            source: LINUX_FOOTPRINT_SOURCE,
          };
    return { footprint, ...parsed };
  } catch {
    return unavailableAttribution(LINUX_FOOTPRINT_SOURCE);
  }
}

function darwinProcessMemoryAttribution(
  readDarwinRusageV0: (() => Uint8Array | null) | undefined,
): ProcessMemoryAttribution {
  try {
    const encoded = readDarwinRusageV0?.();
    const decoded =
      encoded === null || encoded === undefined ? null : decodeDarwinRusageV0(encoded);
    if (decoded === null) return unavailableAttribution(DARWIN_FOOTPRINT_SOURCE);
    return {
      footprint: {
        status: "ok",
        bytes: decoded.physFootprintBytes,
        source: DARWIN_FOOTPRINT_SOURCE,
      },
    };
  } catch {
    return unavailableAttribution(DARWIN_FOOTPRINT_SOURCE);
  }
}

export function createProcessMemoryReader(deps: {
  platform: NodeJS.Platform;
  readLinuxProcStatus?: () => string;
  readDarwinRusageV0?: () => Uint8Array | null;
}): ProcessMemoryReader {
  return (): ProcessMemoryAttribution => {
    if (deps.platform === "linux") {
      return linuxProcessMemoryAttribution(deps.readLinuxProcStatus);
    }
    if (deps.platform === "darwin") {
      return darwinProcessMemoryAttribution(deps.readDarwinRusageV0);
    }
    return {
      footprint: {
        status: "unsupported",
        bytes: null,
        source: "",
      },
    };
  };
}

interface DarwinProcPidRusageBinding {
  symbols: {
    proc_pid_rusage: (pid: number, flavor: number, buffer: NodeJS.TypedArray) => number;
  };
}

function openDarwinProcPidRusageBinding(): DarwinProcPidRusageBinding {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pid_rusage: {
      args: [FFIType.i32, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
}

function defaultDarwinRusageV0Reader(): () => Uint8Array | null {
  let binding: DarwinProcPidRusageBinding | null = null;
  let bindingResolved = false;
  return (): Uint8Array | null => {
    if (!bindingResolved) {
      bindingResolved = true;
      try {
        binding = openDarwinProcPidRusageBinding();
      } catch {
        binding = null;
      }
    }
    if (binding === null) return null;
    const bytes = new Uint8Array(96);
    const rc = binding.symbols.proc_pid_rusage(process.pid, 0, bytes);
    return rc === 0 ? bytes : null;
  };
}

export function defaultProcessMemoryReader(): ProcessMemoryReader {
  return createProcessMemoryReader({
    platform: process.platform,
    readLinuxProcStatus: (): string => readFileSync("/proc/self/status", "utf8"),
    readDarwinRusageV0: defaultDarwinRusageV0Reader(),
  });
}
