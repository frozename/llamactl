import type { ClusterNode } from "@llamactl/remote";

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as undici from "undici/index.js";

import { generateSelfSignedCert } from "../../../../remote/src/server/tls.js";

// Bun exposes an Agent stub for the bare specifier; exercise Electron's installed implementation.
mock.module("undici", () => undici);
const { makeNodePinnedFetch } = await import("../../../electron/trpc/node-pinned-fetch.js");

describe("makeNodePinnedFetch", () => {
  test("refuses remote agent nodes without a pinned certificate", () => {
    const node: ClusterNode = {
      name: "gpu1",
      endpoint: "https://gpu1.example.test:7443",
    };

    expect(() => makeNodePinnedFetch(node)).toThrow(
      "node 'gpu1' has no pinned certificate; refusing to connect",
    );
  });

  test("allows loopback nodes without a pinned certificate", () => {
    const node: ClusterNode = {
      name: "dev-agent",
      endpoint: "http://127.0.0.1:7843",
    };

    expect(() => makeNodePinnedFetch(node)).not.toThrow();
  });
});

describe("undici forwarded TLS identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "app-forward-tls-"));
  let server: ReturnType<typeof Bun.serve>;
  let node: ClusterNode;
  let otherCertificate: string;
  let otherFingerprint: string;
  let requests = 0;

  beforeAll(async () => {
    const cert = await generateSelfSignedCert({
      dir: directory,
      commonName: "worker.example.test",
    });
    const other = await generateSelfSignedCert({
      dir: join(directory, "other"),
      commonName: "worker.example.test",
    });
    otherCertificate = other.certPem;
    otherFingerprint = other.fingerprint;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: cert.certPem, key: cert.keyPem },
      fetch() {
        requests++;
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
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  });

  async function read(candidate: ClusterNode): Promise<string | null> {
    const original = globalThis.fetch;
    globalThis.fetch = undici.fetch as unknown as typeof fetch;
    try {
      return await makeNodePinnedFetch(candidate)(candidate.endpoint).then(
        (response) => response.text(),
        () => null,
      );
    } finally {
      globalThis.fetch = original;
    }
  }

  test("verifies the configured identity through undici", async () => {
    expect(await read(node)).toBe("verified");
  });
  test("rejects a different certificate name before sending credentials", async () => {
    const before = requests;
    expect(await read({ ...node, tlsServerName: "wrong.example.test" })).toBeNull();
    expect(requests).toBe(before);
  });
  test("rejects a different CA before sending credentials", async () => {
    const before = requests;
    expect(
      await read({
        ...node,
        certificate: otherCertificate,
        certificateFingerprint: otherFingerprint,
      }),
    ).toBeNull();
    expect(requests).toBe(before);
  });
  test("retains endpoint identity checks without an override", async () => {
    const { tlsServerName: _, ...without } = node;
    expect(await read(without)).toBeNull();
  });
  test("rejects a wrong fingerprint before connecting", () => {
    const before = requests;
    expect(() =>
      makeNodePinnedFetch({ ...node, certificateFingerprint: "sha256:" + "0".repeat(64) }),
    ).toThrow(/fingerprint mismatch/);
    expect(requests).toBe(before);
  });
});
