import { type config as kubecfg, workloadApply, workloadStore } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExpose } from "../src/commands/expose.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

// Part of #519: `llamactl expose` must charge the incoming workload against
// the same NodeRun admission budget + residency policy every other apply
// path does, instead of falling through with no lookups at all.

interface RecordedApplyOpts {
  getNodeBudgetGiB?: (nodeName: string) => unknown;
  getNodeResidency?: (nodeName: string) => unknown;
  resolveNodeIdentity?: (nodeName: string) => string | null;
}

interface ExposeDeps {
  applyOne?: typeof workloadApply.applyOne;
  saveWorkload?: typeof workloadStore.saveWorkload;
  loadConfig?: typeof kubecfg.loadConfig;
  resolveNode?: typeof kubecfg.resolveNode;
  getNodeClientByName?: (nodeName: string) => unknown;
  listNodeRuns?: () => readonly unknown[];
}

type RunExposeWithDeps = (args: string[], deps?: ExposeDeps) => Promise<number>;
const runExposeWithDeps = runExpose as unknown as RunExposeWithDeps;

const EXPOSE_ARGS = ["fake-org/fake-model.gguf", "--node", "expose-519", "--name", "x519"];

let tmp = "";
let stdoutText = "";
let stderrText = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConfigEnv = process.env["LLAMACTL_CONFIG"];
const originalWorkloadsEnv = process.env["LLAMACTL_WORKLOADS_DIR"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-expose-519-"));
  stdoutText = "";
  stderrText = "";
  process.stdout.write = (chunk: string | Uint8Array): true => {
    stdoutText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): true => {
    stderrText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  };
  process.env["LLAMACTL_CONFIG"] = join(tmp, "kubeconfig");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalConfigEnv === undefined) delete process.env["LLAMACTL_CONFIG"];
  else process.env["LLAMACTL_CONFIG"] = originalConfigEnv;
  if (originalWorkloadsEnv === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
  else process.env["LLAMACTL_WORKLOADS_DIR"] = originalWorkloadsEnv;
  rmSync(tmp, { recursive: true, force: true });
});

function nodeRunFixture(
  name: string,
  memoryGiB?: number,
  residency?: Record<string, unknown>,
): unknown {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name, labels: {} },
    spec: {
      node: name,
      infra: [],
      ...(memoryGiB !== undefined ? { budget: { memoryGiB } } : {}),
      ...(residency !== undefined ? { residency } : {}),
    },
  };
}

function startedResult(): workloadApply.ApplyResult {
  return {
    action: "started",
    statusSection: {
      phase: "Running",
      serverPid: null,
      endpoint: null,
      lastTransitionTime: "t",
      conditions: [],
    },
  };
}

interface RecordingDeps {
  deps: ExposeDeps;
  seen: { opts?: RecordedApplyOpts | undefined };
  calls: { apply: number };
}

function recordingDeps(nodeRuns: () => readonly unknown[]): RecordingDeps {
  const seen: { opts?: RecordedApplyOpts | undefined } = {};
  const calls = { apply: 0 };
  const deps: ExposeDeps = {
    listNodeRuns: nodeRuns,
    applyOne: (_manifest, _getClient, _onEvent, _gateway, opts) => {
      calls.apply++;
      seen.opts = opts;
      return Promise.resolve(startedResult());
    },
    saveWorkload: () => "/tmp/x519.yaml",
    getNodeClientByName: () => {
      throw new Error("no client");
    },
  };
  return { deps, seen, calls };
}

interface ClientCalls {
  names: string[];
  nodeFacts: number;
  serverStart: number;
}

function fakeExposeClient(calls: ClientCalls): workloadApply.WorkloadClient {
  return {
    serverStatus: {
      query: () => Promise.resolve({ state: "down", rel: null, extraArgs: [] }),
    },
    nodeFacts: {
      query: () => {
        calls.nodeFacts++;
        return Promise.resolve({ memBytes: 100 * 1024 ** 3 });
      },
    },
    serverStart: {
      subscribe: (
        _input: unknown,
        callbacks: { onError: (err: unknown) => void },
      ): { unsubscribe: () => void } => {
        calls.serverStart++;
        callbacks.onError(new Error("fake start must not run"));
        return { unsubscribe: () => undefined };
      },
    },
  } as unknown as workloadApply.WorkloadClient;
}

function admissionDeps(nodeRuns: () => readonly unknown[]): {
  deps: ExposeDeps;
  calls: ClientCalls;
} {
  const calls: ClientCalls = { names: [], nodeFacts: 0, serverStart: 0 };
  const client = fakeExposeClient(calls);
  const deps: ExposeDeps = {
    listNodeRuns: nodeRuns,
    applyOne: (manifest, getClient, onEvent, gatewayDispatch, opts) =>
      workloadApply.applyOne(manifest, getClient, onEvent, gatewayDispatch, {
        ...opts,
        workloadsDir: tmp,
      }),
    getNodeClientByName: (name) => {
      calls.names.push(name);
      return client;
    },
  };
  return { deps, calls };
}

