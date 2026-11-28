// #519: listInvalidNodeRuns reports NodeRun-shaped manifests that fail schema
// validation instead of silently dropping them the way listNodeRuns must. At
// the pinned base the export does not exist, so the LI cases fail BY ASSERTION
// on the structural probe — never by an import or type error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun } from "../../src/workload/noderun-schema.js";

import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import * as store from "../../src/workload/noderun-store.js";

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-noderun-store-invalid-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(tmp, "operations.sqlite"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  tmp = "";
});

type InvalidNodeRunEntry = {
  file: string;
  name: string | null;
  node: string | null;
  error: string;
};
type ListInvalidNodeRuns = (dir?: string) => InvalidNodeRunEntry[];

function listInvalidNodeRuns(dir: string): InvalidNodeRunEntry[] {
  const fn = (store as Record<string, unknown>)["listInvalidNodeRuns"];
  expect(typeof fn).toBe("function");
  if (typeof fn !== "function") return [];
  return (fn as ListInvalidNodeRuns)(dir);
}

function writeFixture(file: string, text: string): void {
  writeFileSync(join(tmp, file), text, "utf8");
}

function validNodeRun(): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: "gpu1", labels: {} },
    spec: {
      node: "gpu1",
      infra: [],
      residency: { minResidencySeconds: 60 },
    },
  };
}

const INVALID_MIN_RESIDENCY_YAML = `apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: gpu1
spec:
  node: gpu1
  residency:
    minResidencySecs: 60
`;

const INVALID_MARGIN_YAML = `apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: gpu1
spec:
  node: gpu1
  residency:
    safetyMarginRatio: 1.5
`;

describe("listInvalidNodeRuns (#519)", () => {
  test("LI1: an invalid residency key is reported with file, name, node and path detail", () => {
    writeFixture("gpu1.yaml", INVALID_MIN_RESIDENCY_YAML);

    const entries = listInvalidNodeRuns(tmp);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ file: "gpu1.yaml", name: "gpu1", node: "gpu1" });
    expect(entries[0]?.error).toContain("spec.residency");
    expect(entries[0]?.error).toContain("minResidencySecs");
  });

  test("LI2: an out-of-range safetyMarginRatio names its full spec path", () => {
    writeFixture("bad-margin.yaml", INVALID_MARGIN_YAML);

    const entries = listInvalidNodeRuns(tmp);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.error).toContain("spec.residency.safetyMarginRatio");
  });

  test("LI3: valid NodeRuns, other kinds, unparseable YAML and non-yaml files are not listed", () => {
    store.saveNodeRun(validNodeRun(), tmp);
    writeFixture(
      "modelrun.yaml",
      `apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: some-model
spec:
  node: gpu1
`,
    );
    writeFixture("malformed.yaml", "apiVersion: [\n");
    writeFixture("not-yaml.txt", INVALID_MIN_RESIDENCY_YAML);
    writeFixture("invalid.yaml", INVALID_MIN_RESIDENCY_YAML);

    const entries = listInvalidNodeRuns(tmp);

    expect(entries.map((entry) => entry.file)).toEqual(["invalid.yaml"]);
  });

  test("LI4: entries sort by file and non-string name or node values become null", () => {
    writeFixture(
      "z.yaml",
      `apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: aaa
spec:
  node: aaa
  residency:
    safetyMarginRatio: 1.5
`,
    );
    writeFixture(
      "a.yaml",
      `apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: 7
spec:
  node: 7
  residency:
    safetyMarginRatio: 1.5
`,
    );

    const entries = listInvalidNodeRuns(tmp);

    expect(entries.map((entry) => entry.file)).toEqual(["a.yaml", "z.yaml"]);
    expect(entries[0]).toMatchObject({ name: null, node: null });
    expect(entries[1]).toMatchObject({ name: "aaa", node: "aaa" });
  });

  test("LI5: listNodeRuns still omits the invalid file and returns the valid one", () => {
    store.saveNodeRun(validNodeRun(), tmp);
    writeFixture("invalid.yaml", INVALID_MIN_RESIDENCY_YAML);

    const rows = store.listNodeRuns(tmp);

    expect(rows.map((row) => row.metadata.name)).toEqual(["gpu1"]);
  });

  test("LI6: a missing directory returns an empty list", () => {
    expect(listInvalidNodeRuns(join(tmp, "missing"))).toEqual([]);
  });
});
