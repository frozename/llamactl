// packages/remote/src/search/ingest/sessions.ts
import { sessionEventBus } from '../../ops-chat/sessions/event-bus.js';
import type { JournalEvent } from '../../ops-chat/sessions/journal-schema.js';

export interface IngestRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface SessionsIngestOpts {
  sink: (records: IngestRecord[]) => Promise<void>;
  flushMs?: number;
  /** Subscribe globally to all sessions; default true. */
  global?: boolean;
}

function recordFor(event: JournalEvent): IngestRecord | null {
  if (event.type === 'session_started') {
    if (!event.goal) return null;
    return {
      id: `${event.sessionId}::start`,
      content: event.goal,
      metadata: {
        sessionId: event.sessionId,
        goal: event.goal,
        startedAt: event.ts,
        where: 'goal',
      },
    };
  }
  if (event.type === 'plan_proposed') {
    const argsText = JSON.stringify((event.step as any).args ?? {});
    const text = [event.reasoning, argsText].filter(Boolean).join('\n');
    if (!text.trim()) return null;
    return {
      id: `${(event as any).sessionId ?? '?'}::${event.stepId}`,
      content: text,
      metadata: {
        sessionId: (event as any).sessionId ?? '?',
        stepId: event.stepId,
        iteration: event.iteration,
        where: `iteration #${event.iteration + 1}`,
      },
    };
  }
  return null;
}

export function startSessionsIngest(opts: SessionsIngestOpts): () => void {
  const flushMs = opts.flushMs ?? 250;
  let queue: IngestRecord[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = async (): Promise<void> => {
    timer = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      await opts.sink(batch);
    } catch {
      /* swallow — ingest is best-effort */
    }
  };

  const onEvent = (sessionId: string) => (event: JournalEvent) => {
    const r = recordFor({ ...event, sessionId } as JournalEvent);
    if (!r) return;
    queue.push(r);
    if (timer === null) timer = setTimeout(() => void flush(), flushMs);
  };

  const originalCreate = sessionEventBus.create.bind(sessionEventBus);
  const subs = new Set<() => void>();
  (sessionEventBus as any).create = (sessionId: string): void => {
    originalCreate(sessionId);
    subs.add(sessionEventBus.subscribe(sessionId, onEvent(sessionId)));
  };

  return () => {
    if (timer !== null) clearTimeout(timer);
    void flush();
    subs.forEach((off) => off());
    subs.clear();
    (sessionEventBus as any).create = originalCreate;
  };
}