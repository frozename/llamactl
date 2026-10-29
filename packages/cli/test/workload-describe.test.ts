import type { NodeClient } from "@llamactl/remote";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runDescribe,
} from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseJsonRecord } from "./helpers.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-describe-workload-"));
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
});

afterEach(() => {
  __resetWorkloadTestSeams();
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

async function withCapturedIo<T>(
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
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = stdoutOrig;
    process.stderr.write = stderrOrig;
  }
}

function writeManifest(name: string, lines: string[]): void {
  writeFileSync(
    join(process.env["LLAMACTL_WORKLOADS_DIR"]!, `${name}.yaml`),
    `${lines.join("\n")}\n`,
    "utf8",
  );
}

function writeModelHost(): void {
  writeManifest("mlx-host", [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    "  name: mlx-host",
    "spec:",
    "  node: local",
    "  engine: omlx",
    "  binary: /opt/omlx/bin/omlx",
    "  endpoint:",
    "    host: 127.0.0.1",
    "    port: 8094",
    "  hostedModels:",
    "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
    "  extraArgs: [--max-tokens, '512']",
  ]);
}

interface StatusCalls {
  modelHost: string[];
  server: string[];
}

function seamClient(calls: StatusCalls): void {
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStatus: {
          query: ({ workload }: { workload: string }) => {
            calls.modelHost.push(workload);
            return Promise.resolve({ state: "Running", pid: 4242, specHash: "abc" });
          },
        },
        serverStatus: {
          query: ({ workload }: { workload: string }) => {
            calls.server.push(workload);
            return Promise.resolve({ state: "up", rel: "m.gguf", pid: 99 });
          },
        },
      }) as unknown as NodeClient,
  });
}

function writeModelHostOn(name: string, node: string): void {
  writeManifest(name, [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  node: ${node}`,
    "  engine: omlx",
    "  binary: /opt/omlx/bin/omlx",
    "  endpoint:",
    "    host: 127.0.0.1",
    "    port: 8094",
    "  hostedModels:",
    "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
  ]);
}

function writeModelRunOn(name: string, node: string): void {
  writeManifest(name, [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  node: ${node}`,
    "  target:",
    "    kind: rel",
    "    value: m.gguf",
  ]);
}

