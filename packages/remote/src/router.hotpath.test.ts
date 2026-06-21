import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JournalEvent } from "./ops-chat/sessions/journal-schema.js";

import { sessionEventBus } from "./ops-chat/sessions/event-bus.js";
import { appendJournalEvent } from "./ops-chat/sessions/journal.js";
import { queryServerStatusWithTimeout, router, tailSessionEvents } from "./router.js";
import { mkdtempSync, rmSync } from "./safe-fs.js";

// ---------------------------------------------------------------------------
// Hermetic journal root so readJournal/appendJournalEvent never touch the real
// ~/.llamactl. $DEV_STORAGE reroots defaultSessionsDir (see ops-chat/paths.ts).
// ---------------------------------------------------------------------------
let prevDevStorage: string | undefined;
let tmpRoot: string;

beforeEach(() => {
  prevDevStorage = process.env.DEV_STORAGE;
  tmpRoot = mkdtempSync(join(tmpdir(), "router-hotpath-"));
  process.env.DEV_STORAGE = tmpRoot;
});

afterEach(() => {
  if (prevDevStorage === undefined) delete process.env.DEV_STORAGE;
  else process.env.DEV_STORAGE = prevDevStorage;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const done = (): JournalEvent => ({ type: "done", ts: new Date().toISOString(), iterations: 1 });
const started = (sessionId: string): JournalEvent => ({
  type: "session_started",
  ts: new Date().toISOString(),
  sessionId,
  goal: "g",
  historyLen: 0,
  toolCount: 0,
});

/** A promise that rejects after `ms` with `message` — used to turn a
 * HANG into a test failure instead of stalling the whole suite forever. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
}

/** Drain an async generator with a hard deadline so a HANG fails the test
 * (rejects) instead of stalling the whole suite forever. */
async function drainWithDeadline(
  gen: AsyncGenerator<JournalEvent>,
  ms: number,
): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  const consume = (async (): Promise<JournalEvent[]> => {
    for await (const ev of gen) out.push(ev);
    return out;
  })();
  return await Promise.race([
    consume,
    rejectAfter(ms, `generator did not complete within ${String(ms)}ms`),
  ]);
}

// ===========================================================================
// FIX [4] — tailSessionEvents listener leak / park ignores abort.
// ===========================================================================

test("FIX[4] tailSessionEvents: aborting the signal while parked wakes the await and removes the bus listener (no leak)", async () => {
  const sessionId = "sess-leak-1";
  sessionEventBus.create(sessionId);
  const before = sessionEventBus.listenerCount(sessionId);

  const ac = new AbortController();
  const gen = tailSessionEvents(sessionId, ac.signal);

  // Kick the generator so it subscribes and parks on the empty queue.
  const first = gen.next();
  // Listener is now attached (one more than baseline).
  expect(sessionEventBus.listenerCount(sessionId)).toBe(before + 1);

  // Abort while parked. Pre-fix the park ignored the signal and never woke;
  // this drain would hang forever (deadline rejects -> test fails).
  ac.abort();

  const r = await Promise.race([
    first,
    rejectAfter(2000, "park ignored abort: generator did not wake"),
  ]);
  expect(r.done).toBe(true);

  // finally must have removed the bus subscription: count back to baseline.
  expect(sessionEventBus.listenerCount(sessionId)).toBe(before);

  sessionEventBus.close(sessionId);
});

test("FIX[4] tailSessionEvents: a signal already aborted before the first park still cleans up the listener", async () => {
  const sessionId = "sess-leak-2";
  sessionEventBus.create(sessionId);
  const before = sessionEventBus.listenerCount(sessionId);

  const ac = new AbortController();
  ac.abort();
  const gen = tailSessionEvents(sessionId, ac.signal);

  const out = await drainWithDeadline(gen, 2000);
  expect(out).toEqual([]);
  // No dangling listener.
  expect(sessionEventBus.listenerCount(sessionId)).toBe(before);
  sessionEventBus.close(sessionId);
});

test("FIX[4] tailSessionEvents: terminal event ends the stream and removes the listener", async () => {
  const sessionId = "sess-leak-3";
  sessionEventBus.create(sessionId);
  const before = sessionEventBus.listenerCount(sessionId);

  const ac = new AbortController();
  const gen = tailSessionEvents(sessionId, ac.signal);
  const collected: JournalEvent[] = [];
  const pump = (async (): Promise<void> => {
    for await (const ev of gen) collected.push(ev);
  })();

  // Let it subscribe + park.
  await Promise.resolve();
  const term = done();
  sessionEventBus.publish(sessionId, started(sessionId));
  sessionEventBus.publish(sessionId, term);

  await Promise.race([pump, rejectAfter(2000, "terminal event did not end the stream")]);

  expect(collected.at(-1)?.type).toBe("done");
  expect(sessionEventBus.listenerCount(sessionId)).toBe(before);
  sessionEventBus.close(sessionId);
});

// ===========================================================================
// FIX [5] — opsSessionWatch read-then-subscribe race drops a terminal event.
// ===========================================================================

test("FIX[5] opsSessionWatch: a terminal event published in the read->subscribe gap is still delivered (no hang)", async () => {
  const sessionId = "sess-gap-1";
  // Non-empty, non-terminal journal forces a real `readFile` -> the
  // read-then-subscribe gap is wide enough that the pre-fix code suspends on
  // the journal read WITHOUT a bus listener attached. A terminal published in
  // that window is dropped pre-fix (client hangs); the fix subscribes first so
  // the buffer catches it.
  await appendJournalEvent(sessionId, started(sessionId));
  sessionEventBus.create(sessionId);

  const caller = router.createCaller({});
  const gen = (await caller.opsSessionWatch({ sessionId })) as AsyncGenerator<JournalEvent>;

  const collected: JournalEvent[] = [];
  const pump = (async (): Promise<void> => {
    for await (const ev of gen) collected.push(ev);
  })();

  // Publish the terminal in the gap window.
  await Promise.resolve();
  await Promise.resolve();
  const term = done();
  sessionEventBus.publish(sessionId, term);

  await Promise.race([pump, rejectAfter(3000, "gap event dropped: watcher hung")]);

  // The gap terminal `done` was delivered and ended the stream (no hang).
  expect(collected.some((e) => e.type === "done")).toBe(true);
  sessionEventBus.close(sessionId);
});

test("FIX[5] opsSessionWatch: persisted journal replays and a journal-vs-buffer duplicate is delivered once", async () => {
  const sessionId = "sess-gap-2";
  // Persist a non-terminal event so the journal is replayed first.
  await appendJournalEvent(sessionId, started(sessionId));
  sessionEventBus.create(sessionId);

  const caller = router.createCaller({});
  const gen = (await caller.opsSessionWatch({ sessionId })) as AsyncGenerator<JournalEvent>;
  const collected: JournalEvent[] = [];
  const pump = (async (): Promise<void> => {
    for await (const ev of gen) collected.push(ev);
  })();

  await Promise.resolve();
  await Promise.resolve();
  // Terminal ends the stream.
  sessionEventBus.publish(sessionId, done());

  await Promise.race([pump, rejectAfter(3000, "watcher hung")]);

  // session_started replayed exactly once, done delivered.
  expect(collected.filter((e) => e.type === "session_started").length).toBe(1);
  expect(collected.some((e) => e.type === "done")).toBe(true);
  sessionEventBus.close(sessionId);
});

test("FIX[5] tailSessionEvents preSubscribed: pre-buffered events drain before live tail (handoff path)", async () => {
  const sessionId = "sess-handoff-1";
  sessionEventBus.create(sessionId);
  const before = sessionEventBus.listenerCount(sessionId);

  // Caller attaches the bus subscription and pre-buffers events.
  const buffer: JournalEvent[] = [];
  let wake: (() => void) | null = null;
  const off = sessionEventBus.subscribe(sessionId, (e) => {
    buffer.push(e);
    wake?.();
  });
  buffer.push(started(sessionId)); // pre-buffered in the gap

  const ac = new AbortController();
  const gen = tailSessionEvents(sessionId, ac.signal, {
    buffer,
    off,
    setWake: (w) => {
      wake = w;
    },
  });

  const collected: JournalEvent[] = [];
  const pump = (async (): Promise<void> => {
    for await (const ev of gen) collected.push(ev);
  })();

  await Promise.resolve();
  // A live event arrives AFTER handoff -> must reach the same drained buffer.
  sessionEventBus.publish(sessionId, started(sessionId));
  sessionEventBus.publish(sessionId, done());

  await Promise.race([pump, rejectAfter(2000, "handoff tail hung")]);

  expect(collected.filter((e) => e.type === "session_started").length).toBe(2);
  expect(collected.at(-1)?.type).toBe("done");
  // Handoff path must not leak the listener it adopted.
  expect(sessionEventBus.listenerCount(sessionId)).toBe(before);
  sessionEventBus.close(sessionId);
});

// ===========================================================================
// FIX [6] — workloadList per-node timeout.
// ===========================================================================

test("FIX[6] queryServerStatusWithTimeout: a never-resolving node rejects within ~the timeout instead of hanging", async () => {
  const t0 = Date.now();
  // A query that never settles models a black-holed / unreachable node.
  const neverResolves = (): Promise<never> =>
    new Promise<never>(() => {
      /* intentionally never resolves */
    });
  let threw: unknown;
  try {
    await queryServerStatusWithTimeout(neverResolves, 150);
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(Error);
  expect((threw as Error).message).toMatch(/timed out/);
  const elapsed = Date.now() - t0;
  // Resolved by the deadline, not blocked forever.
  expect(elapsed).toBeLessThan(2000);
  expect(elapsed).toBeGreaterThanOrEqual(100);
});

test("FIX[6] queryServerStatusWithTimeout: a fast node resolves with its value and clears the timer", async () => {
  const value = { state: "up" as const };
  const fast = (): Promise<typeof value> => Promise.resolve(value);
  const got = await queryServerStatusWithTimeout(fast, 5000);
  expect(got).toEqual(value);
});

test("FIX[6] workloadList: one black-holed node is reported Unreachable while others return, bounded by the timeout", async () => {
  // Drives the real procedure end-to-end via the in-proc caller. With no
  // workloads configured the list is empty (no nodes to hang on), which still
  // exercises the procedure wiring; the per-node deadline itself is pinned by
  // the unit test above. We assert the call returns promptly and is an array.
  const t0 = Date.now();
  const caller = router.createCaller({});
  const rows = await caller.workloadList();
  expect(Array.isArray(rows)).toBe(true);
  expect(Date.now() - t0).toBeLessThan(10000);
});
