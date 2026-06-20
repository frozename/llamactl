import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MeasuredMemoryEntry {
  workloadName: string;
  measuredAt: string;
  rssMeanMb: number;
  rssPeakMb: number;
  sampleCount: number;
  engineKind: "llama.cpp" | "oMLX";
  binary: string;
}

export type MeasuredMemoryCache = Record<string, MeasuredMemoryEntry>;

export function measuredMemoryCachePath(): string {
  return (
    process.env["LLAMACTL_MEASURED_MEMORY_PATH"] ??
    `${process.env["HOME"] ?? "/tmp"}/.llamactl/measured-memory.json`
  );
}

/**
 * Returns { peakMb } for the given modelKey when a measured entry exists,
 * or null when the cache file is absent, the key is missing, or the file is
 * unreadable / invalid JSON.
 */
export function readMeasuredMemoryCache(modelKey: string): { peakMb: number } | null {
  try {
    const raw = readFileSync(measuredMemoryCachePath(), "utf8");
    const parsed = JSON.parse(raw) as MeasuredMemoryCache;
    const entry = parsed[modelKey];
    if (
      !entry ||
      typeof entry.rssPeakMb !== "number" ||
      !Number.isFinite(entry.rssPeakMb) ||
      entry.rssPeakMb < 0
    )
      return null;
    return { peakMb: entry.rssPeakMb };
  } catch {
    return null;
  }
}

/**
 * Merges a new entry into the cache file, creating it (and any parent
 * directories) if absent.
 */
export function writeMeasuredMemoryCache(modelKey: string, entry: MeasuredMemoryEntry): void {
  const path = measuredMemoryCachePath();
  let existing: MeasuredMemoryCache = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as MeasuredMemoryCache;
  } catch {
    /* start fresh on missing / invalid */
  }
  const updated = { ...existing, [modelKey]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
}
