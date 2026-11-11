import { upsertCluster, upsertNode } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ControllerPassState,
  nodeRpcTimeoutsFromConfig,
  type ReconcilePassDeps,
  runReconcilePass,
} from "../src/commands/controller.js";
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
    expect(nextState.oom).toEqual(state.oom);
  });
});
