import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { FleetJournalEntry } from './types.js';

export function defaultFleetJournalPath(): string {
  const base = process.env['DEV_STORAGE'] ?? `${homedir()}/.llamactl`;
  return `${base}/fleet-supervisor/journal.jsonl`;
}

export function appendFleetJournal(entry: FleetJournalEntry, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}
