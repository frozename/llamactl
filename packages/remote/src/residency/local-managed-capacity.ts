import type {
  ManagedCapacitySample,
  ManagedCapacityScope,
  ManagedMemoryPressure,
} from "@llamactl/core/resources/managed-capacity";

import { execFileSync } from "node:child_process";

import { readFileSync } from "../safe-fs.js";

export interface LocalManagedCapacityDeps {
  platform?: NodeJS.Platform;
  nowMs?: () => number;
  readFile?: (path: string) => string;
  exec?: (file: string, args: string[]) => string;
}

type ReadFile = NonNullable<LocalManagedCapacityDeps["readFile"]>;
type Exec = NonNullable<LocalManagedCapacityDeps["exec"]>;
type Measurements = Omit<ManagedCapacitySample, "observedAtMs">;

const cgroupRoot = "/sys/fs/cgroup";
const unknownScope = { kind: "unknown" } as const;
const hostScope = { kind: "host-physical" } as const;

function readSafely(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

function unsigned(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function scaled(count: number | null, unit: number | null): number | null {
  if (count === null || unit === null) return null;
  const bytes = count * unit;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function readMeminfo(raw: string): Map<string, number | null> {
  const fields = new Map<string, number | null>();
  for (const [, name, count] of raw.matchAll(/^(\w+):[ \t]+(\d+)[ \t]+kB[ \t]*$/gm)) {
    if (name !== undefined)
      fields.set(name, fields.has(name) ? null : scaled(unsigned(count), 1024));
  }
  return fields;
}

function psiAverage(line: string | undefined): number | null {
  const match = /(?:^|\s)avg10=(\d+(?:\.\d+)?)(?:\s|$)/.exec(line ?? "");
  if (match?.[1] === undefined) return null;
  const percent = Number(match[1]);
  return percent <= 100 ? percent : null;
}

function linuxPressure(raw: string): ManagedMemoryPressure {
  const lines = raw.split("\n");
  const some = psiAverage(lines.find((line) => line.startsWith("some ")));
  const full = psiAverage(lines.find((line) => line.startsWith("full ")));
  if (some === null || full === null || full > some) return null;
  if (full > 0) return "critical";
  return some > 0 ? "warning" : "normal";
}

function worsePressure(a: ManagedMemoryPressure, b: ManagedMemoryPressure): ManagedMemoryPressure {
  if (a === "critical" || b === "critical") return "critical";
  if (a === "warning" || b === "warning") return "warning";
  return a === null || b === null ? null : "normal";
}

function hasPhysicalCgroupRoot(read: ReadFile): boolean {
  const mounts = read("/proc/self/mountinfo").split("\n");
  const complete = mounts.some((line) => {
    const [mount, fs] = line.split(" - ");
    const fields = mount?.split(" ");
    return fields?.[3] === "/" && fields[4] === cgroupRoot && fs?.startsWith("cgroup2 ") === true;
  });
  if (
    !complete ||
    !read(`${cgroupRoot}/cgroup.controllers`).trim().split(/\s+/).includes("memory")
  ) {
    return false;
  }
  // The real root exposes the enabled controller but no memory.max. A
  // namespaced subtree can look like "/" in mountinfo and /proc/self/cgroup.
  try {
    read(`${cgroupRoot}/memory.max`);
    return false;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function cgroupDirectories(raw: string): string[] | null {
  const membership = /^0::(\/[^\n]*)$/.exec(raw.trim())?.[1];
  if (membership === undefined) return null;
  if (membership === "/") return [];
  const parts = membership.slice(1).split("/");
  if (
    parts.length > 32 ||
    parts.some((part) => !/^[\w@.:-]+$/.test(part) || part === "." || part === "..")
  ) {
    return null;
  }
  let directory = cgroupRoot;
  return parts.map((part) => (directory += "/" + part));
}

function finiteCgroupLimit(read: ReadFile, path: string): { limit: number; available: number } {
  const rawLimit = read(path + "/memory.max").trim();
  if (rawLimit === "max")
    return { limit: Number.POSITIVE_INFINITY, available: Number.POSITIVE_INFINITY };
  const limit = unsigned(rawLimit);
  const usage = unsigned(read(path + "/memory.current"));
  if (limit === null || usage === null) throw new Error("unverified cgroup memory bound");
  return { limit, available: Math.max(0, limit - usage) };
}

function linuxCgroup(read: ReadFile): {
  scope: ManagedCapacityScope;
  pressure: ManagedMemoryPressure;
} {
  try {
    const membership = read("/proc/self/cgroup").trim();
    const directories = cgroupDirectories(membership);
    if (directories === null || !hasPhysicalCgroupRoot(read)) {
      return { scope: unknownScope, pressure: null };
    }
    let limitBytes = Number.POSITIVE_INFINITY;
    let availableBytes = Number.POSITIVE_INFINITY;
    let pressure: ManagedMemoryPressure = "normal";
    for (const path of directories) {
      const view = finiteCgroupLimit(read, path);
      limitBytes = Math.min(limitBytes, view.limit);
      availableBytes = Math.min(availableBytes, view.available);
      pressure = worsePressure(
        pressure,
        linuxPressure(readSafely(() => read(path + "/memory.pressure"))),
      );
    }
    if (read("/proc/self/cgroup").trim() !== membership) {
      return { scope: unknownScope, pressure: null };
    }
    const scope: ManagedCapacityScope = Number.isFinite(limitBytes)
      ? { kind: "cgroup-v2", limitBytes, availableBytes }
      : hostScope;
    return { scope, pressure };
  } catch {
    return { scope: unknownScope, pressure: null };
  }
}

function linuxMeasurements(read: ReadFile): Measurements {
  const fields = readMeminfo(readSafely(() => read("/proc/meminfo")));
  const total = fields.get("SwapTotal") ?? null;
  const free = fields.get("SwapFree") ?? null;
  const hostPressure = linuxPressure(readSafely(() => read("/proc/pressure/memory")));
  const cgroup = linuxCgroup(read);
  return {
    source: "linux-procfs",
    physicalBytes: fields.get("MemTotal") ?? null,
    availableBytes: fields.get("MemAvailable") ?? null,
    pressure: worsePressure(hostPressure, cgroup.pressure),
    swapUsedBytes: total !== null && free !== null && total >= free ? total - free : null,
    scope: cgroup.scope,
  };
}

function darwinPressure(raw: string): ManagedMemoryPressure {
  switch (raw.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warning";
    case "4":
      return "critical";
    default:
      return null;
  }
}

function darwinSwapUsed(raw: string): number | null {
  const [, amount, unit] = /\bused\s*=\s*(\d+(?:\.\d+)?)([BKMGT])(?:\s|$)/.exec(raw) ?? [];
  if (amount === undefined || unit === undefined) return null;
  const bytes = Math.ceil(Number(amount) * 1024 ** "BKMGT".indexOf(unit));
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function darwinAvailable(raw: string): number | null {
  const pageSize = unsigned(/\bpage size of (\d+) bytes\b/.exec(raw)?.[1]);
  const freePages = unsigned(/^Pages free:[ \t]+(\d+)\.[ \t]*$/m.exec(raw)?.[1]);
  return pageSize === 0 ? null : scaled(freePages, pageSize);
}

function darwinMeasurements(exec: Exec): Measurements {
  const sysctl = (key: string): string => readSafely(() => exec("/usr/sbin/sysctl", ["-n", key]));
  return {
    source: "darwin-vm",
    physicalBytes: unsigned(sysctl("hw.memsize")),
    // The free-page floor avoids assuming that cached or compressed pages are reclaimable.
    availableBytes: darwinAvailable(readSafely(() => exec("/usr/bin/vm_stat", []))),
    pressure: darwinPressure(sysctl("kern.memorystatus_vm_pressure_level")),
    swapUsedBytes: darwinSwapUsed(sysctl("vm.swapusage")),
    scope: hostScope,
  };
}

const defaultRead: ReadFile = (path) => readFileSync(path, "utf8");
const defaultExec: Exec = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 750,
  });

function readMeasurements(deps: LocalManagedCapacityDeps): Measurements {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") return linuxMeasurements(deps.readFile ?? defaultRead);
  if (platform === "darwin") return darwinMeasurements(deps.exec ?? defaultExec);
  return {
    source: "unsupported",
    physicalBytes: null,
    availableBytes: null,
    pressure: null,
    swapUsedBytes: null,
    scope: unknownScope,
  };
}

export function readLocalManagedCapacity(
  deps: LocalManagedCapacityDeps = {},
): ManagedCapacitySample {
  const observedAtMs = (deps.nowMs ?? Date.now)();
  return { ...readMeasurements(deps), observedAtMs };
}
