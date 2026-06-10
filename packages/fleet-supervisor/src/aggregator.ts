import type { FleetSnapshotEntry } from "./types.js";
import { listPeers, type PeerNode } from "../../remote/src/config/peers.js";

export type AggregatorPeer = PeerNode;

export interface AggregatedSnapshot {
  nodeId: string;
  fetchedAt: number | null;
  snapshot: FleetSnapshotEntry | null;
  stale: boolean;
  error?: string;
}

export interface FleetAggregatorOptions {
  peers?: AggregatorPeer[];
  fetchSnapshot: (peer: AggregatorPeer) => Promise<FleetSnapshotEntry | null>;
  now?: () => number;
  pollIntervalMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 90_000;

export class FleetAggregator {
  private readonly peers: AggregatorPeer[];
  private readonly fetchSnapshot: (peer: AggregatorPeer) => Promise<FleetSnapshotEntry | null>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly cache = new Map<string, AggregatedSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: FleetAggregatorOptions) {
    this.peers = opts.peers ?? listPeers();
    this.fetchSnapshot = opts.fetchSnapshot;
    this.now = opts.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    for (const peer of this.peers) {
      this.cache.set(peer.id, {
        nodeId: peer.id,
        fetchedAt: null,
        snapshot: null,
        stale: true,
      });
    }
  }

  async pollNow(): Promise<void> {
    const now = this.now();
    await Promise.all(
      this.peers.map(async (peer) => {
        const prior = this.cache.get(peer.id) ?? {
          nodeId: peer.id,
          fetchedAt: null,
          snapshot: null,
          stale: true,
        };
        if (prior.fetchedAt !== null && now - prior.fetchedAt < this.pollIntervalMs) return;
        try {
          const snapshot = await this.fetchSnapshot(peer);
          if (snapshot === null) {
            this.cache.set(peer.id, {
              ...prior,
              stale: true,
              error: "empty snapshot",
            });
            return;
          }
          this.cache.set(peer.id, {
            nodeId: peer.id,
            fetchedAt: now,
            snapshot,
            stale: false,
          });
        } catch (err) {
          this.cache.set(peer.id, {
            ...prior,
            stale: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  getSnapshot(nodeId: string): AggregatedSnapshot | null {
    const row = this.cache.get(nodeId);
    if (!row) return null;
    if (row.snapshot === null) return null;
    if (row.stale) return null;
    if (row.fetchedAt === null) return null;
    if (this.now() - row.fetchedAt > this.staleAfterMs) return null;
    return row;
  }

  getAll(): AggregatedSnapshot[] {
    return [...this.cache.values()].map((row) => {
      if (row.fetchedAt === null) return row;
      if (row.stale) return row;
      if (this.now() - row.fetchedAt > this.staleAfterMs) {
        return { ...row, stale: true, error: row.error ?? "stale" };
      }
      return row;
    });
  }

  start(): { stop: () => void } {
    if (this.timer !== null) {
      return {
        stop: () => {
          if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
          }
        },
      };
    }
    void this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.pollIntervalMs);
    return {
      stop: () => {
        if (this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
        }
      },
    };
  }
}
