/**
 * #335 test-only pin: the #221 physical-node grouping and bounded pool.
 * groupByNodes keeps items sharing a node key (transitively) in one
 * serial group, merges everything when any key list is null, keeps an
 * empty key list a singleton, and orders groups by smallest index.
 * runNodeGroups honours the worker bound, awaits a group's indices
 * strictly in order, and surfaces only the first error after every
 * worker has drained. normalizeNodeConcurrency clamps bounds to a
 * usable worker count.
 *
 * Every runNodeGroups test is deterministic: workers park on deferreds
 * the test releases explicitly, and ordering is observed through
 * per-index "started" deferreds plus microtask flushing. No timers.
 *
 * Mutation that kills it: in runNodeGroups, replace
 * `Math.min(concurrency, groups.length)` with `groups.length` (ignore
 * the worker bound); the "at most `concurrency` at a time" test fails.
 * Also killed: in unionItemKeys, replace the root union with
 * `else parent[index] = seen;` (link the item, not its root); the
 * "later item bridges two components" test fails.
 *
 * The plain rejection-drain case is already covered in
 * reconciler.test.ts; this file pins the gated settle-only-after-drain
 * ordering and the concurrency bound on top of it.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RECONCILE_NODE_CONCURRENCY,
  groupByNodes,
  normalizeNodeConcurrency,
  runNodeGroups,
} from "../../src/workload/node-concurrency.js";

type Gate = { promise: Promise<void>; resolve: () => void };

function deferred(): Gate {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function gates(count: number): Gate[] {
  return Array.from({ length: count }, () => deferred());
}

function at(list: readonly Gate[], index: number): Gate {
  const gate = list[index];
  if (gate === undefined) throw new Error(`missing gate ${String(index)}`);
  return gate;
}

/** Drain pending promise continuations without any timer. */
async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

type KeyedItem = { keys: readonly string[] | null };

function keysOf(item: KeyedItem): readonly string[] | null {
  return item.keys;
}

