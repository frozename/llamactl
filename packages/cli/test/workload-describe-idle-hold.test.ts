import { type NodeClient, workloadReconciler } from "@llamactl/remote";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runDescribe,
} from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

const ISO = "2026-11-20T10:00:00.000Z";

let tmp = "";
const originalEnv = { ...process.env };

function workloadsDir(): string {
  return join(tmp, "workloads");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-describe-idle-hold-"));
  process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir();
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(workloadsDir(), { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStatus: {
          query: () => Promise.resolve({ state: "Running", pid: 4242, specHash: "abc" }),
        },
        serverStatus: {
          query: () => Promise.resolve({ state: "up", rel: "m.gguf", pid: 99 }),
        },
      }) as unknown as NodeClient,
  });
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
  writeFileSync(join(workloadsDir(), `${name}.yaml`), `${lines.join("\n")}\n`, "utf8");
}

function writeModelRunOn(name: string, node: string, enabled = true): void {
  writeManifest(name, [
    "apiVersion: llamactl/v1",
    "kind: ModelRun",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  node: ${node}`,
    ...(enabled ? [] : ["  enabled: false"]),
    "  target:",
    "    kind: rel",
    "    value: m.gguf",
  ]);
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

test("I1: describe workload prints the idle hold for a held ModelRun only", async () => {
  writeModelRunOn("qwen-idle", "local");
  writeModelRunOn("qwen-busy", "local");
  workloadReconciler.stampIdleEvictionHold("qwen-idle", ISO, workloadsDir());

  const idle = await withCapturedIo(() => runDescribe(["workload", "qwen-idle"]));

  expect(idle.result).toBe(0);
  expect(idle.stdout).toContain(
    "IdleHold:   idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; the controller keeps it down until llamactl residency release-idle qwen-idle\n",
  );

  const busy = await withCapturedIo(() => runDescribe(["workload", "qwen-busy"]));

  expect(busy.result).toBe(0);
  expect(busy.stdout).not.toContain("IdleHold:");
});

test("I2: describe workload prints the idle hold for a held ModelHost", async () => {
  writeModelHostOn("mlx-idle", "local");
  workloadReconciler.stampIdleEvictionHold("mlx-idle", ISO, workloadsDir());

  const { result, stdout } = await withCapturedIo(() => runDescribe(["workload", "mlx-idle"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "IdleHold:   idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; the controller keeps it down until llamactl residency release-idle mlx-idle\n",
  );
});

test("I3: describe workload marks the hold inactive on a disabled ModelRun", async () => {
  writeModelRunOn("qwen-off", "local", false);
  workloadReconciler.stampIdleEvictionHold("qwen-off", ISO, workloadsDir());

  const { result, stdout } = await withCapturedIo(() => runDescribe(["workload", "qwen-off"]));

  expect(result).toBe(0);
  expect(stdout).toContain(
    "IdleHold:   idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; inactive while the workload is disabled\n",
  );
  expect(stdout).not.toContain("the controller keeps it down");
});
