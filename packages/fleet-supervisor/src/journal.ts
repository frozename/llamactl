import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { FleetJournalEntry } from "./types.js";

export function defaultFleetJournalPath(): string {
  const base = process.env["DEV_STORAGE"] ?? `${homedir()}/.llamactl`;
  return `${base}/fleet-supervisor/journal.jsonl`;
}

export function defaultFleetAuditPath(): string {
  const base = process.env["LLAMACTL_FLEET_DIR"] ?? `${homedir()}/.llamactl/fleet-supervisor`;
  return `${base}/audit.jsonl`;
}

export function appendFleetJournal(entry: FleetJournalEntry, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export function readCurrentLeaseHolder(journalPath: string): string | null {
  if (!existsSync(journalPath)) return null;
  const raw = readFileSync(journalPath, "utf8");
  let latest: { ts: string; holder: string } | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string; ts?: string; holder?: string };
      if (parsed.kind !== "fleet-lease-election") continue;
      if (typeof parsed.ts !== "string" || typeof parsed.holder !== "string") continue;
      if (latest === null || parsed.ts > latest.ts) {
        latest = { ts: parsed.ts, holder: parsed.holder };
      }
    } catch {
      // Best-effort scan: malformed lines are ignored.
    }
  }
  return latest?.holder ?? null;
}

interface JournalMoveLine {
  kind?: string;
  workload?: string;
  ts?: string;
  action?: { type?: string };
  transition?: { subject?: string };
}

function moveWorkloadFrom(parsed: JournalMoveLine): string | null {
  if (parsed.kind === "fleet-move") {
    return typeof parsed.workload === "string" ? parsed.workload : null;
  }
  if (
    parsed.kind === "fleet-proposal" &&
    parsed.action?.type === "move" &&
    typeof parsed.transition?.subject === "string"
  ) {
    return parsed.transition.subject;
  }
  return null;
}

function parseMoveLine(trimmed: string): { workload: string; movedAtMs: number } | null {
  try {
    const parsed = JSON.parse(trimmed) as JournalMoveLine;
    const workload = moveWorkloadFrom(parsed);
    if (!workload || typeof parsed.ts !== "string") return null;
    const movedAtMs = Date.parse(parsed.ts);
    if (!Number.isFinite(movedAtMs)) return null;
    return { workload, movedAtMs };
  } catch {
    // Best-effort scan: malformed lines are ignored.
    return null;
  }
}

export function readRecentMovesFromJournal(
  journalPath: string,
): { workload: string; movedAtMs: number }[] {
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, "utf8");
  const latestByWorkload = new Map<string, number>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const move = parseMoveLine(trimmed);
    if (!move) continue;
    const prior = latestByWorkload.get(move.workload);
    if (prior === undefined || move.movedAtMs > prior) {
      latestByWorkload.set(move.workload, move.movedAtMs);
    }
  }

  return [...latestByWorkload.entries()].map(([workload, movedAtMs]) => ({ workload, movedAtMs }));
}