function writeNodeRunOn(name: string, node: string): void {
  writeManifest(name, [
    "apiVersion: llamactl/v1",
    "kind: NodeRun",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  node: ${node}`,
    "  infra:",
    "    - pkg: llama-cpp",
    "      version: b4500",
  ]);
}

interface HungHostReply {
  state: "Running";
  pid: number;
}

interface HungServerReply {
  state: "up";
  rel: string;
  pid: number;
}

interface HungBudgetReply {
  budget: number;
  reserved: number;
  workloads: string[];
}

// #221: every status query stays pending until release(), like a node that suspended mid-call.
// release() only lets the test finish cleanly. With the deadline, describe has already returned by then.
function stubHungClient(): { release: () => void } {
  let open = (): void => undefined;
  const hung = new Promise<void>((resolve): void => {
    open = (): void => {
      resolve();
    };
  });
  __setWorkloadTestSeams({
    getNodeClientByName: (): NodeClient =>
      ({
        modelHostStatus: {
          query: (): Promise<HungHostReply> =>
            hung.then((): HungHostReply => ({ state: "Running", pid: 4242 })),
        },
        serverStatus: {
          query: (): Promise<HungServerReply> =>
            hung.then((): HungServerReply => ({ state: "up", rel: "m.gguf", pid: 99 })),
        },
        nodeBudget: {
          query: (): Promise<HungBudgetReply> =>
            hung.then((): HungBudgetReply => ({ budget: 16, reserved: 0, workloads: [] })),
        },
        infraList: {
          query: (): Promise<string[]> => hung.then((): string[] => []),
        },
      }) as unknown as NodeClient,
    nodeQueryTimeoutMs: 1,
  });
  return {
    release: (): void => {
      open();
    },
  };
}

// Resolves "settled" when `work` settles first, or "stalled" after `limitMs`. The bound only
// turns a hang into an assertion failure; with the 1 ms deadline the work settles far sooner.
async function settledWithin(
  work: Promise<unknown>,
  limitMs: number,
): Promise<"settled" | "stalled"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<"stalled">((resolve): void => {
    timer = setTimeout((): void => {
      resolve("stalled");
    }, limitMs);
  });
  try {
    return await Promise.race([work.then((): "settled" => "settled"), stall]);
  } finally {
    clearTimeout(timer);
  }
}

test("describe workload prints ModelHost fields and modelHostStatus", async () => {
  writeModelHost();
  const calls: StatusCalls = { modelHost: [], server: [] };
  seamClient(calls);

  const { result, stdout, stderr } = await withCapturedIo(() =>
    runDescribe(["workload", "mlx-host"]),
  );

  expect(stderr).toBe("");
  expect(result).toBe(0);
  expect(calls).toEqual({ modelHost: ["mlx-host"], server: [] });
  expect(stdout).toContain("Name:       mlx-host");
  expect(stdout).toContain("Kind:       ModelHost");
  expect(stdout).toContain("Node:       local");
  expect(stdout).toContain("Engine:     omlx");
  expect(stdout).toContain("Binary:     /opt/omlx/bin/omlx");
  expect(stdout).toContain("Models:     mlx-community/Qwen3-8B-MLX-4bit");
  expect(stdout).toContain("Endpoint:   127.0.0.1:8094");
  expect(stdout).toContain("ExtraArgs:  --max-tokens 512");
  expect(stdout).toContain('"state": "Running"');
  expect(stdout).toContain('"pid": 4242');
});

test("describe workload prints persisted ModelHost conditions", async () => {
  writeModelHost();
  const runtime = {
    conditions: [
      {
        type: "ReconcileError",
        status: "True",
        reason: "ApplyFailed",
        message: "strata run-config --native must be A; got B",
        firstSeen: "2026-10-21T14:07:00.000Z",
        lastSeen: "2026-10-21T14:22:00.000Z",
        lastTransitionTime: "2026-10-21T14:07:00.000Z",
        count: 90,
      },
    ],
    restarts: 2,
    lastRestartAt: "2026-10-21T14:02:30.000Z",
    lastRestartReason: "EngineExited",
  };
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", runtime }) },
      }) as unknown as NodeClient,
  });

  const { result, stdout } = await withCapturedIo(() => runDescribe(["workload", "mlx-host"]));

  expect(result).toBe(0);
  expect(stdout).toContain("Restarts:   2 (last 2026-10-21T14:02:30.000Z, EngineExited)\n");
  expect(stdout).toContain(
    "Conditions:\n  ReconcileError=True ApplyFailed x90 first 2026-10-21T14:07:00.000Z last 2026-10-21T14:22:00.000Z\n    strata run-config --native must be A; got B\n",
  );
});

test("describe workload --json returns the ModelHost manifest and live status", async () => {
  writeModelHost();
  const calls: StatusCalls = { modelHost: [], server: [] };
  seamClient(calls);

  const { result, stdout } = await withCapturedIo(() =>
    runDescribe(["workload", "mlx-host", "--json"]),
  );

  expect(result).toBe(0);
  const parsed = parseJsonRecord(stdout);
  expect(parsed["manifest"]).toMatchObject({ kind: "ModelHost", metadata: { name: "mlx-host" } });
  expect(parsed["liveStatus"]).toEqual({ state: "Running", pid: 4242, specHash: "abc" });
});

test("describe workload still uses serverStatus for a ModelRun", async () => {
  writeManifest("gemma-qa", [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    "  name: gemma-qa",
    "spec:",
    "  node: local",
    "  target:",
    "    kind: rel",
    "    value: m.gguf",
  ]);
  const calls: StatusCalls = { modelHost: [], server: [] };
  seamClient(calls);

  const { result, stdout } = await withCapturedIo(() => runDescribe(["workload", "gemma-qa"]));

  expect(result).toBe(0);
  expect(calls).toEqual({ modelHost: [], server: ["gemma-qa"] });
  expect(stdout).toContain("Target:     rel:m.gguf");
  expect(stdout).toContain('"state": "up"');
});

test("describe workload --json: a ModelHost whose node never answers reports the deadline error (#221)", async () => {
  writeModelHostOn("z13-host", "z13");
  const stub = stubHungClient();

  const pending = withCapturedIo(() => runDescribe(["workload", "z13-host", "--json"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result, stdout } = await pending;

  expect(outcome).toBe("settled");
  expect(result).toBe(0);
  const parsed = parseJsonRecord(stdout);
  expect(parsed["manifest"]).toMatchObject({ kind: "ModelHost", metadata: { name: "z13-host" } });
  expect(parsed["liveStatus"]).toEqual({ error: "node 'z13' did not answer within 1 ms" });
});

test("describe workload --json: a ModelRun whose node never answers reports the deadline error (#221)", async () => {
  writeModelRunOn("z13-run", "z13");
  const stub = stubHungClient();

  const pending = withCapturedIo(() => runDescribe(["workload", "z13-run", "--json"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result, stdout } = await pending;

  expect(outcome).toBe("settled");
  expect(result).toBe(0);
  const parsed = parseJsonRecord(stdout);
  expect(parsed["manifest"]).toMatchObject({ kind: "ModelRun", metadata: { name: "z13-run" } });
  expect(parsed["liveStatus"]).toEqual({ error: "node 'z13' did not answer within 1 ms" });
});

test("help: DESCRIBE_USAGE documents the 10 s node query deadline (#221)", async () => {
  const { result, stdout } = await withCapturedIo(() => runDescribe(["workload", "x", "--help"]));

  expect(result).toBe(0);
  expect(stdout).toContain("10 s deadline");
});

test("describe noderun --json: a node that never answers reports the deadline error in liveInfra (#221)", async () => {
  writeNodeRunOn("z13-infra", "z13");
  const stub = stubHungClient();

  const pending = withCapturedIo(() => runDescribe(["noderun", "z13-infra", "--json"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result, stdout } = await pending;

  expect(outcome).toBe("settled");
  expect(result).toBe(0);
  const parsed = parseJsonRecord(stdout);
  expect(parsed["manifest"]).toMatchObject({
    kind: "NodeRun",
    metadata: { name: "z13-infra" },
    spec: { node: "z13" },
  });
  expect(parsed["liveInfra"]).toEqual({ error: "node 'z13' did not answer within 1 ms" });
});

test("describe node: a node that never answers prints the deadline error and exits 1 (#221)", async () => {
  const stub = stubHungClient();

  const pending = withCapturedIo(() => runDescribe(["node", "z13"]));
  const outcome = await settledWithin(pending, 2_000);
  stub.release();
  const { result, stdout, stderr } = await pending;

  expect(outcome).toBe("settled");
  expect(result).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("describe: node 'z13' did not answer within 1 ms\n");
});

test("help: DESCRIBE_USAGE documents the describe node deadline (#221)", async () => {
  const { result, stdout } = await withCapturedIo(() => runDescribe(["node", "x", "--help"]));

  expect(result).toBe(0);
  expect(stdout).toContain("describe node prints the error and exits 1");
});
