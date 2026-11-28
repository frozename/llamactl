import type { ManagedClaimState, ManagedWorkloadKind } from "@llamactl/core/residency/admission";
import type { OkPlan } from "@llamactl/core/residency/planner";
import type { ManagedProfileSelection } from "@llamactl/core/residency/profile-selection";
import type { ManagedMemoryCalibrationKey } from "@llamactl/core/resources/memory";

import type { VerifyParkedOmlxProbe } from "../server/modelhost.js";
import type { AdmissionAuthority, AdmitRequest, GenerationRecord } from "./admission-authority.js";
import type { DirectLifecycleOutcome } from "./direct-lifecycle.js";
import type { InferenceHoldState } from "./inference-holds.js";

export interface ManagedLaunchRequest {
  kind: ManagedWorkloadKind;
  runtimeKey: string;
  launch: Readonly<Record<string, unknown>>;
  effectiveSpecDigest?: string;
  effectiveLaunch?: Readonly<Record<string, unknown>>;
}

interface LaunchResult {
  ok: boolean;
  pid: number | null;
  spawnedPid?: number;
  preDispatchRefusal?: string;
}

export type CommitLaunchReadiness = (pid: number) => string | undefined;
type StartManagedLaunch<T> = (
  commitReadiness: CommitLaunchReadiness,
  checkSpawn?: () => string | undefined,
) => Promise<DirectLifecycleOutcome<T>>;

export interface ManagedApplyBudget {
  ok: true;
  budget: number;
  reservedAfter: number;
}

export interface ManagedAdmissionReadout {
  ownerNodeId: string;
  ledger: "available" | "unavailable";
  profile:
    | { kind: Exclude<ManagedProfileSelection["kind"], "selected"> }
    | { kind: "selected"; profile: string };
  budgetGiB: number | null;
  claims: {
    workload: string;
    kind: ManagedWorkloadKind | null;
    state: ManagedClaimState;
    allocationGiB: number;
    inferenceHold?: InferenceHoldState;
  }[];
}

export type ManagedProfileWorkloadObservation =
  | { state: "running"; allocationGiB: number }
  | { state: "unknown" };

export interface ManagedCalibrationReadout {
  key: ManagedMemoryCalibrationKey;
  declaredGiB: number;
  allocationGiB: number;
  measured: boolean;
}

export interface ManagedLaunchAdmission {
  prepareStopRelease?: AdmissionAuthority["prepareStopRelease"];
  runOwnedLifecycle?: <T>(run: () => T) => T;
  ownsNode?: (name: string) => boolean;
  ownerNodeId?: string;
  readStatus?: () => ManagedAdmissionReadout;
  readCalibration?: (workload: string) => ManagedCalibrationReadout | undefined;
  allowsProfileServing?: (workload: string) => boolean;
  observeProfileWorkload?: (
    workload: string,
    kind: ManagedWorkloadKind,
  ) => ManagedProfileWorkloadObservation | undefined;
  verifyParkedOmlxProbe?: VerifyParkedOmlxProbe;
  preflightProfile?: (
    plan: Pick<OkPlan, "victims" | "replacements" | "retained">,
  ) => string | undefined;
  withDesiredManifest?: <T>(
    input: unknown,
    apply: (owned: boolean, budget?: ManagedApplyBudget) => Promise<T>,
  ) => Promise<T>;
  run<T extends LaunchResult>(
    request: ManagedLaunchRequest,
    signal: AbortSignal,
    start: StartManagedLaunch<T>,
  ): Promise<DirectLifecycleOutcome<T>>;
}

type LaunchRefusal = { ran: false; detail: string };
type AdmittedClaim = { claimId: string; fenceToken: string };

interface ManagedLaunchOptions {
  runOwnedLifecycle?: ManagedLaunchAdmission["runOwnedLifecycle"];
  authority: Pick<
    AdmissionAuthority,
    | "admit"
    | "recordGeneration"
    | "completeReady"
    | "failUncertain"
    | "abandonUnstarted"
    | "prepareStopRelease"
  >;
  inspectRuntime?: () => string | undefined;
  // The approved spec must account for the complete invocation.
  resolve: (request: ManagedLaunchRequest) => PlanResolution;
  // A probe of a bare PID cannot prove which process the launch created.
  capture: (request: ManagedLaunchRequest, pid: number) => GenerationRecord | undefined;
}

type ApprovedClaimPlan = Pick<AdmitRequest, "specDigest" | "allocationGiB"> & {
  measuredCalibrationDigest?: string;
};
type PlanResolution = ApprovedClaimPlan | { refusal: string } | undefined;

function verifyApprovedPlan(
  expected: ApprovedClaimPlan,
  actual: PlanResolution,
): string | undefined {
  if (actual === undefined) return "ManagedSpecUnknown";
  if ("refusal" in actual) return actual.refusal;
  return actual.specDigest === expected.specDigest &&
    actual.allocationGiB === expected.allocationGiB &&
    actual.measuredCalibrationDigest === expected.measuredCalibrationDigest
    ? undefined
    : "ManagedSpecChanged";
}

function refuse(detail: string): LaunchRefusal {
  return { ran: false, detail };
}

