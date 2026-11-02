import type { PeerNode } from "@llamactl/core/config/peers";

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSelfSignedCert } from "../../remote/src/server/tls.js";
import { createPeerFetch } from "../src/peer-fetch.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

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

function captureFetch(): {
  capturedInit: () => (RequestInit & { tls?: { ca?: string; serverName?: string } }) | undefined;
  cleanup: () => void;
} {
  let captured: (RequestInit & { tls?: { ca?: string; serverName?: string } }) | undefined;
  globalThis.fetch = ((_input: Request | string | URL, init?: RequestInit) => {
    captured = init;
    return Promise.resolve(
      new Response(makeSnapshot("mac-mini"), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return {
    capturedInit: () => captured,
    cleanup: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("peer fetch tls server name", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("forwarded peer with certificate passes tlsServerName as serverName", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-sni-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    const spy = captureFetch();
    try {
      const peer: PeerNode = {
        id: "mac-mini",
        endpoint: "https://203.0.113.7:7843",
        certificate: cert.certPem,
        tlsServerName: "macmini.ai",
        token: "peer-token",
      };
      const snapshot = await createPeerFetch(peer)();
      expect(snapshot?.node).toBe("mac-mini");
      const init = spy.capturedInit();
      expect(init?.tls?.ca).toBe(cert.certPem);
      expect(init?.tls?.serverName).toBe("macmini.ai");
    } finally {
      spy.cleanup();
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("serverName is absent when tlsServerName is unset", async () => {
    const certDir = mkdtempSync(join(tmpdir(), "llamactl-peer-fetch-sni-"));
    const cert = await generateSelfSignedCert({
      dir: certDir,
      commonName: "macmini.ai",
      hostnames: ["macmini.ai"],
    });
    const spy = captureFetch();
    try {
      const peer: PeerNode = {
        id: "mac-mini",
        endpoint: "https://macmini.ai:7843",
        certificate: cert.certPem,
        token: "peer-token",
      };
      const snapshot = await createPeerFetch(peer)();
      expect(snapshot?.node).toBe("mac-mini");
      const init = spy.capturedInit();
      expect(init?.tls?.ca).toBe(cert.certPem);
      expect(init?.tls?.serverName).toBeUndefined();
    } finally {
      spy.cleanup();
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("serverName is absent when there is no certificate", async () => {
    const spy = captureFetch();
    try {
      const peer: PeerNode = {
        id: "local-peer",
        endpoint: "https://127.0.0.1:7843",
        tlsServerName: "macmini.ai",
        token: "peer-token",
      };
      const snapshot = await createPeerFetch(peer)();
      expect(snapshot?.node).toBe("mac-mini");
      const init = spy.capturedInit();
      expect(init?.tls).toBeUndefined();
    } finally {
      spy.cleanup();
    }
  });
});
