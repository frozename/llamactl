import { existsSync, readFileSync } from 'node:fs';
import type { FleetSnapshotEntry } from './types.js';

export function readLatestFleetSnapshotFromJournal(
  journalPath: string,
): FleetSnapshotEntry | null {
  if (!existsSync(journalPath)) return null;
  const raw = readFileSync(journalPath, 'utf8');
  let latest: FleetSnapshotEntry | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string; ts?: string };
      if (parsed.kind !== 'fleet-snapshot') continue;
      if (typeof parsed.ts !== 'string') continue;
      const entry = parsed as FleetSnapshotEntry;
      if (latest === null || entry.ts > latest.ts) latest = entry;
    } catch {
      // Best-effort tail scan: malformed lines are ignored.
    }
  }
  return latest;
}
