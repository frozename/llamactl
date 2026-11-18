import type { ResidencyState } from "@llamactl/core/residency/lifecycle";
import type { NodeClient } from "@llamactl/remote";

import { workloadSchema, workloadStore } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyStatus } from "../../remote/src/residency/procedures.js";
import type * as ResidencyModule from "../src/commands/residency.js";

import * as workloadMod from "../src/commands/workload.js";
import { EMPTY_GLOBALS, resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";

type LeaseWorkloadRow = {
  workload: string;
  phase: "open" | "draining" | "unloaded";
  epoch: number;
  activeLeaseCount: number;
  waiters: number;
};

type LeaseAuditRow = {
  workload: string;
  epoch: number;
  forced: true;
  revokedCount: number;
  reason: string | null;
};

type LeasesSection =
  | { status: "unavailable"; scope: "serving-process" }
  | {
      status: "available";
      scope: "serving-process";
      workloads: LeaseWorkloadRow[];
      auditCount: number;
      recentAudit: LeaseAuditRow[];
    };

type LifecycleWorkloadRow = {
  model: string;
  group: string | null;
  state: ResidencyState;
  occupying: boolean;
  version: number;
  updatedAtMs: number;
};

type LifecycleSection =
  | {
      status: "available";
      scope: "serving-process";
      workloads: LifecycleWorkloadRow[];
      exclusiveViolations: { group: string; members: string[] }[];
    }
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: "StoreUnreadable" | "LifecycleUnreadable";
    };

type SessionSnapshotRow = {
  sessionId: string;
  workload: string;
  refs: number;
  idleMs: number;
  expiresInMs: number | null;
};

type SessionsSection =
  | {
      status: "unavailable";
      scope: "serving-process";
      reason: "NoRegistry" | "SessionsUnknown" | "SnapshotUnsupported";
    }
  | {
      status: "available";
      scope: "serving-process";
      idleTimeoutMs: number;
      sessions: SessionSnapshotRow[];
    };

type StatusFixture = Omit<ResidencyStatus, "lifecycle" | "sessions"> & {
  leases: LeasesSection;
  lifecycle?: LifecycleSection;
  sessions?: SessionsSection;
};

const RESIDENCY_STORE_PATH = "/tmp/rs/operations.sqlite";
const SPAWN_TIMEOUT_MS = 10_000;
// Each bin case cold-starts the CLI; the test limit must sit above the 10 s spawnSync limit.
const CLI_SPAWN_TEST_TIMEOUT_MS = 20_000;

const OK_STATUS: StatusFixture = {
  node: "gpu1",
  nodeRun: { present: true },
  policy: { present: true, residency: {} },
  budget: { memoryGiB: 24, source: "noderun" },
  store: {
    path: RESIDENCY_STORE_PATH,
    present: true,
    nonterminalCount: 1,
    nonterminal: [
      {
        operationId: "op-1",
        model: "qwen3-8b",
        phase: "loading",
        targetState: "resident",
        reservationGiB: 6.5,
      },
    ],
    scope: "serving-process",
  },
  leases: {
    status: "available",
    scope: "serving-process",
    workloads: [
      {
        workload: "llama-drain",
        phase: "draining",
        epoch: 3,
        activeLeaseCount: 2,
        waiters: 1,
      },
      { workload: "qwen3-8b", phase: "open", epoch: 0, activeLeaseCount: 1, waiters: 0 },
    ],
    auditCount: 1,
    recentAudit: [
      { workload: "old-model", epoch: 2, forced: true, revokedCount: 1, reason: "operator" },
    ],
  },
};

const ABSENT_STATUS: StatusFixture = {
  node: "gpu1",
  nodeRun: { present: false },
  policy: { present: false },
  budget: { memoryGiB: 16, source: "computed" },
  store: { path: RESIDENCY_STORE_PATH, present: false, scope: "serving-process" },
  leases: { status: "unavailable", scope: "serving-process" },
};

const ERROR_STATUS: StatusFixture = {
  ...ABSENT_STATUS,
  store: {
    path: RESIDENCY_STORE_PATH,
    present: true,
    error: "no such table: operations",
    scope: "serving-process",
  },
};

const LIFECYCLE_WORKLOADS: LifecycleWorkloadRow[] = [
  {
    model: "a-glm",
    group: "z13-large-gpu",
    state: "ready",
    occupying: true,
    version: 4,
    updatedAtMs: 1,
  },
  {
    model: "b-run",
    group: null,
    state: "downloaded",
    occupying: false,
    version: 1,
    updatedAtMs: 1,
  },
];

const LIFECYCLE_OK_STATUS: StatusFixture = {
  ...OK_STATUS,
  lifecycle: {
    status: "available",
    scope: "serving-process",
    workloads: LIFECYCLE_WORKLOADS,
    exclusiveViolations: [],
  },
};

const LIFECYCLE_VIOLATION_STATUS: StatusFixture = {
  ...OK_STATUS,
  lifecycle: {
    status: "available",
    scope: "serving-process",
    workloads: LIFECYCLE_WORKLOADS,
    exclusiveViolations: [{ group: "z13-large-gpu", members: ["deepseek", "glm"] }],
  },
};

const LIFECYCLE_STORE_UNREADABLE_STATUS: StatusFixture = {
  ...OK_STATUS,
  lifecycle: { status: "unavailable", scope: "serving-process", reason: "StoreUnreadable" },
};

