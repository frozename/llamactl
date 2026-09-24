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

export class InferenceEnvelopeError extends Error {
  readonly code: "invalid-envelope" | "native-body-too-deep";

  constructor(code: "invalid-envelope" | "native-body-too-deep", message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "InferenceEnvelopeError";
    this.code = code;
  }
}

/**
 * Deepest nativeBody nesting the envelope accepts. Real request bodies
 * (message arrays, tool schemas, base64 payloads) stay far below this; a
 * deeper graph is a hostile or malformed input and rejects with a typed
 * error instead of blowing the stack mid-clone.
 */
export const ENVELOPE_BODY_MAX_DEPTH = 128;

// Clone first, then freeze: the caller's own nested objects must stay
// mutable. The walk is iterative so depth is bounded by the explicit
// budget, never by the call stack.
interface CloneFrame {
  src: object;
  dst: object;
  depth: number;
}

function cloneContainerFor(src: object): object {
  return Array.isArray(src) ? [] : {};
}

function assignClonedChild(
  dst: object,
  key: string,
  child: unknown,
  depth: number,
  seen: Map<object, object>,
  stack: CloneFrame[],
): void {
  const slot = dst as Record<string, unknown>;
  if (child === null || typeof child !== "object") {
    slot[key] = child;
    return;
  }
  const existing = seen.get(child);
  if (existing !== undefined) {
    slot[key] = existing;
    return;
  }
  const clone = cloneContainerFor(child);
  seen.set(child, clone);
  slot[key] = clone;
  stack.push({ src: child, dst: clone, depth: depth + 1 });
}

function cloneFreezeBounded(value: Record<string, unknown>): Record<string, unknown> {
  const root = cloneContainerFor(value) as Record<string, unknown>;
  const seen = new Map<object, object>([[value, root]]);
  const stack: CloneFrame[] = [{ src: value, dst: root, depth: 0 }];
  for (let frame = stack.pop(); frame !== undefined; frame = stack.pop()) {
    if (frame.depth > ENVELOPE_BODY_MAX_DEPTH) {
      throw new InferenceEnvelopeError(
        "native-body-too-deep",
        `nativeBody exceeds the maximum depth of ${String(ENVELOPE_BODY_MAX_DEPTH)}`,
      );
    }
    const entries = Object.entries(frame.src) as [string, unknown][];
    for (const [key, child] of entries) {
      assignClonedChild(frame.dst, key, child, frame.depth, seen, stack);
    }
  }
  for (const node of seen.values()) Object.freeze(node);
  return root;
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
  nativeBody: z.record(z.string(), z.unknown()).transform(cloneFreezeBounded),
  headerFingerprint: HeaderFingerprintV1Schema,
  cachePolicy: CachePolicyV1Schema.default({ exact: "default", semantic: "off" }),
  normalized: UnifiedAiRequestSchema.optional(),
  internal: InternalSelectionV1Schema.optional(),
});
export type InferenceEnvelopeV1 = z.infer<typeof InferenceEnvelopeV1Schema>;

export function parseInferenceEnvelope(input: unknown): InferenceEnvelopeV1 {
  try {
    return InferenceEnvelopeV1Schema.parse(input);
  } catch (error) {
    if (error instanceof InferenceEnvelopeError) throw error;
    throw new InferenceEnvelopeError(
      "invalid-envelope",
      error instanceof Error ? error.message : "inference envelope rejected",
      error,
    );
  }
}
