import { type ClusterNode, LOCAL_NODE_ENDPOINT } from "@llamactl/core/config/schema";
import { describe, expect, test } from "bun:test";

import { makePinnedFetch } from "../src/client/links.js";

const FAKE_CERT = "-----BEGIN CERTIFICATE-----\nMIIBxxx\n-----END CERTIFICATE-----\n";

function makeNode(overrides: {
  name: string;
  endpoint: string;
  certificate?: string;
}): ClusterNode {
  return overrides;
}

describe("makePinnedFetch", () => {
  test("throws for a remote node with no certificate", () => {
    const node = makeNode({ name: "gpu1", endpoint: "https://10.0.0.1:7843" });
    expect(() => makePinnedFetch(node)).toThrow(
      "node 'gpu1' has no pinned certificate; refusing to connect",
    );
  });

  test("throws for any non-loopback remote endpoint with no certificate", () => {
    const node = makeNode({ name: "remote", endpoint: "https://myhost.example.com:7843" });
    expect(() => makePinnedFetch(node)).toThrow(/no pinned certificate/);
  });

  test("returns a function (does not throw) when node has a certificate", () => {
    const node = makeNode({
      name: "gpu1",
      endpoint: "https://10.0.0.1:7843",
      certificate: FAKE_CERT,
    });
    const fn = makePinnedFetch(node);
    expect(typeof fn).toBe("function");
  });

  test("does not throw for inproc local node with no certificate", () => {
    const node = makeNode({ name: "local", endpoint: LOCAL_NODE_ENDPOINT });
    expect(() => makePinnedFetch(node)).not.toThrow();
  });

  test("does not throw for localhost endpoint with no certificate", () => {
    const node = makeNode({ name: "local", endpoint: "https://localhost:7843" });
    expect(() => makePinnedFetch(node)).not.toThrow();
  });

  test("does not throw for 127.0.0.1 endpoint with no certificate", () => {
    const node = makeNode({ name: "local", endpoint: "https://127.0.0.1:7843" });
    expect(() => makePinnedFetch(node)).not.toThrow();
  });

  test("does not throw for [::1] endpoint with no certificate", () => {
    const node = makeNode({ name: "local", endpoint: "https://[::1]:7843" });
    expect(() => makePinnedFetch(node)).not.toThrow();
  });
});
