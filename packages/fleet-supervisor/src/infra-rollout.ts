import type { PeerNode } from "../../remote/src/config/peers.js";
import type { FleetSnapshotEntry } from "./types.js";

export type InfraRolloutStrategy = "one-at-a-time" | "all";

export interface InfraClientLike {
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

export interface RolloutPlan {
  ok: boolean;
  reason?: string;
}

export function planRollout(
  peers: PeerNode[],
  localNodeId: string,
  strategy: InfraRolloutStrategy,
): PeerNode[][] {
  const ordered = peers.filter((peer) => peer.id !== localNodeId);
  const local = peers.filter((peer) => peer.id === localNodeId);
  if (strategy === "all") {
    return [ordered, local].filter((group) => group.length > 0);
  }
  return [...ordered.map((peer) => [peer]), ...local.map((peer) => [peer])];
}

export async function healthGate(
  fetchSnapshot: () => Promise<FleetSnapshotEntry | null>,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<"healthy" | "timeout"> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await fetchSnapshot();
    if (
      snapshot !== null &&
      (snapshot.workloads.length === 0 ||
        snapshot.workloads.every((workload) => workload.reachable))
    ) {
      return "healthy";
    }
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
  return "timeout";
}

async function runGroup(
  group: PeerNode[],
  clientFactory: (peer: PeerNode) => InfraClientLike,
  opts: {
    pkg: string;
    version: string;
    previousVersion?: string;
    tarballUrl: string;
    sha256: string;
    skipIfPresent: boolean;
    healthTimeoutMs: number;
    pollIntervalMs: number;
  },
): Promise<RolloutPlan> {
  const installResults = await Promise.allSettled(
    group.map((peer) =>
      clientFactory(peer).install({
        pkg: opts.pkg,
        version: opts.version,
        tarballUrl: opts.tarballUrl,
        sha256: opts.sha256,
        activate: false,
        skipIfPresent: opts.skipIfPresent,
      }),
    ),
  );
  if (installResults.some((r) => r.status === "rejected")) {
    return { ok: false, reason: "install-failed" };
  }

  const activateOutcomes = await Promise.allSettled(
    group.map(async (peer) => {
      await clientFactory(peer).activate({ pkg: opts.pkg, version: opts.version });
      return peer;
    }),
  );
  const activateFailed = activateOutcomes.some((r) => r.status === "rejected");
  if (activateFailed) {
    // Roll back peers that successfully activated to the prior version so the
    // group doesn't remain split across two versions.
    const previousVersion = opts.previousVersion;
    if (previousVersion !== undefined) {
      const switched = activateOutcomes
        .filter((r): r is PromiseFulfilledResult<PeerNode> => r.status === "fulfilled")
        .map((r) => r.value);
      await Promise.allSettled(
        switched.map((peer) =>
          clientFactory(peer).activate({ pkg: opts.pkg, version: previousVersion }),
        ),
      );
    }
    return { ok: false, reason: "activate-failed" };
  }

  const healths = await Promise.all(
    group.map((peer) =>
      clientFactory(peer).pollHealth({
        timeoutMs: opts.healthTimeoutMs,
        pollIntervalMs: opts.pollIntervalMs,
      }),
    ),
  );
  if (healths.some((health) => health === "timeout")) {
    return { ok: false, reason: "health-timeout" };
  }
  return { ok: true };
}

export async function runRollout(
  groups: PeerNode[][],
  clientFactory: (peer: PeerNode) => InfraClientLike,
  opts: {
    pkg: string;
    version: string;
    previousVersion?: string;
    tarballUrl: string;
    sha256: string;
    skipIfPresent: boolean;
    healthTimeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<RolloutPlan> {
  const healthTimeoutMs = opts.healthTimeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  for (const group of groups) {
    const result = await runGroup(group, clientFactory, {
      ...opts,
      healthTimeoutMs,
      pollIntervalMs,
    });
    if (!result.ok) return result;
  }
  return { ok: true };
}

export async function runRollback(
  peers: PeerNode[],
  clientFactory: (peer: PeerNode) => InfraClientLike,
  opts: { pkg: string; previousVersion: string },
): Promise<RolloutPlan> {
  const results = await Promise.allSettled(
    peers.map((peer) =>
      clientFactory(peer).activate({
        pkg: opts.pkg,
        version: opts.previousVersion,
      }),
    ),
  );
  if (results.some((r) => r.status === "rejected")) {
    return { ok: false, reason: "rollback-failed" };
  }
  return { ok: true };
}
