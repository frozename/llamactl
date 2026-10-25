import { describe, expect, test } from "bun:test";

import {
  assertTokenReplaceable,
  TokenConflictError,
  upsertNode,
} from "../../src/config/kubeconfig.js";
import { type ClusterNode, type Config, freshConfig } from "../../src/config/schema.js";

/**
 * The context user's bearer authenticates every remote agent node,
 * so replacing it to onboard one node silently cuts off the others.
 * assertTokenReplaceable is the single gate both `node add` and
 * POST /register consult before writing a new token.
 */

const CLUSTER = "home";
const USER = "me";
const LOCAL_TOKEN = "inproc-local";

function configWith(nodes: ClusterNode[], users?: Config["users"]): Config {
  let cfg = freshConfig();
  if (users) cfg = { ...cfg, users };
  for (const node of nodes) cfg = upsertNode(cfg, CLUSTER, node);
  return cfg;
}

const remoteAgent: ClusterNode = {
  name: "mac-mini",
  endpoint: "https://mac-mini.lan:7843",
  certificateFingerprint: "sha256:" + "a".repeat(64),
};

describe("assertTokenReplaceable", () => {
  test("incoming token equal to the current one passes", () => {
    const cfg = configWith([remoteAgent]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, LOCAL_TOKEN, "gpu2");
    }).not.toThrow();
  });

  test("different token with a remote agent node throws, naming the node", () => {
    const cfg = configWith([remoteAgent]);
    let caught: unknown;
    try {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-b", "gpu2");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TokenConflictError);
    const err = caught as TokenConflictError;
    expect(err.nodes).toEqual(["mac-mini"]);
    expect(err.userName).toBe(USER);
    expect(err.message).toContain(USER);
    expect(err.message).toContain("mac-mini");
  });

  test("inproc local, gateway, cloud, rag and provider nodes are ignored", () => {
    const cfg = configWith([
      {
        name: "gw",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
      {
        name: "openai",
        endpoint: "",
        cloud: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      },
      {
        name: "kb",
        endpoint: "",
        kind: "rag",
        rag: { provider: "chroma", endpoint: "chroma-mcp", extraArgs: [] },
      },
      {
        name: "gw.sirius-up",
        endpoint: "",
        provider: { gateway: "gw", providerName: "sirius-up" },
      },
    ]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-b", "gpu2");
    }).not.toThrow();
  });

  test("the node being re-added is ignored", () => {
    const cfg = configWith([remoteAgent]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-b", "mac-mini");
    }).not.toThrow();
  });

  test("a tokenRef is resolved through env and compared", () => {
    const cfg = configWith([remoteAgent], [{ name: USER, tokenRef: "env:TOK" }]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-a", "gpu2", { TOK: "tok-a" });
    }).not.toThrow();
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-b", "gpu2", { TOK: "tok-a" });
    }).toThrow(TokenConflictError);
  });

  test("an unresolvable tokenRef means no current token and does not throw", () => {
    const cfg = configWith([remoteAgent], [{ name: USER, tokenRef: "env:TOK" }]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, USER, "tok-b", "gpu2", {});
    }).not.toThrow();
  });

  test("a missing user passes", () => {
    const cfg = configWith([remoteAgent]);
    expect(() => {
      assertTokenReplaceable(cfg, CLUSTER, "ghost", "tok-b", "gpu2");
    }).not.toThrow();
  });
});
