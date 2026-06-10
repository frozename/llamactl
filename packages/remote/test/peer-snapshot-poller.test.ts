import { describe, expect, test } from "bun:test";

import type { PeerSnapshot } from "../../core/src/workloadRuntime.js";
import type { PeerNode } from "../src/config/peers.js";

import { startPeerSnapshotPoller } from "../src/server/peer-snapshot-poller.js";

function peer(id: string): PeerNode {
  return { id, endpoint: `https://${id}.local:7843`, token: "tok" };
}

function capture() {
  let published: Map<string, PeerSnapshot> | null = null;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    done,
    get published() {
      return published;
    },
    publish: (m: Map<string, PeerSnapshot>) => {
      published = m;
      resolve();
    },
  };
}

describe("startPeerSnapshotPoller", () => {
  test("publishes a snapshot map keyed by peer id on the immediate tick", async () => {
    const cap = capture();
    const stop = startPeerSnapshotPoller({
      intervalMs: 1_000_000,
      nowFn: () => 1000,
      listPeersFn: () => [peer("mac-mini")],
      fetchFn: async () => ({
        workloads: [{ modelId: "granite-mini-3b", port: 8086 }],
        pressure: "NORMAL",
        fetchedAt: 1000,
      }),
      publish: cap.publish,
    });
    await cap.done;
    stop();
    expect([...cap.published!.keys()]).toEqual(["mac-mini"]);
    expect(cap.published!.get("mac-mini")!.workloads).toEqual([
      { modelId: "granite-mini-3b", port: 8086 },
    ]);
  });

  test("omits peers whose fetch returns null (unreachable / no snapshot)", async () => {
    const cap = capture();
    const stop = startPeerSnapshotPoller({
      intervalMs: 1_000_000,
      listPeersFn: () => [peer("up"), peer("down")],
      fetchFn: async (p) =>
        p.id === "up"
          ? { workloads: [{ modelId: "m", port: 1 }], pressure: "NORMAL", fetchedAt: 1 }
          : null,
      publish: cap.publish,
    });
    await cap.done;
    stop();
    expect([...cap.published!.keys()]).toEqual(["up"]);
  });

  test("retains a peer snapshot across a transient fetch failure (no route flap)", async () => {
    const publishes: Map<string, PeerSnapshot>[] = [];
    let calls = 0;
    let n = 0;
    let resolve!: () => void;
    const twoTicks = new Promise<void>((r) => {
      resolve = () => {
        if (++n >= 2) r();
      };
    });
    const stop = startPeerSnapshotPoller({
      intervalMs: 15,
      listPeersFn: () => [peer("mac-mini")],
      fetchFn: async () => {
        calls += 1;
        // First tick succeeds; every later tick fails (returns null).
        return calls === 1
          ? {
              workloads: [{ modelId: "granite-mini-3b", port: 8086 }],
              pressure: "NORMAL",
              fetchedAt: 1,
            }
          : null;
      },
      publish: (m) => {
        publishes.push(new Map(m));
        resolve();
      },
    });
    await twoTicks;
    stop();
    expect(publishes[0]!.has("mac-mini")).toBe(true); // first tick: fetched
    expect(publishes[publishes.length - 1]!.has("mac-mini")).toBe(true); // later tick failed -> retained
  });

  test("publishes an empty map when there are no peers (local-only routing)", async () => {
    const cap = capture();
    const stop = startPeerSnapshotPoller({
      intervalMs: 1_000_000,
      listPeersFn: () => [],
      fetchFn: async () => null,
      publish: cap.publish,
    });
    await cap.done;
    stop();
    expect(cap.published!.size).toBe(0);
  });
});
