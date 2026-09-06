import { writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { listLocalRoutes } from "@llamactl/core/workloadRuntime";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";
import { parseWorkload, saveWorkload } from "../src/workload/store.js";

/**
 * E.4 — `workloadList` returns a per-row summary of each declared
 * ModelRun so the Workloads UI can show a multi-node badge on the row
 * without fetching the full manifest. We assert two new fields are
 * populated from `spec.workers[]`: `workerCount` and `workerNodes`.
 *
 * Scopes the workloads dir under a tempdir via LLAMACTL_WORKLOADS_DIR
 * so the suite never touches ~/.llamactl/workloads/. The procedure
 * also consults the kubeconfig for per-node reachability, but that
 * side-channel is irrelevant to the manifest-derived fields we test
 * here — when the node is unreachable the row still populates the
 * worker summary from the on-disk manifest.
 */
let tmp = "";
const originalEnv = { ...process.env };

const multiNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: llama-70b-split
spec:
  node: coordinator
  target:
    kind: rel
    value: llama-70b.gguf
  workers:
    - node: gpu-worker-1
      rpcHost: 10.0.0.21
      rpcPort: 50052
    - node: gpu-worker-2
      rpcHost: 10.0.0.22
      rpcPort: 50052
  timeoutSeconds: 60
`;

const singleNodeYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-solo
spec:
  node: local
  target:
    kind: rel
    value: gemma.gguf
`;

const modelHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-workload-list-"));
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    // Pin the config lookup to a file that does not exist, so
    // kubecfg.loadConfig returns a fresh empty config and workloadList
    // falls through to "Unreachable" deterministically instead of
    // picking up the dev machine's real ~/.llamactl/config.
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

describe("workloadList", () => {
  test("populates workerCount + workerNodes for multi-node workloads", async () => {
    saveWorkload(parseWorkload(multiNodeYaml), tmp);
    saveWorkload(parseWorkload(singleNodeYaml), tmp);

    const caller = router.createCaller({});
    const rows = await caller.workloadList();

    const byName = Object.fromEntries(rows.map((r) => [r.name, r] as const));

    const multi = byName["llama-70b-split"];
    expect(multi).toBeDefined();
    expect(multi!.workerCount).toBe(2);
    expect(multi!.workerNodes).toEqual(["gpu-worker-1", "gpu-worker-2"]);
    expect(multi!.node).toBe("coordinator");
    expect(multi!.rel).toBe("llama-70b.gguf");

    const solo = byName["gemma-solo"];
    expect(solo).toBeDefined();
    expect(solo!.workerCount).toBe(0);
    expect(solo!.workerNodes).toEqual([]);
  });

  test("includes ModelHost workloads tagged with kind", async () => {
    saveWorkload(parseWorkload(singleNodeYaml), tmp);
    saveModelHost(parseModelHost(modelHostYaml), tmp);

    const caller = router.createCaller({});
    const rows = await caller.workloadList();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r] as const));

    const host = byName["mlx-host"];
    expect(host).toBeDefined();
    expect(host!.kind).toBe("ModelHost");
    expect(host!.node).toBe("local");
    expect(host!.rel).toBe("Qwen3-8B-MLX-4bit");
    // No live state file in the tempdir -> Stopped, not a crash.
    expect(host!.phase).toBe("Stopped");

    // Existing ModelRun rows gain the discriminator too.
    expect(byName["gemma-solo"]!.kind).toBe("ModelRun");
  });
});

