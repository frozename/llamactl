/**
 * InferenceRpcV1 — the versioned gateway–worker execution RPC (P4.1,
 * design §6.1). Schema and pure negotiation only; the worker procedures
 * and clients live in @llamactl/remote. The stream carries Nova's
 * ExecutionEventV1, consumed from @novaproto/contracts and never
 * redefined here.
 *
 * Flow: `negotiate` picks a version and features, `catalog` lists the
 * worker's fixed deployments, `submit` runs acceptance fencing and
 * returns accepted/rejected without starting work, `stream` attaches the
 * one consumer of an accepted attempt and starts it, `status` and
 * `cancel` resolve an attempt by id. A transport loss is resolved through
 * `status`; `unknown` never means a retry is safe.
 */
import { ExecutionEventV1Schema, ExecutionTerminalSchema } from "@novaproto/contracts";
import { z } from "zod";

import { BackendKindSchema } from "../routing/catalog.js";
import { InferenceEnvelopeV1Schema } from "./contracts.js";

export const InferenceRpcVersionSchema = z.object({
  major: z.number().int().positive(),
  minor: z.number().int().nonnegative(),
});
export type InferenceRpcVersion = z.infer<typeof InferenceRpcVersionSchema>;

export const INFERENCE_RPC_VERSION: InferenceRpcVersion = Object.freeze({ major: 1, minor: 0 });

/**
 * Worker-routing hops a submit may carry in its envelope's internal
 * selection, counting itself: the caller's one trusted hop. Workers
 * execute locally and never forward.
 */
export const INFERENCE_RPC_MAX_HOPS = 1;

/** Bound on the visited-node chain. A node that appears twice is a loop. */
export const INFERENCE_RPC_MAX_VISITED_NODES = 8;

export const InferenceRpcOperationSchema = z.enum([
  "negotiate",
  "catalog",
  "submit",
  "stream",
  "status",
  "cancel",
]);
export type InferenceRpcOperation = z.infer<typeof InferenceRpcOperationSchema>;

export const InferenceRpcFeatureSchema = z.string().min(1).max(64);

/** Features a 1.x worker can honor when a caller requires them. */
export const INFERENCE_RPC_FEATURES: readonly string[] = Object.freeze([
  "attempt-status",
  "cancel-ack",
  "execution-event-v1",
]);

export const InferenceRpcRejectionCodeSchema = z.enum([
  "unauthorized-scope",
  "not-owner",
  "stale-generation",
  "deadline-exceeded",
  "hop-limit",
  "target-unavailable",
  "unsupported-feature",
  "unsupported-version",
  "overloaded",
]);
export type InferenceRpcRejectionCode = z.infer<typeof InferenceRpcRejectionCodeSchema>;

export const InferenceRpcRejectionV1Schema = z.object({
  code: InferenceRpcRejectionCodeSchema,
  message: z.string(),
  supportedVersions: z.array(InferenceRpcVersionSchema).optional(),
  unsupportedFeatures: z.array(InferenceRpcFeatureSchema).optional(),
  catalogGeneration: z.string().min(1).optional(),
});
export type InferenceRpcRejectionV1 = z.infer<typeof InferenceRpcRejectionV1Schema>;

const rejected = z.object({
  outcome: z.literal("rejected"),
  rejection: InferenceRpcRejectionV1Schema,
});

/**
 * Verified service authorization, derived server-side from a service
 * credential and never read from client headers. A deployment is in
 * scope when its id is in `deployments` or its model is in `models`.
 */
export const InferenceServiceClaimsV1Schema = z.object({
  serviceId: z.string().min(1),
  operations: z.array(InferenceRpcOperationSchema),
  deployments: z.array(z.string().min(1)),
  models: z.array(z.string().min(1)),
  tenants: z.array(z.string().min(1)),
  credentialScopeId: z.string().min(1),
});
export type InferenceServiceClaimsV1 = z.infer<typeof InferenceServiceClaimsV1Schema>;

