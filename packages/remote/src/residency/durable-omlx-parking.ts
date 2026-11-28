import { getResidencyLeaseRegistry, type ResidencyLeases } from "@llamactl/core/residency/leases";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

import type { AdmissionAuthority, NativeRuntimeGeneration } from "./admission-authority.js";
import type { ClaimRow, NativeWakeLimits } from "./admission-store.js";
import type { InferenceHoldState } from "./inference-holds.js";
import type { ConnectOmlxOwnerSocket } from "./omlx-owner-socket.js";

import {
  createOmlxNativeClient,
  nativeBindingCurrent,
  type NativeLoadResult,
  type NativeUnloadResult,
  type OmlxNativeBinding,
  type OmlxNativeClient,
  type OmlxNativeClientOptions,
  type OmlxNativeLoadReceipt,
  type OmlxNativeUnloadReceipt,
} from "./engine-client.js";
import { createOmlxOwnerFetch } from "./omlx-owner-http.js";

type ParkedResult = { kind: "parked"; modelId: string; chargedGiB: number };
type DurableUnloadResult = ParkedResult | Exclude<NativeUnloadResult, { reservation: "released" }>;
export type NativeOmlxResidencyAction = "park" | "resume";
export type NativeOmlxResidencyResult = DurableUnloadResult | NativeLoadResult;
type Parked = { claim: ClaimRow; receipt: OmlxNativeUnloadReceipt };

export interface DurableOmlxParkingOptions {
  activityObservable: boolean;
  apiKey: string;
  readiness: NonNullable<OmlxNativeClientOptions["readiness"]>;
  authority: Pick<AdmissionAuthority, "snapshot" | "transitionNative">;
  runtime: NativeRuntimeGeneration;
  binding: OmlxNativeBinding;
  connect: ConnectOmlxOwnerSocket;
  registry: ResidencyLeases;
  readInferenceHold: (workload: string) => InferenceHoldState;
  verifyExclusiveIngress: () => boolean;
  qualifiedResidualGiB: (receipt: OmlxNativeUnloadReceipt) => number | undefined;
  readLimits: () => NativeWakeLimits | undefined;
}

function sameClaim(current: ClaimRow | undefined, expected: ClaimRow): boolean {
  return (
    current?.claimId === expected.claimId &&
    current.fenceToken === expected.fenceToken &&
    current.generationVersion === expected.generationVersion &&
    current.ownerEpoch === expected.ownerEpoch
  );
}

const refuseLoad = (): NativeLoadResult => ({
  kind: "refused",
  reason: "ManagedReservationUnavailable",
});
const refuseUnload = (): DurableUnloadResult => ({
  kind: "refused",
  reason: "ManagedReservationUnavailable",
  reservation: "held",
});
const unconfirmedUnload = (): DurableUnloadResult => ({
  kind: "ambiguous",
  reason: "ManagedReleaseUnverified",
  reservation: "uncertain",
});

function parkedResult(parked: Parked): ParkedResult {
  return {
    kind: "parked",
    modelId: parked.receipt.modelId,
    chargedGiB: parked.claim.allocationGiB,
  };
}

type ParkAttempt = { started?: ClaimRow | undefined };
type LoadAttempt = { reserved?: ClaimRow | undefined; dispatched?: ClaimRow | undefined };

function lostParkedProof(result: NativeLoadResult): boolean {
  return (
    result.kind === "ambiguous" ||
    (result.kind === "refused" &&
      (result.reason === "IdentityUnverified" ||
        result.reason === "LoadInProgress" ||
        result.reason === "StatusUnavailable"))
  );
}

function residualCharge(measured: number | undefined, fullGiB: number): number {
  return measured !== undefined && Number.isFinite(measured) && measured > 0 && measured <= fullGiB
    ? measured
    : fullGiB;
}

function exclusiveIngressConfirmed(value: unknown): boolean {
  return value === true;
}

