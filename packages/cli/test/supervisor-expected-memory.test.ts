import { describe, expect, test } from "bun:test";

import type { ModelHostManifest } from "../../remote/src/workload/modelhost-schema.js";

import { resolveWorkloadTargetsAtStartup } from "../src/commands/supervisor.js";

function modelHost(expectedMemoryGiB: number | undefined): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: {
      name: "demo",
      labels: {},
    },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: "/tmp/omlx",
      endpoint: { host: "127.0.0.1", port: 8088 },
      hostedModels: [{ rel: "demo.gguf" }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      ...(expectedMemoryGiB !== undefined ? { resources: { expectedMemoryGiB } } : {}),
    },
  };
}

describe("supervisor expectedMemoryMb startup wiring", () => {
  test("ModelHost target with declared expectedMemoryGiB gets expectedMemoryMb=GiB*1024", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "demo", endpoint: "http://127.0.0.1:8088", kind: "ModelHost" }],
      {},
      {
        loadWorkloadByNameAny: () => modelHost(20),
      },
    );
    expect(out[0]?.expectedMemoryMb).toBe(20 * 1024);
  });

  test("ModelHost target without declared expectedMemoryGiB leaves expectedMemoryMb undefined", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "demo", endpoint: "http://127.0.0.1:8088", kind: "ModelHost" }],
      {},
      {
        loadWorkloadByNameAny: () => modelHost(undefined),
      },
    );
    expect(out[0]?.expectedMemoryMb).toBeUndefined();
  });

  test("manifest load failure does not crash startup; expectedMemoryMb stays undefined", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "missing", endpoint: "http://127.0.0.1:8088", kind: "ModelHost" }],
      {},
      {
        loadWorkloadByNameAny: () => {
          throw new Error("workload manifest not found: missing");
        },
        warn: () => undefined,
      },
    );
    expect(out[0]?.expectedMemoryMb).toBeUndefined();
  });

  test("ModelRun target is left unchanged (expectedMemoryMb stays undefined)", () => {
    const out = resolveWorkloadTargetsAtStartup(
      [{ name: "demo", endpoint: "http://127.0.0.1:8088", kind: "ModelRun" }],
      {},
      {
        loadWorkloadByNameAny: () => modelHost(20),
        loadWorkloadByName: (): never => {
          throw new Error("not used");
        },
      },
    );
    expect(out[0]?.expectedMemoryMb).toBeUndefined();
  });
});
