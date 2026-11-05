// packages/app/test/console/workloads-scope.test.ts
// Issue #410, P5a RED — pins the workloads view scoping. The list shows
// only rows whose node is the tab node, in fetch order; the footer
// counts the remaining rows per node, sorted by node name, each linked
// through ?node=. workloadLocation classifies a deep-linked name as
// here / elsewhere / missing so a workload on another node renders the
// switch notice instead of a node-routed call. The module does not
// exist at the base commit, so every case fails by assertion through
// the import-catch pattern — never by import error.

import { describe, expect, test } from "bun:test";

const SCOPE_SPEC = "../../src/console/workloads-scope.ts";

interface WorkloadRow {
  name: string;
  kind: "ModelRun" | "ModelHost";
  node: string;
  rel: string;
  phase: "Running" | "Stopped" | "Mismatch" | "Unreachable" | "Foreign";
  endpoint: string | null;
  workerCount: number;
  workerNodes: string[];
}

interface OtherNodeCount {
  node: string;
  count: number;
  href: string;
}

interface WorkloadsForTabResult {
  rows: WorkloadRow[];
  others: OtherNodeCount[];
}

type WorkloadLocationResult =
  | { kind: "here"; row: WorkloadRow }
  | { kind: "elsewhere"; node: string; message: string; href: string }
  | { kind: "missing" };

interface WorkloadsScopeModule {
  workloadsForTab?: (rows: WorkloadRow[], tabNode: string) => WorkloadsForTabResult;
  workloadLocation?: (rows: WorkloadRow[], name: string, tabNode: string) => WorkloadLocationResult;
}

async function importScope(): Promise<WorkloadsScopeModule | null> {
  return (await import(SCOPE_SPEC).catch(() => null)) as WorkloadsScopeModule | null;
}

function makeRow(name: string, kind: WorkloadRow["kind"], node: string): WorkloadRow {
  return {
    name,
    kind,
    node,
    rel: `hf.co/${name}.gguf`,
    phase: "Running",
    endpoint: null,
    workerCount: 0,
    workerNodes: [],
  };
}

const localRun1 = makeRow("w-local-1", "ModelRun", "local");
const gpuRun = makeRow("w-on-gpu", "ModelRun", "gpu-1");
const localHost = makeRow("h-local", "ModelHost", "local");
const gpuRun2 = makeRow("w-gpu-2", "ModelRun", "gpu-1");
const localRun2 = makeRow("w-local-2", "ModelRun", "local");
const miniRun = makeRow("w-mini", "ModelRun", "mac-mini");

function fixtureRows(): WorkloadRow[] {
  return [localRun1, gpuRun, localHost, gpuRun2, localRun2, miniRun];
}

describe("workloads tab scope (#410 P5a)", () => {
  test("workloadsForTab keeps tab-node rows in order and counts the rest per node", async () => {
    const mod = await importScope();
    expect(mod?.workloadsForTab).toBeFunction();

    const scoped = mod!.workloadsForTab!(fixtureRows(), "local");
    expect(scoped.rows).toEqual([localRun1, localHost, localRun2]);
    expect(scoped.rows.map((row) => row.name)).toEqual(["w-local-1", "h-local", "w-local-2"]);
    expect(scoped.others).toEqual([
      { node: "gpu-1", count: 2, href: "/workloads?node=gpu-1" },
      { node: "mac-mini", count: 1, href: "/workloads?node=mac-mini" },
    ]);
  });

  test("workloadsForTab on an empty list has no rows and no others", async () => {
    const mod = await importScope();
    expect(mod?.workloadsForTab).toBeFunction();

    expect(mod!.workloadsForTab!([], "local")).toEqual({ rows: [], others: [] });
  });

  test("workloadsForTab on an unknown node counts every node sorted by name", async () => {
    const mod = await importScope();
    expect(mod?.workloadsForTab).toBeFunction();

    const scoped = mod!.workloadsForTab!(fixtureRows(), "nobody");
    expect(scoped.rows).toEqual([]);
    expect(scoped.others).toEqual([
      { node: "gpu-1", count: 2, href: "/workloads?node=gpu-1" },
      { node: "local", count: 3, href: "/workloads?node=local" },
      { node: "mac-mini", count: 1, href: "/workloads?node=mac-mini" },
    ]);
  });

  test("workloadLocation reports a workload on another node as elsewhere with a switch notice", async () => {
    const mod = await importScope();
    expect(mod?.workloadLocation).toBeFunction();

    expect(mod!.workloadLocation!(fixtureRows(), "w-on-gpu", "local")).toEqual({
      kind: "elsewhere",
      node: "gpu-1",
      message: "This workload runs on gpu-1. Switch this tab or open a new one",
      href: "/workloads/w-on-gpu?node=gpu-1",
    });
  });

  test("workloadLocation reports a tab-node workload as here with its row", async () => {
    const mod = await importScope();
    expect(mod?.workloadLocation).toBeFunction();

    const located = mod!.workloadLocation!(fixtureRows(), "h-local", "local");
    expect(located).toEqual({ kind: "here", row: localHost });
    if (located.kind === "here") expect(located.row).toBe(localHost);
  });

  test("workloadLocation reports an unknown name as missing", async () => {
    const mod = await importScope();
    expect(mod?.workloadLocation).toBeFunction();

    expect(mod!.workloadLocation!(fixtureRows(), "no-such", "local")).toEqual({
      kind: "missing",
    });
  });
});
