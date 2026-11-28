// #519: residencyStatus surfaces NodeRun-shaped files that failed validation.
// They cannot be selected as a valid NodeRun, but the operator still needs the
// file name and schema error. At the pinned base the input and output fields do
// not exist, so the IN cases fail BY ASSERTION — never by an import or type
// error.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeRun } from "../../src/workload/noderun-schema.js";

import { buildResidencyStatus } from "../../src/residency/procedures.js";
import { openNodeManagedAdmission } from "../../src/residency/target-admission-policy.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";

const originalEnv = { ...process.env };
let tmp = "";
let storePath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-invalid-noderun-"));
  storePath = join(tmp, "operations.sqlite");
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
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

function buildStatus(options: { node: string; invalidNodeRuns?: InvalidNodeRunEntry[] }): unknown {
  return buildResidencyStatus({
    node: options.node,
    nodeRun: undefined,
    budgetGiB: 24,
    budgetSource: "computed",
    store: { path: storePath, present: false },
    servingNode: null,
    nowMs: 1_000_000,
    ...(options.invalidNodeRuns !== undefined ? { invalidNodeRuns: options.invalidNodeRuns } : {}),
  } as unknown as Parameters<typeof buildResidencyStatus>[0]);
}

function invalidNodeRunWarningsOf(built: unknown): string[] | undefined {
  return (built as { invalidNodeRunWarnings?: string[] }).invalidNodeRunWarnings;
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

describe("residencyStatus invalidNodeRunWarnings (#519)", () => {
  test("IN1: an invalid entry for the queried node becomes one warning", () => {
    const built = buildStatus({
      node: "gpu1",
      invalidNodeRuns: [
        {
          file: "gpu1.yaml",
          name: "gpu1",
          node: "gpu1",
          error: 'spec.residency: Unrecognized key: "minResidencySecs"',
        },
      ],
    });

    const warnings = invalidNodeRunWarningsOf(built);

    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toContain("gpu1.yaml");
    expect(warnings?.[0]).toContain("failed validation");
    expect(warnings?.[0]).toContain("minResidencySecs");
  });

  test("IN2: name, spec.node or file basename match the node; unrelated entries are excluded", () => {
    const built = buildStatus({
      node: "gpu1",
      invalidNodeRuns: [
        { file: "z-by-name.yaml", name: "gpu1", node: null, error: "ERR name" },
        { file: "a-by-node.yaml", name: null, node: "gpu1", error: "ERR node" },
        { file: "gpu1.yaml", name: null, node: null, error: "ERR file" },
        { file: "q-other.yaml", name: "other", node: "other", error: "ERR other" },
      ],
    });

    const warnings = invalidNodeRunWarningsOf(built);

    expect(warnings).toHaveLength(3);
    const joined = (warnings ?? []).join("\n");
    expect(joined).toContain("a-by-node.yaml");
    expect(joined).toContain("gpu1.yaml");
    expect(joined).toContain("z-by-name.yaml");
    expect(joined).not.toContain("q-other.yaml");
    expect(joined.indexOf("a-by-node.yaml")).toBeLessThan(joined.indexOf("gpu1.yaml"));
    expect(joined.indexOf("gpu1.yaml")).toBeLessThan(joined.indexOf("z-by-name.yaml"));
  });

  test("IN3: omitted or empty invalidNodeRuns omits the warnings field", () => {
    const absent = buildStatus({ node: "gpu1" });
    const empty = buildStatus({ node: "gpu1", invalidNodeRuns: [] });

    expect("invalidNodeRunWarnings" in (absent as object)).toBe(false);
    expect("invalidNodeRunWarnings" in (empty as object)).toBe(false);
  });

  test("IN4: the router reports an invalid persisted NodeRun without selecting it", async () => {
    writeFileSync(join(tmp, "gpu1.yaml"), INVALID_MIN_RESIDENCY_YAML, "utf8");

    const res = await router.createCaller({}).residencyStatus({ node: "gpu1" });

    expect(res.nodeRun.present).toBe(false);
    const warnings = invalidNodeRunWarningsOf(res);
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toContain("gpu1.yaml");
    expect(warnings?.[0]).toContain("minResidencySecs");
  });

  test("IN5: a valid persisted NodeRun yields no invalidNodeRunWarnings", async () => {
    saveNodeRun(validNodeRun(), tmp);

    const res = await router.createCaller({}).residencyStatus({ node: "gpu1" });

    expect(res.nodeRun.present).toBe(true);
    expect("invalidNodeRunWarnings" in res).toBe(false);
  });

  test("an owner alias reports both the canonical file and an alias-specific invalid file", async () => {
    process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
    writeFileSync(join(tmp, "gpu1.yaml"), INVALID_MIN_RESIDENCY_YAML, "utf8");
    writeFileSync(
      join(tmp, "alias-policy.yaml"),
      INVALID_MIN_RESIDENCY_YAML.replace("node: gpu1", "node: gpu1-lan"),
      "utf8",
    );
    const runtime = await openNodeManagedAdmission({
      nodeName: "gpu1",
      aliases: ["gpu1-lan"],
      workloadsDir: tmp,
      readCapacity: () => ({
        source: "linux-procfs",
        physicalBytes: 64 * 1024 ** 3,
        availableBytes: 48 * 1024 ** 3,
        scope: { kind: "host-physical" },
        pressure: "normal",
        swapUsedBytes: 0,
        observedAtMs: Date.now(),
      }),
    });
    try {
      expect(
        runtime.admission.preflightProfile?.({ victims: [], retained: [], replacements: [] }),
      ).toBe("ManagedCapacity: NodeBudgetUnknown");
      const caller = router.createCaller({ managedLaunchAdmission: runtime.admission });
      const status = await caller.residencyStatus({ node: "gpu1-lan" });
      expect(status).toMatchObject({ node: "gpu1-lan", managed: { budgetGiB: null } });
      const warnings = invalidNodeRunWarningsOf(status);
      expect(warnings).toHaveLength(2);
      expect(warnings?.[0]).toContain("alias-policy.yaml");
      expect(warnings?.[1]).toContain("gpu1.yaml");
    } finally {
      runtime.authority.close();
    }
  });

  test("a malformed policy warning reports unavailable declarations without promising admission defaults", () => {
    const status = buildStatus({
      node: "gpu1",
      invalidNodeRuns: [{ file: "gpu1.yaml", name: "gpu1", node: "gpu1", error: "bad policy" }],
    });
    const warning = invalidNodeRunWarningsOf(status)?.[0];
    expect(warning).toContain("Its declared budget and residency policy are unavailable");
    expect(warning).not.toContain("admission, the residency planner and ranking use the defaults");
  });
});
