/**
 * InferenceEnvelopeV1 — the unified router's request seam (P0.2, design §4.2).
 * Carries authenticated-context identity, the requested feature set and the
 * original validated native body (kept frozen so no hop mutates the caller's
 * bytes). Normalized chat payloads reuse @nova/contracts directly; this file
 * adds only the routing wrapper.
 */
import { UnifiedAiRequestSchema } from "@nova/contracts";
import { z } from "zod";

import {
  InferenceOperationSchema,
  IngressProtocolSchema,
  RequiredFeaturesSchema,
} from "../routing/capabilities.js";

export const TraceContextV1Schema = z.object({
  traceparent: z.string().min(1).optional(),
  tracestate: z.string().optional(),
});
export type TraceContextV1 = z.infer<typeof TraceContextV1Schema>;

export const SessionReferenceV1Schema = z.object({
  sessionId: z.string().min(1),
  ownerNodeId: z.string().min(1),
});
export type SessionReferenceV1 = z.infer<typeof SessionReferenceV1Schema>;

export const HeaderFingerprintV1Schema = z.object({
  allowlist: z.array(z.string().min(1)),
  fingerprint: z.string().min(1),
});
export type HeaderFingerprintV1 = z.infer<typeof HeaderFingerprintV1Schema>;

export const CachePolicyV1Schema = z.object({
  exact: z.enum(["default", "bypass", "refresh"]).default("default"),
  semantic: z.enum(["off", "read", "read-write"]).default("off"),
});
export type CachePolicyV1 = z.infer<typeof CachePolicyV1Schema>;

export const InternalSelectionV1Schema = z.object({
  deploymentId: z.string().min(1).optional(),
  expectedDeploymentEpoch: z.string().min(1).optional(),
  catalogVersion: z.string().min(1).optional(),
  membershipEpoch: z.string().min(1).optional(),
  hopCount: z.number().int().nonnegative().optional(),
  visitedNodes: z.array(z.string().min(1)).optional(),
});
export type InternalSelectionV1 = z.infer<typeof InternalSelectionV1Schema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export const InferenceEnvelopeV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  requestId: z.string().min(1),
  attemptId: z.string().min(1),
  deadline: z.number().int().positive(),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  credentialScopeId: z.string().min(1),
  traceContext: TraceContextV1Schema.optional(),
  operation: InferenceOperationSchema,
  ingressProtocol: IngressProtocolSchema,
  publicModelId: z.string().min(1),
  features: RequiredFeaturesSchema,
  stream: z.boolean(),
  session: SessionReferenceV1Schema.optional(),
  nativeBody: z.record(z.string(), z.unknown()).transform(deepFreeze),
  headerFingerprint: HeaderFingerprintV1Schema,
  cachePolicy: CachePolicyV1Schema.default({ exact: "default", semantic: "off" }),
  normalized: UnifiedAiRequestSchema.optional(),
  internal: InternalSelectionV1Schema.optional(),
});
export type InferenceEnvelopeV1 = z.infer<typeof InferenceEnvelopeV1Schema>;

export function parseInferenceEnvelope(input: unknown): InferenceEnvelopeV1 {
  return InferenceEnvelopeV1Schema.parse(input);
}
