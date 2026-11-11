import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionEventBus } from "../src/ops-chat/sessions/event-bus.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { startSearchIngest, stopSearchIngest } from "../src/search/ingest/lifecycle.js";

test("no RAG destination leaves session ingestion inactive", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ingest-lifecycle-"));
  const previous = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  writeFileSync(
    join(tmp, "config"),
    JSON.stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "local",
      contexts: [{ name: "local", cluster: "local", user: "local" }],
      clusters: [
        { name: "local", nodes: [{ name: "local", kind: "agent", endpoint: "inproc://local" }] },
      ],
    }),
  );
  const create = Object.getOwnPropertyDescriptor(sessionEventBus, "create")?.value as unknown;
  const subscribeAll = spyOn(sessionEventBus, "subscribeAll");
  try {
    void startSearchIngest();
    expect(subscribeAll).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(sessionEventBus, "create")?.value).toBe(create);
    sessionEventBus.create("no-rag");
    expect(sessionEventBus.listenerCount("no-rag")).toBe(0);
  } finally {
    stopSearchIngest();
    subscribeAll.mockRestore();
    sessionEventBus.close("no-rag");
    if (previous === undefined) delete process.env["LLAMACTL_CONFIG"];
    else process.env["LLAMACTL_CONFIG"] = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});

function installSearchIngestFixture(): {
  readonly live: number;
  readonly rawUnsubscribes: number;
  teardown: () => Promise<void>;
} {
  const tmp = mkdtempSync(join(tmpdir(), "ingest-lifecycle-"));
  const ragName = `kb-test-${randomUUID()}`;
  const previous = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  writeFileSync(
    join(tmp, "config"),
    JSON.stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "local",
      contexts: [{ name: "local", cluster: "local", user: "local" }],
      clusters: [
        {
          name: "local",
          nodes: [
            { name: "local", kind: "agent", endpoint: "inproc://local" },
            {
              name: ragName,
              kind: "rag",
              rag: {
                provider: "pgvector",
                endpoint: "postgres://kb@127.0.0.1:1/kb",
                collection: "docs",
              },
            },
          ],
        },
      ],
    }),
  );
  // subscribeAll is only reached through startSessionsIngest, so one live
  // subscription equals one running search ingest. The rag node name is
  // unique per run: a stray sink call resolving it against a restored
  // operator config throws inside resolveRagNode and is swallowed by the
  // ingest loops, so the operator's real KB can never receive a write.
  const realSubscribeAll = sessionEventBus.subscribeAll.bind(sessionEventBus);
  let live = 0;
  // Every call to a subscription's real unsubscribe, NOT de-duplicated, so a
  // stop function run twice shows up here even though `live` does not move.
  let rawUnsubscribes = 0;
  const subscribeAll = spyOn(sessionEventBus, "subscribeAll").mockImplementation((listener) => {
    const off = realSubscribeAll(listener);
    live += 1;
    let done = false;
    return (): void => {
      if (!done) {
        done = true;
        live -= 1;
      }
      rawUnsubscribes += 1;
      off();
    };
  });
  return {
    get live(): number {
      return live;
    },
    get rawUnsubscribes(): number {
      return rawUnsubscribes;
    },
    teardown: async (): Promise<void> => {
      stopSearchIngest();
      // In-flight sink promises settle against the temp config before the
      // env and the spy come down.
      await new Promise((resolve) => setTimeout(resolve, 25));
      subscribeAll.mockRestore();
      if (previous === undefined) delete process.env["LLAMACTL_CONFIG"];
      else process.env["LLAMACTL_CONFIG"] = previous;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("startSearchIngest stop handles (#634)", () => {
  let fixture: ReturnType<typeof installSearchIngestFixture>;

  beforeEach(() => {
    fixture = installSearchIngestFixture();
  });

  afterEach(async () => {
    await fixture.teardown();
  });

  /**
   * Kills: a stop handle whose body delegates to the process-wide
   * stopSearchIngest() — one handle call would drop every agent's ingest
   * (live would be 0 after stopA).
   */
  test("a stop handle stops only the ingest it started", () => {
    const stopA = startSearchIngest();
    const stopB = startSearchIngest();
    expect(typeof stopA).toBe("function");
    expect(fixture.live).toBe(2);
    stopA();
    expect(fixture.live).toBe(1);
    stopB();
    expect(fixture.live).toBe(0);
  });

  /**
   * Kills: removing the undo-partial-start catch in startSearchIngest — a
   * logs-ingest throw would leave the already-started sessions ingest
   * subscribed (live stays 1).
   */
  test("a partial start (logs ingest throws) leaves no sessions ingest running", () => {
    const si = spyOn(globalThis, "setInterval").mockImplementationOnce(() => {
      throw new Error("logs ingest boom");
    });
    try {
      expect(() => startSearchIngest()).toThrow("logs ingest boom");
      expect(si).toHaveBeenCalledTimes(1);
    } finally {
      si.mockRestore();
    }
    expect(fixture.live).toBe(0);
  });

  /**
   * Kills: handles that register only in their own list and not in the
   * module registry — stopSearchIngest() would leave live ingests running
   * (live stays 2). Also kills a stopSearchIngest() that no longer clears
   * the registry: a later a()/b() would find its entries still registered
   * and run each real stop a second time. The raw counters are not
   * de-duplicated, unlike `live`, so that double stop is visible.
   */
  test("stopSearchIngest() still stops every started ingest, and a later handle call is a no-op", () => {
    const timers: unknown[] = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const si = spyOn(globalThis, "setInterval").mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = realSetInterval(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    const ownClears = new Map<unknown, number>();
    const ci = spyOn(globalThis, "clearInterval").mockImplementation(((
      timer?: Parameters<typeof clearInterval>[0],
    ) => {
      if (timers.includes(timer)) ownClears.set(timer, (ownClears.get(timer) ?? 0) + 1);
      realClearInterval(timer);
    }) as typeof clearInterval);
    try {
      const a = startSearchIngest();
      const b = startSearchIngest();
      expect(typeof a).toBe("function");
      expect(fixture.live).toBe(2);
      // One logs-ingest interval per start.
      expect(timers).toHaveLength(2);
      stopSearchIngest();
      expect(fixture.live).toBe(0);
      expect(() => {
        a();
        b();
      }).not.toThrow();
      expect(fixture.live).toBe(0);
      // Each sessions ingest unsubscribed exactly once, each logs ingest
      // interval cleared exactly once, across stopSearchIngest() + a() + b().
      expect(fixture.rawUnsubscribes).toBe(2);
      expect(timers.map((t) => ownClears.get(t) ?? 0)).toEqual([1, 1]);
    } finally {
      ci.mockRestore();
      si.mockRestore();
    }
  });

  /**
   * Kills: dropping the `if (index === -1) continue;` guard in stopEntries.
   * a's entries are already gone from the registry after stopSearchIngest(),
   * so indexOf returns -1 and splice(-1, 1) would remove b's entries from
   * the registry instead — the final stopSearchIngest() would then miss b
   * (live stays 1).
   */
  test("a handle called after stopSearchIngest() leaves a later ingest in the registry", () => {
    const a = startSearchIngest();
    stopSearchIngest();
    expect(fixture.live).toBe(0);
    const b = startSearchIngest();
    expect(typeof b).toBe("function");
    expect(fixture.live).toBe(1);
    a();
    expect(fixture.live).toBe(1);
    stopSearchIngest();
    expect(fixture.live).toBe(0);
  });
});
