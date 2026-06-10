import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listModelHosts } from "../../src/workload/modelhost-store.js";
import { listNodeRuns } from "../../src/workload/noderun-store.js";
import { listWorkloads } from "../../src/workload/store.js";

describe("kind-aware workload listing", () => {
  test("shared directory can mix ModelRun, ModelHost, and NodeRun files", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-kind-filter-"));
    try {
      writeFileSync(
        join(dir, "run.yaml"),
        "apiVersion: llamactl/v1\nkind: ModelRun\nmetadata:\n  name: run\nspec:\n  node: local\n  enabled: true\n  target:\n    kind: rel\n    value: x\n  extraArgs: []\n  workers: []\n  restartPolicy: Always\n  timeoutSeconds: 60\n  gateway: false\n  allowExternalBind: false\n",
      );
      writeFileSync(
        join(dir, "host.yaml"),
        "apiVersion: llamactl/v1\nkind: ModelHost\nmetadata:\n  name: host\nspec:\n  engine: omlx\n  node: local\n  enabled: true\n  binary: /tmp/omlx\n  endpoint:\n    host: 127.0.0.1\n    port: 8094\n  hostedModels:\n    - rel: mlx-community/Qwen3-8B-MLX-4bit\n  extraArgs: []\n  restartPolicy: Always\n  timeoutSeconds: 60\n",
      );
      writeFileSync(
        join(dir, "node.yaml"),
        "apiVersion: llamactl/v1\nkind: NodeRun\nmetadata:\n  name: node\nspec:\n  node: local\n  infra: []\n",
      );
      expect(listWorkloads(dir).map((m) => m.metadata.name)).toEqual(["run"]);
      expect(listModelHosts(dir).map((m) => m.metadata.name)).toEqual(["host"]);
      expect(listNodeRuns(dir).map((m) => m.metadata.name)).toEqual(["node"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
