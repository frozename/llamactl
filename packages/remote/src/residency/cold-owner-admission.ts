import type {
  ColdEngineDispatch,
  ColdEngineForwarder,
  LocalEngineRequest,
} from "@llamactl/core/residency/engine-forwarder";

import {
  modelKeyOf,
  type QueueModelRef,
  type QueueSnapshot,
  type RequestQueueLimits,
} from "@llamactl/core/residency/queue-policy";
import { randomUUID } from "node:crypto";

import type { OwnerAdmission } from "./owner-admission.js";

import { admissionErrorResponse } from "../server/chat-admission.js";
import { type AdmissionRequest, createRequestAdmission } from "./request-admission.js";

type DeclaredModelEntryV1 = ColdEngineDispatch["declaration"];

export interface TrustedColdPin {
  model: string;
  workload: string;
  ownerNodeId: string;
  /** Exact owner deployment identity, including the target kind if a workload name can be shared. */
  deploymentId: string;
  artifactRevision: string;
  policyRevision: string;
  endpoint: string;
  pretokenizedCompletion?: true;
}

export interface ReadyColdDeployment {
  pin: Readonly<TrustedColdPin>;
  runtimeGeneration: string;
}

export interface TrustedColdOwner {
  /** Resolve the supplied declaration against current owner state, including policy and artifact. */
  pin: (entry: Readonly<DeclaredModelEntryV1>) => TrustedColdPin | undefined;
  /** The owner must enforce its own memory authority. Only "refused" proves no unresolved launch. */
  activate: (
    pin: Readonly<TrustedColdPin>,
    signal: AbortSignal,
  ) => Promise<"ready" | "refused" | "uncertain">;
  ready: (
    pin: Readonly<TrustedColdPin>,
    signal: AbortSignal,
  ) => Promise<ReadyColdDeployment | undefined>;
  /** Revalidate the exact runtime generation synchronously at engine dispatch. */
  stillOwns: (deployment: Readonly<ReadyColdDeployment>) => boolean;
}

interface ColdOwnerOptions {
  ownerNodeId: string;
  warm: OwnerAdmission;
  owner: TrustedColdOwner;
  limits: RequestQueueLimits;
}

interface ColdBatch {
  key: string;
  pin: Readonly<TrustedColdPin>;
  declaration: Readonly<DeclaredModelEntryV1>;
  model: QueueModelRef;
  waiters: number;
  loadSignal?: AbortSignal;
  ready?: ReadyColdDeployment;
}

export interface ColdOwnerAdmission {
  forward: ColdEngineForwarder;
  stop: () => void;
  whenIdle: () => Promise<void>;
  snapshot: () => QueueSnapshot;
}

function pinKey(pin: Readonly<TrustedColdPin>): string {
  return JSON.stringify([
    pin.model,
    pin.workload,
    pin.ownerNodeId,
    pin.deploymentId,
    pin.artifactRevision,
    pin.policyRevision,
    pin.endpoint,
    pin.pretokenizedCompletion === true,
  ]);
}

function buildTarget(
  pin: Readonly<TrustedColdPin>,
  path: ColdEngineDispatch["path"],
): string | undefined {
  const endpoint = URL.parse(pin.endpoint);
  if (
    endpoint?.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "/v1")
  )
    return undefined;
  return new URL(path, endpoint).href;
}

function matchesDeclaration(
  pin: Readonly<TrustedColdPin>,
  entry: Readonly<DeclaredModelEntryV1>,
): boolean {
  return (
    pin.model === entry.id &&
    pin.ownerNodeId === entry.ownerNodeId &&
    pin.workload === entry.workload &&
    [pin.artifactRevision, pin.policyRevision, pin.deploymentId].every((id) => id.length > 0)
  );
}

function ownerRefusal(code: "cold_owner_unavailable" | "cold_owner_fenced"): Response {
  return Response.json({ error: { type: "model_unavailable", code } }, { status: 503 });
}

