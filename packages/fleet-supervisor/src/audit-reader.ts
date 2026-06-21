import * as readline from "node:readline";

import { defaultFleetAuditPath } from "./journal.js";
import * as fs from "./safe-fs.js";

export interface AuditEntry {
  kind: "mcp-audit";
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  outcome: "denied" | "success" | "error";
  detail: Record<string, unknown>;
}

export interface AuditReadOptions {
  auditPath?: string; // default defaultFleetAuditPath()
  tool?: string; // exact-match filter on `tool`
  outcome?: "denied" | "success" | "error";
  /** ISO 8601 timestamp; entries with ts >= since are included. Compared via Date.parse (timezone-aware). */
  since?: string; // entries with ts >= since
  /** Values <1 are clamped to 1 (no count-only mode). */
  limit?: number; // most-recent-first; default 50, cap 500
}

export interface AuditReadResult {
  entries: AuditEntry[]; // most-recent-first
  total: number; // count BEFORE limit (post-filter)
  auditPath: string; // resolved path used
  malformedLines: number;
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<AuditEntry>;
  return (
    entry.kind === "mcp-audit" &&
    typeof entry.ts === "string" &&
    typeof entry.tool === "string" &&
    (entry.outcome === "denied" || entry.outcome === "success" || entry.outcome === "error")
  );
}

function matchesAuditFilters(
  entry: AuditEntry,
  opts: AuditReadOptions | undefined,
  sinceMs: number,
): boolean {
  if (opts?.tool && entry.tool !== opts.tool) return false;
  if (opts?.outcome && entry.outcome !== opts.outcome) return false;
  const entryMs = Date.parse(entry.ts);
  if (!Number.isNaN(sinceMs) && !Number.isNaN(entryMs) && entryMs < sinceMs) return false;
  return true;
}

async function collectFilteredEntries(
  rl: readline.Interface,
  opts: AuditReadOptions | undefined,
  sinceMs: number,
): Promise<{ filtered: AuditEntry[]; malformedLines: number }> {
  const filtered: AuditEntry[] = [];
  let malformedLines = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as unknown;
        if (!isAuditEntry(entry)) continue;
        if (!matchesAuditFilters(entry, opts, sinceMs)) continue;
        filtered.push(entry);
      } catch {
        malformedLines++;
      }
    }
  } finally {
    rl.close();
  }
  return { filtered, malformedLines };
}

export async function readAuditEntries(opts?: AuditReadOptions): Promise<AuditReadResult> {
  const auditPath = opts?.auditPath ?? defaultFleetAuditPath();
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));

  if (!fs.existsSync(auditPath)) {
    return { entries: [], total: 0, auditPath, malformedLines: 0 };
  }

  const stream = fs.createReadStream(auditPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const sinceMs = opts?.since ? Date.parse(opts.since) : NaN;

  const { filtered, malformedLines } = await collectFilteredEntries(rl, opts, sinceMs);

  filtered.sort((a, b) => b.ts.localeCompare(a.ts));
  const total = filtered.length;
  const entries = filtered.slice(0, limit);

  return { entries, total, auditPath, malformedLines };
}