describe("normalizeNodeConcurrency", () => {
  test("falls back to the default for absent or non-finite input", () => {
    expect(normalizeNodeConcurrency(undefined)).toBe(DEFAULT_RECONCILE_NODE_CONCURRENCY);
    expect(normalizeNodeConcurrency(Number.NaN)).toBe(DEFAULT_RECONCILE_NODE_CONCURRENCY);
    expect(normalizeNodeConcurrency(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_RECONCILE_NODE_CONCURRENCY,
    );
  });

  test("clamps zero and negative bounds to one worker", () => {
    expect(normalizeNodeConcurrency(0)).toBe(1);
    expect(normalizeNodeConcurrency(-5)).toBe(1);
  });

  test("floors fractional bounds and passes integers through", () => {
    expect(normalizeNodeConcurrency(2.9)).toBe(2);
    expect(normalizeNodeConcurrency(7)).toBe(7);
  });
});

describe("groupByNodes", () => {
  test("empty input yields no groups", () => {
    expect(groupByNodes([], keysOf)).toEqual([]);
  });

  test("distinct node keys stay in separate singleton groups", () => {
    const items: KeyedItem[] = [{ keys: ["n1"] }, { keys: ["n2"] }, { keys: ["n3"] }];
    expect(groupByNodes(items, keysOf)).toEqual([[0], [1], [2]]);
  });

  test("items sharing a key form one group", () => {
    const items: KeyedItem[] = [{ keys: ["n1"] }, { keys: ["n1"] }, { keys: ["n2"] }];
    expect(groupByNodes(items, keysOf)).toEqual([[0, 1], [2]]);
  });

  test("shared keys merge groups transitively", () => {
    const items: KeyedItem[] = [{ keys: ["n1"] }, { keys: ["n1", "n2"] }, { keys: ["n2"] }];
    expect(groupByNodes(items, keysOf)).toEqual([[0, 1, 2]]);
  });

  test("a later item bridges two components that already exist", () => {
    const bridge: KeyedItem[] = [{ keys: ["n1"] }, { keys: ["n2"] }, { keys: ["n1", "n2"] }];
    expect(groupByNodes(bridge, keysOf)).toEqual([[0, 1, 2]]);
    const nonAdjacent: KeyedItem[] = [
      { keys: ["a"] },
      { keys: ["b"] },
      { keys: ["c"] },
      { keys: ["a", "c"] },
    ];
    expect(groupByNodes(nonAdjacent, keysOf)).toEqual([[0, 2, 3], [1]]);
  });

  test("a null key list merges every item into one group", () => {
    const items: KeyedItem[] = [{ keys: ["n1"] }, { keys: ["n2"] }, { keys: null }];
    expect(groupByNodes(items, keysOf)).toEqual([[0, 1, 2]]);
    const nullFirst: KeyedItem[] = [{ keys: null }, { keys: ["n1"] }];
    expect(groupByNodes(nullFirst, keysOf)).toEqual([[0, 1]]);
  });

  test("an empty key list is that item's own singleton", () => {
    const items: KeyedItem[] = [{ keys: ["x"] }, { keys: [] }, { keys: ["y"] }, { keys: [] }];
    expect(groupByNodes(items, keysOf)).toEqual([[0], [1], [2], [3]]);
  });

  test("groups are ordered by smallest index, indices ascending inside", () => {
    const items: KeyedItem[] = [{ keys: ["b"] }, { keys: ["a"] }, { keys: ["b"] }];
    expect(groupByNodes(items, keysOf)).toEqual([[0, 2], [1]]);
  });
});

describe("runNodeGroups", () => {
  test("starts workers in group order and runs at most `concurrency` at a time", async () => {
    const release = gates(4);
    const startedGate = gates(4);
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const done = runNodeGroups([[0], [1], [2], [3]], 2, async (index) => {
      started.push(index);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      at(startedGate, index).resolve();
      await at(release, index).promise;
      inFlight -= 1;
    });

    // Workers start synchronously; only two may be in flight.
    expect(started).toEqual([0, 1]);
    expect(inFlight).toBe(2);
    await flushMicrotasks();
    expect(started).toEqual([0, 1]);
    expect(inFlight).toBe(2);

    at(release, 0).resolve();
    await at(startedGate, 2).promise;
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2]);
    expect(inFlight).toBe(2);

    at(release, 1).resolve();
    await at(startedGate, 3).promise;
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(inFlight).toBe(2);

    at(release, 2).resolve();
    at(release, 3).resolve();
    await done;
    expect(inFlight).toBe(0);
    expect(maxInFlight).toBe(2);
  });

  test("awaits a group's indices strictly in order", async () => {
    const release = gates(2);
    const events: string[] = [];
    const done = runNodeGroups([[0, 1]], 1, async (index) => {
      events.push(`start ${String(index)}`);
      await at(release, index).promise;
      events.push(`end ${String(index)}`);
    });
    await flushMicrotasks();
    expect(events).toEqual(["start 0"]);

    at(release, 0).resolve();
    await flushMicrotasks();
    expect(events).toEqual(["start 0", "end 0", "start 1"]);

    at(release, 1).resolve();
    await done;
    expect(events).toEqual(["start 0", "end 0", "start 1", "end 1"]);
  });

  test("rethrows only the first error after every worker has finished", async () => {
    const first = new Error("first-error");
    const second = new Error("second-error");
    const release = gates(2);
    const attempted: number[] = [];
    let settled = false;
    const done = runNodeGroups([[0], [1]], 2, async (index) => {
      attempted.push(index);
      await at(release, index).promise;
      throw index === 0 ? first : second;
    });
    const outcome = done.then(
      () => {
        settled = true;
        return undefined;
      },
      (err: unknown) => {
        settled = true;
        return err;
      },
    );
    expect(attempted).toEqual([0, 1]);

    at(release, 0).resolve();
    await flushMicrotasks();
    // Worker 1 is still parked, so the first error must not surface yet.
    expect(settled).toBe(false);

    at(release, 1).resolve();
    expect(await outcome).toBe(first);
    expect(settled).toBe(true);
  });
});
