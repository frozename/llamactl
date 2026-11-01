import { expect, spyOn, test } from "bun:test";

import type { JournalEvent } from "../src/ops-chat/sessions/journal-schema.js";

import { sessionEventBus } from "../src/ops-chat/sessions/event-bus.js";
import { type IngestRecord, startSessionsIngest } from "../src/search/ingest/sessions.js";

const event = (sessionId: string): JournalEvent => ({
  type: "session_started" as const,
  ts: "2026-10-31T00:00:00.000Z",
  sessionId,
  goal: "index this session",
  historyLen: 0,
  toolCount: 0,
});
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

test("closed sessions leave no retained per-session unsubscribe collection", () => {
  const callbacks = new WeakSet<() => void>();
  const collections: Set<unknown>[] = [];
  const subscribe = sessionEventBus.subscribe.bind(sessionEventBus);
  const add = Reflect.get(Set.prototype, "add") as (
    this: Set<unknown>,
    value: unknown,
  ) => Set<unknown>;
  const subscribeSpy = spyOn(sessionEventBus, "subscribe").mockImplementation((id, listener) => {
    const off = subscribe(id, listener);
    callbacks.add(off);
    return off;
  });
  const addSpy = spyOn(Set.prototype, "add").mockImplementation(function (
    this: Set<unknown>,
    value: unknown,
  ) {
    if (
      typeof value === "function" &&
      callbacks.has(value as () => void) &&
      !collections.includes(this)
    ) {
      collections.push(this);
    }
    return add.call(this, value);
  });
  let stop: (() => void) | undefined;
  try {
    stop = startSessionsIngest({ sink: () => Promise.resolve() });
    for (let i = 0; i < 1000; i++) {
      const id = `lifetime-closed-${String(i)}`;
      sessionEventBus.create(id);
      sessionEventBus.close(id);
    }
    expect(collections.reduce((count, collection) => count + collection.size, 0)).toBe(0);
  } finally {
    stop?.();
    addSpy.mockRestore();
    subscribeSpy.mockRestore();
  }
});

test("repeated create remains idempotent for ingestion", async () => {
  const records: IngestRecord[] = [];
  const stop = startSessionsIngest({
    flushMs: 1,
    sink: async (batch) => {
      await Promise.resolve();
      records.push(...batch);
    },
  });
  try {
    sessionEventBus.create("lifetime-repeated");
    sessionEventBus.create("lifetime-repeated");
    sessionEventBus.publish("lifetime-repeated", event("lifetime-repeated"));
    await settle();
    expect(records.map((record) => record.id)).toEqual(["lifetime-repeated::start"]);
  } finally {
    stop();
    sessionEventBus.close("lifetime-repeated");
  }
});

test("ingestion observes an already open session and ignores it after close", async () => {
  const records: IngestRecord[] = [];
  sessionEventBus.create("lifetime-existing");
  const stop = startSessionsIngest({
    flushMs: 1,
    sink: async (batch) => {
      await Promise.resolve();
      records.push(...batch);
    },
  });
  try {
    sessionEventBus.publish("lifetime-existing", event("lifetime-existing"));
    sessionEventBus.close("lifetime-existing");
    sessionEventBus.publish("lifetime-existing", event("lifetime-existing"));
    await settle();
    expect(records.map((record) => record.id)).toEqual(["lifetime-existing::start"]);
  } finally {
    stop();
    sessionEventBus.close("lifetime-existing");
  }
});

test("stopping an older ingester preserves another observer across session churn", async () => {
  const first: IngestRecord[] = [],
    second: IngestRecord[] = [];
  const stopFirst = startSessionsIngest({
    flushMs: 1,
    sink: async (batch) => {
      await Promise.resolve();
      first.push(...batch);
    },
  });
  const stopSecond = startSessionsIngest({
    flushMs: 1,
    sink: async (batch) => {
      await Promise.resolve();
      second.push(...batch);
    },
  });
  try {
    stopFirst();
    for (let i = 0; i < 1000; i++) {
      const id = `lifetime-churn-${String(i)}`;
      sessionEventBus.create(id);
      sessionEventBus.publish(id, event(id));
      sessionEventBus.close(id);
    }
    await settle();
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1000);
    stopSecond();
    sessionEventBus.create("lifetime-after-stop");
    sessionEventBus.publish("lifetime-after-stop", event("lifetime-after-stop"));
    await settle();
    expect(second).toHaveLength(1000);
  } finally {
    stopSecond();
    stopFirst();
    sessionEventBus.close("lifetime-after-stop");
  }
});
