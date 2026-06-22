import type { PeerNode } from "@llamactl/core/config/peers";

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerSnapshot } from "../../core/src/workloadRuntime.js";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import {
  startPeerSnapshotPoller,
  __peerSnapshotInternals,
} from "../src/server/peer-snapshot-poller.js";
import { generateSelfSignedCert } from "../src/server/tls.js";

const originalFetch = globalThis.fetch;

function peer(id: string): PeerNode {
  return { id, endpoint: `https://${id}.local:7843`, token: "tok" };
}

function capture(): {
  done: Promise<void>;
  readonly published: Map<string, PeerSnapshot> | null;
  publish: (m: Map<string, PeerSnapshot>) => void;
} {
  let published: Map<string, PeerSnapshot> | null = null;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    done,
    get published(): Map<string, PeerSnapshot> | null {
      return published;
    },
    publish: (m: Map<string, PeerSnapshot>): void => {
      published = m;
      resolve();
    },
  };
}

function rawFleetSnapshot(): unknown {
  return {
    node_mem: { free_mb: 1024, inactive_mb: 2048 },
    workloads: [
      {
        models: ["granite-mini-3b"],
        endpoint: "http://127.0.0.1:8086",
        reachable: true,
        revision: "rev-1",
      },
    ],
  };
}

describe("startPeerSnapshotPoller", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("publishes a snapshot map keyed by peer id on the immediate tick", async () => {
    const cap = capture();
    const stop = startPeerSnapshotPoller({
      intervalMs: 1_000_000,
      nowFn: () => 1000,
      listPeersFn: () => [peer("mac-mini")],
      fetchFn: () =>
        Promise.resolve({
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
      fetchFn: (p) =>
        Promise.resolve(
          p.id === "up"
            ? { workloads: [{ modelId: "m", port: 1 }], pressure: "NORMAL", fetchedAt: 1 }
            : null,
        ),
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
      resolve = (): void => {
        if (++n >= 2) r();
      };
    });
    const stop = startPeerSnapshotPoller({
      intervalMs: 15,
      listPeersFn: () => [peer("mac-mini")],
      fetchFn: async () => {
        await Promise.resolve();
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
      fetchFn: () => Promise.resolve(null),
      publish: cap.publish,
    });
    await cap.done;
    stop();
    expect(cap.published!.size).toBe(0);
  });

  test("tunnelPreferred peer fetches snapshot through the pinned relay", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-poller-relay-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1"],
    });
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          type: "res",
          id: "relay-1",
          result: rawFleetSnapshot(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(
        {
          id: "mac-mini",
          endpoint: "https://direct-macmini.invalid:7843",
          tunnelPreferred: true,
          tunnelCentralUrl: "https://central.local:7843",
          tunnelCentralCertificate: cert.certPem,
          tunnelCentralFingerprint: cert.fingerprint,
          tunnelRelayToken: "local-agent-token",
          tunnelNodeName: "mac-mini-tunnel",
        },
        1234,
      );

      expect(snapshot).toEqual({
        workloads: [{ modelId: "granite-mini-3b", port: 8086, revision: "rev-1" }],
        pressure: "NORMAL",
        fetchedAt: 1234,
      });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://central.local:7843/tunnel-relay/mac-mini-tunnel");
      const init = captured[0]!.init as RequestInit & { tls?: { ca?: string } };
      expect(init.method).toBe("POST");
      expect(init.tls?.ca).toBe(cert.certPem);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-agent-token");
      expect(JSON.parse(init.body as string)).toEqual({
        method: "fleetSnapshot",
        type: "query",
        input: undefined,
      });
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("non-tunnel peer keeps the direct pinned fetch path unchanged", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-poller-direct-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(JSON.stringify(rawFleetSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const snapshot = await __peerSnapshotInternals.fetchPeerSnapshot(
        {
          id: "mac-mini",
          endpoint: "https://macmini.ai:7843",
          certificate: cert.certPem,
          token: "peer-token",
        },
        1234,
      );

      expect(snapshot?.workloads).toEqual([
        { modelId: "granite-mini-3b", port: 8086, revision: "rev-1" },
      ]);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://macmini.ai:7843/v1/fleet/snapshot");
      const init = captured[0]!.init as RequestInit & { tls?: { ca?: string } };
      expect(init.method).toBe("GET");
      expect(init.tls).toEqual({ ca: cert.certPem });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer peer-token");
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
