import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { defaultOpsChatAuditPath } from './paths.js';

/**
 * Append-only JSONL audit sink for the Ops Chat module. Every
 * attempted + completed tool dispatch writes one line so operators
 * can retrace what the assistant + human collaborators ran, when,
 * and what came back.
 */

export interface OpsChatAuditEntry {
  ts: string;
  tool: string;
  dryRun: boolean;
  /** sha256 of the JSON-stringified arguments. */
  argumentsHash: string;
  ok: boolean;
  durationMs: number;
  /** When ok=false, the error code (from dispatch or Zod). */
  errorCode?: string;
  errorMessage?: string;
  sessionId?: string;
}

export function hashArguments(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
}

export function appendOpsChatAudit(
  entry: OpsChatAuditEntry,
  path: string = defaultOpsChatAuditPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
}

export function readOpsChatAudit(
  opts: { limit?: number; path?: string } = {},
): { entries: OpsChatAuditEntry[]; path: string } {
  const path = opts.path ?? defaultOpsChatAuditPath();
  const limit = opts.limit ?? 100;
  if (!existsSync(path)) return { entries: [], path };
  const body = readFileSync(path, 'utf8');
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit).reverse();
  const entries: OpsChatAuditEntry[] = [];
  for (const l of tail) {
    try {
      entries.push(JSON.parse(l) as OpsChatAuditEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return { entries, path };
}