const LIFECYCLE_ROWS_UNREADABLE_STATUS: StatusFixture = {
  ...OK_STATUS,
  lifecycle: {
    status: "unavailable",
    scope: "serving-process",
    reason: "LifecycleUnreadable",
  },
};

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-"));
});

afterEach(() => {
  workloadMod.__resetWorkloadTestSeams();
  resetGlobals();
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

async function loadResidency(): Promise<typeof ResidencyModule> {
  const mod = (await import("../src/commands/residency.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  expect(typeof mod["runResidency"]).toBe("function");
  expect(typeof mod["renderResidencyStatus"]).toBe("function");
  return mod as unknown as typeof ResidencyModule;
}

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;

      process.stderr.write = stderrOrig;
    });
}

function leafHandler(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
  method: string,
): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    calls.push(`${proc}.${method}`);
    inputs.push(input);
    const handler = handlers[`${proc}.${method}`];
    if (handler === undefined) {
      throw new Error(`unexpected ${proc}.${method}`);
    }
    return await handler(input);
  };
}

function procedureNamespace(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return leafHandler(calls, inputs, handlers, proc, prop);
    },
  });
}

function recordingClient(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
): NodeClient {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return procedureNamespace(calls, inputs, handlers, prop);
    },
  }) as unknown as NodeClient;
}

interface ResidencyDeps {
  getNodeClientByName: (node: string) => NodeClient;
}

interface ResidencyRecording {
  calls: string[];
  inputs: unknown[];
  nodes: string[];
  deps: ResidencyDeps;
}

function setupResidency(
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
): ResidencyRecording {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const nodes: string[] = [];
  const client = recordingClient(calls, inputs, handlers);
  return {
    calls,
    inputs,
    nodes,
    deps: {
      getNodeClientByName: (node: string): NodeClient => {
        nodes.push(node);
        return client;
      },
    },
  };
}

type NodeQueryDeadline = <T>(node: string, query: () => Promise<T>) => Promise<T>;

function exportedNodeQueryDeadline(): NodeQueryDeadline {
  const fn = (workloadMod as unknown as Record<string, unknown>)["withNodeQueryDeadline"];
  expect(typeof fn).toBe("function");
  return fn as NodeQueryDeadline;
}

async function expectRefusal(
  residency: typeof ResidencyModule,
  args: string[],
  needle: string,
): Promise<void> {
  const rec = setupResidency({});
  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedIo(() => residency.runResidency(args, rec.deps));
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain(needle);
  expect(rec.calls).toEqual([]);
  expect(rec.nodes).toEqual([]);
}

