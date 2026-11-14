import type { PeerNode } from "@llamactl/core/config/peers";

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSelfSignedCert } from "../../remote/src/server/tls.js";
import { makeDefaultProbeFn } from "../src/loop-helpers.js";
import { createPeerFetch } from "../src/peer-fetch.js";
import { detectDegradation } from "../src/policy.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const originalFetch = globalThis.fetch;

function makeSnapshot(node: string): string {
  return JSON.stringify({
    kind: "fleet-snapshot",
    ts: "2026-05-25T17:00:00.000Z",
    node,
    node_mem: {
      free_mb: 2048,
      active_mb: 0,
      inactive_mb: 0,
      wired_mb: 0,
      compressor_mb: 0,
      swap_in: 0,
      swap_out: 0,
    },
    workloads: [],
  });
}

function parsedSnapshot(node: string): unknown {
  return JSON.parse(makeSnapshot(node)) as unknown;
}

function requestUrl(input: Request | string | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected JSON string request body");
  return JSON.parse(body) as unknown;
}

async function expectRejectsToThrow(promise: Promise<unknown>, expected?: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (expected !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(expected);
    }
    return;
  }
  throw new Error("expected promise to reject");
}

function withStubbedSnapshotFetch(
  peerRequestCapture: (url: string, init: RequestInit | undefined) => string,
): {
  captured: () => { url: string; headers: Headers } | null;
  cleanup: () => void;
} {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; headers: Headers } | null = null;
  globalThis.fetch = ((input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    captured = { url, headers: new Headers(init?.headers) };
    const responseBody = peerRequestCapture(url, init);
    return Promise.resolve(
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    captured: (): { url: string; headers: Headers } | null => captured,
    cleanup: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("peer fetch", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forwards token as Authorization and trusts inline certificate", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    let capturedAuthorization = "";
    const fetchSpy = withStubbedSnapshotFetch((url, init) => {
      if (url === "https://macmini.ai:7843/v1/fleet/snapshot") {
        capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      }
      return makeSnapshot("mac-mini");
    });

    try {
      const peer: PeerNode = {
        id: "mac-mini",
        endpoint: "https://macmini.ai:7843",
        certificate: cert.certPem,
        token: "peer-token",
      };
      const snapshot = await createPeerFetch(peer)();
      expect(snapshot?.node).toBe("mac-mini");
      expect(capturedAuthorization).toBe("Bearer peer-token");
      expect(fetchSpy.captured()?.url).toBe("https://macmini.ai:7843/v1/fleet/snapshot");
    } finally {
      fetchSpy.cleanup();
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("resolves tokenRef via tokenRef when token is absent", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    let capturedAuthorization = "";
    const tokenPath = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-token-"));
    writeFileSync(join(tokenPath, "token"), "  ref-token  \n", "utf8");
    const fetchSpy = withStubbedSnapshotFetch((url, init) => {
      if (url === "https://macmini.ai:7843/v1/fleet/snapshot") {
        capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      }
      return makeSnapshot("mac-mini");
    });
    try {
      const peer: PeerNode = {
        id: "mac-mini",
        endpoint: "https://macmini.ai:7843",
        certificate: cert.certPem,
        tokenRef: join(tokenPath, "token"),
      };
      const snapshot = await createPeerFetch(peer)();
      expect(snapshot?.node).toBe("mac-mini");
      expect(capturedAuthorization).toBe("Bearer ref-token");
      expect(fetchSpy.captured()?.url).toBe("https://macmini.ai:7843/v1/fleet/snapshot");
    } finally {
      fetchSpy.cleanup();
      rmSync(certDir, { recursive: true, force: true });
      rmSync(tokenPath, { recursive: true, force: true });
    }
  });

  test("tunnelPreferred peer routes fleetSnapshot through tunnel relay", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-central-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1"],
    });
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: requestUrl(input), init });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: "res",
            id: "relay-1",
            result: parsedSnapshot("mac-mini"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    try {
      const peer = {
        id: "mac-mini",
        endpoint: "https://direct-macmini.invalid:7843",
        tunnelPreferred: true,
        tunnelCentralUrl: "https://central.local:7843",
        tunnelCentralCertificate: cert.certPem,
        tunnelCentralFingerprint: cert.fingerprint,
        tunnelRelayToken: "local-agent-token",
        tunnelNodeName: "mac-mini-tunnel",
      } as PeerNode;
      const snapshot = await createPeerFetch(peer)();

      expect(snapshot?.node).toBe("mac-mini");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://central.local:7843/tunnel-relay/mac-mini-tunnel");
      const init = captured[0]!.init as RequestInit & { tls?: { ca?: string } };
      expect(init.method).toBe("POST");
      expect(init.tls?.ca).toBe(cert.certPem);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer local-agent-token");
      expect(requestBodyJson(init)).toEqual({
        method: "fleetSnapshot",
        type: "query",
        input: undefined,
      });
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("non-tunnel peer keeps the direct request byte-for-byte", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-direct-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: requestUrl(input), init });
      return Promise.resolve(
        new Response(makeSnapshot("mac-mini"), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      const peer: PeerNode = {
        id: "mac-mini",
        endpoint: "https://macmini.ai:7843",
        certificate: cert.certPem,
        token: "peer-token",
      };
      const snapshot = await createPeerFetch(peer)();

      expect(snapshot?.node).toBe("mac-mini");
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://macmini.ai:7843/v1/fleet/snapshot");
      const init = captured[0]!.init as RequestInit & {
        tls?: { ca?: string; servername?: string };
      };
      expect(init.method).toBe("GET");
      expect(init.tls).toEqual({ ca: cert.certPem });
      expect(init.tls?.servername).toBeUndefined();
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer peer-token");
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("SAN mismatch fails direct fetch but succeeds through the tunnel", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-san-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "127.0.0.1",
      hostnames: ["127.0.0.1"],
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(makeSnapshot("mac-mini"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      tls: { cert: cert.certPem, key: cert.keyPem },
    });
    try {
      const endpoint = `https://localhost:${String(server.port)}`;
      const directPeer: PeerNode = {
        id: "mac-mini",
        endpoint,
        certificate: cert.certPem,
        token: "peer-token",
      };
      await expectRejectsToThrow(createPeerFetch(directPeer)());

      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              type: "res",
              id: "relay-1",
              result: parsedSnapshot("mac-mini"),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )) as unknown as typeof fetch;
      const tunnelPeer = {
        ...directPeer,
        tunnelPreferred: true,
        tunnelCentralUrl: "https://central.local:7843",
        tunnelCentralCertificate: cert.certPem,
        tunnelCentralFingerprint: cert.fingerprint,
        tunnelRelayToken: "local-agent-token",
      } as PeerNode;
      const snapshot = await createPeerFetch(tunnelPeer)();
      expect(snapshot?.node).toBe("mac-mini");
    } finally {
      await server.stop(true);
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("tunnelPreferred without relay pinning fails closed before network I/O", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(makeSnapshot("mac-mini"), { status: 200 }));
    }) as unknown as typeof fetch;
    const peer = {
      id: "mac-mini",
      endpoint: "https://macmini.ai:7843",
      tunnelPreferred: true,
      tunnelCentralUrl: "https://central.local:7843",
      tunnelRelayToken: "local-agent-token",
    } as PeerNode;

    await expectRejectsToThrow(createPeerFetch(peer)(), /tunnelCentralFingerprint/);
    expect(calls).toBe(0);
  });

  test("tunnelPreferred without tunnelCentralUrl refuses direct fallback", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(makeSnapshot("mac-mini"), { status: 200 }));
    }) as unknown as typeof fetch;
    const peer = {
      id: "mac-mini",
      endpoint: "https://macmini.ai:7843",
      tunnelPreferred: true,
      tunnelRelayToken: "local-agent-token",
    } as PeerNode;

    await expectRejectsToThrow(createPeerFetch(peer)(), /cannot route via reverse tunnel/);
    expect(calls).toBe(0);
  });

  test("https non-local peer without pinned certificate refuses direct fetch", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(makeSnapshot("mac-mini"), { status: 200 }));
    }) as unknown as typeof fetch;
    const peer: PeerNode = {
      id: "no-cert",
      endpoint: "https://macmini.ai:7843",
      token: "peer-token",
    };

    await expectRejectsToThrow(createPeerFetch(peer)(), /no pinned certificate/);
    expect(calls).toBe(0);
  });

  test("direct peer with mismatched fingerprint refuses before network I/O", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-fp-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response(makeSnapshot("mac-mini"), { status: 200 }));
    }) as unknown as typeof fetch;
    try {
      const peer: PeerNode = {
        id: "bad-fp",
        endpoint: "https://macmini.ai:7843",
        certificate: cert.certPem,
        fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        token: "peer-token",
      };
      await expectRejectsToThrow(createPeerFetch(peer)(), /fingerprint mismatch/);
      expect(calls).toBe(0);
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("local https endpoint without a pinned certificate still proceeds", async () => {
    const captured: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: requestUrl(input), init });
      return Promise.resolve(
        new Response(makeSnapshot("mac-mini"), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const peer: PeerNode = {
      id: "local-peer",
      endpoint: "https://127.0.0.1:7843",
      token: "peer-token",
    };
    const snapshot = await createPeerFetch(peer)();
    expect(snapshot?.node).toBe("mac-mini");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://127.0.0.1:7843/v1/fleet/snapshot");
    expect(new Headers(captured[0]!.init?.headers).get("authorization")).toBe("Bearer peer-token");
  });

  test("new-peer snapshot carries health_rtt_ms and null percentiles through peer fetch (#277)", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-rtt-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "peer.test",
      hostnames: ["peer.test"],
    });
    try {
      const workloadFetch = async (url: string): Promise<Response> => {
        if (url.endsWith("/health")) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return new Response("ok", { status: 200 });
        }
        if (url.endsWith("/v1/models"))
          return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
        return new Response("", { status: 404 });
      };
      const probeFn = makeDefaultProbeFn({
        fetch: workloadFetch as unknown as typeof fetch,
        timeoutMs: 500,
        consecutiveErrors: new Map(),
      });
      const snap = await probeFn({
        name: "mlx-host-peer",
        endpoint: "http://127.0.0.1:8086",
        kind: "ModelHost",
      });
      const body = JSON.stringify({
        kind: "fleet-snapshot",
        ts: "2026-05-25T17:00:00.000Z",
        node: "peer-node",
        node_mem: {
          free_mb: 2048,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          compressor_mb: 0,
          swap_in: 0,
          swap_out: 0,
        },
        workloads: [snap],
      });
      const fetchSpy = withStubbedSnapshotFetch(() => body);
      try {
        const peer: PeerNode = {
          id: "peer-node",
          endpoint: "https://peer.test:7843",
          certificate: cert.certPem,
          token: "t",
        };
        const snapshot = await createPeerFetch(peer)();
        const workload = snapshot?.workloads[0];
        expect(workload?.p50_ms).toBeNull();
        expect(workload?.p95_ms).toBeNull();
        expect(typeof workload?.health_rtt_ms).toBe("number");
        expect(workload?.health_rtt_ms).toBeGreaterThan(0);
      } finally {
        fetchSpy.cleanup();
      }
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  // Kills: any future strict peer parser that drops unknown keys
  // (future_field) or requires health_rtt_ms on incoming workloads.
  test("older peer without health_rtt_ms and unknown fields are tolerated (#277)", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-legacy-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "peer.test",
      hostnames: ["peer.test"],
    });
    try {
      const body = JSON.stringify({
        kind: "fleet-snapshot",
        ts: "2026-05-25T17:00:00.000Z",
        node: "old-peer",
        future_field: { x: 1 },
        node_mem: {
          free_mb: 2048,
          active_mb: 0,
          inactive_mb: 0,
          wired_mb: 0,
          compressor_mb: 0,
          swap_in: 0,
          swap_out: 0,
        },
        workloads: [
          {
            name: "legacy-host",
            kind: "ModelHost",
            endpoint: "http://127.0.0.1:8086",
            priority: 50,
            rss_mb: null,
            request_rate_5m: null,
            error_rate_5m: 0,
            p50_ms: 10,
            p95_ms: 20,
            models: ["m"],
            reachable: true,
            consecutiveErrors: 0,
            revision: null,
            future_field: { x: 1 },
          },
        ],
      });
      const fetchSpy = withStubbedSnapshotFetch(() => body);
      try {
        const peer: PeerNode = {
          id: "old-peer",
          endpoint: "https://peer.test:7843",
          certificate: cert.certPem,
          token: "t",
        };
        const snapshot = await createPeerFetch(peer)();
        expect(snapshot).not.toBeNull();
        if (!snapshot) return;
        const workload = snapshot.workloads[0]!;
        expect(workload.p95_ms).toBe(20);
        expect(workload.health_rtt_ms).toBeUndefined();
        expect("health_rtt_ms" in workload).toBe(false);
        // future_field is not part of the typed snapshot; read it untyped.
        expect((workload as unknown as Record<string, unknown>)["future_field"]).toEqual({ x: 1 });
        expect((snapshot as unknown as Record<string, unknown>)["future_field"]).toEqual({
          x: 1,
        });
        expect(
          detectDegradation(workload, "healthy", {
            consecutiveErrorsForDegraded: 3,
            p95DegradedMs: 5_000,
            consecutiveCompletionErrorsForDegraded: 2,
          }),
        ).toBeNull();
      } finally {
        fetchSpy.cleanup();
      }
    } finally {
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
