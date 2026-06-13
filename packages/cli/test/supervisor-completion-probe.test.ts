import { describe, expect, test } from "bun:test";

import type { ModelRun } from "../../remote/src/workload/schema.js";

import {
  resolveCompletionProbe,
  resolveWorkloadTargetsAtStartup,
} from "../src/commands/supervisor.js";

type CompletionProbeSpec = NonNullable<ModelRun["spec"]["completionProbe"]>;

function modelRun(completionProbe?: Partial<CompletionProbeSpec> & { enabled: boolean }): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "granite-judge", labels: {}, annotations: {} },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "granite-3b.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
      ...(completionProbe
        ? {
            completionProbe: {
              path: "/v1/chat/completions",
              prompt: "ping",
              maxTokens: 1,
              timeoutSeconds: 20,
              everyNTicks: 4,
              ...completionProbe,
            },
          }
        : {}),
    },
  };
}

describe("resolveCompletionProbe", () => {
  test("enabled probe maps to a supervisor config with seconds→ms", () => {
    const out = resolveCompletionProbe("granite-judge", {
      loadWorkloadByName: () =>
        modelRun({ enabled: true, model: "granite-3b", timeoutSeconds: 30 }),
    });
    expect(out).toEqual({
      path: "/v1/chat/completions",
      prompt: "ping",
      maxTokens: 1,
      timeoutMs: 30000,
      everyNTicks: 4,
      model: "granite-3b",
    });
  });

  test("omits model when unset", () => {
    const out = resolveCompletionProbe("granite-judge", {
      loadWorkloadByName: () => modelRun({ enabled: true }),
    });
    expect(out).not.toBeNull();
    expect(out && "model" in out).toBe(false);
    expect(out?.timeoutMs).toBe(20000);
  });

  test("returns undefined when disabled", () => {
    const out = resolveCompletionProbe("granite-judge", {
      loadWorkloadByName: () => modelRun({ enabled: false }),
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined when the probe block is absent", () => {
    const out = resolveCompletionProbe("granite-judge", {
      loadWorkloadByName: () => modelRun(),
    });
    expect(out).toBeUndefined();
  });

  test("returns undefined when the manifest cannot be read", () => {
    const out = resolveCompletionProbe("missing", {
      loadWorkloadByName: () => {
        throw new Error("workload manifest not found: missing");
      },
    });
    expect(out).toBeUndefined();
  });
});

describe("resolveWorkloadTargetsAtStartup attaches the completion probe", () => {
  test("an enabled probe rides onto the workload target", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "granite-judge", endpoint: "http://127.0.0.1:8086", kind: "ModelRun" }],
      {},
      { loadWorkloadByName: () => modelRun({ enabled: true }) },
    );
    expect(out[0]?.completionProbe?.everyNTicks).toBe(4);
    expect(out[0]?.completionProbe?.timeoutMs).toBe(20000);
    expect(out[0]?.endpoint).toBe("http://127.0.0.1:8086");
  });

  test("no probe block leaves the target without completionProbe", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "granite-judge", endpoint: "http://127.0.0.1:8086", kind: "ModelRun" }],
      {},
      { loadWorkloadByName: () => modelRun() },
    );
    expect(out[0]?.completionProbe).toBeUndefined();
  });

  test("a ModelHost target never attempts the ModelRun-only probe load", () => {
    let probeLoads = 0;
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "mlx-host", endpoint: "http://127.0.0.1:8088", kind: "ModelHost" }],
      {},
      {
        // proxy resolution uses loadWorkloadByNameAny; the probe loader below must stay untouched
        loadWorkloadByNameAny: () => ({ spec: {} }),
        loadWorkloadByName: () => {
          probeLoads++;
          return modelRun({ enabled: true });
        },
      },
    );
    expect(out[0]?.completionProbe).toBeUndefined();
    expect(probeLoads).toBe(0);
  });
});
