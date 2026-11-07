// packages/remote/test/dispatch/dispatcher-forwarding.test.ts
// Issue frozename/llamactl#410 (plan P7-A) — ports the two surviving
// cases from the deleted Electron dispatcher test
// (packages/app/test/dispatcher.test.ts) onto the host-agnostic
// buildDispatchRouter in @llamactl/remote: a real agent on loopback
// plus a temp kubeconfig, and a spy pinned-fetch factory recording
// every outbound client build. Local targets must run in-process and
// never build a remote client; TLS server-identity changes must bust
// the cached pinned client.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  __resetDispatchClientCacheForTests,
  buildDispatchRouter,
  type ClusterNode,
  config as kubecfg,
  makePinnedFetch,
  type PinnedFetch,
} from "../../src/index.js";
import { type Cluster, makeCluster } from "../helpers.js";

let cluster: Cluster | null = null;
let previousConfig: string | undefined;

beforeAll(async () => {
  cluster = await makeCluster({ nodes: [{ name: "remote1" }] });
  previousConfig = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;
  // Cluster startup does real TLS cert generation + an agent-server bind; on a
  // loaded CI runner that occasionally exceeds 60s. A generous budget keeps the
  // one-time setup off the per-test clock without masking a real hang.
}, 120_000);

afterAll(async () => {
  if (previousConfig === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  else process.env["LLAMACTL_CONFIG"] = previousConfig;
  await cluster?.cleanup();
});

function fetchInputLabel(input: Parameters<PinnedFetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Dispatch-router caller in "local" (fail-open) mode: the selected node
 * comes from ctx.node (null here), so the kubeconfig's defaultNode
 * decides. The fetch factory records every outbound URL — fetches mean
 * forwarding happened; no fetches means the local caller ran.
 */
type DispatchCaller = ReturnType<ReturnType<typeof buildDispatchRouter>["createCaller"]>;

function dispatchCaller(urls: string[]): DispatchCaller {
  __resetDispatchClientCacheForTests();
  const router = buildDispatchRouter({
    fetchFactory: (node: ClusterNode): PinnedFetch => {
      const inner = makePinnedFetch(node);
      return async (input, init) => {
        urls.push(fetchInputLabel(input));
        return await inner(input, init);
      };
    },
    nodeFromCtx: (ctx: { node?: string | null }): string | null => ctx.node ?? null,
    onUnresolvable: "local",
  });
  return router.createCaller({ node: null });
}

describe("dispatch router forwarding", () => {
  test("falls through locally when default is local", async () => {
    const c = cluster!;
    kubecfg.saveConfig(
      kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), "local"),
      c.clusterConfigPath,
    );
    const urls: string[] = [];
    const caller = dispatchCaller(urls);
    const res = await caller.env();
    expect(res).toBeTruthy();
    expect(urls.length).toBe(0);
  }, 15_000);
});

test("dispatch preserves TLS server identity and invalidates cached clients when it changes", async () => {
  const c = cluster!;
  kubecfg.saveConfig(
    kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), "remote1"),
    c.clusterConfigPath,
  );
  __resetDispatchClientCacheForTests();
  const seen: (string | undefined)[] = [];
  const router = buildDispatchRouter({
    fetchFactory: (node: ClusterNode): PinnedFetch => {
      seen.push(node.tlsServerName);
      return makePinnedFetch(node);
    },
    nodeFromCtx: (ctx: { node?: string | null }): string | null => ctx.node ?? null,
    onUnresolvable: "local",
  });
  const caller = router.createCaller({ node: null });
  for (const identity of ["localhost", "127.0.0.1"]) {
    const cfg = kubecfg.setDefaultNode(kubecfg.loadConfig(c.clusterConfigPath), "remote1");
    for (const clusterNode of cfg.clusters) {
      const node = clusterNode.nodes.find((n) => n.name === "remote1");
      if (node) node.tlsServerName = identity;
    }
    kubecfg.saveConfig(cfg, c.clusterConfigPath);
    await caller.env();
  }
  expect(seen).toEqual(["localhost", "127.0.0.1"]);
});
