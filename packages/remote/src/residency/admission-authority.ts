/**
 * Target-owned admission authority (plan v3 — "Authority lifecycle" work
 * package). TYPE-ONLY contract stub: the RED tests in
 * test/residency/admission-authority.test.ts define the lifecycle; every
 * body here throws until the implementation seat lands.
 *
 * The authority wraps one openAdmissionStore ledger with the pieces the
 * store deliberately does not hold: the caller's budget probe, the
 * process observer, the runtime-dir pid-record reader and the per-claim
 * generation evidence captured between admit and ready. All observation
 * is injected — tests drive it with fakes, production wires real probes.
 * Nothing here spawns, signals or reaps a process.
 *
 * GenerationRecord / ProcessObservation / GenerationVerdict /
 * JudgeGeneration are local mirrors of the pure judge in
 * packages/core/src/residency/generation-evidence.ts, which lands on
 * branch feat/target-authority-core-policy and is not on this base.
 * Replace these declarations with the core import when that branch
 * merges.
 */
import type { ManagedWorkloadKind } from "@llamactl/core/residency/managed-admission";

import type { ClaimRefuseReason, ClaimRow } from "./admission-store.js";

/** What the injected process observer reports for one pid. */
export type ProcessObservation = {
  pid: number;
  alive: boolean;
  startTimeMs?: number | undefined;
  executable?: string | undefined;
};

/** One captured generation of a claim: a pid plus optional identity fields. */
export type GenerationRecord = {
  pid: number;
  startTimeMs?: number | undefined;
  executable?: string | undefined;
};

export type GenerationVerdict =
  | { kind: "same-generation" }
  | { kind: "verified-absent" }
  | { kind: "different-generation"; reason: string }
  | { kind: "uncertain"; reason: string };

/** Signature of core's pure judgeGeneration. */
export type JudgeGeneration = (input: {
  recorded: GenerationRecord | undefined;
  pidFilePid: number | undefined;
  observation: ProcessObservation | undefined;
}) => GenerationVerdict;

export interface AdmitRequest {
  runtimeKey: string;
  specDigest: string;
  kind?: ManagedWorkloadKind | undefined;
  allocationGiB: number;
}

/**
 * Outcome of one admit. Mirrors the store's ClaimResult with the wire
 * vocabulary: join-pending surfaces as "joined" (the caller waits on the
 * owning loader's result and receives no fence token) and
 * already-resident as "resident". Refusals carry the policy reason
 * verbatim — AuthorityUnavailable for a closed or degraded ledger.
 */
export type AdmissionOutcome =
  | {
      kind: "admitted";
      claimId: string;
      fenceToken: string;
      chargedGiB: number;
      committedGiB: number;
    }
  | { kind: "joined"; claimId: string }
  | { kind: "resident"; claimId: string }
  | { kind: "refuse"; reason: ClaimRefuseReason; detail: string };

export type ReleaseAttemptResult =
  | { kind: "released"; claimId: string }
  | { kind: "retained"; claimId: string; reason: string }
  | { kind: "unknown-claim"; claimId: string };

export interface AuthorityClaimRow extends ClaimRow {
  /** Captured generations, oldest first. Detached like every snapshot row. */
  readonly generations: readonly GenerationRecord[];
}

export interface AdmissionAuthority {
  /**
   * Claim via the store under the current opts.budgetGiB() value. An
   * unknown budget refuses BudgetUnknown — never falls back to
   * unlimited. An unopened, closed or degraded store refuses
   * AuthorityUnavailable — never falls back to an unmanaged path.
   */
  admit(request: AdmitRequest): AdmissionOutcome;
  /**
   * Capture one generation (launch event, spawn seam or verified adopted
   * pid) for a claim. The fence token is validated but not consumed — it
   * still drives the subsequent completeReady/failUncertain. Returns
   * false on an unknown claim, a stale token or a degraded store.
   */
  recordGeneration(claimId: string, fenceToken: string, generation: GenerationRecord): boolean;
  /** CAS pending→resident through the store; stale tokens change nothing. */
  completeReady(claimId: string, fenceToken: string): boolean;
  /**
   * CAS pending→uncertain on timeout, disconnect or an unprovable
   * outcome. Uncertain is absorbing and stays charged; reason is journal
   * metadata only.
   */
  failUncertain(claimId: string, fenceToken: string, reason: string): boolean;
  /**
   * The only release path: verified whole-runtime absence. Every
   * recorded generation must judge verified-absent under a fresh
   * observation, the runtime-dir pid record must be present and name a
   * recorded generation — only then does the claim's charge free.
   * Anything less retains the row; "retained" covers a live generation,
   * an unidentifiable death, a missing or conflicting pid record, and a
   * claim with no captured generation.
   */
  tryRelease(claimId: string): ReleaseAttemptResult;
  /** Detached rows including captured generations. */
  snapshot(): readonly AuthorityClaimRow[];
  /** Idempotent; post-close admits refuse AuthorityUnavailable. */
  close(): void;
}

/**
 * Open (or degrade) the authority over `storePath`. An unreadable store
 * still returns an authority — degraded — so callers always speak to the
 * managed surface: every admit refuses AuthorityUnavailable, mutations
 * fail closed, snapshot is empty.
 */
export function openAdmissionAuthority(_opts: {
  storePath: string;
  runtimeRoot: string;
  budgetGiB: () => number | undefined;
  observe: (pid: number) => ProcessObservation | undefined;
  readPidFile: (runtimeKey: string) => number | undefined;
}): AdmissionAuthority {
  throw new Error("not implemented");
}
