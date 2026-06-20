import type { ClusterNode } from "@llamactl/remote";

import { describe, expect, test } from "bun:test";

import { makeNodePinnedFetch } from "../../../electron/trpc/node-pinned-fetch";

describe("makeNodePinnedFetch", () => {
  test("refuses remote agent nodes without a pinned certificate", () => {
    const node: ClusterNode = {
      name: "gpu1",
      endpoint: "https://gpu1.example.test:7443",
    };

    expect(() => makeNodePinnedFetch(node)).toThrow(
      "node 'gpu1' has no pinned certificate; refusing to connect",
    );
  });

  test("allows loopback nodes without a pinned certificate", () => {
    const node: ClusterNode = {
      name: "dev-agent",
      endpoint: "http://127.0.0.1:7843",
    };

    expect(() => makeNodePinnedFetch(node)).not.toThrow();
  });
});