class DurableOmlxParking {
  readonly #runtime: NativeRuntimeGeneration;
  readonly #binding: OmlxNativeBinding;
  readonly #client: OmlxNativeClient;
  readonly #privateBind: boolean;
  readonly #authenticated: boolean;
  #parked: Parked | undefined;
  #inFlight = false;
  #approveWrite: (() => boolean) | undefined;

  constructor(private readonly opts: DurableOmlxParkingOptions) {
    this.#runtime = Object.freeze({ ...opts.runtime });
    this.#binding = Object.freeze({
      ...opts.binding,
      endpoint: Object.freeze({ ...opts.binding.endpoint }),
    });
    this.#authenticated = opts.apiKey.trim().length > 0;
    const endpoint = this.#binding.endpoint;
    const read = createOmlxOwnerFetch(endpoint, { connect: opts.connect });
    const write = createOmlxOwnerFetch(endpoint, {
      connect: (signal) => this.#connectForWrite(signal),
    });
    this.#client = createOmlxNativeClient({
      endpoint: this.#binding.endpoint,
      binding: this.#binding,
      hostedRel: this.#binding.modelId,
      activityObservable: opts.activityObservable,
      apiKey: opts.apiKey,
      readiness: opts.readiness,
      fetch: Object.assign(
        (input: Request | URL | string, init?: RequestInit): Promise<Response> =>
          (init?.method === "POST" ? write : read)(input, init),
        { preconnect: read.preconnect },
      ),
      leases: { registry: opts.registry, workload: this.#runtime.workload },
    });
    const { host } = this.#binding.endpoint;
    this.#privateBind = host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  }

  async #connectForWrite(signal?: AbortSignal | null): ReturnType<ConnectOmlxOwnerSocket> {
    const socket = await this.opts.connect(signal);
    try {
      signal?.throwIfAborted();
      if (this.#approveWrite?.() !== true) {
        throw new Error("Managed native transition no longer authorizes dispatch");
      }
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  #issuerCurrent(): boolean {
    try {
      return (
        this.#privateBind &&
        this.#authenticated &&
        this.#binding.runtimeGeneration === this.#runtime.birthId &&
        this.opts.registry === getResidencyLeaseRegistry() &&
        exclusiveIngressConfirmed(this.opts.verifyExclusiveIngress()) &&
        this.opts.readInferenceHold(this.#runtime.workload) === "clear" &&
        nativeBindingCurrent(this.#binding, this.#binding.endpoint)
      );
    } catch {
      return false;
    }
  }

  #claim(): ClaimRow | undefined {
    return this.opts.authority
      .snapshot()
      .find(
        (row) =>
          row.runtimeKey === this.#runtime.workload &&
          row.kind === "ModelHost" &&
          row.specDigest === this.#runtime.specDigest,
      );
  }

  #ownsDrain(receipt: OmlxNativeUnloadReceipt, phase: "draining" | "unloaded"): boolean {
    const { registry } = this.opts;
    const { workload } = this.#runtime;
    const lease = registry.snapshot(workload);
    return (
      receipt.registry === registry &&
      receipt.token.workload === workload &&
      receipt.token.epoch === lease.epoch &&
      lease.phase === phase &&
      receipt.modelId === this.#binding.modelId &&
      isDeepStrictEqual(receipt.binding, this.#binding)
    );
  }

  #parkCurrent(held: Parked): boolean {
    return (
      this.#issuerCurrent() &&
      this.#ownsDrain(held.receipt, "unloaded") &&
      sameClaim(this.#claim(), held.claim)
    );
  }

  #retain(claim: ClaimRow): void {
    this.opts.authority.transitionNative(this.#runtime, claim, { kind: "uncertain" });
  }

  #invalidate(held: Parked): void {
    this.#retain(held.claim);
    this.#parked = undefined;
  }

  async #verifyParked(held: Parked, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || !this.#parkCurrent(held)) return false;
    const status = await this.#client.status(signal);
    return (
      !signal?.aborted &&
      status.state === "discovered" &&
      status.modelId === this.#binding.modelId &&
      this.#parkCurrent(held)
    );
  }

  async #confirmParked(held: Parked): Promise<DurableUnloadResult> {
    if (await this.#verifyParked(held)) return parkedResult(held);
    this.#invalidate(held);
    return unconfirmedUnload();
  }

  #beginPark(attempt: ParkAttempt, receipt: OmlxNativeUnloadReceipt): boolean {
    if (!this.#issuerCurrent() || !this.#ownsDrain(receipt, "draining")) return false;
    const claim = this.#claim();
    if (claim === undefined) return false;
    const started = this.opts.authority.transitionNative(this.#runtime, claim, {
      kind: "begin-park",
    });
    if (started === undefined) return false;
    attempt.started = started;
    this.#approveWrite = (): boolean =>
      this.#issuerCurrent() &&
      this.#ownsDrain(receipt, "draining") &&
      sameClaim(this.#claim(), started);
    return true;
  }

  #commitPark(attempt: ParkAttempt, receipt: OmlxNativeUnloadReceipt): boolean {
    const { started } = attempt;
    if (started === undefined || !this.#issuerCurrent() || !this.#ownsDrain(receipt, "unloaded")) {
      return false;
    }
    const residualGiB = residualCharge(
      this.opts.qualifiedResidualGiB(receipt),
      started.allocationGiB,
    );
    if (!this.#issuerCurrent() || !this.#ownsDrain(receipt, "unloaded")) return false;
    const claim = this.opts.authority.transitionNative(this.#runtime, started, {
      kind: "park",
      residualGiB,
    });
    if (claim === undefined) return false;
    this.#parked = { claim, receipt };
    return true;
  }

  async #unload(): Promise<DurableUnloadResult> {
    if (this.#parked !== undefined) return await this.#confirmParked(this.#parked);
    return await this.#park();
  }

  async #park(): Promise<DurableUnloadResult> {
    const client = this.#client;
    if (client.unloadWithCommit === undefined || !this.#issuerCurrent()) return refuseUnload();
    const attempt: ParkAttempt = {};
    try {
      const result = await client.unloadWithCommit({
        workload: this.#runtime.workload,
        beforeDispatch: (receipt) => this.#beginPark(attempt, receipt),
        commitParked: (receipt) => this.#commitPark(attempt, receipt),
      });
      if (result.reservation !== "released") return result;
      return this.#parked === undefined ? unconfirmedUnload() : parkedResult(this.#parked);
    } finally {
      if (attempt.started !== undefined && this.#parked === undefined)
        this.#retain(attempt.started);
    }
  }

  async #verifyResident(): Promise<NativeLoadResult> {
    const { registry } = this.opts;
    const { workload } = this.#runtime;
    const claim = this.#claim();
    const lease = registry.snapshot(workload);
    if (claim?.state !== "resident" || lease.phase !== "open") return refuseLoad();

    const status = await this.#client.status();
    const current = registry.snapshot(workload);
    if (
      (status.state !== "ready" && status.state !== "busy") ||
      status.modelId !== this.#binding.modelId ||
      !this.#issuerCurrent() ||
      !sameClaim(this.#claim(), claim) ||
      current.phase !== "open" ||
      current.epoch !== lease.epoch
    )
      return refuseLoad();
    return { kind: "already-loaded", modelId: status.modelId };
  }

  #reserveLoad(attempt: LoadAttempt, held: Parked, receipt: OmlxNativeLoadReceipt): boolean {
    if (
      receipt.modelId !== this.#binding.modelId ||
      !isDeepStrictEqual(receipt.binding, this.#binding)
    ) {
      return false;
    }
    const { authority, readLimits } = this.opts;
    const limits = readLimits();
    if (limits === undefined || !this.#parkCurrent(held)) return false;
    attempt.reserved = authority.transitionNative(this.#runtime, held.claim, {
      kind: "reserve",
      limits,
    });
    const reserved = attempt.reserved;
    if (reserved === undefined) return false;
    this.#approveWrite = (): boolean => {
      const fresh = readLimits();
      if (
        fresh === undefined ||
        !this.#issuerCurrent() ||
        !this.#ownsDrain(held.receipt, "unloaded") ||
        !sameClaim(this.#claim(), reserved)
      )
        return false;
      attempt.dispatched = authority.transitionNative(this.#runtime, reserved, {
        kind: "dispatch",
        limits: fresh,
      });
      return attempt.dispatched !== undefined;
    };
    return true;
  }

  async #loadParked(held: Parked): Promise<NativeLoadResult> {
    const { authority, registry } = this.opts;
    const client = this.#client;
    if (client.loadWithCommit === undefined || !this.#parkCurrent(held)) {
      this.#invalidate(held);
      return refuseLoad();
    }
    const attempt: LoadAttempt = {};
    try {
      const result = await client.loadWithCommit({
        workload: this.#runtime.workload,
        expectedLease: { registry, token: held.receipt.token, phase: "unloaded" },
        beforeDispatch: (receipt): boolean => this.#reserveLoad(attempt, held, receipt),
        commitReady: ({ modelId, binding }) =>
          attempt.dispatched !== undefined &&
          modelId === this.#binding.modelId &&
          isDeepStrictEqual(binding, this.#binding) &&
          this.#issuerCurrent() &&
          this.#ownsDrain(held.receipt, "unloaded") &&
          authority.transitionNative(this.#runtime, attempt.dispatched, { kind: "ready" }) !==
            undefined,
      });
      if (attempt.reserved === undefined && (lostParkedProof(result) || !this.#parkCurrent(held))) {
        this.#invalidate(held);
      }
      return result;
    } finally {
      if (attempt.reserved !== undefined) {
        this.#retain(attempt.dispatched ?? attempt.reserved);
        this.#parked = undefined;
      }
    }
  }

  async #load(): Promise<NativeLoadResult> {
    if (!this.#issuerCurrent()) {
      if (this.#parked !== undefined) this.#invalidate(this.#parked);
      return refuseLoad();
    }
    return this.#parked === undefined
      ? await this.#verifyResident()
      : await this.#loadParked(this.#parked);
  }

  async #run<T>(operation: () => Promise<T>, busy: T): Promise<T> {
    if (this.#inFlight) return busy;
    this.#inFlight = true;
    try {
      return await operation();
    } finally {
      this.#approveWrite = undefined;
      this.#inFlight = false;
    }
  }

  async verifyParked(signal?: AbortSignal): Promise<boolean> {
    const held = this.#parked;
    if (held === undefined || this.#inFlight) return false;
    return (await this.#verifyParked(held, signal)) && !this.#inFlight;
  }

  validateParkedCredit(claim: Readonly<ClaimRow>): boolean {
    const held = this.#parked;
    // The caller owns the ledger write lock and supplies its already-read row.
    return (
      held !== undefined &&
      isDeepStrictEqual(claim, held.claim) &&
      this.#issuerCurrent() &&
      this.#ownsDrain(held.receipt, "unloaded")
    );
  }

  unload(): Promise<DurableUnloadResult> {
    return this.#run(() => this.#unload(), {
      kind: "refused",
      reason: "OperationInProgress",
      reservation: "held",
    });
  }

  load(): Promise<NativeLoadResult> {
    return this.#run(() => this.#load(), { kind: "refused", reason: "OperationInProgress" });
  }
}

/** Same-claim native transitions for an owner-exclusive, pinned oMLX listener. */
export function createDurableOmlxParking(
  opts: DurableOmlxParkingOptions,
): Pick<DurableOmlxParking, "unload" | "load" | "validateParkedCredit" | "verifyParked"> {
  return new DurableOmlxParking(opts);
}
