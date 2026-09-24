/**
 * P0.2 (#130) — InferenceEnvelopeV1 contract.
 * Pins the seam fields the unified router needs: identity + deadline +
 * tenant scope, operation + ingress protocol, requested features, the
 * immutable native body, header fingerprint, cache policy and the
 * trusted-internal selection block.
 */
import { describe, expect, test } from "bun:test";

import {
  InferenceEnvelopeV1Schema,
  parseInferenceEnvelope,
} from "../../src/inference/contracts.js";

const base = {
  requestId: "req-1",
  attemptId: "att-1",
  deadline: 1_900_000_000_000,
  tenantId: "tenant-a",
  projectId: "proj-1",
  credentialScopeId: "cred-scope-1",
  operation: "generate",
  ingressProtocol: "openai-chat",
  publicModelId: "shared.gguf",
  features: {
    operation: "generate",
    protocol: "openai-chat",
    stream: false,
    modalities: ["text"],
    tools: false,
    structuredOutput: false,
    session: false,
    cancellation: true,
  },
  stream: false,
  nativeBody: { model: "shared.gguf", messages: [{ role: "user", content: "hi" }] },
  headerFingerprint: { allowlist: ["content-type"], fingerprint: "fp-abc" },
};

describe("InferenceEnvelopeV1", () => {
  test("a complete envelope parses with defaults applied", () => {
    const env = parseInferenceEnvelope(base);
    expect(env.schemaVersion).toBe(1);
    expect(env.requestId).toBe("req-1");
    expect(env.cachePolicy.exact).toBe("default");
    expect(env.cachePolicy.semantic).toBe("off");
    expect(env.nativeBody["model"]).toBe("shared.gguf");
  });

  test("empty identity fields reject", () => {
    for (const key of ["requestId", "attemptId", "tenantId", "credentialScopeId"]) {
      expect(InferenceEnvelopeV1Schema.safeParse({ ...base, [key]: "" }).success).toBe(false);
    }
  });

  test("unregistered operations and protocols reject", () => {
    expect(InferenceEnvelopeV1Schema.safeParse({ ...base, operation: "frobnicate" }).success).toBe(
      false,
    );
    expect(InferenceEnvelopeV1Schema.safeParse({ ...base, ingressProtocol: "grpc" }).success).toBe(
      false,
    );
    expect(
      InferenceEnvelopeV1Schema.safeParse({ ...base, operation: "count-tokens" }).success,
    ).toBe(true);
    expect(InferenceEnvelopeV1Schema.safeParse({ ...base, operation: "embed" }).success).toBe(true);
  });

  test("the native body is deeply frozen after parse", () => {
    const env = parseInferenceEnvelope(base);
    expect(Object.isFrozen(env.nativeBody)).toBe(true);
    const messages = env.nativeBody["messages"];
    expect(Object.isFrozen(messages)).toBe(true);
    expect(Object.isFrozen((messages as unknown[])[0])).toBe(true);
  });

  test("trusted-internal selection fields are optional and typed", () => {
    const env = parseInferenceEnvelope({
      ...base,
      internal: {
        deploymentId: "d1",
        expectedDeploymentEpoch: "epoch-7",
        catalogVersion: "cat-3",
        membershipEpoch: "mem-2",
        hopCount: 1,
        visitedNodes: ["n1", "n2"],
      },
    });
    expect(env.internal?.hopCount).toBe(1);
    expect(env.internal?.visitedNodes).toEqual(["n1", "n2"]);
    expect(
      InferenceEnvelopeV1Schema.safeParse({ ...base, internal: { hopCount: -1 } }).success,
    ).toBe(false);
    expect(
      InferenceEnvelopeV1Schema.safeParse({ ...base, internal: { hopCount: 0 } }).success,
    ).toBe(true);
  });

  test("a server-approved session reference is optional", () => {
    expect(parseInferenceEnvelope(base).session).toBeUndefined();
    const env = parseInferenceEnvelope({
      ...base,
      session: { sessionId: "sess-1", ownerNodeId: "node1" },
    });
    expect(env.session?.sessionId).toBe("sess-1");
  });

  test("trace context carries the caller's propagated identity", () => {
    const env = parseInferenceEnvelope({
      ...base,
      traceContext: { traceparent: "00-abc-def-01", tracestate: "k=v" },
    });
    expect(env.traceContext?.traceparent).toBe("00-abc-def-01");
  });

  test("a normalized conversation may ride alongside the native body", () => {
    const env = parseInferenceEnvelope({
      ...base,
      normalized: {
        model: "shared.gguf",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(env.normalized?.model).toBe("shared.gguf");
  });
});