export const InferenceRpcNegotiateRequestV1Schema = z.object({
  /** Every version the caller speaks: its own and the previous minor. */
  versions: z.array(InferenceRpcVersionSchema).min(1).max(8),
  requiredFeatures: z.array(InferenceRpcFeatureSchema).max(32).default([]),
  optionalFeatures: z.array(InferenceRpcFeatureSchema).max(32).default([]),
});
export type InferenceRpcNegotiateRequestV1 = z.infer<typeof InferenceRpcNegotiateRequestV1Schema>;
export type InferenceRpcNegotiateInputV1 = z.input<typeof InferenceRpcNegotiateRequestV1Schema>;

export const InferenceRpcNegotiateResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("negotiated"),
    version: InferenceRpcVersionSchema,
    workerId: z.string().min(1),
    workerIncarnation: z.string().min(1),
    features: z.array(InferenceRpcFeatureSchema),
  }),
  /** A positive "no RPC here": keep new requests on the existing path. */
  z.object({ outcome: z.literal("not-advertised"), workerId: z.string().min(1) }),
  rejected,
]);
export type InferenceRpcNegotiateResultV1 = z.infer<typeof InferenceRpcNegotiateResultV1Schema>;

export const InferenceRpcAvailabilitySchema = z.enum(["available", "unavailable"]);

export const InferenceRpcDeploymentV1Schema = z.object({
  deploymentId: z.string().min(1),
  /** The exact upstream model the deployment executes; never an alias. */
  model: z.string().min(1),
  publicModelIds: z.array(z.string().min(1)),
  backendKind: BackendKindSchema,
  /** Null when the epoch is unknown; such a deployment cannot be fenced. */
  deploymentEpoch: z.string().min(1).nullable(),
  availability: InferenceRpcAvailabilitySchema,
});
export type InferenceRpcDeploymentV1 = z.infer<typeof InferenceRpcDeploymentV1Schema>;

export const InferenceRpcCatalogResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("catalog"),
    workerId: z.string().min(1),
    workerIncarnation: z.string().min(1),
    catalogGeneration: z.string().min(1),
    deployments: z.array(InferenceRpcDeploymentV1Schema),
  }),
  rejected,
]);
export type InferenceRpcCatalogResultV1 = z.infer<typeof InferenceRpcCatalogResultV1Schema>;

export const InferenceRpcTargetV1Schema = z.object({
  deploymentId: z.string().min(1),
  expectedDeploymentEpoch: z.string().min(1),
  catalogGeneration: z.string().min(1),
  workerIncarnation: z.string().min(1),
});
export type InferenceRpcTargetV1 = z.infer<typeof InferenceRpcTargetV1Schema>;

export const InferenceRpcSubmitRequestV1Schema = z.object({
  version: InferenceRpcVersionSchema,
  envelope: InferenceEnvelopeV1Schema,
  target: InferenceRpcTargetV1Schema,
  cancelId: z.string().min(1).max(128),
});
export type InferenceRpcSubmitRequestV1 = z.infer<typeof InferenceRpcSubmitRequestV1Schema>;
export type InferenceRpcSubmitInputV1 = z.input<typeof InferenceRpcSubmitRequestV1Schema>;

/**
 * `accepted`: fenced and waiting for its stream; `started`: the engine
 * request left; `emitting`: content flowed; `terminal`: settled.
 * `unknown`: no record (never received, or retention expired) — it never
 * means a retry is safe.
 */
export const InferenceRpcAttemptStateSchema = z.enum([
  "unknown",
  "accepted",
  "started",
  "emitting",
  "terminal",
]);
export type InferenceRpcAttemptState = z.infer<typeof InferenceRpcAttemptStateSchema>;

export const InferenceRpcAttemptStatusV1Schema = z.object({
  attemptId: z.string().min(1),
  state: InferenceRpcAttemptStateSchema,
  requestId: z.string().min(1).optional(),
  deploymentId: z.string().min(1).optional(),
  terminal: ExecutionTerminalSchema.optional(),
  /**
   * The sequence of the terminal event, once the worker emitted it on the
   * attempt's stream. A caller whose stream broke compares it with the
   * last event it received: only when the terminal was the very next event
   * did it lose nothing but the terminal.
   */
  terminalSequence: z.number().int().nonnegative().optional(),
});
export type InferenceRpcAttemptStatusV1 = z.infer<typeof InferenceRpcAttemptStatusV1Schema>;

