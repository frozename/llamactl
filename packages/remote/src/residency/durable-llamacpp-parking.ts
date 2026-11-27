import { getResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  type ManagedCapacityOptions,
  type ManagedCapacitySample,
  projectManagedCapacity,
} from "@llamactl/core/resources/managed-capacity";

import type { AdmissionAuthority } from "./admission-authority.js";
import type { ClaimRow, NativeWakeLimits } from "./admission-store.js";
import type { NativeSleepReceipt } from "./llamacpp-sleep-client.js";

import { nativeWakeCovered } from "./admission-store.js";
import {
  createAgentLlamacppWakeDriver,
  type LlamacppWakeDriveOutcome,
  type LlamacppWakeDriver,
  type LlamacppWakeDriverOptions,
  type ManagedLlamacppWakeProof,
} from "./llamacpp-wake-client.js";

type Runtime = ManagedLlamacppWakeProof["pin"]["runtime"];
type WakeOptions = Parameters<LlamacppWakeDriver["wake"]>[0];

export interface DurableLlamacppParkingOptions {
  authority: Pick<AdmissionAuthority, "snapshot" | "transitionNative">;
  runtime: Runtime;
  memberId: string;
  readInferenceHold: (workload: string) => "clear" | "current" | "prior" | "unknown";
  /** Only a qualified, current residual-memory upper bound may lower the durable charge. */
  qualifiedResidualGiB: (runtime: Runtime, receipt: NativeSleepReceipt) => number | undefined;
  /** Verify this generation still owns the pinned listener. */
  verifySleepEndpoint: (runtime: Runtime) => boolean;
  observeRuntime: ManagedLlamacppWakeProof["observeRuntime"];
  qualifiedReady: ManagedLlamacppWakeProof["qualifiedReady"];
  readCapacity: () => ManagedCapacitySample | undefined;
  capacityPolicy: () => ManagedCapacityOptions;
}

type SleepClaim = { claim: ClaimRow; receipt: NativeSleepReceipt };

export interface DurableLlamacppParking {
  sleep: {
    workload: string;
    readInferenceHold: DurableLlamacppParkingOptions["readInferenceHold"];
    beforeDispatch: (receipt: NativeSleepReceipt) => boolean;
    parkAfterSleep: (receipt: NativeSleepReceipt) => boolean;
  };
  wake(
    opts: Omit<LlamacppWakeDriverOptions, "managed" | "memberId" | "endpoint">,
    wakeOpts?: WakeOptions,
  ): Promise<LlamacppWakeDriveOutcome>;
}

function ownsDrain(receipt: NativeSleepReceipt, phase: "draining" | "unloaded"): boolean {
  const { sleepRegistry, sleepDrain } = receipt;
  if (getResidencyLeaseRegistry() !== sleepRegistry) return false;
  const current = sleepRegistry.snapshot(sleepDrain.workload);
  return current.phase === phase && current.epoch === sleepDrain.epoch;
}

function matchesReceipt(
  runtime: Runtime,
  memberId: string,
  receipt: NativeSleepReceipt,
  phase: "draining" | "unloaded",
): boolean {
  return (
    receipt.memberId === memberId &&
    receipt.sleepDrain.workload === runtime.workload &&
    receipt.endpoint.host === runtime.endpoint.host &&
    receipt.endpoint.port === runtime.endpoint.port &&
    ownsDrain(receipt, phase)
  );
}

function sameSleepDrain(a: NativeSleepReceipt | undefined, b: NativeSleepReceipt): boolean {
  return (
    a?.sleepRegistry === b.sleepRegistry &&
    a.sleepDrain.workload === b.sleepDrain.workload &&
    a.sleepDrain.epoch === b.sleepDrain.epoch
  );
}

function sameClaim(row: ClaimRow, expected: ClaimRow): boolean {
  return (
    row.claimId === expected.claimId &&
    row.fenceToken === expected.fenceToken &&
    row.generationVersion === expected.generationVersion &&
    row.ownerEpoch === expected.ownerEpoch
  );
}

function capacityLimits(opts: DurableLlamacppParkingOptions): NativeWakeLimits | undefined {
  try {
    const measured = projectManagedCapacity(opts.readCapacity(), opts.capacityPolicy());
    return measured.ok ? measured : undefined;
  } catch {
    return undefined;
  }
}

