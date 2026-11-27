import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { hashToken } from "../src/server/auth.js";
import {
  __peerSnapshotInternals,
  startPeerSnapshotPoller,
} from "../src/server/peer-snapshot-poller.js";
import { startAgentServer } from "../src/server/serve.js";
import { generateSelfSignedCert } from "../src/server/tls.js";

const OWNER = "owner-node";
const TOKEN = "fixture-read-only-token";
const CAPABILITY = "x-llamactl-declaration-provenance";
const MODEL = "org/ready.gguf";
type DeclarationProvenance = NonNullable<PeerSnapshot["declaredProvenance"]>;
const LIVE = {
  name: "ready-host",
  kind: "ModelHost" as const,
  models: [MODEL],
  endpoint: "http://127.0.0.1:8081",
  reachable: true,
  revision: "legacy-cache-boot-token",
};
const READY = {
  id: MODEL,
  workload: LIVE.name,
  kind: LIVE.kind,
  ownerNodeId: OWNER,
  state: "ready",
  artifactRevision: `sha256:${"a".repeat(64)}`,
  policyRevision: `sha256:${"1".repeat(64)}`,
  deploymentEpoch: "generation:ready-7",
} satisfies DeclarationProvenance["entries"][number];
const COLD = {
  id: "org/cold.gguf",
  workload: "cold-run",
  kind: "ModelRun",
  ownerNodeId: OWNER,
  state: "cold",
  artifactRevision: `sha256:${"b".repeat(64)}`,
  policyRevision: `sha256:${"2".repeat(64)}`,
} satisfies DeclarationProvenance["entries"][number];
const PROOF = { schemaVersion: 1, entries: [READY, COLD] } satisfies DeclarationProvenance;

function journal(workloads: unknown[], extra?: Record<string, unknown>): string {
  return (
    JSON.stringify({
      kind: "fleet-snapshot",
      ts: new Date().toISOString(),
      node: OWNER,
      node_mem: { free_mb: 4096, inactive_mb: 0 },
      workloads,
      ...extra,
    }) + "\n"
  );
}

function fleetRequest(url: string, version?: string, authenticated = true): Request {
  const headers = new Headers();
  if (version !== undefined) headers.set(CAPABILITY, version);
  if (authenticated) headers.set("authorization", `Bearer ${TOKEN}`);
  return new Request(new URL("/v1/fleet/snapshot?include=local-routes", url).href, { headers });
}

