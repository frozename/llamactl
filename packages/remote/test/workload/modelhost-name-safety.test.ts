import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as modelhostStore from "../../src/workload/modelhost-store.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import {
  deleteModelHost,
  loadModelHostByName,
  modelHostPath,
  saveModelHost,
} from "../../src/workload/modelhost-store.js";

const base = {
  apiVersion: "llamactl/v1",
  kind: "ModelHost",
  metadata: { name: "mlx-host-local" },
  spec: {
    engine: "omlx",
    node: "local",
    enabled: true,
    binary: "/tmp/omlx",
    endpoint: { host: "127.0.0.1", port: 8094 },
    hostedModels: [{ rel: "mlx-community/Qwen3-8B-MLX-4bit" }],
    extraArgs: [],
    timeoutSeconds: 60,
  },
} as const;

const invalidNames = [
  "../escape",
  "..",
  "foo/bar",
  ".hidden",
  "UPPERCASE",
  "mixed-Case",
  "trailing.",
  "name_with_underscore",
];

describe("ModelHost name safety", () => {
  test("schema rejects unsafe metadata.name values", () => {
    for (const name of invalidNames) {
      expect(() =>
        ModelHostManifestSchema.parse({
          ...base,
          metadata: { name },
        }),
      ).toThrow();
    }
  });

  test("store rejects crafted names that would escape the workloads dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-name-safety-"));
    try {
      const stub = spyOn(modelhostStore, "modelHostPath").mockReturnValue(
        join(dir, "..", "escape.yaml"),
      );
      try {
        expect(() => saveModelHost(base as never, dir)).toThrow(/escapes workloads dir/i);
        expect(() => loadModelHostByName("mlx-host-local", dir)).toThrow(/escapes workloads dir/i);
        expect(() => deleteModelHost("mlx-host-local", dir)).toThrow(/escapes workloads dir/i);
      } finally {
        stub.mockRestore();
      }
      expect(modelHostPath("../escape", dir)).toBe(join(dir, "../escape.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("round-trips a valid name", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-roundtrip-"));
    try {
      const path = saveModelHost(base as never, dir);
      expect(path).toBe(join(dir, "mlx-host-local.yaml"));
      writeFileSync(path, "\n", { flag: "a" });
      const loaded = loadModelHostByName("mlx-host-local", dir);
      expect(loaded.metadata.name).toBe("mlx-host-local");
      expect(deleteModelHost("mlx-host-local", dir)).toBe(true);
      expect(deleteModelHost("mlx-host-local", dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
