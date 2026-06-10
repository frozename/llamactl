/* eslint-disable @typescript-eslint/require-await -- Test fetch stub implements the async fetch contract without artificial scheduling. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PeerNode } from "../../remote/src/config/peers.js";

import { generateSelfSignedCert } from "../../remote/src/server/tls.js";
import { createPeerFetch } from "../src/peer-fetch.js";

function makeSnapshot(node: string) {
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
) {
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
    captured: () => captured,
    cleanup: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("peer fetch", () => {
  afterEach(() => {
    globalThis.fetch = fetch;
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
});
