import type { NodeClient } from "@llamactl/remote";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEnv } from "../../core/src/env.js";
import { workloadRuntimeDir } from "../../core/src/workloadRuntime.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runDelete,
} from "../src/commands/workload.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-delete-workload-"));
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  mkdirSync(process.env["LLAMACTL_WORKLOADS_DIR"], { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
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

test("delete workload removes ModelHost manifest and runtime dir", async () => {
  const manifestPath = join(process.env["LLAMACTL_WORKLOADS_DIR"]!, "mlx-host.yaml");
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
          // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
          mutate: async () => {
            stopCalls++;
            return { ok: true };
          },
        },
      }) as unknown as NodeClient,
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

test("delete workload keeps manifest and runtime state when the remote refuses to stop", async () => {
  // A refused stop means the remote could not prove the recorded pid's
  // identity — deleting the manifest would orphan a possibly-live process.
  const manifestPath = join(process.env["LLAMACTL_WORKLOADS_DIR"]!, "mlx-host.yaml");
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
  writeFileSync(join(runtimeDir, "modelhost.pid"), "1234\n", "utf8");

  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStop: {
          // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
          mutate: async () => ({ ok: false, error: "pid identity unknown" }),
        },
      }) as unknown as NodeClient,
  });

  const { result: code, stderr } = await withCapturedIo(() => runDelete(["workload", "mlx-host"]));

  expect(code).toBe(1);
  expect(stderr).toContain("pid identity unknown");
  expect(readFileSync(manifestPath, "utf8")).toContain("mlx-host");
  expect(readFileSync(join(runtimeDir, "modelhost.state"), "utf8")).toContain("running");
  expect(readFileSync(join(runtimeDir, "modelhost.pid"), "utf8")).toContain("1234");
});

// #221: resolves "settled" when `work` settles first, or "stalled" after `limitMs`. The bound only
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

interface HungServerReply {
  state: "up";
  rel: string;
  pid: number;
}

test("delete workload: a ModelRun whose node never answers the status query is removed with a warning (#221)", async () => {
  const manifestPath = join(process.env["LLAMACTL_WORKLOADS_DIR"]!, "z13-run.yaml");
  writeFileSync(
    manifestPath,
    [
      "apiVersion: llamactl/v1",
      "kind: ModelRun",
      "metadata:",
      "  name: z13-run",
      "spec:",
      "  node: z13",
      "  target:",
      "    kind: rel",
      "    value: models/demo.gguf",
      "",
    ].join("\n"),
    "utf8",
  );

  // The status query stays pending until release(), like a node that suspended mid-call.
  let release = (): void => undefined;
  const hung = new Promise<void>((resolve): void => {
    release = (): void => {
      resolve();
    };
  });
  let stopCalls = 0;
  __setWorkloadTestSeams({
    getNodeClientByName: (): NodeClient =>
      ({
        serverStatus: {
          query: (): Promise<HungServerReply> =>
            hung.then((): HungServerReply => ({ state: "up", rel: "models/demo.gguf", pid: 99 })),
        },
        serverStop: {
          mutate: (): Promise<{ stopped: boolean }> => {
            stopCalls++;
            return Promise.resolve({ stopped: true });
          },
        },
      }) as unknown as NodeClient,
    nodeQueryTimeoutMs: 1,
  });

  const pending = withCapturedIo(() => runDelete(["workload", "z13-run"]));
  const outcome = await settledWithin(pending, 2_000);
  release();
  const { result: code, stdout, stderr } = await pending;

  expect(outcome).toBe("settled");
  expect(code).toBe(0);
  expect(stopCalls).toBe(0);
  expect(stderr).toBe("warning: failed to reach node z13: node 'z13' did not answer within 1 ms\n");
  expect(stdout).toBe("deleted modelrun/z13-run\n");
  expect(() => readFileSync(manifestPath, "utf8")).toThrow();
});
