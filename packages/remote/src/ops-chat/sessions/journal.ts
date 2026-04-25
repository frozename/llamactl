import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSessionDir } from '../paths.js';
import {
  JournalEventSchema,
  type JournalEvent,
} from './journal-schema.js';

export function journalDir(sessionId: string): string {
  return defaultSessionDir(process.env, sessionId);
}

export function journalPath(sessionId: string): string {
  return join(journalDir(sessionId), 'journal.jsonl');
}

export async function appendJournalEvent(
  sessionId: string,
  event: JournalEvent,
): Promise<void> {
  const path = journalPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}

export async function readJournal(sessionId: string): Promise<JournalEvent[]> {
  const path = journalPath(sessionId);
  if (!existsSync(path)) return [];
  const body = await readFile(path, 'utf8');
  const out: JournalEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JournalEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
