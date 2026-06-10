import type { workloadSchema } from "@llamactl/remote";

import { describe, expect, test } from "bun:test";

import { stampApplyAnnotations } from "../src/commands/workload.js";

function makeManifest(): workloadSchema.ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name: "demo",
      labels: {},
      annotations: {},
    },
    spec: {
      node: "gpu1",
      enabled: true,
      target: { kind: "rel" as const, value: "fake/model.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always" as const,
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

describe("apply annotation stamping", () => {
  test("--evict collects repeatable values into the manifest annotation", () => {
    const manifest = makeManifest();

    stampApplyAnnotations(manifest, { evict: ["foo", "bar"], force: false });

    expect(manifest.metadata.annotations["llamactl.io/evict"]).toBe("foo,bar");
  });

  test("--force stamps force-admit=true on the manifest annotation", () => {
    const manifest = makeManifest();

    stampApplyAnnotations(manifest, { evict: [], force: true });

    expect(manifest.metadata.annotations["llamactl.io/force-admit"]).toBe("true");
  });
});
