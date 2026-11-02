import { readModelHostState } from "@llamactl/core/engines/state";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * Pins the router-side handoff for frozename/llamactl#216.
 *
 * The CLI's `apply -f` already hands an enabled local ModelHost to a live
 * controller (`.controller.lock` in the workloads dir) so the engine is
 * spawned under the controller's service rather than the caller's cgroup.
 * Without the same check, `workloadApply` would start the host in-process,
 * stranding the engine in the caller's lifecycle scope. These cases pin
 * the router-side handoff: validate the spec, persist the manifest,
 * report the controller pid, spawn nothing.
 */

let tmp = "";
let workloadsDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-apply-handoff-"));
  process.env["DEV_STORAGE"] = join(tmp, "dev");
  process.env["LLAMACTL_CONFIG"] = join(tmp, "no-such-kubeconfig.yaml");
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(tmp, "workloads");
  process.env["LOCAL_AI_RUNTIME_DIR"] = join(tmp, "runtime");
  // An ambient models dir would let the in-process launch past
  // prepareLaunch into a real spawn attempt; stripping it keeps the
  // current code's failure cheap and the run hermetic.
  Reflect.deleteProperty(process.env, "LLAMACTL_MODELS_DIR");
  Reflect.deleteProperty(process.env, "LLAMA_CPP_MODELS");
  workloadsDir = process.env["LLAMACTL_WORKLOADS_DIR"];
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(process.env["LOCAL_AI_RUNTIME_DIR"], { recursive: true });
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function modelHostYaml(): string {
  return [
    "apiVersion: llamactl/v1",
    "kind: ModelHost",
    "metadata:",
    "  name: mlx-host",
    "spec:",
    "  enabled: true",
    "  node: local",
    "  engine: omlx",
    `  binary: ${join(tmp, "omlx")}`,
    "  resources:",
    "    expectedMemoryGiB: 1",
    "  endpoint:",
    "    host: 127.0.0.1",
    "    port: 8094",
    "  hostedModels:",
    "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
    "  extraArgs: []",
    "  timeoutSeconds: 2",
    "",
  ].join("\n");
}

// The lock must name a live pid in a process other than this one;
// process.ppid satisfies both without spawning a dummy holder.
function writeLiveControllerLock(): void {
  writeFileSync(join(workloadsDir, ".controller.lock"), String(process.ppid));
}

test("workloadApply hands an enabled local ModelHost to a live controller in another process", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  writeLiveControllerLock();
  const caller = router.createCaller({});

  const res = await caller.workloadApply({ yaml: modelHostYaml() }).catch((e: unknown) => e);

  expect((res as { action: string }).action).toBe("handed-off");
  expect((res as { controllerPid: number }).controllerPid).toBe(process.ppid);
  expect((res as { name: string }).name).toBe("mlx-host");
  expect((res as { node: string }).node).toBe("local");
}, 15_000);

test("handoff persists the manifest and never spawns", async () => {
  writeFileSync(join(tmp, "omlx"), "", "utf8");
  writeLiveControllerLock();
  const caller = router.createCaller({});

  const res = await caller.workloadApply({ yaml: modelHostYaml() }).catch((e: unknown) => e);

  const savedPath = join(workloadsDir, "mlx-host.yaml");
  expect((res as { path: string }).path).toBe(savedPath);
  expect(existsSync(savedPath)).toBe(true);
  expect(readModelHostState({ name: "mlx-host" })).toBeNull();
  expect((res as { status: { phase: string } }).status.phase).toBe("Pending");
}, 15_000);
