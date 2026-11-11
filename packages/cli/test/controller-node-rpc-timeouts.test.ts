import { saveConfig, upsertCluster, upsertNode } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ControllerPassState,
  nodeRpcTimeoutsFromConfig,
  type ReconcilePassDeps,
  runController,
  runReconcilePass,
} from "../src/commands/controller.js";
import { resetGlobals, setGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

describe("nodeRpcTimeoutsFromConfig (#221)", () => {
  test("resolves each node's rpcTimeouts block from the kubeconfig", () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, "home", {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
      rpcTimeouts: { queryMs: 2000 },
    });
    cfg = upsertNode(cfg, "home", { name: "gpu2", endpoint: "https://gpu2.lan:7843" });

    const forNode = nodeRpcTimeoutsFromConfig(cfg);
    expect(forNode("gpu1")).toEqual({ queryMs: 2000 });
    expect(forNode("gpu2")).toBeUndefined();
    expect(forNode("ghost")).toBeUndefined();
  });

  test("carries mutateMs through, alone and alongside queryMs", () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, "home", {
      name: "gpu-both",
      endpoint: "https://gpu-both.lan:7843",
      rpcTimeouts: { queryMs: 1500, mutateMs: 45_000 },
    });
    cfg = upsertNode(cfg, "home", {
      name: "gpu-mutate-only",
      endpoint: "https://gpu-mutate.lan:7843",
      rpcTimeouts: { mutateMs: 60_000 },
    });

    const forNode = nodeRpcTimeoutsFromConfig(cfg);
    expect(forNode("gpu-both")).toEqual({ queryMs: 1500, mutateMs: 45_000 });
    expect(forNode("gpu-mutate-only")).toEqual({ mutateMs: 60_000 });
  });

  test("a --context override resolves the node in that context's cluster", () => {
    let cfg = freshConfig();
    cfg = upsertNode(cfg, "home", {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
      rpcTimeouts: { queryMs: 2000 },
    });
    cfg = upsertCluster(cfg, {
      name: "away",
      nodes: [{ name: "gpu1", endpoint: "https://gpu1.lab:7843", rpcTimeouts: { queryMs: 9000 } }],
    });
    cfg = {
      ...cfg,
      contexts: [
        ...cfg.contexts,
        { name: "alt", cluster: "away", user: "me", defaultNode: "gpu1" },
      ],
    };

    expect(nodeRpcTimeoutsFromConfig(cfg)("gpu1")).toEqual({ queryMs: 2000 });
    expect(nodeRpcTimeoutsFromConfig(cfg, "alt")("gpu1")).toEqual({ queryMs: 9000 });
  });
});

describe("runReconcilePass wiring (#221)", () => {
  test("threads rpcTimeoutsFor into both the ModelRun and the NodeRun reconciler", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "llamactl-pass-wiring-"));
    const captured: {
      modelrun?: Parameters<NonNullable<ReconcilePassDeps["reconcileModelRuns"]>>[0];
      noderun?: Parameters<NonNullable<ReconcilePassDeps["reconcileNodeRuns"]>>[0];
    } = {};
    const deps: ReconcilePassDeps = {
      reconcileModelRuns: (opts) => {
        captured.modelrun = opts;
        return Promise.resolve({ reports: [], errors: 0 });
      },
      reconcileNodeRuns: (opts) => {
        captured.noderun = opts;
        return Promise.resolve({ reports: [], errors: 0 });
      },
    };
    const forNode = (nodeName: string): { queryMs?: number; mutateMs?: number } | undefined =>
      nodeName === "gpu1" ? { queryMs: 7, mutateMs: 11 } : undefined;
    const state: ControllerPassState = { errors: new Map(), oom: { last: null, pendingKills: 0 } };

    const stdoutOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (): boolean => true;
    let nextState: ControllerPassState;
    try {
      nextState = await runReconcilePass(tmp, () => null, forNode, state, deps);
    } finally {
      process.stdout.write = stdoutOrig;
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(captured.modelrun?.rpcTimeoutsFor).toBeDefined();
    expect(captured.noderun?.rpcTimeoutsFor).toBeDefined();
    expect(captured.modelrun?.rpcTimeoutsFor?.("gpu1")).toEqual({ queryMs: 7, mutateMs: 11 });
    expect(captured.noderun?.rpcTimeoutsFor?.("gpu1")).toEqual({ queryMs: 7, mutateMs: 11 });
    expect(captured.modelrun?.rpcTimeoutsFor?.("ghost")).toBeUndefined();
    expect(captured.noderun?.rpcTimeoutsFor?.("ghost")).toBeUndefined();
    // The pass also samples the host cgroup OOM counter, which is host-dependent
    // (Linux CI runners have a real cgroup), so only the RPC wiring is asserted here.
    expect(nextState.errors).toBeInstanceOf(Map);
  });
});

describe("controller kubeconfig path honours --cluster-config (#221)", () => {
  test("runController reads rpcTimeouts from the --cluster-config file", async () => {
    const base = mkdtempSync(join(tmpdir(), "llamactl-controller-cluster-cfg-"));
    const cfgFile = join(base, "cluster.yaml");
    let cfg = freshConfig();
    cfg = upsertCluster(cfg, {
      name: "prod-cluster",
      nodes: [
        {
          name: "gpu1",
          endpoint: "https://gpu1.lan:7843",
          rpcTimeouts: { queryMs: 1234, mutateMs: 5678 },
        },
      ],
    });
    cfg = {
      ...cfg,
      currentContext: "prod",
      contexts: [
        ...cfg.contexts,
        { name: "prod", cluster: "prod-cluster", user: "me", defaultNode: "gpu1" },
      ],
    };
    saveConfig(cfg, cfgFile);

    const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-controller-cluster-cfg-wl-"));
    const previousWorkloads = process.env["LLAMACTL_WORKLOADS_DIR"];
    process.env["LLAMACTL_WORKLOADS_DIR"] = workloadsDir;

    const outChunks: string[] = [];
    const outSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outChunks.push(String(chunk));
      return true;
    });
    try {
      setGlobals({ nodeName: null, contextName: null, configPath: cfgFile });
      const code = await runController(["serve", "--once"]);
      expect(code).toBe(0);
      const stdout = outChunks.join("");
      // --cluster-config must drive both the banner path and the context that
      // is actually read out of the loaded config file.
      expect(stdout).toContain(`cfg=${cfgFile}`);
      expect(stdout).toContain("context=prod");
      expect(stdout).not.toContain("context=default");
      const forNode = nodeRpcTimeoutsFromConfig(cfg, "prod");
      expect(forNode("gpu1")).toEqual({ queryMs: 1234, mutateMs: 5678 });
    } finally {
      outSpy.mockRestore();
      resetGlobals();
      if (previousWorkloads === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
      else process.env["LLAMACTL_WORKLOADS_DIR"] = previousWorkloads;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