export const InferenceRpcSubmitResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    workerId: z.string().min(1),
    workerIncarnation: z.string().min(1),
    deploymentId: z.string().min(1),
    deploymentEpoch: z.string().min(1),
    acceptedAt: z.iso.datetime({ offset: true }),
  }),
  /** A duplicate attemptId: the existing record, never a second execution. */
  z.object({ outcome: z.literal("existing"), status: InferenceRpcAttemptStatusV1Schema }),
  rejected,
]);
export type InferenceRpcSubmitResultV1 = z.infer<typeof InferenceRpcSubmitResultV1Schema>;

export const InferenceRpcStreamRequestV1Schema = z.object({ attemptId: z.string().min(1) });
export type InferenceRpcStreamRequestV1 = z.infer<typeof InferenceRpcStreamRequestV1Schema>;

export const InferenceRpcStreamFrameV1Schema = z.discriminatedUnion("frame", [
  z.object({ frame: z.literal("event"), event: ExecutionEventV1Schema }),
  /**
   * The attempt cannot be streamed — unknown, already streamed once, or
   * settled — so its status is returned instead of a replay.
   */
  z.object({ frame: z.literal("unavailable"), status: InferenceRpcAttemptStatusV1Schema }),
  z.object({ frame: z.literal("rejected"), rejection: InferenceRpcRejectionV1Schema }),
]);
export type InferenceRpcStreamFrameV1 = z.infer<typeof InferenceRpcStreamFrameV1Schema>;

export const InferenceRpcStatusRequestV1Schema = z.object({ attemptId: z.string().min(1) });
export type InferenceRpcStatusRequestV1 = z.infer<typeof InferenceRpcStatusRequestV1Schema>;

export const InferenceRpcStatusResultV1Schema = z.discriminatedUnion("outcome", [
  InferenceRpcAttemptStatusV1Schema.extend({ outcome: z.literal("status") }),
  rejected,
]);
export type InferenceRpcStatusResultV1 = z.infer<typeof InferenceRpcStatusResultV1Schema>;

export const InferenceRpcCancelRequestV1Schema = z.union([
  z.object({ attemptId: z.string().min(1) }),
  z.object({ cancelId: z.string().min(1).max(128) }),
]);
export type InferenceRpcCancelRequestV1 = z.infer<typeof InferenceRpcCancelRequestV1Schema>;

export const InferenceRpcCancelResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cancelled"), attemptId: z.string().min(1) }),
  z.object({ outcome: z.literal("already-terminal"), attemptId: z.string().min(1) }),
  z.object({ outcome: z.literal("unknown") }),
  rejected,
]);
export type InferenceRpcCancelResultV1 = z.infer<typeof InferenceRpcCancelResultV1Schema>;

export function compareInferenceRpcVersions(
  a: InferenceRpcVersion,
  b: InferenceRpcVersion,
): number {
  return a.major === b.major ? a.minor - b.minor : a.major - b.major;
}

/** The versions a peer at `current` speaks: its own and the previous minor (N-1). */
export function inferenceRpcVersionsSpokenAt(current: InferenceRpcVersion): InferenceRpcVersion[] {
  return current.minor === 0
    ? [{ ...current }]
    : [{ ...current }, { major: current.major, minor: current.minor - 1 }];
}

function newest(versions: readonly InferenceRpcVersion[]): InferenceRpcVersion | undefined {
  return [...versions].sort(compareInferenceRpcVersions).at(-1);
}

/**
 * The rolling-upgrade window: the highest version both sides speak, as
 * long as their newest versions share a major and sit at most one minor
 * apart. Anything further apart is refused even when the lists overlap,
 * so the window never stretches past N-1. Null means incompatible.
 */
export function selectInferenceRpcVersion(
  offered: readonly InferenceRpcVersion[],
  supported: readonly InferenceRpcVersion[],
): InferenceRpcVersion | null {
  const callerNewest = newest(offered);
  const workerNewest = newest(supported);
  if (callerNewest === undefined || workerNewest === undefined) return null;
  if (callerNewest.major !== workerNewest.major) return null;
  if (Math.abs(callerNewest.minor - workerNewest.minor) > 1) return null;
  const common = offered.filter((v) =>
    supported.some((s) => compareInferenceRpcVersions(s, v) === 0),
  );
  return newest(common) ?? null;
}
