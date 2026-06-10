import { createTRPCClient } from "@trpc/client";

import type { PeerNode } from "../config/peers.js";
import type { AppRouter } from "../router.js";

import { loadConfig, resolveToken } from "../config/kubeconfig.js";
import { type ClusterNode, LOCAL_NODE_ENDPOINT } from "../config/schema.js";
import { buildPinnedLinks, makePinnedFetch } from "./links.js";
import { createNodeClient } from "./node-client.js";

export interface InfraClient {
  install(args: {
    pkg: string;
    version: string;
    tarballUrl: string;
    sha256: string;
    activate: boolean;
    skipIfPresent: boolean;
  }): Promise<void>;
  activate(args: { pkg: string; version: string }): Promise<void>;
  pollHealth(opts: { timeoutMs: number; pollIntervalMs: number }): Promise<"healthy" | "timeout">;
}

function resolvedPeerToken(peer: PeerNode): string | undefined {
  if (peer.token) return peer.token;
  if (!peer.tokenRef) return undefined;
  try {
    return resolveToken({ name: peer.id, tokenRef: peer.tokenRef });
  } catch {
    return undefined;
  }
}

function remoteClient(peer: PeerNode) {
  const token = resolvedPeerToken(peer);
  return createTRPCClient<AppRouter>({
    links: buildPinnedLinks(
      {
        name: peer.id,
        endpoint: peer.endpoint,
        certificate: peer.certificate,
        certificateFingerprint: peer.fingerprint,
      },
      token ?? "",
      makePinnedFetch,
    ),
  });
}

function localNodeClient(peer: PeerNode): ReturnType<typeof createNodeClient> {
  const config = loadConfig();
  if (
    !config.clusters.some((cluster) =>
      cluster.nodes.some((candidate) => candidate.name === peer.id),
    )
  ) {
    throw new Error(`local peer '${peer.id}' not found in kubeconfig`);
  }
  return createNodeClient(config, { nodeName: peer.id });
}

function isLocalPeer(peer: PeerNode): boolean {
  return peer.endpoint === LOCAL_NODE_ENDPOINT || peer.endpoint.startsWith("inproc://");
}

function snapshotFetch(
  peer: PeerNode,
): () => Promise<Awaited<ReturnType<InfraClient["pollHealth"]>>> {
  const token = resolvedPeerToken(peer);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const pinnedFetch = makePinnedFetch({
    name: peer.id,
    endpoint: peer.endpoint,
    certificate: peer.certificate,
    fingerprint: peer.fingerprint,
  } as ClusterNode);
  const target = new URL("/v1/fleet/snapshot", peer.endpoint);
  return async () => {
    const res = await pinnedFetch(
      target,
      Object.keys(headers).length ? { method: "GET", headers } : { method: "GET" },
    );
    if (res.status === 204) return "timeout";
    if (!res.ok) throw new Error(`peer ${peer.id} returned ${String(res.status)}`);
    const snapshot = (await res.json()) as { workloads: { reachable: boolean }[] } | null;
    if (
      snapshot &&
      snapshot.workloads.length > 0 &&
      snapshot.workloads.every((workload) => workload.reachable)
    ) {
      return "healthy";
    }
    return "timeout";
  };
}

export function makeInfraClient(peer: PeerNode): InfraClient {
  if (isLocalPeer(peer)) {
    const client = localNodeClient(peer);
    return {
      install: async (args) => {
        await client.infraInstall.mutate(args);
      },
      activate: async (args) => {
        await client.infraActivate.mutate(args);
      },
      pollHealth: async (opts) => {
        const probe = snapshotFetch(peer);
        const start = Date.now();
        while (Date.now() - start <= opts.timeoutMs) {
          if ((await probe()) === "healthy") return "healthy";
          await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
        }
        return "timeout";
      },
    };
  }

  const client = remoteClient(peer);
  return {
    install: async (args) => {
      await client.infraInstall.mutate(args);
    },
    activate: async (args) => {
      await client.infraActivate.mutate(args);
    },
    pollHealth: async (opts) => {
      const probe = snapshotFetch(peer);
      const start = Date.now();
      while (Date.now() - start <= opts.timeoutMs) {
        if ((await probe()) === "healthy") return "healthy";
        await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
      }
      return "timeout";
    },
  };
}
