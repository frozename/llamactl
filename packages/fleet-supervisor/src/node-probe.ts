import { type GttObservation, parseGttCounters } from "@llamactl/core/resources/memory";

import type { NodeMemSnapshot } from "./types.js";

import { readdirSync, readFileSync } from "./safe-fs.js";

const PAGE_FIELDS: Record<
  string,
  "free_mb" | "active_mb" | "inactive_mb" | "wired_mb" | "compressor_mb"
> = {
  "Pages free": "free_mb",
  "Pages active": "active_mb",
  "Pages inactive": "inactive_mb",
  "Pages wired down": "wired_mb",
  "Pages occupied by compressor": "compressor_mb",
};

export function parseVmStatOutput(raw: string): NodeMemSnapshot {
  const pageSizeMatch = /page size of (\d+) bytes/.exec(raw);
  const pageSizeText = pageSizeMatch?.[1];
  const pageSize = pageSizeText ? parseInt(pageSizeText, 10) : 4096;
  const toMb = (pages: number): number => (pages * pageSize) / 1024 / 1024;

  const snap: NodeMemSnapshot = {
    free_mb: 0,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 0,
    swap_in: 0,
    swap_out: 0,
  };

  let matchedPageFields = 0;
  for (const line of raw.split("\n")) {
    const pageMatch = /^(.+?):\s+([\d.]+)\./.exec(line);
    if (!pageMatch) continue;
    const [, rawLabel, rawCount] = pageMatch;
    if (rawLabel === undefined || rawCount === undefined) continue;
    const label = rawLabel.trim();
    const count = parseFloat(rawCount);

    const field = PAGE_FIELDS[label];
    if (field) {
      snap[field] = toMb(count);
      matchedPageFields++;
      continue;
    }
    if (label === "Swapins") {
      snap.swap_in = count;
    } else if (label === "Swapouts") {
      snap.swap_out = count;
    }
  }

  if (matchedPageFields < Object.keys(PAGE_FIELDS).length) {
    snap.available = false;
    snap.unavailable_reason = "no-data";
  }

  return snap;
}

export function parseProcMeminfo(raw: string): NodeMemSnapshot {
  const values: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    const match = /^(\w+):\s+(\d+) kB/.exec(line);
    const key = match?.[1];
    const valueText = match?.[2];
    if (key === undefined || valueText === undefined) continue;
    values[key] = parseInt(valueText, 10);
  }

  const toMb = (kb: number | undefined): number => (kb ?? 0) / 1024;
  const swapTotal = values["SwapTotal"];
  const swapFree = values["SwapFree"];

  const snap: NodeMemSnapshot = {
    free_mb: toMb(values["MemAvailable"]),
    active_mb: toMb(values["Active"]),
    // MemAvailable already includes reclaimable inactive pages, and
    // packages/remote/src/server/peer-snapshot-poller.ts sums free_mb +
    // inactive_mb, so a non-zero value here would double-count.
    inactive_mb: 0,
    wired_mb: toMb(values["Unevictable"]),
    compressor_mb:
      swapTotal !== undefined && swapFree !== undefined
        ? Math.max(0, (swapTotal - swapFree) / 1024)
        : 0,
    // meminfo carries no swap in/out counters.
    swap_in: 0,
    swap_out: 0,
  };

  if (values["MemTotal"] === undefined || values["MemAvailable"] === undefined) {
    snap.available = false;
    snap.unavailable_reason = "no-data";
  }

  return snap;
}

export async function probeNodeMem(opts?: {
  exec?: (cmd: string) => Promise<string>;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
}): Promise<NodeMemSnapshot> {
  const exec =
    opts?.exec ??
    ((_cmd: string): Promise<string> => {
      const proc = Bun.spawnSync(["vm_stat"]);
      if (proc.exitCode !== 0) return Promise.resolve("");
      return Promise.resolve(new TextDecoder().decode(proc.stdout));
    });
  const readFile =
    opts?.readFile ??
    ((path: string): Promise<string> => {
      try {
        return Promise.resolve(readFileSync(path, "utf8"));
      } catch {
        return Promise.resolve("");
      }
    });
  const platform = opts?.platform ?? process.platform;

  if (platform === "darwin") {
    return parseVmStatOutput(await exec("vm_stat"));
  }
  if (platform === "linux") {
    return parseProcMeminfo(await readFile("/proc/meminfo").catch(() => ""));
  }
  return {
    free_mb: 0,
    active_mb: 0,
    inactive_mb: 0,
    wired_mb: 0,
    compressor_mb: 0,
    swap_in: 0,
    swap_out: 0,
    available: false,
    unavailable_reason: "unsupported-platform",
  };
}

const DRM_DIR = "/sys/class/drm";
const DRM_CARD = /^card\d+$/;

function drmCardNumber(name: string): number {
  return Number(name.slice("card".length));
}

function isPermissionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "EACCES" || err.code === "EPERM")
  );
}

export async function probeGpuGtt(opts?: {
  platform?: NodeJS.Platform;
  readDir?: (path: string) => Promise<string[]>;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}): Promise<GttObservation> {
  const platform = opts?.platform ?? process.platform;
  if (platform !== "linux") {
    return {
      status: "unsupported",
      totalBytes: null,
      usedBytes: null,
      observedAtMs: null,
      source: "",
      scope: "shared",
    };
  }

  const readDir =
    opts?.readDir ??
    ((path: string): Promise<string[]> => {
      try {
        return Promise.resolve(readdirSync(path));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  const readFile =
    opts?.readFile ??
    ((path: string): Promise<string> => {
      try {
        return Promise.resolve(readFileSync(path, "utf8"));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  const now = opts?.now ?? ((): number => Date.now());

  let entries: string[];
  try {
    entries = await readDir(DRM_DIR);
  } catch {
    return {
      status: "unavailable",
      totalBytes: null,
      usedBytes: null,
      observedAtMs: null,
      source: "",
      scope: "shared",
    };
  }

  const cards = entries
    .filter((name) => DRM_CARD.test(name))
    .sort((a, b) => drmCardNumber(a) - drmCardNumber(b));

  let sawDenied = false;
  for (const card of cards) {
    const device = `${DRM_DIR}/${card}/device`;
    let totalRaw: string;
    let usedRaw: string;
    try {
      totalRaw = await readFile(`${device}/mem_info_gtt_total`);
      usedRaw = await readFile(`${device}/mem_info_gtt_used`);
    } catch (err) {
      if (isPermissionError(err)) sawDenied = true;
      continue;
    }
    const observation = parseGttCounters(totalRaw, usedRaw, {
      source: device,
      observedAtMs: now(),
    });
    if (observation.status === "ok") return observation;
  }

  return {
    status: sawDenied ? "denied" : "unavailable",
    totalBytes: null,
    usedBytes: null,
    observedAtMs: null,
    source: "",
    scope: "shared",
  };
}
