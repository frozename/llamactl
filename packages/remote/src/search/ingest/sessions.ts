import type { JournalEvent } from "../../ops-chat/sessions/journal-schema.js";

// packages/remote/src/search/ingest/sessions.ts
import { sessionEventBus } from "../../ops-chat/sessions/event-bus.js";

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

function recordFor(event: JournalEvent, sessionId?: string): IngestRecord | null {
  if (event.type === "session_started") {
    if (!event.goal) return null;
    return {
      id: `${event.sessionId}::start`,
      content: event.goal,
      metadata: {
        sessionId: event.sessionId,
        goal: event.goal,
        startedAt: event.ts,
        where: "goal",
      },
    };
  }
  if (event.type === "plan_proposed") {
    const owningSessionId = sessionId ?? "?";
    const argsText = JSON.stringify(readStepArgs(event.step));
    const text = [event.reasoning, argsText].filter(Boolean).join("\n");
    if (!text.trim()) return null;
    return {
      id: `${owningSessionId}::${event.stepId}`,
      content: text,
      metadata: {
        sessionId: owningSessionId,
        stepId: event.stepId,
        iteration: event.iteration,
        where: `iteration #${String(event.iteration + 1)}`,
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

  const onEvent =
    (sessionId: string): ((event: JournalEvent) => void) =>
    (event: JournalEvent) => {
      const r = recordFor(event, sessionId);
      if (!r) return;
      queue.push(r);
      timer ??= setTimeout(() => void flush(), flushMs);
    };

  const originalCreate = sessionEventBus.create.bind(sessionEventBus);
  const subs = new Set<() => void>();
  sessionEventBus.create = (sessionId: string): void => {
    originalCreate(sessionId);
    subs.add(sessionEventBus.subscribe(sessionId, onEvent(sessionId)));
  };

  return () => {
    if (timer !== null) clearTimeout(timer);
    void flush();
    for (const off of subs) off();
    subs.clear();
    sessionEventBus.create = originalCreate;
  };
}

function readStepArgs(step: unknown): Record<string, unknown> {
  if (!step || typeof step !== "object") return {};
  const maybe = step as { args?: unknown };
  return maybe.args && typeof maybe.args === "object"
    ? (maybe.args as Record<string, unknown>)
    : {};
}