test("qualified peer provenance travels through authenticated fleet GET and pinned poller", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-provenance-"));
  const journalPath = join(dir, "journal.jsonl");
  const journalClaim = { ...PROOF, entries: [{ ...READY, deploymentEpoch: "injected-journal" }] };
  writeFileSync(journalPath, journal([LIVE], { declaredProvenance: journalClaim }));
  const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
  let published: unknown = PROOF;
  let reads = 0;
  const options = {
    nodeName: OWNER,
    tokenHash: hashToken(TOKEN),
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
    fleetJournalPath: journalPath,
    peerDeclarationProvenance: (): unknown => {
      reads++;
      return published;
    },
  };
  const agent = startAgentServer(options);
  try {
    const legacyCaller = router.createCaller({ fleetJournalPath: journalPath });
    expect(await legacyCaller.fleetSnapshot({ include: ["local-routes"] })).not.toHaveProperty(
      "declaredProvenance",
    );
    const handleRequest = agent.handleRequest;
    if (handleRequest === undefined)
      throw new Error("fixture agent did not expose request handling");
    expect((await handleRequest(fleetRequest(agent.url, "1", false))).status).toBe(401);
    expect(reads).toBe(0);

    for (const version of [undefined, "2"]) {
      const older = await handleRequest(fleetRequest(agent.url, version));
      expect(older.status).toBe(200);
      expect(await older.json()).not.toHaveProperty("declaredProvenance");
    }
    expect(reads).toBe(0);

    const peer = {
      id: OWNER,
      endpoint: agent.url,
      token: TOKEN,
      certificate: cert.certPem,
      fingerprint: cert.fingerprint,
    };
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 100)).toEqual({
      workloads: [{ modelId: MODEL, port: 8081, revision: LIVE.revision }],
      declaredProvenance: PROOF,
      pressure: "NORMAL",
      fetchedAt: 100,
    });
    expect(reads).toBe(1);
    published = { ...PROOF, schemaVersion: 2 };
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 100)).not.toHaveProperty(
      "declaredProvenance",
    );

    writeFileSync(journalPath, "");
    const coldOnly = { schemaVersion: 1, entries: [COLD] } satisfies DeclarationProvenance;
    published = coldOnly;
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 101)).toEqual({
      workloads: [],
      declaredProvenance: coldOnly,
      pressure: "NORMAL",
      fetchedAt: 101,
    });
    expect(reads).toBe(3);
  } finally {
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy, invalid, wrong-owner and ambiguous peer evidence does not become proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-wire-"));
  const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
  let payload: unknown = { workloads: [LIVE] };
  let redirect = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: cert.certPem, key: cert.keyPem },
    fetch(req): Response {
      const url = new URL(req.url);
      if (redirect && url.pathname === "/v1/fleet/snapshot") {
        return Response.redirect(new URL("/other-publisher", url).href);
      }
      return Response.json(payload);
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("fixture peer did not bind");
  const peer = {
    id: OWNER,
    endpoint: `https://127.0.0.1:${String(port)}`,
    token: TOKEN,
    certificate: cert.certPem,
    fingerprint: cert.fingerprint,
  };
  try {
    const legacy: PeerSnapshot = {
      workloads: [{ modelId: MODEL, port: 8081, revision: LIVE.revision }],
      pressure: "NORMAL",
      fetchedAt: 200,
    };
    for (const raw of [
      { workloads: [LIVE] },
      { workloads: [LIVE], declaredProvenance: { ...PROOF, schemaVersion: 2 } },
      {
        workloads: [LIVE],
        declaredProvenance: { ...PROOF, entries: [{ ...READY, ownerNodeId: "different-node" }] },
      },
      {
        workloads: [LIVE],
        declaredProvenance: { ...PROOF, entries: [READY, { ...READY, workload: "other-host" }] },
      },
      { workloads: [LIVE, { ...LIVE, name: "other-host" }], declaredProvenance: PROOF },
      {
        workloads: [LIVE],
        declaredProvenance: { ...PROOF, entries: [{ ...READY, workload: "other-host" }] },
      },
      {
        workloads: [LIVE],
        declaredProvenance: {
          ...PROOF,
          entries: [{ ...READY, artifactRevision: "/host/private.gguf" }],
        },
      },
      {
        workloads: [LIVE],
        declaredProvenance: { ...PROOF, entries: [{ ...READY, deploymentEpoch: undefined }] },
      },
    ]) {
      payload = raw;
      expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 200)).toEqual(legacy);
    }
    payload = { workloads: [LIVE], declaredProvenance: PROOF };
    const { token: _token, ...withoutToken } = peer;
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(withoutToken, 200)).toEqual(legacy);
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 200)).toEqual({
      ...legacy,
      declaredProvenance: PROOF,
    });
    redirect = true;
    expect(await __peerSnapshotInternals.fetchPeerSnapshot(peer, 200)).toBeNull();
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetch failures, duplicate identities, and discovery failures retain only legacy routes", async () => {
  const peer = { id: OWNER, endpoint: "https://127.0.0.1:1234" };
  const other = { ...peer, endpoint: "https://127.0.0.1:1235" };
  const legacy: PeerSnapshot = {
    workloads: [{ modelId: MODEL, port: 8081 }],
    pressure: "NORMAL",
    fetchedAt: 100,
  };
  const fresh: PeerSnapshot = {
    ...legacy,
    declaredProvenance: {
      schemaVersion: 1,
      entries: [READY],
    },
  };
  const publications: (PeerSnapshot | undefined)[] = [];
  const done = Promise.withResolvers<boolean>();
  const stop = startPeerSnapshotPoller({
    intervalMs: 2,
    listPeersFn: () => {
      if (publications.length === 4) {
        queueMicrotask(() => {
          done.resolve(true);
        });
        throw new Error("invalid fixture kubeconfig");
      }
      return publications.length === 2 ? [peer, other] : [peer];
    },
    fetchFn: () => Promise.resolve(publications.length === 1 ? null : fresh),
    publish(next): void {
      publications.push(next.get(OWNER));
    },
  });
  try {
    await done.promise;
    expect(publications).toEqual([fresh, legacy, legacy, fresh, legacy]);
  } finally {
    stop();
  }
});
