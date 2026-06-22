/* eslint-disable @typescript-eslint/require-await -- Test fetch stub implements the async fetch contract without artificial scheduling. */
import type { PeerNode } from "@llamactl/core/config/peers";

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSelfSignedCert } from "../../remote/src/server/tls.js";
import { createPeerFetch } from "../src/peer-fetch.js";
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

function withStubbedSnapshotFetch(
  peerRequestCapture: (url: string, init: RequestInit | undefined) => string,
): {
  captured: () => { url: string; headers: Headers } | null;
  cleanup: () => void;
} {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; headers: Headers } | null = null;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    captured = { url, headers: new Headers(init?.headers) };
    const responseBody = peerRequestCapture(url, init);
    return new Response(responseBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
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
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          type: "res",
          id: "relay-1",
          result: JSON.parse(makeSnapshot("mac-mini")),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
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
      expect(JSON.parse(init.body as string)).toEqual({
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
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init });
      return new Response(makeSnapshot("mac-mini"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
      await expect(createPeerFetch(directPeer)()).rejects.toThrow();

      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({
            type: "res",
            id: "relay-1",
            result: JSON.parse(makeSnapshot("mac-mini")),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
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
      server.stop(true);
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("tunnelPreferred without relay pinning fails closed before network I/O", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(makeSnapshot("mac-mini"), { status: 200 });
    }) as unknown as typeof fetch;
    const peer = {
      id: "mac-mini",
      endpoint: "https://macmini.ai:7843",
      tunnelPreferred: true,
      tunnelCentralUrl: "https://central.local:7843",
      tunnelRelayToken: "local-agent-token",
    } as PeerNode;

    await expect(createPeerFetch(peer)()).rejects.toThrow(/tunnelCentralFingerprint/);
    expect(calls).toBe(0);
  });

  test("tunnelPreferred without tunnelCentralUrl refuses direct fallback", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(makeSnapshot("mac-mini"), { status: 200 });
    }) as unknown as typeof fetch;
    const peer = {
      id: "mac-mini",
      endpoint: "https://macmini.ai:7843",
      tunnelPreferred: true,
      tunnelRelayToken: "local-agent-token",
    } as PeerNode;

    await expect(createPeerFetch(peer)()).rejects.toThrow(/cannot route via reverse tunnel/);
    expect(calls).toBe(0);
  });
});
