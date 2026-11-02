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
 * GenerationRecord / ProcessObservation / GenerationVerdict /
 * JudgeGeneration are local mirrors of the pure judge in
 * packages/core/src/residency/generation-evidence.ts, which lands on
 * branch feat/target-authority-core-policy and is not on this base.
 * Replace these declarations with the core import when that branch
 * merges.
 */
import type { ManagedWorkloadKind } from "@llamactl/core/residency/managed-admission";

import {
  type AdmissionStore,
  AuthorityUnavailableError,
  type ClaimRefuseReason,
  type ClaimRow,
  openAdmissionStore,
  type OwnerIdentity,
} from "./admission-store.js";

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

function identityMatches(
  recorded: GenerationRecord,
  observation: ProcessObservation,
  field: "startTimeMs" | "executable",
): boolean {
  return (
    observation[field] === undefined ||
    recorded[field] === undefined ||
    observation[field] === recorded[field]
  );
}

function judgeGeneration(
  recorded: GenerationRecord,
  observation: ProcessObservation | undefined,
): GenerationVerdict {
  if (observation === undefined) {
    return { kind: "uncertain", reason: "process cannot be identified" };
  }
  const startTimeMatches = identityMatches(recorded, observation, "startTimeMs");
  const executableMatches = identityMatches(recorded, observation, "executable");
  if (observation.alive) {
    return startTimeMatches && executableMatches
      ? { kind: "same-generation" }
      : {
          kind: "different-generation",
          reason: "a live process does not match the recorded identity",
        };
  }
  const carriesIdentity =
    observation.startTimeMs !== undefined || observation.executable !== undefined;
  if (carriesIdentity && startTimeMatches && executableMatches) {
    return { kind: "verified-absent" };
  }
  return {
    kind: "uncertain",
    reason: "the death cannot be attributed to the recorded generation",
  };
}

/**
 * Open (or degrade) the authority over `storePath`. An unreadable store
 * still returns an authority — degraded — so callers always speak to the
 * managed surface: every admit refuses AuthorityUnavailable, mutations
 * fail closed, snapshot is empty.
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
  runtimeRoot: string;
  budgetGiB: () => number | undefined;
  observe: (pid: number) => ProcessObservation | undefined;
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
  // Generations are kept in memory only in this slice: losing them makes
  // tryRelease retain the charge, which is the fail-safe direction.
  const generations = new Map<string, GenerationRecord[]>();

  const findRow = (claimId: string): ClaimRow | undefined =>
    store?.snapshot().find((r) => r.claimId === claimId);

  const releaseClaim = (claimId: string, row: ClaimRow): ReleaseAttemptResult => {
    const captured = generations.get(claimId) ?? [];
    if (captured.length === 0) {
      return { kind: "retained", claimId, reason: "no-generation" };
    }
    const pidFilePid = opts.readPidFile(row.runtimeKey);
    if (pidFilePid === undefined) {
      return { kind: "retained", claimId, reason: "pid-record-missing" };
    }
    if (!captured.some((gen) => gen.pid === pidFilePid)) {
      return { kind: "retained", claimId, reason: "pid-record-conflict" };
    }
    for (const gen of captured) {
      const verdict = judgeGeneration(gen, opts.observe(gen.pid));
      if (verdict.kind === "same-generation" || verdict.kind === "different-generation") {
        return { kind: "retained", claimId, reason: "live-generation" };
      }
      if (verdict.kind !== "verified-absent") {
        return { kind: "retained", claimId, reason: "unidentified-death" };
      }
    }
    const released = store?.releaseVerified(claimId, row.fenceToken, {
      verification: "runtime-absent",
      observedAt: Date.now(),
    });
    if (released !== true) {
      return { kind: "retained", claimId, reason: "release-cas-failed" };
    }
    generations.delete(claimId);
    return { kind: "released", claimId };
  };

  return {
    admit(request: AdmitRequest): AdmissionOutcome {
      if (store === null) {
        return {
          kind: "refuse",
          reason: "AuthorityUnavailable",
          detail: "admission authority is degraded or closed",
        };
      }
      // The budget probe is read on every admit; an unknown budget is
      // handed to the store's policy as NaN — which the policy refuses
      // BudgetUnknown — never substituted with an unlimited figure.
      const result = store.claim({
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
      const row = findRow(claimId);
      if (row?.state !== "pending" || row.fenceToken !== fenceToken) {
        return false;
      }
      const copy: GenerationRecord = { ...generation };
      const captured = generations.get(claimId);
      if (captured === undefined) {
        generations.set(claimId, [copy]);
      } else {
        captured.push(copy);
      }
      return true;
    },

    completeReady(claimId: string, fenceToken: string): boolean {
      return store?.commitResident(claimId, fenceToken) ?? false;
    },

    failUncertain(claimId: string, fenceToken: string, _reason: string): boolean {
      return store?.markUncertain(claimId, fenceToken) ?? false;
    },

    tryRelease(claimId: string): ReleaseAttemptResult {
      const row = findRow(claimId);
      if (row === undefined) {
        return { kind: "unknown-claim", claimId };
      }
      return releaseClaim(claimId, row);
    },

    snapshot(): readonly AuthorityClaimRow[] {
      if (store === null) {
        return [];
      }
      return store.snapshot().map(
        (row): AuthorityClaimRow => ({
          ...row,
          generations: (generations.get(row.claimId) ?? []).map((gen) => ({ ...gen })),
        }),
      );
    },

    close(): void {
      store?.close();
    },
  };
}
