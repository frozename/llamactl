// frozename/llamactl#249: shared fleet-snapshot plumbing for `workload status
// --metrics` and `workload top`. Reads only journaled data (local journal +
// peer snapshots) — it never wakes a model or issues inference. Kept free of
// workload-status.ts / workload-top.ts imports so both commands can depend on
// it without an import cycle.

import type { EngineThroughputSnapshot, FleetSnapshotEntry } from "@llamactl/fleet-supervisor";

import { listPeers, type PeerNode } from "@llamactl/core/config/peers";
import {
  createPeerFetch,
  defaultFleetJournalPath,
  readLatestFleetSnapshotFromJournal,
} from "@llamactl/fleet-supervisor";

export const NO_SNAPSHOT_REASON = "no fleet snapshot found (is the fleet supervisor running?)";

export interface WorkloadDeps {
  readLocalSnapshot?: () => Promise<FleetSnapshotEntry | null>;
  readPeers?: () => PeerNode[];
  fetchPeerSnapshot?: (peer: PeerNode) => Promise<FleetSnapshotEntry | null>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  signal?: AbortSignal;
  isTTY?: boolean;
}

export type WorkloadStatusDeps = WorkloadDeps;

export interface ResolvedWorkloadStatusDeps {
  readLocalSnapshot: () => Promise<FleetSnapshotEntry | null>;
  readPeers: () => PeerNode[];
  fetchPeerSnapshot: (peer: PeerNode) => Promise<FleetSnapshotEntry | null>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
  isTTY: boolean;
  signal?: AbortSignal;
}

export interface ThroughputMatch {
  node: string;
  snapshotTs: string;
  entry: EngineThroughputSnapshot;
}

function stdoutIsTTY(): boolean {
  // isTTY is typed boolean but is undefined when stdout is piped.
  const stream: { isTTY?: boolean } = process.stdout;
  return stream.isTTY === true;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timers: { pending?: ReturnType<typeof setTimeout> } = {};
    const onAbort = (): void => {
      clearTimeout(timers.pending);
      resolve();
    };
    timers.pending = setTimeout((): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveWorkloadStatusDeps(deps: WorkloadDeps): ResolvedWorkloadStatusDeps {
  const readLocalSnapshot =
    deps.readLocalSnapshot ??
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    (async (): Promise<FleetSnapshotEntry | null> =>
      readLatestFleetSnapshotFromJournal(defaultFleetJournalPath()));
  const readPeers = deps.readPeers ?? listPeers;
  const fetchPeerSnapshot =
    deps.fetchPeerSnapshot ??
    (async (peer: PeerNode): Promise<FleetSnapshotEntry | null> => {
      const fetcher = createPeerFetch(peer);
      return await fetcher();
    });
  return {
    readLocalSnapshot,
    readPeers,
    fetchPeerSnapshot,
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now ?? ((): Date => new Date()),
    isTTY: deps.isTTY ?? stdoutIsTTY(),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  };
}

export async function gatherSnapshots(
  deps: ResolvedWorkloadStatusDeps,
): Promise<FleetSnapshotEntry[]> {
  const snapshots: FleetSnapshotEntry[] = [];
  const local = await deps.readLocalSnapshot();
  if (local !== null) snapshots.push(local);
  const peerSnapshots = await Promise.all(
    deps.readPeers().map(async (peer): Promise<FleetSnapshotEntry | null> => {
      try {
        return await deps.fetchPeerSnapshot(peer);
      } catch {
        return null;
      }
    }),
  );
  for (const snapshot of peerSnapshots) {
    if (snapshot !== null) snapshots.push(snapshot);
  }
  return snapshots;
}

export function latestSnapshotByNode(
  snapshots: readonly FleetSnapshotEntry[],
): Map<string, FleetSnapshotEntry> {
  const latestByNode = new Map<string, FleetSnapshotEntry>();
  for (const snapshot of snapshots) {
    const seen = latestByNode.get(snapshot.node);
    if (seen === undefined || snapshot.ts > seen.ts) {
      latestByNode.set(snapshot.node, snapshot);
    }
  }
  return latestByNode;
}

export function findThroughputMatch(
  snapshots: readonly FleetSnapshotEntry[],
  name: string,
): ThroughputMatch | null {
  let match: ThroughputMatch | null = null;
  for (const snapshot of latestSnapshotByNode(snapshots).values()) {
    for (const entry of snapshot.engineThroughput ?? []) {
      if (entry.workload !== name) continue;
      if (match === null || entry.sampledAt > match.entry.sampledAt) {
        match = { node: snapshot.node, snapshotTs: snapshot.ts, entry };
      }
    }
  }
  return match;
}
