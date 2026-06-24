import { join } from "node:path";

import type { KvRegistry } from "./registry.js";

import { readdirSync, statSync, unlinkSync } from "../safe-fs.js";

export interface SweepOrphanSlotFilesOptions {
  slotDir: string;
  registry: KvRegistry;
  ttlMs: number;
  now: number;
}

export interface SweepOrphanSlotFilesResult {
  orphansFound: number;
  orphansDeleted: number;
}

export function sweepOrphanSlotFiles(
  opts: SweepOrphanSlotFilesOptions,
): SweepOrphanSlotFilesResult {
  const cutoff = opts.now - opts.ttlMs;
  let orphansFound = 0;
  let orphansDeleted = 0;

  // Snapshot the known SHAs once instead of one DB read per slot file: the
  // sweep runs on the per-cacheable-response KV-persist path, so an O(n) query
  // fan-out here contributes to SQLITE_BUSY. A concurrently inserted entry's
  // file is written after this snapshot, so its mtime stays above `cutoff` and
  // the mtime guard below (which we deliberately keep ordered after the
  // membership check) refuses to delete it.
  const knownShas = new Set<string>();
  for (const entry of opts.registry.listAll()) knownShas.add(entry.sha);

  for (const filename of readdirSync(opts.slotDir)) {
    const sha = parseShaFromSlotFile(filename);
    if (!sha) continue;
    if (knownShas.has(sha)) continue;
    orphansFound += 1;

    const fullPath = join(opts.slotDir, filename);
    const stat = safeStat(fullPath);
    if (!stat) continue;
    if (stat.mtimeMs > cutoff) continue;
    if (!safeDelete(fullPath)) continue;
    orphansDeleted += 1;
  }

  return { orphansFound, orphansDeleted };
}

function parseShaFromSlotFile(filename: string): string | null {
  if (!filename.endsWith(".kvslot")) return null;
  const sha = filename.slice(0, -".kvslot".length);
  if (sha.length === 0) return null;
  return sha;
}

function safeStat(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch (error: unknown) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function safeDelete(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
