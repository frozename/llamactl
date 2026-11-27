/**
 * Target-owned admission authority (plan v3 — "Authority lifecycle" work
 * package). Tests live in test/residency/admission-authority.test.ts.
 *
 * The authority wraps one openAdmissionStore ledger with the pieces the
 * store deliberately does not hold: the caller's budget probe, the
 * process observer, the runtime-dir pid-record reader and the per-claim
 * generation evidence captured between admit and ready. All observation
 * is injected — tests drive it with fakes, production wires real probes.
 * Nothing here spawns, signals or reaps a process.
 *
 * ProcessObservation, GenerationRecord, and GenerationVerdict are
 * re-exported from packages/core/src/residency/generation-evidence.ts.
 * judgeGeneration is called directly from that module.
 */
import type { ManagedWorkloadKind } from "@llamactl/core/residency/admission";

import {
  type GenerationRecord,
  type GenerationVerdict,
  judgeGeneration,
  type ProcessObservation,
} from "@llamactl/core/residency/generation-evidence";

import {
  type AdmissionStore,
  AuthorityUnavailableError,
  type ClaimRefuseReason,
  type ClaimRow,
  type InspectedOwnership,
  openAdmissionStore,
  type OwnerIdentity,
} from "./admission-store.js";

export type { GenerationRecord, GenerationVerdict, ProcessObservation };

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

export type ManagedStopProof = (stoppedPid: number) => ReleaseAttemptResult;

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
  /** Reserved for a trusted launch adapter that proves its engine callback never ran. */
  abandonUnstarted(claimId: string, fenceToken: string): boolean;
  /**
   * Release a settled claim on verified whole-runtime absence. Every
   * recorded generation must judge verified-absent under a fresh
   * observation, the runtime-dir pid record must be present and name a
   * recorded generation — only then does the claim's charge free.
   * Anything less retains the row; "retained" covers a live generation,
   * an unidentifiable death, a missing or conflicting pid record, and a
   * claim with no captured generation.
   */
  tryRelease(claimId: string): ReleaseAttemptResult;
  /** Capture the runtime record before a verified stop removes it. */
  prepareStopRelease(runtimeKey: string, kind: ManagedWorkloadKind): ManagedStopProof | undefined;
  /**
   * Detached rows including captured generations. A ledger degraded
   * after open — where the store's snapshot throws
   * AuthorityUnavailableError — surfaces as the documented empty
   * snapshot; the authority stays degraded, never legacy.
   */
  snapshot(): readonly AuthorityClaimRow[];
  isOperational(): boolean;
  /** Idempotent; post-close admits refuse AuthorityUnavailable. */
  close(): void;
}

type ObserveGeneration = (
  pid: number,
  recorded: GenerationRecord,
) => ProcessObservation | undefined;

function ownerIdentityMatches(a: OwnerIdentity, b: OwnerIdentity): boolean {
  if (a.birthId !== undefined || b.birthId !== undefined) {
    return a.pid === b.pid && a.birthId === b.birthId;
  }
  const shared = (field: "startTimeMs" | "executable"): boolean =>
    a[field] === undefined || b[field] === undefined || a[field] === b[field];
  return a.pid === b.pid && shared("startTimeMs") && shared("executable");
}

/**
 * Read the ledger rows with the documented degraded fallback: the store
 * fails closed with AuthorityUnavailableError on a read failure or a
 * corrupt stored value; the authority translates that into the empty
 * snapshot rather than crashing.
 */
function ledgerRows(store: AdmissionStore): readonly ClaimRow[] {
  try {
    return store.snapshot();
  } catch (e) {
    if (e instanceof AuthorityUnavailableError) {
      return [];
    }
    throw e;
  }
}

function stakeOrRecover(
  store: AdmissionStore,
  owner: OwnerIdentity,
  previousOwnerGone: boolean,
  inspected: InspectedOwnership,
): string | undefined {
  const result = store.recoverOwnership(owner, previousOwnerGone, inspected);
  return result.kind === "refused"
    ? `admission authority is degraded: ownership recovery refused (${result.reason})`
    : undefined;
}

