import { describe, expect, test } from "bun:test";

import { serviceTokenSubjectOf } from "../src/server/auth.js";

describe("serviceTokenSubjectOf", () => {
  test("submit with envelope.attemptId returns the attempt id", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { envelope: { attemptId: "att-1" } })).toBe(
      "att-1",
    );
  });

  test("submit with a long subject passes through unchanged", () => {
    const subject = "deploy/gpu-1/llama-3.1-70b";
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { envelope: { attemptId: subject } })).toBe(
      subject,
    );
  });

  test("cancel with attemptId returns it", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { attemptId: "att-2" })).toBe("att-2");
  });

  test("cancel with cancelId returns it", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { cancelId: "c-3" })).toBe("c-3");
  });

  test("cancel with both attemptId and cancelId prefers attemptId", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { attemptId: "a", cancelId: "c" })).toBe(
      "a",
    );
  });

  test("submit with a non-string envelope.attemptId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { envelope: { attemptId: 42 } })).toBe(
      undefined,
    );
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { envelope: { attemptId: {} } })).toBe(
      undefined,
    );
  });

  test("cancel with a non-string attemptId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { attemptId: 42 })).toBe(undefined);
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { attemptId: {} })).toBe(undefined);
  });

  test("cancel with a non-string cancelId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { cancelId: 42 })).toBe(undefined);
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", { cancelId: {} })).toBe(undefined);
  });

  test("status and stream with a non-string attemptId return undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.status", { attemptId: 42 })).toBe(undefined);
    expect(serviceTokenSubjectOf("inferenceRpc.status", { attemptId: {} })).toBe(undefined);
    expect(serviceTokenSubjectOf("inferenceRpc.stream", { attemptId: 42 })).toBe(undefined);
    expect(serviceTokenSubjectOf("inferenceRpc.stream", { attemptId: {} })).toBe(undefined);
  });

  test("status with attemptId returns it", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.status", { attemptId: "att-3" })).toBe("att-3");
  });

  test("stream with attemptId returns it", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.stream", { attemptId: "att-4" })).toBe("att-4");
  });

  test("negotiate returns undefined regardless of input", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.negotiate", { versions: [{ major: 1 }] })).toBe(
      undefined,
    );
  });

  test("catalog returns undefined regardless of input", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.catalog", {})).toBe(undefined);
  });

  test("submit with no envelope returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { other: "field" })).toBe(undefined);
  });

  test("submit with envelope but no attemptId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.submit", { envelope: {} })).toBe(undefined);
  });

  test("cancel with neither attemptId nor cancelId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.cancel", {})).toBe(undefined);
  });

  test("status with no attemptId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.status", {})).toBe(undefined);
  });

  test("stream with no attemptId returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.stream", {})).toBe(undefined);
  });

  test("an unknown method returns undefined", () => {
    expect(serviceTokenSubjectOf("inferenceRpc.unknown", { attemptId: "x" })).toBe(undefined);
  });

  test("non-record input returns undefined for any method", () => {
    for (const method of [
      "inferenceRpc.submit",
      "inferenceRpc.cancel",
      "inferenceRpc.status",
      "inferenceRpc.stream",
    ]) {
      expect(serviceTokenSubjectOf(method, "not-a-record")).toBe(undefined);
      expect(serviceTokenSubjectOf(method, 42)).toBe(undefined);
      expect(serviceTokenSubjectOf(method, null)).toBe(undefined);
      expect(serviceTokenSubjectOf(method, undefined)).toBe(undefined);
    }
  });
});
