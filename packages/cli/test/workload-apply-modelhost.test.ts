import type { NodeClient } from "@llamactl/remote";

import { readModelHostState } from "@llamactl/core/engines/state";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runApply,
} from "../src/commands/workload.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-modelhost-"));
  process.env["DEV_STORAGE"] = join(tmp, "dev");
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
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

function writeManifest(options?: { node?: string; binary?: string }): string {
  const manifestPath = join(tmp, "mlx-host.yaml");
  writeFileSync(
    manifestPath,
    [
      "apiVersion: llamactl/v1",
      "kind: ModelHost",
      "metadata:",
      "  name: mlx-host",
      "spec:",
      "  enabled: true",
      `  node: ${options?.node ?? "local"}`,
      "  engine: omlx",
      `  binary: ${options?.binary ?? join(tmp, "omlx")}`,
      "  resources:",
      // Small reservation: the apply path admits against the default node
      // budget (75% of the test machine's RAM), which is ~5 GiB on CI runners.
      "    expectedMemoryGiB: 1",
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
  return manifestPath;
}

function writeLock(pid: number): void {
  writeFileSync(join(process.env["LLAMACTL_WORKLOADS_DIR"]!, ".controller.lock"), String(pid));
}

function stubStartClient(): { startCalls: () => number } {
  let calls = 0;
  __setWorkloadTestSeams({
    getNodeClientByName: () =>
      ({
        modelHostStart: {
          subscribe: (
            _input: unknown,
            cb: { onData: (evt: unknown) => void; onComplete: () => void },
          ) => {
            calls++;
            queueMicrotask(() => {
              cb.onData({ type: "done", result: { ok: true, pid: 3333, state: "Running" } });
              cb.onComplete();
            });
            return { unsubscribe: (): void => undefined };
          },
        },
        modelHostStatus: {
          // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
          query: async () => ({ state: "Running", pid: 3333 }),
        },
      }) as unknown as NodeClient,
  });
  return { startCalls: () => calls };
}

test("apply hands a local ModelHost to the running controller without spawning", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  const manifestPath = writeManifest();
  writeLock(process.pid);
  let clientCalls = 0;
  __setWorkloadTestSeams({
    getNodeClientByName: () => {
      clientCalls++;
      throw new Error("no node client may be used after handoff");
    },
  });

  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(code).toBe(0);
  expect(clientCalls).toBe(0);
  expect(existsSync(join(process.env["LLAMACTL_WORKLOADS_DIR"]!, "mlx-host.yaml"))).toBe(true);
  expect(readModelHostState({ name: "mlx-host" })).toBeNull();
  expect(stdout).toContain(`controller pid=${String(process.pid)}`);
  expect(stderr).toBe("");
});

test("apply handoff with --json reports the controller pid", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  const manifestPath = writeManifest();
  writeLock(process.pid);
  __setWorkloadTestSeams({
    getNodeClientByName: () => {
      throw new Error("no node client may be used after handoff");
    },
  });

  const { result: code, stdout } = await withCapturedIo(() =>
    runApply(["-f", manifestPath, "--json"]),
  );

  expect(code).toBe(0);
  const payload = JSON.parse(stdout) as { action: string; controllerPid: number };
  expect(payload.action).toBe("handed-off");
  expect(payload.controllerPid).toBe(process.pid);
});

test("apply handoff validates the engine spec and fails without a client call", async () => {
  const manifestPath = writeManifest({ binary: join(tmp, "missing-omlx") });
  writeLock(process.pid);
  let clientCalls = 0;
  __setWorkloadTestSeams({
    getNodeClientByName: () => {
      clientCalls++;
      throw new Error("no node client may be used after handoff");
    },
  });

  const { result: code, stderr } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(code).toBe(1);
  expect(stderr).toContain("binary not found");
  expect(clientCalls).toBe(0);
});

test("apply without a controller still starts in-process and warns about the cgroup", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  const manifestPath = writeManifest();
  const { startCalls } = stubStartClient();

  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(code).toBe(0);
  expect(startCalls()).toBe(1);
  expect(stdout).toContain("ModelHost ready at");
  expect(stderr).toContain("no controller is running");
});

test("apply with a stale controller lock falls back to in-process start", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  const manifestPath = writeManifest();
  writeLock(4_294_967_290);
  const { startCalls } = stubStartClient();

  const {
    result: code,
    stdout,
    stderr,
  } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(code).toBe(0);
  expect(startCalls()).toBe(1);
  expect(stdout).toContain("ModelHost ready at");
  expect(stderr).toContain("no controller is running");
});

test("apply for a remote node ignores the local controller lock", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  const manifestPath = writeManifest({ node: "gpu1" });
  writeLock(process.pid);
  const { startCalls } = stubStartClient();

  const { result: code, stderr } = await withCapturedIo(() => runApply(["-f", manifestPath]));

  expect(code).toBe(0);
  expect(startCalls()).toBe(1);
  expect(stderr).not.toContain("no controller");
});
