// Best-effort OOM-kill observation for the current process's cgroup (Linux
// cgroup v2 only). The kernel bumps `oom_kill` in the victim cgroup's
// `memory.events` when it kills a task, global OOM kills included, so a
// controller that spawns its engines into its own cgroup can tell an engine
// that was OOM-killed from one that merely exited. Readers return null
// instead of throwing: OOM visibility must never break a reconcile pass.
import { join } from "node:path";

import { atomicWriteFile } from "./fsAtomic.js";
import { readFileSync } from "./safe-fs.js";

export interface CgroupOomSample {
  /** cgroup v2 path relative to the unified mount, e.g. `/user.slice/.../app.service`. */
  cgroup: string;
  /** `oom_kill` from that cgroup's `memory.events`. */
  oomKill: number;
}

export interface CgroupOomDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  /** Mount point of the cgroup v2 unified hierarchy. */
  root?: string;
}

/** The unified-hierarchy entry (`0::<path>`) of a `/proc/<pid>/cgroup` file. */
export function parseCgroupV2Path(procCgroup: string): string | null {
  for (const line of procCgroup.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).trim();
    return path.startsWith("/") ? path : null;
  }
  return null;
}

/** The `oom_kill` counter of a cgroup v2 `memory.events` file. */
export function parseMemoryEventsOomKill(memoryEvents: string): number | null {
  for (const line of memoryEvents.split("\n")) {
    const [key, value, ...rest] = line.trim().split(/\s+/);
    if (key !== "oom_kill" || value === undefined || rest.length > 0) continue;
    if (!/^\d+$/.test(value)) return null;
    const count = Number(value);
    return Number.isSafeInteger(count) ? count : null;
  }
  return null;
}

export function memoryEventsPath(cgroup: string, root = "/sys/fs/cgroup"): string {
  return join(root, cgroup, "memory.events");
}

export function readCgroupOomSample(deps: CgroupOomDeps = {}): CgroupOomSample | null {
  if ((deps.platform ?? process.platform) !== "linux") return null;
  const readFile = deps.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  try {
    const cgroup = parseCgroupV2Path(readFile("/proc/self/cgroup"));
    if (cgroup === null) return null;
    const oomKill = parseMemoryEventsOomKill(readFile(memoryEventsPath(cgroup, deps.root)));
    return oomKill === null ? null : { cgroup, oomKill };
  } catch {
    // No cgroup v2 memory controller here (v1 host, root cgroup, container
    // without the file): OOM attribution is simply unavailable.
    return null;
  }
}

/**
 * The last sample a controller saw, persisted so a kill that happened while
 * the controller itself was down still counts. Under systemd's default
 * `OOMPolicy=stop` the unit is stopped and restarted after an engine OOM kill;
 * with `KillMode=process` its cgroup (and the counter) outlive that restart.
 */
export function readOomBaseline(file: string): CgroupOomSample | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CgroupOomSample>;
    const { cgroup, oomKill } = parsed;
    if (typeof cgroup !== "string" || typeof oomKill !== "number") return null;
    if (!Number.isSafeInteger(oomKill) || oomKill < 0) return null;
    return { cgroup, oomKill };
  } catch {
    return null;
  }
}

export function writeOomBaseline(file: string, sample: CgroupOomSample): void {
  try {
    atomicWriteFile(file, `${JSON.stringify(sample)}\n`);
  } catch {
    // A lost baseline only costs attribution of kills during a later restart.
  }
}
