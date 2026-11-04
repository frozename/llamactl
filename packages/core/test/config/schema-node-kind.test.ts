/**
 * Pin resolveNodeKind rules for explicit kind, provider/cloud blocks,
 * and fallback to 'agent'.
 *
 * Part of #335
 */

import { describe, expect, test } from "bun:test";

import { type ClusterNode, resolveNodeKind } from "../../src/config/schema.js";

function node(partial: Partial<ClusterNode>): ClusterNode {
  return partial as ClusterNode;
}

describe("resolveNodeKind", () => {
  test("explicit kind 'agent' wins even when a cloud block is present", () => {
    const result = resolveNodeKind(
      node({
        name: "myagent",
        endpoint: "https://agent.lan:7843",
        kind: "agent",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      }),
    );
    expect(result).toBe("agent");
  });

  test("explicit kind 'gateway' is returned as-is", () => {
    const result = resolveNodeKind(
      node({
        name: "mygateway",
        endpoint: "",
        kind: "gateway",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      }),
    );
    expect(result).toBe("gateway");
  });

  test("with no kind and a provider block, result is 'provider'", () => {
    const result = resolveNodeKind(
      node({
        name: "virtual",
        endpoint: "",
        provider: { gateway: "sirius", providerName: "openai" },
      }),
    );
    expect(result).toBe("provider");
  });

  test("with no kind, a provider block beats a cloud block (provider is checked first)", () => {
    const result = resolveNodeKind(
      node({
        name: "mixed",
        endpoint: "",
        provider: { gateway: "sirius", providerName: "openai" },
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      }),
    );
    expect(result).toBe("provider");
  });

  test("with no kind and a cloud block, upstream 'sirius' gives 'gateway'", () => {
    const result = resolveNodeKind(
      node({
        name: "gw",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://localhost:3000/v1" },
      }),
    );
    expect(result).toBe("gateway");
  });

  test("with no kind and a cloud block, upstream 'embersynth' gives 'gateway'", () => {
    const result = resolveNodeKind(
      node({
        name: "gw",
        endpoint: "",
        cloud: { provider: "embersynth", baseUrl: "http://localhost:7777/v1" },
      }),
    );
    expect(result).toBe("gateway");
  });

  test("with no kind and a cloud block, upstream 'openai-compatible' gives 'gateway'", () => {
    const result = resolveNodeKind(
      node({
        name: "gw",
        endpoint: "",
        cloud: { provider: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" },
      }),
    );
    expect(result).toBe("gateway");
  });

  test("with no kind and a cloud block, upstream 'openai' gives 'cloud'", () => {
    const result = resolveNodeKind(
      node({
        name: "cloud-node",
        endpoint: "",
        cloud: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      }),
    );
    expect(result).toBe("cloud");
  });

  test("with no kind and a cloud block, upstream 'anthropic' gives 'cloud'", () => {
    const result = resolveNodeKind(
      node({
        name: "cloud-node",
        endpoint: "",
        cloud: { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
      }),
    );
    expect(result).toBe("cloud");
  });

  test("with no kind and a cloud block, upstream 'groq' gives 'cloud'", () => {
    const result = resolveNodeKind(
      node({
        name: "cloud-node",
        endpoint: "",
        cloud: { provider: "groq", baseUrl: "https://api.groq.com/openai/v1" },
      }),
    );
    expect(result).toBe("cloud");
  });

  test("a node with only name and endpoint gives 'agent'", () => {
    const result = resolveNodeKind(
      node({
        name: "myagent",
        endpoint: "https://agent.lan:7843",
      }),
    );
    expect(result).toBe("agent");
  });
});
