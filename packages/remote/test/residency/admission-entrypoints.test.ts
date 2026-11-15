/**
 * DF-01 (#274): every workload admission entry point must surface the same
 * typed refusal reason — BudgetExceeded when declared reservations would
 * exceed the node budget, BudgetUnknown when a remote node's budget cannot
 * be verified — and must count ModelHost residents alongside ModelRuns in
 * the living set. One hermetic matrix drives all eight callers through the
 * same resident/candidate scenario on node "gpu1"; every case fails on the
 * pinned base by assertion (the typed reason fields and the CLI
 * "admission refused" lines do not exist yet) and passes once the fix lands.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { SetEnabledDeps } from "../../../cli/src/commands/setEnabled.js";
import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { NodeRun } from "../../src/workload/noderun-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { setWorkloadEnabledWithDeps } from "../../../cli/src/commands/setEnabled.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runApply,
} from "../../../cli/src/commands/workload.js";
import { EMPTY_GLOBALS, setGlobals } from "../../../cli/src/dispatcher.js";
import { captureProcessStreams } from "../../../cli/test/helpers.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { applyManifest } from "../../src/workload/apply.js";
import { loadModelHostByName, saveModelHost } from "../../src/workload/modelhost-store.js";
import { listNodeRuns, saveNodeRun } from "../../src/workload/noderun-store.js";
import { reconcileOnce } from "../../src/workload/reconciler.js";
import { loadWorkloadByName, saveWorkload } from "../../src/workload/store.js";

const NODE = "gpu1";
const RESIDENT_MEMORY_GIB = 24;
const CANDIDATE_MEMORY_GIB = 8;
const NODE_FACTS_MEM_BYTES = 256 * 1024 ** 3;
const RESIDENT_PORT = 18101;
const CANDIDATE_PORT = 18102;

type ResidentKind = "ModelRun" | "ModelHost";
type CandidateKind = "ModelRun" | "ModelHost";
type CallerEntry = "apply-manifest" | "reconcile" | "cli-apply" | "enable";
type Arm = 1 | 2 | 3;

const RESIDENT_KINDS: readonly ResidentKind[] = ["ModelRun", "ModelHost"];

const RESIDENT_NAME: Record<ResidentKind, string> = {
  ModelRun: "resident-run",
  ModelHost: "resident-host",
};
const CANDIDATE_NAME: Record<CandidateKind, string> = {
  ModelRun: "cand-run",
  ModelHost: "cand-host",
};

interface CallerSpec {
  entry: CallerEntry;
  candidate: CandidateKind;
  label: string;
  /** Mutations this caller's assertions kill, before the resident-kind
   *  dependent M5 and the arm-(3) M6 are added per test. */
  mutations: readonly string[];
}

const CALLERS: readonly CallerSpec[] = [
  {
    entry: "apply-manifest",
    candidate: "ModelRun",
    label: "applyManifest(ModelRun candidate)",
    mutations: ["M2"],
  },
  {
    entry: "apply-manifest",
    candidate: "ModelHost",
    label: "applyManifest(ModelHost candidate)",
    mutations: ["M1"],
  },
  {
    entry: "reconcile",
    candidate: "ModelRun",
    label: "reconcileOnce(ModelRun candidate)",
    mutations: ["M3"],
  },
  {
    entry: "reconcile",
    candidate: "ModelHost",
    label: "reconcileOnce(ModelHost candidate)",
    mutations: ["M1", "M3"],
  },
  {
    entry: "cli-apply",
    candidate: "ModelRun",
    label: "runApply(ModelRun YAML)",
    mutations: ["M4"],
  },
  {
    entry: "cli-apply",
    candidate: "ModelHost",
    label: "runApply(ModelHost YAML)",
    mutations: ["M1", "M4"],
  },
  {
    entry: "enable",
    candidate: "ModelRun",
    label: "setWorkloadEnabled(ModelRun candidate)",
    mutations: ["M4"],
  },
  {
    entry: "enable",
    candidate: "ModelHost",
    label: "setWorkloadEnabled(ModelHost candidate)",
    mutations: ["M1", "M4"],
  },
];

const originalEnv = { ...process.env };
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-admission-entrypoints-"));
  const devStorage = join(tmp, "dev");
  const workloadsDir = join(tmp, "workloads");
  const runtimeDir = join(tmp, "runtime");
  const modelsDir = join(tmp, "models");
  process.env["DEV_STORAGE"] = devStorage;
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMA_CPP_MODELS"] = modelsDir;
  mkdirSync(devStorage, { recursive: true });
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  setGlobals(EMPTY_GLOBALS);
  __resetWorkloadTestSeams();
});