describe("llamactl residency status", () => {
  test("status --json prints the residencyStatus payload through the dispatcher", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.resolve(OK_STATUS),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["status", "--node", "gpu1", "--json"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(OK_STATUS);
    expect(stdout).toBe(`${JSON.stringify(OK_STATUS, null, 2)}\n`);
  });

  test("status records exactly one residencyStatus.query for the requested node", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.resolve(OK_STATUS),
    });

    const { result: code } = await withCapturedIo(() =>
      residency.runResidency(["status", "--node", "gpu1", "--json"], rec.deps),
    );

    expect(code).toBe(0);
    expect(rec.nodes).toEqual(["gpu1"]);
    expect(rec.calls).toEqual(["residencyStatus.query"]);
    expect(rec.inputs).toEqual([{ node: "gpu1" }]);
  });

  test("status takes --node from globals and prefers an explicit local --node", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.resolve(OK_STATUS),
    });
    setGlobals({ ...EMPTY_GLOBALS, nodeName: "gpu2" });

    const globalOnly = await withCapturedIo(() =>
      residency.runResidency(["status", "--json"], rec.deps),
    );
    expect(globalOnly.result).toBe(0);
    expect(rec.nodes).toEqual(["gpu2"]);
    expect(rec.inputs).toEqual([{ node: "gpu2" }]);

    rec.calls.length = 0;
    rec.inputs.length = 0;
    rec.nodes.length = 0;

    const localFlag = await withCapturedIo(() =>
      residency.runResidency(["status", "--node", "gpu3", "--json"], rec.deps),
    );
    expect(localFlag.result).toBe(0);
    expect(rec.nodes).toEqual(["gpu3"]);
    expect(rec.inputs).toEqual([{ node: "gpu3" }]);
  });

  test("status renders the human-readable residency status", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.resolve(OK_STATUS),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["status", "--node", "gpu1"], rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(residency.renderResidencyStatus(OK_STATUS));
    expect(stdout).toContain("Node:       gpu1");
    expect(stdout).toContain("NodeRun:    present");
    expect(stdout).toContain("Budget:     24.0 GiB (source: noderun)");
    expect(stdout).toContain("Store:      /tmp/rs/operations.sqlite (scope: serving-process)");
    expect(stdout).toContain("not gpu1's coordinator state");
    expect(stdout).toContain("Nonterminal: 1");
    expect(stdout).toMatch(/op-1\s+qwen3-8b\s+loading -> resident\s+6\.5 GiB/);
  });

  test("status renders the lease/drain section after the store", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.resolve(OK_STATUS),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["status", "--node", "gpu1"], rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Leases:     2 workload(s) (scope: serving-process)");
    const leases = stdout.slice(stdout.indexOf("Leases:"));
    expect(leases).toMatch(/llama-drain\s+draining\s+epoch 3\s+active 2\s+waiters 1/);
    expect(leases).toMatch(/qwen3-8b\s+open\s+epoch 0\s+active 1\s+waiters 0/);
    expect(leases.indexOf("llama-drain")).toBeLessThan(leases.indexOf("qwen3-8b"));
    expect(leases).toContain("Audit:      1 of 1 forced unload(s)");
    expect(leases).toMatch(/old-model\s+epoch 2\s+revoked 1\s+reason operator/);
    expect(stdout.indexOf("Leases:")).toBeLessThan(stdout.indexOf("Note:"));
  });

  describe("lifecycle section", () => {
    test("CL1 renders workloads and no violations between the store block and leases", async () => {
      const residency = await loadResidency();
      const rendered = residency.renderResidencyStatus(LIFECYCLE_OK_STATUS);

      expect(rendered).toContain("Lifecycle:  2 workload(s) (scope: serving-process)");
      expect(rendered).toMatch(/a-glm\s+ready\s+group z13-large-gpu\s+version 4/);
      expect(rendered).toMatch(/b-run\s+downloaded\s+group -\s+version 1/);
      expect(rendered).toContain("Exclusive:  no violations");

      const storeIdx = rendered.indexOf("Store:");
      const nonterminalIdx = rendered.indexOf("Nonterminal:");
      const opIdx = rendered.indexOf("op-1");
      const lifecycleIdx = rendered.indexOf("Lifecycle:");
      const exclusiveIdx = rendered.indexOf("Exclusive:");
      const leasesIdx = rendered.indexOf("Leases:");
      expect(storeIdx).toBeGreaterThanOrEqual(0);
      expect(nonterminalIdx).toBeGreaterThan(storeIdx);
      expect(opIdx).toBeGreaterThan(nonterminalIdx);
      expect(lifecycleIdx).toBeGreaterThan(opIdx);
      expect(exclusiveIdx).toBeGreaterThan(lifecycleIdx);
      expect(leasesIdx).toBeGreaterThan(exclusiveIdx);
    });

    test("CL2 renders an exclusive-group violation with its members", async () => {
      const residency = await loadResidency();
      const rendered = residency.renderResidencyStatus(LIFECYCLE_VIOLATION_STATUS);

      expect(rendered).toContain("Exclusive:  violation in z13-large-gpu: deepseek, glm");
    });

    test("CL3 renders an unavailable lifecycle when the store is unreadable", async () => {
      const residency = await loadResidency();
      const rendered = residency.renderResidencyStatus(LIFECYCLE_STORE_UNREADABLE_STATUS);

      expect(rendered).toContain(
        "Lifecycle:  unavailable (store unreadable; scope: serving-process)",
      );
    });

    test("CL3b renders an unavailable lifecycle when the lifecycle rows are unreadable", async () => {
      const residency = await loadResidency();
      const rendered = residency.renderResidencyStatus(LIFECYCLE_ROWS_UNREADABLE_STATUS);

      expect(rendered).toContain(
        "Lifecycle:  unavailable (lifecycle rows unreadable; scope: serving-process)",
      );
    });

    test("CL4 renders no Lifecycle line for a payload without the key", async () => {
      const residency = await loadResidency();
      const rendered = residency.renderResidencyStatus(OK_STATUS);

      expect(rendered).not.toContain("Lifecycle:");
    });
  });

  test("renderResidencyStatus covers absent policy and store error states", async () => {
    const residency = await loadResidency();

    const absent = residency.renderResidencyStatus(ABSENT_STATUS);
    expect(absent).toContain("NodeRun:    absent");
    expect(absent).toContain("Policy:     none");
    expect(absent).toContain("Budget:     16.0 GiB (source: computed)");
    expect(absent).toContain(
      "Store:      not present at /tmp/rs/operations.sqlite (scope: serving-process)",
    );

    const errored = residency.renderResidencyStatus(ERROR_STATUS);
    expect(errored).toContain(
      "Store:      error at /tmp/rs/operations.sqlite: no such table: operations (scope: serving-process)",
    );
  });

  test("renderResidencyStatus reports an unavailable lease registry", async () => {
    const residency = await loadResidency();
    const rendered = residency.renderResidencyStatus(ABSENT_STATUS);
    expect(rendered).toContain(
      "Leases:     unavailable (no lease registry installed; scope: serving-process)",
    );
  });

  test("status exits 1 with the deadline message when the node does not answer", async () => {
    const residency = await loadResidency();
    workloadMod.__setWorkloadTestSeams({ nodeQueryTimeoutMs: 25 });
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => new Promise<unknown>(() => undefined),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["status", "--node", "gpu1"], rec.deps));

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("residency status: node 'gpu1' did not answer within 25 ms");
  });

  test("status exits 1 with the transport error when the query rejects", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => Promise.reject(new Error("ECONNREFUSED")),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["status", "--node", "gpu1"], rec.deps));

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("residency status: ECONNREFUSED");
  });

  describe("status refusals", () => {
    test("requires an explicit --node", async () => {
      const residency = await loadResidency();
      await expectRefusal(residency, ["status", "--json"], "--node <name> is required");
    });

    test("refuses --node all", async () => {
      const residency = await loadResidency();
      await expectRefusal(
        residency,
        ["status", "--node", "all", "--json"],
        "--node all is not supported",
      );
    });

    test("rejects unknown arguments", async () => {
      const residency = await loadResidency();
      await expectRefusal(
        residency,
        ["status", "--bogus"],
        "residency status: unknown argument --bogus",
      );
    });

    test("rejects unknown subcommands", async () => {
      const residency = await loadResidency();
      await expectRefusal(residency, ["bogus"], "Unknown residency subcommand: bogus");
    });

    test("prints usage with no arguments", async () => {
      const residency = await loadResidency();
      const rec = setupResidency({});
      const {
        result: code,
        stdout,
        stderr,
      } = await withCapturedIo(() => residency.runResidency([], rec.deps));
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Usage:");
      expect(stderr).toContain("llamactl residency status --node <name> [--json]");
      expect(rec.calls).toEqual([]);
      expect(rec.nodes).toEqual([]);
    });
  });

  test("prints usage for --help at both levels", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({});

    const top = await withCapturedIo(() => residency.runResidency(["--help"], rec.deps));
    expect(top.result).toBe(0);
    expect(top.stderr).toBe("");
    expect(top.stdout).toContain("llamactl residency status --node <name> [--json]");

    const sub = await withCapturedIo(() => residency.runResidency(["status", "--help"], rec.deps));
    expect(sub.result).toBe(0);
    expect(sub.stderr).toBe("");
    expect(sub.stdout).toContain("llamactl residency status --node <name> [--json]");
    expect(rec.calls).toEqual([]);
    expect(rec.nodes).toEqual([]);
  });

  test("withNodeQueryDeadline enforces the configured node query deadline", async () => {
    const withDeadline = exportedNodeQueryDeadline();
    workloadMod.__setWorkloadTestSeams({ nodeQueryTimeoutMs: 25 });

    expect(await withDeadline("n", (): Promise<number> => Promise.resolve(42))).toBe(42);

    const failure = new Error("node gone");
    const propagated = await withDeadline("n", (): Promise<number> => Promise.reject(failure)).then(
      (): null => null,
      (err: unknown): unknown => err,
    );
    expect(propagated).toBe(failure);

    const message = await withDeadline(
      "n",
      (): Promise<number> => new Promise<number>(() => undefined),
    ).then(
      (): string => "settled",
      (err: unknown): string => (err as Error).message,
    );
    expect(message).toBe("node 'n' did not answer within 25 ms");
  });
});

