import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnv } from "../../core/src/env.js";
import { workloadRuntimeDir } from "../../core/src/workloadRuntime.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runDelete,
} from "../src/commands/workload.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-delete-workload-"));
  process.env.LLAMACTL_WORKLOADS_DIR = join(tmp, "workloads");
  process.env.LOCAL_AI_RUNTIME_DIR = join(tmp, "runtime");
  mkdirSync(process.env.LLAMACTL_WORKLOADS_DIR, { recursive: true });
  mkdirSync(process.env.LOCAL_AI_RUNTIME_DIR, { recursive: true });
});

afterEach(() => {
  __resetWorkloadTestSeams();
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = stdoutOrig;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = stderrOrig;
    });
}

test("delete workload removes ModelHost manifest and runtime dir", async () => {
  const manifestPath = join(process.env.LLAMACTL_WORKLOADS_DIR!, "mlx-host.yaml");
  writeFileSync(
    manifestPath,
    [
      "apiVersion: llamactl/v1",
      "kind: ModelHost",
      "metadata:",
      "  name: mlx-host",
      "spec:",
      "  enabled: true",
      "  node: local",
      "  engine: omlx",
      "  binary: /tmp/omlx",
      "  endpoint:",
      "    host: 127.0.0.1",
      "    port: 8094",
      "  hostedModels:",
      "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
      "  extraArgs: []",
      "  timeoutSeconds: 60",
      "",
    ].join("\n"),
    "utf8",
  );

  const runtimeDir = workloadRuntimeDir(resolveEnv(), { name: "mlx-host" });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "modelhost.state"), '{"state":"running"}\n', "utf8");

  let stopCalls = 0;
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStop: {
          mutate: async () => {
            stopCalls++;
            return { ok: true };
          },
        },
      }) as any,
  });

  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedIo(() => runDelete(["workload", "mlx-host"]));

  expect(code).toBe(0);
  expect(stopCalls).toBe(1);
  expect(stdout).toContain("stopped modelhost on node local");
  expect(stdout).toContain("deleted modelhost/mlx-host");
  expect(stderr).toBe("");
  expect(() => readFileSync(manifestPath, "utf8")).toThrow();
  expect(() => readFileSync(join(runtimeDir, "modelhost.state"), "utf8")).toThrow();
});