afterEach(() => {
  __resetWorkloadTestSeams();
  setGlobals(EMPTY_GLOBALS);
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function makeModelRun(name: string, expectedMemoryGiB: number, enabled: boolean): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      node: NODE,
      enabled,
      target: { kind: "rel", value: `${name}.gguf` },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      resources: { expectedMemoryGiB },
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function makeModelHost(
  name: string,
  expectedMemoryGiB: number,
  enabled: boolean,
  port: number,
): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: NODE,
      enabled,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port },
      hostedModels: [{ rel: `mlx-community/${name}` }],
      resources: { expectedMemoryGiB },
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
    },
  };
}

function makeNodeRun(memoryGiB: number): NodeRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: NODE, labels: {} },
    spec: { node: NODE, infra: [], budget: { memoryGiB } },
  };
}

function storeManifest(
  kind: "ModelRun" | "ModelHost",
  name: string,
  expectedMemoryGiB: number,
  enabled: boolean,
  dir: string,
  port: number,
): void {
  if (kind === "ModelRun") {
    saveWorkload(makeModelRun(name, expectedMemoryGiB, enabled), dir);
  } else {
    saveModelHost(makeModelHost(name, expectedMemoryGiB, enabled, port), dir);
  }
}

function mutationIds(caller: CallerSpec, resident: ResidentKind): string {
  const ids = [...caller.mutations];
  if (resident === "ModelHost") ids.push("M5");
  ids.push("M6");
  return ids.join("+");
}

interface AdmissionFake {
  client: WorkloadClient;
  starts: Map<string, number>;
}

/**
 * One fake node for every caller: serverStatus is down, modelHostStatus is
 * Stopped until that workload name has been started (Running afterwards),
 * both start subscriptions record input.workload then emit done ok, and
 * nodeFacts reports 256 GiB unless the arm puts it in reject mode — a
 * fallback that charged the candidate against controller RAM or nodeFacts
 * memory would admit arm (3) and die on the BudgetUnknown assertion.
 */
function makeAdmissionFake(nodeFactsRejects: boolean): AdmissionFake {
  const starts = new Map<string, number>();
  const startedHosts = new Set<string>();
  const recordStart = (input: { workload: string }): void => {
    starts.set(input.workload, (starts.get(input.workload) ?? 0) + 1);
  };
  const client: WorkloadClient = {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ ok: true }) },
    serverStart: {
      subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
        recordStart(input);
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 41000, endpoint: "http://127.0.0.1:19000" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
        recordStart(input);
        startedHosts.add(input.workload);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true, pid: 41001, state: "Running" } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
    modelHostStatus: {
      query: (input) =>
        Promise.resolve(
          startedHosts.has(input.workload)
            ? { state: "Running", pid: 41001 }
            : { state: "Stopped", pid: null },
        ),
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
    nodeFacts: {
      query: () =>
        nodeFactsRejects
          ? Promise.reject(new Error("node unreachable"))
          : Promise.resolve({ memBytes: NODE_FACTS_MEM_BYTES }),
    },
  };
  return { client, starts };
}

interface PreparedArm {
  armDir: string;
  workloadsDir: string;
  fake: AdmissionFake;
  deps: SetEnabledDeps;
  nodeClientByName: NonNullable<SetEnabledDeps["getNodeClientByName"]>;
}

/**
 * Seed one arm in a fresh directory tree: the resident of kind R (24 GiB,
 * enabled, on gpu1), the NodeRun budget for arms (1)/(2), and the candidate
 * wherever the caller reads it from — stored enabled for reconcileOnce,
 * stored enabled:false for the enable path, inline manifest or -f YAML for
 * the apply paths. Arm (3) saves no NodeRun and puts nodeFacts in reject
 * mode so every budget resolver falls through to an unverifiable remote
 * node (#669).
 */