/**
 * Open-time ownership check: stake a vacant ledger, continue through an
 * identity match, recover a verified-absent owner's ledger, or name the
 * degradation for a live or unidentifiable one. Returns the refusal
 * detail when the authority must degrade; undefined when it owns the
 * ledger.
 */
function resolveOpenOwnership(
  store: AdmissionStore,
  owner: OwnerIdentity,
  observe: ObserveGeneration,
): string | undefined {
  const inspected = store.inspectOwnership();
  if (inspected === null) {
    return "admission authority is degraded: ownership could not be read";
  }
  const rec = inspected.owner;
  if (rec === undefined) {
    return stakeOrRecover(store, owner, false, inspected);
  }
  if (ownerIdentityMatches(rec, owner)) {
    return undefined;
  }
  const observation = observe(rec.pid, rec);
  const verdict = judgeGeneration({ recorded: rec, observation });
  const knownReused =
    verdict.kind === "different-generation" &&
    rec.birthId !== undefined &&
    observation?.birthId !== undefined &&
    rec.birthId !== observation.birthId;
  if (verdict.kind === "verified-absent" || knownReused) {
    return stakeOrRecover(store, owner, true, inspected);
  }
  return verdict.kind === "uncertain"
    ? `admission authority is degraded: the recorded owner pid ${String(rec.pid)} cannot be identified`
    : `admission authority is degraded: the recorded owner pid ${String(rec.pid)} is still live`;
}

function releaseClaim(
  row: ClaimRow,
  captured: readonly GenerationRecord[],
  store: AdmissionStore,
  pidFilePid: number | undefined,
  observe: ObserveGeneration,
): ReleaseAttemptResult {
  const { claimId } = row;
  if (captured.length === 0) {
    return { kind: "retained", claimId, reason: "no-generation" };
  }
  if (pidFilePid === undefined) {
    return { kind: "retained", claimId, reason: "pid-record-missing" };
  }
  if (!captured.some((gen) => gen.pid === pidFilePid)) {
    return { kind: "retained", claimId, reason: "pid-record-conflict" };
  }
  for (const gen of captured) {
    const verdict = judgeGeneration({
      recorded: gen,
      observation: observe(gen.pid, gen),
    });
    if (verdict.kind === "same-generation" || verdict.kind === "different-generation") {
      return { kind: "retained", claimId, reason: "live-generation" };
    }
    if (verdict.kind !== "verified-absent") {
      return { kind: "retained", claimId, reason: "unidentified-death" };
    }
  }
  const released = store.releaseVerified(claimId, row.fenceToken, {
    verification: "runtime-absent",
    generationVersion: row.generationVersion,
    observedAt: Date.now(),
  });
  if (!released) {
    return { kind: "retained", claimId, reason: "release-cas-failed" };
  }
  return { kind: "released", claimId };
}

function captureStopRelease(
  store: AdmissionStore,
  row: ClaimRow,
  readPidFile: (runtimeKey: string) => number | undefined,
  observe: ObserveGeneration,
): ManagedStopProof | undefined {
  if (row.state === "pending") return undefined;
  const before = readPidFile(row.runtimeKey);
  if (before === undefined) return undefined;
  const captured = store.generationsOf(row.claimId);
  return (stoppedPid) => {
    const after = readPidFile(row.runtimeKey);
    if (stoppedPid !== before || (after !== undefined && after !== before)) {
      return { kind: "retained", claimId: row.claimId, reason: "pid-record-conflict" };
    }
    return releaseClaim(row, captured, store, before, observe);
  };
}

function isReadableStore(store: AdmissionStore | null): boolean {
  if (store === null) return false;
  try {
    store.snapshot();
    return true;
  } catch (error) {
    if (error instanceof AuthorityUnavailableError) return false;
    throw error;
  }
}

/**
 * Open (or degrade) the authority over `storePath`. An unreadable store
 * still returns an authority — degraded — so callers always speak to the
 * managed surface: every admit refuses AuthorityUnavailable, mutations
 * fail closed, snapshot is empty. A ledger that degrades after open
 * (#383) keeps that contract: the store's typed snapshot failure reads
 * as the empty snapshot and admits keep refusing AuthorityUnavailable.
 *
 * `owner` is this process's identity, staked on the ledger at open: on a
 * vacant store it is recorded outright; with a recorded previous owner the
 * open observes it through opts.observe and judges it by the same strict
 * identity rule generations use. Verified absent recovers the store
 * (epoch rotates, orphan pendings sweep to uncertain); the same process
 * continues as owner with no rotation; a live or unidentifiable other
 * owner degrades the authority rather than stealing ownership.
 */
