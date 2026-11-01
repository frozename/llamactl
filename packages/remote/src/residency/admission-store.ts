/**
 * Target-owned managed-admission authority store (plan v3, "Store" package).
 * Type contract only — the bun:sqlite implementation lands with the GREEN
 * package; tests live in test/residency/admission-store.test.ts.
 *
 * One durable SQLite ledger per canonical runtime root. `claim` runs the
 * read → evaluateManagedAdmission → insert-pending → commit pipeline inside
 * a single synchronous BEGIN IMMEDIATE transaction; no await, probe or spawn
 * occurs inside it. Pending, resident and uncertain rows all charge against
 * the caller-supplied budget.
 *
 * Ownership: every open takes a fresh owner epoch (a persisted counter that
 * only ever increases) and converts every pre-existing pending row to
 * uncertain — a previous owner's in-flight promises cannot survive a reopen.
 * The persisted authorityId never changes for a file.
 *
 * Fencing: each row carries an opaque fenceToken bound to
 * (claimId, ownerEpoch, generationVersion). Every successful CAS mutation
 * rotates it, so a stale or foreign token is rejected without mutation.
 */
import type {
  ManagedAdmissionRefuseReason,
  ManagedWorkloadKind,
} from "@llamactl/core/residency/managed-admission";

export type ClaimState = "pending" | "resident" | "uncertain";

export interface ClaimRow {
  claimId: string;
  runtimeKey: string;
  specDigest: string;
  kind?: ManagedWorkloadKind;
  state: ClaimState;
  allocationGiB: number;
  ownerEpoch: number;
  generationVersion: number;
  fenceToken: string;
}

export type ClaimRefuseReason = ManagedAdmissionRefuseReason | "AuthorityUnavailable";

export type ClaimResult =
  | {
      kind: "admitted";
      claimId: string;
      fenceToken: string;
      chargedGiB: number;
      /** Committed total after charging this claim. */
      committedGiB: number;
    }
  | { kind: "join-pending"; claimId: string }
  | { kind: "already-resident"; claimId: string }
  | { kind: "refuse"; reason: ClaimRefuseReason; detail: string };

export class AuthorityUnavailableError extends Error {
  readonly code = "AuthorityUnavailable" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthorityUnavailable";
  }
}

export interface ClaimInput {
  runtimeKey: string;
  specDigest: string;
  kind?: ManagedWorkloadKind;
  allocationGiB: number;
  budgetGiB: number;
}

export interface ReleaseEvidence {
  /** Whole-runtime absence proof produced by the target-owned observer. */
  verification: "runtime-absent";
  observedAt?: number;
}

export interface AdmissionStore {
  /** Persisted id of this ledger. Stable across reopen of the same file. */
  authorityId(): string;
  /** Owner epoch taken at open. Changes on every reopen. */
  epoch(): number;
  /**
   * Atomic check-and-insert of a pending claim. Never throws for a refusal:
   * busy/lock contention, a closed store and invalid input all return
   * {kind:"refuse"} — refused before effects. Pending rows owned by other
   * epochs are NOT converted here — the open-time sweep is the only orphan
   * conversion point, so a second live connection can still join them.
   */
  claim(input: ClaimInput): ClaimResult;
  /** CAS pending→resident. Rotates the row's fenceToken on success. */
  commitResident(claimId: string, fenceToken: string): boolean;
  /** CAS pending→uncertain. Rotates the row's fenceToken on success. */
  markUncertain(claimId: string, fenceToken: string): boolean;
  /** CAS delete — the only path that frees a charge. */
  releaseVerified(claimId: string, fenceToken: string, evidence: ReleaseEvidence): boolean;
  /** Detached copies; mutating them never changes stored state. */
  snapshot(): readonly ClaimRow[];
  /** Idempotent. Calls after close refuse/return false rather than write. */
  close(): void;
}

export function openAdmissionStore(opts: { path: string; busyTimeoutMs?: number }): AdmissionStore {
  throw new Error("not implemented");
}
