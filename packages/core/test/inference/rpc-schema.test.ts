/**
 * P4.1 — InferenceRpcV1 schema bounds: the negotiation window's version
 * and feature caps, the cancel union's id bound, strict acceptedAt
 * offsets, the nullable deploymentEpoch fence, and major-first version
 * ordering. Pure zod parsing — no I/O.
 */
import { describe, expect, test } from "bun:test";

import {
  compareInferenceRpcVersions,
  INFERENCE_RPC_FEATURES,
  INFERENCE_RPC_MAX_DEADLINE_MS,
  INFERENCE_RPC_MAX_HOPS,
  INFERENCE_RPC_MAX_VISITED_NODES,
  INFERENCE_RPC_VERSION,
  InferenceRpcCancelRequestV1Schema,
  InferenceRpcCancelResultV1Schema,
  InferenceRpcDeploymentV1Schema,
  InferenceRpcFeatureSchema,
  InferenceRpcNegotiateRequestV1Schema,
  InferenceRpcNegotiateResultV1Schema,
  InferenceRpcOperationSchema,
  InferenceRpcStatusRequestV1Schema,
  InferenceRpcStatusResultV1Schema,
  InferenceRpcStreamRequestV1Schema,
  InferenceRpcSubmitRequestV1Schema,
  InferenceRpcSubmitResultV1Schema,
  InferenceRpcVersionSchema,
} from "../../src/inference/rpc-schema.js";

describe("inference RPC constants", () => {
  test("INFERENCE_RPC_VERSION is the frozen 1.0 this build speaks", () => {
    expect(INFERENCE_RPC_VERSION).toEqual({ major: 1, minor: 0 });
    expect(Object.isFrozen(INFERENCE_RPC_VERSION)).toBe(true);
  });

  test("INFERENCE_RPC_FEATURES is the frozen 1.x feature list", () => {
    expect(INFERENCE_RPC_FEATURES).toEqual(["attempt-status", "cancel-ack", "execution-event-v1"]);
    expect(Object.isFrozen(INFERENCE_RPC_FEATURES)).toBe(true);
  });

  test("deadline, hop and visited-node bounds are pinned", () => {
    expect(INFERENCE_RPC_MAX_DEADLINE_MS).toBe(900000);
    expect(INFERENCE_RPC_MAX_HOPS).toBe(1);
    expect(INFERENCE_RPC_MAX_VISITED_NODES).toBe(8);
  });

  test("the operation enum lists the six RPC operations", () => {
    expect(InferenceRpcOperationSchema.options).toEqual([
      "negotiate",
      "catalog",
      "submit",
      "stream",
      "status",
      "cancel",
    ]);
  });
});

describe("InferenceRpcVersionSchema", () => {
  test("accepts major 1 minor 0", () => {
    expect(InferenceRpcVersionSchema.safeParse({ major: 1, minor: 0 }).success).toBe(true);
    expect(InferenceRpcVersionSchema.parse({ major: 1, minor: 0 })).toEqual({
      major: 1,
      minor: 0,
    });
  });

  test("rejects major 0", () => {
    expect(InferenceRpcVersionSchema.safeParse({ major: 0, minor: 0 }).success).toBe(false);
  });

  test("rejects minor -1 and minor 0.5", () => {
    expect(InferenceRpcVersionSchema.safeParse({ major: 1, minor: -1 }).success).toBe(false);
    expect(InferenceRpcVersionSchema.safeParse({ major: 1, minor: 0.5 }).success).toBe(false);
  });
});

describe("InferenceRpcNegotiateRequestV1Schema", () => {
  test("defaults requiredFeatures and optionalFeatures to empty lists", () => {
    expect(
      InferenceRpcNegotiateRequestV1Schema.parse({ versions: [{ major: 1, minor: 0 }] }),
    ).toEqual({
      versions: [{ major: 1, minor: 0 }],
      requiredFeatures: [],
      optionalFeatures: [],
    });
  });

  test("rejects an empty versions list", () => {
    expect(InferenceRpcNegotiateRequestV1Schema.safeParse({ versions: [] }).success).toBe(false);
  });

  test("accepts eight offered versions and rejects nine", () => {
    expect(
      InferenceRpcNegotiateRequestV1Schema.safeParse({
        versions: Array.from({ length: 8 }, () => ({ major: 1, minor: 0 })),
      }).success,
    ).toBe(true);
    expect(
      InferenceRpcNegotiateRequestV1Schema.safeParse({
        versions: Array.from({ length: 9 }, () => ({ major: 1, minor: 0 })),
      }).success,
    ).toBe(false);
  });

  test("rejects more than 32 required features", () => {
    expect(
      InferenceRpcNegotiateRequestV1Schema.safeParse({
        versions: [{ major: 1, minor: 0 }],
        requiredFeatures: Array.from({ length: 33 }, (_, i) => `feat-${String(i)}`),
      }).success,
    ).toBe(false);
  });
});

