import { describe, expect, it } from "bun:test";

import { ModelRunSchema } from "../../src/workload/schema.js";

function manifest(completionProbe?: unknown): unknown {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "granite-judge" },
    spec: {
      target: { kind: "rel", value: "granite-3b.gguf" },
      ...(completionProbe === undefined ? {} : { completionProbe }),
    },
  };
}

describe("ModelRunSpec.completionProbe", () => {
  it("is absent when not declared (opt-in)", () => {
    const parsed = ModelRunSchema.parse(manifest());
    expect(parsed.spec.completionProbe).toBeUndefined();
  });

  it("fills defaults when enabled with no other fields", () => {
    const parsed = ModelRunSchema.parse(manifest({ enabled: true }));
    expect(parsed.spec.completionProbe).toEqual({
      enabled: true,
      path: "/v1/chat/completions",
      prompt: "ping",
      maxTokens: 1,
      timeoutSeconds: 20,
      everyNTicks: 4,
    });
  });

  it("defaults enabled to false when the block is present but enabled is omitted", () => {
    const parsed = ModelRunSchema.parse(manifest({ prompt: "are you alive?" }));
    expect(parsed.spec.completionProbe?.enabled).toBe(false);
    expect(parsed.spec.completionProbe?.prompt).toBe("are you alive?");
  });

  it("preserves explicit overrides including model", () => {
    const parsed = ModelRunSchema.parse(
      manifest({ enabled: true, model: "granite-3b", everyNTicks: 8, timeoutSeconds: 30 }),
    );
    expect(parsed.spec.completionProbe?.model).toBe("granite-3b");
    expect(parsed.spec.completionProbe?.everyNTicks).toBe(8);
    expect(parsed.spec.completionProbe?.timeoutSeconds).toBe(30);
  });

  it("caps timeoutSeconds at 30 so a stalled probe cannot block the tick", () => {
    expect(
      ModelRunSchema.parse(manifest({ enabled: true, timeoutSeconds: 30 })).spec.completionProbe
        ?.timeoutSeconds,
    ).toBe(30);
    expect(() => ModelRunSchema.parse(manifest({ enabled: true, timeoutSeconds: 31 }))).toThrow();
  });

  it("rejects out-of-range maxTokens", () => {
    expect(() => ModelRunSchema.parse(manifest({ enabled: true, maxTokens: 200 }))).toThrow();
  });
});