function sealWakeProof(
  opts: DurableLlamacppParkingOptions,
  runtime: Runtime,
  parked: SleepClaim,
  reserved: ClaimRow,
): ManagedLlamacppWakeProof {
  const { authority } = opts;
  const { sleepRegistry, sleepDrain } = parked.receipt;
  function stillCovers(): boolean {
    const limits = capacityLimits(opts);
    if (
      limits === undefined ||
      !ownsDrain(parked.receipt, "unloaded") ||
      opts.readInferenceHold(runtime.workload) !== "clear"
    )
      return false;
    const claims = authority.snapshot();
    const row = claims.find((candidate) => sameClaim(candidate, reserved));
    return row?.state === "pending" && nativeWakeCovered(claims, row, limits);
  }

  let qualified = false;
  return {
    sleepRegistry,
    pin: {
      memberId: opts.memberId,
      runtime,
      sleepDrain,
      claim: {
        claimId: reserved.claimId,
        fenceToken: reserved.fenceToken,
        allocationGiB: reserved.allocationGiB,
      },
    },
    observeRuntime: (pin, signal) => opts.observeRuntime(pin, signal),
    isReserved: stillCovers,
    beginDispatch(): boolean {
      const limits = capacityLimits(opts);
      return (
        limits !== undefined &&
        stillCovers() &&
        authority.transitionNative(runtime, reserved, { kind: "dispatch", limits }) !== undefined
      );
    },
    qualifiedReady(pin, props): boolean {
      qualified = opts.qualifiedReady(pin, props);
      return qualified;
    },
    commitReady(): boolean {
      return (
        qualified &&
        stillCovers() &&
        authority.transitionNative(runtime, reserved, { kind: "ready" }) !== undefined
      );
    },
    markUncertain(): void {
      authority.transitionNative(runtime, reserved, { kind: "uncertain" });
    },
  };
}

// A serving owner must supply independent, qualified native evidence. No
// ordinary readiness poll or backend acknowledgement authorizes this adapter.
export function createDurableLlamacppParking(
  opts: DurableLlamacppParkingOptions,
): DurableLlamacppParking {
  const runtime = Object.freeze({
    ...opts.runtime,
    endpoint: Object.freeze({ ...opts.runtime.endpoint }),
  });
  const { authority, memberId } = opts;
  let parked: SleepClaim | undefined;
  let dispatch: SleepClaim | undefined;
  const activeClaim = (): ClaimRow | undefined =>
    authority
      .snapshot()
      .find((row) => row.runtimeKey === runtime.workload && row.specDigest === runtime.specDigest);

  return {
    sleep: {
      workload: runtime.workload,
      readInferenceHold: (workload) => opts.readInferenceHold(workload),
      beforeDispatch(receipt): boolean {
        if (
          !matchesReceipt(runtime, memberId, receipt, "draining") ||
          !opts.verifySleepEndpoint(runtime)
        )
          return false;
        const claim = sameSleepDrain(dispatch?.receipt, receipt) ? dispatch?.claim : activeClaim();
        if (claim === undefined || !ownsDrain(receipt, "draining")) return false;
        const verified = authority.transitionNative(runtime, claim, { kind: "verify-sleep" });
        if (verified === undefined) return false;
        dispatch = { claim: verified, receipt };
        return true;
      },
      parkAfterSleep(receipt): boolean {
        const attempted = dispatch;
        if (
          attempted === undefined ||
          !sameSleepDrain(attempted.receipt, receipt) ||
          !matchesReceipt(runtime, memberId, receipt, "unloaded")
        )
          return false;
        const residualGiB = opts.qualifiedResidualGiB(runtime, receipt);
        if (residualGiB === undefined || opts.readInferenceHold(runtime.workload) !== "clear")
          return false;
        if (!opts.verifySleepEndpoint(runtime) || !ownsDrain(receipt, "unloaded")) return false;
        const sealed = authority.transitionNative(runtime, attempted.claim, {
          kind: "park",
          residualGiB,
        });
        if (sealed === undefined) return false;
        parked = {
          claim: sealed,
          receipt: {
            ...receipt,
            sleepDrain: Object.freeze({ ...receipt.sleepDrain }),
            endpoint: Object.freeze({ ...receipt.endpoint }),
          },
        };
        return true;
      },
    },
    async wake(wake, wakeOpts): Promise<LlamacppWakeDriveOutcome> {
      if (wakeOpts?.signal?.aborted === true) return { kind: "refused", reason: "WakeAborted" };
      const candidate = parked;
      const limits = capacityLimits(opts);
      if (
        candidate === undefined ||
        limits === undefined ||
        !ownsDrain(candidate.receipt, "unloaded") ||
        opts.readInferenceHold(runtime.workload) !== "clear"
      )
        return { kind: "refused", reason: "ManagedWakeReservationUnavailable" };
      const reserved = authority.transitionNative(runtime, candidate.claim, {
        kind: "reserve",
        limits,
      });
      if (reserved === undefined)
        return { kind: "refused", reason: "ManagedWakeReservationUnavailable" };
      const managed = sealWakeProof(opts, runtime, candidate, reserved);
      try {
        return await createAgentLlamacppWakeDriver({
          ...wake,
          endpoint: runtime.endpoint,
          memberId,
          managed,
        }).wake(wakeOpts);
      } finally {
        // If the exact receipt is still pending, no other path may treat its
        // unapplied allocation as released. Successful ready rotated its fence.
        authority.transitionNative(runtime, reserved, { kind: "uncertain" });
      }
    },
  };
}