export function openAdmissionAuthority(opts: {
  storePath: string;
  budgetGiB: () => number | undefined;
  observe: ObserveGeneration;
  readPidFile: (runtimeKey: string) => number | undefined;
  owner: OwnerIdentity;
}): AdmissionAuthority {
  let store: AdmissionStore | null = null;
  try {
    store = openAdmissionStore({ path: opts.storePath });
  } catch (e) {
    if (!(e instanceof AuthorityUnavailableError)) {
      throw e;
    }
  }

  const degradedDetail =
    store === null ? undefined : resolveOpenOwnership(store, opts.owner, opts.observe);

  const ledger = (): AdmissionStore | null => (degradedDetail === undefined ? store : null);

  return {
    admit(request: AdmitRequest): AdmissionOutcome {
      const active = ledger();
      if (active === null) {
        return {
          kind: "refuse",
          reason: "AuthorityUnavailable",
          detail: degradedDetail ?? "admission authority is degraded or closed",
        };
      }
      // The budget probe is read on every admit; an unknown budget is
      // handed to the store's policy as NaN — which the policy refuses
      // BudgetUnknown — never substituted with an unlimited figure.
      const result = active.claim({
        runtimeKey: request.runtimeKey,
        specDigest: request.specDigest,
        allocationGiB: request.allocationGiB,
        budgetGiB: opts.budgetGiB() ?? Number.NaN,
        ...(request.kind === undefined ? {} : { kind: request.kind }),
      });
      switch (result.kind) {
        case "admitted":
        case "refuse":
          return result;
        case "join-pending":
          return { kind: "joined", claimId: result.claimId };
        case "already-resident":
          return { kind: "resident", claimId: result.claimId };
      }
    },

    recordGeneration(claimId: string, fenceToken: string, generation: GenerationRecord): boolean {
      const active = ledger();
      if (active === null) {
        return false;
      }
      return active.recordGeneration(claimId, fenceToken, generation);
    },

    completeReady(claimId: string, fenceToken: string): boolean {
      return ledger()?.commitResident(claimId, fenceToken) ?? false;
    },

    failUncertain(claimId: string, fenceToken: string, _reason: string): boolean {
      return ledger()?.markUncertain(claimId, fenceToken) ?? false;
    },

    abandonUnstarted(claimId: string, fenceToken: string): boolean {
      return ledger()?.abandonUnstarted(claimId, fenceToken) ?? false;
    },

    tryRelease(claimId: string): ReleaseAttemptResult {
      const active = ledger();
      if (active === null) return { kind: "unknown-claim", claimId };
      const row = ledgerRows(active).find((claim) => claim.claimId === claimId);
      if (row === undefined) {
        return { kind: "unknown-claim", claimId };
      }
      if (row.state === "pending") {
        return { kind: "retained", claimId, reason: "launch-pending" };
      }
      return releaseClaim(
        row,
        active.generationsOf(claimId),
        active,
        opts.readPidFile(row.runtimeKey),
        opts.observe,
      );
    },

    prepareStopRelease(
      runtimeKey: string,
      kind: ManagedWorkloadKind,
    ): ManagedStopProof | undefined {
      const active = ledger();
      if (active === null) return undefined;
      const row = ledgerRows(active).find(
        (claim) => claim.runtimeKey === runtimeKey && claim.kind === kind,
      );
      return row === undefined
        ? undefined
        : captureStopRelease(active, row, opts.readPidFile, opts.observe);
    },

    snapshot(): readonly AuthorityClaimRow[] {
      const active = ledger();
      if (active === null) {
        return [];
      }
      return ledgerRows(active).map(
        (row): AuthorityClaimRow => ({
          ...row,
          generations: active.generationsOf(row.claimId),
        }),
      );
    },

    isOperational: () => isReadableStore(ledger()),

    close(): void {
      store?.close();
      store = null;
    },
  };
}