function prepareArm(
  arm: Arm,
  resident: ResidentKind,
  candidate: CandidateKind,
  caller: CallerEntry,
): PreparedArm {
  __resetWorkloadTestSeams();
  const armDir = join(tmp, `arm-${caller}-${candidate}-${resident}-${String(arm)}`);
  const workloadsDir = join(armDir, "workloads");
  const runtimeDir = join(armDir, "runtime");
  const devStorage = join(armDir, "dev");
  const modelsDir = join(armDir, "models");
  for (const dir of [workloadsDir, runtimeDir, devStorage, modelsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  process.env["DEV_STORAGE"] = devStorage;
  process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;
  process.env["LLAMA_CPP_MODELS"] = modelsDir;

  storeManifest(
    resident,
    RESIDENT_NAME[resident],
    RESIDENT_MEMORY_GIB,
    true,
    workloadsDir,
    resident === "ModelHost" ? RESIDENT_PORT : CANDIDATE_PORT,
  );
  if (arm !== 3) {
    saveNodeRun(makeNodeRun(arm === 1 ? 24 : 32), workloadsDir);
  }
  if (caller === "reconcile") {
    storeManifest(
      candidate,
      CANDIDATE_NAME[candidate],
      CANDIDATE_MEMORY_GIB,
      true,
      workloadsDir,
      CANDIDATE_PORT,
    );
  } else if (caller === "enable") {
    storeManifest(
      candidate,
      CANDIDATE_NAME[candidate],
      CANDIDATE_MEMORY_GIB,
      false,
      workloadsDir,
      CANDIDATE_PORT,
    );
  }

  const fake = makeAdmissionFake(arm === 3);
  const nodeClientByName = ((): unknown => fake.client) as unknown as NonNullable<
    SetEnabledDeps["getNodeClientByName"]
  >;
  const deps: SetEnabledDeps = {
    getNodeClientByName: nodeClientByName,
    loadConfig: (() => ({
      currentContext: "default",
      contexts: [],
      clusters: [],
      users: [],
    })) as unknown as SetEnabledDeps["loadConfig"],
    resolveNode: ((_cfg: unknown, node: string) => ({
      node: { endpoint: `https://${node}` },
    })) as unknown as SetEnabledDeps["resolveNode"],
    listNodeRuns: () => listNodeRuns(workloadsDir),
  };
  return { armDir, workloadsDir, fake, deps, nodeClientByName };
}

interface ArmOutcome {
  admitted: boolean;
  reason: unknown;
  starts: number;
  message: string;
  /** Persisted spec.enabled after the call; only the enable caller reads it. */
  candidateEnabled?: boolean;
}

function candidateManifest(
  candidate: CandidateKind,
  enabled: boolean,
): ModelRun | ModelHostManifest {
  const name = CANDIDATE_NAME[candidate];
  return candidate === "ModelRun"
    ? makeModelRun(name, CANDIDATE_MEMORY_GIB, enabled)
    : makeModelHost(name, CANDIDATE_MEMORY_GIB, enabled, CANDIDATE_PORT);
}

async function runApplyManifestCaller(
  prepared: PreparedArm,
  candidate: CandidateKind,
): Promise<ArmOutcome> {
  const name = CANDIDATE_NAME[candidate];
  const outcome = await applyManifest({
    manifest: candidateManifest(candidate, true),
    workloadsDir: prepared.workloadsDir,
    env: process.env,
    getClient: () => prepared.fake.client,
    // applyManifest does no NodeRun lookup of its own; mirror router.ts's
    // nodeRunBudgetGiB/nodeRunResidency keyed by NodeRun metadata.name.
    getNodeBudgetGiB: (node) =>
      listNodeRuns(prepared.workloadsDir).find((r) => r.metadata.name === node)?.spec.budget
        ?.memoryGiB,
    getNodeResidency: (node) =>
      listNodeRuns(prepared.workloadsDir).find((r) => r.metadata.name === node)?.spec.residency,
  });
  return {
    admitted: outcome.ok,
    reason: outcome.ok ? undefined : (outcome as { reason?: unknown }).reason,
    starts: prepared.fake.starts.get(name) ?? 0,
    message: outcome.ok ? "" : outcome.error,
  };
}

async function runReconcileCaller(
  prepared: PreparedArm,
  candidate: CandidateKind,
): Promise<ArmOutcome> {
  const name = CANDIDATE_NAME[candidate];
  const result = await reconcileOnce({
    workloadsDir: prepared.workloadsDir,
    getClient: () => prepared.fake.client,
  });
  const report = result.reports.find((r) => r.name === name);
  return {
    admitted: report !== undefined && report.error === undefined,
    reason:
      report === undefined ? undefined : (report as { admissionReason?: unknown }).admissionReason,
    starts: prepared.fake.starts.get(name) ?? 0,
    message: report?.error ?? "",
  };
}

async function runCliApplyCaller(
  prepared: PreparedArm,
  candidate: CandidateKind,
): Promise<ArmOutcome> {
  const name = CANDIDATE_NAME[candidate];
  const manifestPath = join(prepared.armDir, "candidate.yaml");
  writeFileSync(manifestPath, stringifyYaml(candidateManifest(candidate, true)));
  __setWorkloadTestSeams({ getNodeClientByName: prepared.nodeClientByName });
  const { result: code, stderr } = await captureProcessStreams(() =>
    runApply(["-f", manifestPath]),
  );
  const refused = /apply: admission refused: ([A-Za-z]+)/.exec(stderr);
  return {
    admitted: code === 0,
    reason: refused?.[1],
    starts: prepared.fake.starts.get(name) ?? 0,
    message: stderr,
  };
}

async function runEnableCaller(
  prepared: PreparedArm,
  candidate: CandidateKind,
): Promise<ArmOutcome> {
  const name = CANDIDATE_NAME[candidate];
  const result = await setWorkloadEnabledWithDeps(name, true, prepared.deps);
  const storedEnabled =
    candidate === "ModelRun"
      ? loadWorkloadByName(name, prepared.workloadsDir).spec.enabled
      : loadModelHostByName(name, prepared.workloadsDir).spec.enabled;
  return {
    admitted: result.code === 0,
    reason: (result as { reason?: unknown }).reason,
    starts: prepared.fake.starts.get(name) ?? 0,
    message: result.message ?? "",
    candidateEnabled: storedEnabled,
  };
}

async function runCallerArm(
  caller: CallerSpec,
  resident: ResidentKind,
  arm: Arm,
): Promise<ArmOutcome> {
  const prepared = prepareArm(arm, resident, caller.candidate, caller.entry);
  switch (caller.entry) {
    case "apply-manifest":
      return await runApplyManifestCaller(prepared, caller.candidate);
    case "reconcile":
      return await runReconcileCaller(prepared, caller.candidate);
    case "cli-apply":
      return await runCliApplyCaller(prepared, caller.candidate);
    case "enable":
      return await runEnableCaller(prepared, caller.candidate);
  }
}

// Mutation legend (ids ride in each generated test's title):
//   M1 admitModelHostBudget drops `reason`          — ModelHost candidates
//   M2 applyModelRunManifest drops the reason       — applyManifest(ModelRun)
//   M3 the reconciler omits admissionReason         — reconcileOnce callers
//   M4 the CLI omits the "admission refused" line   — runApply + enable
//   M5 listAnyWorkloadsForAdmission becomes
//      ModelRun-only, hiding a ModelHost resident   — ModelHost residents
//   M6 the remote budget falls back to
//      defaultNodeBudgetGiB(totalmem) or nodeFacts x 0.75 when nodeFacts
//      rejects                                      — arm (3), every caller
describe("admission entrypoints (#274)", () => {
  for (const caller of CALLERS) {
    for (const resident of RESIDENT_KINDS) {
      // Kills: see title suffix — the mutations this caller x resident
      // combination is responsible for.
      test(`${caller.label} vs ${resident} resident [kills ${mutationIds(caller, resident)}]: same typed reason on every arm`, async () => {
        const arm1 = await runCallerArm(caller, resident, 1);
        expect(arm1.admitted).toBe(false);
        expect(arm1.reason).toBe("BudgetExceeded");
        expect(arm1.starts).toBe(0);
        expect(arm1.message).toContain("Budget is 24.0 GiB");
        expect(arm1.message).toContain("would reserve 32.0 GiB");
        if (caller.entry === "enable") expect(arm1.candidateEnabled).toBe(false);

        const arm2 = await runCallerArm(caller, resident, 2);
        expect(arm2.admitted).toBe(true);
        expect(arm2.starts).toBe(1);

        const arm3 = await runCallerArm(caller, resident, 3);
        expect(arm3.admitted).toBe(false);
        expect(arm3.reason).toBe("BudgetUnknown");
        expect(arm3.message).toContain("node 'gpu1' memory budget is unknown");
        expect(arm3.starts).toBe(0);
        if (caller.entry === "enable") expect(arm3.candidateEnabled).toBe(false);
      });
    }
  }

  test("all 16 caller x resident combinations agree on BudgetExceeded", async () => {
    const reasons: unknown[] = [];
    for (const caller of CALLERS) {
      for (const resident of RESIDENT_KINDS) {
        reasons.push((await runCallerArm(caller, resident, 1)).reason);
      }
    }
    expect(reasons).toEqual(Array(16).fill("BudgetExceeded"));
  });

  test("all 16 caller x resident combinations agree on BudgetUnknown", async () => {
    const reasons: unknown[] = [];
    for (const caller of CALLERS) {
      for (const resident of RESIDENT_KINDS) {
        reasons.push((await runCallerArm(caller, resident, 3)).reason);
      }
    }
    expect(reasons).toEqual(Array(16).fill("BudgetUnknown"));
  });
});