class ColdOwnerAdmissionImpl implements ColdOwnerAdmission {
  private readonly blocked = new AbortController();
  private readonly stopped = new AbortController();
  private readonly batches = new Map<string, ColdBatch>();
  private readonly byModel = new Map<string, ColdBatch>();
  private readonly activeLoads = new Set<Promise<void>>();
  private readonly admission;

  constructor(private readonly opts: ColdOwnerOptions) {
    this.admission = createRequestAdmission({
      limits: opts.limits,
      load: (key, signal): Promise<void> => {
        const load = this.loadBatch(key, signal);
        this.activeLoads.add(load);
        return load.finally(() => {
          this.activeLoads.delete(load);
        });
      },
    });
  }

  private async loadBatch(key: string, signal: AbortSignal): Promise<void> {
    this.stopped.signal.throwIfAborted();
    const batch = this.byModel.get(key);
    if (batch === undefined) throw new Error("cold batch ended");
    batch.loadSignal = signal;
    try {
      batch.ready = await this.load(batch, signal);
      signal.throwIfAborted();
    } finally {
      delete batch.loadSignal;
      this.forgetIdleBatch(batch);
    }
  }

  private pinStillCurrent(batch: ColdBatch): boolean {
    const current = this.opts.owner.pin(batch.declaration);
    return current !== undefined && pinKey(current) === batch.key;
  }

  private checkReady(batch: ColdBatch, ready: ReadyColdDeployment): ReadyColdDeployment {
    if (pinKey(ready.pin) !== batch.key || ready.runtimeGeneration.trim().length === 0) {
      throw new Error("cold readiness changed");
    }
    const proof = Object.freeze({ pin: batch.pin, runtimeGeneration: ready.runtimeGeneration });
    if (!this.stillOwns(batch, proof)) throw new Error("cold target changed");
    return proof;
  }

  private stillOwns(batch: ColdBatch, ready: ReadyColdDeployment): boolean {
    try {
      return (
        !this.blocked.signal.aborted &&
        !this.stopped.signal.aborted &&
        this.pinStillCurrent(batch) &&
        this.opts.owner.stillOwns(ready)
      );
    } catch {
      return false;
    }
  }

  private async load(batch: ColdBatch, signal: AbortSignal): Promise<ReadyColdDeployment> {
    signal.throwIfAborted();
    if (!this.pinStillCurrent(batch)) throw new Error("cold pin changed");
    const existing = await this.opts.owner.ready(batch.pin, signal);
    if (existing !== undefined) return this.checkReady(batch, existing);
    signal.throwIfAborted();
    if (!this.pinStillCurrent(batch)) throw new Error("cold pin changed");
    return await this.activate(batch, signal);
  }

  private async activate(batch: ColdBatch, signal: AbortSignal): Promise<ReadyColdDeployment> {
    let outcome: Awaited<ReturnType<TrustedColdOwner["activate"]>> | undefined;
    try {
      outcome = await this.opts.owner.activate(batch.pin, signal);
      if (outcome !== "ready") throw new Error("cold owner did not confirm launch");
      // The physical activation needs a verdict even if every HTTP client left.
      const ready = await this.opts.owner.ready(batch.pin, this.stopped.signal);
      if (ready === undefined) throw new Error("cold activation did not establish readiness");
      return this.checkReady(batch, ready);
    } catch (error) {
      if (outcome !== "refused") this.blocked.abort();
      throw error;
    }
  }

  private getBatch(
    declaration: Readonly<DeclaredModelEntryV1>,
    pin: Readonly<TrustedColdPin>,
  ): ColdBatch | undefined {
    const key = pinKey(pin);
    const existing = this.batches.get(key);
    if (existing !== undefined) return existing.loadSignal?.aborted === true ? undefined : existing;
    if (declaration.state === "loading") return undefined;
    const model = { name: randomUUID(), revision: "cold-owner" };
    const batch = { key, declaration, pin, model, waiters: 0 };
    this.batches.set(key, batch);
    this.byModel.set(modelKeyOf(model), batch);
    return batch;
  }

