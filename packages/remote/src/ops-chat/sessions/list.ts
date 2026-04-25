// packages/remote/src/ops-chat/sessions/list.ts
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defaultSessionsDir } from '../paths.js';
import { readJournal } from './journal.js';
import type { JournalEvent } from './journal-schema.js';
import { isTerminal } from './journal-schema.js';

export type SessionStatus = 'live' | 'done' | 'refused' | 'aborted';

export interface SessionSummary {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  iterations: number;
  startedAt: string;
  endedAt?: string;
  nodeId?: string;
  model?: string;
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary> {
  const events = await readJournal(sessionId);
  const start = events.find((e) => e.type === 'session_started');
  if (!start || start.type !== 'session_started') {
    throw new Error(`session ${sessionId} has no session_started event`);
  }
  const terminal = events.find((e) => isTerminal(e));
  let status: SessionStatus = 'live';
  let endedAt: string | undefined;
  if (terminal) {
    endedAt = terminal.ts;
    if (terminal.type === 'done') status = 'done';
    else if (terminal.type === 'refusal') status = 'refused';
    else status = 'aborted';
  }
  const iterations = events.filter((e) => e.type === 'plan_proposed').length;
  return {
    sessionId,
    goal: start.goal,
    status,
    iterations,
    startedAt: start.ts,
    endedAt,
    nodeId: start.nodeId,
    model: start.model,
  };
}

export async function listSessions(opts: {
  limit: number;
  cursor?: string;
  status?: SessionStatus;
}): Promise<{ sessions: SessionSummary[]; nextCursor?: string }> {
  const root = defaultSessionsDir();
  if (!existsSync(root)) return { sessions: [] };
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const summaries: SessionSummary[] = [];
  for (const id of ids) {
    try {
      summaries.push(await getSessionSummary(id));
    } catch {
      /* malformed/empty session — skip */
    }
  }
  summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const filtered = opts.status
    ? summaries.filter((s) => s.status === opts.status)
    : summaries;
  const startIdx = opts.cursor
    ? Math.max(0, filtered.findIndex((s) => s.sessionId === opts.cursor) + 1)
    : 0;
  const page = filtered.slice(startIdx, startIdx + opts.limit);
  const nextCursor =
    startIdx + opts.limit < filtered.length ? page[page.length - 1]?.sessionId : undefined;
  return { sessions: page, nextCursor };
}