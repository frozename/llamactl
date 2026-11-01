import { type ClusterNode, ClusterNodeSchema } from "@llamactl/core/config/schema";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeInfraClient } from "../src/client/infra-client.js";
import { makePinnedFetch } from "../src/client/links.js";
import { __peerSnapshotInternals } from "../src/server/peer-snapshot-poller.js";
import { generateSelfSignedCert } from "../src/server/tls.js";

const dir = mkdtempSync(join(tmpdir(), "llamactl-forward-tls-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let node: ClusterNode & {
  certificate: string;
  certificateFingerprint: string;
  tlsServerName: string;
};
let requests = 0;
let otherCertificate: string;
let otherFingerprint: string;
beforeAll(async () => {
  const cert = await generateSelfSignedCert({ dir, commonName: "worker.example.test" });
  const other = await generateSelfSignedCert({
    dir: join(dir, "other"),
    commonName: "worker.example.test",
  });
  otherCertificate = other.certPem;
  otherFingerprint = other.fingerprint;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch(req) {
      requests++;
      if (new URL(req.url).pathname === "/v1/fleet/snapshot")
        return Response.json({
          workloads: [
            { reachable: true, models: ["synthetic"], endpoint: "http://127.0.0.1:8086" },
          ],
        });
      return new Response("verified");
    },
  });
  node = {
    name: "forwarded",
    endpoint: `https://127.0.0.1:${String(server.port)}`,
    certificate: cert.certPem,
    certificateFingerprint: cert.fingerprint,
    tlsServerName: "worker.example.test",
  };
});
afterAll(async () => {
  await server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
test("schema preserves an explicit TLS server identity", () => {
  expect(ClusterNodeSchema.parse(node)).toHaveProperty("tlsServerName", "worker.example.test");
  expect(ClusterNodeSchema.safeParse({ ...node, tlsServerName: "" }).success).toBe(false);
});
test("verifies a forwarded connection against the configured certificate name", async () => {
  const text = await makePinnedFetch(node)(node.endpoint).then(
    (response) => response.text(),
    () => null,
  );
  expect(text).toBe("verified");
});
test("rejects a different server identity before sending the request", async () => {
  const before = requests;
  const error: unknown = await makePinnedFetch({ ...node, tlsServerName: "wrong.example.test" })(
    node.endpoint,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(requests).toBe(before);
});
test("retains endpoint hostname verification when no override is configured", async () => {
  const { tlsServerName: _, ...without } = node;
  const error: unknown = await makePinnedFetch(without)(node.endpoint).then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
});
test("rejects a mismatched certificate fingerprint before connecting", () => {
  expect(() =>
    makePinnedFetch({ ...node, certificateFingerprint: "sha256:" + "0".repeat(64) }),
  ).toThrow(/fingerprint mismatch/);
});

test("peer health polling verifies the forwarded certificate identity", async () => {
  const client = makeInfraClient({
    id: node.name,
    endpoint: node.endpoint,
    certificate: node.certificate,
    fingerprint: node.certificateFingerprint,
    tlsServerName: node.tlsServerName,
  });
  const health = await client.pollHealth({ timeoutMs: 100, pollIntervalMs: 1 }).catch(() => null);
  expect(health).toBe("healthy");
});

test("rejects an untrusted server certificate before sending the request", async () => {
  const before = requests;
  const result: unknown = await makePinnedFetch({
    ...node,
    certificate: otherCertificate,
    certificateFingerprint: otherFingerprint,
  })(node.endpoint).then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect(requests).toBe(before);
});

test("peer snapshot polling preserves the configured TLS identity", async () => {
  const result = await __peerSnapshotInternals.fetchPeerSnapshot(
    {
      id: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate,
      fingerprint: node.certificateFingerprint,
      tlsServerName: node.tlsServerName,
    },
    1234,
  );
  expect(result?.workloads).toEqual([{ modelId: "synthetic", port: 8086, revision: null }]);
});

test("peer snapshot polling rejects a bad fingerprint before connecting", async () => {
  const before = requests;
  const result = await __peerSnapshotInternals.fetchPeerSnapshot(
    {
      id: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate,
      fingerprint: "sha256:" + "0".repeat(64),
      tlsServerName: node.tlsServerName,
    },
    1234,
  );
  expect(result).toBeNull();
  expect(requests).toBe(before);
});

test("infra health rechecks a changed fingerprint before connecting", async () => {
  const peer = {
    id: node.name,
    endpoint: node.endpoint,
    certificate: node.certificate,
    fingerprint: node.certificateFingerprint,
    tlsServerName: node.tlsServerName,
  };
  const client = makeInfraClient(peer);
  peer.fingerprint = "sha256:" + "0".repeat(64);
  const before = requests;
  const result: unknown = await client.pollHealth({ timeoutMs: 100, pollIntervalMs: 1 }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain("fingerprint mismatch");
  expect(requests).toBe(before);
});
