import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { defaultFleetAuditPath } from './journal.js';

export interface AuditEntry {
  kind: 'mcp-audit';
  ts: string;
  tool: string;
  input: Record<string, unknown>;
  outcome: 'denied' | 'success' | 'error';
  detail: Record<string, unknown>;
}

export interface AuditReadOptions {
  auditPath?: string;     // default defaultFleetAuditPath()
  tool?: string;          // exact-match filter on `tool`
  outcome?: 'denied' | 'success' | 'error';
  since?: string;    // entries with ts >= since
  limit?: number;         // most-recent-first; default 50, cap 500
}

export interface AuditReadResult {
  entries: AuditEntry[];  // most-recent-first
  total: number;          // count BEFORE limit (post-filter)
  auditPath: string;      // resolved path used
  malformedLines: number;
}

export async function readAuditEntries(opts?: AuditReadOptions): Promise<AuditReadResult> {
  const auditPath = opts?.auditPath ?? defaultFleetAuditPath();
  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));

  if (!fs.existsSync(auditPath)) {
    return { entries: [], total: 0, auditPath, malformedLines: 0 };
  }

  const stream = fs.createReadStream(auditPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const filtered: AuditEntry[] = [];
  let total = 0;
  let malformedLines = 0;
  
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.kind !== 'mcp-audit') continue;
      
      if (opts?.tool && entry.tool !== opts.tool) continue;
      if (opts?.outcome && entry.outcome !== opts.outcome) continue;
      if (opts?.since && entry.ts < opts.since) continue;
      
      total++;
      filtered.push(entry);
      // Keep most-recent-first
      filtered.sort((a, b) => b.ts.localeCompare(a.ts));
      if (filtered.length > limit) {
        filtered.pop(); // Remove the oldest entry
      }
    } catch (err) {
      malformedLines++;
    }
  }

  return { entries: filtered, total, auditPath, malformedLines };
}
