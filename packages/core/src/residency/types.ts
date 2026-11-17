/**
 * Shared types for residency lease management (Refs #278, DF-05).
 */

export type Lease = {
  id: string;
  workload: string;
  epoch: number;
  signal: AbortSignal;
  release: () => boolean;
};

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; reason: "Draining" | "Unloaded"; workload: string; epoch: number };

export type DrainToken = {
  workload: string;
  epoch: number;
};

export type BeginDrainResult =
  | { ok: true; token: DrainToken; active: string[] }
  | { ok: false; reason: "AlreadyDraining" | "Unloaded"; workload: string; epoch: number };

export type WhenIdleResult =
  | { idle: true }
  | { idle: false; reason: "Aborted" | "DrainCancelled" | "StaleDrainToken"; active: string[] };

export type CommitUnloadResult =
  | { ok: true; revoked: string[] }
  | { ok: false; reason: "LeasesActive"; active: string[] }
  | { ok: false; reason: "StaleDrainToken" };

export type ResidencySnapshot = {
  workload: string;
  phase: "open" | "draining" | "unloaded";
  epoch: number;
  active: string[];
  waiters: number;
};

export type ResidencyAuditEntry = {
  workload: string;
  epoch: number;
  forced: true;
  revoked: string[];
  reason?: string;
  // Id of the registry (one per serving process) that wrote the entry. Epochs
  // and lease ids restart per process, so this is what tells a persisted row
  // from an earlier process apart from a live entry with the same fields.
  // Every live entry carries it; only legacy persisted rows lack it.
  incarnation?: string;
};

export interface ResidencyLeases {
  acquire: (workload: string) => AcquireResult;
  active: (workload: string) => string[];
  beginDrain: (workload: string) => BeginDrainResult;
  whenIdle: (token: DrainToken, opts?: { signal?: AbortSignal }) => Promise<WhenIdleResult>;
  commitUnload: (
    token: DrainToken,
    opts?: { force?: boolean; reason?: string },
  ) => CommitUnloadResult;
  cancelDrain: (token: DrainToken) => boolean;
  reopen: (token: DrainToken) => boolean;
  snapshot: (workload: string) => ResidencySnapshot;
  waiterCount: (workload: string) => number;
  audit: () => ResidencyAuditEntry[];
  // Optional read-out (Part of #519): the last time this workload saw lease
  // activity (a successful acquire, or a release that removed a lease), or the
  // registry's creation time when never touched. Advisory only: nothing here
  // acts on it, and existing fakes need not implement it.
  lastActivityAtMs?: (workload: string) => number;
}
