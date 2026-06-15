import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILT_IN_PLANNER_TOOLS } from "@llamactl/remote";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";

import { buildMcpServer } from "../src/server.js";

/**
 * Parity pin: the MCP `llamactl.operator.plan` handler must teach the
 * planner the SAME built-in tool catalog (composite.apply +
 * workload.apply) that the tRPC `operatorPlan` path injects via
 * mergePlannerTools. Without this, direct-MCP planner sessions would
 * see a strictly smaller catalog than the renderer's Operator Console,
 * silently downgrading plan quality on the MCP-only entry point.
 */

async function connected(): Promise<{ client: Client; server: McpServer }> {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

describe("llamactl.operator.plan planner catalog parity", () => {
  test("merges BUILT_IN_PLANNER_TOOLS even when input.tools omits them", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "llamactl.operator.plan",
      arguments: {
        goal: "apply a composite stack",
        mode: "stub",
        // Caller supplies only one tool — the merge must still teach
        // the planner about composite.apply + workload.apply.
        tools: [
          {
            name: "nova.ops.overview",
            description: "fleet overview",
            tier: "read" as const,
          },
        ],
      },
    });
    const parsed = JSON.parse(textOf(result)) as {
      ok: boolean;
      toolsAvailable?: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.toolsAvailable)).toBe(true);
    const advertised = new Set(parsed.toolsAvailable);
    for (const builtin of BUILT_IN_PLANNER_TOOLS) {
      expect(advertised.has(builtin.name)).toBe(true);
    }
    // Caller-supplied tool also survives — caller wins, built-ins
    // append.
    expect(advertised.has("nova.ops.overview")).toBe(true);
  });
});
