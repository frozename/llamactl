import { describe, expect, test } from "bun:test";

import type { ModelHostManifest } from "../../remote/src/workload/modelhost-schema.js";

import { resolveWorkloadTargetsAtStartup } from "../src/commands/supervisor.js";

type MemoryDeclaration = {
  expectedMemoryGiB?: number;
  residentGiB?: number;
  diskBackedGiB?: number;
};

function modelHost(resources: MemoryDeclaration | undefined): ModelHostManifest {
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
      ...(resources !== undefined ? { resources } : {}),
    },
  };
}

function expectedMemoryMbFor(resources: MemoryDeclaration | undefined): number | undefined {
  return resolveWorkloadTargetsAtStartup(
    [{ name: "demo", endpoint: "http://127.0.0.1:8088", kind: "ModelHost" }],
    {},
    {
      loadWorkloadByNameAny: () => modelHost(resources),
    },
  )[0]?.expectedMemoryMb;
}

describe("supervisor migration gate honours the shared declared-memory resolver", () => {
  test("residentGiB alone drives the gate (100 GiB → 102400 MiB)", () => {
    expect(expectedMemoryMbFor({ residentGiB: 100, diskBackedGiB: 103 })).toBe(100 * 1024);
  });

  test("expectedMemoryGiB alone still drives the gate", () => {
    expect(expectedMemoryMbFor({ expectedMemoryGiB: 20 })).toBe(20 * 1024);
  });

  test("the larger of residentGiB and expectedMemoryGiB is charged", () => {
    expect(expectedMemoryMbFor({ expectedMemoryGiB: 24, residentGiB: 10 })).toBe(24 * 1024);
    expect(expectedMemoryMbFor({ expectedMemoryGiB: 24, residentGiB: 30 })).toBe(30 * 1024);
  });

  test("resources with no memory declaration leaves expectedMemoryMb undefined", () => {
    expect(expectedMemoryMbFor({})).toBeUndefined();
    expect(expectedMemoryMbFor(undefined)).toBeUndefined();
  });
});