describe("InferenceRpcFeatureSchema", () => {
  test("accepts a 64-character feature name", () => {
    expect(InferenceRpcFeatureSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(InferenceRpcFeatureSchema.parse("a".repeat(64))).toBe("a".repeat(64));
  });

  test("rejects a 65-character name and the empty string", () => {
    expect(InferenceRpcFeatureSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(InferenceRpcFeatureSchema.safeParse("").success).toBe(false);
  });
});

describe("InferenceRpcCancelRequestV1Schema", () => {
  test("parses a cancelId request unchanged", () => {
    expect(InferenceRpcCancelRequestV1Schema.parse({ cancelId: "c" })).toEqual({
      cancelId: "c",
    });
  });

  test("bounds cancelId at 128 characters", () => {
    expect(InferenceRpcCancelRequestV1Schema.safeParse({ cancelId: "x".repeat(128) }).success).toBe(
      true,
    );
    expect(InferenceRpcCancelRequestV1Schema.safeParse({ cancelId: "x".repeat(129) }).success).toBe(
      false,
    );
  });

  test("rejects an empty object", () => {
    expect(InferenceRpcCancelRequestV1Schema.safeParse({}).success).toBe(false);
  });

  test("accepts an attemptId request", () => {
    expect(InferenceRpcCancelRequestV1Schema.safeParse({ attemptId: "a" }).success).toBe(true);
  });
});

describe("InferenceRpcSubmitResultV1Schema accepted outcome", () => {
  const accepted = {
    outcome: "accepted",
    requestId: "req-1",
    attemptId: "att-1",
    workerId: "worker-1",
    workerIncarnation: "inc-1",
    deploymentId: "dep-1",
    deploymentEpoch: "epoch-1",
    acceptedAt: "2026-10-19T12:00:00.000Z",
  } as const;

  test("accepts Z and numeric-offset acceptedAt timestamps", () => {
    expect(InferenceRpcSubmitResultV1Schema.safeParse(accepted).success).toBe(true);
    expect(InferenceRpcSubmitResultV1Schema.parse(accepted)).toEqual(accepted);
    expect(
      InferenceRpcSubmitResultV1Schema.safeParse({
        ...accepted,
        acceptedAt: "2026-10-19T12:00:00+02:00",
      }).success,
    ).toBe(true);
  });

  test("rejects acceptedAt without a timezone designator", () => {
    expect(
      InferenceRpcSubmitResultV1Schema.safeParse({
        ...accepted,
        acceptedAt: "2026-10-19T12:00:00",
      }).success,
    ).toBe(false);
    expect(
      InferenceRpcSubmitResultV1Schema.safeParse({
        ...accepted,
        acceptedAt: "2026-10-19 12:00",
      }).success,
    ).toBe(false);
  });
});

describe("InferenceRpcDeploymentV1Schema", () => {
  const deployment = {
    deploymentId: "d",
    model: "m",
    publicModelIds: [],
    backendKind: "local-model",
    availability: "available",
  };

  test("accepts a null deploymentEpoch", () => {
    expect(
      InferenceRpcDeploymentV1Schema.safeParse({ ...deployment, deploymentEpoch: null }).success,
    ).toBe(true);
  });

  test("rejects a missing deploymentEpoch", () => {
    expect(InferenceRpcDeploymentV1Schema.safeParse(deployment).success).toBe(false);
  });

  test("rejects an empty deploymentEpoch", () => {
    expect(
      InferenceRpcDeploymentV1Schema.safeParse({ ...deployment, deploymentEpoch: "" }).success,
    ).toBe(false);
  });
});

describe("InferenceRpcCancelResultV1Schema", () => {
  test("accepts a rejection with a known code", () => {
    const result = {
      outcome: "rejected",
      rejection: { code: "overloaded", message: "m" },
    } as const;
    expect(InferenceRpcCancelResultV1Schema.safeParse(result).success).toBe(true);
    expect(InferenceRpcCancelResultV1Schema.parse(result)).toEqual(result);
  });

  test("rejects an unknown rejection code", () => {
    expect(
      InferenceRpcCancelResultV1Schema.safeParse({
        outcome: "rejected",
        rejection: { code: "nope", message: "m" },
      }).success,
    ).toBe(false);
  });

  test("accepts the unknown outcome", () => {
    expect(InferenceRpcCancelResultV1Schema.safeParse({ outcome: "unknown" }).success).toBe(true);
  });
});

describe("InferenceRpcNegotiateResultV1Schema", () => {
  test("not-advertised strips worker identity fields", () => {
    expect(
      InferenceRpcNegotiateResultV1Schema.parse({
        outcome: "not-advertised",
        workerId: "w",
      }),
    ).toEqual({ outcome: "not-advertised" });
  });
});

describe("InferenceRpcStatusResultV1Schema", () => {
  test("parses a status outcome unchanged", () => {
    const status = { outcome: "status", attemptId: "a", state: "unknown" } as const;
    expect(InferenceRpcStatusResultV1Schema.safeParse(status).success).toBe(true);
    expect(InferenceRpcStatusResultV1Schema.parse(status)).toEqual(status);
  });

  test("rejects a negative terminalSequence", () => {
    expect(
      InferenceRpcStatusResultV1Schema.safeParse({
        outcome: "status",
        attemptId: "a",
        state: "unknown",
        terminalSequence: -1,
      }).success,
    ).toBe(false);
  });
});

describe("compareInferenceRpcVersions", () => {
  test("orders by major before minor", () => {
    expect(
      compareInferenceRpcVersions({ major: 1, minor: 5 }, { major: 2, minor: 0 }),
    ).toBeLessThan(0);
    expect(
      compareInferenceRpcVersions({ major: 2, minor: 0 }, { major: 1, minor: 9 }),
    ).toBeGreaterThan(0);
  });

  test("compares minors within the same major", () => {
    expect(compareInferenceRpcVersions({ major: 1, minor: 3 }, { major: 1, minor: 1 })).toBe(2);
    expect(compareInferenceRpcVersions({ major: 1, minor: 1 }, { major: 1, minor: 1 })).toBe(0);
  });
});

describe("InferenceRpcV1 id bounds", () => {
  const envelope = {
    requestId: "req-1",
    attemptId: "att-1",
    deadline: 1_900_000_000_000,
    tenantId: "tenant-a",
    projectId: "proj-1",
    credentialScopeId: "cred-scope-1",
    operation: "generate",
    ingressProtocol: "openai-chat",
    publicModelId: "m",
    features: {
      operation: "generate",
      protocol: "openai-chat",
      stream: true,
      modalities: ["text"],
      tools: false,
      structuredOutput: false,
      session: false,
      cancellation: true,
    },
    stream: true,
    nativeBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
    headerFingerprint: { allowlist: ["content-type"], fingerprint: "fp-1" },
  };

  const submit = {
    version: { major: 1, minor: 0 },
    envelope,
    target: {
      deploymentId: "dep-1",
      expectedDeploymentEpoch: "ep-1",
      catalogGeneration: "gen-1",
      workerIncarnation: "inc-1",
    },
    cancelId: "c-1",
  };

  test("rejects a submit envelope attemptId over 128 characters", () => {
    const req = { ...submit, envelope: { ...envelope, attemptId: "a".repeat(129) } };
    expect(InferenceRpcSubmitRequestV1Schema.safeParse(req).success).toBe(false);
  });

  test("rejects a submit envelope requestId over 128 characters", () => {
    const req = { ...submit, envelope: { ...envelope, requestId: "r".repeat(129) } };
    expect(InferenceRpcSubmitRequestV1Schema.safeParse(req).success).toBe(false);
  });

  test("status rejects an attemptId over 128 characters", () => {
    expect(
      InferenceRpcStatusRequestV1Schema.safeParse({ attemptId: "a".repeat(129) }).success,
    ).toBe(false);
  });

  test("stream rejects an attemptId over 128 characters", () => {
    expect(
      InferenceRpcStreamRequestV1Schema.safeParse({ attemptId: "a".repeat(129) }).success,
    ).toBe(false);
  });

  test("cancel rejects an attemptId over 128 characters", () => {
    expect(
      InferenceRpcCancelRequestV1Schema.safeParse({ attemptId: "a".repeat(129) }).success,
    ).toBe(false);
  });

  test("accepts a submit with 128-character attemptId and requestId", () => {
    const req = {
      ...submit,
      envelope: { ...envelope, attemptId: "a".repeat(128), requestId: "r".repeat(128) },
    };
    expect(InferenceRpcSubmitRequestV1Schema.safeParse(req).success).toBe(true);
  });

  test("accepts proxy-shaped attemptId and requestId", () => {
    const req = {
      ...submit,
      envelope: {
        ...envelope,
        attemptId: `att-${crypto.randomUUID()}`,
        requestId: `req-${crypto.randomUUID()}`,
      },
    };
    expect(InferenceRpcSubmitRequestV1Schema.safeParse(req).success).toBe(true);
  });

  test("status, stream and cancel accept a 128-character attemptId", () => {
    const attemptId = "a".repeat(128);
    expect(InferenceRpcStatusRequestV1Schema.safeParse({ attemptId }).success).toBe(true);
    expect(InferenceRpcStreamRequestV1Schema.safeParse({ attemptId }).success).toBe(true);
    expect(InferenceRpcCancelRequestV1Schema.safeParse({ attemptId }).success).toBe(true);
  });

  test("the parsed submit keeps nativeBody deep-frozen", () => {
    const parsed = InferenceRpcSubmitRequestV1Schema.parse(submit);
    const body = parsed.envelope.nativeBody;
    expect(Object.isFrozen(body)).toBe(true);
    const messages = body["messages"];
    expect(Object.isFrozen(messages)).toBe(true);
    expect(Object.isFrozen((messages as unknown[])[0])).toBe(true);
  });
});
