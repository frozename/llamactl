import type { FleetSnapshotEntry } from "./types.js";

import { readJournalLines } from "./journal-reader.js";
import { existsSync } from "./safe-fs.js";

export function readLatestFleetSnapshotFromJournal(journalPath: string): FleetSnapshotEntry | null {
  if (!existsSync(journalPath)) return null;
  let latest: FleetSnapshotEntry | null = null;
  for (const line of readJournalLines(journalPath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string; ts?: string };
      if (parsed.kind !== "fleet-snapshot") continue;
      if (typeof parsed.ts !== "string") continue;
      const entry = parsed as FleetSnapshotEntry;
      if (latest === null || entry.ts > latest.ts) latest = entry;
    } catch {
      // Best-effort tail scan: malformed lines are ignored.
    }
  }
  return latest;
}
