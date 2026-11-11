/**
 * #282 DF-09 — target-admission-gated oMLX native load/unload.
 *
 * ensureLoaded is the ONLY path for any oMLX native load, operator
 * requested or request triggered: it claims budget through the shared
 * TargetAdmissionAuthority before any HTTP call, so a native load can
 * never overspend the target. Wiring it into the request path is a
 * later #282 slice; request-path callers must call it before forwarding
 * to oMLX once wired.
 *
 * Residency is tracked per instance: an uncertain outcome (ambiguous
 * load/unload, or a backend that loads on its own) demotes or marks the
 * claim uncertain and blocks further attempts until a verified unload
 * retires the claim. No timers; recovery is driven by explicit calls.
 */
import type {
  ManagedAdmissionClaim,
  ManagedAdmissionRefuseReason,
} from "@llamactl/core/residency/admission";

import type {
  TargetAdmissionAuthority,
  TargetAdmissionClaimHandle,
} from "../workload/admission.js";
import type { NativeLoadResult, NativeUnloadResult, OmlxNativeClient } from "./engine-client.js";

export type ManagedOmlxResidencyState = "unclaimed" | "pending" | "resident" | "uncertain";

export type ManagedEnsureLoadedResult =
  | NativeLoadResult
  | { kind: "refused"; reason: "ResidencyUncertain" }
  | { kind: "refused"; reason: "AdmissionRefused"; admission: ManagedAdmissionRefuseReason }
  | { kind: "refused"; reason: "ClaimHeldElsewhere"; claimId: string };

export type ManagedOmlxResidencyOptions = {
  client: OmlxNativeClient;
  authority: TargetAdmissionAuthority;
  targetIdentity: string;
  /** The ModelHost name owning this native model slot. */
  runtimeKey: string;
  specDigest: string;
  allocationGiB: number | undefined;
  budgetGiB: () => number | undefined;
  living?: () => readonly ManagedAdmissionClaim[];
};

export type ManagedOmlxResidency = {
  ensureLoaded(): Promise<ManagedEnsureLoadedResult>;
  unload(): Promise<NativeUnloadResult>;
  residency(): ManagedOmlxResidencyState;
  claimId(): string | undefined;
};

// Ambiguous, LoadInProgress, or Conflict (409 'already being loaded') cannot
// be told apart from a load that actually happened: the claim must stay
// charged as uncertain.
function loadDemotesToUncertain(result: NativeLoadResult): boolean {
  // prettier-ignore
  return (
    result.kind === "ambiguous" || (result.kind === "refused" && result.reason === "LoadInProgress") || (result.kind === "failed" && result.reason === "Conflict")
  );
}

export function createManagedOmlxResidency(
  opts: ManagedOmlxResidencyOptions,
): ManagedOmlxResidency {
  let state: ManagedOmlxResidencyState = "unclaimed";
  let handle: TargetAdmissionClaimHandle | null = null;
  // One shared operation flight gates the whole layer: while a load or an
  // unload is in flight, a concurrent ensureLoaded joins the load promise
  // (M10) but a second unload, and any ensureLoaded against a pending
  // unload, are refused without touching the client, so an unload can never
  // release a claim admitted after it started.
  let flight: Promise<ManagedEnsureLoadedResult> | null = null;
  let unloadInFlight = false;

  const abandonClaim = (admitted: TargetAdmissionClaimHandle): void => {
    admitted.releaseUnstarted();
    handle = null;
    state = "unclaimed";
  };

  const admitAndLoad = async (): Promise<ManagedEnsureLoadedResult> => {
    const { decision, handle: admitted } = opts.authority.tryClaim({
      targetIdentity: opts.targetIdentity,
      runtimeKey: opts.runtimeKey,
      specDigest: opts.specDigest,
      kind: "ModelHost",
      allocationGiB: opts.allocationGiB,
      budgetGiB: opts.budgetGiB(),
      ...(opts.living !== undefined ? { living: opts.living() } : {}),
    });
    if (decision.kind === "refuse") {
      return { kind: "refused", reason: "AdmissionRefused", admission: decision.reason };
    }
    if (decision.kind === "join-pending") return { kind: "refused", reason: "LoadInProgress" };
    if (decision.kind === "already-resident") {
      return { kind: "refused", reason: "ClaimHeldElsewhere", claimId: decision.claimId };
    }
    if (admitted === null) throw new Error("admission admitted without a claim handle");
    handle = admitted;
    state = "pending";
    // An admitted claim must leave `pending` on every exit path: a throw
    // from the client means the load may already have reached the backend,
    // so the finally marks the claim uncertain instead of releasing it.
    try {
      const result = await opts.client.load();
      if (result.kind === "loaded" || result.kind === "already-loaded") {
        admitted.markResident();
        state = "resident";
      } else if (loadDemotesToUncertain(result)) {
        admitted.markUncertain();
        state = "uncertain";
      } else {
        abandonClaim(admitted);
      }
      return result;
    } finally {
      if (admitted.state() === "pending") {
        admitted.markUncertain();
        state = "uncertain";
      }
    }
  };

  const ensureLoadedInner = async (): Promise<ManagedEnsureLoadedResult> => {
    if (state === "resident" && handle !== null) {
      const held = handle;
      const result = await opts.client.load();
      if (loadDemotesToUncertain(result)) {
        held.demoteUncertain();
        state = "uncertain";
      }
      return result;
    }
    return await admitAndLoad();
  };

  return {
    async ensureLoaded(): Promise<ManagedEnsureLoadedResult> {
      if (state === "uncertain") return { kind: "refused", reason: "ResidencyUncertain" };
      if (unloadInFlight) return { kind: "refused", reason: "OperationInProgress" };
      if (flight !== null) return await flight;
      const promise = ensureLoadedInner().finally(() => {
        flight = null;
      });
      flight = promise;
      return await promise;
    },
    async unload(): Promise<NativeUnloadResult> {
      if (flight !== null || unloadInFlight) {
        return { kind: "refused", reason: "OperationInProgress", reservation: "held" };
      }
      // The shared flight marker is held across the whole unload, so no
      // ensureLoaded can admit a claim mid-unload and the claim this unload
      // retires below is provably the one it started with.
      unloadInFlight = true;
      try {
        const result = await opts.client.unload();
        if (result.reservation === "released") {
          if (handle !== null && (state === "resident" || state === "uncertain")) {
            handle.releaseVerified();
          }
          handle = null;
          state = "unclaimed";
        } else if (result.reservation === "uncertain") {
          if (handle !== null && state === "resident") {
            handle.demoteUncertain();
          }
          // Even with no claim held, local residency goes uncertain so a
          // later ensureLoaded refuses instead of guessing at the backend.
          state = "uncertain";
        }
        return result;
      } finally {
        unloadInFlight = false;
      }
    },
    residency(): ManagedOmlxResidencyState {
      return state;
    },
    claimId(): string | undefined {
      return handle?.claimId;
    },
  };
}
