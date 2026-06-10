/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, @typescript-eslint/unbound-method -- Test doubles implement async tool/logger interfaces with synchronous fixtures. */
import { describe, expect, test } from "bun:test";

import { type RunbookToolClient, runRunbook, type ToolCallInput } from "../src/index.js";

/**
 * audit-fleet is read-only; this test uses a mock MCP tool client
 * that returns canned payloads for every expected call. Asserts
 * shape + summary assembly without touching disk.
 */

function makeClient(responses: Record<string, unknown>): {
  client: RunbookToolClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client: RunbookToolClient = {
    async callTool(input: ToolCallInput) {
      calls.push(input.name);
      const payload = responses[input.name];
      if (payload === undefined) throw new Error(`unexpected tool call: ${input.name}`);
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  };
  return { client, calls };
}

describe("audit-fleet runbook", () => {
  test("composes every tool and returns a unified summary", async () => {
    const { client, calls } = makeClient({
      "llamactl.node.ls": {
        context: "default",
        cluster: "home",
        nodes: [
          { name: "local", endpoint: "inproc://local", kind: "agent" },
          { name: "sirius-primary", endpoint: "", kind: "gateway" },
        ],
      },
      "llamactl.promotions.list": [
        { profile: "macbook-pro-48g", preset: "best", rel: "foo/bar-Q4.gguf" },
      ],
      "llamactl.workload.list": { count: 0, workloads: [] },
      "llamactl.server.status": { state: "down" },
      "llamactl.bench.compare": [
        {
          rel: "foo/bar-Q4.gguf",
          class: "reasoning",
          installed: true,
          tuned: { gen_tps: "35.0" },
        },
        {
          rel: "slow/bench.gguf",
          class: "reasoning",
          installed: true,
          tuned: { gen_tps: "5.0" },
        },
        {
          rel: "not-installed/x.gguf",
          class: "reasoning",
          installed: false,
          tuned: { gen_tps: "99.0" },
        },
      ],
    });

    const result = await runRunbook(
      "audit-fleet",
      {},
      {
        log: () => {},
        toolClient: client,
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "llamactl.node.ls",
      "llamactl.promotions.list",
      "llamactl.workload.list",
      "llamactl.server.status",
      "llamactl.bench.compare",
    ]);

    const summary = result.summary as {
      context: string | null;
      cluster: string | null;
      nodes: { name: string; kind: string }[];
      promotions: { rel: string }[];
      workloads: unknown[];
      serverStatus: { state?: string };
      installedAndBenched: { rel: string; genTps: string }[];
    };
    expect(summary.context).toBe("default");
    expect(summary.nodes).toHaveLength(2);
    expect(summary.promotions[0]!.rel).toBe("foo/bar-Q4.gguf");
    expect(summary.workloads).toEqual([]);
    expect(summary.serverStatus.state).toBe("down");
    // Only installed + benched rels show up; not-installed is filtered.
    expect(summary.installedAndBenched.map((r) => r.rel)).toEqual([
      "foo/bar-Q4.gguf",
      "slow/bench.gguf",
    ]);
  });

  test("server.status failure surfaces in the summary without failing the runbook", async () => {
    const { client } = makeClient({
      "llamactl.node.ls": { context: null, cluster: null, nodes: [] },
      "llamactl.promotions.list": [],
      "llamactl.workload.list": { count: 0, workloads: [] },
      "llamactl.bench.compare": [],
    });
    // Override server.status to throw.
    const original = client.callTool;
    client.callTool = async (input): Promise<unknown> => {
      if (input.name === "llamactl.server.status") {
        throw new Error("server unavailable");
      }
      return await original.call(client, input);
    };
    const result = await runRunbook(
      "audit-fleet",
      {},
      {
        log: () => {},
        toolClient: client,
      },
    );
    expect(result.ok).toBe(true);
    const summary = result.summary as { serverStatus: { error?: string } };
    expect(summary.serverStatus.error).toMatch(/server unavailable/);
  });
});
