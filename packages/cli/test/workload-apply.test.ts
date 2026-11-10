import type { workloadSchema } from "@llamactl/remote";

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runApply, stampApplyAnnotations } from "../src/commands/workload.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { captureProcessStreams } from "./helpers.js";

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

describe("apply flag validation", () => {
  test("--evict/--force are rejected for ModelHost manifests instead of dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-apply-hostflags-"));
    try {
      const manifestPath = join(dir, "host.yaml");
      writeFileSync(
        manifestPath,
        [
          "apiVersion: llamactl/v1",
          "kind: ModelHost",
          "metadata:",
          "  name: mlx-host",
          "spec:",
          "  engine: omlx",
          "  node: local",
          "  enabled: true",
          "  binary: /bin/true",
          "  endpoint:",
          "    host: 127.0.0.1",
          "    port: 8094",
          "  hostedModels:",
          "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
          "  extraArgs: []",
          "  timeoutSeconds: 60",
          "",
        ].join("\n"),
      );
      for (const extra of [["--evict", "victim"], ["--force"], ["--evict", "victim", "--force"]]) {
        const { result: code, stderr } = await captureProcessStreams(() =>
          runApply(["-f", manifestPath, ...extra]),
        );
        expect(code).toBe(1);
        expect(stderr).toContain("not supported for ModelHost");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
