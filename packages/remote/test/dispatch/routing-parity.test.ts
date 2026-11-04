/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- RED contract tests for #410 P2a: the dispatch surface is not exported yet, so every test reaches it through the untyped `api()` shim and fails on its expects rather than on an import error or a TypeError. */
// Issue frozename/llamactl#410 (plan P2a) — routing parity for the dispatcher
// extracted into @llamactl/remote, modelled on
// packages/app/test/dispatcher.test.ts: a real agent on loopback plus a temp
// kubeconfig, a spy pinned-fetch factory recording every outbound URL. In
// "local" (fail-open) mode, control-plane procedures run in-process and
// node-routed calls forward over pinned TLS when defaultNode is remote.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import * as remote from "../../src/index.js";
import { type Cluster, makeCluster } from "../helpers.js";

/**
 * The P2a surface under test does not exist on the module yet; reaching it
 * through the namespace keeps module evaluation safe and turns every RED
 * failure into a failed expect here, never an import error or a TypeError.
 */
function api(): any {
  expect(typeof remote.resolveDispatchTarget).toBe("function");
  expect(typeof remote.buildDispatchRouter).toBe("function");
  expect(typeof remote.__resetDispatchClientCacheForTests).toBe("function");
  expect(typeof remote.DispatchResolutionError).toBe("function");
  return remote as any;
}

let cluster: Cluster | null = null;
let previousConfig: string | undefined;
let urls: string[] = [];

beforeAll(async () => {
  cluster = await makeCluster({ nodes: [{ name: "remote1" }] });
  previousConfig = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = cluster.clusterConfigPath;
  const cfg = remote.config.loadConfig();
  remote.config.saveConfig(remote.config.setDefaultNode(cfg, "remote1"));
  // Cluster startup does real TLS cert generation + an agent-server bind; a
  // generous budget keeps the one-time setup off the per-test clock.
}, 120_000);

afterAll(async () => {
  if (previousConfig === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
  else process.env["LLAMACTL_CONFIG"] = previousConfig;
  await cluster?.cleanup();
});

/**
 * Build a dispatch-router caller in "local" (Electron-parity) mode whose
 * pinned-fetch factory records every URL it is asked to open. The node is
 * taken from the kubeconfig's defaultNode (remote1, set in beforeAll).
 */
function dispatchCaller(r: any): any {
  r.__resetDispatchClientCacheForTests();
  urls = [];
  return r
    .buildDispatchRouter({
      fetchFactory: (node: remote.ClusterNode): remote.PinnedFetch => {
        const inner = remote.makePinnedFetch(node);
        return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          urls.push(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          return await inner(input, init);
        };
      },
      nodeFromCtx: (): null => null,
      onUnresolvable: "local",
    })
    .createCaller({ node: null });
}

describe("dispatch router routing parity", () => {
  test("workloadList runs on the control plane even when defaultNode is remote", async () => {
    const r = api();
    const caller = dispatchCaller(r);
    await caller.workloadList();
    expect(urls.length).toBe(0);
  }, 15_000);

  test("serverStatus forwards to the remote default node over pinned TLS", async () => {
    const r = api();
    const caller = dispatchCaller(r);
    await caller.serverStatus({ workload: "test-workload" });
    const nodeUrl = cluster!.nodes[0]!.url;
    expect(urls.some((u) => u.includes(nodeUrl) && u.includes("/trpc/serverStatus"))).toBe(true);
  }, 15_000);

  test("serverLogs subscription forwards to the remote default node", async () => {
    const r = api();
    const caller = dispatchCaller(r);
    const iterable = (await caller.serverLogs({
      workload: "test-workload",
      lines: 0,
      follow: false,
    })) as AsyncIterable<unknown>;
    for await (const _event of iterable) {
      // Drain the stream so the remote subscription completes.
    }
    expect(urls.some((u) => u.includes("/trpc/serverLogs"))).toBe(true);
  }, 15_000);
});