function saveResidentA(dir: string): void {
  workloadStore.saveWorkload(
    workloadStore.parseWorkload(
      [
        "apiVersion: llamactl/v1",
        "kind: ModelRun",
        "metadata:",
        "  name: resident-a",
        "spec:",
        "  node: expose-519",
        "  enabled: true",
        "  target:",
        "    kind: rel",
        "    value: fake-org/resident-a.gguf",
        "  resources:",
        "    expectedMemoryGiB: 20",
        "",
      ].join("\n"),
    ),
    dir,
  );
}

describe("llamactl expose NodeRun admission (#519)", () => {
  test("expose passes the NodeRun budget lookup through to applyOne", async () => {
    // Kills: applyExposeManifest dropping getNodeBudgetGiB from the applyOne opts.
    const { deps, seen, calls } = recordingDeps(() => [
      nodeRunFixture("expose-519", 12),
      nodeRunFixture("other"),
    ]);

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(0);
    expect(calls.apply).toBe(1);
    expect(seen.opts?.getNodeBudgetGiB?.("expose-519")).toBe(12);
    expect(seen.opts?.getNodeBudgetGiB?.("other")).toBeUndefined();
    expect(seen.opts?.getNodeBudgetGiB?.("nope")).toBeUndefined();
  });

  test("expose passes the NodeRun residency lookup through to applyOne", async () => {
    // Kills: applyExposeManifest dropping getNodeResidency from the applyOne opts.
    const { deps, seen, calls } = recordingDeps(() => [
      nodeRunFixture("expose-519", undefined, { safetyMarginRatio: 0.5 }),
      nodeRunFixture("other"),
    ]);

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(0);
    expect(calls.apply).toBe(1);
    expect(seen.opts?.getNodeResidency?.("expose-519")).toEqual({ safetyMarginRatio: 0.5 });
    expect(seen.opts?.getNodeResidency?.("other")).toBeUndefined();
  });

  test("explicit NodeRun budget refuses over-budget on an unresolved node after verifying it live", async () => {
    // Kills: dropping getNodeBudgetGiB — the verified 0.75 x 100 GiB fallback
    // would admit the 20 GiB reservation and run serverStart.
    saveResidentA(tmp);
    const { deps, calls } = admissionDeps(() => [nodeRunFixture("expose-519", 10)]);

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(1);
    expect(stderrText).toContain("Budget is 10.0 GiB");
    expect(calls.names).toContain("expose-519");
    expect(calls.nodeFacts).toBeGreaterThanOrEqual(1);
    expect(calls.serverStart).toBe(0);
  });

  test("NodeRun safetyMarginRatio sizes the computed budget on an unresolved node", async () => {
    // Kills: expose sizing the computed budget with the fixed 0.75 —
    // 75.0 GiB would admit the 20 GiB reservation and run serverStart.
    saveResidentA(tmp);
    const { deps, calls } = admissionDeps(() => [
      nodeRunFixture("expose-519", undefined, { safetyMarginRatio: 0.1 }),
    ]);

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(1);
    expect(stderrText).toContain("Budget is 10.0 GiB");
    expect(calls.nodeFacts).toBeGreaterThanOrEqual(1);
    expect(calls.serverStart).toBe(0);
  });

  test("no governing NodeRun leaves both lookups undefined and the apply succeeds", async () => {
    // At base this fails only because deps are ignored: the real applyOne
    // cannot resolve 'expose-519' and exits 1 without calling the recorder.
    const { deps, seen, calls } = recordingDeps(() => []);

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(0);
    expect(calls.apply).toBe(1);
    expect(seen.opts?.getNodeBudgetGiB?.("expose-519")).toBeUndefined();
    expect(seen.opts?.getNodeResidency?.("expose-519")).toBeUndefined();
  });

  test("explicit NodeRun budget wins on a resolved node without a live nodeFacts read", async () => {
    // Kills: expose ignoring the injected resolveNode (identity would be
    // unresolved and nodeFacts queried) and dropping getNodeBudgetGiB
    // (verified 75.0 GiB would admit and start).
    saveResidentA(tmp);
    const { deps, calls } = admissionDeps(() => [nodeRunFixture("expose-519", 10)]);
    deps.loadConfig = (): ReturnType<typeof kubecfg.loadConfig> =>
      ({}) as unknown as ReturnType<typeof kubecfg.loadConfig>;
    deps.resolveNode = ((_cfg: unknown, n: string) => ({
      node: { endpoint: `https://${n}.invalid:7843` },
    })) as unknown as typeof kubecfg.resolveNode;

    const code = await runExposeWithDeps(EXPOSE_ARGS, deps);

    expect(code).toBe(1);
    expect(stderrText).toContain("Budget is 10.0 GiB");
    expect(calls.names).toContain("expose-519");
    expect(calls.nodeFacts).toBe(0);
    expect(calls.serverStart).toBe(0);
  });
});
