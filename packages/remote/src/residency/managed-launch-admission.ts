import type { ManagedWorkloadKind } from "@llamactl/core/residency/admission";

import type { AdmissionAuthority, AdmitRequest, GenerationRecord } from "./admission-authority.js";
import type { DirectLifecycleOutcome } from "./direct-lifecycle.js";

export interface ManagedLaunchRequest {
  kind: ManagedWorkloadKind;
  runtimeKey: string;
  launch: Readonly<Record<string, unknown>>;
}

interface LaunchResult {
  ok: boolean;
  pid: number | null;
  spawnedPid?: number;
}

export interface ManagedLaunchAdmission {
  run<T extends LaunchResult>(
    request: ManagedLaunchRequest,
    signal: AbortSignal,
    start: () => Promise<DirectLifecycleOutcome<T>>,
  ): Promise<DirectLifecycleOutcome<T>>;
}

type LaunchRefusal = { ran: false; detail: string };
type AdmittedClaim = { claimId: string; fenceToken: string };

interface ManagedLaunchOptions {
  authority: Pick<
    AdmissionAuthority,
    "admit" | "recordGeneration" | "completeReady" | "failUncertain" | "abandonUnstarted"
  >;
  // The approved spec must account for the complete invocation.
  resolve: (
    request: ManagedLaunchRequest,
  ) => Pick<AdmitRequest, "specDigest" | "allocationGiB"> | undefined;
  // A probe of a bare PID cannot prove which process the launch created.
  capture: (request: ManagedLaunchRequest, pid: number) => GenerationRecord | undefined;
}

function refuse(detail: string): LaunchRefusal {
  return { ran: false, detail };
}

function recordLaunchGeneration(
  opts: ManagedLaunchOptions,
  request: ManagedLaunchRequest,
  claim: AdmittedClaim,
  result: LaunchResult,
): boolean {
  const pid = result.pid ?? result.spawnedPid;
  if (pid === undefined) return false;
  const generation = opts.capture(request, pid);
  return (
    generation?.pid === pid &&
    generation.startTimeMs !== undefined &&
    Number.isFinite(generation.startTimeMs) &&
    generation.startTimeMs > 0 &&
    opts.authority.recordGeneration(claim.claimId, claim.fenceToken, generation)
  );
}

async function runClaimedLaunch<T extends LaunchResult>(
  opts: ManagedLaunchOptions,
  request: ManagedLaunchRequest,
  { claimId, fenceToken }: AdmittedClaim,
  signal: AbortSignal,
  start: () => Promise<DirectLifecycleOutcome<T>>,
): Promise<DirectLifecycleOutcome<T>> {
  let settled = false;
  try {
    const outcome = signal.aborted ? refuse("LaunchCanceled") : await start();
    if (!outcome.ran) {
      settled = opts.authority.abandonUnstarted(claimId, fenceToken);
      return outcome;
    }
    const recorded = recordLaunchGeneration(opts, request, { claimId, fenceToken }, outcome.result);
    if (!outcome.result.ok) return outcome;
    if (signal.aborted) return refuse("LaunchCanceled");
    if (outcome.result.pid === null || !recorded) return refuse("ManagedGenerationUnverified");
    settled = opts.authority.completeReady(claimId, fenceToken);
    return settled ? outcome : refuse("ManagedReadyUnverified");
  } finally {
    if (!settled) {
      opts.authority.failUncertain(claimId, fenceToken, "launch outcome could not be committed");
    }
  }
}

export function createManagedLaunchAdmission(opts: ManagedLaunchOptions): ManagedLaunchAdmission {
  return {
    async run<T extends LaunchResult>(
      request: ManagedLaunchRequest,
      signal: AbortSignal,
      start: () => Promise<DirectLifecycleOutcome<T>>,
    ): Promise<DirectLifecycleOutcome<T>> {
      if (signal.aborted) return refuse("LaunchCanceled");
      // Replacement needs a verified release of the old generation.
      if (request.launch["restart"] === true) return refuse("ManagedRestartUnavailable");
      // Loading a manifest after admission can launch a different spec.
      if (request.kind === "ModelHost" && request.launch["manifest"] === undefined) {
        return refuse("ManagedManifestRequired");
      }
      const spec = opts.resolve(request);
      if (spec === undefined) return refuse("ManagedSpecUnknown");
      const claim = opts.authority.admit({
        specDigest: spec.specDigest,
        allocationGiB: spec.allocationGiB,
        runtimeKey: request.runtimeKey,
        kind: request.kind,
      });
      if (claim.kind === "refuse") return refuse(`${claim.reason}: ${claim.detail}`);
      if (claim.kind === "joined") return refuse("ManagedLaunchPending");
      if (claim.kind === "resident") return refuse("ManagedRuntimeResident");
      return await runClaimedLaunch(opts, request, claim, signal, start);
    },
  };
}
