import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";
import { generateSelfSignedCert } from "../src/server/tls.js";

interface Fixture {
  stats: {
    requests: number;
    active: number;
    completed: number;
    disconnected: number;
    bytes: number;
  };
  ports: Set<number>;
  bodyBytes: number;
  peer: { id: string; endpoint: string; certificate?: string; fingerprint?: string };
  stop(): Promise<void>;
}

async function fixture(tls: boolean, status: number, slow: boolean): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-body-"));
  const cert = await generateSelfSignedCert({
    dir,
    commonName: "127.0.0.1",
    hostnames: ["127.0.0.1"],
  });
  const stats = { requests: 0, active: 0, completed: 0, disconnected: 0, bytes: 0 };
  const ports = new Set<number>();
  const payload = JSON.stringify({
    node_mem: { free_mb: 1024, inactive_mb: 2048 },
    workloads: [{ models: ["synthetic"], endpoint: "http://127.0.0.1:8086", reachable: true }],
  });
  const chunk = Buffer.alloc(4096, 120);
  const chunks = 96;
  const server = tls
    ? createHttpsServer({ cert: cert.certPem, key: cert.keyPem })
    : createHttpServer();
  server.on("request", (req, res) => {
    stats.requests += 1;
    stats.active += 1;
    ports.add(req.socket.remotePort!);
    let written = 0;
    const timer = slow
      ? setInterval(() => {
          stats.bytes += chunk.length;
          res.write(chunk);
          if (++written === chunks) {
            clearInterval(timer);
            res.end();
          }
        }, 20)
      : undefined;
    let settled = false;
    const disconnected = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      stats.active -= 1;
      stats.disconnected += 1;
    };
    req.socket.on("close", disconnected);
    res.on("finish", () => {
      if (settled) return;
      settled = true;
      req.socket.off("close", disconnected);
      stats.active -= 1;
      stats.completed += 1;
    });
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": slow ? chunk.length * chunks : Buffer.byteLength(payload),
    });
    res.flushHeaders();
    if (!slow) {
      res.end(payload);
      return;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  return {
    stats,
    ports,
    bodyBytes: chunk.length * chunks,
    peer: {
      id: "synthetic",
      endpoint: `${tls ? "https" : "http"}://127.0.0.1:${String(address.port)}`,
      ...(tls ? { certificate: cert.certPem, fingerprint: cert.fingerprint } : {}),
    },
    async stop(): Promise<void> {
      const closed = new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server.closeAllConnections();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settleClosed(stats: { active: number }): Promise<void> {
  const deadline = Date.now() + 500;
  while (stats.active !== 0 && Date.now() < deadline) await Bun.sleep(5);
}

describe("peer snapshot native response cleanup", () => {
  test("aborts discarded TLS error bodies before returning idle", async () => {
    const f = await fixture(true, 503, true);
    try {
      for (let i = 0; i < 6; i += 1) {
        expect(await __peerSnapshotInternals.fetchPeerSnapshot(f.peer, 1234)).toBeNull();
      }
      await settleClosed(f.stats);
      expect(f.stats.requests).toBe(6);
      expect(f.stats.active).toBe(0);
      expect(f.stats.disconnected).toBe(6);
      expect(f.stats.completed).toBe(0);
      expect(f.stats.bytes).toBeLessThan(6 * f.bodyBytes);
    } finally {
      await f.stop();
    }
  });

  for (const tls of [false, true]) {
    test(`consumes successful ${tls ? "TLS" : "HTTP"} snapshots and reuses the connection`, async () => {
      const f = await fixture(tls, 200, false);
      try {
        for (let i = 0; i < 2; i += 1) {
          expect(await __peerSnapshotInternals.fetchPeerSnapshot(f.peer, 1234)).toEqual({
            workloads: [{ modelId: "synthetic", port: 8086, revision: null }],
            pressure: "NORMAL",
            fetchedAt: 1234,
          });
        }
        await settleClosed(f.stats);
        expect(f.stats.completed).toBe(2);
        expect(f.stats.disconnected).toBe(0);
        expect(f.ports.size).toBe(1);
      } finally {
        await f.stop();
      }
    });
  }

  test("aborts a timed-out TLS body read", async () => {
    const f = await fixture(true, 200, true);
    try {
      expect(await __peerSnapshotInternals.fetchPeerSnapshot(f.peer, 1234, 40)).toBeNull();
      await settleClosed(f.stats);
      expect(f.stats.active).toBe(0);
      expect(f.stats.disconnected).toBe(1);
      expect(f.stats.completed).toBe(0);
      expect(f.stats.bytes).toBeLessThan(f.bodyBytes);
    } finally {
      await f.stop();
    }
  });
});