describe("residency force-unload", () => {
  const FORCE_UNLOAD_OK = {
    ok: true,
    workload: "w1",
    kind: "modelrun",
    source: "operator",
    reason: "drill",
    revoked: ["w1#1"],
    stopped: true,
    epoch: 1,
  };

  function forceUnloadArgs(workload = "w1", extra: string[] = []): string[] {
    return ["force-unload", workload, "--reason", "drill", "--node", "gpu1", "--yes", ...extra];
  }

  test("refuses without --yes before touching the node client", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({});

    const { result: code, stderr } = await withCapturedIo(() =>
      residency.runResidency(
        ["force-unload", "w1", "--reason", "drill", "--node", "gpu1"],
        rec.deps,
      ),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency force-unload: refusing without --yes");
    expect(rec.calls).toEqual([]);
    expect(rec.nodes).toEqual([]);
  });

  test("--yes mutates residencyForceUnload once and renders the operator result", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyForceUnload.mutate": (): Promise<unknown> => Promise.resolve(FORCE_UNLOAD_OK),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(forceUnloadArgs(), rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(rec.nodes).toEqual(["gpu1"]);
    expect(rec.calls).toEqual(["residencyForceUnload.mutate"]);
    expect(rec.inputs).toEqual([{ workload: "w1", reason: "drill", confirm: true }]);
    expect(stdout).toContain("Forced unload: w1");
    expect(stdout).toContain("source operator");
    expect(stdout).toContain("reason drill");
  });

  test("--json prints the mutate result", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyForceUnload.mutate": (): Promise<unknown> => Promise.resolve(FORCE_UNLOAD_OK),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(forceUnloadArgs("w1", ["--json"]), rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(FORCE_UNLOAD_OK);
  });

  test("typed refusals exit 1 with the reason on stderr", async () => {
    const residency = await loadResidency();
    for (const reason of ["UnknownWorkload", "Unavailable"]) {
      const rec = setupResidency({
        "residencyForceUnload.mutate": (): Promise<unknown> =>
          Promise.resolve({ ok: false, reason, workload: "ghost", detail: "x" }),
      });
      const { result: code, stderr } = await withCapturedIo(() =>
        residency.runResidency(forceUnloadArgs("ghost"), rec.deps),
      );
      expect(code).toBe(1);
      expect(stderr).toContain(`residency force-unload: ${reason}`);
    }
  });

  test("usage errors never reach the node client", async () => {
    const residency = await loadResidency();

    const missingReason = setupResidency({});
    const r1 = await withCapturedIo(() =>
      residency.runResidency(["force-unload", "w1", "--node", "gpu1", "--yes"], missingReason.deps),
    );
    expect(r1.result).toBe(1);
    expect(r1.stderr).toContain("residency force-unload: --reason <text> is required");
    expect(missingReason.calls).toEqual([]);
    expect(missingReason.nodes).toEqual([]);

    for (const blank of ["", "="]) {
      const rec = setupResidency({});
      const args =
        blank === "="
          ? ["force-unload", "w1", "--reason=", "--node", "gpu1", "--yes"]
          : ["force-unload", "w1", "--reason", "", "--node", "gpu1", "--yes"];
      const r = await withCapturedIo(() => residency.runResidency(args, rec.deps));
      expect(r.result).toBe(1);
      expect(r.stderr).toContain("residency force-unload: --reason <text> is required");
      expect(rec.calls).toEqual([]);
      expect(rec.nodes).toEqual([]);
    }

    const longReason = setupResidency({});
    const r3 = await withCapturedIo(() =>
      residency.runResidency(
        ["force-unload", "w1", "--reason", "x".repeat(201), "--node", "gpu1", "--yes"],
        longReason.deps,
      ),
    );
    expect(r3.result).toBe(1);
    expect(r3.stderr).toContain("residency force-unload: --reason must be at most 200 characters");
    expect(longReason.calls).toEqual([]);
    expect(longReason.nodes).toEqual([]);

    const noWorkload = setupResidency({});
    const r4 = await withCapturedIo(() =>
      residency.runResidency(["force-unload"], noWorkload.deps),
    );
    expect(r4.result).toBe(1);
    expect(r4.stderr).toContain("force-unload <workload>");
    expect(noWorkload.calls).toEqual([]);
    expect(noWorkload.nodes).toEqual([]);
  });

  test("an idle unload reports zero revocations and no audit row", async () => {
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyForceUnload.mutate": (): Promise<unknown> =>
        Promise.resolve({ ...FORCE_UNLOAD_OK, revoked: [] }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(forceUnloadArgs(), rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("revoked 0 lease(s); no lease audit row written");
  });
});

