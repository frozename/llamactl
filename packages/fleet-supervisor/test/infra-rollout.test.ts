/* eslint-disable @typescript-eslint/require-await -- test doubles implement async contracts without scheduling */
import { describe, expect, it } from "bun:test";

import type { PeerNode } from "../../remote/src/config/peers.js";

import { type InfraClientLike, planRollout, runRollout } from "../src/infra-rollout.js";

function makePeer(id: string): PeerNode {
  return { id, endpoint: `https://${id}.example` };
}

function makeClient(
  overrides: Partial<{
    install: (args: {
      pkg: string;
      version: string;
      tarballUrl: string;
      sha256: string;
      activate: boolean;
      skipIfPresent: boolean;
    }) => Promise<void>;
    activate: (args: { pkg: string; version: string }) => Promise<void>;
    pollHealth: (opts: {
      timeoutMs: number;
      pollIntervalMs: number;
    }) => Promise<"healthy" | "timeout">;
  }> = {},
): InfraClientLike {
  return {
    install: overrides.install ?? ((): Promise<void> => Promise.resolve()),
    activate: overrides.activate ?? ((): Promise<void> => Promise.resolve()),
    pollHealth:
      overrides.pollHealth ??
      ((): Promise<"healthy" | "timeout"> => Promise.resolve("healthy" as const)),
  };
}

const BASE_OPTS = {
  pkg: "llamactl-agent",
  version: "1.1.0",
  tarballUrl: "https://releases.example/pkg.tar.gz",
  sha256: "deadbeef",
  skipIfPresent: false,
  healthTimeoutMs: 100,
  pollIntervalMs: 10,
} as const;

describe("planRollout", () => {
  it("one-at-a-time: local node last, remotes each in their own group", () => {
    const peers = [makePeer("local"), makePeer("a"), makePeer("b")];
    const groups = planRollout(peers, "local", "one-at-a-time");
    expect(groups).toHaveLength(3);
    expect(groups[0]!).toEqual([peers[1]!]);
    expect(groups[1]!).toEqual([peers[2]!]);
    expect(groups[2]!).toEqual([peers[0]!]);
  });

  it("all: remotes in one group, local in a second group", () => {
    const peers = [makePeer("local"), makePeer("a"), makePeer("b")];
    const groups = planRollout(peers, "local", "all");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
    expect(groups[1]).toHaveLength(1);
    expect(groups[1]![0]!.id).toBe("local");
  });
});

describe("runRollout — happy path", () => {
  it("install is called with activate:false, then activate is called separately", async () => {
    const calls: string[] = [];
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        install: async ({ activate }) => {
          calls.push(`install:${peer.id}:activate=${String(activate)}`);
        },
        activate: async ({ version }) => {
          calls.push(`activate:${peer.id}:${version}`);
        },
      });
    const result = await runRollout([[makePeer("a")]], factory, BASE_OPTS);
    expect(result.ok).toBe(true);
    expect(calls).toContain("install:a:activate=false");
    expect(calls).toContain("activate:a:1.1.0");
  });

  it("returns ok:true when all groups succeed", async () => {
    const result = await runRollout(
      [[makePeer("a"), makePeer("b")], [makePeer("c")]],
      (): InfraClientLike => makeClient(),
      BASE_OPTS,
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with reason=health-timeout when pollHealth times out", async () => {
    const result = await runRollout(
      [[makePeer("a")]],
      (): InfraClientLike => makeClient({ pollHealth: async () => "timeout" }),
      BASE_OPTS,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("health-timeout");
  });

  it("stops at the first failing group and does not process later groups", async () => {
    const activated: string[] = [];
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        pollHealth: async () => (peer.id === "a" ? "timeout" : "healthy"),
        activate: async () => {
          activated.push(peer.id);
        },
      });
    const result = await runRollout([[makePeer("a")], [makePeer("b")]], factory, BASE_OPTS);
    expect(result.ok).toBe(false);
    expect(activated).not.toContain("b");
  });
});

// ── BUG REPRO: partial activate failure leaves group split ────────────────────
//
// With the buggy code, Promise.all(activate) throws when one node rejects
// and there is no rollback — peers that already activated stay on the new
// version while others remain on the old one (silent split).
//
// The fix must:
//   1. NOT throw out of runRollout; return { ok: false } instead.
//   2. Roll back peers that activated successfully when another peer fails.

describe("runRollout — activate failure mid-group (the no-rollback bug)", () => {
  it("returns ok:false and does NOT throw when a peer rejects activate", async () => {
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        activate: async () => {
          if (peer.id === "node-b") throw new Error("node-b: activate refused");
        },
      });

    let threw = false;
    let result = { ok: true };
    try {
      result = await runRollout([[makePeer("node-a"), makePeer("node-b")]], factory, BASE_OPTS);
    } catch {
      threw = true;
    }

    // Bug: current code throws instead of returning ok:false
    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("rolls back peers that activated successfully when another peer's activate fails", async () => {
    const activations: string[] = [];

    // node-a activates fine; node-b always rejects the new version
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        activate: async ({ version }) => {
          if (peer.id === "node-b" && version === "1.1.0") {
            throw new Error("node-b: activation refused");
          }
          activations.push(`${peer.id}@${version}`);
        },
      });

    const result = await runRollout([[makePeer("node-a"), makePeer("node-b")]], factory, {
      ...BASE_OPTS,
      previousVersion: "1.0.0",
    });

    expect(result.ok).toBe(false);

    // node-a activated to 1.1.0, then node-b failed → node-a must be rolled back
    // Bug: without the fix, no rollback happens and activations stays ["node-a@1.1.0"]
    expect(activations).toContain("node-a@1.1.0");
    expect(activations).toContain("node-a@1.0.0"); // rollback entry
  });

  it("does NOT roll back when previousVersion is absent — but still returns ok:false cleanly", async () => {
    const activations: string[] = [];
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        activate: async ({ version }) => {
          if (peer.id === "node-b") throw new Error("refused");
          activations.push(`${peer.id}@${version}`);
        },
      });

    let threw = false;
    let result = { ok: true };
    try {
      result = await runRollout(
        [[makePeer("node-a"), makePeer("node-b")]],
        factory,
        BASE_OPTS, // no previousVersion
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
    // No rollback possible without previousVersion, but the caller gets a clean error
    expect(activations).not.toContain("node-a@undefined");
  });

  it("install failure also returns ok:false cleanly without throwing", async () => {
    const factory = (peer: PeerNode): InfraClientLike =>
      makeClient({
        install: async () => {
          if (peer.id === "node-b") throw new Error("install refused");
        },
      });

    let threw = false;
    let result = { ok: true };
    try {
      result = await runRollout([[makePeer("node-a"), makePeer("node-b")]], factory, BASE_OPTS);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result.ok).toBe(false);
  });
});
