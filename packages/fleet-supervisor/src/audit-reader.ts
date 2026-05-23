import * as fs from 'node:fs';
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
  sinceIsoTs?: string;    // entries with ts >= sinceIsoTs
  limit?: number;         // most-recent-first; default 50, cap 500
}

export interface AuditReadResult {
  entries: AuditEntry[];  // most-recent-first
  total: number;          // count BEFORE limit (post-filter)
  auditPath: string;      // resolved path used
}

export function readAuditEntries(opts?: AuditReadOptions): AuditReadResult {
  const auditPath = opts?.auditPath ?? defaultFleetAuditPath();
  const limit = Math.min(opts?.limit ?? 50, 500);

  if (!fs.existsSync(auditPath)) {
    return { entries: [], total: 0, auditPath };
  }

  const content = fs.readFileSync(auditPath, 'utf8');
  const lines = content.split('\n');

  const filtered: AuditEntry[] = [];
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.kind !== 'mcp-audit') continue;
      
      if (opts?.tool && entry.tool !== opts.tool) continue;
      if (opts?.outcome && entry.outcome !== opts.outcome) continue;
      if (opts?.sinceIsoTs && entry.ts < opts.sinceIsoTs) continue;
      
      filtered.push(entry);
    } catch (err) {
      console.error('skipping malformed journal line: ' + line);
    }
  }

  // Sort most-recent-first by ts lexicographic compare
  filtered.sort((a, b) => b.ts.localeCompare(a.ts));

  const total = filtered.length;
  const entries = filtered.slice(0, limit);

  return { entries, total, auditPath };
}