describe("bin residency routing", () => {
  const BIN = join(import.meta.dir, "../src/bin.ts");

  function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: tmp,
        DEV_STORAGE: tmp,
        LLAMACTL_RESIDENCY_STORE: join(tmp, "rs.sqlite"),
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test(
    "llamactl residency --help prints residency usage",
    () => {
      const r = runBin(["residency", "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("llamactl residency status --node <name> [--json]");
    },
    CLI_SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "llamactl --help lists the residency command",
    () => {
      const r = runBin(["--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("llamactl residency status --node <name>");
    },
    CLI_SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "llamactl residency bogus reports an unknown residency subcommand",
    () => {
      const r = runBin(["residency", "bogus"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Unknown residency subcommand: bogus");
      expect(r.stderr).not.toContain("Unknown command: residency");
    },
    CLI_SPAWN_TEST_TIMEOUT_MS,
  );
});

describe("inert default", () => {
  test("describe node still reads nodeBudget.query and never residencyStatus", async () => {
    const budget = { budget: 24, reserved: 6, workloads: [] };
    const calls: string[] = [];
    const inputs: unknown[] = [];
    const nodes: string[] = [];
    const client = recordingClient(calls, inputs, {
      "nodeBudget.query": (): Promise<unknown> => Promise.resolve(budget),
    });
    workloadMod.__setWorkloadTestSeams({
      getNodeClientByName: (node: string): NodeClient => {
        nodes.push(node);
        return client;
      },
    });

    const json = await withCapturedIo(() => workloadMod.runDescribe(["node", "gpu1", "--json"]));
    expect(json.result).toBe(0);
    expect(json.stderr).toBe("");
    expect(json.stdout).toBe(`${JSON.stringify(budget, null, 2)}\n`);
    expect(calls).toEqual(["nodeBudget.query"]);
    expect(inputs).toEqual([{ node: "gpu1" }]);
    expect(nodes).toEqual(["gpu1"]);

    const human = await withCapturedIo(() => workloadMod.runDescribe(["node", "gpu1"]));
    expect(human.result).toBe(0);
    expect(human.stdout).toBe(workloadMod.renderNodeBudget(budget));
    expect(calls.every((call) => call === "nodeBudget.query")).toBe(true);
    expect(calls.some((call) => call.includes("residencyStatus"))).toBe(false);
  });

  test("residency status is read-only and issues exactly one query per run", async () => {
    const residency = await loadResidency();
    let handlerCalls = 0;
    const rec = setupResidency({
      "residencyStatus.query": (): Promise<unknown> => {
        handlerCalls += 1;
        return Promise.resolve(OK_STATUS);
      },
    });

    const json = await withCapturedIo(() =>
      residency.runResidency(["status", "--node", "gpu1", "--json"], rec.deps),
    );
    expect(json.result).toBe(0);
    expect(handlerCalls).toBe(1);

    const human = await withCapturedIo(() =>
      residency.runResidency(["status", "--node", "gpu1"], rec.deps),
    );
    expect(human.result).toBe(0);
    expect(handlerCalls).toBe(2);

    expect(rec.calls).toHaveLength(2);
    for (const call of rec.calls) {
      expect(call).toMatch(/^residencyStatus\.query$/);
      expect(call.endsWith(".mutate")).toBe(false);
      expect(call.endsWith(".subscribe")).toBe(false);
    }
  });
});

describe("residency sessions surface", () => {
  const SESSIONS_OK_STATUS: StatusFixture = {
    ...OK_STATUS,
    sessions: {
      status: "available",
      scope: "serving-process",
      idleTimeoutMs: 600000,
      sessions: [
        { sessionId: "sess-1", workload: "wl-a", refs: 1, idleMs: 10, expiresInMs: null },
        { sessionId: "sess-2", workload: "wl-a", refs: 0, idleMs: 500, expiresInMs: 1500 },
      ],
    },
  };

  test("renders the bound sessions section", async () => {
    // Kills: sessions section not rendered.
    const residency = await loadResidency();
    const fixture: StatusFixture = SESSIONS_OK_STATUS;
    const rendered = residency.renderResidencyStatus(fixture);
    expect(rendered).toContain("Sessions:   2 bound (idle timeout 10m 0s; scope: serving-process)");
    expect(rendered).toContain("  wl-a  sess-1  refs 1  in flight");
    expect(rendered).toContain("  wl-a  sess-2  refs 0  expires in 1s");
  });

  test("renders a distinct line per unavailable reason", async () => {
    // Kills: one generic message for every reason.
    const residency = await loadResidency();
    const render = (reason: "NoRegistry" | "SessionsUnknown" | "SnapshotUnsupported"): string => {
      const fixture: StatusFixture = {
        ...OK_STATUS,
        sessions: { status: "unavailable", scope: "serving-process", reason },
      };
      return residency.renderResidencyStatus(fixture);
    };
    expect(render("NoRegistry")).toContain(
      "Sessions:   unavailable (no session registry installed; scope: serving-process)",
    );
    expect(render("SessionsUnknown")).toContain(
      "Sessions:   unavailable (session registry unreadable; scope: serving-process)",
    );
    expect(render("SnapshotUnsupported")).toContain(
      "Sessions:   unavailable (session registry has no snapshot; scope: serving-process)",
    );
  });

  test("renders no Sessions line when the payload has no sessions key", async () => {
    // GUARD — passes at base: pins that payloads without the section (older
    // agents, the no-registry-key builder path) render unchanged.
    const residency = await loadResidency();
    const rendered = residency.renderResidencyStatus(OK_STATUS);
    expect(rendered).not.toContain("Sessions:");
  });

  test("force-unload prints the released session ids", async () => {
    // Kills: renderForceUnload dropping releasedSessions.
    const residency = await loadResidency();
    const rec = setupResidency({
      "residencyForceUnload.mutate": (): Promise<unknown> =>
        Promise.resolve({
          ok: true,
          workload: "w1",
          kind: "modelrun",
          source: "operator",
          reason: "drill",
          revoked: ["w1#1"],
          releasedSessions: ["s1", "s2"],
          stopped: true,
          epoch: 1,
        }),
    });
    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(
        ["force-unload", "w1", "--reason", "drill", "--node", "gpu1", "--yes"],
        rec.deps,
      ),
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Forced unload: released 2 session(s): s1, s2");
  });

  test("force-unload prints no session line when nothing was released", async () => {
    // GUARD — passes at base: pins that an empty or absent releasedSessions
    // never prints a session(s) line.
    const residency = await loadResidency();
    const base = {
      ok: true,
      workload: "w1",
      kind: "modelrun",
      source: "operator",
      reason: "drill",
      revoked: ["w1#1"],
      stopped: true,
      epoch: 1,
    };
    for (const payload of [{ ...base, releasedSessions: [] }, { ...base }]) {
      const rec = setupResidency({
        "residencyForceUnload.mutate": (): Promise<unknown> => Promise.resolve(payload),
      });
      const { result: code, stdout } = await withCapturedIo(() =>
        residency.runResidency(
          ["force-unload", "w1", "--reason", "drill", "--node", "gpu1", "--yes"],
          rec.deps,
        ),
      );
      expect(code).toBe(0);
      expect(stdout).not.toContain("session(s)");
    }
  });

  test("help names the sessions section", async () => {
    // Kills: USAGE status line not naming the sessions section.
    const residency = await loadResidency();
    const rec = setupResidency({});
    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["--help"], rec.deps));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("bound sessions (refs, idle-timeout expiry)");
  });
});

// #519: `llamactl residency evict-idle` / `release-idle` — RED tests pinning
// the operator-enforced idle eviction CLI. evict-idle is dry-run by default:
// one residencyEvictIdle.mutate { node } reports the window and rows; --yes
// stamps each targeted LOCAL manifest with the durable idle-evicted-at hold
// (deps.now) BEFORE the wet mutate, then keeps the hold only on rows that
// come back "evicted" — a skipped/refused/failed row or a thrown mutate
// clears it. Workloads without a local manifest are never targeted and
// render "skipped NotHeld". release-idle clears the hold through the
// reconciler's clearIdleEvictionHold. At the pinned base the residency
// command knows neither subcommand, so every case fails BY ASSERTION on the
// recorded calls, stdout/stderr text or the on-disk annotation — never by
// import, type or exit-code error.
describe("residency evict-idle / release-idle", () => {
  const IDLE_EVICTED_AT = "llamactl.io/idle-evicted-at";
  const STAMP_ISO = "1970-01-12T13:46:40.000Z";
  const NOW_MS = 1_000_000_000;

  type EvictIdleKind = "modelrun" | "modelhost";
  type EvictIdleRow = {
    workload: string;
    action: "would-evict" | "evicted" | "skipped";
    kind?: EvictIdleKind;
    idleSinceMs?: number;
    dueAtMs?: number;
    reason?: string;
    detail?: string;
  };
  type EvictIdleResult =
    | { ok: false; reason: string }
    | { ok: true; dryRun: boolean; windowSeconds: number; rows: EvictIdleRow[] };

  type EvictIdleDeps = ResidencyDeps & {
    workloadsDir?: string;
    now?: () => Date;
  };

  let evictDir = "";
  let savedEnv: Record<string, string | undefined> = {};

  const ENV_KEYS = ["LLAMACTL_WORKLOADS_DIR", "LLAMACTL_CONFIG", "DEV_STORAGE"] as const;

  beforeEach(() => {
    evictDir = join(tmp, "workloads");
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, {
      LLAMACTL_WORKLOADS_DIR: evictDir,
      LLAMACTL_CONFIG: join(tmp, "config-missing"),
      DEV_STORAGE: join(tmp, "dev"),
    });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  function writeRun(name: string, annotations?: Record<string, string>): void {
    workloadStore.saveWorkload(
      workloadSchema.ModelRunSchema.parse({
        apiVersion: "llamactl/v1",
        kind: "ModelRun",
        metadata: {
          name,
          ...(annotations === undefined ? {} : { annotations }),
        },
        spec: {
          node: "local",
          enabled: true,
          restartPolicy: "Always",
          target: { kind: "rel", value: `${name}/missing.gguf` },
        },
      }),
      evictDir,
    );
  }

  function idleAnnotation(name: string): string | undefined {
    try {
      return workloadStore.loadWorkloadByName(name, evictDir).metadata.annotations[IDLE_EVICTED_AT];
    } catch {
      return undefined;
    }
  }

  function dryResult(rows: EvictIdleRow[]): EvictIdleResult {
    return { ok: true, dryRun: true, windowSeconds: 600, rows };
  }

  function wetResult(rows: EvictIdleRow[]): EvictIdleResult {
    return { ok: true, dryRun: false, windowSeconds: 600, rows };
  }

  function wouldEvict(workload: string): EvictIdleRow {
    return {
      workload,
      action: "would-evict",
      kind: "modelrun",
      idleSinceMs: NOW_MS - 660_000,
      dueAtMs: NOW_MS - 60_000,
    };
  }

  interface EvictIdleRecording extends ResidencyRecording {
    deps: EvictIdleDeps;
  }

  function evictIdleSetup(
    handlers: Record<string, (input: unknown) => Promise<unknown>>,
  ): EvictIdleRecording {
    const rec = setupResidency(handlers);
    const deps: EvictIdleDeps = {
      getNodeClientByName: rec.deps.getNodeClientByName,
      workloadsDir: evictDir,
      now: () => new Date(NOW_MS),
    };
    return { ...rec, deps };
  }

  function evictIdleMutate(script: {
    dry: EvictIdleResult;
    wet?: EvictIdleResult | Error;
    onWet?: (input: { node: string; targets?: unknown }) => void;
  }): Record<string, (input: unknown) => Promise<unknown>> {
    return {
      "residencyEvictIdle.mutate": (input: unknown): Promise<unknown> => {
        const i = input as { node: string; targets?: unknown };
        if (i.targets === undefined) return Promise.resolve(script.dry);
        script.onWet?.(i);
        if (script.wet instanceof Error) return Promise.reject(script.wet);
        return Promise.resolve(script.wet ?? wetResult([]));
      },
    };
  }

  test("C1: evict-idle without --yes makes one dry mutate and stamps nothing", async () => {
    // kills: defaulting to wet, calling mutate twice, or stamping on dry run.
    writeRun("w1");
    const residency = await loadResidency();
    const rec = evictIdleSetup(evictIdleMutate({ dry: dryResult([wouldEvict("w1")]) }));

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual(["residencyEvictIdle.mutate"]);
    expect(rec.inputs).toEqual([{ node: "gpu1" }]);
    expect(stdout).toContain("Idle eviction (dry run): window 600s");
    expect(stdout).toContain("  w1  would-evict  modelrun");
    expect(idleAnnotation("w1")).toBeUndefined();
  });

  test("C2: --yes stamps the hold before the wet mutate and keeps it on evicted", async () => {
    // kills: stamping after the mutate, clearing on success, or skipping the
    // dry preview call.
    writeRun("w1");
    let stampSeenInWet: string | undefined;
    const residency = await loadResidency();
    const rec = evictIdleSetup(
      evictIdleMutate({
        dry: dryResult([wouldEvict("w1")]),
        wet: wetResult([{ workload: "w1", action: "evicted", kind: "modelrun" }]),
        onWet: () => {
          stampSeenInWet = idleAnnotation("w1");
        },
      }),
    );

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual(["residencyEvictIdle.mutate", "residencyEvictIdle.mutate"]);
    expect(rec.inputs).toEqual([
      { node: "gpu1" },
      { node: "gpu1", targets: [{ workload: "w1", kind: "modelrun" }] },
    ]);
    expect(stampSeenInWet).toBe(STAMP_ISO);
    expect(idleAnnotation("w1")).toBe(STAMP_ISO);
    expect(stdout).toContain("Idle eviction: window 600s");
    expect(stdout).toContain("  w1  evicted  modelrun");
  });

  test("C3: a StopRefused wet row clears the stamped hold afterwards", async () => {
    // kills: keeping the hold on a refused stop (the workload still runs).
    writeRun("w1");
    const residency = await loadResidency();
    const rec = evictIdleSetup(
      evictIdleMutate({
        dry: dryResult([wouldEvict("w1")]),
        wet: wetResult([
          {
            workload: "w1",
            action: "skipped",
            reason: "StopRefused",
            detail: "SessionsActive: s1",
          },
        ]),
      }),
    );

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("  w1  skipped  StopRefused  SessionsActive: s1");
    expect(idleAnnotation("w1")).toBeUndefined();
  });

  test("C4: a throwing wet mutate clears the stamped hold and exits 1", async () => {
    // kills: leaving the hold stamped when the stop never completed.
    writeRun("w1");
    const residency = await loadResidency();
    const rec = evictIdleSetup(
      evictIdleMutate({
        dry: dryResult([wouldEvict("w1")]),
        wet: new Error("boom"),
      }),
    );

    const { result: code, stderr } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], rec.deps),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency evict-idle: boom");
    expect(idleAnnotation("w1")).toBeUndefined();
  });

  test("C5: a would-evict workload with no local manifest is never targeted", async () => {
    // kills: targeting remote/absent manifests, or rendering would-evict for
    // a workload the CLI cannot hold.
    writeRun("w1");
    const residency = await loadResidency();
    const rec = evictIdleSetup(
      evictIdleMutate({
        dry: dryResult([wouldEvict("w1"), wouldEvict("w3")]),
        wet: wetResult([{ workload: "w1", action: "evicted", kind: "modelrun" }]),
      }),
    );

    const wet = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], rec.deps),
    );
    expect(wet.result).toBe(0);
    expect(wet.stdout).toContain("w3  skipped  NotHeld");
    expect(rec.inputs[1]).toEqual({
      node: "gpu1",
      targets: [{ workload: "w1", kind: "modelrun" }],
    });

    // Dry mode renders the same NotHeld row and never mutates.
    const dryRec = evictIdleSetup(
      evictIdleMutate({ dry: dryResult([wouldEvict("w1"), wouldEvict("w3")]) }),
    );
    const dry = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1"], dryRec.deps),
    );
    expect(dry.result).toBe(0);
    expect(dry.stdout).toContain("w3  skipped  NotHeld");
    expect(dryRec.calls).toEqual(["residencyEvictIdle.mutate"]);

    // No local target left: the wet mutate is never called.
    const noneRec = evictIdleSetup(evictIdleMutate({ dry: dryResult([wouldEvict("w3")]) }));
    const none = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], noneRec.deps),
    );
    expect(none.result).toBe(0);
    expect(none.stdout).toContain("w3  skipped  NotHeld");
    expect(noneRec.calls).toEqual(["residencyEvictIdle.mutate"]);
    expect(noneRec.inputs).toEqual([{ node: "gpu1" }]);
  });

  test("C6: an ok:false dry result exits 1 and writes nothing to disk", async () => {
    // kills: exiting 0 on a refused run, or stamping before the dry answer.
    writeRun("w1");
    const before = readFileSync(join(evictDir, "w1.yaml"), "utf8");
    const residency = await loadResidency();
    const rec = evictIdleSetup(evictIdleMutate({ dry: { ok: false, reason: "Disabled" } }));

    const { result: code, stderr } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1"], rec.deps),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency evict-idle: Disabled\n");
    expect(stderr).not.toContain("Disabled:");
    expect(readFileSync(join(evictDir, "w1.yaml"), "utf8")).toBe(before);
  });

  test("C7: any StopFailed wet row makes the exit 1", async () => {
    // kills: exiting 0 when a stop attempt failed.
    writeRun("w1");
    const residency = await loadResidency();
    const rec = evictIdleSetup(
      evictIdleMutate({
        dry: dryResult([wouldEvict("w1")]),
        wet: wetResult([
          { workload: "w1", action: "skipped", reason: "StopFailed", detail: "boom" },
        ]),
      }),
    );

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--yes"], rec.deps),
    );

    expect(code).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("StopFailed");
  });

  test("C8: --json prints the dry-run payload", async () => {
    // kills: printing the rendered text under --json.
    writeRun("w1");
    const payload = dryResult([wouldEvict("w1")]);
    const residency = await loadResidency();
    const rec = evictIdleSetup(evictIdleMutate({ dry: payload }));

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "gpu1", "--json"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(payload);
  });

  test("C9: --node is required and --node all is refused", async () => {
    // kills: falling back to a default node or fanning out to all.
    const residency = await loadResidency();

    const missing = evictIdleSetup({});
    const m = await withCapturedIo(() => residency.runResidency(["evict-idle"], missing.deps));
    expect(m.result).toBe(1);
    expect(m.stderr).toContain("residency evict-idle: --node <name> is required");
    expect(missing.calls).toEqual([]);

    const all = evictIdleSetup({});
    const a = await withCapturedIo(() =>
      residency.runResidency(["evict-idle", "--node", "all"], all.deps),
    );
    expect(a.result).toBe(1);
    expect(a.stderr).toContain("residency evict-idle: --node all is not supported; name one node");
    expect(all.calls).toEqual([]);
  });

  test("C10: help names both new subcommands", async () => {
    // kills: USAGE not documenting the new verbs.
    const residency = await loadResidency();
    const rec = setupResidency({});
    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => residency.runResidency(["--help"], rec.deps));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("evict-idle --node <name> [--yes] [--json]");
    expect(stdout).toContain("release-idle <workload> [--json]");
  });

  test("C11: release-idle clears a held manifest and reports the outcomes", async () => {
    // kills: release-idle not clearing the annotation, or misreporting a
    // manifest that was never held / never existed.
    writeRun("w1", { [IDLE_EVICTED_AT]: STAMP_ISO });
    const residency = await loadResidency();
    const rec = evictIdleSetup({});

    const first = await withCapturedIo(() =>
      residency.runResidency(["release-idle", "w1"], rec.deps),
    );
    expect(first.result).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("released idle hold on w1");
    expect(idleAnnotation("w1")).toBeUndefined();

    const second = await withCapturedIo(() =>
      residency.runResidency(["release-idle", "w1"], rec.deps),
    );
    expect(second.result).toBe(0);
    expect(second.stdout).toContain("w1 has no idle hold");

    const missing = await withCapturedIo(() =>
      residency.runResidency(["release-idle", "nope"], rec.deps),
    );
    expect(missing.result).toBe(1);
    expect(missing.stderr).toContain("residency release-idle: no ModelRun or ModelHost named nope");
  });
});
