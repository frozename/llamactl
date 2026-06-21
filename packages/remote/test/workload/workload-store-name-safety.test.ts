import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelRun } from "../../src/workload/schema.js";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import * as workloadStore from "../../src/workload/store.js";
import {
  deleteWorkload,
  loadWorkloadByName,
  loadWorkloadByNameAny,
  saveWorkload,
  workloadPath,
} from "../../src/workload/store.js";

// Names with a leading "../" cause path.join to normalize them outside the dir.
// Names like ".." alone become "..yaml" (harmless filename) and "foo/bar" stays within
// the dir as a subdirectory path — those are schema-level rejections, not store escapes.
const traversalNames = ["../escape", "../../tmp/escape", "../etc/x"];

const validRun: ModelRun = {
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name: "safe-name", labels: {}, annotations: {} },
  spec: {
    node: "local",
    enabled: true,
    target: { kind: "rel", value: "acme/model.gguf" },
    extraArgs: [],
    workers: [],
    restartPolicy: "Always",
    timeoutSeconds: 60,
    gateway: false,
    allowExternalBind: false,
  },
};

describe("workload store name safety", () => {
  test("deleteWorkload rejects names that escape the workloads dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-workload-store-safety-"));
    try {
      for (const name of traversalNames) {
        expect(() => deleteWorkload(name, dir)).toThrow(/escapes workloads dir/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadWorkloadByNameAny rejects names that escape the workloads dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-workload-store-safety-"));
    try {
      for (const name of traversalNames) {
        expect(() => loadWorkloadByNameAny(name, dir)).toThrow(/escapes workloads dir/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadWorkloadByName rejects names that escape the workloads dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-workload-store-safety-"));
    try {
      for (const name of traversalNames) {
        expect(() => loadWorkloadByName(name, dir)).toThrow(/escapes workloads dir/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("store rejects crafted paths that would escape via spy", () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-workload-store-safety-spy-"));
    try {
      const stub = spyOn(workloadStore, "workloadPath").mockReturnValue(
        join(dir, "..", "escape.yaml"),
      );
      try {
        expect(() => deleteWorkload("safe-name", dir)).toThrow(/escapes workloads dir/i);
        expect(() => loadWorkloadByNameAny("safe-name", dir)).toThrow(/escapes workloads dir/i);
        expect(() => loadWorkloadByName("safe-name", dir)).toThrow(/escapes workloads dir/i);
        expect(() => saveWorkload(validRun, dir)).toThrow(/escapes workloads dir/i);
      } finally {
        stub.mockRestore();
      }
      // workloadPath itself is pass-through — containment is enforced at call sites
      expect(workloadPath("../escape", dir)).toBe(join(dir, "../escape.yaml"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
