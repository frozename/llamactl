import { type ClusterNode, config as kubecfg } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  __resetActiveNodeOverrideForTests,
  __resetPeerClientFactoryForTests,
  __setPeerClientFactoryForTests,
  buildDispatcherRouter,
} from "../../../electron/trpc/dispatcher.js";

type Config = ReturnType<typeof kubecfg.loadConfig>;
type OpsSearchResult = {
  hits: { id: string; query: string; originNode?: string }[];
  unreachableNodes: string[];
};
type LogsSearchResult = {
  hits: { line: string; query: string; originNode?: string }[];
  unreachableNodes: string[];
};
type CrossNodeCaller = {
  uiCrossNodeOpsSessionSearch: (input: { query: string }) => Promise<OpsSearchResult>;
  uiCrossNodeLogsSearch: (input: { query: string }) => Promise<LogsSearchResult>;
};

describe("UI Cross-Node Dispatcher Procedures", () => {
  beforeEach(() => {
    __resetPeerClientFactoryForTests();
    __resetActiveNodeOverrideForTests();
    const config: Config = {
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user: "me", defaultNode: "local" }],
      clusters: [
        {
          name: "home",
          nodes: [
            { name: "local", endpoint: "https://127.0.0.1:7843" },
            { name: "mac-mini", endpoint: "https://192.168.68.76:7843", kind: "agent" },
            { name: "linux-box", endpoint: "https://192.168.68.77:7843", kind: "agent" },
          ],
        },
      ],
      users: [{ name: "me", token: "abc" }],
    };
    spyOn(kubecfg, "loadConfig").mockReturnValue(config);
  });

  afterEach(() => {
    __resetPeerClientFactoryForTests();
    __resetActiveNodeOverrideForTests();
    mock.restore();
  });

  test("uiCrossNodeOpsSessionSearch fans out to remote agent nodes", async () => {
    const hitsCalled: string[] = [];

    __setPeerClientFactoryForTests((node: ClusterNode) => {
      const nodeName = node.name;
      return {
        opsSessionSearch: {
          query: (input: { query: string }) => {
            hitsCalled.push(nodeName);
            return Promise.resolve({ hits: [{ id: `session-${nodeName}`, query: input.query }] });
          },
        },
      };
    });

    const router = buildDispatcherRouter();
    const caller = router.createCaller({}) as unknown as CrossNodeCaller;

    const result: OpsSearchResult = await caller.uiCrossNodeOpsSessionSearch({ query: "test" });

    expect(hitsCalled.sort()).toEqual(["linux-box", "mac-mini"]);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.id).sort()).toEqual(["session-linux-box", "session-mac-mini"]);
    expect(result.unreachableNodes).toEqual([]);
  });

  test("uiCrossNodeLogsSearch fans out to remote agent nodes", async () => {
    const hitsCalled: string[] = [];

    __setPeerClientFactoryForTests((node: ClusterNode) => {
      const nodeName = node.name;
      return {
        logsSearch: {
          query: (input: { query: string }) => {
            hitsCalled.push(nodeName);
            return Promise.resolve({ hits: [{ line: `log-${nodeName}`, query: input.query }] });
          },
        },
      };
    });

    const router = buildDispatcherRouter();
    const caller = router.createCaller({}) as unknown as CrossNodeCaller;

    const result: LogsSearchResult = await caller.uiCrossNodeLogsSearch({ query: "error" });

    expect(hitsCalled.sort()).toEqual(["linux-box", "mac-mini"]);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.line).sort()).toEqual(["log-linux-box", "log-mac-mini"]);
    expect(result.unreachableNodes).toEqual([]);
  });
});