function recordLaunchGeneration(
  opts: ManagedLaunchOptions,
  request: ManagedLaunchRequest,
  claim: AdmittedClaim,
  pid: number,
): boolean {
  const generation = opts.capture(request, pid);
  return (
    generation?.pid === pid &&
    (generation.birthId !== undefined
      ? generation.birthId.length > 0
      : generation.startTimeMs !== undefined &&
        Number.isFinite(generation.startTimeMs) &&
        generation.startTimeMs > 0) &&
    opts.authority.recordGeneration(claim.claimId, claim.fenceToken, generation)
  );
}

function settlePreDispatchRefusal<T extends LaunchResult>(
  outcome: DirectLifecycleOutcome<T>,
): DirectLifecycleOutcome<T> {
  if (!outcome.ran || outcome.result.ok || outcome.result.preDispatchRefusal === undefined) {
    return outcome;
  }
  return refuse(outcome.result.preDispatchRefusal);
}

async function runClaimedLaunch<T extends LaunchResult>(
  opts: ManagedLaunchOptions,
  request: ManagedLaunchRequest,
  { claimId, fenceToken }: AdmittedClaim,
  signal: AbortSignal,
  start: (commitReadiness: CommitLaunchReadiness) => Promise<DirectLifecycleOutcome<T>>,
): Promise<DirectLifecycleOutcome<T>> {
  const claim = { claimId, fenceToken };
  let capturedPid: number | undefined;
  let committedPid: number | undefined;
  let abandoned = false;
  const commitReadiness: CommitLaunchReadiness = (pid) => {
    if (committedPid !== undefined) {
      return committedPid === pid ? undefined : "ManagedReadyUnverified";
    }
    if (signal.aborted) return "LaunchCanceled";
    if (!recordLaunchGeneration(opts, request, claim, pid)) return "ManagedGenerationUnverified";
    capturedPid = pid;
    if (!opts.authority.completeReady(claimId, fenceToken)) return "ManagedReadyUnverified";
    committedPid = pid;
    return undefined;
  };
  try {
    const outcome = settlePreDispatchRefusal(
      signal.aborted ? refuse("LaunchCanceled") : await start(commitReadiness),
    );
    if (!outcome.ran) {
      abandoned =
        committedPid === undefined && opts.authority.abandonUnstarted(claimId, fenceToken);
      return outcome;
    }
    const { ok, pid, spawnedPid } = outcome.result;
    if (ok) {
      return pid === committedPid ? outcome : refuse("ManagedReadyUnverified");
    }
    const failedPid = pid ?? spawnedPid;
    if (committedPid === undefined && failedPid !== undefined && failedPid !== capturedPid) {
      recordLaunchGeneration(opts, request, claim, failedPid);
    }
    return outcome;
  } finally {
    if (committedPid === undefined && !abandoned) {
      opts.authority.failUncertain(claimId, fenceToken, "launch outcome could not be committed");
    }
  }
}

export function createManagedLaunchAdmission(opts: ManagedLaunchOptions): ManagedLaunchAdmission {
  return {
    prepareStopRelease: (runtimeKey, kind) => opts.authority.prepareStopRelease(runtimeKey, kind),
    ...(opts.runOwnedLifecycle === undefined ? {} : { runOwnedLifecycle: opts.runOwnedLifecycle }),
    async run<T extends LaunchResult>(
      request: ManagedLaunchRequest,
      signal: AbortSignal,
      start: StartManagedLaunch<T>,
    ): Promise<DirectLifecycleOutcome<T>> {
      if (signal.aborted) return refuse("LaunchCanceled");
      // Replacement needs a verified release of the old generation.
      if (request.launch["restart"] === true) return refuse("ManagedRestartUnavailable");
      // Loading a manifest after admission can launch a different spec.
      if (request.kind === "ModelHost" && request.launch["manifest"] === undefined) {
        return refuse("ManagedManifestRequired");
      }
      const runtimeRefusal = opts.inspectRuntime?.();
      if (runtimeRefusal !== undefined) return refuse(runtimeRefusal);
      const spec = opts.resolve(request);
      if (spec === undefined) return refuse("ManagedSpecUnknown");
      if ("refusal" in spec) return refuse(spec.refusal);
      const claim = opts.authority.admit({
        specDigest: request.effectiveSpecDigest ?? spec.specDigest,
        allocationGiB: spec.allocationGiB,
        runtimeKey: request.runtimeKey,
        kind: request.kind,
      });
      if (claim.kind === "refuse") return refuse(`${claim.reason}: ${claim.detail}`);
      if (claim.kind === "joined") return refuse("ManagedLaunchPending");
      if (claim.kind === "resident") return refuse("ManagedRuntimeResident");
      const execute = (): Promise<DirectLifecycleOutcome<T>> =>
        runClaimedLaunch(opts, request, claim, signal, (commitReadiness) => {
          const verify = (): string | undefined => verifyApprovedPlan(spec, opts.resolve(request));
          const issue = verify();
          if (issue !== undefined) return Promise.resolve(refuse(issue));
          return start(
            (pid) => verify() ?? commitReadiness(pid),
            () => (signal.aborted ? "LaunchCanceled" : verify()),
          );
        });
      return await (opts.runOwnedLifecycle === undefined
        ? execute()
        : opts.runOwnedLifecycle(execute));
    },
  };
}
