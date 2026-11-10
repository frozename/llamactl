import { upsertNode } from "@llamactl/core/config/kubeconfig";
import { type Config, freshConfig } from "@llamactl/core/config/schema";
import { describe, expect, test } from "bun:test";

import * as controller from "../src/commands/controller.js";

type NodeRpcTimeoutsForNode = (
  nodeName: string,
) => { queryMs?: number; mutateMs?: number } | undefined;

describe("nodeRpcTimeoutsFromConfig (#221)", () => {
  test("resolves each node's rpcTimeouts block from the kubeconfig", () => {
    const fn = (controller as Record<string, unknown>)["nodeRpcTimeoutsFromConfig"];
    expect(typeof fn).toBe("function");
    if (typeof fn !== "function") return;
    const fromConfig = fn as (config: Config) => NodeRpcTimeoutsForNode;

    let cfg = freshConfig();
    cfg = upsertNode(cfg, "home", {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
      rpcTimeouts: { queryMs: 2000 },
    });
    cfg = upsertNode(cfg, "home", { name: "gpu2", endpoint: "https://gpu2.lan:7843" });

    const forNode = fromConfig(cfg);
    expect(forNode("gpu1")).toEqual({ queryMs: 2000 });
    expect(forNode("gpu2")).toBeUndefined();
    expect(forNode("ghost")).toBeUndefined();
  });
});