describe("workloadList foreign-listener detection", () => {
  function writeServerSidecars(
    runtimeDir: string,
    name: string,
    opts: { recordedPid: number; host: string; port: number; rel: string },
  ): void {
    const dir = join(runtimeDir, "workloads", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "llama-server.pid"), `${String(opts.recordedPid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: opts.rel,
        extraArgs: [],
        host: opts.host,
        port: String(opts.port),
        binary: "/nonexistent/llama-server",
        pid: opts.recordedPid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );
  }

  function workloadYaml(name: string, rel: string): string {
    return `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: ${name}
spec:
  node: local
  target:
    kind: rel
    value: ${rel}
`;
  }

  // A process llamactl does not own is bound to the workload's recorded
  // port: the recorded pid is dead, the endpoint still answers /health,
  // and the pid holding the port is not the recorded one. `get
  // workloads` must not render this as a green Running — the proxy has
  // already dropped the route, so the row has to name the mismatch.
  test("marks the workload Foreign when a foreign process squats the recorded port", async () => {
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const squatterPort = squatter.port;
    if (squatterPort === undefined) throw new Error("squatter did not bind a port");
    const runtimeDir = join(tmp, "runtime");
    Object.assign(process.env, {
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMA_CPP_HOST: "127.0.0.1",
      // Nothing listens on the env-default endpoint — the squatter only
      // holds the port recorded in this workload's sidecar.
      LLAMA_CPP_PORT: "1",
    });
    try {
      saveWorkload(parseWorkload(workloadYaml("squatted", "gemma.gguf")), tmp);
      writeServerSidecars(runtimeDir, "squatted", {
        recordedPid: 999999,
        host: "127.0.0.1",
        port: squatterPort,
        rel: "gemma.gguf",
      });

      const caller = router.createCaller({});
      const rows = await caller.workloadList();
      const row = rows.find((r) => r.name === "squatted");

      expect(row).toBeDefined();
      expect(row!.phase).toBe("Foreign");
      expect(row!.statePid).toBeNull();
      expect(row!.listenerPid).toBe(process.pid);
      // The proxy sees the same reality: the dead recorded pid means the
      // workload has no route. Foreign makes the two views agree.
      expect(listLocalRoutes(resolveEnv())).toHaveLength(0);
    } finally {
      await squatter.stop(true);
    }
  });

  // Same shape but the listener IS the recorded pid: the endpoint answers
  // and the process holding the port is the one llamactl recorded, so the
  // row must stay Running — Foreign is only for pid-vs-listener mismatch.
  test("keeps Running when the recorded live pid owns the answering port", async () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const listenerPort = listener.port;
    if (listenerPort === undefined) throw new Error("listener did not bind a port");
    const runtimeDir = join(tmp, "runtime");
    Object.assign(process.env, {
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: "1",
    });
    try {
      saveWorkload(parseWorkload(workloadYaml("owned", "gemma.gguf")), tmp);
      writeServerSidecars(runtimeDir, "owned", {
        recordedPid: process.pid,
        host: "127.0.0.1",
        port: listenerPort,
        rel: "gemma.gguf",
      });

      const caller = router.createCaller({});
      const rows = await caller.workloadList();
      const row = rows.find((r) => r.name === "owned");

      expect(row).toBeDefined();
      expect(row!.phase).toBe("Running");
      expect(row!.statePid).toBe(process.pid);
      expect(row!.listenerPid).toBe(process.pid);
      expect(listLocalRoutes(resolveEnv())).toHaveLength(1);
    } finally {
      await listener.stop(true);
    }
  });

  // The recorded pid is alive but the port belongs to someone else —
  // the stale-orphan / pid-reuse variant. `state: "up"` alone cannot
  // tell this apart from a healthy server; only the pid-vs-listener
  // comparison can.
  test("marks the workload Foreign when a live recorded pid does not hold the answering port", async () => {
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const squatterPort = squatter.port;
    if (squatterPort === undefined) throw new Error("squatter did not bind a port");
    // A real live pid that is NOT the port listener.
    const decoy = spawn("sleep", ["30"], { stdio: "ignore" });
    const decoyPid = decoy.pid;
    if (decoyPid === undefined) throw new Error("decoy process did not spawn");
    const runtimeDir = join(tmp, "runtime");
    Object.assign(process.env, {
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: "1",
    });
    try {
      saveWorkload(parseWorkload(workloadYaml("reused", "gemma.gguf")), tmp);
      writeServerSidecars(runtimeDir, "reused", {
        recordedPid: decoyPid,
        host: "127.0.0.1",
        port: squatterPort,
        rel: "gemma.gguf",
      });

      const caller = router.createCaller({});
      const rows = await caller.workloadList();
      const row = rows.find((r) => r.name === "reused");

      expect(row).toBeDefined();
      expect(row!.phase).toBe("Foreign");
      expect(row!.statePid).toBe(decoyPid);
      expect(row!.listenerPid).toBe(process.pid);
    } finally {
      decoy.kill("SIGKILL");
      await squatter.stop(true);
    }
  });

  // ModelHost rows share the list surface. A dead recorded pid with the
  // endpoint still answering is the same squatter shape — the row must
  // be Foreign rather than a misleading Stopped/Running.
  test("marks a ModelHost Foreign when its endpoint answers under a foreign pid", async () => {
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    const squatterPort = squatter.port;
    if (squatterPort === undefined) throw new Error("squatter did not bind a port");
    const runtimeDir = join(tmp, "runtime");
    Object.assign(process.env, {
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMA_CPP_HOST: "127.0.0.1",
      LLAMA_CPP_PORT: "1",
    });
    try {
      saveModelHost(parseModelHost(modelHostYaml), tmp);
      writeModelHostState(
        {
          kind: "ModelHost",
          engine: "omlx",
          pid: 999999,
          host: "127.0.0.1",
          port: squatterPort,
          modelAliases: ["Qwen3-8B-MLX-4bit"],
          startedAt: new Date().toISOString(),
        },
        { name: "mlx-host" },
        resolveEnv(),
      );

      const caller = router.createCaller({});
      const rows = await caller.workloadList();
      const row = rows.find((r) => r.name === "mlx-host");

      expect(row).toBeDefined();
      expect(row!.kind).toBe("ModelHost");
      expect(row!.phase).toBe("Foreign");
      expect(row!.statePid).toBeNull();
      expect(row!.listenerPid).toBe(process.pid);
    } finally {
      await squatter.stop(true);
    }
  });
});
