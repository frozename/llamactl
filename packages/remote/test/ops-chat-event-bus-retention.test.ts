import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JournalEvent } from "../src/ops-chat/sessions/journal-schema";

import { sessionEventBus } from "../src/ops-chat/sessions/event-bus";
import { appendJournalEvent } from "../src/ops-chat/sessions/journal";
import { router, tailSessionEvents } from "../src/router";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

function retained(): number {
  expect(typeof (sessionEventBus as { retainedChannelCount?: unknown }).retainedChannelCount).toBe(
    "function",
  );
  const bus = sessionEventBus as unknown as { retainedChannelCount: () => number };
  return bus.retainedChannelCount();
}

function sessionId(label: string): string {
  return `${label}-${randomUUID()}`;
}

function startedEvent(id: string): JournalEvent {
  return {
    type: "session_started",
    ts: "2026-04-25T00:00:00.000Z",
    sessionId: id,
    goal: "g",
    historyLen: 0,
    toolCount: 0,
  };
}

async function collectStream<T>(stream: AsyncIterable<T>, boundMs = 3_000): Promise<T[]> {
  const events: T[] = [];
  const draining = (async (): Promise<T[]> => {
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("stream did not reach its terminal"));
    }, boundMs);
  });
  try {
    return await Promise.race([draining, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const noop = (): void => undefined;

describe("ops-chat event bus retention", () => {
  let root: string;
  let prev: string | undefined;
  let caller: ReturnType<typeof router.createCaller>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ops-bus-retention-"));
    prev = process.env["DEV_STORAGE"];
    process.env["DEV_STORAGE"] = root;
    caller = router.createCaller({});
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = prev;
    rmSync(root, { recursive: true, force: true });
  });

  test("watching a never-opened session retains no channel after unsubscribe (#367)", () => {
    const id = sessionId("never-opened");
    const before = retained();
    const off = sessionEventBus.subscribe(id, noop);
    off();
    expect(retained()).toBe(before);
    expect(sessionEventBus.listenerCount(id)).toBe(0);
  });

  test("subscribing after a session closed does not resurrect a retained channel (#367)", () => {
    const id = sessionId("closed-before-watch");
    const before = retained();
    sessionEventBus.create(id);
    sessionEventBus.close(id);
    const off = sessionEventBus.subscribe(id, noop);
    off();
    expect(retained()).toBe(before);
    expect(sessionEventBus.listenerCount(id)).toBe(0);
  });

  test("repeated watch cycles on finished sessions stay bounded (#367)", () => {
    const before = retained();
    for (let i = 0; i < 200; i += 1) {
      const id = sessionId(`closed-cycle-${String(i)}`);
      sessionEventBus.create(id);
      sessionEventBus.close(id);
      const off = sessionEventBus.subscribe(id, noop);
      off();
    }
    expect(retained()).toBe(before);
  });

  test("opsSessionWatch on a completed session releases its channel (#367)", async () => {
    const id = sessionId("completed-watch");
    await appendJournalEvent(id, startedEvent(id));
    await appendJournalEvent(id, {
      type: "done",
      ts: "2026-04-25T00:00:01.000Z",
      iterations: 0,
    });
    const before = retained();
    const stream = await caller.opsSessionWatch({ sessionId: id });
    const events = await collectStream(stream);
    expect(events.at(-1)?.type).toBe("done");
    expect(retained()).toBe(before);
  });

  test("tailSessionEvents with an already-aborted signal on an unopened id releases its channel (#367)", async () => {
    const id = sessionId("aborted-tail");
    const before = retained();
    const events = await collectStream(tailSessionEvents(id, AbortSignal.abort()));
    expect(events).toEqual([]);
    expect(retained()).toBe(before);
  });

  test("an open session keeps its channel after its last subscriber leaves", () => {
    const id = sessionId("open-session");
    const before = retained();
    sessionEventBus.create(id);
    const off = sessionEventBus.subscribe(id, noop);
    off();
    expect(sessionEventBus.hasChannel(id)).toBe(true);
    expect(retained()).toBe(before + 1);

    const received: JournalEvent[] = [];
    const offNext = sessionEventBus.subscribe(id, (event) => {
      received.push(event);
    });
    sessionEventBus.publish(id, startedEvent(id));
    expect(received).toHaveLength(1);
    offNext();
    sessionEventBus.close(id);
    expect(retained()).toBe(before);
  });

  test("a subscriber attached before create still receives after create", () => {
    const id = sessionId("subscribe-before-create");
    const before = retained();
    const received: JournalEvent[] = [];
    const off = sessionEventBus.subscribe(id, (event) => {
      received.push(event);
    });
    sessionEventBus.create(id);
    sessionEventBus.publish(id, startedEvent(id));
    expect(received).toHaveLength(1);
    off();
    sessionEventBus.close(id);
    expect(retained()).toBe(before);
  });

  test("a stale unsubscribe never drops a newer channel", () => {
    const id = sessionId("stale-unsubscribe");
    const before = retained();
    const a: JournalEvent[] = [];
    const b: JournalEvent[] = [];
    const offA = sessionEventBus.subscribe(id, (event) => {
      a.push(event);
    });
    sessionEventBus.close(id);
    const offB = sessionEventBus.subscribe(id, (event) => {
      b.push(event);
    });
    offA();
    sessionEventBus.create(id);
    sessionEventBus.publish(id, startedEvent(id));
    expect(b).toHaveLength(1);
    expect(a).toHaveLength(0);
    offB();
    sessionEventBus.close(id);
    expect(retained()).toBe(before);
  });
});
