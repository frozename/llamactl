import type { PeerSnapshot } from "@llamactl/core/workloadRuntime";

import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { hashToken } from "../src/server/auth.js";
import {
  type PeerDeclarationHistory,
  recordPeerDeclarationDenials,
} from "../src/server/peer-declaration-denials.js";
import {
  __peerSnapshotInternals,
  startPeerSnapshotPoller,
} from "../src/server/peer-snapshot-poller.js";
import { startAgentServer } from "../src/server/serve.js";
import { generateSelfSignedCert } from "../src/server/tls.js";

const OWNER = "owner-node";
const TOKEN = "fixture-read-only-token";
const CAPABILITY = "x-llamactl-declaration-provenance";
const INVENTORY_CAPABILITY = "x-llamactl-declaration-inventory";
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

test("only a negotiated empty inventory from the same authenticated peer clears retained denials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-empty-inventory-"));
  const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
  const journalPath = join(dir, "fleet.jsonl");
  const empty = { schemaVersion: 2, ownerNodeId: OWNER, complete: true, entries: [] };
  writeFileSync(journalPath, journal([], { declaredInventory: empty }));
  let published: unknown = { schemaVersion: 1, entries: [COLD] };
  const agent = startAgentServer({
    nodeName: OWNER,
    tokenHash: hashToken(TOKEN),
    tls: { certPath: cert.certPath, keyPath: cert.keyPath },
    advertiseMdns: false,
    fleetJournalPath: journalPath,
    peerDeclarationProvenance: (): unknown => published,
  });
  const peer = {
    id: OWNER,
    endpoint: agent.url,
    token: TOKEN,
    certificate: cert.certPem,
    fingerprint: cert.fingerprint,
  };
  let nextTick = Promise.withResolvers<PeerSnapshot | undefined>();
  const stop = startPeerSnapshotPoller({
    listPeersFn: () => [peer],
    intervalMs: 10,
    publish(next): void {
      nextTick.resolve(next.get(OWNER));
    },
  });
  try {
    expect((await nextTick.promise)?.declaredDenials?.aliases.has(COLD.id)).toBe(true);
    const awaitPublish = async (value: unknown): Promise<PeerSnapshot | undefined> => {
      published = value;
      nextTick = Promise.withResolvers<PeerSnapshot | undefined>();
      return await nextTick.promise;
    };
    for (const value of [
      undefined,
      { ...empty, ownerNodeId: "other-owner" },
      { ...empty, complete: false },
      { schemaVersion: 1, entries: [] },
    ]) {
      const snapshot = await awaitPublish(value);
      expect(snapshot?.declaredDenials?.aliases.has(COLD.id)).toBe(true);
      expect(snapshot?.declaredInventory).toBeUndefined();
    }

    const snapshot = await awaitPublish(empty);
    expect(snapshot?.declaredDenials).toBeUndefined();
    expect(snapshot?.declaredInventory).toBeUndefined();
    const request = fleetRequest(agent.url, undefined, false);
    request.headers.set(INVENTORY_CAPABILITY, "2");
    expect((await fetch(request, { tls: { ca: cert.certPem } })).status).toBe(401);

    const oldRequest = fleetRequest(agent.url, "1");
    expect(
      await (await fetch(oldRequest, { tls: { ca: cert.certPem } })).json(),
    ).not.toHaveProperty("declaredInventory");
    const newRequest = fleetRequest(agent.url, "1");
    newRequest.headers.set(INVENTORY_CAPABILITY, "2");
    const response = await fetch(newRequest, { tls: { ca: cert.certPem } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ declaredInventory: empty });
  } finally {
    stop();
    await agent.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retained peer alias history bounds overflow and fences identity replacement", () => {
  const oldPeer = {
    id: OWNER,
    endpoint: "https://peer.invalid:7843",
    certificate: "old-pinned-cert",
    token: TOKEN,
  };
  const newPeer = { ...oldPeer, certificate: "new-pinned-cert" };
  const history: PeerDeclarationHistory = new Map();
  const manyAliases = Array.from({ length: 1025 }, (_, i) => ({
    ...COLD,
    id: `model-${String(i)}`,
  }));
  const update = (
    peer: typeof oldPeer,
    proof: Pick<PeerSnapshot, "declaredProvenance" | "declaredInventory">,
  ): PeerSnapshot | undefined => {
    const snapshots = new Map<string, PeerSnapshot>([
      [OWNER, { workloads: [], fetchedAt: 100, pressure: "NORMAL", ...proof }],
    ]);
    recordPeerDeclarationDenials(history, [peer], new Set(), snapshots);
    return snapshots.get(OWNER);
  };
  const initial = update(oldPeer, {
    declaredProvenance: { schemaVersion: 1, entries: manyAliases },
  })?.declaredDenials;
  expect(initial?.saturated).toBe(true);
  expect(initial?.aliases.size).toBe(1024);
  expect(initial?.aliases.has("model-0")).toBe(true);
  expect(initial?.aliases.has("model-1024")).toBe(false);

  const withdrawal = {
    declaredInventory: { schemaVersion: 2, ownerNodeId: OWNER, complete: true, entries: [] },
  } satisfies Pick<PeerSnapshot, "declaredInventory">;
  const retained = update(newPeer, withdrawal)?.declaredDenials;
  expect(retained?.aliases.size).toBe(1024);
  expect(retained?.saturated).toBe(true);
  expect(update(oldPeer, withdrawal)?.declaredDenials).toBeUndefined();
});

test("temporarily missing peer config preserves history until a valid config removes its owner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-denial-config-"));
  const path = join(dir, "config.yaml");
  const previous = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = path;
  const cfg = freshConfig();
  cfg.clusters[0]?.nodes.push({
    name: OWNER,
    endpoint: "https://peer.invalid:7843",
    certificate: "fixture-certificate",
  });
  saveConfig(cfg, path);
  let nextTick = Promise.withResolvers<PeerSnapshot | undefined>();
  const stop = startPeerSnapshotPoller({
    intervalMs: 5,
    fetchFn: (_peer, fetchedAt) =>
      Promise.resolve({
        workloads: [],
        fetchedAt,
        pressure: "NORMAL",
        declaredProvenance: { schemaVersion: 1, entries: [COLD] },
      }),
    publish(next): void {
      nextTick.resolve(next.get(OWNER));
    },
  });
  try {
    expect((await nextTick.promise)?.declaredDenials?.aliases.has(COLD.id)).toBe(true);
    rmSync(path);
    nextTick = Promise.withResolvers<PeerSnapshot | undefined>();
    expect((await nextTick.promise)?.declaredDenials?.aliases.has(COLD.id)).toBe(true);
    saveConfig(freshConfig(), path);
    nextTick = Promise.withResolvers<PeerSnapshot | undefined>();
    expect(await nextTick.promise).toBeUndefined();
  } finally {
    stop();
    if (previous === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
    else process.env["LLAMACTL_CONFIG"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
