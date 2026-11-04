/**
 * Pin resolveNode virtual-node synthesis, context/user resolution,
 * error cases, and setDefaultNode behaviour.
 *
 * Part of #335
 */

import { describe, expect, test } from "bun:test";

import { resolveNode, setDefaultNode, upsertNode } from "../../src/config/kubeconfig.js";
import { type Config, freshConfig } from "../../src/config/schema.js";

const CLUSTER = "home";

function buildConfig(nodes: Config["clusters"][number]["nodes"]): Config {
  let config = freshConfig();
  for (const node of nodes) {
    config = upsertNode(config, CLUSTER, node);
  }
  return config;
}

describe("resolveNode", () => {
  test("virtual node from gateway fanout: sirius.openai returns provider-kind node", () => {
    const config = buildConfig([
      {
        name: "sirius",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
      {
        name: "gpu1",
        endpoint: "https://gpu1.lan:7843",
      },
    ]);

    const result = resolveNode(config, "sirius.openai");

    expect(result.node.name).toBe("sirius.openai");
    expect(result.node.endpoint).toBe("");
    expect(result.node.kind).toBe("provider");
    expect(result.node.provider).toEqual({
      gateway: "sirius",
      providerName: "openai",
    });
    // provider.source is NOT set for gateway-fanout flavour (only "cli" source)
    expect((result.node.provider as { source?: string }).source).toBeUndefined();
  });

  test("returned context and user match the current context's context and user", () => {
    const config = buildConfig([
      {
        name: "sirius",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
    ]);

    const result = resolveNode(config, "sirius.openai");

    expect(result.context.name).toBe("default");
    expect(result.context.cluster).toBe("home");
    expect(result.context.user).toBe("me");
    expect(result.user.name).toBe("me");
  });

  test("trailing dot: sirius. throws not found in cluster home", () => {
    const config = buildConfig([
      {
        name: "sirius",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
    ]);

    let caught: unknown;
    try {
      resolveNode(config, "sirius.");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not found in cluster 'home'/);
  });

  test("leading dot: .openai throws not found", () => {
    const config = buildConfig([]);

    let caught: unknown;
    try {
      resolveNode(config, ".openai");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not found/);
  });

  test("unknown parent: nosuch.openai throws not found", () => {
    const config = buildConfig([
      {
        name: "sirius",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
    ]);

    let caught: unknown;
    try {
      resolveNode(config, "nosuch.openai");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not found/);
  });

  test("parent is an agent with no cloud and no matching cli binding: gpu1.openai throws not found", () => {
    const config = buildConfig([
      {
        name: "gpu1",
        endpoint: "https://gpu1.lan:7843",
      },
    ]);

    let caught: unknown;
    try {
      resolveNode(config, "gpu1.openai");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not found/);
  });

  test("direct match wins over virtual: explicit sirius.openai node returns that node", () => {
    const config = buildConfig([
      {
        name: "sirius",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      },
      {
        name: "sirius.openai",
        endpoint: "https://x.lan:7843",
      },
    ]);

    const result = resolveNode(config, "sirius.openai");

    expect(result.node.name).toBe("sirius.openai");
    expect(result.node.endpoint).toBe("https://x.lan:7843");
    expect(result.node.kind).not.toBe("provider");
  });

  test("explicit contextName resolves using that context", () => {
    const base = buildConfig([
      {
        name: "gpu1",
        endpoint: "https://gpu1.lan:7843",
      },
    ]);

    // Add a second context
    const expanded = {
      ...base,
      contexts: [
        ...base.contexts,
        { name: "alt", cluster: "home", user: "me", defaultNode: "local" },
      ],
    };

    const result = resolveNode(expanded, "gpu1", "alt");

    expect(result.context.name).toBe("alt");
    expect(result.context.cluster).toBe("home");
    expect(result.context.user).toBe("me");
    // current context is still "default"
    expect(expanded.currentContext).toBe("default");
  });

  test("resolveNode with missing contextName throws context not found", () => {
    const config = buildConfig([
      {
        name: "gpu1",
        endpoint: "https://gpu1.lan:7843",
      },
    ]);

    let caught: unknown;
    try {
      resolveNode(config, "gpu1", "missing");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/context 'missing' not found/);
  });

  test("context whose cluster is absent throws cluster not found", () => {
    const base = buildConfig([]);
    const modified = {
      ...base,
      contexts: [
        ...base.contexts,
        { name: "ghostctx", cluster: "ghost", user: "me", defaultNode: "local" },
      ],
    };

    let caught: unknown;
    try {
      resolveNode(modified, "local", "ghostctx");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/cluster 'ghost' not found/);
  });

  test("context whose user is absent throws user not found", () => {
    const base = freshConfig();
    // Replace the default context with one that references a non-existent user
    const modified = {
      ...base,
      contexts: [{ name: "default", cluster: "home", user: "ghost", defaultNode: "local" }],
    };

    let caught: unknown;
    try {
      resolveNode(modified, "local");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/user 'ghost' not found/);
  });
});

describe("setDefaultNode", () => {
  test("setDefaultNode sets defaultNode on the current context only", () => {
    let config = freshConfig();
    config = upsertNode(config, CLUSTER, {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
    });
    // Add a second context that stays untouched
    config = {
      ...config,
      contexts: [
        ...config.contexts,
        { name: "alt", cluster: "home", user: "me", defaultNode: "remote-node" },
      ],
    };

    const result = setDefaultNode(config, "gpu1");

    // Current context's defaultNode is updated
    expect(result.contexts.find((c) => c.name === "default")?.defaultNode).toBe("gpu1");
    // Second context's defaultNode is unchanged
    expect(result.contexts.find((c) => c.name === "alt")?.defaultNode).toBe("remote-node");
  });

  test("input config object is not mutated", () => {
    let config = freshConfig();
    config = upsertNode(config, CLUSTER, {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
    });

    const originalDefaultNode = config.contexts[0]?.defaultNode ?? "local";

    setDefaultNode(config, "gpu1");

    // Original context's defaultNode stays "local"
    expect(config.contexts[0]?.defaultNode).toBe(originalDefaultNode);
  });

  test("setDefaultNode with unknown node throws node not found", () => {
    const config = freshConfig();

    let caught: unknown;
    try {
      setDefaultNode(config, "nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/node 'nope' not found in cluster 'home'/);
  });

  test("current context pointing at an absent cluster throws cluster not found", () => {
    let config = freshConfig();
    config = {
      ...config,
      contexts: [{ name: "default", cluster: "ghost", user: "me", defaultNode: "local" }],
    };

    let caught: unknown;
    try {
      setDefaultNode(config, "local");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/cluster 'ghost' not found/);
  });

  test("setDefaultNode does NOT accept a virtual name: sirius.openai throws", () => {
    let config = freshConfig();
    config = upsertNode(config, CLUSTER, {
      name: "sirius",
      endpoint: "",
      cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
    });

    let caught: unknown;
    try {
      setDefaultNode(config, "sirius.openai");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not found/);
  });
});