  private forgetIdleBatch(batch: ColdBatch): void {
    if (batch.waiters !== 0 || batch.loadSignal !== undefined) return;
    this.batches.delete(batch.key);
    const modelKey = modelKeyOf(batch.model);
    this.byModel.delete(modelKey);
    this.admission.invalidateModel(modelKey);
  }

  private currentPin(declaration: Readonly<DeclaredModelEntryV1>): TrustedColdPin | undefined {
    if (
      declaration.ownerNodeId !== this.opts.ownerNodeId ||
      !(
        declaration.state === "loading" ||
        (declaration.state === "cold" && declaration.autoLoadEligible)
      )
    )
      return undefined;
    try {
      const value = this.opts.owner.pin(declaration);
      return value === undefined || !matchesDeclaration(value, declaration)
        ? undefined
        : Object.freeze({ ...value });
    } catch {
      return undefined;
    }
  }

  private async queueAndForward(
    batch: ColdBatch,
    request: LocalEngineRequest,
    dispatch: ColdEngineDispatch,
    queued: Omit<AdmissionRequest, "model" | "requestId">,
  ): Promise<Response> {
    batch.waiters++;
    try {
      const release = await this.admission.acquire(
        { ...queued, model: batch.model, requestId: randomUUID() },
        {
          signal: AbortSignal.any([request.clientSignal, this.blocked.signal]),
          deadlineMs: request.deadlineMs,
        },
      );
      release();
    } catch (error) {
      if (this.blocked.signal.aborted) return ownerRefusal("cold_owner_fenced");
      return admissionErrorResponse(error);
    } finally {
      batch.waiters--;
      this.forgetIdleBatch(batch);
    }

    const proof = batch.ready;
    if (proof === undefined || !this.stillOwns(batch, proof)) {
      return ownerRefusal("cold_owner_unavailable");
    }
    return await (this.opts.warm.forward({
      ...request,
      stillOwnsTarget: () => this.stillOwns(batch, proof),
      send: (signal, body) => dispatch.send(request.target, signal, body),
    }) ?? ownerRefusal("cold_owner_unavailable"));
  }

  forward: ColdEngineForwarder = async (dispatch): Promise<Response> => {
    if (dispatch.clientSignal.aborted) return new Response(null, { status: 499 });
    if (this.blocked.signal.aborted) return ownerRefusal("cold_owner_fenced");
    if (this.stopped.signal.aborted) return ownerRefusal("cold_owner_unavailable");
    const declaration = Object.freeze({ ...dispatch.declaration });
    const pin = this.currentPin(declaration);
    const target = pin === undefined ? undefined : buildTarget(pin, dispatch.path);
    if (pin === undefined || target === undefined) return ownerRefusal("cold_owner_unavailable");

    const request: LocalEngineRequest = {
      target,
      deadlineMs: dispatch.deadlineMs,
      body: dispatch.body,
      workload: pin.workload,
      ...(pin.pretokenizedCompletion === true ? { pretokenizedCompletion: true } : {}),
      clientSignal: AbortSignal.any([dispatch.clientSignal, this.stopped.signal]),
      principal: dispatch.principal,
    };
    const checked = this.opts.warm.preflightCold(request, pin.model);
    if (checked === undefined) return ownerRefusal("cold_owner_unavailable");
    if ("refusal" in checked) return admissionErrorResponse(checked.refusal);
    const batch = this.getBatch(declaration, pin);
    if (batch === undefined) return ownerRefusal("cold_owner_unavailable");
    // Warm preflight owns the effective body. The queue keeps only its bounded costs.
    return await this.queueAndForward(batch, request, dispatch, checked.request);
  };

  stop = (): void => {
    this.stopped.abort();
  };

  whenIdle = async (): Promise<void> => {
    await Promise.allSettled(this.activeLoads);
  };

  snapshot = (): QueueSnapshot => this.admission.snapshot();
}

export function createColdOwnerAdmission(opts: ColdOwnerOptions): ColdOwnerAdmission {
  return new ColdOwnerAdmissionImpl(opts);
}
